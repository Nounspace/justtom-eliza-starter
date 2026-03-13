
import { createClient } from "@supabase/supabase-js";
import { v5 as uuidv5 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

function stringToUuid(str: string): string {
    const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // Default UUID namespace
    return uuidv5(str, NAMESPACE);
}

async function main() {
    const curationRoomId = stringToUuid("farcaster-clanker.space-room");
    console.log(`Curation Room ID (UUID): ${curationRoomId}`);

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
        process.exit(1);
    }

    const supabase = createClient(url, key);
    const { data: memories } = await supabase
        .from("memories")
        .select("*")
        .eq("roomId", curationRoomId)
        .order("createdAt", { ascending: false })
        .limit(5);

    console.log(`Found ${memories?.length || 0} memories in this room.`);
    memories?.forEach(m => {
        console.log(`- [${new Date(m.createdAt).toISOString()}] ${m.content.text}`);
    });
}

main();
