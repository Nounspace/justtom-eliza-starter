import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// Load environment variables from .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');
dotenv.config({ path: path.join(rootDir, '.env') });

async function deleteCast(apiKey: string, signerUuid: string, targetHash: string) {
    console.log(`Deleting cast ${targetHash}...`);
    try {
        const response = await fetch('https://api.neynar.com/v2/farcaster/cast/', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
            },
            body: JSON.stringify({
                signer_uuid: signerUuid,
                target_hash: targetHash,
            }),
        });

        const data = await response.json();
        if (response.ok && data.success) {
            console.log(`Successfully deleted cast ${targetHash}`);
            return true;
        } else {
            console.error(`Failed to delete cast ${targetHash}:`, data);
            return false;
        }
    } catch (error) {
        console.error(`Error deleting cast ${targetHash}:`, error);
        return false;
    }
}

async function main() {
    const args = process.argv.slice(2);
    let character = '';
    const hashes: string[] = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--character' || args[i] === '-c') {
            character = args[++i];
        } else if (!args[i].startsWith('-')) {
            hashes.push(args[i]);
        }
    }

    if (!character) {
        console.error('Error: Please specify a character using --character or -c (e.g., TOM, NOUN584, CAPTAINCLANKIT)');
        process.exit(1);
    }

    if (hashes.length === 0) {
        console.error('Error: Please provide at least one cast hash to delete.');
        process.exit(1);
    }

    const apiKeyEnv = `CHARACTER.${character.toUpperCase()}.FARCASTER_NEYNAR_API_KEY`;
    const signerUuidEnv = `CHARACTER.${character.toUpperCase()}.FARCASTER_NEYNAR_SIGNER_UUID`;

    const apiKey = process.env[apiKeyEnv];
    const signerUuid = process.env[signerUuidEnv];

    if (!apiKey || !signerUuid) {
        console.error(`Error: Could not find configuration for character "${character}" in .env`);
        console.error(`Expected: ${apiKeyEnv} and ${signerUuidEnv}`);
        process.exit(1);
    }

    console.log(`Using character: ${character.toUpperCase()}`);
    console.log(`Found API Key and Signer UUID for ${character}`);

    for (const hash of hashes) {
        await deleteCast(apiKey, signerUuid, hash);
        // respect rate limits by waiting a bit between multiple deletions
        if (hashes.indexOf(hash) < hashes.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
}

main().catch(console.error);
