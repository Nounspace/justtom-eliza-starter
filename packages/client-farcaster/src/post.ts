import {
    composeContext,
    generateText,
    type IAgentRuntime,
    ModelClass,
    stringToUuid,
    elizaLogger,
} from "@elizaos/core";

import type { FarcasterClient } from "./client";
import { formatTimeline, postTemplate } from "./prompts";
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
            }

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
                }
            );

            // Generate new cast
            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.farcasterPostTemplate ||
                    postTemplate,
            });

            const newContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.LARGE,
            });

            const slice = newContent.replaceAll(/\\n/g, "\n").trim();

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
                const [{ cast }] = await sendChannelCast({
                    client: this.client,
                    runtime: this.runtime,
                    signerUuid: this.signerUuid,
                    roomId: generateRoomId,
                    content: { text: content },
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

                elizaLogger.info(
                    `[Farcaster Neynar Client] Published cast ${cast.hash}`
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
