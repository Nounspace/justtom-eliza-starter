import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import * as readline from 'readline';

// Load environment variables from .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(rootDir, '.env') });

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query: string): Promise<string> => new Promise((resolve) => rl.question(query, resolve));

async function postCast(apiKey: string, signerUuid: string, text: string, parent?: string, imageUrl?: string) {
    console.log(`\n🚀 Posting cast...`);
    console.log(`📝 Text: ${text}`);
    if (imageUrl) console.log(`🖼️ Image: ${imageUrl}`);
    if (parent) console.log(`🔗 Parent Hash: ${parent}`);

    try {
        const body: any = {
            signer_uuid: signerUuid,
            text: text,
        };

        if (parent) {
            body.parent = parent;
        }

        if (imageUrl) {
            body.embeds = [{ url: imageUrl }];
        }

        const response = await fetch('https://api.neynar.com/v2/farcaster/cast', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
            },
            body: JSON.stringify(body),
        });

        const data = await response.json();
        if (response.ok && data.success) {
            console.log(`✅ Successfully posted cast!`);
            console.log(`🔗 Hash: ${data.cast.hash}`);
            return true;
        } else {
            console.error(`❌ Failed to post cast:`, JSON.stringify(data, null, 2));
            return false;
        }
    } catch (error) {
        console.error(`❌ Error posting cast:`, error);
        return false;
    }
}

async function main() {
    const args = process.argv.slice(2);
    let character = '';
    let text = '';
    let parent = '';
    let imageUrl = '';
    let interactive = args.length === 0;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--character' || args[i] === '-c' || args[i] === '--c') {
            character = args[++i];
        } else if (args[i] === '--parent' || args[i] === '-p' || args[i] === '--p') {
            parent = args[++i];
        } else if (args[i] === '--text' || args[i] === '-t') {
            text = args[++i];
        } else if (args[i] === '--image' || args[i] === '-i') {
            imageUrl = args[++i];
        } else if (!args[i].startsWith('-')) {
            if (!text) {
                text = args.slice(i).join(' ');
                break;
            }
        }
    }

    if (interactive) {
        console.log("--- Farcaster Interactive Post ---");
        character = await question("Character name (e.g., TOM, NOUN584): ");
        text = await question("Cast text: ");
        imageUrl = await question("Image URL (optional): ");
        parent = await question("Parent hash (optional): ");
    }

    if (!character || !text) {
        console.error('Error: Character and Text are required.');
        if (interactive) {
            rl.close();
        }
        process.exit(1);
    }

    const apiKeyEnv = `CHARACTER.${character.toUpperCase()}.FARCASTER_NEYNAR_API_KEY`;
    const signerUuidEnv = `CHARACTER.${character.toUpperCase()}.FARCASTER_NEYNAR_SIGNER_UUID`;

    const apiKey = process.env[apiKeyEnv];
    const signerUuid = process.env[signerUuidEnv];

    if (!apiKey || !signerUuid) {
        console.error(`Error: Could not find configuration for character "${character}" in .env`);
        console.error(`Expected: ${apiKeyEnv} and ${signerUuidEnv}`);
        if (interactive) rl.close();
        process.exit(1);
    }

    if (interactive) {
        console.log("\n--- Review Cast ---");
        console.log(`Character: ${character.toUpperCase()}`);
        console.log(`Text: ${text}`);
        if (imageUrl) console.log(`Image: ${imageUrl}`);
        if (parent) console.log(`Parent: ${parent}`);

        const confirm = await question("\nSubmit cast? (y/n): ");
        if (confirm.toLowerCase() !== 'y') {
            console.log("Post cancelled.");
            rl.close();
            return;
        }
    }

    await postCast(apiKey, signerUuid, text, parent, imageUrl);

    if (interactive) {
        rl.close();
    }
}

main().catch((err) => {
    console.error(err);
    rl.close();
});
