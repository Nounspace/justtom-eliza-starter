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
import { ForYouProvider } from "@neynar/nodejs-sdk/build/api";

export class FarcasterInteractionManager {
    private timeout: NodeJS.Timeout | undefined;
    private spamFilterManager: SpamFilterManager;

    constructor(
        public client: FarcasterClient,
        public runtime: IAgentRuntime,
        private signerUuid: string,
        public cache: Map<string, any>
    ) {
        this.spamFilterManager = SpamFilterManager.getInstance();
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
        const agentFid = this.client.farcasterConfig?.FARCASTER_FID ?? 0;
        if (!agentFid) {
            elizaLogger.info("No FID found, skipping interactions");
            return;
        }

        // Fetch global trending topics
        await this.fetchGlobalTrending();

        // Fetch ForYou feed
        await this.fetchForYouFeed();

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
                elizaLogger.info(
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
            elizaLogger.info("skipping cast from bot itself", cast.hash);
            return;
        }

        if (!memory.content.text) {
            elizaLogger.info("skipping cast with no text", cast.hash);
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
            elizaLogger.warn(
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
            elizaLogger.warn(
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
            `Farcaster: Engagement/Context Filter: ${cast.profile.name} said: ${cast.text} | Result: ${shouldRespondResponse}`
        );

        if (
            shouldRespondResponse === "IGNORE" ||
            shouldRespondResponse === "STOP"
        ) {
            elizaLogger.warn(
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
                elizaLogger.error("Error sending response cast:", error);
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



    // private manageBlockedUsers(username, senderId) {
    //     const now = Date.now();
    //     const oneHour = 60 * 60 * 1000; // One hour in milliseconds
    //     const cleanupThreshold = 48 * 60 * 60 * 1000; // 24 hours in milliseconds

    //     // Cleanup blocked users who have not been active for a specified duration
    //     for (const userId in this.spamFilter.blockedUsers) {
    //         const user = this.spamFilter.blockedUsers[userId];
    //         // Remove users who have not been blocked for more than the threshold
    //         if (now - user.lastBlockedTimestamp > cleanupThreshold) {
    //             delete this.spamFilter.blockedUsers[userId];
    //         }
    //     }


    //     if (!this.spamFilter.blockedUsers[senderId]) {
    //         this.spamFilter.blockedUsers[senderId] = {
    //             username: username,
    //             count: 1, // Initialize count to 1 when first blocked
    //             lastBlockedTimestamp: Date.now(), // Track when the user was blocked
    //         }
    //         this.spamFilter.blockedUsersCount++;
    //     } else {
    //         this.spamFilter.blockedUsers[senderId].count++; // Increment count if already blocked
    //     }

    //     // Check if we need to log a warning
    //     const shouldLogReport = (this.spamFilter.blockedUsersCount - this.spamFilter.lastReportedCount >= 10) || (now - this.spamFilter.lastReportedTimestamp > oneHour);
    //     if (shouldLogReport) {
    //         const filteredReport = Object.entries(this.spamFilter.blockedUsers).map(([key, user]) => ({
    //             username: user.username,
    //             count: user.count
    //         }));

    //         elizaLogger.warn(`Farcaster SPAM Filter report ${this.spamFilter.blockedUsersCount}: ${JSON.stringify(filteredReport)}`);
    //         this.spamFilter.lastReportedCount = this.spamFilter.blockedUsersCount; // Update last reported count
    //         this.spamFilter.lastReportedTimestamp = now; // Update last reported timestamp
    //     }
    // }


    // Method to fetch global trending topics
    private async fetchGlobalTrending() {
        const feed = await this.client.fetchGlobalTrending({
            feedType: FeedType.Filter,
            filterType: FilterType.GlobalTrending,
            limit: 10,
        });
        console.log(feed);
        // Process the feed to extract topics of interest
        // Implement logic to respond based on the topics
    }

    // Method to fetch ForYou feed
    private async fetchForYouFeed() {
        const fid = 3; // Example fid
        const viewerFid = 10; // Example viewer fid
        const provider = ForYouProvider.Mbd;
        const limit = 20;
        const providerMetadata = encodeURIComponent(
            JSON.stringify({
                filters: {
                    channels: ["https://farcaster.group/founders"],
                },
            })
        );

        const response = await this.client.fetchFeedForYou(fid, {
            limit,
            viewerFid,
            provider,
            providerMetadata: providerMetadata,
        });
        console.log("response:", response);
        // Process the response to handle the ForYou feed
    }
}