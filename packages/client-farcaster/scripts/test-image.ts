import { v2 as cloudinary } from "cloudinary";
import { generateImage, elizaLogger } from "../../../packages/core/src/index";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from the root .env file
dotenv.config({ path: path.join(__dirname, "../../../.env") });

async function testImageGenerationAndUpload() {
    console.log("🚀 Starting Farcaster Image Generation & Cloudinary Upload Test");

    // 1. Setup Mock Runtime
    const mockRuntime = {
        getSetting: (key: string) => {
            return process.env[key];
        },
        imageModelProvider: process.env.IMAGE_MODEL_PROVIDER || "openai",
        modelProvider: process.env.MODEL_PROVIDER || "openai",
        character: {
            name: "Tom",
            settings: {
                imageSettings: {
                    width: 1024,
                    height: 1024,
                }
            }
        }
    };

    const localImagePath = path.join(__dirname, "test_image.png");
    let imageData: string;

    // 2. Load or Generate Image
    if (fs.existsSync(localImagePath)) {
        console.log(`📦 Found local image at ${localImagePath}, skipping generation to save tokens.`);
        const buffer = fs.readFileSync(localImagePath);
        imageData = `data:image/png;base64,${buffer.toString('base64')}`;
    } else {
        const testContent = "lines of code folding into new shapes, each shift quiet but deliberate, building the future happens in the spaces between noise.";
        const style = mockRuntime.getSetting("IMAGE_GENERATE_STYLE") || "64-bit Retro Sci-fi Art";
        const prompt = `generate an image in ${style} style for this text: ${testContent}`;

        console.log(`📝 Generated Prompt: "${prompt}"`);
        console.log("🎨 Calling generateImage...");

        // @ts-ignore - simplified mock runtime
        const imageResult = await generateImage({
            prompt: prompt,
            width: 1024,
            height: 1024,
        }, mockRuntime);

        if (!imageResult.success || !imageResult.data || imageResult.data.length === 0) {
            console.error("❌ Image generation failed:", imageResult);
            return;
        }

        imageData = imageResult.data[0];
        console.log("✅ Image generated successfully.");

        // Save locally for future tests
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
        fs.writeFileSync(localImagePath, Buffer.from(base64Data, 'base64'));
        console.log(`💾 Saved image locally to ${localImagePath}`);
    }

    try {
        // 3. Upload to Cloudinary
        const cloudName = process.env["CHARACTER.TOM.CLOUDINARY_CLOUD_NAME"];
        const apiKey = process.env["CHARACTER.TOM.CLOUDINARY_API_KEY"];
        const apiSecret = process.env["CHARACTER.TOM.CLOUDINARY_API_SECRET"];

        if (!cloudName || !apiKey || !apiSecret) {
            console.error("❌ Missing Cloudinary credentials in .env. Please check CHARACTER.TOM.CLOUDINARY_* variables.");
            console.log("Current env keys available:", Object.keys(process.env).filter(k => k.includes("CLOUDINARY")));
            return;
        }

        console.log("☁️ Configuring Cloudinary...");
        console.log(`- Cloud Name: ${cloudName}`);
        console.log(`- API Key: ${apiKey.substring(0, 4)}... (length: ${apiKey.length})`);
        console.log(`- API Secret: ${apiSecret.substring(0, 2)}... (length: ${apiSecret.length})`);

        cloudinary.config({
            cloud_name: cloudName,
            api_key: apiKey,
            api_secret: apiSecret,
        });

        console.log(`⬆️ Uploading to Cloudinary (Folder: ${mockRuntime.character.name})...`);
        const uploadResult = await cloudinary.uploader.upload(localImagePath, {
            folder: mockRuntime.character.name,
        });

        console.log("✅ Upload successful!");
        console.log("🔗 Image URL:", uploadResult.secure_url);

    } catch (error: any) {
        console.error("💥 Test failed with error:");
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Data:", error.response.data);
        } else {
            console.error(JSON.stringify(error, null, 2));
        }
    }
}

testImageGenerationAndUpload();

