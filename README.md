# Intigriti Researcher MCP

![Intigriti Researcher MCP for Codex: programs, inbox status, report drafts and payouts.](banner.png)

**“Which of my reports are still in triage?”**

Ask Codex about your Intigriti inbox, or hand it your notes and evidence to prepare your next report. You review the draft, approve the files, and decide when to submit.

| Feature | Try asking Codex | What you get |
| --- | --- | --- |
| **Programs** | “Show me five open bounty programs.” | Bounty ranges, scope summaries, rules and recent changes. |
| **Inbox** | “How many reports are pending or in triage?” | Counts by status, or a single report’s status by title or ID. |
| **Drafts** | “Add this screenshot to my draft.” | A review of the destination and files, then a check of what was saved. |
| **Payouts** | “Which payouts are still pending?” | Amounts, currencies, dates and payment status. |

## Quick start

1. Choose **Code → Download ZIP** on GitHub. Extract it and open the folder containing this README as a trusted project in Codex.
2. Ask Codex: **“Set up this Intigriti tool for me.”** With [Node.js 22 or newer](https://nodejs.org/en/download) and npm installed, the setup commands are:

   ```sh
   npm ci
   npm run setup:codex
   ```

3. Sign in to Intigriti in your browser. Start a new Codex chat in the same project and try the inbox question above.

For programs and payouts, add a [researcher token](https://app.intigriti.com/researcher/personal-access-tokens) as `INTIGRITI_API_TOKEN` in the local `.env` after setup, then restart the connector. Rerunning setup secures the file and preserves your token.

## What you approve

- **Inbox reads.** Codex reads the signed-in list through Chrome or Computer. Compare the proposed values with the list before confirming them. Title searches and status lists omit report links. Dates and comment previews appear only when the list labels them.
- **Draft edits and uploads.** Review the program or draft link, text and files in the Codex form. The picker uses private, read-only copies. Codex reopens the draft to check the saved fields and filenames. Only you submit.
- **Payouts.** Each page of personal earnings requires a separate confirmation before Codex reads it.

Draft text is stored locally under `~/.intigriti-researcher-mcp/drafts` in plain text. Data used in an answer enters the chat. Interrupted picker copies expire and are cleaned up during a later attachment handoff. Hosts without confirmation forms support local previews and program browsing.

<details>
<summary>Developer checks</summary>

Run `npm test` for regressions, `npm run test:draft` for ten synthetic handoffs, and `npm run test:package` for five clean installs. With the Codex CLI installed, `node scripts/codex-host-smoke.js` exercises all nine tools in five fresh sessions. For live API checks, run `npm run test:live`. Add `-- --payouts` to approve real payout reads interactively.

</details>

[Release notes](https://github.com/bunny0417/intigriti-researcher-mcp/releases) · [MIT license](LICENSE)
