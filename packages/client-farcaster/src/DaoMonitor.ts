import {
    IAgentRuntime,
    elizaLogger,
} from "@elizaos/core";

import { z, ZodError } from "zod";
import { ethers } from "ethers";
import { EventFragment } from "ethers";

// import { NounsDaoAccountConfig } from "./DaoMonitor-environment";
import { formatValue } from "./DaoMonitor-utils";
import { FarcasterClient } from "./client";

const DRY_RUN_BLOCKS_RANGE = [23722846, 23646051];

type ParsedLog = ethers.LogDescription & { fragment: ethers.EventFragment };

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

export const nounsDaoAccountEnvSchema = z.object({
    DAOMONITOR_ETHERSCAN_API_KEY: z.string(),
    DAOMONITOR_WSS_MAINNET_ENDPOINT: z.string(),
    DAOMONITOR_CONTRACT_ADDRESS: z.string(),
    DAOMONITOR_DRY_RUN: z.boolean().optional(),
});

export type NounsDaoAccountConfig = z.infer<typeof nounsDaoAccountEnvSchema>;

export class DaoMonitor {
    private runtime: IAgentRuntime;
    private config: NounsDaoAccountConfig;
    private provider!: ethers.WebSocketProvider;
    private iface!: ethers.Interface;
    

    private proposals: Proposal[] = [];
    private votes: Vote[] = [];

