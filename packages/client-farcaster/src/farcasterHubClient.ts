const FID_CLANKER = 874542;
// const BOT_NAME = "";
// const LAST_CONVERSATION_LIMIT = 5;
// const TARGET_CHANNELS = [];

import Groq from "groq-sdk";

import {
    formatCast,
    formatTimeline,
    messageHandlerTemplate,
    shouldRespondTemplate,
} from "./prompts";

import { castUuid } from "./utils";
import { sendCast } from "./actions";

import {
    composeContext,
    generateMessageResponse,
    generateText,
    generateShouldRespond,
    type Memory,
    ModelClass,
    stringToUuid,
    elizaLogger,
    type HandlerCallback,
    type Content,
    type IAgentRuntime,
    IImageDescriptionService,
    ServiceType,
} from "@elizaos/core";

import {
    HubEvent, HubEventType,
    OnChainEventType,
    Message,
    MessageType,
    HubAsyncResult,
    isUserDataAddMessage,
    UserDataType,
    CastType,
    ReactionType,
    UserNameType,
    Embed,
    fromFarcasterTime,
    Protocol,
    getInsecureHubRpcClient,
    getSSLHubRpcClient,
    createDefaultMetadataKeyInterceptor,
    ClientOptions,
    HubRpcClient,
} from '@farcaster/hub-nodejs'

// import { CastParamType, FeedType, FilterType, isApiErrorResponse } from "@neynar/nodejs-sdk";
import { type NeynarAPIClient, isApiErrorResponse } from "@neynar/nodejs-sdk";
import { UserResponse } from '@neynar/nodejs-sdk/build/api/models/user-response';
import { CastParamType, CastWithInteractions, FeedType, FilterType } from '@neynar/nodejs-sdk/build/api/models';

import { err, ok, Result } from "neverthrow";
import { FarcasterEventBusInterface } from './eventBus.interface'

import { saveLatestEventId, getLatestEvent } from './event'

import GraphemeSplitter from 'grapheme-splitter';

// import { VerificationProtocol, , BotCastObj, CastAddBodyJson, BotChatMessage } from './hub.types';
import {
    VerificationProtocol,
    MessageBodyJson,
    CastAddBodyJson,
    // BotCastObj
} from './hub.types';

import { FarcasterClient } from './client';
import { Cast, Profile } from "./types";
import { buildConversationThread, createCastMemory } from "./memory";

// import { BulkUsersResponse, CastWithInteractions, Conversation, UserResponse } from '@neynar/nodejs-sdk/build/neynar-api/v2';

export class FarcasterHubClient {
    // public MEM_USED: NodeJS.MemoryUsage;
    // private eventBus: FarcasterEventBusInterface;

    private readonly MAX_CACHE_SIZE = 100;

    private chatBotGroq: Groq;

    private USERS_DATA_INFO: Map<string, UserResponse>;
    private USERS_FNAME_MAP: Map<number, any>;  // TODO: need to replace to user new USERS_DATA_INFO
    private TARGET_FNAME_MAP: Map<number, any>;

    private isConnected: boolean;
    private isReconnecting: boolean;
    private isStopped: boolean; // set by external discord command
    private hubClient: HubRpcClient;
    private HUB_RPC: string | null;
    // private HUB_SSL: boolean;

    private TARGETS: number[];

    constructor(
        // eventBus: FarcasterEventBusInterface, 
        public client: FarcasterClient,
        public runtime: IAgentRuntime,
        private signerUuid: string,
        private neynarConfig: any,
        public cache: Map<string, any>,
        // public client: FarcasterClient,
        // public neynarClient: NeynarAPIClient
    ) {

        // TARGETS? HUB_RPC? HUB_SSL?
        console.warn(this.client.farcasterConfig.FARCASTER_FID);

        this.chatBotGroq = new Groq({
            apiKey: process.env.GROQ_API_KEY,
        });

        this.TARGETS = this.client.farcasterConfig.FARCASTER_TARGETS_USERS;
        // this.TARGETS = [
        //     FID_CLANKER,            //  clanker
        // ]

        // this.MEM_USED = process.memoryUsage();
        // this.eventBus = eventBus;
        this.USERS_DATA_INFO = new Map();
        this.USERS_FNAME_MAP = new Map();
        this.TARGET_FNAME_MAP = new Map();

        this.isConnected = false;
        this.isReconnecting = false;
        this.isStopped = false;

        // TODO: update farcaster settings as array of hubs[]
        this.HUB_RPC = this.runtime.getSetting("FARCASTER_HUB_RPC");

        if (this.HUB_RPC === null) {
            throw new Error('Farcaster HUB_RPC setting is missing')
        }

        var hubClientOptions: Partial<ClientOptions> = {};


        hubClientOptions = {
            interceptors: [
                createDefaultMetadataKeyInterceptor(
                    'x-api-key', this.neynarConfig.apiKey),
            ],
        }

        this.hubClient = getSSLHubRpcClient(this.HUB_RPC, hubClientOptions)
        // FARCASTER_HUB_SSL 
        // ?? getSSLHubRpcClient(HUB_RPC, hubClientOptions)
        // : getInsecureHubRpcClient(HUB_RPC)
    }

    private bytesToHex(value: Uint8Array): `0x${string}` {
        return `0x${Buffer.from(value).toString("hex")}`;
    }

    private hubProtocolToVerificationProtocol(protocol: Protocol): VerificationProtocol {
        switch (protocol) {
            // case Protocol.ETHEREUM:
            //     return "ethereum";
            default:
                return "ethereum";
        }
    }

    private protocolBytesToString(bytes: Uint8Array, protocol: Protocol | VerificationProtocol): string {
        switch (protocol) {
            case Protocol.ETHEREUM:
            case "ethereum":
                return this.bytesToHex(bytes);
            default:
                throw new Error(`Unexpected protocol: ${protocol}`);
        }
    }

    private farcasterTimeToDate(time: number): Date;
    private farcasterTimeToDate(time: null): null;
    private farcasterTimeToDate(time: undefined): undefined;
    private farcasterTimeToDate(time: number | null | undefined): Date | null | undefined {
        if (time === undefined) return undefined;
        if (time === null) return null;
        const result = fromFarcasterTime(time);
        if (result.isErr()) throw result.error;
        return new Date(result.value);
    }

    async insertMentions(text: string, mentions: number[], mentionsPositions: number[]): Promise<string> {
        const splitter = new GraphemeSplitter();
        const graphemes = splitter.splitGraphemes(text);

        // Normalize positions by mapping each visual position to grapheme index
        const normalizedPositions = mentionsPositions.map((pos) =>
            splitter.splitGraphemes(text.slice(0, pos)).length
        );

        // Use the correct position from mentionsPositions
        for (let i = mentions.length - 1; i >= 0; i--) {
            const mention = mentions[i];
            const fName = await this.handleUserFid(mention);
            const position = mentionsPositions[i];
            graphemes.splice(position, 0, `@${fName}`);
        }
        return graphemes.join('');
    }

