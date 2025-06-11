import { SlackClientProvider } from "../providers/slack-client.provider";
import type { SlackConfig } from "../types/slack-types";
import { EventHandler } from "../events";
import { config } from "dotenv";
import { resolve } from "path";
import { createReadStream } from "fs";
import express from "express";

// Load environment variables
const envPath = resolve(__dirname, "../../../../.env");
elizaLogger.log("Loading environment from:", envPath);
config({ path: envPath });

function validateEnvironment() {
    const requiredEnvVars = [
        "SLACK_APP_ID",
        "SLACK_CLIENT_ID",
        "SLACK_CLIENT_SECRET",
        "SLACK_SIGNING_SECRET",
        "SLACK_VERIFICATION_TOKEN",
        "SLACK_BOT_TOKEN",
        "SLACK_CHANNEL_ID",
    ];

    const missing = requiredEnvVars.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        console.error("Missing required environment variables:", missing);
        return false;
    }

    // Log masked versions of the tokens for debugging
    elizaLogger.log("Environment variables loaded:");
    requiredEnvVars.forEach((key) => {
        const value = process.env[key] || "";
        const maskedValue =
            value.length > 8
                ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}`
                : "****";
        elizaLogger.log(`${key}: ${maskedValue}`);
    });

    return true;
}

async function startServer(
    app: express.Application,
    port: number
): Promise<number> {
    try {
        await new Promise<void>((resolve, reject) => {
            app.listen(port, () => resolve()).on("error", (err: any) => {
                if (err.code === "EADDRINUSE") {
                    elizaLogger.log(`Port ${port} is busy, trying ${port + 1}...`);
                    resolve();
                } else {
                    reject(err);
                }
            });
        });
        return port;
    } catch (error) {
        if (port < 3010) {
            // Try up to 10 ports
            return startServer(app, port + 1);
        }
        throw error;
    }
}

async function runExample() {
    elizaLogger.log("\n=== Starting Slack Client Example ===\n");

    if (!validateEnvironment()) {
        throw new Error("Environment validation failed");
    }

    // Initialize the client with your Slack credentials
    const slackConfig: SlackConfig = {
        appId: process.env.SLACK_APP_ID || "",
        clientId: process.env.SLACK_CLIENT_ID || "",
        clientSecret: process.env.SLACK_CLIENT_SECRET || "",
        signingSecret: process.env.SLACK_SIGNING_SECRET || "",
        verificationToken: process.env.SLACK_VERIFICATION_TOKEN || "",
        botToken: process.env.SLACK_BOT_TOKEN || "",
        botId: process.env.SLACK_BOT_ID || "", // This will be updated automatically
    };

    elizaLogger.log("\nInitializing Slack client...");
    const slackProvider = new SlackClientProvider(slackConfig);

    try {
        // Validate the connection
        elizaLogger.log("\nValidating Slack connection...");
        const isConnected = await slackProvider.validateConnection();
        if (!isConnected) {
            throw new Error("Failed to connect to Slack");
        }
        elizaLogger.log("✓ Successfully connected to Slack");

        // Set up event handling
        elizaLogger.log("\nSetting up event handling...");
        const eventHandler = new EventHandler(
            slackConfig,
            slackProvider.getContext().client
        );
        const events = eventHandler.getEventAdapter();

        // Create Express app
        const app = express();
        const basePort = Number.parseInt(process.env.PORT || "3000");

        // Mount the event handler
        app.use("/slack/events", events.expressMiddleware());

        // Send initial message
        const channelId = process.env.SLACK_CHANNEL_ID || "";
        elizaLogger.log(`\nSending initial message to channel: ${channelId}`);

        try {
            // Send text message
            const messageResult = await slackProvider.sendMessage(
                channelId,
                "Hello! I am now active and ready to help. Here are my capabilities:"
            );
            elizaLogger.log("✓ Initial message sent:", messageResult);

            // Send message with image
            const imagePath = resolve(__dirname, "../tests/test_image.png");
            elizaLogger.log("\nSending message with image...");
            const imageResult = await slackProvider
                .getContext()
                .client.files.uploadV2({
                    channel_id: channelId,
                    file: createReadStream(imagePath),
                    filename: "test_image.png",
                    title: "Test Image",
                    initial_comment: "1. I can send messages with images 🖼️",
                });
            elizaLogger.log("✓ Image message sent:", imageResult);

            // Send message in thread
            if (messageResult.ts) {
                elizaLogger.log("\nSending message in thread...");
                const threadResult = await slackProvider.replyInThread(
                    channelId,
                    messageResult.ts,
                    "2. I can reply in threads 🧵"
                );
                elizaLogger.log("✓ Thread message sent:", threadResult);

                // Send another image in the thread
                elizaLogger.log("\nSending image in thread...");
                const threadImageResult = await slackProvider
                    .getContext()
                    .client.files.uploadV2({
                        channel_id: channelId,
                        file: createReadStream(imagePath),
                        filename: "test_image_thread.png",
                        title: "Test Image in Thread",
                        thread_ts: messageResult.ts,
                        initial_comment:
                            "3. I can also send images in threads! 🖼️🧵",
                    });
                elizaLogger.log("✓ Thread image sent:", threadImageResult);
            }

            // Start the server
            const port = await startServer(app, basePort);
            elizaLogger.log(`\n✓ Slack event server is running on port ${port}`);
            elizaLogger.log("\n=== Bot is ready to interact! ===");
            elizaLogger.log("\nCore functionalities demonstrated:");
            elizaLogger.log("1. Sending regular messages");
            elizaLogger.log("2. Sending images and attachments");
            elizaLogger.log("3. Replying in threads");
            elizaLogger.log("4. Sending images in threads");
            elizaLogger.log(
                "\nTry mentioning me with @eve_predict_client to interact!"
            );

            if (!process.env.SLACK_BOT_ID) {
                elizaLogger.log(`\nℹ️ Bot ID: ${slackConfig.botId}`);
            }
        } catch (error) {
            console.error("\n❌ Error during initialization:", error);
            // Continue even if initial messages fail
            elizaLogger.log("\nStarting server despite initialization errors...");

            const port = await startServer(app, basePort);
            elizaLogger.log(`\n✓ Slack event server is running on port ${port}`);
            elizaLogger.log("\n=== Bot is ready to interact! ===");
        }
    } catch (error) {
        console.error("\n❌ Error in Slack client example:");
        if (error instanceof Error) {
            console.error("Error message:", error.message);
            console.error("Stack trace:", error.stack);
            if ("data" in error) {
                console.error("Error data:", (error as any).data);
            }
        } else {
            console.error("Unknown error:", error);
        }
        process.exit(1);
    }
}

// Run the example if this file is executed directly
if (require.main === module) {
    runExample().catch((error) => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
}
