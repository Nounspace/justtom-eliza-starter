import {
    elizaLogger,
    generateImage,
    generateText,
    ModelClass,
    type IAgentRuntime,
} from "@elizaos/core";

import { v2 as cloudinary } from "cloudinary";
import type { FarcasterClient } from "./client";

export class FarcasterImageManager {
    constructor(
        private client: FarcasterClient,
        private runtime: IAgentRuntime
    ) { }

    private selectImageMode(content: string): "lab" | "dashboard" | "abstract" {
        const lower = content.toLowerCase();

        const labKeywords = [
            "code", "build", "deploy", "lab", "progress", "iteration",
            "version", "commit", "shipping", "testing", "systems",
            "architecture", "folding", "emerging"
        ];

        const dashboardKeywords = [
            "dashboard", "token", "coordination", "network", "ecosystem",
            "activity", "growth", "holders", "governance", "signals",
            "metrics", "forming", "infrastructure", "launchpad"
        ];

        if (labKeywords.some(kw => lower.includes(kw))) return "lab";
        if (dashboardKeywords.some(kw => lower.includes(kw))) return "dashboard";
        return "abstract";
    }

    /**
     * OLD SYSTEM — kept for reference
     * (currently unused)
     */
    private generateArchetypePrompt(content: string, style: string): string {

        /*
        const mode = this.selectImageMode(content);

        const universe = `
Retro-futuristic digital world inspired by ${style}.
Visible pixel structure.
CRT glow.
Stylized lighting.
No modern UI.
`;

        const constraints = `
Cinematic framing.
No readable text.
No letters.
No numbers.
No logos.
No captions.
No symbols.
No alphanumeric characters.
Interfaces must contain only abstract shapes and geometric patterns.
`;

        let scene = "";

        switch (mode) {
            case "lab":
                scene = `
Inside a retro-tech builder lab.
Monitors showing abstract geometric signal patterns.
Glowing visual modules instead of dashboards.
Subtle human silhouette.
`;
                break;

            case "dashboard":
                scene = `
Massive panoramic window showing cosmic dust.
Layered control consoles with abstract geometric signal patterns.
Network activity represented as flowing light constellations suspended in the air.
No literal UI elements.
`;
                break;

            case "abstract":
                scene = `
Flowing retro digital energy.
Structured pixel-based motion.
Glowing geometric forms.
`;
                break;
        }

        return `${universe}\n${scene}\n${constraints}`;
        */

        return "";
    }

    /**
     * NEW IMAGE PROMPT GENERATOR (LLM powered)
     */
    private async generateLLMImagePrompt(content: string, isCuration: boolean = false, isClankerPost: boolean = false): Promise<string> {

        const IMAGE_SYSTEM_PROMPT = `
You are an expert in writing prompts for AI art generation.
You create vivid visual descriptions.
Return ONLY the description of the image contents.
Never include instructions like "create an image".
`;

        const STYLE =
            this.runtime.getSetting("IMAGE_GENERATE_STYLE")
            || "64-bit Retro Sci-fi Art";

        elizaLogger.debug(`IMAGE_GENERATE_STYLE: "${STYLE}"`);

        let input = "";
        elizaLogger.log(`Generating ${isCuration ? "curation" : "clanker"} post image prompt`);

        if (isClankerPost) {
            input = `
Generate a minimalist digital coin logo or futuristic token symbol prompt from the following content.
The symbol should be the central focus, representing a new technical "shape" or concept.

<content>
${content}
</content>

<style>
${STYLE}
</style>

Important Constraints:
- Focus on abstract geometric patterns and technical metaphors.
- Single central icon.

Structure the prompt with:
Main symbol
Environment (minimalist/void/technical)
Lighting (glowing/circuitry/geometric)
Colors
Mood
Composition (perfectly centered)
Style

Limit the prompt to 50 words.
Return ONLY the prompt text.
`;
        } else {
            input = `
Generate an image prompt from the following content.

<content>
${content}
</content>

<style>
${STYLE}
</style>

Structure the prompt with:

Main subject
Environment
Lighting
Colors
Mood
Composition
Style

Limit the prompt to 50 words.
Return ONLY the prompt text.
`;
        }

        const imagePrompt = await generateText({
            runtime: this.runtime,
            context: input,
            modelClass: ModelClass.MEDIUM,
            customSystemPrompt: IMAGE_SYSTEM_PROMPT,
        });

        elizaLogger.log("Image prompt received:", imagePrompt);

        return imagePrompt.trim();
    }

    public async generateAndUploadImage(
        content: string,
        isCuration: boolean = false,
        isClankerPost: boolean = false
    ): Promise<string | undefined> {

        try {

            const imageProbability = parseFloat(
                String(this.client.farcasterConfig.FARCASTER_POST_IMAGE_PROBABILITY || "0")
            );

            const shouldGenerateImage =
                isCuration ||
                isClankerPost ||
                (this.client.farcasterConfig.FARCASTER_POST_IMAGE &&
                    Math.random() < imageProbability);

            if (!shouldGenerateImage) return undefined;

            const imageSettings =
                this.runtime.character.settings?.imageSettings || {};

            const imagePromptText =
                await this.generateLLMImagePrompt(content, isCuration, isClankerPost);

            elizaLogger.debug(`[Farcaster][${this.runtime.character.name}] Image prompt: ${imagePromptText}`);
            elizaLogger.info(`[Farcaster][${this.runtime.character.name}] Generating image...`);

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

            if (imageResult.success && imageResult.data?.length) {

                const cloudName =
                    this.client.farcasterConfig["CLOUDINARY_CLOUD_NAME"];
                const apiKey =
                    this.client.farcasterConfig["CLOUDINARY_API_KEY"];
                const apiSecret =
                    this.client.farcasterConfig["CLOUDINARY_API_SECRET"];

                if (cloudName && apiKey && apiSecret) {

                    cloudinary.config({
                        cloud_name: cloudName,
                        api_key: apiKey,
                        api_secret: apiSecret,
                    });

                    const uploadResult = await cloudinary.uploader.upload(
                        imageResult.data[0],
                        {
                            folder: this.runtime.character.name.toLowerCase(),
                        }
                    );

                    return uploadResult.secure_url;
                }

                elizaLogger.warn(
                    "Cloudinary credentials missing, skipping upload"
                );
            }

        } catch (error) {
            elizaLogger.error("Error in generateAndUploadImage:", error);
        }

        return undefined;
    }
}