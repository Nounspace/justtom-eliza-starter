import dotenv from "dotenv";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// Load environment variables from the root .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../../.env") });

const VENICE_API_KEY = process.env.VENICE_API_KEY;

if (!VENICE_API_KEY) {
    console.error("❌ VENICE_API_KEY not found in .env");
    process.exit(1);
}

const imagePrompt = `
Main Subject: the compiler shows the type but the signal is what matters. the engine hums loudest when no one is watching.
Environment: Wires, coffee, late night hum.
Lighting: Neon amber, deep shadows.
Colors: Teal, rust orange, matte black.
Mood: Quiet focus, building the future.
Composition: Low angle, depth of field.
Style: 64-bit Retro Sci-fi Art, pixelated textures.
`;

async function testVeniceImage() {
    console.log("🚀 Starting Venice Image Simulation...");
    console.log("Model: nano-banana-2 (derived from logs)");

    try {
        const response = await fetch("https://api.venice.ai/api/v1/image/generate", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${VENICE_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "nano-banana-2",
                prompt: imagePrompt,
                width: 1024,
                height: 1024,
                steps: 20,
                hide_watermark: true,
                return_binary: false // We want to see the JSON response format
            })
        });

        console.log(`Status: ${response.status} ${response.statusText}`);
        const result = await response.json();

        if (!response.ok) {
            console.error("❌ Venice API Error Response:", JSON.stringify(result, null, 2));
            return;
        }

        // If response.ok is true, but the result itself indicates an error (e.g., a specific error field in the JSON)
        if (result.error) {
            console.error("❌ Venice API Error (from response body):", JSON.stringify(result.error, null, 2));
            return;
        }

        console.log("\n--- RAW RESPONSE STRUCTURE ---");
        console.log(JSON.stringify(result, (key, value) => {
            // Truncate base64 strings so they don't clog the console
            if (typeof value === 'string' && value.length > 100 && (key === 'image' || key === 'images' || value.startsWith('iVBORw') || value.startsWith('/9j/'))) {
                return value.substring(0, 50) + "... [TRUNCATED " + value.length + " chars]";
            }
            return value;
        }, 2));
        console.log("----------------------------\n");

        if (result.images && Array.isArray(result.images)) {
            console.log("✅ Success! Found 'images' array with " + result.images.length + " item(s).");

            // Save the first image to disk
            const base64Image = result.images[0];
            if (base64Image) {
                const hash = crypto.randomBytes(6).toString("hex"); // 12-char hash
                const imagePath = path.join(__dirname, `img_${hash}.webp`);
                try {
                    const fs = await import("fs");
                    const buffer = Buffer.from(base64Image, 'base64');
                    fs.writeFileSync(imagePath, buffer);
                    console.log(`🖼️  Image saved to: ${imagePath}`);
                } catch (fsError) {
                    console.error("❌ Failed to save image to disk:", fsError);
                }
            }
        } else if (result.image) {
            console.warn("⚠️  WARNING: Found single 'image' field instead of 'images' array. This might be why Eliza throws an error!");
        } else {
            console.error("❌ ERROR: Predicted format 'images' array not found in response.");
        }

    } catch (error) {
        console.error("❌ Fetch Error:", error);
    }
}

testVeniceImage();
