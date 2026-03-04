import {
    elizaLogger,
    generateImage,
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
        const labKeywords = ["code", "build", "deploy", "lab", "progress", "iteration", "version", "commit", "shipping", "testing", "systems", "architecture", "folding", "emerging"];
        const dashboardKeywords = ["dashboard", "token", "coordination", "network", "ecosystem", "activity", "growth", "holders", "governance", "signals", "metrics", "forming", "infrastructure", "launchpad"];

        if (labKeywords.some(kw => lower.includes(kw))) return "lab";
        if (dashboardKeywords.some(kw => lower.includes(kw))) return "dashboard";
        return "abstract";
    }

    private generateArchetypePrompt(content: string, style: string): string {
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
    }

    public async generateAndUploadImage(content: string, isCuration: boolean = false): Promise<string | undefined> {
        try {
            const imageProbability = parseFloat(String(this.client.farcasterConfig.FARCASTER_POST_IMAGE_PROBABILITY || "0"));
            const shouldGenerateImage = isCuration || (this.client.farcasterConfig.FARCASTER_POST_IMAGE && Math.random() < imageProbability);

            if (!shouldGenerateImage) return undefined;

            let imageSettings = this.runtime.character.settings?.imageSettings || {};
            const imageStyle = this.runtime.getSetting("IMAGE_GENERATE_STYLE") || "64-bit Retro Sci-fi Art";
            const imagePromptText = this.generateArchetypePrompt(content, imageStyle);

            elizaLogger.debug(`[Farcaster] Image prompt: ${imagePromptText}`);
            elizaLogger.info(`[Farcaster] Generating image for ${isCuration ? "Curation" : "normal"} post...`);

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
                    return uploadResult.secure_url;
                } else {
                    elizaLogger.warn("Cloudinary credentials missing, skipping image upload");
                }
            }
        } catch (error) {
            elizaLogger.error("Error in generateAndUploadImage:", error);
        }
        return undefined;
    }
}
