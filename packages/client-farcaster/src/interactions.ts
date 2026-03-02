import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    type Memory,
    ModelClass,
    stringToUuid,
    elizaLogger,
    type HandlerCallback,
    type Content,
    type IAgentRuntime,
} from "@elizaos/core";
import type { FarcasterClient } from "./client";
import { toHex } from "viem";
import { buildConversationThread, createCastMemory } from "./memory";
import type { Cast, Profile } from "./types";
import {
    formatCast,
    formatTimeline,
    messageHandlerTemplate,
    shouldRespondTemplate,
    shouldRespondSecurityTemplate,
    shouldRespondEngagementTemplate,
} from "./prompts";
import { castUuid } from "./utils";
import { sendCast } from "./actions";
import SpamFilterManager from './spamFilterManager';
import { FeedResponse, ForYouProvider } from "@neynar/nodejs-sdk/build/api";

export class FarcasterInteractionManager {
    // Property to track last fetch records
    private lastFetchFeeds: Map<string, Map<string, { timestamp: Date }>> = new Map();
    private timeout: NodeJS.Timeout | undefined;
    private spamFilterManager: SpamFilterManager;

    constructor(
        public client: FarcasterClient,
        public runtime: IAgentRuntime,
        private signerUuid: string,
        public cache: Map<string, any>
    ) {
        this.spamFilterManager = SpamFilterManager.getInstance();
        this.lastFetchFeeds.set(this.runtime.character.name, new Map());
    }

    public async start() {
        const handleInteractionsLoop = async () => {
            try {
                await this.handleInteractions();
            } catch (error) {
                elizaLogger.error(error);
            }

            // Always set up next check, even if there was an error
            this.timeout = setTimeout(
                handleInteractionsLoop,
                Number(this.client.farcasterConfig?.FARCASTER_POLL_INTERVAL ?? 120) *
                1000 // Default to 2 minutes
            );
        };

        handleInteractionsLoop();
    }

    public async stop() {
        if (this.timeout) clearTimeout(this.timeout);
    }


    private async handleInteractions() {
        const agentFid = this.client.farcasterConfig?.FARCASTER_FID;
        const agentName = this.runtime.character.name ?? "";
        const now = new Date();

        if (typeof agentFid !== 'number') {
            elizaLogger.info(`Farcaster: ${agentName} No FID found, skipping interactions`);
            return;
        }

        if (this.client.farcasterConfig.ENABLE_ACTION_PROCESSING) {
            // Initialize inner map if not exists
            if (!this.lastFetchFeeds.has(agentName)) {
                this.lastFetchFeeds.set(agentName, new Map());
            }

            const characterFeeds = this.lastFetchFeeds.get(agentName)!;
            const lastEntry = characterFeeds.get("dailyCheck");

            for (const [character, feedMap] of this.lastFetchFeeds.entries()) {
                elizaLogger.debug(`Farcaster: Read Feeds: Character: ${character}`);
                for (const [key, value] of feedMap.entries()) {
                    elizaLogger.debug(`Farcaster: Read Feeds:  ${key}: ${value.timestamp.toISOString()}`);
                }
            }

            if (lastEntry && (now.getTime() - lastEntry.timestamp.getTime()) < 24 * 60 * 60 * 1000) {
                elizaLogger.log(`Farcaster: ${agentName} has already read the feeds today. Last read time: ${lastEntry.timestamp.toISOString()}`);
            } else {
                // Run the once-per-day logic
                await this.fetchGlobalTrending();
                await this.fetchForYouFeed();
                characterFeeds.set("dailyCheck", { timestamp: now });
            }
        }

        const mentions = await this.client.getMentions({
            fid: agentFid,
            pageSize: 10,
        });

        const agent = await this.client.getProfile(agentFid);
        for (const mention of mentions) {
            const messageHash = toHex(mention.hash);
            const conversationId = `${messageHash}-${this.runtime.agentId}`;
            const roomId = stringToUuid(conversationId);
            const userId = stringToUuid(mention.authorFid.toString());

            const pastMemoryId = castUuid({
                agentId: this.runtime.agentId,
                hash: mention.hash,
            });

            const pastMemory =
                await this.runtime.messageManager.getMemoryById(pastMemoryId);

            if (pastMemory) {
                continue;
            }

            // Check if the user is already blocked
            if (this.spamFilterManager.isUserBlocked(userId)) {
                elizaLogger.debug(
                    `Farcaster: Not responding to cast because Security/Spam filter BLOCK ${mention.profile.username}`
                );
                continue; // Skip processing for blocked users
            }

            await this.runtime.ensureConnection(
                userId,
                roomId,
                mention.profile.username,
                mention.profile.name,
                "farcaster"
            );

            const thread = await buildConversationThread({
                client: this.client,
                runtime: this.runtime,
                cast: mention,
            });

            const memory: Memory = {
                content: { text: mention.text },
                agentId: this.runtime.agentId,
                userId,
                roomId,
            };

            await this.handleCast({
                agent,
                cast: mention,
                memory,
                thread,
            });
        }

        this.client.lastInteractionTimestamp = new Date();
    }

