import { type Client, type IAgentRuntime, elizaLogger } from "@elizaos/core";
import { FarcasterClient } from "./client";
import { FarcasterPostManager } from "./post";
import { FarcasterInteractionManager } from "./interactions";
import { Configuration, NeynarAPIClient } from "@neynar/nodejs-sdk";
import { validateFarcasterConfig, type FarcasterConfig } from "./environment";
import { FarcasterHubClient } from "./farcasterHubClient"
// import { DaoMonitor } from "./DaoMonitor"
import { DaoMonitor } from "./DaoMonitor.web3"

/**
 * A manager that orchestrates all Farcaster operations:
 * - client: base operations (Neynar client, hub connection, etc.)
 * - posts: autonomous posting logic
 * - interactions: handling mentions, replies, likes, etc.
 */
class FarcasterManager {
    client: FarcasterClient;
    posts: FarcasterPostManager;
    interactions: FarcasterInteractionManager;
    hubClient: FarcasterHubClient;
    daoMonitor: DaoMonitor;
    private signerUuid: string;

    constructor(runtime: IAgentRuntime, farcasterConfig: FarcasterConfig) {
        const cache = new Map<string, any>();
        this.signerUuid = runtime.getSetting("FARCASTER_NEYNAR_SIGNER_UUID")!;

        const neynarConfig = new Configuration({
            apiKey: runtime.getSetting("FARCASTER_NEYNAR_API_KEY")!,
        });

        const neynarClient = new NeynarAPIClient(neynarConfig);

        this.client = new FarcasterClient({
            runtime,
            ssl: true,
            url: runtime.getSetting("FARCASTER_HUB_URL") ?? "hub.pinata.cloud",
            neynar: neynarClient,
            signerUuid: this.signerUuid,
            cache,
            farcasterConfig,
        });

        elizaLogger.success("Farcaster Neynar client initialized.");

        this.posts = new FarcasterPostManager(
            this.client,
            runtime,
            this.signerUuid,
            cache
        );

        this.interactions = new FarcasterInteractionManager(
            this.client,
            runtime,
            this.signerUuid,
            cache
        );


        this.hubClient = new FarcasterHubClient(
            this.client,
            runtime,
            this.signerUuid,
            neynarConfig,
            cache
        );

        this.daoMonitor = new DaoMonitor(
            this.client,
            runtime,
        );
    }

    async start() {
        this.hubClient.start();
        // this.daoMonitor.start();

        await Promise.all([
            this.posts.start(),
            this.interactions.start()
        ]);
    }

    async stop() {
        this.hubClient.stop();
        this.daoMonitor.stop();

        await Promise.all([
            this.posts.stop(),
            this.interactions.stop()
        ]);
    }
}

export const FarcasterClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        const farcasterConfig = await validateFarcasterConfig(runtime);

        elizaLogger.log(`${runtime.character.name} Farcaster client started`);

        const manager = new FarcasterManager(runtime, farcasterConfig);

        // Start all services
        await manager.start();
        // runtime.clients.farcaster = manager;     //rferrari: bug clients.farcaster do not exist
        return manager;
    },

    async stop(runtime: IAgentRuntime) {
        try {
            // stop it
            elizaLogger.log(`${runtime.character.name} Stopping farcaster client`, runtime.agentId);
            if (runtime.clients.farcaster) {
                await runtime.clients.farcaster.stop();
            }
        } catch (e) {
            elizaLogger.error(`${runtime.character.name} client-farcaster interface stop error`, e);
        }
    },
};

export default FarcasterClientInterface;
