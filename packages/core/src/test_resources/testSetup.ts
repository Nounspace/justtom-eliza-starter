import dotenv from "dotenv";
import path from "path";

// Load test environment variables
const envPath = path.resolve(__dirname, "../../.env.test");
elizaLogger.log("Current directory:", __dirname);
elizaLogger.log("Trying to load env from:", envPath);
const result = dotenv.config({ path: envPath });
if (result.error) {
    console.error("Error loading .env.test:", result.error);
}