    constructor(
        public client: FarcasterClient,
        runtime: IAgentRuntime, 
        // config: NounsDaoAccountConfig, 
    ) {
        this.runtime = runtime;
        // this.config = config;
        this.provider = null!;
        this.iface = null!;

        this.config = {
            DAOMONITOR_ETHERSCAN_API_KEY: "VR9GQU1CQGZVCFR5TXREMWMWRVFDRU59D5",
            DAOMONITOR_WSS_MAINNET_ENDPOINT: "wss://eth-mainnet.g.alchemy.com/v2/vDrmuZIY16ReNE7ikolCvZDK49xJBJD6",
            DAOMONITOR_CONTRACT_ADDRESS: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d",
            DAOMONITOR_DRY_RUN: true,
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Lifecycle                                                          */
    /* ------------------------------------------------------------------ */
    public async start(): Promise<void> {
        const agentFid = this.client.farcasterConfig?.FARCASTER_FID ?? 0;
        if (!agentFid) {
            elizaLogger.info(`Farcaster: DaoMonitor: No FID found, skipping interactions`);
            return;
        }
        if (agentFid !== 527313) {
            elizaLogger.info(`Farcaster: DaoMonitor: ${agentFid} Not Tom, skipping start`);
            return;
        }

        elizaLogger.info("DAO: Starting Nouns DAO Monitor...");
        await this.initializeProvider();
        if (this.config.DAOMONITOR_DRY_RUN) {
            await this.dryRun();
        } else {
            this.setupEventListeners();
        }
    }

    public async stop(): Promise<void> {
        await this.provider?.destroy();
        elizaLogger.info("DAO: Nouns DAO Monitor stopped");
    }

    public getNewProposals(): Proposal[] {
        const newProposals = [...this.proposals];
        this.proposals = [];
        return newProposals;
    }

    public getNewVotes(): Vote[] {
        const newVotes = [...this.votes];
        this.votes = [];
        return newVotes;
    }

    /* ------------------------------------------------------------------ */
    /*  Provider & ABI                                                     */
    /* ------------------------------------------------------------------ */
    private async initializeProvider(): Promise<void> {
        this.provider = new ethers.WebSocketProvider(this.config.DAOMONITOR_WSS_MAINNET_ENDPOINT);

        const abi = await this.fetchAbi();
        const extraEvents = this.getExtraEvents();
        this.iface = new ethers.Interface([...abi, ...extraEvents]);

        const eventNames = this.iface.fragments
            .filter((f): f is EventFragment => f.type === "event")
            .map(f => f.name);
        elizaLogger.log("Loaded events:", eventNames.join(", "));
    }

    private async fetchAbi(): Promise<any[]> {
        if (!this.config.DAOMONITOR_ETHERSCAN_API_KEY) throw new Error("ETHERSCAN_API_KEY required");

        const getabi_url = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getabi`;
        const res = await fetch(
            `${getabi_url}&address=${this.config.DAOMONITOR_CONTRACT_ADDRESS}&apikey=${this.config.DAOMONITOR_ETHERSCAN_API_KEY}`
        );
        const data: any = await res.json();
        if (data.status !== "1") throw new Error(`Etherscan: ${data.result}`);
        return JSON.parse(data.result);
    }

    private getExtraEvents() {
        return [
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
                  {
                    indexed: true,
                    name: "voter",
                    type: "address"
                  },
                  {
                    indexed: false,
                    name: "proposalId",
                    type: "uint256"
                  },
                  {
                    indexed: false,
                    name: "support",
                    type: "uint8"
                  },
                  {
                    indexed: false,
                    name: "votes",
                    type: "uint256"
                  },
                  {
                    indexed: false,
                    name: "reason",
                    type: "string"
                  }
                ]
              }
        ];
    }

    /* ------------------------------------------------------------------ */
    /*  Listeners                                                          */
    /* ------------------------------------------------------------------ */
    private setupEventListeners(): void {
        this.provider.on(
            { address: this.config.DAOMONITOR_CONTRACT_ADDRESS },
            log => this.handleLog(log)
        );
        elizaLogger.info("DAO: Listening for all DAO events...");
    }

    private async dryRun(): Promise<void> {
        const [fromBlock, toBlock] = DRY_RUN_BLOCKS_RANGE;

        elizaLogger.warn(
            `DAO: DRY RUN: Scanning blocks ${fromBlock} → ${toBlock} ` +
            `(${toBlock - fromBlock + 1} blocks, 3s pause between blocks)`
        );

        const eventCounter = new Map<string, number>();

        for (let block = fromBlock; block >= toBlock; block--) {
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

            if (block < toBlock) {
                await this.sleep(1500);
            }
        }

        const total = Array.from(eventCounter.values()).reduce((a, b) => a + b, 0);
        elizaLogger.log(`DAO: Dry-run complete – ${total} events processed`);
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
        } catch {
            return;
        }
        if (!parsed) return;

        const handler = this.getHandler(parsed.name);
        if (handler) {
            await handler(parsed, log);
        } else {
            elizaLogger.debug(`Unhandled event: ${parsed.name}`);
        }
    }

    private getHandler(eventName: string): ((p: ParsedLog, l: ethers.Log) => Promise<void>) | null {
        const map: Record<string, (p: ParsedLog, l: ethers.Log) => Promise<void>> = {
            ProposalCreated: this.handleProposalCreated.bind(this),
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

        const proposal: Proposal = {
            id: values.id,
            proposer: values.proposer,
            description: values.description,
            targets: values.targets ? values.targets.split(',') : [],
            values: values.values ? values.values.split(',') : [],
            signatures: values.signatures ? values.signatures.split(',') : [],
            calldatas: values.calldatas ? values.calldatas.split(',') : [],
            startBlock: values.startBlock,
            endBlock: values.endBlock,
            votes: [],
        };

        this.proposals.push(proposal);
    }

    private async handleVoteCast(parsed: ParsedLog, _log: ethers.Log): Promise<void> {
        const { voter, proposalId, support, votes, reason } = parsed.args;
        elizaLogger.warn(`DAO: Vote Cast: voter=${voter} prop=${proposalId} support=${support} votes=${votes} reason=${reason}`);

        const vote: Vote = {
            proposalId: proposalId.toString(),
            voter: voter.toString(),
            support: support.toString(),
            votes: votes.toString(),
            reason: reason.toString(),
        };

        this.votes.push(vote);

        const proposal = this.proposals.find(p => p.id === vote.proposalId);
        if (proposal) {
            proposal.votes.push(vote);
        }
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