    private convertProtobufMessageBodyToJson(message: Message): MessageBodyJson | undefined {
        let body: MessageBodyJson;
        switch (message.data?.type) {
            case MessageType.CAST_ADD: {
                if (!message.data.castAddBody) {
                    elizaLogger.debug("Missing castAddBody");
                    return
                }
                const {
                    embeds: embedsFromCastAddBody,
                    mentions,
                    mentionsPositions,
                    text,
                    parentCastId,
                    parentUrl,
                    type,
                } = message.data.castAddBody;

                const embeds: string[] = [];

                for (const embed of embedsFromCastAddBody) {
                    if (typeof embed.castId !== "undefined") {
                        embeds.push(this.bytesToHex(embed.castId.hash));
                    }
                    // We are going "one of" approach on the embed Cast Id and URL.
                    // If both are set its likely a client attributing itself with the same
                    // cast information. If it is a different URL representing a different cast
                    // that would be inaccurate way to push data to the protocol anyway.
                    // Eventually we may want to attribute which client quoted cast was shared
                    // from - but that will require a data model change on how messages are stored.
                    else if (typeof embed.url !== "undefined") {
                        embeds.push(embed.url);
                    }
                }

                body = {
                    embeds: embeds,
                    mentions,
                    mentionsPositions,
                    text,
                    type,
                    parent: parentCastId ? {
                        fid: parentCastId.fid,
                        hash: this.bytesToHex(parentCastId.hash)
                    } : { fid: 0, hash: "0x0" },
                };
                break;
            }
            case MessageType.CAST_REMOVE: {
                if (!message.data.castRemoveBody) throw new Error("Missing castRemoveBody");
                const { targetHash } = message.data.castRemoveBody;
                body = { targetHash: this.bytesToHex(targetHash) };
                break;
            }
            case MessageType.REACTION_ADD:
            case MessageType.REACTION_REMOVE: {
                if (!message.data.reactionBody) throw new Error("Missing reactionBody");
                if (message.data.reactionBody.targetCastId) {
                    const {
                        type,
                        targetCastId: { fid, hash },
                    } = message.data.reactionBody;
                    body = { type, target: { fid, hash: this.bytesToHex(hash) } };
                } else if (message.data.reactionBody.targetUrl) {
                    const { type, targetUrl } = message.data.reactionBody;
                    body = { type, target: targetUrl };
                } else {
                    throw new Error("Missing targetCastId and targetUrl on reactionBody");
                }
                break;
            }
            case MessageType.LINK_ADD:
            case MessageType.LINK_REMOVE: {
                if (!message.data.linkBody) throw new Error("Missing linkBody");
                const target = message.data.linkBody.targetFid;
                if (!target) throw new Error("Missing linkBody target");
                const { type, targetFid, displayTimestamp } = message.data.linkBody;
                body = { type, targetFid };
                if (displayTimestamp) {
                    const displayTimestampUnixResult = fromFarcasterTime(displayTimestamp);
                    if (displayTimestampUnixResult.isErr()) throw displayTimestampUnixResult.error;
                    body.displayTimestamp = displayTimestampUnixResult.value;
                }
                break;
            }
            case MessageType.LINK_COMPACT_STATE: {
                if (!message.data.linkCompactStateBody) throw new Error("Missing linkCompactStateBody");
                const { type, targetFids } = message.data.linkCompactStateBody;
                body = { type, targetFids };
                break;
            }
            case MessageType.VERIFICATION_ADD_ETH_ADDRESS: {
                if (!message.data.verificationAddAddressBody) {
                    throw new Error("Missing verificationAddAddressBody");
                }
                const { address, claimSignature, blockHash, protocol } = message.data.verificationAddAddressBody;
                body = {
                    address: this.protocolBytesToString(address, protocol),
                    claimSignature: this.protocolBytesToString(claimSignature, protocol),
                    blockHash: this.protocolBytesToString(blockHash, protocol),
                    protocol: this.hubProtocolToVerificationProtocol(protocol),
                };
                break;
            }
            case MessageType.VERIFICATION_REMOVE: {
                if (!message.data.verificationRemoveBody) throw new Error("Missing verificationRemoveBody");
                const { address, protocol } = message.data.verificationRemoveBody;
                body = {
                    address: this.protocolBytesToString(address, protocol),
                    protocol: this.hubProtocolToVerificationProtocol(protocol),
                };
                break;
            }
            case MessageType.USER_DATA_ADD: {
                if (!message.data.userDataBody) throw new Error("Missing userDataBody");
                const { type, value } = message.data.userDataBody;
                body = { type, value };
                break;
            }
            case MessageType.USERNAME_PROOF: {
                if (!message.data.usernameProofBody) throw new Error("Missing usernameProofBody");
                const { timestamp, name, owner, signature, fid, type } = message.data.usernameProofBody;
                body = {
                    timestamp,
                    name: this.bytesToHex(name),
                    owner: this.bytesToHex(owner),
                    signature: this.bytesToHex(signature),
                    fid,
                    type,
                };
                break;
            }
            default:
                // TODO: Once we update types in upstream @farcaster/hub-nodejs, switch to this
                // assertUnreachable(message.data.type);
                throw new Error(`Unknown message type ${message.data?.type}`);
        }

        return body;
    }

    private async subscriberStream(fromEventId: number | undefined) {
        const result = await this.hubClient.subscribe({
            eventTypes: [
                HubEventType.MERGE_MESSAGE,
                // HubEventType.PRUNE_MESSAGE,
                // HubEventType.REVOKE_MESSAGE,
                // HubEventType.MERGE_ON_CHAIN_EVENT,
            ],
            fromId: fromEventId,       // the last event we processed
        })


        if (result.isErr()) {
            elizaLogger.error(`Farcaster: Error starting stream: ${result.error}`);
            if (!this.isStopped)
                this.reconnect();
            return
        }

        this.isConnected = true;
        this.isReconnecting = false;

        result.match(
            (stream) => {
                elizaLogger.log(`Subscribed to Farcaster Stream from: ${fromEventId ? `event ${fromEventId}` : 'HEAD'}`);

                // console.info(`Subscribed to Farcaster Stream: HEAD`)         //current event
                //TEST: Manually trigger the 'close' event for testing // Simulate close after 3 seconds
                // setTimeout(() => { console.log("Simulating stream end..."); stream.emit('end'); }, 10000);
                // setTimeout(() => { console.log("Simulating stream close..."); stream.emit('close'); stream.emit('close'); }, 10000);

                stream.on('data', async (e: HubEvent) => {
                    this.handleEvent(e)
                    saveLatestEventId(e.id)
                    // elizaLogger.debug('Farcaster Hub: Processing Event ' + e.id)

                    // Manually trigger the 'close' event from command
                    if (this.isStopped) {
                        this.isConnected = false;
                        stream.destroy();
                    }
                })

                stream.on('end', async () => {
                    elizaLogger.log(`Farcaster Hub: Hub stream ended`);
                    // console.log(`Stream object details on END:`);
                    // this.logRelevantStreamDetails(stream);
                    // this.isConnected = false;
                })

                stream.on('close', async () => {
                    const closeReason = this.determineCloseReason(stream);
                    elizaLogger.log(`Farcaster Hub: Hub stream closed: ${closeReason}`);

                    // console.log(`Stream object details on CLOSE:`);
                    // this.logRelevantStreamDetails(stream);
                    if (!this.isStopped) {
                        //if we did not received external command to stop, try to reconect
                        this.isConnected = false;
                        this.reconnect();
                    }
                })

                // Handle stream errors
                stream.on('error', (error) => {
                    console.error('Stream error:', error);
                    this.handleStreamError(error);
                });
            }, (e) => { elizaLogger.error('Error streaming data.') })
    }

