import {
    CastType, 
    ReactionType,
    UserDataType,
    UserNameType,
} from '@farcaster/hub-nodejs'

export type VerificationProtocol = "ethereum";

// export type Fid = number;
// export type Hex = `0x${string}`;

// export interface BotChatMessage {
//     name: string;
//     message: string;
//     imageUrl?: string;
// }

export type CastIdJson = {
    fid: number;
    hash: `0x${string}`;
};

export type CastAddBodyJson = {
    text: string;
    textWithMentions?: string;
    embeds?: any[];
    mentions?: number[];
    mentionsPositions?: number[];
    parent?: CastIdJson;
    type: CastType;
};

export type CastRemoveBodyJson = {
    targetHash: string;
};

export type ReactionBodyJson = {
    type: ReactionType;
    target: CastIdJson | string;
};

export type LinkBodyJson = {
    type: string;
    /** original timestamp in Unix ms */
    displayTimestamp?: number;
    targetFid?: number;
    targetFids?: number[];
};

export type VerificationAddEthAddressBodyJson = {
    address: string;
    claimSignature: string;
    blockHash: string;
    protocol: string;
};

export type VerificationRemoveBodyJson = {
    address: string;
};

export type SignerAddBodyJson = {
    signer: string;
    name: string;
};

export type SignerRemoveBodyJson = {
    signer: string;
};

export type UserDataBodyJson = {
    type: UserDataType;
    value: string;
};

export type UsernameProofBodyJson = {
    timestamp: number;
    name: string;
    owner: string;
    signature: string;
    fid: number;
    type: UserNameType;
};

export type MessageBodyJson =
    | CastAddBodyJson
    | CastRemoveBodyJson
    | ReactionBodyJson
    | LinkBodyJson
    | VerificationAddEthAddressBodyJson
    | VerificationRemoveBodyJson
    | SignerAddBodyJson
    | SignerRemoveBodyJson
    | UserDataBodyJson
    | UsernameProofBodyJson;

// export type BotCastObj = {
//     fid: number;
//     fName: string;
//     hash: string;
//     type: MessageType;
//     timestamp: Date;
//     body: CastAddBodyJson;
// };

// export type ClankerBotResponse = {
//     historyConversation: Conversation,
//     deployerInfo: any
//     imageUrls: any,
//     nounspacePage: string,
//     thread_hash,
// }

// type EmbedObject = {
//     cast_id: {
//         fid: number;
//         hash: string;
//     };
//     cast: {
//         object: string;
//         hash: string;
//         author: {
//             object: string;
//             fid: number;
//             username: string;
//             display_name: string;
//             pfp_url: string;
//         };
//         thread_hash: string;
//         parent_hash: string | null;
//         parent_url: string;
//         root_parent_url: string;
//         parent_author: {
//             fid: number | null;
//         };
//         text: string;
//         timestamp: string;
//         embeds: {
//             url: string;
//             metadata: {
//                 content_type: string;
//                 content_length: number | null;
//                 _status: string;
//                 html: {
//                     favicon: string;
//                     ogImage: { url: string }[];
//                     ogTitle: string;
//                     ogLocale: string;
//                     ogDescription: string;
//                 };
//             };
//         }[];
//         channel: {
//             object: string;
//             id: string;
//             name: string;
//             image_url: string;
//             viewer_context: {
//                 following: boolean;
//             };
//         };
//     };
// };

// // fetch conversation history last messages
// interface ConversationMessage {
//     object: string;
//     hash: string;
//     author: Author;
//     text: string;
//     timestamp: string;
// }
// interface Author {
//     object: string;
//     fid: number;
//     username: string;
//     display_name: string;
//     pfp_url: string;
// }