    private async handleCast({
        agent,
        cast,
        memory,
        thread,
    }: {
        agent: Profile;
        cast: Cast;
        memory: Memory;
        thread: Cast[];
    }) {
        if (cast.profile.fid === agent.fid) {
            elizaLogger.info("Farcaster: skipping cast from bot itself", cast.hash);
            return;
        }

        if (!memory.content.text) {
            elizaLogger.info("Farcaster: skipping cast with no text", cast.hash);
            return { text: "", action: "IGNORE" };
        }

        const currentPost = formatCast(cast);

        const senderId = stringToUuid(cast.authorFid.toString());

        const { timeline } = await this.client.getTimeline({
            fid: agent.fid,
            pageSize: 10,
        });

        const formattedTimeline = formatTimeline(
            this.runtime.character,
            timeline
        );

        const formattedConversation = thread
            .map(
                (cast) => `@${cast.profile.username} (${new Date(
                    cast.timestamp
                ).toLocaleString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                })}):
                ${cast.text}`
            )
            .join("\n\n");

        const state = await this.runtime.composeState(memory, {
            farcasterUsername: agent.username,
            timeline: formattedTimeline,
            currentPost,
            formattedConversation,
        });

        // Stage 1: Security/Spam Filter
        if (this.spamFilterManager.isUserBlocked(senderId)) {
            this.spamFilterManager.addUserToBlockList(cast.profile.username, senderId);
            elizaLogger.debug(
                `Farcaster: Not responding to cast because Security/Spam filter BLOCK ${cast.profile.username}`
            );
            return
        }

        const shouldRespondSecurityContext = composeContext({
            state,
            template: shouldRespondSecurityTemplate,
        });

        const securityResponse = String(
            await generateShouldRespond({
                runtime: this.runtime,
                context: shouldRespondSecurityContext,
                modelClass: ModelClass.SMALL,
            })
        ).toUpperCase();

        elizaLogger.info(
            `Farcaster: Security/Spam Filter: ${securityResponse} ${cast.authorFid.toString()} ${cast.profile.username}: ${cast.text.slice(0, 15)}`
        );

        if (securityResponse === "STOP") {
            elizaLogger.debug(
                `Farcaster: Not responding to cast because Security/Spam filter returned BLOCK ${cast.profile.username}`
            );

            // If the user is blocked, update the spam filter
            this.spamFilterManager.addUserToBlockList(cast.profile.username, senderId);
            return;
        }

        // Stage 2: Engagement/Context Filter
        const shouldRespondContext = composeContext({
            state,
            template: shouldRespondEngagementTemplate,
        });

        const memoryId = castUuid({
            agentId: this.runtime.agentId,
            hash: cast.hash,
        });

        const castMemory =
            await this.runtime.messageManager.getMemoryById(memoryId);

        if (!castMemory) {
            await this.runtime.messageManager.createMemory(
                createCastMemory({
                    roomId: memory.roomId,
                    senderId,
                    runtime: this.runtime,
                    cast,
                })
            );
        }

        const shouldRespondResponse = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
        });

        elizaLogger.warn(
            `Farcaster: Engagement/Context Filter: Result: ${shouldRespondResponse} | ${cast.profile.name} said: ${cast.text}`
        );

        if (
            shouldRespondResponse === "IGNORE" ||
            shouldRespondResponse === "STOP"
        ) {
            elizaLogger.debug(
                `Farcaster: Not responding to cast because shouldRespondContext was ${shouldRespondResponse}`
            );
            return;
        }

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.farcasterMessageHandlerTemplate ??
                this.runtime.character?.templates?.messageHandlerTemplate ??
                messageHandlerTemplate,
        });

        const responseContent = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        responseContent.inReplyTo = memoryId;

        if (!responseContent.text) return;

        if (this.client.farcasterConfig?.FARCASTER_DRY_RUN) {
            elizaLogger.info(
                `Dry run: would have responded to cast ${this.client.farcasterConfig?.FAVORITE_FRONTEND}/${cast.profile.username}/${cast.hash} with ${responseContent.text}`
            );
            return;
        }

        const callback: HandlerCallback = async (
            content: Content,
            _files: any[]
        ) => {
            try {
                if (memoryId && !content.inReplyTo) {
                    content.inReplyTo = memoryId;
                }
                const results = await sendCast({
                    runtime: this.runtime,
                    client: this.client,
                    signerUuid: this.signerUuid,
                    profile: cast.profile,
                    content: content,
                    roomId: memory.roomId,
                    inReplyTo: {
                        fid: cast.authorFid,
                        hash: cast.hash,
                    },
                });
                // sendCast lost response action, so we need to add it back here
                results[0].memory.content.action = content.action;

                for (const { memory } of results) {
                    await this.runtime.messageManager.createMemory(memory);
                }
                return results.map((result) => result.memory);
            } catch (error) {
                elizaLogger.error("Farcaster: Error sending response cast:", error);
                return [];
            }
        };

        const responseMessages = await callback(responseContent);

        const newState = await this.runtime.updateRecentMessageState(state);

        await this.runtime.processActions(
            { ...memory, content: { ...memory.content, cast } },
            responseMessages,
            newState,
            callback
        );
    }


    private async fetchAndFilterCasts(agentFid?: number) {
        const response = await this.client.getFeed(agentFid);
        const casts = response.timeline.casts;

        const filteredCasts = await Promise.all(casts.map(async cast => {
            const memoryId = castUuid({
                agentId: this.runtime.agentId,
                hash: cast.hash,
            });

            const castMemory = await this.runtime.messageManager.getMemoryById(memoryId);
            if (castMemory) {
                elizaLogger.debug(`Farcaster: Removing processed cast: ${cast.author.username}`);
                return null; // Exclude this cast from the new array
            }
            return cast; // Include this cast in the new array
        }));

        response.timeline.casts = filteredCasts.filter(cast => cast !== null);
        return response;
    }

    private async fetchGlobalTrending() {
        elizaLogger.debug("Farcaster: fetch Global Trending");
        const response = await this.fetchAndFilterCasts();
        await this.processAgentFeed(response.timeline);
    }

    private async fetchForYouFeed() {
        const agentFid = this.client.farcasterConfig?.FARCASTER_FID ?? 0;
        elizaLogger.debug("Farcaster: getFeed for you");
        const response = await this.fetchAndFilterCasts(agentFid);
        await this.processAgentFeed(response.timeline);
    }


    // // Method to fetch global trending topics
    // private async fetchGlobalTrending() {
    //     const response = await this.client.getFeed();
    //     elizaLogger.debug("Farcaster: fetch Global Trending");

    //     const casts = response.timeline.casts;

    //     // Use Promise.all to await all asynchronous operations
    //     const filteredCasts = await Promise.all(casts.map(async cast => {
    //         const memoryId = castUuid({
    //             agentId: this.runtime.agentId,
    //             hash: cast.hash,
    //         });

    //         const castMemory = await this.runtime.messageManager.getMemoryById(memoryId);

    //         if (castMemory) {
    //             // Log that the cast is being removed
    //             elizaLogger.debug(`Farcaster: Removing processed cast: ${memoryId} ${cast.author.username}`);
    //             return null; // Exclude this cast from the new array
    //         }

    //         return cast; // Include this cast in the new array
    //     }));

    //     // Filter out null values
    //     response.timeline.casts = filteredCasts.filter(cast => cast !== null);

    //     // Process the response to handle the ForYou feed
    //     await this.processAgentFeed(response.timeline);
    // }


    // // Method to fetch ForYou feed
    // private async fetchForYouFeed() {
    //     const agentFid = this.client.farcasterConfig?.FARCASTER_FID ?? 0;
    //     const response = await this.client.getFeed(agentFid);

    //     elizaLogger.debug("Farcaster: getFeed for you");

    //     const casts = response.timeline.casts;

    //     // Use Promise.all to await all asynchronous operations
    //     const filteredCasts = await Promise.all(casts.map(async cast => {
    //         const memoryId = castUuid({
    //             agentId: this.runtime.agentId,
    //             hash: cast.hash,
    //         });

    //         const castMemory = await this.runtime.messageManager.getMemoryById(memoryId);

    //         if (castMemory) {
    //             // Log that the cast is being removed
    //             elizaLogger.debug(`Farcaster: Removing processed cast: ${cast.author.username}`);
    //             return null; // Exclude this cast from the new array
    //         }

    //         return cast; // Include this cast in the new array
    //     }));

    //     // Filter out null values
    //     response.timeline.casts = filteredCasts.filter(cast => cast !== null);

    //     // Process the response to handle the ForYou feed
    //     await this.processAgentFeed(response.timeline);
    // }


    private async processAgentFeed(timeline: FeedResponse) {
        const casts = timeline.casts; // Assuming timeline contains the casts
        const agentFid = this.client.farcasterConfig?.FARCASTER_FID ?? 0;
        const agent: Profile = await this.client.getProfile(agentFid); // Obtain the agent using the correct fid
        for (const cast of casts) {
            // console.dir(cast)
            // Process the feed to extract topics of interest
            const userId = stringToUuid(cast.author.fid.toString());
            const senderId = stringToUuid(userId); // Define senderId using the correct property
            const senderProfile: Profile = await this.client.getProfile(cast.author.fid); // Obtain the agent using the correct fid

            const conversationId = `${toHex(cast.hash)}-${this.runtime.agentId}`;
            const roomId = stringToUuid(conversationId); // Define roomId

            // Create a Cast object from CastWithInteractions
            const castData: Cast = {
                hash: cast.hash, // Ensure to include the hash
                text: cast.text, // Ensure to include the text
                timestamp: new Date(cast.timestamp), // Ensure to include the timestamp
                authorFid: cast.author.fid, // Assuming this is available in cast
                profile: senderProfile, // Assuming agent contains the profile information
            };


            await this.runtime.ensureConnection(
                userId,
                roomId,
                senderProfile.username,
                senderProfile.name,
                "farcaster"
            );

            const memory: Memory = createCastMemory({
                roomId,
                senderId,
                runtime: this.runtime,
                cast: castData, // Pass the constructed Cast object
            });

            const castDataObject = {
                agent,
                cast: castData,
                memory,
                thread: [castData], // Assuming the current cast is the only one in the thread
            };

            // elizaLogger.warn("handling cast:")
            // console.dir(cast)
            await this.handleCast(castDataObject); // Send the constructed object to handleCast
        }
    }

}