    private determineCloseReason(stream: any): string {
        if (this.isStopped) {
            return 'Manual stop requested';
        }
        if (stream.destroyed) {
            return 'Stream was destroyed';
        }
        if (stream.error) {
            return `Error occurred: ${stream.error.message}`;
        }
        if (!this.isConnected) {
            return 'Connection lost';
        }
        return 'Unknown reason';
    }

    private handleStreamError(error: Error): void {
        elizaLogger.debug('Stream error details:', {
            name: error.name,
            message: error.message,
            stack: error.stack,
            // For gRPC specific errors
            code: (error as any).code,
            details: (error as any).details,
            metadata: (error as any).metadata
        });
    }

    private async reconnect() {
        // Guard against multiple concurrent reconnection attempts
        if (this.isReconnecting || this.isConnected || this.isStopped) {
            return;
        }

        try {
            this.isReconnecting = true;
            elizaLogger.warn(`Farcaster Hub: Reconnecting to ${this.HUB_RPC}`);

            // Get latest event once before reconnection attempt
            const latestEvent = await getLatestEvent();

            await new Promise(resolve => setTimeout(resolve, 3000));

            if (!this.isConnected && !this.isStopped) {
                await this.subscriberStream(latestEvent);
            }
        } catch (error) {
            elizaLogger.error('Reconnection failed:', error);
        } finally {
            // Reset reconnecting flag if connection wasn't established
            if (!this.isConnected) {
                this.isReconnecting = false;
            }
        }
    }


    private logRelevantStreamDetails(stream: any) {
        const keysOfInterest = ['error', 'statusCode', 'closed', 'destroyed', '_readableState', 'call'];
        const filteredDetails: Record<string, any> = {};

        keysOfInterest.forEach((key) => {
            if (key in stream) {
                filteredDetails[key] = stream[key];
            }
        });

        // console.log(
        //     `Filtered stream details:`,
        //     inspect(filteredDetails, { depth: 2, colors: true })
        // );
    }

    private async handleEvent(event: HubEvent) {
        switch (event.type) {
            case HubEventType.MERGE_MESSAGE: {
                const msg = event.mergeMessageBody!.message!
                const msgType = msg.data!.type

                switch (msgType) {
                    case MessageType.CAST_ADD: {
                        this.handleAddCasts([msg]);
                        break
                    }
                    case MessageType.CAST_REMOVE: {
                        // this.deleteCasts([msg]);
                        break
                    }
                    case MessageType.VERIFICATION_ADD_ETH_ADDRESS: {
                        // this.insertVerifications([msg]);
                        break
                    }
                    case MessageType.VERIFICATION_REMOVE: {
                        // this.deleteVerifications([msg]);
                        break
                    }
                    case MessageType.USER_DATA_ADD: {
                        // this.insertUserDatas([msg]);
                        break
                    }
                    case MessageType.REACTION_ADD: {
                        // await insertReactions([msg])
                        // this.insertReactions([msg]);
                        break
                    }
                    case MessageType.REACTION_REMOVE: {
                        // await deleteReactions([msg])
                        // this.deleteReactions([msg]);
                        break
                    }
                    case MessageType.LINK_ADD: {
                        // await insertLinks([msg])
                        // this.insertLinks([msg]);
                        break
                    }
                    case MessageType.LINK_REMOVE: {
                        // await deleteLinks([msg])
                        // this.deleteLinks([msg]);
                        break
                    }
                    default: {
                        // log.info('UNHANDLED MERGE_MESSAGE EVENT', event.id)
                        // console.info('UNHANDLED MERGE_MESSAGE EVENT', event.id)
                        // this.eventBus.publish("LOG", 'UNHANDLED MERGE_MESSAGE EVENT: ' + event.id);
                    }
                }

                break
            }
            case HubEventType.PRUNE_MESSAGE: {
                const msg = event.pruneMessageBody!.message!
                const msgType = msg.data!.type

                switch (msgType) {
                    case MessageType.CAST_ADD: {
                        // await pruneCasts([msg])
                        break
                    }
                    case MessageType.REACTION_ADD: {
                        // await pruneReactions([msg])
                        break
                    }
                    case MessageType.LINK_ADD: {
                        // await pruneLinks([msg])
                        break
                    }
                    default: {
                        // console.log('UNHANDLED PRUNE_MESSAGE EVENT ' + msg.data);
                        elizaLogger.error('UNHANDLED PRUNE_MESSAGE EVENT ' + msg.data);
                    }
                }

                break
            }
            case HubEventType.REVOKE_MESSAGE: {
                // Events are emitted when a signer that was used to create a message is removed
                // TODO: handle revoking messages
                break
            }
            case HubEventType.MERGE_ON_CHAIN_EVENT: {
                const onChainEvent = event.mergeOnChainEventBody!.onChainEvent!

                switch (onChainEvent.type) {
                    case OnChainEventType.EVENT_TYPE_ID_REGISTER: {
                        // await insertRegistrations([onChainEvent])
                        break
                    }
                    case OnChainEventType.EVENT_TYPE_SIGNER: {
                        // await insertSigners([onChainEvent])
                        break
                    }
                    case OnChainEventType.EVENT_TYPE_STORAGE_RENT: {
                        // await insertStorage([onChainEvent])
                        break
                    }
                }

                break
            }
            default: {
                console.error('UNHANDLED HUB EVENT', event.id)
                break
            }
        }
        // await job.updateProgress(100)
    }

