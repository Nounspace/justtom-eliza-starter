import { elizaLogger, type Plugin } from "@elizaos/core";
import { generateTextAction } from "./actions/generateTextAction";
import { generateEmbeddingAction } from "./actions/generateEmbeddingAction";
import { analyzeSentimentAction } from "./actions/analyzeSentimentAction";
import { transcribeAudioAction } from "./actions/transcribeAudioAction";
import { moderateContentAction } from "./actions/moderateContentAction";
import { editTextAction } from "./actions/editTextAction";

// Simple terminal output
elizaLogger.log("\n===============================");
elizaLogger.log("      OpenAI Plugin Loaded      ");
elizaLogger.log("===============================");
elizaLogger.log("Name      : openai-plugin");
elizaLogger.log("Version   : 0.1.0");
elizaLogger.log("X Account : https://x.com/Data0x88850");
elizaLogger.log("GitHub    : https://github.com/0xrubusdata");
elizaLogger.log("Actions   :");
elizaLogger.log("  - generateTextAction");
elizaLogger.log("  - generateEmbeddingAction");
elizaLogger.log("  - analyzeSentimentAction");
elizaLogger.log("  - transcribeAudioAction");
elizaLogger.log("  - moderateContentAction");
elizaLogger.log("  - editTextAction");
elizaLogger.log("===============================\n");

export const openaiPlugin: Plugin = {
    name: "openai",
    description: "OpenAI integration plugin for various AI capabilities",
    actions: [
        generateTextAction,
        generateEmbeddingAction,
        analyzeSentimentAction,
        transcribeAudioAction,
        moderateContentAction,
        editTextAction,
    ],
    evaluators: [],
    providers: [],
};

export default openaiPlugin;
