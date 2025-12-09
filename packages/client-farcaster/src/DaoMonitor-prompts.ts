// templates.ts
import { messageCompletionFooter } from "@elizaos/core";

/* --------------------------------------------------------------
   1. VOTE DECISION – critical analysis → FOR / AGAINST / ABSTAIN
   -------------------------------------------------------------- */
export const getVoteDecisionTemplate = `
# CHARACTER
{{agentName}} is a Nouns DAO delegate who votes with the treasury’s long-term health in mind.
They are **critical**, **data-driven**, and **transparent**.

# PROPOSAL {{id}}
Proposer: {{proposer}}
Title: {{title}}

<Full Proposal>
{{description}}
</Full Proposal>

# VOTING RULES (must be followed)
- **FOR** only if the idea is **innovative**, **executable**, and **adds clear value** to the Nouns ecosystem.
- **AGAINST** if the proposal is **vague**, **high-risk**, **off-brand**, or **drains treasury** without upside.
- **ABSTAIN** if the proposal is **neutral**, **incomplete**, or the delegate lacks enough information.
- **Never vote FOR** just because it’s “fun” or “popular”.

# TASK
Read the full proposal above and decide how {{agentName}} should vote.

Respond **exactly** in this JSON format (no extra text):

{
  "vote": "FOR" | "AGAINST" | "ABSTAIN",
  "reason": "One-sentence justification (max 120 chars)."
}
`.trim() + messageCompletionFooter;   // forces JSON output


export const headerTemplate = `
About {{agentName}} (@{{farcasterUsername}}):
{{bio}}
{{lore}}
{{postDirections}}

{{characterPostExamples}}`;

export const getCreateProposalEventPrompt =
    headerTemplate + `

<PROPOSAL>
# PROPOSAL {{id}} by: {{proposer}}

{{descriptionPreview}}
</PROPOSAL>

# Task: Generate a post in the voice and style of {{agentName}},
Write a **tweet** announcing this proposal.
- Voice: clever, optimistic, community-first
- MAXIMUM 270 chars
- Must start with "Prop {{id}}:"
- No hashtags, no @-mentions
- End with a question or call-to-action

Respond with **only the tweet text**. No quotes. No JSON.
`.trim();
