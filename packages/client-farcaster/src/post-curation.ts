import {
    composeContext,
    generateText,
    type IAgentRuntime,
    ModelClass,
    stringToUuid,
    elizaLogger,
} from "@elizaos/core";

import type { FarcasterClient } from "./client";
import { curationPostTemplate, curationStatsTemplate } from "./prompts";
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

            // 1. Fetch memories from the dedicated curation room (last 24 hours only)
            const curationRoomId = stringToUuid("farcaster-clanker.space-room");
            const now = Date.now();
            const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

            const memories = await this.runtime.messageManager.getMemories({
                roomId: curationRoomId,
                count: 150,
                start: twentyFourHoursAgo,
                end: now,
            });

            // 2. Spam Filter: Remove all tokens from deployers who launched > 5 in 24h
            //    Note: userId is always Clanker's FID (the bot posting deploys), so we
            //    extract the actual deployer from the text pattern "(by @username)"
            const MAX_DEPLOYS_PER_USER = 5;
            const nonSelfMemories = memories.filter(m => m.userId !== this.runtime.agentId);

            const extractDeployer = (text: string): string => {
                const match = text?.match(/\(by @([^)]+)\)/);
                return match ? match[1] : "unknown";
            };

            const deployCountByUser = new Map<string, number>();
            for (const m of nonSelfMemories) {
                const deployer = extractDeployer(m.content.text);
                deployCountByUser.set(deployer, (deployCountByUser.get(deployer) || 0) + 1);
            }

            const spammers = new Set<string>();
            for (const [deployer, count] of deployCountByUser) {
                if (count > MAX_DEPLOYS_PER_USER) {
                    spammers.add(deployer);
                    elizaLogger.info(`Curation spam filter: Removing @${deployer} (${count} deploys in 24h)`);
                }
            }

            const rawSignals = nonSelfMemories
                .filter(m => !spammers.has(extractDeployer(m.content.text)))
                .map(m => m.content.text);

            const totalCuratedCount = rawSignals.length;
            elizaLogger.info(`Processing ${totalCuratedCount} curation signals (last 24h, ${spammers.size} spammers filtered)`);

            if (totalCuratedCount === 0) {
                elizaLogger.warn("No curation signals in the last 24 hours, skipping post");
                return;
            }

            // Phase 1: Stats Post (Silent/Console Only by default)
            // ---------------------
            const POST_STATS_PREAMBLE = false;
            const today = new Date().toISOString().split('T')[0];
            const deployCountStr = await this.runtime.cacheManager.get<string>(`farcaster/stats/${today}/total_deployments`) || "0";
            const lowRepCountStr = await this.runtime.cacheManager.get<string>(`farcaster/stats/${today}/low_reputation_filtered`) || "0";

            const statsState = await this.runtime.composeState(
                {
                    roomId: curationRoomId,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: { text: "", action: "" },
                },
                {
                    farcasterUsername: profile.username,
                    totalDeployments: deployCountStr,
                    lowRepFiltered: lowRepCountStr,
                    engagedGems: totalCuratedCount.toString(),
                }
            );

            const statsContext = composeContext({
                state: statsState,
                template: curationStatsTemplate,
            });

            const statsResponse = await generateText({
                runtime: this.runtime,
                context: statsContext,
                modelClass: ModelClass.SMALL,
            });

            const statsContent = statsResponse.replace(/^"|"$/g, '').trim().slice(0, MAX_CAST_LENGTH);

            if (this.runtime.getSetting("FARCASTER_DRY_RUN") === "true" || !POST_STATS_PREAMBLE) {
                elizaLogger.info(`[SILENT STATS]: ${statsContent}`);
            } else {
                try {
                    await sendCast({
                        client: this.client,
                        runtime: this.runtime,
                        signerUuid: this.signerUuid,
                        roomId: curationRoomId,
                        content: { text: statsContent },
                        profile,
                    });
                    elizaLogger.info(`Successfully posted curation stats preamble.`);
                } catch (error) {
                    elizaLogger.error("Failed to post curation stats cast:", error);
                }
            }

            // Wait 10 minutes before ranking and posting the actual Gems if the preamble was posted
            if (POST_STATS_PREAMBLE && this.runtime.getSetting("FARCASTER_DRY_RUN") !== "true") {
                elizaLogger.info("Waiting 10 minutes before ranking and posting final curation gems...");
                await new Promise(resolve => setTimeout(resolve, 600000)); // 600000ms = 10 mins
            }

            // Phase 2: Score & Batch Curation gems
            // ---------------------
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
1. Identify the top 2-3 "Gems". Return them in this format: "GEMS: TOKEN_NAME [Link: http://...]".
2. Provide a 1-sentence "Market Observation" for this batch. 
   - STRICT RULE: This must be a meta-observation about the ecosystem or builder energy.
   - NEVER mention specific token names, user handles, or list any projects.
   - Example: "AI and utility tokens are showing strong builder intent."
   - Return it as "MARKET_OBSERVATION: [Observation]".