    // public async getTrendingFeed(filter = FilterType.GlobalTrending) {
    //     let trendingFeed = "";
    //     try {
    //         const feed = await this.client.neynar.fetchFeed({
    //             feedType: FeedType.Filter,
    //             filterType: filter,
    //         });
    //         for (const cast of Object.values(feed.casts))
    //             trendingFeed += `${cast.author.display_name}: ${cast.text}`;
    //     } catch (err) {
    //         console.error("Error fetching Farcaster Feed", err);
    //     }
    //     return trendingFeed;
    // }



    /**
     * Function to publish a message (cast) using neynarClient.
     * @param msg - The message to be published.
     * @returns A promise that resolves when the operation completes.
     * Example of `response_data`:
        {
            hash: '0xbb89163dc43e88f05ff2e1fb0dbb8b781ddf547c',
            author: {
                object: 'user',
                fid: 527313,
                username: 'nounspacetom',
                display_name: 'nounspaceTom.eth',
                pfp_url: 'https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/46134281-9cbd-431e-01cc-d128c7695700/original',
                custody_address: '0xaa3ea790b0d714dcab0bdb7a02a336393dd2e2d9',
                profile: { bio: [Object] },
                follower_count: 8377,
                following_count: 1258,
                verifications: [ '0x06ae622bf2029db79bdebd38f723f1f33f95f6c5' ],
                verified_addresses: { eth_addresses: [Array], sol_addresses: [] },
                verified_accounts: null,
                power_badge: true
            },
            text: "Here's to new beginnings! I'm thrilled to join this vibrant community, eager to learn..."
        }
     */
    private async publishToFarcaster(msg: string, options: any) {
        if (this.isStopped) return

        if (this.client.farcasterConfig?.FARCASTER_DRY_RUN) {
            elizaLogger.warn(
                `Farcaster Cast: ${msg}`
            );
            return;
        }

        this.client.neynar
            .publishCast({
                signerUuid: String(process.env.FARCASTER_NEYNAR_SIGNER_UUID),
                text: msg,
                channelId: options.channelId,
                parentAuthorFid: options.parent_author_fid,
                parent: options.replyTo,
            })
            .then(response_data => {
                elizaLogger.warn(`Farcaster: Cast published successfully:\n  ${this.client.farcasterConfig?.FAVORITE_FRONTEND}/${this.client.farcasterConfig?.FARCASTER_USERNAME}/${response_data.cast.hash}`)
            })
            .catch(error => {
                if (isApiErrorResponse(error)) {
                    const errorCastObj = {
                        error: error.response.data,
                        msg,
                        options
                    }
                    // this.eventBus.publish("ERROR_FC_PUBLISH", errorCastObj);
                } else {
                    const errorCastObj = {
                        error: JSON.stringify(error),
                        msg,
                        options
                    }
                    // this.eventBus.publish("ERROR_FC_PUBLISH", errorCastObj);
                }
            });

        this.likeCast(options);
    }

    // public async delayedLikeCast(options: any) {
    //     const delayInMinutes = Math.floor(Math.random() * 2);
    //     // const delayInMinutes = randomInt(1, 2);
    //     setTimeout(() => {
    //         this.likeCast(options);
    //     }, delayInMinutes * 60 * 1000); // convert minutes to milliseconds
    // }

    public async likeCast(options: any) {
        if ((options.replyTo) && (options.parent_author_fid)) {
            this.client.neynar.publishReaction({
                signerUuid: this.signerUuid,
                reactionType: 'like',
                target: options.replyTo,
                targetAuthorFid: options.parent_author_fid
            }).then(response => {
                elizaLogger.warn("Farcaster: Reaction published successfully");
                // this.farcasterLog.info("Reaction published successfully ", "INFO")
                // console.log('Publish Reaction Operation Status:', response); // Outputs the status of the reaction post
            }).catch(error => {
                if (isApiErrorResponse(error)) {
                    elizaLogger.error("Farcaster: Failed to publish reaction");
                    elizaLogger.debug(error.response.data)
                    // console.error(Red + error.response.data + Reset);
                    // this.farcasterLog.log("Failed to publish reaction: " + error.response.data, "ERROR")
                } else {
                    elizaLogger.error("Farcaster: Failed to publish reaction");
                    elizaLogger.debug(error)
                    // this.farcasterLog.log("Failed to publish reaction: " + JSON.stringify(error), "ERROR")
                    // console.error(Red + "Failed to publish Reaction: " + error + + Reset);
                }
            });
        }
    }

    public async schedulePublishUserReply(msg: string, parentHash: string, parentAuthorFid: number) {
        // Using the neynarClient to publish the cast.
        const options = {
            replyTo: parentHash,
            parent_author_fid: parentAuthorFid,
        }

        // Wait for a random time between 1 and 2 minutes before publishing
        const delayInMinutes = Math.floor(Math.random() * 2);
        setTimeout(() => {
            this.publishToFarcaster(msg, options);
        }, delayInMinutes * 60 * 1000); // convert minutes to milliseconds
    }

    // public async publishUserReply(msg: string, parentHash: string, parentAuthorFid: number) {
    //     // Using the neynarClient to publish the cast.
    //     const options = {
    //         replyTo: parentHash,
    //         parent_author_fid: parentAuthorFid,
    //     }

    //     this.publishToFarcaster(msg, options);

    //     const fName = (await this.handleUserFid(parentAuthorFid));
    //     // if (botConfig.PUBLISH_TO_FARCASTER)
    //     //     this.farcasterLog.info(`Published Reply to:\n  https://warpcast.com/${fName}/${parentHash}`);
    // }

    // public async publishNewChannelCast(msg: string) {
    //     // Using the neynarClient to publish the cast.
    //     const options = {
    //         channelId: botConfig.CAST_TO_CHANNEL
    //     }

    //     this.publishToFarcaster(msg, options);
    // };

    private urlMatchesTargetChannel(url: string): boolean {
        // Early return if no URL provided
        if (!url) return false;

        // Get target channels from config, default to empty array if undefined
        const targetChannels = this.client.farcasterConfig.FARCASTER_TARGET_CHANNEL ?? "";

        // Return false if no target channels configured
        if (!targetChannels.length) {
            elizaLogger.warn('No target channels configured');
            return false;
        }

        // Check if URL matches any target channel
        try {
            return url.toLowerCase().endsWith('~/channel/' + targetChannels.toLowerCase());
        } catch (error) {
            return false;
        }
    }

