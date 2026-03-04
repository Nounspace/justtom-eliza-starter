
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
        console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
        process.exit(1);
    }

    const supabase = createClient(url, key);

    const query = process.argv[2] || "rovio";
    const limit = parseInt(process.argv[3]) || 10;
    const isAsc = (process.argv[4] || "desc").toLowerCase() === "asc";

    console.log(`--- Memory Search Tool (Supabase) ---`);
    console.log(`Searching for: "${query}"`);
    console.log(`Settings: limit=${limit}, order=${isAsc ? 'asc' : 'desc'}`);

    try {
        const { data, count, error } = await supabase
            .from("memories")
            .select("*", { count: "exact" })
            .ilike("content->>text", `%${query}%`)
            .order("createdAt", { ascending: isAsc })
            .limit(limit);

        if (error) throw error;

        console.log(`\nTotal matches in database: ${count}`);
        console.log(`Displaying top ${data?.length || 0} results:`);
        console.log('---');

        data?.forEach((row, index) => {
            console.log(`${index + 1}. ID: ${row.id}`);
            console.log(`   Room: ${row.roomId}`);
            console.log(`   User: ${row.userId}`);
            console.log(`   Agent: ${row.agentId}`);
            console.log(`   Created: ${new Date(row.createdAt).toISOString()}`);
            console.log(`   Text: ${row.content.text}`);
            console.log('----------------------\n');
        });
    } catch (error) {
        console.error("Error searching memories:", error);
    } finally {
        process.exit(0);
    }
}

main().catch(console.error);
