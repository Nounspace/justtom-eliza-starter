
import Groq from "groq-sdk";
import { createClient } from "@supabase/supabase-js";
import { sha1 } from "js-sha1";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

function stringToUuid(target: string | number): string {
    if (typeof target === "number") target = target.toString();
    if (typeof target !== "string") throw TypeError("Value must be string");

    const _uint8ToHex = (ubyte: number): string => {
        const first = ubyte >> 4;
        const second = ubyte - (first << 4);
        const HEX_DIGITS = "0123456789abcdef".split("");
        return HEX_DIGITS[first] + HEX_DIGITS[second];
    };
    const _uint8ArrayToHex = (buf: Uint8Array): string => {
        let out = "";
        for (let i = 0; i < buf.length; i++) out += _uint8ToHex(buf[i]);
        return out;
    };

    const escapedStr = encodeURIComponent(target);
    const buffer = new Uint8Array(escapedStr.length);
    for (let i = 0; i < escapedStr.length; i++) buffer[i] = escapedStr[i].charCodeAt(0);

    const hash = sha1(buffer);
    const hashBuffer = new Uint8Array(hash.length / 2);
    for (let i = 0; i < hash.length; i += 2) {
        hashBuffer[i / 2] = Number.parseInt(hash.slice(i, i + 2), 16);
    }

    return (_uint8ArrayToHex(hashBuffer.slice(0, 4)) +
        "-" +
        _uint8ArrayToHex(hashBuffer.slice(4, 6)) +
        "-" +
        _uint8ToHex(hashBuffer[6] & 0x0f) +
        _uint8ToHex(hashBuffer[7]) +
        "-" +
        _uint8ToHex((hashBuffer[8] & 0x3f) | 0x80) +
        _uint8ToHex(hashBuffer[9]) +
        "-" +
        _uint8ArrayToHex(hashBuffer.slice(10, 16)));
}