    private async handleAddCasts(msgs: Message[]): Promise<void> {
        for (let m = 0; m < msgs.length; m++) {
            const data = msgs[m].data;
            if (data && data.castAddBody) {

                // Handle Targets Add Cast
                if (this.TARGETS.includes(data.fid)) {
                    // Target Add New Cast
                    this.handleTargetAddCast(msgs[m])
                    return;
                }

                // Handle Channel Messages
                // if (data.castAddBody.parentUrl) elizaLogger.debug(data.castAddBody.parentUrl);
                if (data.castAddBody.parentUrl && this.urlMatchesTargetChannel(data.castAddBody.parentUrl)) {
                    this.handleTargetChannelCast(msgs[m]);
                    return;
                }

                //DEBUG
                // console.dir(msgs[m]);
                // elizaLogger.debug(`${msgs[m].data?.fid} cast: ${msgs[m].data?.castAddBody?.text}`)
                // elizaLogger.warn(`${msgs[m].data?.fid} cast: ${msgs[m].data?.castAddBody?.text}`)

                // Handle Replies
                // if (data.castAddBody.parentCastId && botConfig.TARGETS.includes(data.castAddBody.parentCastId.fid)) {
                // if ((data.castAddBody.parentCastId)
                //     && (botConfig.BotFID == data.castAddBody.parentCastId.fid)) {
                //     // Target found on parentCastId (Reply)
                //     this.handleReceivedReply(msgs[m]);
                //     return;
                // }

                // Handle Mentions
                // const foundMention = data.castAddBody.mentions.find(mention => botConfig.TARGETS.includes(mention));
                // const foundMention = data.castAddBody.mentions.find(mention => botConfig.BotFID == mention);
                // if (foundMention) {
                //     // Target found on Mention
                //     this.handleMentioned(msgs[m], foundMention);
                //     return;
                // }

                // Quote Casts
                // if (data.castAddBody.embeds && data.castAddBody.embeds.find(embeds => botConfig.BotFID == embeds.castId?.fid)) {
                //     this.handleQuoteCasts(msgs[m])
                //     return;
                // }
            }
        }
    }


    // // ... fetch and save into cache. return fetched data
    public async handleUserInfo(fname: string): Promise<UserResponse | undefined> {
        // check if fid is on the users fname cache
        if (!this.USERS_DATA_INFO.has(fname)) {
            const result = await this.getUserDataFromFname(fname);
            if (result)
                this.USERS_DATA_INFO.set(fname, result);
        }

        // trim max user fname cache TODO:
        if (this.USERS_DATA_INFO.size >= this.MAX_CACHE_SIZE) {
            this.USERS_DATA_INFO.delete(this.USERS_DATA_INFO.keys().next().value as string);
        }

        return this.USERS_DATA_INFO.get(fname);
    }

    private async handleUserFid(fid: number): Promise<string> {
        // check if fid is on the users fname cache
        if (!this.USERS_FNAME_MAP.has(fid)) {
            const usernameResult = await this.getFnameFromFid(fid);
            usernameResult.match(
                (username) => this.USERS_FNAME_MAP.set(fid, username),
                (error) => console.error(`Error: ${error.message}`)
            );
        }

        // trim max user fname cache
        if (this.USERS_FNAME_MAP.size >= 100) { //botConfig.MAX_USER_CACHE) {
            this.USERS_FNAME_MAP.delete(this.USERS_FNAME_MAP.keys().next().value as number);
        }

        return this.USERS_FNAME_MAP.get(fid)!;
    }

    // // get fname from fid using FC hub results.... we can replace this for new USER DATA INFO map
    private async getFnameFromFid(fid: number): Promise<Result<string, Error>> {
        try {
            const result = await this.hubClient.getUserData({
                fid: fid,
                userDataType: UserDataType.USERNAME
            });

            const username = result.match(
                (message) => {
                    if (isUserDataAddMessage(message)) {
                        return message.data.userDataBody.value;
                    }
                    return `${fid}!`;
                },
                (error) => `${fid}!` // fallback to FID if error
            );

            return ok(username);
        } catch (error) {
            return err(error instanceof Error ? error : new Error('Unknown error'));
        }
    }

    // // get some information from user using neynar
    private async getUserDataFromFname(fname: string): Promise<UserResponse | undefined> {
        try {
            const userData = await this.client.neynar
                .lookupUserByUsername({
                    username: fname,
                    viewerFid: this.client.farcasterConfig?.FARCASTER_FID
                })
            // .fetchBulkUsers([fid], { viewerFid: botConfig.BotFID });
            // const userData = result; //select first result
            // this.farcasterLog.log(userData, "UserData");
            return userData;
            // return userData;
            // return {
            //     fid,
            //     fName: userData?.username,
            //     display_name: userData?.display_name,
            //     bio: userData?.profile?.bio?.text,
            //     city: userData?.profile?.location?.address?.city ?? 'Unknown',
            //     state: userData?.profile?.location?.address?.state ?? null,
            //     country_code: userData?.profile?.location?.address?.country_code ?? '',
            //     follower_count: userData?.follower_count ?? 0,
            //     following_count: userData?.following_count ?? 0,
            //     verifications: (userData?.verifications ?? []).length,
            //     power_badge: userData?.power_badge ?? false,
            //     viewer_context: {
            //       following: userData?.viewer_context?.following ?? false,
            //       followed_by: userData?.viewer_context?.followed_by ?? false,
            //     },
            // };
        }
        catch (err) {
            // console.error(err)
        };
    }

    // // return bot targets from fid and store it on cache
    // private async handleTargetFid(fid: number): Promise<string> {
    //     if (!this.TARGET_FNAME_MAP.has(fid)) {
    //         const result = await this.getFnameFromFid(fid);
    //         if (result.isOk()) {
    //             this.TARGET_FNAME_MAP.set(fid, result.value);
    //         }
    //     }

    //     return this.TARGET_FNAME_MAP.get(fid)!;
    // }


    // // handle when bot targest posst new message
    // private async handleTargetAddCast(message: Message) {
    //     // const body = this.convertProtobufMessageBodyToJson(message);
    //     // const tName = await this.handleTargetFid(message.data.fid);  // target Name
    //     const castObj = await this.createCastObj(message);
    //     this.eventBus.publish("CAST_ADD", castObj);
    // }

    // private async handleQuoteCasts(message: Message): Promise<void> {
    //     // const tName = await this.handleTargetFid(message.data.castAddBody.parentCastId.fid);  // farcaster (User)Name 
    //     const castObj = await this.createCastObj(message);
    //     // console.dir(castObj);
    //     this.eventBus.publish("WAS_QUOTE_CAST", castObj);
    // }

    // private async handleReceivedReply(message: Message): Promise<void> {
    //     // const tName = await this.handleTargetFid(message.data.castAddBody.parentCastId.fid);  // farcaster (User)Name 
    //     const castObj = await this.createCastObj(message);
    //     // console.dir(castObj);
    //     this.eventBus.publish("WAS_REPLIED", castObj);
    // }

    // private async handleMentioned(message: Message, foundMention: number): Promise<void> {
    //     // const tName = await this.handleTargetFid(foundMention);  // target Name
    //     const castObj = await this.createCastObj(message);
    //     // console.log(tName + " was mentioned by " + castObj.fName);
    //     // console.dir(castObj);
    //     this.eventBus.publish("WAS_MENTIONED", castObj);
    // }


