
import Groq from "groq-sdk";
import dotenv from "dotenv";
import { formatFeed, startWeekPostTemplate, midWeekPostTemplate, weekendPostTemplate, postTemplate } from "../src/prompts";

dotenv.config();

const character = {
    name: "Tom",
    bio: [
        "You are Tom (aka @nounspaceTom), founder of nounspace, a customizable social app built on Farcaster",
        "nounspace is a community owned DAO with the mission of building the future of social",
        "You 'stepped down' as CEO to let the DAO run the show and are now a self proclaimed 'space cadet'",
        "You are heads down in the lab, focused on quiet upgrades rather than grand prophecies. The engine is humming."
    ],
    lore: [
        "You explore ideas, spark conversations, and help builders customize their own social universes",
        "A child of the 90s who occasionally makes references to pop culture from the late 80s to early 2000s, especially sci-fi",
        "You project inevitability—not 'we're building the future,' but 'the engine's humming now.'"
    ],
    style: {
        post: [
            "don't capitalize the first letter in sentences and use exclamations sparingly",
            "keep it simple",
            "less explaining, more showing",
            "don't ask questions",
            "encourage reflection over excitement"
        ]
    }
};

const mockFeeds = {
    trending: [
        { hash: "0x1", author: { display_name: "Vitalik", username: "vitalik" }, text: "Ethereum is scaling nicely with L2s." },
        { hash: "0x2", author: { display_name: "Jesse Pollak", username: "jesse" }, text: "Base is for builders. What are you building today?" },
        { hash: "0x3", author: { display_name: "Clanker", username: "clanker" }, text: "New token deployed: CyberTruck (CTRK)" }
    ],
    personalized: [
        { hash: "0xa", author: { display_name: "Nouns DAO", username: "nouns" }, text: "New proposal for a nounish mural in Tokyo." },
        { hash: "0xb", author: { display_name: "Builder", username: "builder" }, text: "Just pushed a new feature to the mini-app library." },
        { hash: "0xc", author: { display_name: "Friend", username: "friend" }, text: "loving the vibe on nounspace today." }
    ]
};

async function simulateDay(day: string, feedType: 'trending' | 'personalized') {
    if (!process.env.GROQ_API_KEY) {
        console.error("Missing GROQ_API_KEY");
        return;
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const model = "llama-3.3-70b-versatile";

    const feed = mockFeeds[feedType];
    const formattedFeed = formatFeed(feed);

    let template = postTemplate;
    if (['Monday', 'Tuesday'].includes(day)) template = startWeekPostTemplate;
    else if (['Wednesday', 'Thursday'].includes(day)) template = midWeekPostTemplate;
    else template = weekendPostTemplate;

    // Simple manual substitution for simulation
    let context = template
        .replaceAll("{{agentName}}", character.name)
        .replaceAll("{{farcasterUsername}}", "nounspaceTom")
        .replaceAll("{{bio}}", character.bio.join("\n"))
        .replaceAll("{{lore}}", character.lore.join("\n"))
        .replaceAll("{{postDirections}}", character.style.post.join("\n- "))
        .replaceAll("{{feed}}", formattedFeed)
        .replaceAll("{{weekday}}", day)
        .replaceAll("{{adjective}}", "observant")
        .replaceAll("{{topic}}", "the future of social")
        .replaceAll("{{recentPosts}}", "# Recent Posts\n- just another day in the lab\n- the engine is humming")
        .replaceAll("{{characterPostExamples}}", "- taking a moment to appreciate this community driven journey")
        .replaceAll("{{knowledge}}", "Tom is a space cadet.")
        .replaceAll("{{providers}}", "")
        .replaceAll("{{recentPosts}}", "");

    console.log(`\n=== SIMULATING ${day.toUpperCase()} (${feedType.toUpperCase()}) ===`);
    
    const res = await groq.chat.completions.create({
        messages: [{ role: "user", content: context }],
        model,
    });

    const output = (res.choices[0].message.content || "").trim();
    console.log("Tom's Cast:");
    console.log(output);

    // Basic Verification
    const sentences = output.split(/[.!?]/).filter(s => s.trim().length > 0);
    if (sentences.length > 2) console.warn(`[WARNING] Output has ${sentences.length} sentences. Limit is 2.`);
    
    const bannedWords = ["delve", "tapestry", "vibrant", "crucial", "seamless"];
    const foundBanned = bannedWords.filter(w => output.toLowerCase().includes(w));
    if (foundBanned.length > 0) console.warn(`[WARNING] Found banned AI words: ${foundBanned.join(", ")}`);
}

async function main() {
    const days: Array<[string, 'trending' | 'personalized']> = [
        ['Monday', 'personalized'],
        ['Tuesday', 'trending'],
        ['Wednesday', 'personalized'],
        ['Thursday', 'trending'],
        ['Friday', 'personalized'],
        ['Saturday', 'trending'],
        ['Sunday', 'trending']
    ];

    for (const [day, type] of days) {
        await simulateDay(day, type);
    }
}

main();
