# Two-Stage Should Respond System for Farcaster

## 1. Overview

Currently, the system uses a single `shouldRespondTemplate` to decide whether to respond to a message, combining both spam/security and engagement/context checks. To better combat spam, we will split this into two sequential checks:

- **Stage 1: Security/Spam Filter**
  - Uses a new template focused only on spam and security risks.
  - If the message is safe, proceed to Stage 2.
- **Stage 2: Engagement/Context Filter**
  - Uses a new template focused only on whether the message is interesting or relevant to the agent.
  - Only context/engagement is considered here.

---

## 2. Template Design

### A. Security/Spam Filter Template (`shouldRespondSecurityTemplate`)
- **Purpose:** Block messages that are spammy or pose a security risk.
- **Criteria:** Use the same as the current `shouldRespondTemplate` (lines 82–86 in `prompts.ts`), but focus only on spam/security.
- **Response:** `"PASS"` (safe) or `"BLOCK"` (spam/risk).

### B. Engagement/Context Filter Template (`shouldRespondEngagementTemplate`)
- **Purpose:** Decide if the agent should engage, assuming the message is already safe.
- **Criteria:** Use the non-security/contextual parts of the current template (lines 68–81, 87+).
- **Response:** `"RESPOND"`, `"IGNORE"`, or `"STOP"`.

---

## 3. Interaction Flow Update

### In `FarcasterInteractionManager.handleCast`:

1. **Run Security/Spam Filter**
   - Use `shouldRespondSecurityTemplate`.
   - If `"BLOCK"`, log and skip responding.
   - If `"PASS"`, continue.

2. **Run Engagement/Context Filter**
   - Use `shouldRespondEngagementTemplate`.
   - If `"IGNORE"` or `"STOP"`, skip responding.
   - If `"RESPOND"`, proceed to generate and send a reply.

---

## 4. Implementation Steps

1. **Add new templates** to `prompts.ts`:
   - `shouldRespondSecurityTemplate`
   - `shouldRespondEngagementTemplate`

2. **Refactor `handleCast`** in `interactions.ts`:
   - Insert the two-stage check as described above.
   - Ensure logging for both stages.

3. **Testing & Extensibility**
   - Make sure the new system is easy to extend with additional filters if needed.

---

## 5. Mermaid Diagram

```mermaid
flowchart TD
    A[Receive Cast] --> B{Security/Spam Filter}
    B -- BLOCK --> X[Do Not Respond (Log as Spam/Security)]
    B -- PASS --> C{Engagement/Context Filter}
    C -- IGNORE/STOP --> Y[Do Not Respond (Not Engaging)]
    C -- RESPOND --> D[Generate & Send Reply]
```

---

## 6. Notes

- The spam/security criteria will use the current logic as-is.
- This plan is designed to be extensible for future filter stages or template customization.