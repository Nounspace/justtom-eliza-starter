/* DaoMonitor.ts
 *
 * Updated to be proxy-aware and to automatically fetch & merge
 * proxy ABI + implementation ABI (Etherscan / BaseScan).
 *
 * Requirements:
 *  - ethers v6
 *  - Node with global fetch or polyfill (your original code used fetch)
 *
 * Environment variables used:
 *  - DAOMONITOR_ETHERSCAN_API_KEY  (required to fetch ABI)
 *  - DAOMONITOR_WSS_MAINNET_ENDPOINT
 *  - DAOMONITOR_CONTRACT_ADDRESS
 *  - DAOMONITOR_DRY_RUN (optional)
 *  - DAOMONITOR_DAO_CHAIN_ID (optional, default "1"). Use "8453" for Base.
 */

import {
    IAgentRuntime,
    elizaLogger,
    stringToUuid,
    composeContext,
    generateText,
    cleanJsonResponse,
    truncateToCompleteSentence,
    getEmbeddingZeroVector,
    ModelClass,
    State,
    Memory,
    UUID,
} from "@elizaos/core";
import { getCreateProposalEventPrompt } from "./DaoMonitor-prompts";
import { sendChannelCast } from "./actions";

import { z, ZodError } from "zod";
import { ethers } from "ethers";
import { EventFragment } from "ethers";

// import { NounsDaoAccountConfig } from "./DaoMonitor-environment";
import { formatValue } from "./DaoMonitor-utils";
import { FarcasterClient } from "./client";

type ParsedLog = ethers.LogDescription & { fragment: ethers.EventFragment };

const TEST_RUN_BLOCKS_RANGE = [23978345, 23977613];
// const TEST_RUN_BLOCKS_RANGE = [23939000, 23938900];
const STANDARD_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const NOUNS_DAO_IMPLEMENTATION_SLOT = "0x0"; // Slot 0 for Nouns DAO custom proxy

export interface Proposal {
    id: string;
    proposer: string;
    description: string;
    targets: string[];
    values: string[];
    signatures: string[];
    calldatas: string[];
    startBlock: string;
    endBlock: string;
    votes: Vote[];
}

export interface Vote {
    proposalId: string;
    voter: string;
    support: string;
    votes: string;
    reason: string;
}

export const DaoMonitorAccountEnvSchema = z.object({
    DAOMONITOR_ETHERSCAN_API_KEY: z.string(),
    DAOMONITOR_WSS_MAINNET_ENDPOINT: z.string(),
    DAOMONITOR_CONTRACT_ADDRESS: z.string(),
    DAOMONITOR_DRY_RUN: z.boolean().optional(),
    TEST_DAOMONITOR: z.boolean().optional(),
});

export type DaoMonitorAccountConfig = z.infer<typeof DaoMonitorAccountEnvSchema>;

export class DaoMonitor {
    private runtime: IAgentRuntime;
    private config: DaoMonitorAccountConfig;
    private provider!: ethers.WebSocketProvider;
    private iface!: ethers.Interface;

