import {
    composeContext,
    generateText,
    type IAgentRuntime,
    ModelClass,
    stringToUuid,
    elizaLogger,
    generateImage,
} from "@elizaos/core";
import { v2 as cloudinary } from "cloudinary";

import type { FarcasterClient } from "./client";
import { formatTimeline, postTemplate, builderPostTemplate, philosophyPostTemplate, chillPostTemplate } from "./prompts";
import { castUuid, MAX_CAST_LENGTH } from "./utils";
import { createCastMemory } from "./memory";
import { sendChannelCast } from "./actions";

export class FarcasterPostManager {
    client: FarcasterClient;
    runtime: IAgentRuntime;
    fid: number;
    isDryRun: boolean;
    private timeout: NodeJS.Timeout | undefined;

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

        // Log configuration on initialization
        elizaLogger.warn("Farcaster Client Configuration:");
        elizaLogger.warn(`- FID: ${this.fid}`);
        elizaLogger.warn(
            `- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`
        );
        elizaLogger.warn(
            `- Enable Post: ${this.client.farcasterConfig.ENABLE_POST ? "enabled" : "disabled"}`
        );
        if (this.client.farcasterConfig.ENABLE_POST) {

            elizaLogger.warn(
                `- CAST HOUR: ${this.client.farcasterConfig.FARCASTER_CAST_HOURS}`
            );

            elizaLogger.warn(
                `- Post Interval: ${this.client.farcasterConfig.POST_INTERVAL_MIN}-${this.client.farcasterConfig.POST_INTERVAL_MAX} minutes`
            );
            elizaLogger.warn(
                `- Post Immediately: ${this.client.farcasterConfig.POST_IMMEDIATELY ? "enabled" : "disabled"}`
            );
        }
        elizaLogger.warn(
            `- Action Processing: ${this.client.farcasterConfig.ENABLE_ACTION_PROCESSING ? "enabled" : "disabled"}`
        );
        elizaLogger.warn(
            `- Action Interval: ${this.client.farcasterConfig.ACTION_INTERVAL} minutes`
        );