- The message might look like "Token X deployed... [Link: http://...]". Capture both for GEMS.
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

                // Handle both newlines and common separators (|, ;) used by some models
                const lines = batchResult
                    .split(/[\n|;]/)
                    .map(l => l.trim())
                    .filter(l => l.length > 0);

                const batchGems = lines
                    .filter(l => l.toUpperCase().startsWith("GEMS:"))
                    .flatMap(l => {
                        const gemsText = l.replace(/^GEMS:/i, "").trim();
                        // Split by comma, but rejoin parts that belong to the same [Link: ...]
                        const parts: string[] = [];
                        let current = "";
                        let bracketDepth = 0;
                        for (const char of gemsText) {
                            if (char === "[") bracketDepth++;
                            if (char === "]") bracketDepth--;
                            if (char === "," && bracketDepth === 0) {
                                parts.push(current.trim());
                                current = "";
                            } else {
                                current += char;
                            }
                        }
                        if (current.trim()) parts.push(current.trim());
                        return parts;
                    });

                const batchSentiment = lines
                    .find(l => l.toUpperCase().startsWith("MARKET_OBSERVATION:"))
                    ?.replace(/^MARKET_OBSERVATION:/i, "").trim();

                if (batchSentiment) sentiments.push(batchSentiment);
                finalists.push(...batchGems);
            }

            const curatedMemories = finalists.join("\n");
            
            // Safeguard: Sanitize batch sentiments to strip any accidental placeholders
            const sanitizeSentiment = (text: string) => 
                text?.replace(/TOKEN\s*(?:by\s*)?@\w+/gi, "")
                    .replace(/TOKEN\d?/gi, "")
                    .replace(/notable launches include:?/gi, "")
                    .replace(/\s*,\s*and\s*/gi, " ")
                    .replace(/\s\s+/g, " ")
                    .trim();

            const processedSentiments = sentiments.map(s => sanitizeSentiment(s)).filter(s => s.length > 0);
            const batchSentiments = processedSentiments.join(" ");
            elizaLogger.info(`Curation finalists selected: ${finalists.length}`);

            // 4. Extract token names + links from finalists for programmatic injection
            const tokenLines: string[] = finalists.slice(0, 3).map(gem => {
                // Extract token name and link from "TOKEN_NAME [Link: https://...]"
                const linkMatch = gem.match(/\[Link:\s*(https?:\/\/[^\]]+)\]/i);
                const tokenName = gem.replace(/\s*\[Link:.*?\]/i, "").replace(/\s*by\s*@\S+/i, "").trim();
                if (linkMatch && tokenName) {
                    return `${tokenName}: ${linkMatch[1]}`;
                }
                return tokenName || gem;
            });

            // 5. Generate prose parts via LLM (JSON response)
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
                    batchSentiments: batchSentiments || "Normal builder activity.",
                    weekday,
                }
            );

            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.farcasterCurationPostTemplate ||
                    curationPostTemplate,
            });

            const llmResponse = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.LARGE,
            });

            // 6. Parse JSON and build the final post
            let intro = "";
            let vibe = "";
            let outro = "";

            try {
                // Strip markdown code fences if present
                const cleaned = llmResponse.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
                const parsed = JSON.parse(cleaned);
                
                // Keep it clean but natural. We've hardened the prompt, so we just do a 
                // light pass to ensure no generic "TOKEN" or "TOKENS" words remained.
                const clean = (text: string) => 
                    text?.replace(/\bTOKEN\d?S?\b/gi, "").replace(/\s\s+/g, " ").trim();

                intro = clean(parsed.intro || "");
                vibe = clean(parsed.vibe || "");
                outro = clean(parsed.outro || "");
            } catch (e) {
                elizaLogger.warn("Curation: Failed to parse JSON from LLM, using raw response");
                intro = llmResponse.trim();
            }

            // 7. Assemble final post: prose + token links + closing
            const proseTop = [intro, vibe].filter(p => p.length > 0).join("\n");
            const tokenBlock = tokenLines.join("\n");
            const assembledPost = [proseTop, "", tokenBlock, "", outro].filter((p, i) => {
                // Keep empty strings (blank lines) between sections, but not at start/end
                if (p === "") return i > 0 && i < 4;
                return p.length > 0;
            }).join("\n");

            const slice = assembledPost
                .replace(/\s*[—–]\s*/g, ", ")
                .replace(/ \s*-\s* /g, ", ")
                .trim();

            let content = slice.slice(0, MAX_CAST_LENGTH);

            // Update last curation post timestamp in cache so it doesn't spam Farcaster repeatedly
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
