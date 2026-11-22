# Intigriti Researcher MCP

![Intigriti Researcher MCP for Codex: programs, inbox status, report drafts and payouts.](banner.png)

Ask Codex about your Intigriti bug bounty work in plain language. **You approve draft edits and uploads. Only you submit the report.**

| Feature | What you can do |
| --- | --- |
| **Programs** | Find programs and bounty ranges. Check activity and compare scope or rules across versions. |
| **Inbox** | Get report status by title or ID. List reports or count them by state, including Pending, Triage and Draft. |
| **Drafts** | Turn notes into a draft, add evidence to an existing one, and verify what was saved. |
| **Payouts** | Check personal payout amounts, currencies, dates and payment status. |

## Connect to Codex

1. Choose **Code → Download ZIP** on GitHub. Extract it and open the folder containing this README as a trusted project in Codex.
2. Ask Codex: **“Set up this Intigriti tool for me.”** With [Node.js 22 or newer](https://nodejs.org/en/download) and npm installed, the setup commands are:

   ```sh
   npm ci
   npm run setup:codex
   ```

3. Sign in to Intigriti in your browser. Start a new chat in the same project and ask **“How many of my reports are pending or in triage?”**

**Inbox and drafts** use Codex’s connected Chrome or Computer control. Inbox checks stay on the list. Counts come from portal filters. Submission dates and comment previews are available only when the list labels them. For a draft, provide the program or draft link, review the text and files, then approve saving.

**Programs and payouts** use a researcher token. Save it as `INTIGRITI_API_TOKEN` in the project’s local `.env` file and start a new chat. [Create a token](https://app.intigriti.com/researcher/personal-access-tokens)

Draft snapshots are stored in plain text under `~/.intigriti-researcher-mcp/drafts`. Information used to answer your request enters the chat.

## Testing

Run `npm test` and `npm run test:draft` for offline checks. Live Windows tests used fresh Codex chats to check inbox statuses and reopen drafts to verify synthetic attachments.

[All nine tools, limitations and future improvements](https://github.com/bunny0417/intigriti-researcher-mcp/blob/v1.2.0/README.md#available-tools) · [Release notes](https://github.com/bunny0417/intigriti-researcher-mcp/releases/tag/v1.2.0) · [MIT license](LICENSE)