    private async handleTargetChannelCast(message: Message) {
        const agentFid = this.client.farcasterConfig?.FARCASTER_FID ?? 0;
        const agent = await this.client.getProfile(agentFid);

        // ignore agent casts
        if (message.data?.fid == agentFid) {
            return
        }

        // if bot was mentioned, ignore and let handle Mentions method process it...
        const foundMention = message.data?.castAddBody?.mentions.find(mention => agentFid == mention);
        if (foundMention) {
            return;
        }

        if (message.data && message.data.castAddBody && message.data.castAddBody.parentUrl) {
            // console.warn("New Message at Channel: " + message.data.castAddBody.parentUrl);
            const cast = await this.createCastObj(message);
            if (!cast) return

            // console.dir(cast);
            // generateTomReplyMemory(data.fid, data.castAddBody.text);
            // this.eventBus.publish("CHANNEL_NEW_MESSAGE", cast);
            elizaLogger.info(`Farcaster: New Channel Cast: ${cast.text}`)

            // return;

            const messageHash = cast.hash;
            const conversationId = `${messageHash}-${this.runtime.agentId}`;
            const roomId = stringToUuid(conversationId);
            const userId = stringToUuid(cast.authorFid.toString());

            const pastMemoryId = castUuid({
                agentId: this.runtime.agentId,
                hash: messageHash,
            });

            const pastMemory =
                await this.runtime.messageManager.getMemoryById(pastMemoryId);

            if (pastMemory) {
                return;
            }

            await this.runtime.ensureConnection(
                userId,
                roomId,
                cast.profile.username,
                cast.profile.name,
                "farcaster"
            );

            const thread = await buildConversationThread({
                client: this.client,
                runtime: this.runtime,
                cast,
            });

            const memory: Memory = {
                content: { text: cast.text },
                agentId: this.runtime.agentId,
                userId,
                roomId,
            };

            //
            const castMessage: Cast = cast; // fix, check, todo
            //
            await this.handleCast({
                agent,
                cast: castMessage,
                memory,
                thread,
            });

            this.client.lastInteractionTimestamp = new Date();
        }
    }


    private async createCastObj(message: Message): Promise<Cast | undefined> {
        if (!message.data) return;

        const body = this.convertProtobufMessageBodyToJson(message) as CastAddBodyJson;
        const fName = await this.handleUserFid(message.data.fid);    // farcast (User)Name 
        const userProfile = await this.handleUserInfo(fName);        // go fetch user info async
        if (!userProfile) {
            elizaLogger.error(`Farcaster: missing profile ${fName}`);
            return;
        }

        const hash = this.bytesToHex(message.hash);

        if ('text' in body && 'mentions' in body && 'mentionsPositions' in body) {
            if (body.mentions instanceof Array && body.mentionsPositions instanceof Array) {

                let textContent = body.text;
                if (body.mentions.length > 0)
                    textContent = await this.insertMentions(body.text, body.mentions, body.mentionsPositions);
                body.textWithMentions = textContent;
            }
        }

        // return {
        //     fid: message.data.fid,
        //     fName,
        //     hash,
        //     type: message.data.type,
        //     timestamp: this.farcasterTimeToDate(message.data.timestamp),
        //     body
        // }

        const profile: Profile = {
            fid: userProfile.user.fid,
            name: userProfile.user.display_name || '',
            username: userProfile.user.username
        };

        const inReplyTo = (body.parent?.hash && body.parent.hash !== "0x0") ? {
            hash: body.parent.hash,
            fid: body.parent?.fid!,
        } : undefined;

        return {
            hash,
            authorFid: message.data.fid,
            text: body.textWithMentions!,
            profile,
            inReplyTo,
            timestamp: this.farcasterTimeToDate(message.data.timestamp),
        };

    }

    private async cleanup() {
        // Cleanup connections
        // Clear caches
        this.USERS_DATA_INFO.clear();
        this.USERS_FNAME_MAP.clear();
    }

    public stop() {
        try {
            this.isStopped = true;
            this.cleanup();
            return true;
        } catch {
            return false;
        }
    }

    public async start(from: number | undefined = undefined) {
        const agentFid = this.client.farcasterConfig?.FARCASTER_FID ?? 0;
        if (!agentFid) {
            elizaLogger.info("No FID found, skipping interactions");
            return;
        }

        try {
            this.isStopped = false;
            const lastid = from || await getLatestEvent();
            this.subscriberStream(lastid);
            return true;
        } catch {
            return false;
        }
    }

    // public getConnectionStatus() {
    //     return this.isConnected;
    // }

    // public async getQuoteCastContext(castHashOrUrl: string, castParamType: CastParamType = CastParamType.Hash): Promise<BotChatMessage[]> {
    //     var lastMessages: BotChatMessage[] = [];
    //     try {
    //         const response = await this.neynarClient.lookupCastConversation({
    //             identifier: castHashOrUrl,
    //             type: castParamType,
    //             replyDepth: 2,
    //             includeChronologicalParentCasts: true,
    //             viewerFid: botConfig.BotFID,
    //             limit: botConfig.LAST_CONVERSATION_LIMIT
    //             //                 limit: 10,
    //             // cursor: "nextPageCursor" // Omit this parameter for the initial request
    //         });

    //         lastMessages.push({
    //             name: response.conversation.cast.author.username,
    //             message: response.conversation.cast.text,
    //             imageUrl: "",
    //         });

    //         return lastMessages;
    //     }
    //     catch (error) {
    //         console.error('Get Quote Cast Context Fail:');
    //         return lastMessages;
    //     }
    // }

    // public async getConversationHistory(castHashOrUrl: string, castParamType: CastParamType = CastParamType.Hash): Promise<BotChatMessage[]> {
    //     var lastMessages: BotChatMessage[] = [];
    //     try {
    //         const response = await this.neynarClient.lookupCastConversation({
    //             identifier: castHashOrUrl,
    //             type: castParamType,
    //             replyDepth: 2,
    //             includeChronologicalParentCasts: true,
    //             viewerFid: botConfig.BotFID,
    //             limit: botConfig.LAST_CONVERSATION_LIMIT
    //             //limit: 10,
    //             //cursor: "nextPageCursor" // Omit this parameter for the initial request
    //         })

    //         const messages: CastWithInteractions[] = response.conversation.chronological_parent_casts.slice().reverse();
    //         const lastThreeMessages: BotChatMessage[] = messages
    //             .slice(0, botConfig.LAST_CONVERSATION_LIMIT)
    //             .reverse()
    //             .map((message: CastWithInteractions) => {
    //                 let imageUrl = "";
    //                 const embed = message.embeds[0];
    //                 if (typeof embed === 'object' && 'url' in embed) {
    //                     imageUrl = embed.url;
    //                 }
    //                 return { name: message.author.username, message: message.text, imageUrl };
    //                 // return `@${message.author.username}: ${message.text}\n`;

