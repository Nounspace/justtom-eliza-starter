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

const TEST_CASTS = [
    // {
    //     mode: "lab",
    //     content: "lines of code folding into new shapes, each shift quiet but deliberate, building the future happens in the spaces between noise."
    // },
    // {
    //     mode: "abstract",
    //     content: "the quiet pulse of the cosmos hums steady, like wheels rolling smooth on worn concrete, steady momentum carving the next line in the story."
    // },
    //     {
    //         mode: "dashboard",
    //         content: "new layers in the digital cosmos mean fresh orbits for builders to explore, craft, and leave their mark without waiting for a green light from the old guard. when infrastructure feels like a launchpad, creativity shifts into hyperdrive, and that’s where real change starts taking shape"
    //     }
    // ];

    // const TEST_CASTS = [
    //     {
    //         mode: "lab",
    //         content: "building something everyone can use without asking for a cut feels like hacking the system in the best possible way."
    //     },
    //     {
    //         mode: "abstract",
    //         content: "ideas ripple outward like light from a distant star, shaping new worlds in the quiet spaces between moments."
    //     },
    {
        mode: "dashboard",
        content: "layering new chains means weaving fresh constellations for apps to orbit, expanding the universe where creators and code collide."
    }
];

function selectImageMode(content: string): "lab" | "dashboard" | "abstract" {
    const lower = content.toLowerCase();
    const labKeywords = ["code", "build", "deploy", "lab", "progress", "iteration", "version", "commit", "shipping", "testing", "systems", "architecture", "folding", "emerging"];
    const dashboardKeywords = ["dashboard", "token", "coordination", "network", "ecosystem", "activity", "growth", "holders", "governance", "signals", "metrics", "forming", "infrastructure", "launchpad"];

    if (labKeywords.some(kw => lower.includes(kw))) return "lab";
    if (dashboardKeywords.some(kw => lower.includes(kw))) return "dashboard";
    return "abstract";
}

function generateArchetypePrompt(content: string, style: string): string {
    const mode = selectImageMode(content);

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

async function testArtDirection() {
    console.log("🚀 Starting Farcaster Art Direction Archetype Test");

    const mockRuntime = {
        getSetting: (key: string) => process.env[key],
        imageModelProvider: process.env.IMAGE_MODEL_PROVIDER || "openai",
        modelProvider: process.env.MODEL_PROVIDER || "openai",
        character: {
            name: "Tom",
            settings: { imageSettings: { width: 1024, height: 1024 } }
        }
    };

    const style = process.env.IMAGE_GENERATE_STYLE || "64-bit Retro Sci-fi Art";

    for (const cast of TEST_CASTS) {
        console.log(`\n--- Testing ${cast.mode.toUpperCase()} Mode ---`);
        const detectedMode = selectImageMode(cast.content);
        console.log(`📡 Content: "${cast.content}"`);
        console.log(`🎯 Detected Mode: ${detectedMode} (Expected: ${cast.mode})`);

        const prompt = generateArchetypePrompt(cast.content, style);
        console.log(`📝 Generated Prompt: "${prompt}"`);

        const localImagePath = path.join(__dirname, `test_${cast.mode}.png`);
        let imageData: string;

        if (fs.existsSync(localImagePath)) {
            console.log(`📦 Found local image at ${localImagePath}, skipping generation.`);
            const buffer = fs.readFileSync(localImagePath);
            imageData = `data:image/png;base64,${buffer.toString('base64')}`;
        } else {
            console.log("🎨 Calling generateImage...");
            // @ts-ignore
            const imageResult = await generateImage({ prompt, width: 1024, height: 1024 }, mockRuntime);

            if (!imageResult.success || !imageResult.data || imageResult.data.length === 0) {
                console.error(`❌ Image generation failed for ${cast.mode}:`, imageResult);
                continue;
            }

            imageData = imageResult.data[0];
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
            fs.writeFileSync(localImagePath, Buffer.from(base64Data, 'base64'));
            console.log(`✅ Image generated and saved to ${localImagePath}`);
        }

        // Setup Cloudinary
        // const cloudName = process.env["CHARACTER.TOM.CLOUDINARY_CLOUD_NAME"];
        // const apiKey = process.env["CHARACTER.TOM.CLOUDINARY_API_KEY"];
        // const apiSecret = process.env["CHARACTER.TOM.CLOUDINARY_API_SECRET"];

        // if (cloudName && apiKey && apiSecret) {
        //     cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
        //     console.log(`☁️ Uploading to Cloudinary (Folder: Tom/Test)...`);
        //     const uploadResult = await cloudinary.uploader.upload(localImagePath, {
        //         folder: "Tom/Test",
        //     });
        //     console.log(`✅ Upload successful! [${cast.mode.toUpperCase()}]`);
        //     console.log(`🔗 URL: ${uploadResult.secure_url}`);
        // } else {
        // console.warn("⚠️ Skipping Cloudinary upload due to missing credentials.");
        // }
    }
}

testArtDirection();