async function main() {
    if (!process.env.GROQ_API_KEY) {
        console.error("Missing GROQ_API_KEY");
        return;
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
        console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
        return;
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const model = "llama-3.3-70b-versatile";

    // Step 0: Load Character Context
    console.log("Loading character context...");
    const charPath = path.resolve(process.cwd(), "characters/captainClankit.json");
    const character = JSON.parse(fs.readFileSync(charPath, "utf-8"));
    const agentName = character.name;
    const farcasterUsername = character.settings?.FARCASTER_USERNAME || "captainClankit";
    const bio = Array.isArray(character.bio) ? character.bio.join("\n") : character.bio;
    const lore = Array.isArray(character.lore) ? character.lore.join("\n") : character.lore;
    const postDirections = Array.isArray(character.style?.post) ? character.style.post.join("\n") : "";
    const adjectives = Array.isArray(character.adjectives) ? character.adjectives.join(", ") : "";
    const topics = Array.isArray(character.topics) ? character.topics.join(", ") : "";

    const characterContext = `
About ${agentName} (@${farcasterUsername}):
${bio}
${lore}

Post Directions:
${postDirections}
`;

    // Step 1: Fetch memories from the last 24 hours
    const curationRoomId = stringToUuid("farcaster-clanker.space-room");
    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

    console.log("Fetching live signals from Supabase (last 24h)...");
    const { data: dbMemories, error } = await supabase
        .from("memories")
        .select("*")
        .eq("roomId", curationRoomId)
        .gte("createdAt", new Date(twentyFourHoursAgo).toISOString())
        .lte("createdAt", new Date(now).toISOString())
        .order("createdAt", { ascending: false })
        .limit(150);

    if (error) {
        console.error("Supabase Error:", error);
        return;
    }

    if (!dbMemories || dbMemories.length === 0) {
        console.warn("No curation signals found in the last 24 hours.");
        return;
    }

    // Agent ID of Clanker (or the bot running this) - mock for now since we just need to filter out the bot itself
    // We'll skip the self-filter in simulation to ensure we get data, or just use the same extraction logic
    const extractDeployer = (text: string): string => {
        const match = text?.match(/\(by @([^)]+)\)/);
        return match ? match[1] : "unknown";
    };

    const deployCountByUser = new Map<string, number>();
    for (const m of dbMemories) {
        const deployer = extractDeployer(m.content.text);
        deployCountByUser.set(deployer, (deployCountByUser.get(deployer) || 0) + 1);
    }

    const spammers = new Set<string>();
    for (const [deployer, count] of deployCountByUser) {
        if (count > 5) {
            spammers.add(deployer);
            console.log(`[Spam Filter] Removed @${deployer} (${count} deploys)`);
        }
    }

    const rawSignals = dbMemories
        .filter(m => !spammers.has(extractDeployer(m.content.text)))
        .map(m => m.content.text);

    console.log(`Processing ${rawSignals.length} valid signals (after filtering ${spammers.size} spammers).`);
    
    if (rawSignals.length > 0) {
        console.log("\n--- Valid Signals sent to LLM ---");
        rawSignals.forEach((s, i) => console.log(`${i + 1}. ${s}`));
    }

    if (rawSignals.length === 0) return;

    // Step 1.5: Generate Stats Post
    console.log("\nGenerating Stats Preamble...");
    const statsPrompt = `
# Context
Today's Scan Results:
Total Deployments Seen: 80 (Simulated)
Low Reputation Filtered: ${spammers.size}
Engaged (Valid Gems): ${rawSignals.length}

# Task: Generate a "Captain's Log" style daily stats post.
Write a 1-2 sentence Farcaster post reporting these numbers to the community.
Mention that the daily curation Gems report is coming up shortly.

Style: Professional, observant, builder-focused. No emojis. No generic praise. Concise.
Use the exact numbers provided.
`;
    const statsRes = await groq.chat.completions.create({
        messages: [{ role: "user", content: statsPrompt }],
        model,
    });
    
    console.log("--- STATS PREAMBLE POST ---");
    console.log(statsRes.choices[0].message.content?.replace(/^"|"$/g, '').trim());
    console.log("---------------------------\n");

    // Step 2: Rank the signals into Gems using Groq
    console.log("\nRanking signals (Extracting top 3 gems)...");
    const batchText = rawSignals.map(t => `- ${t}`).join("\n");
    const rankingContext = `
# Task: Identify high-potential token launches from these Farcaster messages.
# Instructions:
1. Identify the top 2-3 "Gems". Return them in this format: "GEMS: TOKEN_NAME [Link: http://...]".
2. Provide a 1-sentence "Sentiment" or "Reason" for this batch. 
   - STRICT RULE: The sentiment/reason MUST be general.
   - NEVER include token names, user handles, or placeholders like "TOKEN" or "TOKEN by @user" in the sentiment.
   - Example Good: "AI and utility tokens are showing strong builder intent."
   - Example Bad: "Notable launches include TOKEN by @user..."
   - Return it as "SENTIMENT: [Reason]".

- The message might look like "Token X deployed... [Link: http://...]". Capture both for GEMS.
- Ignore noisy instructions about themes/fidgets.
- No other text or commentary.

Messages:
${batchText}
`;

    const rankRes = await groq.chat.completions.create({
        messages: [{ role: "user", content: rankingContext }],
        model,
    });

    const rankText = rankRes.choices[0].message.content || "";
    
    console.log("\n--- Raw LLM Ranking Response ---");
    console.log(rankText);
    console.log("--------------------------------\n");

    const lines = rankText.split(/[\n|;]/).map(l => l.trim()).filter(l => l.length > 0);

    const batchGems = lines
        .filter(l => l.toUpperCase().startsWith("GEMS:"))
        .flatMap(l => {
            const gemsText = l.replace(/^GEMS:/i, "").trim();
            const parts: string[] = [];
            let current = "";
            let bracketDepth = 0;
            for (const char of gemsText) {
                if (char === "[") bracketDepth++;
                if (char === "]") bracketDepth--;
                if (char === "," && bracketDepth === 0) {
                    parts.push(current.trim());
                    current = "";
                } else {
                    current += char;
                }
            }
            if (current.trim()) parts.push(current.trim());
            return parts;
        });

    const sanitizedObservation = lines.find(l => l.toUpperCase().startsWith("MARKET_OBSERVATION:"))?.replace(/^MARKET_OBSERVATION:/i, "").trim() || "Normal builder activity.";
    
    // Safeguard: Sanitize observation to strip any accidental placeholders
    const cleanObservation = sanitizedObservation
        .replace(/TOKEN\s*(?:by\s*)?@\w+/gi, "")
        .replace(/TOKEN\d?/gi, "")
        .replace(/notable launches include:?/gi, "")
        .replace(/\s*,\s*and\s*/gi, " ")
        .replace(/\s\s+/g, " ")
        .trim() || "Professional builder energy remains steady.";

    console.log("Gems:", batchGems);
    console.log("Observation:", cleanObservation);

    // Step 3: Extract token name: link lines
    const tokenLines = batchGems.slice(0, 3).map(gem => {
        const linkMatch = gem.match(/\[Link:\s*(https?:\/\/[^\]]+)\]/i);
        const tokenName = gem.replace(/\s*\[Link:.*?\]/i, "").replace(/\s*by\s*@\S+/i, "").trim();
        if (linkMatch && tokenName) return `${tokenName}: ${linkMatch[1]}`;
        return tokenName || gem;
    });

    // Step 4: Ask LLM for prose parts only (JSON)
    console.log("\nGenerating prose (JSON)...");
    const prosePrompt = `
${characterContext}

# Context
Market Observation: ${cleanObservation}

# Task: Generate curation post surrounding commentary as JSON in the voice of ${agentName}.
Return a JSON object with exactly these 3 fields:
{
  "intro": "A short opening sentence about the overall token activity or builder energy. 1 sentence max.",
  "vibe": "A brief reflection on the general ecosystem sentiment based on the Market Observation. 1 sentence max.",
  "outro": "A sharp, observant closing statement. 1 sentence max."
}

Style: ${adjectives}. ${character.style?.all?.join(". ") || ""}

STRICT NEGATIVE CONSTRAINTS:
- NEVER mention specific token names, projects, or list anything in these fields.
- NEVER use placeholders like "TOKEN" or "TOKEN by @user".
- NEVER mention "notable launches" or "what caught your attention".
- These fields provide surrounding context only; the actual list of projects is injected by the system separately.

Return ONLY valid JSON, no commentary or markdown formatting.`;

    const res = await groq.chat.completions.create({
        messages: [{ role: "user", content: prosePrompt }],
        model,
    });

    let raw = res.choices[0].message.content || "";
    
    // Venice Hardening: Strip Llama meta-tags
    raw = raw
        .replace(/<think>[\s\S]*?<\/think>\s*\n*/g, "")
        .replace(/<\|start_header_id\|>.*?<\|end_header_id\|>\s*\n*/g, "")
        .replace(/<\|reserved_special_token_.*?\|>\s*\n*/g, "");

    // Step 5: Parse JSON
    let intro = "", vibe = "", outro = "";
    
    const parseJSONObjectFromText = (text: string) => {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            try {
                return JSON.parse(text.substring(start, end + 1));
            } catch (e) {
                return null;
            }
        }
        return null;
    };

    const parsed = parseJSONObjectFromText(raw);
    
    if (parsed && (parsed.intro || parsed.vibe || parsed.outro)) {
        // Keep it clean but natural. We've hardened the prompt, so we just do a 
        // light pass to ensure no generic "TOKEN" or "TOKENS" words remained.
        const clean = (text: string) => 
            text?.replace(/\bTOKEN\d?S?\b/gi, "").replace(/\s\s+/g, " ").trim();

        intro = clean(parsed.intro || "");
        vibe = clean(parsed.vibe || "");
        outro = clean(parsed.outro || "");
    } else {
        console.error("Failed to parse JSON, using fallback commentary");
        intro = cleanObservation;
    }

    // Step 6: Assemble final post with blank lines around tokens
    const proseTop = [intro, vibe].filter(p => p.length > 0).join("\n");
    const tokenBlock = tokenLines.join("\n");
    const assembledPost = [proseTop, "", tokenBlock, "", outro].filter((p, i) => {
        if (p === "") return i > 0 && i < 4;
        return p.length > 0;
    }).join("\n");

    console.log("\n--- FINAL ASSEMBLED POST ---");
    console.log(assembledPost);
    console.log("----------------------------");
    console.log(`Length: ${assembledPost.length} chars`);
}

main();