    //             });

    //         // Add Embbeded Cast to conversation history if exist
    //         if (response.conversation.cast.embeds.length > 0) {
    //             const embbedCast = response.conversation.cast.embeds[0] as unknown as EmbedObject | undefined;
    //             if (embbedCast.cast && embbedCast.cast.object &&
    //                 embbedCast.cast.object === 'cast_embedded' &&
    //                 embbedCast.cast.text
    //             ) {
    //                 lastThreeMessages.push({
    //                     name: embbedCast.cast.author.username,
    //                     message: embbedCast.cast.text,
    //                     imageUrl: "",
    //                 })
    //             }
    //         }

    //         lastMessages = lastThreeMessages;
    //     }
    //     catch (error) {
    //         console.error('Get Cast Conversation Fail:');
    //     };

    //     return lastMessages;
    // }

    private async handleTargetAddCast(message: Message) {
        switch (message.data?.fid) {
            case FID_CLANKER:
                const cast = await this.createCastObj(message);
                if (cast)
                    this.handleClankerMessage(cast);
                break;

            default:
                break;
        }
    }


    // TODO: any
    async handleClankerMessage(cast: Cast) {
        // Ensure we have the required cast data
        if (!cast.text) {
            elizaLogger.debug("Received invalid cast from Clanker");
            return;
        }

        // Get the cast text content
        // const castUsername = cast.profile.username;
        // const castText = cast.text;
        // const castHash = cast.hash;

        elizaLogger.debug(`Processing Clanker cast:`);
        //  ${castText} (${castHash})`);

        // Log interaction with Clanker's message
        // elizaLogger.debug(`Processing Clanker cast:
        // FID: ${cast.fid}
        // Timestamp: ${cast.timestamp}
        // Text: ${castText}
        // Hash: ${castHash}
        // Link: ${this.client.farcasterConfig?.FAVORITE_FRONTEND}/${castUsername}/${castHash}
        // `);

        if (!this.isDeployEvent(cast)) {
            elizaLogger.debug("Clanker: Not a deploy event");
            return undefined;
        }

        const contractAddress = this.extractContractAddress(cast.text);
        if (!contractAddress) {
            elizaLogger.debug("Clanker: Missing Contract Address");
            return undefined;
        }

        const parentFid = cast.inReplyTo?.fid;
        if (!parentFid) {
            elizaLogger.debug("Clanker: Missing cast.inReplyTo.fid");
            return undefined;
        }

        const deployerInfo = await this.fetchDeployerInfo(parentFid);
        if (!deployerInfo) {
            elizaLogger.debug("Clanker: Missing Deployer Info");
            return undefined;
        }

        const CastConversation = await this.client.neynar.lookupCastConversation({
            identifier: cast.hash,
            type: 'hash',
            replyDepth: 2,
            includeChronologicalParentCasts: true,
            viewerFid: this.client.farcasterConfig.FARCASTER_FID,
            limit: this.client.farcasterConfig.LAST_CONVERSATION_LIMIT
            // limit: 10,
            // cursor: "nextPageCursor" // Omit this parameter for the initial request
        })

        const { historyConversation, imageUrls } = this.extractConversationDetails(CastConversation);
        const image_description = await this.processImage(imageUrls[0])

        const username = deployerInfo.username;
        const bio = deployerInfo.profile.bio.text;
        const nounspacePage = `https://nounspace.com/t/base/${contractAddress}`;
        const thread_hash = CastConversation.conversation.cast.thread_hash;

        const CLANKER_REPLY_PROMPT = `
Roleplay as Tom from "nounspace" and generate a personalized, engaging, and casual message that's snappy, concise, and a maximum of 3 sentences without any introduction, decision-making context or explanations, just responde with the message.

REMEMBER: 
Strictly maintain branding: 'nounspace' must always be lowercase.

# Message goals:
Be witty, creative, and inspired by the provided context which includes:
The token's name and symbol.
The owners's bio, name, and other provided details like about_token and image_description.
Use puns, clever references, or wordplay. 
Encourage action: Prompt the user to log in to "nounspace" with Farcaster to customize their token's space with Themes, Fidgets (mini apps), and Tabs.

# Tips for Better Output:
Include dynamic personalization to create a strong sense of connection.
Maintain clarity despite the creative tone.
No preamble, no wrap-up: Just output the final message. No "Here's your message" intro or follow-up comments.

# IMPORTANT
"nounspace" brand is always lowercase.
Always output 'nounspace' in lowercase, never capitalized.
Do not include any hashtags.
Do not mention @clanker. Only mention token owner's username

<about_token>
  username: @${username}
  user bio: ${bio}

  ${image_description?.description}

  <token_creation_conversatioin>
    ${historyConversation}
  </token_creation_conversatioin>
<about_token>
`;

        // const context = composeContext({
        //     state,
        //     template:
        //         this.runtime.character.templates
        //             ?.farcasterMessageHandlerTemplate ??
        //         this.runtime.character?.templates?.messageHandlerTemplate ??
        //         messageHandlerTemplate,
        // });

        // const response = await generateText;
        // const responseContent = await generateMessageResponse({
        //     runtime: this.runtime,
        //     context,
        //     modelClass: ModelClass.LARGE,
        // });

        // responseContent.inReplyTo = memoryId;

        // if (!responseContent.text) return;
        if (image_description)
            elizaLogger.warn("Image Desctiption: " + image_description.description);

        let reply: any;
        let theTokenReply: any;

        try {
            try {
                reply = await this.chatBotGroq.chat.completions.create({
                    messages: [{
                        role: "user",
                        content: CLANKER_REPLY_PROMPT,
                    },],
                    // model: "llama3-70b-8192",
                    model: "gemma2-9b-it",
                });
            } catch (innerError) {
                elizaLogger.error("Farcaster: Primary chatbot failed");
                elizaLogger.error(innerError);
                elizaLogger.info("Farcaster: Going for Backup LLM");
                reply = await this.chatBotGroq.chat.completions.create({
                    messages: [{
                        role: "user",
                        content: CLANKER_REPLY_PROMPT,
                    },],
                    model: "llama3-8b-8192",
                });
            }

            theTokenReply = reply.choices[0].message.content
                .replace(/^"|"$/g, '')
                + `\n\nHere's your token space: ${nounspacePage}`;
        } catch (error) {
            elizaLogger.error(error);
        }

        // if (this.client.farcasterConfig?.FARCASTER_DRY_RUN) {
        //     // elizaLogger.warn(CLANKER_REPLY_PROMPT);
        //     elizaLogger.warn("\ntheTokenReply:");
        //     elizaLogger.warn(theTokenReply)
        //     return;
        // }

        const options = {
            replyTo: thread_hash,
            parent_author_fid: deployerInfo.fid,
        }

        this.publishToFarcaster(theTokenReply, options);

    }

