/* DaoMonitor.ts
 *
 * Updated to be proxy-aware and to automatically fetch & merge
 * proxy ABI + implementation ABI (Etherscan / BaseScan).
 *
 * Requirements:
 *  - web3.js
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
// import { createCastMemory } from "./memory";

import { sendChannelCast } from "./actions";

import { z, ZodError } from "zod";
import Web3 from "web3";
import { Contract } from "web3-eth-contract";
import { AbiItem, Log } from "web3-types";

// import { NounsDaoAccountConfig } from "./DaoMonitor-environment";
import { formatValue } from "./DaoMonitor-utils";
import { FarcasterClient } from "./client";
import { Cast } from "./types";

type ParsedLog = {
    eventName: string;
    returnValues: { [key: string]: any };
    log: Log;
};


// const TEST_RUN_BLOCKS_RANGE = [39088859, 39033795]; // base
// const TEST_RUN_BLOCKS_RANGE = [39045670, 39033795]; // base

// const TEST_RUN_BLOCKS_RANGE = [24002350, 23938900];
const TEST_RUN_BLOCKS_RANGE = [23939000, 23938900];
// const TEST_RUN_BLOCKS_RANGE = [24006050, 24004245 ];
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

/**
 * Local helper type to represent an 'event' ABI fragment shape we actually use.
 * This keeps us from scattering `any` everywhere while satisfying the compiler.
 */
type EventAbiLike = {
    type: "event";
    name: string;
    anonymous?: boolean;
    inputs?: any[];
};

export class DaoMonitor {
    private runtime: IAgentRuntime;
    private config: DaoMonitorAccountConfig;
    private web3!: Web3;
    private contract!: any;
    private fullAbi: AbiItem[] = [];
    // map topic -> event ABI
    private eventTopicMap: { [topic: string]: EventAbiLike } = {};
    private subscription?: any;
    private blockSubscription?: any;
    private lastBlockTime: number;
    private watchdogTimer?: NodeJS.Timeout;
    private healthCheckTimer?: NodeJS.Timeout;
    private eventsProcessed = 0;
    private lastBlockNumber: bigint = 0n;
    private readonly WATCHDOG_TIMEOUT_MS = 120000; // 2 minutes

    constructor(
        public client: FarcasterClient,
        runtime: IAgentRuntime,
    ) {
        this.runtime = runtime;
        // Initialize them later in initializeProvider()
        this.web3 = null! as unknown as Web3;
        this.contract = null!;

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
        this.lastBlockTime = Date.now();
    }

    /* ------------------------------------------------------------------ */
    /*  Lifecycle                                                          */
    /* ------------------------------------------------------------------ */
    private startWatchdog(): void {
        this.stopWatchdog(); // Ensure no multiple watchdogs
        this.lastBlockTime = Date.now();
        this.watchdogTimer = setInterval(() => {
            const now = Date.now();
            if (now - this.lastBlockTime > this.WATCHDOG_TIMEOUT_MS) {
                elizaLogger.warn(`DAO: Watchdog triggered. No activity for over ${this.WATCHDOG_TIMEOUT_MS / 1000}s. Reconnecting...`);
                // Use a self-executing async function to avoid making setInterval callback async
                (async () => {
                    await this.reconnect();
                })().catch(err => {
                    elizaLogger.error("DAO: Watchdog reconnect failed:", err);
                });
            }
        }, this.WATCHDOG_TIMEOUT_MS / 2);
        elizaLogger.info("DAO: Watchdog started.");
    }

