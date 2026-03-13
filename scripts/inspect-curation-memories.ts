
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
    console.log("--- Inspecting Curation Memories ---");

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
        console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
        process.exit(1);
    }

    const supabase = createClient(url, key);

    // Curation room ID
    const curationRoomId = "f9cbb0b1-838c-0231-a6ab-76480473aad8"; // From user logs

    try {
        const { data: memories, error } = await supabase
            .from("memories")
            .select("*")
            .eq("roomId", curationRoomId)
            .order("createdAt", { ascending: false })
            .limit(10);

        if (error) throw error;

        if (!memories || memories.length === 0) {
            console.log("No memories found for room:", curationRoomId);
            // Try searching by text if room ID changed
            const { data: searchMemories } = await supabase
                .from("memories")
                .select("*")
                .ilike("content->>text", "%clanker.world%")
                .limit(5);

            if (searchMemories && searchMemories.length > 0) {
                console.log("\nFound memories via alternative search:");
                searchMemories.forEach(m => {
                    console.log(`- [${m.createdAt}] Text: ${m.content.text}`);
                    console.log(`  Source: ${m.content.source}`);
                });
            }
            return;
        }

        console.log(`Found ${memories.length} memories.`);
        memories.forEach(m => {
            console.log(`\n- [${new Date(m.createdAt).toISOString()}]`);
            console.log(`  Content: ${m.content.text}`);
            console.log(`  URL: ${m.content.url}`);
        });

    } catch (error) {
        console.error("Error:", error);
    } finally {
        process.exit(0);
    }
}

main();
