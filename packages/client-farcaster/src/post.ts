import {
    composeContext,
    generateText,
    type IAgentRuntime,
    ModelClass,
    stringToUuid,
    elizaLogger,
} from "@elizaos/core";

import type { FarcasterClient } from "./client";
import { formatTimeline, formatFeed, postTemplate, startWeekPostTemplate, midWeekPostTemplate, weekendPostTemplate, clankerTokenTemplate } from "./prompts";
import { castUuid, MAX_CAST_LENGTH } from "./utils";
import { createCastMemory } from "./memory";
import { sendChannelCast } from "./actions";
import { FarcasterCurationManager } from "./post-curation";
import { FarcasterImageManager } from "./post-images";

export class FarcasterPostManager {
    client: FarcasterClient;
    runtime: IAgentRuntime;
    fid: number;
    isDryRun: boolean;
    private timeout: NodeJS.Timeout | undefined;
    private curationManager: FarcasterCurationManager;
    private imageManager: FarcasterImageManager;

    constructor(
        client: FarcasterClient,
        runtime: IAgentRuntime,
        private signerUuid: string,
        public cache: Map<string, any>
    ) {
        this.client = client;
        this.runtime = runtime;
        this.fid = this.client.farcasterConfig?.FARCASTER_FID ?? 0;
        this.isDryRun = this.client.farcasterConfig?.FARCASTER_DRY_RUN ?? false;

        this.curationManager = new FarcasterCurationManager(client, runtime, signerUuid, this.fid);
        this.imageManager = new FarcasterImageManager(client, runtime);

        // Log configuration on initialization
        elizaLogger.warn("Farcaster Client Configuration:");
        elizaLogger.warn(`- FID: ${this.fid}`);
        elizaLogger.warn(`- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`);
        elizaLogger.warn(`- Enable Post: ${this.client.farcasterConfig.ENABLE_POST ? "enabled" : "disabled"}`);
        if (this.client.farcasterConfig.ENABLE_POST) {
            elizaLogger.warn(`- CAST HOUR: ${this.client.farcasterConfig.FARCASTER_CAST_HOURS}`);
            elizaLogger.warn(`- Post Interval: ${this.client.farcasterConfig.POST_INTERVAL_MIN}-${this.client.farcasterConfig.POST_INTERVAL_MAX} minutes`);
            elizaLogger.warn(`- Post Immediately: ${this.client.farcasterConfig.POST_IMMEDIATELY ? "enabled" : "disabled"}`);
        }
        elizaLogger.warn(`- Action Processing: ${this.client.farcasterConfig.ENABLE_ACTION_PROCESSING ? "enabled" : "disabled"}`);
        elizaLogger.warn(`- Action Interval: ${this.client.farcasterConfig.ACTION_INTERVAL} minutes`);

        if (this.isDryRun) {
            elizaLogger.warn("Farcaster client initialized in dry run mode - no actual casts should be posted");
        }
    }

    public async start() {
        if (this.client.farcasterConfig.ENABLE_POST) {
            this.startNormalPostLoop();
        }
        if (this.client.farcasterConfig.FARCASTER_CURATION_MODE) {
            this.startCurationPostLoop();
        }
    }

    private async startNormalPostLoop() {
        const generateNormalCastLoop = async () => {
            const timezone = "America/Chicago";
            const minMinutes = 5;
            const maxMinutes = 20;

            const now = new Date();
            const timezoneTime = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false }).format(now);
            const [hour] = timezoneTime.split(':').map(Number);

            const lastPost = await this.runtime.cacheManager.get<{ timestamp: number }>(
                "farcaster/" + this.fid + "/lastPost"
            );
            const hoursSinceLastPost = lastPost ? (Date.now() - lastPost.timestamp) / (1000 * 60 * 60) : 24;

