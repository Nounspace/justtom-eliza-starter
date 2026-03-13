
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
    console.log("--- Inspecting Curation Signals ---");

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
        console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
        process.exit(1);
    }

    const supabase = createClient(url, key);

    try {
        const { data: memories, error } = await supabase
            .from("memories")
            .select("*")
            .eq("content->>source", "clanker-deploy")
            .order("createdAt", { ascending: false })
            .limit(10);

        if (error) throw error;

        if (!memories || memories.length === 0) {
            console.log("No memories found with source 'clanker-deploy'");

            // Try searching by text pattern
            const { data: searchMemories } = await supabase
                .from("memories")
                .select("*")
                .ilike("content->>text", "%clanker.world%")
                .limit(5);

            if (searchMemories && searchMemories.length > 0) {
                console.log("\nFound memories via text search (clanker.world):");
                searchMemories.forEach(m => {
                    console.log(`- [${new Date(m.createdAt).toISOString()}] Text: ${m.content.text}`);
                    console.log(`  Source: ${m.content.source}`);
                    console.log(`  Room: ${m.roomId}`);
                });
            }
            return;
        }

        console.log(`Found ${memories.length} curation signals.`);
        memories.forEach(m => {
            console.log(`\n- [${new Date(m.createdAt).toISOString()}]`);
            console.log(`  Content: ${m.content.text}`);
            console.log(`  URL: ${m.content.url}`);
            console.log(`  Room: ${m.roomId}`);
        });

    } catch (error) {
        console.error("Error:", error);
    } finally {
        process.exit(0);
    }
}

main();
