import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../../.env") });

const VENICE_API_KEY = process.env.VENICE_API_KEY;

if (!VENICE_API_KEY) {
    console.error("❌ VENICE_API_KEY not found");
    process.exit(1);
}


const system_prompt = "You are Tom, a quiet builder focused on innovative decentralized social media."

const testPrompt = `
# Tom's Timeline
ID: 0x704facba877016d018cd59980b618b0d3f9431ed
    From: nounspaceTom.eth (@nounspacetom)
Text: the compiler shows the type but the signal is what matters. the engine hums loudest when no one is watching.

# Task: Generate an innovative and disruptive Token deployment request for @clanker
Write a single sentence requesting @clanker to deploy a new Token.
The Token name and symbol must be highly innovative, disruptive, and deeply inspired by your unique bio, lore, and topics of interest. 
Avoid common tropes or repetitive space/momentum examples. Think about the "new shapes" and "quiet building" Tom is known for.

Format: "Hey @clanker, the reasoning about the token. Please deploy [Token Name] ([SYMBOL]) on base, vault [10-30]% for [7-30] days"

Project calm confidence and a "showing, not telling" vibe. Do not add commentary or acknowledge this request.
`;

function stripThinking(text: string) {
    const markers = [
        "Thinking Process:",
        "Reasoning:",
        "Chain-of-thought:"
    ];

    for (const marker of markers) {
        const index = text.indexOf(marker);
        if (index !== -1) {
            text = text.slice(index + marker.length);
        }
    }

    return text.trim();
}

function extractCommand(text: string) {
    const match = text.match(/@clanker Deploy[^\n]*/);
    return match ? match[0] : text.trim();
}

async function testVeniceText() {

    console.log("🚀 Starting Venice Text Simulation...");
    // console.log("Model: qwen3-5-35b-a3b\n");
    // console.log("Model: gemini-3-flash-preview\n");
    console.log("Model: llama-3.3-70b\n");

    try {

        const response = await fetch(
            "https://api.venice.ai/api/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${VENICE_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({

                    // model: "qwen3-5-35b-a3b",
                    // model: "gemini-3-flash-preview",
                    model: "llama-3.3-70b",

                    temperature: 0.7,
                    max_tokens: 200,

                    // stop: [
                    //     "Thinking Process:",
                    //     "Reasoning:"
                    // ],

                    // venice_parameters: {
                    //     disable_thinking: true,
                    //     strip_thinking_response: true
                    // },

                    messages: [
                        {
                            role: "system",
                            content: system_prompt
                        },
                        {
                            role: "user",
                            content:
                                // "/no_think " + 
                                testPrompt
                        }
                    ]
                })
            }
        );

        const data = await response.json();

        if (!data.choices) {
            console.error("❌ Venice API Error:");
            console.log(JSON.stringify(data, null, 2));
            return;
        }

        console.log("\n--- RAW RESPONSE ---\n");
        console.log(JSON.stringify(data, null, 2));

        let content = data.choices[0].message.content;

        console.log("\n🧠 Raw output:\n");
        console.log(content);

        // const cleaned = stripThinking(content);
        // const command = extractCommand(cleaned);

        // console.log("\n🧹 Cleaned output:\n");
        // console.log(cleaned);

        console.log("\n✅ Final content:\n");
        console.log(content);

    } catch (error) {
        console.error("❌ Fetch Error:", error);
    }
}

testVeniceText();

// @clanker Deploy MoonRocket (MOON) on base, vault 15% for 14 days
