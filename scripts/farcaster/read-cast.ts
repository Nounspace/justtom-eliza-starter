import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// Load environment variables from .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');
dotenv.config({ path: path.join(rootDir, '.env') });

async function getCast(apiKey: string, identifier: string) {
    console.log(`\n🔍 Fetching cast: ${identifier}...`);

    try {
        const url = new URL('https://api.neynar.com/v2/farcaster/cast');
        url.searchParams.append('type', 'hash');
        url.searchParams.append('identifier', identifier);

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'accept': 'application/json',
                'x-api-key': apiKey,
            },
        });

        const data: any = await response.json();
        
        if (response.ok && data.cast) {
            const cast = data.cast;
            console.log(`\n--- Cast Details ---`);
            console.log(`👤 Author: ${cast.author.display_name} (@${cast.author.username})`);
            console.log(`📅 Date: ${new Date(cast.timestamp).toLocaleString()}`);
            console.log(`📝 Text:`);
            console.log(`   ${cast.text}`);
            
            if (cast.embeds && cast.embeds.length > 0) {
                console.log(`🖼️ Embeds:`);
                cast.embeds.forEach((e: any, i: number) => console.log(`   ${i + 1}. ${e.url}`));
            }

            console.log(`📈 Stats:`);
            console.log(`   Replies: ${cast.replies?.count || 0}`);
            console.log(`   Recasts: ${cast.reactions?.recasts?.length || 0}`);
            console.log(`   Likes:   ${cast.reactions?.likes?.length || 0}`);
            console.log(`\n🔗 Hash: ${cast.hash}`);
            if (cast.parent_hash) console.log(`🔗 Parent: ${cast.parent_hash}`);
            console.log(`--------------------\n`);
            return true;
        } else {
            console.error(`❌ Failed to fetch cast:`, JSON.stringify(data, null, 2));
            return false;
        }
    } catch (error) {
        console.error(`❌ Error fetching cast:`, error);
        return false;
    }
}

async function main() {
    const args = process.argv.slice(2);
    let character = 'TOM'; // Default
    let hash = '';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--character' || args[i] === '-c') {
            character = args[++i];
        } else if (!args[i].startsWith('-')) {
            hash = args[i];
        }
    }

    if (!hash) {
        console.error('Usage: npx tsx scripts/farcaster/read-cast.ts <hash> [--character <name>]');
        console.error('Example: npx tsx scripts/farcaster/read-cast.ts 0x1f9d... --character TOM');
        process.exit(1);
    }

    const apiKeyEnv = `CHARACTER.${character.toUpperCase()}.FARCASTER_NEYNAR_API_KEY`;
    const apiKey = process.env[apiKeyEnv];

    if (!apiKey) {
        // Fallback to generic NEYNAR_API_KEY if character-specific is missing
        const genericKey = process.env.NEYNAR_API_KEY;
        if (!genericKey) {
            console.error(`Error: Could not find configuration for character "${character}" or generic NEYNAR_API_KEY in .env`);
            process.exit(1);
        }
        await getCast(genericKey, hash);
    } else {
        await getCast(apiKey, hash);
    }
}

main().catch((err) => {
    console.error(err);
});
