import { elizaLogger, type Plugin } from "@elizaos/core";
import { edwinProvider, getEdwinClient } from "./provider";
import { getEdwinActions } from "./actions";

// Initial banner
elizaLogger.log("\n┌═════════════════════════════════════┐");
elizaLogger.log("│            EDWIN PLUGIN             │");
elizaLogger.log("│                 ,_,                 │");
elizaLogger.log("│                (o,o)                │");
elizaLogger.log("│                {`\"'}                │");
elizaLogger.log("│                -\"-\"-                │");
elizaLogger.log("├─────────────────────────────────────┤");
elizaLogger.log("│  Initializing Edwin Plugin...       │");
elizaLogger.log("│  Version: 0.0.1                     │");
elizaLogger.log("└═════════════════════════════════════┘");

export const edwinPlugin: Plugin = {
    name: "[Edwin] Integration",
    description: "Edwin integration plugin",
    providers: [edwinProvider],
    evaluators: [],
    services: [],
    actions: await getEdwinActions({
        getClient: getEdwinClient,
    }),
};

export default edwinPlugin;