    private stopWatchdog(): void {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = undefined;
            elizaLogger.info("DAO: Watchdog stopped.");
        }
    }

    private startHealthCheck(): void {
        this.stopHealthCheck(); // Ensure no multiple timers

        // const HEALTHCHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
        // const HEALTHCHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
        const HEALTHCHECK_INTERVAL = parseInt(process.env.DAOMONITOR_HEALTHCHECK_INTERVAL_MS || "60") ; // minutes
        const HEALTHCHECK_INTERVAL_MS = HEALTHCHECK_INTERVAL * 60 * 1000; // 1 hour

        this.healthCheckTimer = setInterval(() => {
            elizaLogger.info("DAO: Health check - I'm alive.");
            elizaLogger.info(`DAO:   - Last block: #${this.lastBlockNumber}`);
            elizaLogger.info(`DAO:   - Last block time: ${new Date(this.lastBlockTime).toISOString()}`);
            elizaLogger.info(`DAO:   - Events processed (since start): ${this.eventsProcessed}`);

            const provider = this.web3.currentProvider as any;
            if (provider && typeof provider.readyState !== 'undefined') {
                // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
                const stateMap: { [key: number]: string } = {
                    0: "CONNECTING",
                    1: "OPEN",
                    2: "CLOSING",
                    3: "CLOSED"
                };
                elizaLogger.info(`DAO:   - WebSocket state: ${stateMap[provider.readyState] || 'UNKNOWN'}`);
            }
        }, HEALTHCHECK_INTERVAL_MS);

        elizaLogger.info(`DAO: Health check started, will run every hour.`);
    }

    private stopHealthCheck(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = undefined;
            elizaLogger.info("DAO: Health check stopped.");
        }
    }

    private async reconnect(): Promise<void> {
        elizaLogger.info("DAO: Attempting to reconnect...");
        await this.stop();
        // A short delay before attempting to start again.
        await new Promise(resolve => setTimeout(resolve, 5000));
        await this.start();
        elizaLogger.info("DAO: Reconnect attempt finished.");
    }

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
        this.eventsProcessed = 0;
        await this.initializeProvider();
        this.startWatchdog();
        if (this.config.TEST_DAOMONITOR) {
            await this.testBlocksRange();
        } else {
            await this.setupEventListeners();
            this.startHealthCheck();
        }
    }

    public async stop(): Promise<void> {
        this.stopWatchdog();
        this.stopHealthCheck();
        this.subscription?.unsubscribe?.();
        this.blockSubscription?.unsubscribe?.();
        if (this.web3 && this.web3.currentProvider && typeof (this.web3.currentProvider as any).disconnect === 'function') {
            (this.web3.currentProvider as any).disconnect();
        }
        elizaLogger.info("DAO: DAO Monitor stopped");
    }

    /* ------------------------------------------------------------------ */
    /*  Provider & ABI                                                     */
    /* ------------------------------------------------------------------ */
    private async initializeProvider(): Promise<void> {
        const provider = new Web3.providers.WebsocketProvider(this.config.DAOMONITOR_WSS_MAINNET_ENDPOINT);
        this.web3 = new Web3(provider);

        const combinedAbi = await this.loadCombinedAbi(this.config.DAOMONITOR_CONTRACT_ADDRESS);
        this.fullAbi = combinedAbi;

        // Create contract instance (web3 Contract accepts many ABI shapes at runtime)
        this.contract = new this.web3.eth.Contract(this.fullAbi as any, this.config.DAOMONITOR_CONTRACT_ADDRESS);

        // Build event topic map for decoding
        this.eventTopicMap = {};
        // Filter explicitly for events to avoid constructor / fallback fragments
        const eventAbis = (this.fullAbi || []).filter((item: any) => item && item.type === 'event');

        for (const eventAbi of eventAbis) {
            const ev = eventAbi as EventAbiLike;
            // ensure it has a name (constructor fragments won't)
            if (ev && ev.type === 'event' && typeof ev.name === 'string' && ev.name.length > 0) {
                // encodeEventSignature has strict types in web3 typings; cast to any for runtime call
                const signature = (this.web3.eth.abi as any).encodeEventSignature(ev);
                this.eventTopicMap[signature] = ev;
            }
        }

        const eventNames = eventAbis.map(e => (e as any).name).filter((n: any) => !!n);
        elizaLogger.info("DAO: Loaded events:", eventNames.join(", "));
    }

    /**
     * Loads ABI for the proxy address and, if found, the implementation's ABI.
     * Merges them (avoids duplicates) and returns a web3.js ABI.
     *
     * Uses process.env.DAOMONITOR_DAO_CHAIN_ID to pick explorer:
     *  - '8453' -> BaseScan (api.basescan.org)
     *  - otherwise -> Etherscan (api.etherscan.io)
     */
    private async loadCombinedAbi(proxyAddress: string): Promise<AbiItem[]> {
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
                ...extraEvents.filter(ev => !proxyAbi.some(p => (p as any).type === (ev as any).type && (p as any).name === (ev as any).name))
            ];
            return combined as AbiItem[];
        }

        // Fetch implementation ABI from corresponding explorer (same explorer; but impl might be on same chain)
        const implAbi = await this.fetchAbiForExplorer(implAddress, explorer);
        elizaLogger.info(`DAO: Fetched implementation ABI (fragments=${implAbi.length}) from ${explorer} for ${implAddress}`);

        // Merge ABIs - keep proxy fragments, then add implementation fragments not already present
        const merged: any[] = [
            ...proxyAbi,
            ...implAbi.filter(frag => {
                // if proxy contains same type+name, skip to avoid duplicates
                return !(proxyAbi.some(p => ((p as any).type === (frag as any).type) && ((p as any).name === (frag as any).name)));
            })
        ];

        // Add extra events only if they don't exist already
        const extraEvents = this.getExtraEvents();
        for (const ev of extraEvents) {
            if (!merged.some(m => (m as any).type === (ev as any).type && (m as any).name === (ev as any).name)) {
                merged.push(ev);
            }
        }

        return merged as AbiItem[];
    }

    /**
     * Fetch ABI for a given address using the correct explorer API.
     * explorer: 'etherscan' | 'base'
     */
    private async fetchAbiForExplorer(address: string, explorer: "etherscan" | "base"): Promise<any[]> {
        if (!this.config.DAOMONITOR_ETHERSCAN_API_KEY) throw new Error("ETHERSCAN_API_KEY required");

        // Choose the proper base URL
        let apiurl: string;
        if (explorer === "base") {
            // apiurl = "https://api.basescan.org/v2/api";
            apiurl = "https://api.etherscan.io/v2/api?chainId=8453";
        } else {
            apiurl = "https://api.etherscan.io/v2/api?chainId=1";
        }

        // Etherscan & BaseScan both support module=contract&action=getabi
        const url = `${apiurl}&module=contract&action=getabi&address=${address}&apikey=${this.config.DAOMONITOR_ETHERSCAN_API_KEY}`;

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
            let raw = await this.web3.eth.getStorageAt(proxyAddress, STANDARD_IMPLEMENTATION_SLOT);

            // If the standard slot is empty, check the custom Nouns DAO slot
            if (!raw || raw === "0x0000000000000000000000000000000000000000000000000000000000000000") {
                elizaLogger.debug("DAO: Standard implementation slot is empty, checking custom Nouns DAO slot 0.");
                raw = await this.web3.eth.getStorageAt(proxyAddress, NOUNS_DAO_IMPLEMENTATION_SLOT);
            }

            // If still no value, return null
            if (!raw || raw === "0x0000000000000000000000000000000000000000000000000000000000000000") {
                return null;
            }

            const impl = "0x" + raw.slice(26);
            if (impl === "0x0000000000000000000000000000000000000000") return null;

            return this.web3.utils.toChecksumAddress(impl);
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
    private async setupEventListeners(): Promise<void> {
        this.subscription = await this.web3.eth.subscribe('logs', {
            address: this.config.DAOMONITOR_CONTRACT_ADDRESS,
        });

        this.subscription.on('data', (log: Log) => {
            this.lastBlockTime = Date.now();
            this.handleLog(log).catch(err => {
                elizaLogger.error("DAO: handleLog error:", err);
            });
        });

        this.subscription.on('error', (error: Error) => {
            elizaLogger.error("DAO: Error in subscription:", error);
        });

        this.blockSubscription = await this.web3.eth.subscribe('newBlockHeaders');
        this.blockSubscription.on('data', (blockHeader: any) => {
            this.lastBlockTime = Date.now();
            if (blockHeader && blockHeader.number != null) {
                try {
                    this.lastBlockNumber = BigInt(blockHeader.number);
                } catch (e) {
                    elizaLogger.warn(`DAO: Could not convert block number to BigInt: ${blockHeader.number}`);
                }
            }
            // elizaLogger.debug(`DAO: New block received: #${blockHeader.number}`);
        });
        this.blockSubscription.on('error', (error: Error) => {
            elizaLogger.error("DAO: Error in block header subscription:", error);
        });

        elizaLogger.info("DAO: Listening for all DAO events...");
    }

    private async testBlocksRange(): Promise<void> {
        const [fromBlock, toBlock] = TEST_RUN_BLOCKS_RANGE;

        elizaLogger.warn(
            `DAO WEB3.js: DRY RUN: Scanning blocks ${fromBlock} → ${toBlock} ` +
            `(${toBlock - fromBlock + 1} blocks)`
        );

        const eventCounter = new Map<string, number>();

        for (let block = fromBlock; block >= toBlock; block--) {
            this.lastBlockTime = Date.now();
            try {
                console.log(`DAO: Scanning block ${block}...`);
                await this.sleep(100); // Can be low due to getPastLogs batching

                const logs = await this.web3.eth.getPastLogs({
                    address: this.config.DAOMONITOR_CONTRACT_ADDRESS,
                    fromBlock: block,
                    toBlock: block,
                });

                for (const log of logs) {
                    if (typeof log === 'string') continue;
                    await this.handleLog(log, eventCounter);
                }
            } catch (error) {
                elizaLogger.error(`DAO: Error scanning block ${block}:`, error);
                await this.sleep(5000); // Wait longer after an error
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
    private tryParseLog(log: Log): ParsedLog | null {
        // Topics in web3-types may be Bytes[]; runtime values are typically string hexs.
        if (!log.topics || log.topics.length === 0 || typeof String(log.topics[0]) !== 'string' || typeof log.data !== 'string') {
            return null;
        }

        const topic0 = String((log.topics as any[])[0]);
        const eventAbi = this.eventTopicMap[topic0];
        if (!eventAbi || !eventAbi.inputs) {
            return null;
        }

        try {
            // Ensure topics are string[] for decodeLog
            const topicsArg: string[] = (log.topics as any[]).slice(1).map((t: any) => String(t));
            // decodeLog typing is strict; cast inputs to any
            const decoded = (this.web3.eth.abi as any).decodeLog(eventAbi.inputs as any, String(log.data), topicsArg);
            return {
                eventName: (eventAbi as any).name || 'unknown',
                returnValues: decoded,
                log: log
            };
        } catch (e) {
            elizaLogger.debug(`DAO: Could not decode log for topic ${topic0}`, e);
            return null;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /* ------------------------------------------------------------------ */
    /*  Core Log Dispatcher                                                */
    /* ------------------------------------------------------------------ */
    private async handleLog(log: Log, eventCounter?: Map<string, number>): Promise<void> {
        this.lastBlockTime = Date.now();
        const parsed = this.tryParseLog(log);

        if (!parsed) {
            return;
        }

        if (eventCounter) {
            const count = eventCounter.get(parsed.eventName) || 0;
            eventCounter.set(parsed.eventName, count + 1);
        }
        this.eventsProcessed++;

        // -------------- 🔥 UNIVERSAL EVENT LOGGING ----------------
        elizaLogger.warn(
            `DAO: Event captured: ${parsed.eventName} ` +
            `(block=${log.blockNumber}, tx=${log.transactionHash})`
        );
        try {
            const replacer = (key: any, value: any) => typeof value === 'bigint' ? value.toString() : value;
            elizaLogger.debug(`DAO: Event args: ${JSON.stringify(parsed.returnValues, replacer, 2)}`);
        } catch (err) {
            elizaLogger.debug(`DAO: Failed to stringify event args:`, err);
        }
        // ----------------------------------------------------------------

        const handler = this.getHandler(parsed.eventName);
        if (handler) {
            await handler(parsed, log);
        } else {
            elizaLogger.debug(`DAO: Unhandled event: ${parsed.eventName}`);
        }
    }

    private getHandler(eventName: string): ((p: ParsedLog, l: Log) => Promise<void>) | null {
        const map: Record<string, (p: ParsedLog, l: Log) => Promise<void>> = {
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

    private async handleProposalCreated(parsed: ParsedLog, log: Log): Promise<void> {
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

            const [{ cast: theCast, memory: castMemory }] = await sendChannelCast({
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

            elizaLogger.info(`DAO: Successfully announced and recorded proposal #${values.id}`);
            elizaLogger.debug(`DAO: the Cast ${theCast.hash}`);
            elizaLogger.debug(`DAO: the Memory: ${castMemory.id}`);

        } catch (error) {
            const err = error instanceof Error ? error.stack : String(error)
            elizaLogger.error(`DAO: Failed to announce proposal #${values.id}. Error: ${err}`);
        }
    }

    private async buildProposalState(announcementId: UUID, values: Record<string, string>): Promise<State> {
        const proposalyMemory: Memory = {
            id: announcementId,
            agentId: this.runtime.agentId,
            userId: this.client.farcasterConfig.FARCASTER_FID
                ? stringToUuid(this.client.farcasterConfig.FARCASTER_FID.toString())
                : stringToUuid("unknown-user"),
            roomId: stringToUuid("dao-monitor-events") as UUID,
            content: {
                text: `Proposal ${values.id} created`,
                source: "dao-monitor",
            },
            createdAt: Date.now(),
            embedding: getEmbeddingZeroVector(),
        };

        const { character } = this.runtime;

        const descriptionLines = (values.description || '').split('\n');
        const title = descriptionLines[0] || '';
        const descriptionBody = descriptionLines.slice(1).join('\n');

        return this.runtime.composeState(proposalyMemory, {
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

    private async handleVoteCast(parsed: ParsedLog, _log: Log): Promise<void> {
        const { voter, proposalId, support, votes, reason } = parsed.returnValues;
        elizaLogger.warn(`DAO: Vote Cast: voter=${voter} prop=${proposalId} support=${support} votes=${votes} reason=${reason}`);
    }

    private async handleProposalExecuted(parsed: ParsedLog, _log: Log): Promise<void> {
        const { id } = parsed.returnValues;
        elizaLogger.warn(`DAO: Proposal Executed: #${id}`);
    }

    private async handleProposalCanceled(parsed: ParsedLog, _log: Log): Promise<void> {
        const { id } = parsed.returnValues;
        elizaLogger.warn(`DAO: Proposal Canceled: #${id}`);
    }

    private async handleProposalQueued(parsed: ParsedLog, _log: Log): Promise<void> {
        const { id, eta } = parsed.returnValues;
        elizaLogger.warn(`DAO: Proposal Queued: #${id} eta=${eta}`);
    }

    /* ------------------------------------------------------------------ */
    /*  Helpers                                                            */
    /* ------------------------------------------------------------------ */
    private extractValues(parsed: ParsedLog): Record<string, string> {
        const values: Record<string, string> = {};
        for (const key in parsed.returnValues) {
            // web3.js returnValues only includes named arguments
            if (isNaN(parseInt(key))) { // filter out numeric keys
                const val = parsed.returnValues[key];
                values[key] = formatValue(val);
            }
        }
        return values;
    }
}