        if (this.isDryRun) {
            elizaLogger.warn(
                "Farcaster client initialized in dry run mode - no actual casts should be posted"
            );
        }
    }


    // Sempre agenda o post em FARCASTER_CAST_HOURS com delay de randeom(minMinutes, maxmMinutes).
    // ✅ Garante que só posta uma vez por dia.
    // ✅ Evita que o post saia fora do horário esperado.
    // 🎯 Agora o post será publicado em um horário aleatório dentro da janela especificada!
    public async start() {
        const generateNewCastLoop = async () => {
            const timezone = "America/Chicago";
            const minMinutes = this.client.farcasterConfig.POST_INTERVAL_MIN;
            const maxMinutes = this.client.farcasterConfig.POST_INTERVAL_MAX;

            const now = new Date();
            const timezoneTime = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false }).format(now);
            const [hour] = timezoneTime.split(':').map(Number);

            if (this.client.farcasterConfig.FARCASTER_CAST_HOURS.includes(hour)) {
                try {
                    const randomDelay = (Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes) * 60 * 1000;
                    setTimeout(async () => {
                        try {
                            await this.generateNewCast();
                        } catch (error) {
                            elizaLogger.error(error);
                        }
                    }, randomDelay);
                    elizaLogger.warn(`Next cast scheduled for ${randomDelay} minutes`);
                } catch (error) {
                    elizaLogger.error(error);
                }
            } else {
                elizaLogger.debug(`Now is not the time to post, waiting for the next cast time`);
                elizaLogger.info(`Now is ${timezoneTime} and the cast time is ${this.client.farcasterConfig.FARCASTER_CAST_HOURS}`);
            }

            elizaLogger.debug(`Next cast verification for 1 hours`);
            setTimeout(generateNewCastLoop, 60 * 60 * 1000); // Re-executa a cada 1 hora
        };

        if (this.client.farcasterConfig.ENABLE_POST) {
            if (this.client.farcasterConfig.POST_IMMEDIATELY) {
                await this.generateNewCast();
            }
            generateNewCastLoop();
        }
    }

    // ORIGINAL:
    // public async start() {
    //     const generateNewCastLoop = async () => {

    //         const lastPost = await this.runtime.cacheManager.get<{
    //             timestamp: number;
    //         }>("farcaster/" + this.fid + "/lastPost");

    //         const lastPostTimestamp = lastPost?.timestamp ?? 0;
    //         const minMinutes = this.client.farcasterConfig.POST_INTERVAL_MIN;
    //         const maxMinutes = this.client.farcasterConfig.POST_INTERVAL_MAX;
    //         const randomMinutes =
    //             Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
    //             minMinutes;
    //         const delay = randomMinutes * 60 * 1000;

    //         if (Date.now() > lastPostTimestamp + delay) {
    //             try {
    //                 await this.generateNewCast();
    //             } catch (error) {
    //                 elizaLogger.error(error);
    //                 return;
    //             }
    //         }

    //         this.timeout = setTimeout(() => {
    //             generateNewCastLoop(); // Set up next iteration
    //         }, delay);

    //         elizaLogger.warn(`Next cast scheduled in ${randomMinutes} minutes`);
    //     };

    //     if (this.client.farcasterConfig.ENABLE_POST) {
    //         if (this.client.farcasterConfig.POST_IMMEDIATELY) {
    //             await this.generateNewCast();
    //         }
    //         generateNewCastLoop();
    //     }
    // }

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

            const { timeline } = await this.client.getTimeline({
                fid: this.fid,
                pageSize: 10,
            });

            this.cache.set("farcaster/timeline", timeline);

            const formattedHomeTimeline = formatTimeline(
                this.runtime.character,
                timeline
            );

            const generateRoomId = stringToUuid("farcaster_generate_room");

            const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date());

            const state = await this.runtime.composeState(
                {
                    roomId: generateRoomId,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: { text: "", action: "" },
                },
                {
                    farcasterUserName: profile.username,
                    timeline: formattedHomeTimeline,
                    weekday: weekday,
                }
            );

            // Select template based on weekday
            let selectedTemplate = postTemplate;
            if (['Monday', 'Tuesday', 'Wednesday'].includes(weekday)) {
                selectedTemplate = builderPostTemplate;
            } else if (['Thursday'].includes(weekday)) {
                selectedTemplate = philosophyPostTemplate;
            } else {
                selectedTemplate = chillPostTemplate;
            }

            // Generate new cast
            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.farcasterPostTemplate ||
                    selectedTemplate,
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

            // if it's bigger than the max limit, delete the last line
            if (content.length > MAX_CAST_LENGTH) {
                content = content.slice(0, content.lastIndexOf("\n"));
            }

            if (content.length > MAX_CAST_LENGTH) {
                // slice at the last period
                content = content.slice(0, content.lastIndexOf("."));
            }

            // if it's still too long, get the period before the last period
            if (content.length > MAX_CAST_LENGTH) {
                content = content.slice(0, content.lastIndexOf("."));
            }

            if (this.runtime.getSetting("FARCASTER_DRY_RUN") === "true") {
                elizaLogger.info(`Dry run: would have cast: ${content}`);
                return;
            }

            try {
                let imageUrl: string | undefined = undefined;

                if (this.client.farcasterConfig.FARCASTER_POST_IMAGE) {
                    try {
                        let imageSettings = this.runtime.character.settings?.imageSettings || {};
                        const imageStyle = this.runtime.getSetting("IMAGE_GENERATE_STYLE") || "64-bit Retro Sci-fi Art";
                        const imagePromptText = `generate an image in **${imageStyle} style"** for this post: "${content}"`;

                        const imageResult = await generateImage({
                            prompt: imagePromptText,
                            width: imageSettings.width || 1024,
                            height: imageSettings.height || 1024,
                            count: imageSettings.count || 1,
                            negativePrompt: imageSettings.negativePrompt || undefined,
                            numIterations: imageSettings.numIterations || 50,
                            guidanceScale: imageSettings.guidanceScale || 7.5,
                            seed: imageSettings.seed || undefined,
                            modelId: imageSettings.modelId || undefined,
                            jobId: imageSettings.jobId || undefined,
                            stylePreset: imageSettings.stylePreset || "",
                            hideWatermark: imageSettings.hideWatermark ?? true,
                            safeMode: imageSettings.safeMode ?? true,
                            cfgScale: imageSettings.cfgScale || undefined,
                        }, this.runtime);

                        if (imageResult.success && imageResult.data && imageResult.data.length > 0) {
                            const cloudName = this.client.farcasterConfig["CLOUDINARY_CLOUD_NAME"];
                            const apiKey = this.client.farcasterConfig["CLOUDINARY_API_KEY"];
                            const apiSecret = this.client.farcasterConfig["CLOUDINARY_API_SECRET"];

                            if (cloudName && apiKey && apiSecret) {
                                cloudinary.config({
                                    cloud_name: cloudName,
                                    api_key: apiKey,
                                    api_secret: apiSecret,
                                });

                                const uploadResult = await cloudinary.uploader.upload(imageResult.data[0], {
                                    folder: this.runtime.character.name.toLowerCase(),
                                });
                                imageUrl = uploadResult.secure_url;
                            } else {
                                elizaLogger.warn("Cloudinary credentials missing, skipping image upload");
                            }
                        } else {
                            elizaLogger.warn("Failed to generate image or no image data returned");
                        }
                    } catch (imageError) {
                        elizaLogger.error("Error generating or uploading image:", imageError);
                        // Continuing to post text-only even if image fails
                    }
                }

                const postContent = {
                    text: content,
                    url: imageUrl
                };

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
                    {
                        hash: cast.hash,
                        timestamp: Date.now(),
                    }
                );

                const roomId = castUuid({
                    agentId: this.runtime.agentId,
                    hash: cast.hash,
                });

                await this.runtime.ensureRoomExists(roomId);

                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                elizaLogger.debug(
                    `[Farcaster Debug Context] ${JSON.stringify(context)}`
                );
                elizaLogger.warn(
                    `[Farcaster Neynar Client] Published cast https://casterscan.com/casts/${cast.hash}`
                );

                await this.runtime.messageManager.createMemory(
                    createCastMemory({
                        roomId,
                        senderId: this.runtime.agentId,
                        runtime: this.runtime,
                        cast,
                    })
                );
            } catch (error) {
                elizaLogger.error("Error sending cast:", error);
            }
        } catch (error) {
            elizaLogger.error("Error generating new cast:", error);
        }
    }
}