            if (this.client.farcasterConfig.FARCASTER_CAST_HOURS.includes(hour) && hoursSinceLastPost > 20) {
                try {
                    const randomDelayMinutes = (Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes);
                    const delayMs = randomDelayMinutes * 60 * 1000;
                    elizaLogger.warn(`[Farcaster] Normal cast hour ${hour} matched! Scheduling post in ${randomDelayMinutes} minutes`);
                    setTimeout(async () => {
                        try { await this.generateNewCast(); } catch (error) { elizaLogger.error(error); }
                    }, delayMs);
                } catch (error) {
                    elizaLogger.error(error);
                }
            } else if (this.client.farcasterConfig.FARCASTER_CAST_HOURS.includes(hour) && hoursSinceLastPost <= 20) {
                elizaLogger.debug(`[Farcaster] Still in cast hour ${hour}, but already posted ${hoursSinceLastPost.toFixed(1)}h ago. Skipping.`);
            } else {
                elizaLogger.info(`[Farcaster] Normal loop: Chicago is ${timezoneTime}. Target hours: ${this.client.farcasterConfig.FARCASTER_CAST_HOURS}`);
            }

            elizaLogger.debug(`Next normal cast verification in 1 hour`);
            setTimeout(generateNormalCastLoop, 60 * 60 * 1000);
        };

        if (this.client.farcasterConfig.POST_IMMEDIATELY) {
            await this.generateNewCast();
        }
        generateNormalCastLoop();
    }

    private async startCurationPostLoop() {
        const generateCurationCastLoop = async () => {
            const timezone = "America/Chicago";
            const minMinutes = 5;
            const maxMinutes = 20;

            const now = new Date();
            const timezoneTime = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false }).format(now);
            const [hour] = timezoneTime.split(':').map(Number);
            const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(now);

            const curationDay = this.client.farcasterConfig.FARCASTER_CURATION_DAY || "Friday";
            const isEveryday = curationDay.toLowerCase() === "everyday";

            if (!isEveryday && weekday !== curationDay) {
                elizaLogger.info(`[Farcaster Curation] Today is ${weekday}, waiting for ${curationDay}`);
                setTimeout(generateCurationCastLoop, 60 * 60 * 1000);
                return;
            }

            const lastPost = await this.runtime.cacheManager.get<{ timestamp: number }>(
                "farcaster/" + this.fid + "/lastCurationPost"
            );
            const hoursSinceLastPost = lastPost ? (Date.now() - lastPost.timestamp) / (1000 * 60 * 60) : 24;
            const targetHours = this.client.farcasterConfig.FARCASTER_CURATION_POST_TIMES || [22];

            if (targetHours.includes(hour) && hoursSinceLastPost > 20) {
                try {
                    const randomDelayMinutes = (Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes);
                    const delayMs = randomDelayMinutes * 60 * 1000;
                    elizaLogger.warn(`[Farcaster] Curation cast hour ${hour} matched! Scheduling in ${randomDelayMinutes} minutes`);
                    setTimeout(async () => {
                        try { await this.curationManager.generateCurationCast(); } catch (error) { elizaLogger.error(error); }
                    }, delayMs);
                } catch (error) {
                    elizaLogger.error(error);
                }
            } else if (targetHours.includes(hour) && hoursSinceLastPost <= 20) {
                elizaLogger.debug(`[Farcaster] Still in curation hour ${hour}, but already posted ${hoursSinceLastPost.toFixed(1)}h ago. Skipping.`);
            } else {
                elizaLogger.info(`[Farcaster] Curation loop: Chicago is ${timezoneTime}. Target hours: ${targetHours}`);
            }

            elizaLogger.debug(`Next curation cast verification in 1 hour`);
            setTimeout(generateCurationCastLoop, 60 * 60 * 1000);
        };

        if (this.client.farcasterConfig.POST_IMMEDIATELY) {
            await this.curationManager.generateCurationCast();
        }
        generateCurationCastLoop();
    }

    public async stop() {
        if (this.timeout) clearTimeout(this.timeout);
    }

    private async generateNewCast() {
        elizaLogger.info("Generating new cast");
        try {
            const profile = await this.client.getProfile(this.fid);
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                profile.username,
                this.runtime.character.name,
                "farcaster"
            );

            const { timeline } = await this.client.getTimeline({ fid: this.fid, pageSize: 10 });
            this.cache.set("farcaster/timeline", timeline);
            
            const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date());

            // Fetch either Global Trending or Personalized "For You" feed
            // Mon/Wed/Fri: For You (following)
            // Tue/Thu/Sat/Sun: Global Trending
            const usePersonalizedFeed = ['Monday', 'Wednesday', 'Friday'].includes(weekday);
            elizaLogger.info(`[Farcaster] Fetching ${usePersonalizedFeed ? "For You" : "Global Trending"} feed for ${weekday}`);
            
            const { timeline: feedResponse } = await this.client.getFeed(usePersonalizedFeed ? this.fid : undefined);
            const formattedFeed = formatFeed(feedResponse.casts);

            const generateRoomId = stringToUuid("farcaster_generate_room");

            const state = await this.runtime.composeState(
                {
                    roomId: generateRoomId,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: { text: "", action: "" },
                },
                {
                    farcasterUserName: profile.username,
                    feed: formattedFeed,
                    weekday,
                }
            );

            // Check for randomized Clanker token deployment
            const clankerProbability = this.client.farcasterConfig.FARCASTER_CLANKER_PROBABILITY;
            const isClankerPost = Math.random() < clankerProbability;
            const isCuration = false;   //new cast not curation

            let selectedTemplate = postTemplate;
            if (isClankerPost) {
                elizaLogger.warn(`[Farcaster][${this.runtime.character.name}] Clanker probability matched! Generating token deployment request.`);
                selectedTemplate = clankerTokenTemplate;
            } else {
                const templates = [postTemplate, startWeekPostTemplate, midWeekPostTemplate, weekendPostTemplate];
                if (Math.random() > 0.3) {
                    if (['Monday', 'Tuesday'].includes(weekday)) {
                        selectedTemplate = startWeekPostTemplate;
                    } else if (['Wednesday', 'Thursday'].includes(weekday)) {
                        selectedTemplate = midWeekPostTemplate;
                    } else {
                        selectedTemplate = weekendPostTemplate;
                    }
                    elizaLogger.info(`Using scheduled template for ${weekday}`);
                } else {
                    selectedTemplate = templates[Math.floor(Math.random() * templates.length)];
                    elizaLogger.info(`Using random template override for variety`);
                }
            }

            const context = composeContext({
                state,
                template: this.runtime.character.templates?.farcasterPostTemplate || selectedTemplate,
            });

            const newContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.LARGE,
            });

            // Remove dashes and replace with commas. Remove extra spaces.
            const slice = newContent
                .replaceAll(/\\n/g, "\n")
                .replace(/\s*[—–]\s*/g, ", ")
                .replace(/ \s*-\s* /g, ", ")
                .trim();

            let content = slice.slice(0, MAX_CAST_LENGTH);

            await this.runtime.cacheManager.set("farcaster/" + this.fid + "/lastPost", { timestamp: Date.now() });

            if (content.length > MAX_CAST_LENGTH) content = content.slice(0, content.lastIndexOf("\n"));
            if (content.length > MAX_CAST_LENGTH) content = content.slice(0, content.lastIndexOf("."));
            if (content.length > MAX_CAST_LENGTH) content = content.slice(0, content.lastIndexOf("."));

            if (this.runtime.getSetting("FARCASTER_DRY_RUN") === "true") {
                elizaLogger.info(`Dry run: would have cast: ${content}`);
                return;
            }

            try {
                const imageUrl = await this.imageManager.generateAndUploadImage(content, isCuration, isClankerPost);
                const postContent: any = { text: content };
                if (imageUrl) postContent.attachments = [{ url: imageUrl }];

                const [{ cast }] = await sendChannelCast({
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

                elizaLogger.debug(`[Farcaster Debug Context] ${JSON.stringify(context)}`);
                elizaLogger.warn(`[Farcaster Neynar Client] Published cast https://casterscan.com/casts/${cast.hash}`);

                await this.runtime.messageManager.createMemory(
                    createCastMemory({ roomId, senderId: this.runtime.agentId, runtime: this.runtime, cast })
                );
            } catch (error) {
                elizaLogger.error("Error sending cast:", error);
            }
        } catch (error) {
            elizaLogger.error("Error generating new cast:", error);
        }
    }
}
