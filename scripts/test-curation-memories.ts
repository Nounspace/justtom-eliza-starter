
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import Groq from "groq-sdk";

dotenv.config();

async function main() {
    console.log("--- Farcaster Curation Pipeline Simulator (PROD-SYNC) ---");

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    const groqKey = process.env.GROQ_API_KEY;

    if (!url || !key) {
        console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
        process.exit(1);
    }

    const supabase = createClient(url, key);
    const groq = groqKey ? new Groq({ apiKey: groqKey }) : null;

    const query = process.argv[2] || "token space:";
    const limit = parseInt(process.argv[3]) || 60;

    console.log(`\n[Step 1] Sourcing memories for testing...`);
    console.log(`Query: "${query}" (Limit: ${limit})`);

    try {
        const { data: memories, error } = await supabase
            .from("memories")
            .select("*")
            .ilike("content->>text", `%${query}%`)
            .order("createdAt", { ascending: false })
            .limit(limit);

        if (error) throw error;

        if (!memories || memories.length === 0) {
            console.log("No memories found matching that query.");
            return;
        }

        const totalCount = memories.length;
        console.log(`Found ${totalCount} memories to process.`);

        const rawSignals = memories.map(m => m.content.text);
        const batchSize = 30;
        const batches: string[][] = [];
        for (let i = 0; i < rawSignals.length; i += batchSize) {
            batches.push(rawSignals.slice(i, i + batchSize));
        }

        console.log(`\n[Step 2] Processing ${batches.length} batches...`);

        const allFinalists: string[] = [];
        const allSentiments: string[] = [];

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            if (!groq) break;

            console.log(`\n--- Batch ${i + 1} ---`);
            const batchText = batch.map(t => `- ${t}`).join("\n");
            const rankingContext = `
# Task: Identify high-potential token launches from these Farcaster messages.
# Instructions:
1. Identify the top 2-3 "Gems". Return them in this format: "GEMS: TOKEN_NAME by @USER".
2. Provide a 1-sentence "Sentiment" or "Reason" for this batch (e.g., "AI tokens are showing strong builder intent"). Return it as "SENTIMENT: [Reason]".
- No other text or commentary.

Messages:
${batchText}
`;

            const completion = await groq.chat.completions.create({
                messages: [{ role: "user", content: rankingContext }],
                model: "llama-3.3-70b-versatile",
            });

            const result = completion.choices[0].message.content || "";
            const lines = result.split("\n").map(l => l.trim());

            const batchGems = lines.filter(l => l.startsWith("GEMS:")).map(l => l.replace("GEMS:", "").trim());
            const batchSentiment = lines.find(l => l.startsWith("SENTIMENT:"))?.replace("SENTIMENT:", "").trim();

            if (batchSentiment) {
                console.log(`[Sentiment] ${batchSentiment}`);
                allSentiments.push(batchSentiment);
            }
            batchGems.forEach(f => {
                console.log(`[Voted] ${f}`);
                allFinalists.push(f);
            });
        }

        if (allFinalists.length > 0 && groq) {
            console.log("\n[Step 3] Generating Final LORE-RICH Post (Production Simulation)");
            const curatedMemories = allFinalists.join("\n");
            const vibeAnalysis = allSentiments.join(" ");

            const finalContext = `
# Context
Observed Volume: ${totalCount} tokens seen today.
Vibe Analysis: ${vibeAnalysis}
Top Highlights:
${curatedMemories}

# Task: Generate a CONCISE, LORE-RICH curation post
Using your knowledge and the Context provided, identify the most interesting token deployments.
Structure:
1. Start with a lore-infused count observation (e.g., "Today I see ${totalCount} tokens...", "Observed ${totalCount} attempts at new shapes..."). 
2. Weave the Vibe Analysis into a cohesive reflection on the current builder energy.
3. List the top highlights (max 3) concisely using the pattern: "[TOKEN] by @user".
4. End with a sharp, observant statement in your unique voice.

Style: Professional, observant, builder-focused. No generic praise. Be extremely concise (max 280 chars total). No emojis. Show, don't tell.

Return ONLY the final post text. No commentary.
`;
            const finalCompletion = await groq.chat.completions.create({
                messages: [{ role: "user", content: finalContext }],
                model: "llama-3.3-70b-versatile",
            });

            console.log("\n--- FINAL PRODUCTION STYLE POST ---");
            console.log(finalCompletion.choices[0].message.content);
            console.log("------------------------------------\n");
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        process.exit(0);
    }
}

main();
