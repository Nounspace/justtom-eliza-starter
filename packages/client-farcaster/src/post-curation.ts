import {
    composeContext,
    generateText,
    type IAgentRuntime,
    ModelClass,
    stringToUuid,
    elizaLogger,
} from "@elizaos/core";

import type { FarcasterClient } from "./client";
import { curationPostTemplate } from "./prompts";
import { castUuid, MAX_CAST_LENGTH } from "./utils";
import { createCastMemory } from "./memory";
import { sendCast, sendChannelCast } from "./actions";
import { FarcasterImageManager } from "./post-images";

export class FarcasterCurationManager {
    private imageManager: FarcasterImageManager;

    constructor(
        private client: FarcasterClient,
        private runtime: IAgentRuntime,
        private signerUuid: string,
        private fid: number
    ) {
        this.imageManager = new FarcasterImageManager(client, runtime);
    }

    public async generateCurationCast(): Promise<void> {
        elizaLogger.info("Starting curation pipeline");
        try {
            const profile = await this.client.getProfile(this.fid);
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                profile.username,
                this.runtime.character.name,
                "farcaster"
            );

            // 1. Fetch deep memories from the dedicated curation room
            const curationRoomId = stringToUuid("farcaster-clanker.space-room");
            const memories = await this.runtime.messageManager.getMemories({
                roomId: curationRoomId,
                count: 150,
            });

            // 2. Initial Filter: Filter out self and focus on signal
            const rawSignals = memories
                .filter(m => m.userId !== this.runtime.agentId)
                .map(m => m.content.text);

            const totalCuratedCount = rawSignals.length;
            elizaLogger.info(`Processing ${totalCuratedCount} potential curation signals`);

            // 3. Score & Batch Curation
            const batchSize = 30;
            const batches: string[][] = [];
            for (let i = 0; i < rawSignals.length; i += batchSize) {
                batches.push(rawSignals.slice(i, i + batchSize));
            }

            const finalists: string[] = [];
            const sentiments: string[] = [];

            for (const batch of batches) {
                const batchText = batch.map(t => `- ${t}`).join("\n");
                const rankingContext = `
# Task: Identify high-potential token launches from these Farcaster messages.
# Instructions:
1. Identify the top 2-3 "Gems". Return them in this format: "GEMS: TOKEN_NAME by @USER".
2. Provide a 1-sentence "Sentiment" or "Reason" for this batch (e.g., "AI tokens are showing strong builder intent"). Return it as "SENTIMENT: [Reason]".
- Ignore noisy instructions about themes/fidgets.
- No other text or commentary.

Messages:
${batchText}
`;
                const batchResult = await generateText({
                    runtime: this.runtime,
                    context: rankingContext,
                    modelClass: ModelClass.SMALL,
                });

                const lines = batchResult.split("\n").map(l => l.trim());

                const batchGems = lines
                    .filter(l => l.startsWith("GEMS:"))
                    .map(l => l.replace("GEMS:", "").trim());

                const batchSentiment = lines
                    .find(l => l.startsWith("SENTIMENT:"))
                    ?.replace("SENTIMENT:", "").trim();

                if (batchSentiment) sentiments.push(batchSentiment);
                finalists.push(...batchGems);
            }

            const curatedMemories = finalists.join("\n");
            const batchSentiments = sentiments.join(" ");
            elizaLogger.info(`Curation finalists selected: ${finalists.length}`);

            // 4. Final Generation using the template
            const agentName = this.runtime.character.name.toLowerCase().replace(/\s+/g, "-");
            const generateRoomId = stringToUuid(`${agentName}-curation-room`);
            const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date());

            const state = await this.runtime.composeState(
                {
                    roomId: generateRoomId,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: { text: "", action: "" },
                },
                {
                    farcasterUsername: profile.username,
                    curatedMemories: curatedMemories || "No recent relevant memories found.",
                    batchSentiments: batchSentiments || "Normal builder activity.",
                    totalCuratedCount: totalCuratedCount.toString(),
                    weekday,
                }
            );

            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.farcasterCurationPostTemplate ||
                    curationPostTemplate,
            });

            const newContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.LARGE,
            });

            const slice = newContent
                .replaceAll(/\\n/g, "\n")
                .replace(/\s*[—–]\s*/g, ", ")
                .replace(/ \s*-\s* /g, ", ")
                .trim();

            let content = slice.slice(0, MAX_CAST_LENGTH);

            // Update last curation post timestamp in cache
            await this.runtime.cacheManager.set("farcaster/" + this.fid + "/lastCurationPost", {
                timestamp: Date.now(),
            });

            if (content.length > MAX_CAST_LENGTH) content = content.slice(0, content.lastIndexOf("\n"));
            if (content.length > MAX_CAST_LENGTH) content = content.slice(0, content.lastIndexOf("."));

            if (this.runtime.getSetting("FARCASTER_DRY_RUN") === "true") {
                elizaLogger.info(`DRY RUN: Curation cast would be: ${content}`);
                elizaLogger.info(`Memories used for curation: \n${curatedMemories}`);
                return;
            }

            try {
                // const imageUrl = await this.imageManager.generateAndUploadImage(content, true);
                const postContent: any = { text: content };
                // if (imageUrl) postContent.attachments = [{ url: imageUrl }];

                const [{ cast }] = await sendCast({
                    client: this.client,
                    runtime: this.runtime,
                    signerUuid: this.signerUuid,
                    roomId: generateRoomId,
                    content: postContent,
                    profile,
                });

                await this.runtime.cacheManager.set(
                    `farcaster/${this.fid}/lastCast`,
                    { hash: cast.hash, timestamp: Date.now() }
                );

                const roomId = castUuid({ agentId: this.runtime.agentId, hash: cast.hash });
                await this.runtime.ensureRoomExists(roomId);
                await this.runtime.ensureParticipantInRoom(this.runtime.agentId, roomId);
                await this.runtime.messageManager.createMemory(
                    createCastMemory({ roomId, senderId: this.runtime.agentId, runtime: this.runtime, cast })
                );

                elizaLogger.warn(`[Farcaster Neynar Client] Published curated cast https://casterscan.com/casts/${cast.hash}`);
            } catch (error) {
                elizaLogger.error("Error sending curated cast:", error);
            }
        } catch (error) {
            elizaLogger.error("Error generating curated cast:", error);
        }
    }
}