    extractConversationDetails(data: any): any {
        const conversation = data.conversation.cast;
        const chronological_parent_casts = data.conversation.chronological_parent_casts;

        // Extract conversation details
        const conversationText = conversation.text.split('\n').slice(0, -3).join('\n');;
        const conversationUsername = conversation.author.username;
        const conversationParentFid = conversation.parent_author?.fid;

        // Filter and map matching chronological parent casts
        const parentCasts = chronological_parent_casts
            .filter(cast => cast.author && cast.author?.fid === conversationParentFid)
            .map(cast => `@${cast.author.username}: ${cast.text}`);

        let imageUrls = [];
        try {
            imageUrls = chronological_parent_casts
                .filter(cast => cast.author && cast.author?.fid === conversationParentFid)
                .flatMap(cast =>
                    cast.embeds?.filter(embed => embed.metadata.content_type.includes("image")) || []
                )
                .map(embed => embed.url);
        } catch (error) {
            elizaLogger.error("Error extracting image URLs");
            elizaLogger.error(error);
        }

        // console.log(imageUrls);

        // Add the conversation details
        const conversationDetail = `@${conversationUsername}: ${conversationText}`;

        // Combine parent casts and the conversation detail
        const formattedDetails = [...parentCasts, conversationDetail];

        // Join the formatted details with a newline character
        // return formattedDetails.join('\n');

        return {
            historyConversation: formattedDetails.join('\n'),
            imageUrls
        }
    }

    isDeployEvent(cast: Cast): boolean {
        return (
            cast.profile.username === "clanker" && cast.text.includes("clanker.world")
        );
    }

    extractContractAddress(castText: string): string | null {
        const contractAddressMatch = castText.match(/0x[a-fA-F0-9]{40}/);
        return contractAddressMatch ? contractAddressMatch[0] : null;
    }

    async fetchDeployerInfo(fid: number) {
        const userResponse = await this.client.neynar.fetchBulkUsers({ fids: [fid] });
        return userResponse.users.length ? userResponse.users[0] : null;
    }

    // Process image messages and generate descriptions
    private async processImage(
        imageUrl: string
    ): Promise<{ description: string } | null> {
        try {
            // let imageUrl: string | null = null;
            elizaLogger.debug(`Farcaster Process Image: ${imageUrl}`);

            if (imageUrl) {
                const imageDescriptionService =
                    this.runtime.getService<IImageDescriptionService>(
                        ServiceType.IMAGE_DESCRIPTION
                    );
                if (!imageDescriptionService) {
                    console.error("❌ Error processing image.");
                    return null;
                }
                const { title, description } =
                    await imageDescriptionService.describeImage(imageUrl);
                return { description: `[Image: ${title}\n${description}]` };
            } else {
                elizaLogger.debug(`Farcaster Process Image: No Image to process`);
            }
        } catch (error) {
            console.error("❌ Error processing image:", error);
        }

        return null;
    }

    private async handleCast({
        agent,
        cast,
        memory,
        thread,
    }: {
        agent: Profile;
        cast: Cast;
        memory: Memory;
        thread: Cast[];
    }) {
        if (cast.profile.fid === agent.fid) {
            elizaLogger.debug("skipping cast from bot itself", cast.hash);
            return;
        }

        if (!memory.content.text) {
            elizaLogger.debug("skipping cast with no text", cast.hash);
            return { text: "", action: "IGNORE" };
        }

        const currentPost = formatCast(cast);

        const senderId = stringToUuid(cast.authorFid.toString());

        const { timeline } = await this.client.getTimeline({
            fid: agent.fid,
            pageSize: 10,
        });

        const formattedTimeline = formatTimeline(
            this.runtime.character,
            timeline
        );

        const formattedConversation = thread
            .map(
                (cast) => `@${cast.profile.username} (${new Date(
                    cast.timestamp
                ).toLocaleString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                })}):
                ${cast.text}`
            )
            .join("\n\n");

        const state = await this.runtime.composeState(memory, {
            farcasterUsername: agent.username,
            timeline: formattedTimeline,
            currentPost,
            formattedConversation,
        });

        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.farcasterShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                shouldRespondTemplate,
        });

        const memoryId = castUuid({
            agentId: this.runtime.agentId,
            hash: cast.hash,
        });

        const castMemory =
            await this.runtime.messageManager.getMemoryById(memoryId);

        if (!castMemory) {
            await this.runtime.messageManager.createMemory(
                createCastMemory({
                    roomId: memory.roomId,
                    senderId,
                    runtime: this.runtime,
                    cast,
                })
            );
        }

        const shouldRespondResponse = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
        });

        elizaLogger.info(
            `Dry run: ${cast.profile.name} said: ${cast.text}`
        );

        if (
            shouldRespondResponse === "IGNORE" ||
            shouldRespondResponse === "STOP"
        ) {
            elizaLogger.info(
                `Not responding to cast because generated ShouldRespond was ${shouldRespondResponse}`
            );
            return;
        }

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.farcasterMessageHandlerTemplate ??
                this.runtime.character?.templates?.messageHandlerTemplate ??
                messageHandlerTemplate,
        });

        const responseContent = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        responseContent.inReplyTo = memoryId;

        if (!responseContent.text) return;

        if (this.client.farcasterConfig?.FARCASTER_DRY_RUN) {
            elizaLogger.info(
                `Dry run: would have responded to cast ${this.client.farcasterConfig?.FAVORITE_FRONTEND}/${cast.profile.username}/${cast.hash} with ${responseContent.text}`
            );
            return;
        }

        const callback: HandlerCallback = async (
            content: Content,
            _files: any[]
        ) => {
            try {
                if (memoryId && !content.inReplyTo) {
                    content.inReplyTo = memoryId;
                }
                const results = await sendCast({
                    runtime: this.runtime,
                    client: this.client,
                    signerUuid: this.signerUuid,
                    profile: cast.profile,
                    content: content,
                    roomId: memory.roomId,
                    inReplyTo: {
                        fid: cast.authorFid,
                        hash: cast.hash,
                    },
                });
                // sendCast lost response action, so we need to add it back here
                results[0].memory.content.action = content.action;

                for (const { memory } of results) {
                    await this.runtime.messageManager.createMemory(memory);
                }
                return results.map((result) => result.memory);
            } catch (error) {
                elizaLogger.error("Error sending response cast:", error);
                return [];
            }
        };

        const responseMessages = await callback(responseContent);

        const newState = await this.runtime.updateRecentMessageState(state);

        await this.runtime.processActions(
            { ...memory, content: { ...memory.content, cast } },
            responseMessages,
            newState,
            callback
        );
    }

}