    constructor(
        public client: FarcasterClient,
        runtime: IAgentRuntime,
    ) {
        this.runtime = runtime;
        this.provider = null!;
        this.iface = null!;

        const DAOMONITOR_DRY_RUN = process.env.DAOMONITOR_DRY_RUN === "true" || false;
        const CONTRACT_ADDRESS = process.env.DAOMONITOR_CONTRACT_ADDRESS || "0x000";
        const WSS_MAINNET_ENDPOINT = process.env.DAOMONITOR_WSS_MAINNET_ENDPOINT || "wss://ethereum-rpc.publicnode.com"
        const ETHERSCAN_API_KEY = process.env.DAOMONITOR_ETHERSCAN_API_KEY || ""
        const TEST_DAOMONITOR = process.env.TEST_DAOMONITOR === "true" || false;

        if (ETHERSCAN_API_KEY === "") {
            elizaLogger.error(`Missing ETHERSCAN_API_KEY.`);
        }

        this.config = {
            DAOMONITOR_ETHERSCAN_API_KEY: ETHERSCAN_API_KEY,
            DAOMONITOR_WSS_MAINNET_ENDPOINT: WSS_MAINNET_ENDPOINT,
            DAOMONITOR_CONTRACT_ADDRESS: CONTRACT_ADDRESS,
            DAOMONITOR_DRY_RUN: DAOMONITOR_DRY_RUN,
            TEST_DAOMONITOR: TEST_DAOMONITOR,
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Lifecycle                                                          */
    /* ------------------------------------------------------------------ */
    public async start(): Promise<void> {
        const agentFid = this.client.farcasterConfig?.FARCASTER_FID ?? 0;
        if (!agentFid) {
            elizaLogger.info(`DAO: Farcaster: No FID found, skipping interactions`);
            return;
        }
        if (agentFid !== 527313) {
            elizaLogger.info(`DAO: Farcaster: ${agentFid} Not Tom, skipping start`);
            return;
        }

        elizaLogger.info("DAO: Starting DAO Monitor...");
        await this.initializeProvider();
        if (this.config.TEST_DAOMONITOR) {
            await this.testBlocksRange();
        } else {
            this.setupEventListeners();
        }
    }

    public async stop(): Promise<void> {
        await this.provider?.destroy();
        elizaLogger.info("DAO: DAO Monitor stopped");
    }

    /* ------------------------------------------------------------------ */
    /*  Provider & ABI                                                     */
    /* ------------------------------------------------------------------ */
    private async initializeProvider(): Promise<void> {
        // Create provider (websocket used for live events)
        this.provider = new ethers.WebSocketProvider(this.config.DAOMONITOR_WSS_MAINNET_ENDPOINT);

        // Load combined interface (proxy ABI + implementation ABI)
        const combinedInterface = await this.loadCombinedInterface(this.config.DAOMONITOR_CONTRACT_ADDRESS);
        this.iface = combinedInterface;

        // Log loaded events
        const eventNames = this.iface.fragments
            .filter((f): f is EventFragment => f.type === "event")
            .map(f => f.name);

        elizaLogger.info("DAO: Loaded events:", eventNames.join(", "));
    }

    /**
     * Loads ABI for the proxy address and, if found, the implementation's ABI.
     * Merges them (avoids duplicates) and returns an ethers.Interface.
     *
     * Uses process.env.DAOMONITOR_DAO_CHAIN_ID to pick explorer:
     *  - '8453' -> BaseScan (api.basescan.org)
     *  - otherwise -> Etherscan (api.etherscan.io)
     */
    private async loadCombinedInterface(proxyAddress: string): Promise<ethers.Interface> {
        const chainId = process.env.DAOMONITOR_DAO_CHAIN_ID || "1";
        const explorer = (chainId === "8453") ? "base" : "etherscan";

        // Fetch proxy ABI (the address you listen to emits events)
        const proxyAbi = await this.fetchAbiForExplorer(proxyAddress, explorer);
        elizaLogger.info(`DAO: Fetched proxy ABI (fragments=${proxyAbi.length}) from ${explorer}`);

        // Attempt to read implementation address from standard ERC-1967 slot
        const implAddress = await this.getImplementationAddress(proxyAddress);
        if (!implAddress) {
            elizaLogger.warn("DAO: No implementation address detected; using proxy ABI only.");
            // Optionally merge extra events if you want them present
            const extraEvents = this.getExtraEvents();
            const combined = [
                ...proxyAbi,
                ...extraEvents.filter(ev => !proxyAbi.some(p => p.type === ev.type && p.name === ev.name))
            ];
            return new ethers.Interface(combined);
        }

        // Fetch implementation ABI from corresponding explorer (same explorer; but impl might be on same chain)
        const implAbi = await this.fetchAbiForExplorer(implAddress, explorer);
        elizaLogger.info(`DAO: Fetched implementation ABI (fragments=${implAbi.length}) from ${explorer} for ${implAddress}`);

        // Merge ABIs - keep proxy fragments, then add implementation fragments not already present
        const merged: any[] = [
            ...proxyAbi,
            ...implAbi.filter(frag => {
                // if proxy contains same type+name, skip to avoid duplicates
                return !(proxyAbi.some(p => (p.type === frag.type) && (p.name === frag.name)));
            })
        ];

        // Add extra events only if they don't exist already
        const extraEvents = this.getExtraEvents();
        for (const ev of extraEvents) {
            if (!merged.some(m => m.type === ev.type && m.name === ev.name)) {
                merged.push(ev);
            }
        }

        return new ethers.Interface(merged);
    }

    /**
     * Fetch ABI for a given address using the correct explorer API.
     * explorer: 'etherscan' | 'base'
     */
    private async fetchAbiForExplorer(address: string, explorer: "etherscan" | "base"): Promise<any[]> {
        if (!this.config.DAOMONITOR_ETHERSCAN_API_KEY) throw new Error("ETHERSCAN_API_KEY required");

        const chainId = process.env.DAOMONITOR_DAO_CHAIN_ID || "1";

        // Choose the proper base URL
        let apiurl: string;
        if (explorer === "base") {
            // apiurl = "https://api.basescan.org/v2/api";
            apiurl = "https://api.etherscan.io/v2/api";
        } else {
            apiurl = "https://api.etherscan.io/v2/api";
        }

        // Etherscan / BaseScan parameter names differ slightly in your earlier code.
        // Both support module=contract&action=getabi
        const url = `${apiurl}?chainid=${chainId}&module=contract&action=getabi&address=${address}&apikey=${this.config.DAOMONITOR_ETHERSCAN_API_KEY}`;

        // Use global fetch (your environment already used fetch elsewhere); fallback will throw if not available.
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch ABI: ${res.status} ${res.statusText}`);
        }
        const data: any = await res.json();
        if (data.status !== "1") {
            // some explorers return status "0" with message in result
            throw new Error(`Explorer ABI fetch error: ${data.result || JSON.stringify(data)}`);
        }
        return JSON.parse(data.result);
    }

    /**
     * Reads the ERC-1967 implementation slot for a given proxy address.
     * Returns implementation address or null.
     */
    private async getImplementationAddress(proxyAddress: string): Promise<string | null> {
        try {
            // First, check the standard ERC-1967 slot
            let raw = await this.provider.getStorage(proxyAddress, STANDARD_IMPLEMENTATION_SLOT);

            // If the standard slot is empty, check the custom Nouns DAO slot
            if (!raw || raw === "0x0000000000000000000000000000000000000000000000000000000000000000") {
                elizaLogger.debug("DAO: Standard implementation slot is empty, checking custom Nouns DAO slot 0.");
                raw = await this.provider.getStorage(proxyAddress, NOUNS_DAO_IMPLEMENTATION_SLOT);
            }

            // If still no value, return null
            if (!raw || raw === "0x0000000000000000000000000000000000000000000000000000000000000000") {
                return null;
            }

            const impl = "0x" + raw.slice(26);
            if (impl === "0x0000000000000000000000000000000000000000") return null;

            return ethers.getAddress(impl);
        } catch (err) {
            elizaLogger.debug("DAO: getImplementationAddress error:", err);
            return null;
        }
    }

    private getExtraEvents() {
        return [
            {
                type: "event",
                name: "ProposalCreatedWithRequirements",
                anonymous: false,
                inputs: [
                    { name: "id", type: "uint256", indexed: false },
                    { name: "signers", type: "address[]", indexed: false },
                    { name: "updatePeriodEndBlock", type: "uint256", indexed: false },
                    { name: "proposalThreshold", type: "uint256", indexed: false },
                    { name: "quorumVotes", type: "uint256", indexed: false },
                    { name: "clientId", type: "uint32", indexed: true },
                ],
            },
            {
                type: "event",
                name: "ProposalCreated",
                anonymous: false,
                inputs: [
                    { name: "id", type: "uint256", indexed: false },
                    { name: "proposer", type: "address", indexed: false },
                    { name: "targets", type: "address[]", indexed: false },
                    { name: "values", type: "uint256[]", indexed: false },
                    { name: "signatures", type: "string[]", indexed: false },
                    { name: "calldatas", type: "bytes[]", indexed: false },
                    { name: "startBlock", type: "uint256", indexed: false },
                    { name: "endBlock", type: "uint256", indexed: false },
                    { name: "description", type: "string", indexed: false },
                ],
            },
            {
                type: "event",
                name: "VoteCast",
                anonymous: false,
                inputs: [
                    { indexed: true, name: "voter", type: "address" },
                    { indexed: false, name: "proposalId", type: "uint256" },
                    { indexed: false, name: "support", type: "uint8" },
                    { indexed: false, name: "votes", type: "uint256" },
                    { indexed: false, name: "reason", type: "string" }
                ]
            }
        ];
    }

    /* ------------------------------------------------------------------ */
    /*  Listeners                                                          */
    /* ------------------------------------------------------------------ */
    private setupEventListeners(): void {
        this.provider.on({
            address: this.config.DAOMONITOR_CONTRACT_ADDRESS
        }, log => this.handleLog(log));
        elizaLogger.info("DAO: Listening for all DAO events...");
    }

    private async testBlocksRange(): Promise<void> {
        const [fromBlock, toBlock] = TEST_RUN_BLOCKS_RANGE;

        elizaLogger.warn(
            `DAO: DRY RUN: Scanning blocks ${fromBlock} → ${toBlock} ` +
            `(${toBlock - fromBlock + 1} blocks)`
        );

        const eventCounter = new Map<string, number>();

        for (let block = fromBlock; block >= toBlock; block--) {
            console.log(`DAO: Scanning block ${block}...`);
            await this.sleep(100); // avoid rate limits

            const logs = await this.provider.getLogs({
                address: this.config.DAOMONITOR_CONTRACT_ADDRESS,
                fromBlock: block,
                toBlock: block,
            });

            for (const log of logs) {
                await this.handleLog(log);
                const parsed = this.tryParseLog(log);
                if (parsed) {
                    eventCounter.set(parsed.name, (eventCounter.get(parsed.name) ?? 0) + 1);
                }
            }
        }

        const total = Array.from(eventCounter.values()).reduce((a, b) => a + b, 0);
        elizaLogger.log(`DAO: Test Blocks Range complete – ${total} events processed`);
        for (const [name, count] of eventCounter) {
            elizaLogger.log(`  ${name}: ${count}`);
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Helper – safe parse + sleep                                        */
    /* ------------------------------------------------------------------ */
    private tryParseLog(log: ethers.Log): ethers.LogDescription | null {
        try {
            return this.iface.parseLog(log) as ethers.LogDescription;
        } catch {
            return null;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /* ------------------------------------------------------------------ */
    /*  Core Log Dispatcher                                                */
    /* ------------------------------------------------------------------ */
    private async handleLog(log: ethers.Log): Promise<void> {
        let parsed: ParsedLog | null = null;

        try {
            parsed = this.iface.parseLog(log) as ParsedLog;
        } catch (err) {
            elizaLogger.debug(`DAO: Failed to parse log, skipping. Topic0=${log.topics[0]}`);
            return;
        }

        if (!parsed) {
            return;
        }

        // -------------- 🔥 UNIVERSAL EVENT LOGGING ----------------
        elizaLogger.warn(
            `DAO: Event captured: ${parsed.name} ` +
            `(block=${log.blockNumber}, tx=${log.transactionHash})`
        );
        try {
            const simpleArgs: Record<string, any> = {};
            if (parsed.fragment?.inputs) {
                parsed.fragment.inputs.forEach(input => {
                    const value = parsed.args[input.name];
                    simpleArgs[input.name] = value;
                });
            }
            const replacer = (key, value) => typeof value === 'bigint' ? value.toString() : value;
            elizaLogger.debug(`DAO: Event args: ${JSON.stringify(simpleArgs, replacer, 2)}`);
        } catch (err) {
            elizaLogger.debug(`DAO: Failed to stringify event args:`, err);
        }
        // ----------------------------------------------------------------

        const handler = this.getHandler(parsed.name);
        if (handler) {
            await handler(parsed, log);
        } else {
            elizaLogger.debug(`DAO: Unhandled event: ${parsed.name}`);
        }
    }

    private getHandler(eventName: string): ((p: ParsedLog, l: ethers.Log) => Promise<void>) | null {
        const map: Record<string, (p: ParsedLog, l: ethers.Log) => Promise<void>> = {
            ProposalCreated: this.handleProposalCreated.bind(this),
            ProposalCreatedWithRequirements: this.handleProposalCreated.bind(this),
            VoteCast: this.handleVoteCast.bind(this),
            ProposalExecuted: this.handleProposalExecuted.bind(this),
            ProposalCanceled: this.handleProposalCanceled.bind(this),
            ProposalQueued: this.handleProposalQueued.bind(this),
        };
        return map[eventName] ?? null;
    }

    /* ------------------------------------------------------------------ */
    /*  Event Handlers (one per event)                                    */
    /* ------------------------------------------------------------------ */

    private async handleProposalCreated(parsed: ParsedLog, log: ethers.Log): Promise<void> {
        const values = this.extractValues(parsed);
        elizaLogger.warn(`DAO: Proposal Created: #${values.id} by ${values.proposer}`);

        const announcementId: UUID = stringToUuid(`dao-proposal-announcement-${values.id}`) as UUID;
        const existingMemory = await this.runtime.messageManager.getMemoryById(announcementId);

        if (existingMemory) {
            elizaLogger.info(`DAO: Already announced proposal #${values.id}. Skipping.`);
            return;
        }

        const state = await this.buildProposalState(announcementId, values);
        const context = composeContext({ state, template: getCreateProposalEventPrompt });

        elizaLogger.warn(`DAO: Context for proposal #${values.id}: ${context}`);

        const castTextRaw = await generateText({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL,
        });
        if (!castTextRaw?.trim()) {
            elizaLogger.error(`DAO: Failed to generate cast text for proposal #${values.id}`);
            return;
        }

        let castText = cleanJsonResponse(castTextRaw).trim();
        castText = truncateToCompleteSentence(castText, 280);
        castText = castText.replace(/^["']|["']$/g, "");
        // castText = castText + `\n\nhttps://www.nounspace.com/p/${values.id}`;

        elizaLogger.info(`DAO: Generated cast for proposal #${values.id}: ${castText}`);

        if (this.config.DAOMONITOR_DRY_RUN) {
            elizaLogger.info(`DAO: [DRY RUN] Would cast for proposal #${values.id}: ${castText}`);
            return;
        }

        try {
            const agentProfile = await this.client.getProfile(this.client.farcasterConfig.FARCASTER_FID);
            const roomId = stringToUuid("dao-monitor-events") as UUID;

            await sendChannelCast({
                client: this.client,
                runtime: this.runtime,
                content: {
                    text: castText,
                    url: `https://www.nounspace.com/p/${values.id}`
                },
                roomId,
                signerUuid: this.client.signerUuid,
                profile: agentProfile,
            });

            const announcementMemory: Memory = {
                id: announcementId,
                agentId: this.runtime.agentId,
                userId: stringToUuid("dao-monitor") as UUID,
                roomId,
                content: {
                    text: `Announcement cast for proposal ${values.id}`,
                    source: "dao-monitor",
                },
                createdAt: Date.now(),
                embedding: getEmbeddingZeroVector(),
            };
            await this.runtime.messageManager.createMemory(announcementMemory);
            elizaLogger.info(`DAO: Successfully announced and recorded proposal #${values.id}`);

        } catch (error) {
            const err = error instanceof Error ? error.stack : String(error)
            elizaLogger.error(`DAO: Failed to announce proposal #${values.id}. Error: ${err}`);
        }
    }

    private async buildProposalState(announcementId: UUID, values: Record<string, string>): Promise<State> {
        const dummyMemory: Memory = {
            id: announcementId,
            agentId: this.runtime.agentId,
            userId: stringToUuid("dao-monitor") as UUID,
            roomId: stringToUuid("dao-monitor-events") as UUID,
            content: {
                text: `Proposal ${values.id} created`,
                source: "dao-monitor",
            },
            createdAt: Date.now(),
            embedding: getEmbeddingZeroVector(),
        };

        const { character } = this.runtime;

        const descriptionLines = values.description.split('\n');
        const title = descriptionLines[0] || '';
        const descriptionBody = descriptionLines.slice(1).join('\n');

        return this.runtime.composeState(dummyMemory, {
            agentName: character.name || "Tom",
            farcasterUsername: this.client.farcasterConfig.FARCASTER_USERNAME || "nounspaceTom",
            bio: character.bio,
            lore: character.lore,
            postDirections: this.runtime.character.style.post.join("\n- "),
            // characterPostExamples: character.postExamples,
            id: values.id, // Use the actual proposal ID here, not the announcementId
            proposer: values.proposer,
            title,
            descriptionPreview: truncateToCompleteSentence(descriptionBody, 7000),
        });
    }

    private async handleVoteCast(parsed: ParsedLog, _log: ethers.Log): Promise<void> {
        const { voter, proposalId, support, votes, reason } = parsed.args;
        elizaLogger.warn(`DAO: Vote Cast: voter=${voter} prop=${proposalId} support=${support} votes=${votes} reason=${reason}`);
    }

    private async handleProposalExecuted(parsed: ParsedLog, _log: ethers.Log): Promise<void> {
        const { id } = parsed.args;
        elizaLogger.warn(`DAO: Proposal Executed: #${id}`);
    }

    private async handleProposalCanceled(parsed: ParsedLog, _log: ethers.Log): Promise<void> {
        const { id } = parsed.args;
        elizaLogger.warn(`DAO: Proposal Canceled: #${id}`);
    }

    private async handleProposalQueued(parsed: ParsedLog, _log: ethers.Log): Promise<void> {
        const { id, eta } = parsed.args;
        elizaLogger.warn(`DAO: Proposal Queued: #${id} eta=${eta}`);
    }

    /* ------------------------------------------------------------------ */
    /*  Helpers                                                            */
    /* ------------------------------------------------------------------ */
    private extractValues(parsed: ParsedLog): Record<string, string> {
        const values: Record<string, string> = {};
        for (const input of parsed.fragment.inputs) {
            const name = input.name;
            const val = parsed.args[name];
            values[name] = formatValue(val);
        }
        return values;
    }
}
