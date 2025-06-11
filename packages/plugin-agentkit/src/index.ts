import type { Plugin } from "@elizaos/core";
import { walletProvider, getClient } from "./provider";
import { getAgentKitActions } from "./actions";

// Initial banner
elizaLogger.log("\n┌════════════════════════════════════════┐");
elizaLogger.log("│          AGENTKIT PLUGIN               │");
elizaLogger.log("├────────────────────────────────────────┤");
elizaLogger.log("│  Initializing AgentKit Plugin...       │");
elizaLogger.log("│  Version: 0.0.1                        │");
elizaLogger.log("└════════════════════════════════════════┘");

const initializeActions = async () => {
    try {
        // Validate environment variables
        const apiKeyName = process.env.CDP_API_KEY_NAME;
        const apiKeyPrivateKey = process.env.CDP_API_KEY_PRIVATE_KEY;

        if (!apiKeyName || !apiKeyPrivateKey) {
            elizaLogger.warn("⚠️ Missing CDP API credentials - AgentKit actions will not be available");
            return [];
        }

        const actions = await getAgentKitActions({
            getClient,
        });
        elizaLogger.log("✔ AgentKit actions initialized successfully.");
        return actions;
    } catch (error) {
        console.error("❌ Failed to initialize AgentKit actions:", error);
        return []; // Return empty array instead of failing
    }
};

export const agentKitPlugin: Plugin = {
    name: "[AgentKit] Integration",
    description: "AgentKit integration plugin",
    providers: [walletProvider],
    evaluators: [],
    services: [],
    actions: await initializeActions(),
};

export default agentKitPlugin;
