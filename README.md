# Intigriti Researcher MCP

![Intigriti Researcher MCP for Codex. Programs cover scope, rules and activity. Inbox shows report status and counts for Pending, Triage, Draft and more. Drafts attach evidence for you to submit. Payouts show amounts and payment status. An AI brain controls a robotic MCP arm.](banner.png)

**v1.2.0 · Codex only.** Check your inbox status counts, look up a report, browse programs, compare rules and scope changes, check payouts, and prepare researcher report drafts.

**Before saving or uploading to Intigriti, sign in and approve the destination, fields and exact files in chat.** Codex uses its connected **@Chrome** control in your signed-in browser, with **@Computer** as a fallback where available. You handle sign-in and 2FA in that browser. You control final review and submission.

Use your browser's existing settings. If an available control can open the picker but cannot select a file, select the approved file yourself. Codex checks the saved attachment afterward. Developer mode and remote debugging are unnecessary.

## Connect to Codex

1. On GitHub, choose **Code → Download ZIP**. Extract the ZIP. Open the extracted folder containing this README and `package.json` as a project in Codex. Trust the project when Codex asks, after checking that it is the repository you intended to download.

2. Paste this into a chat in that project:

   > Please set up the Intigriti tool in this folder for me. Check for Node.js 22 or newer, then run the two setup commands in the README. Tell me when I can start a practice draft.

   If Codex tells you Node.js is missing, install Node.js 22 or newer with npm, reopen Codex, and repeat the request. [Download Node.js](https://nodejs.org/en/download)

   The commands Codex runs in the extracted folder are:

   ```sh
   npm ci
   npm run setup:codex
   ```

   Setup creates a local `.env` and configures `.codex/config.toml`. If setup finds an existing configuration, ask Codex to merge the Intigriti entry it printed.

3. Sign in to Intigriti in your browser. Start a **new chat in the same Codex project** and try:

   > Help me make a practice report on Intigriti. Show me what you’ll save before you do anything on the website.

   Drafting uses your browser sign-in. If the new chat cannot find the Intigriti tool, restart Codex and reopen the trusted project. Start a new project chat after updating this tool, too.

**Optional account lookups.** To list programs or check payouts through the API, create a personal access token. Open the `.env` file in the extracted folder, paste the token after `INTIGRITI_API_TOKEN=`, save, and start a new project chat. Keep the token in that local file. [Create a researcher token](https://app.intigriti.com/researcher/personal-access-tokens)

## Available tools

| Tool | What it returns |
| --- | --- |
| `list_programs` | Program status, following state, bounty ranges and platform links |
| `get_program` | Current rules, version IDs and scope counts by asset type and tier |
| `list_program_activity` | Changes for one program, with version IDs where available |
| `get_scope_version` | Scope counts for a specific version |
| `get_rules_version` | Rules text, testing requirements and safe harbour status for a specific version |
| `list_payouts` | Personal payout amounts, currencies, statuses and dates |
| `get_inbox_counts` | Live inbox totals for all statuses or just the ones you ask about, such as Pending, Triage and Draft |
| `get_inbox_reports` | Current report status by title or submission reference, or a list of reports in one status |
| `prepare_report_draft` | A local report package or a browser handoff that Codex carries out using its built-in controls |

For paginated API lookups, continue from `nextOffset` until it is `null`. A filtered page can be empty and still have a continuation.

## Check your inbox

Look up a report’s current status by title, or get counts for Pending, Triage, Draft and other inbox states. Sign in to Intigriti in your browser and ask Codex in ordinary language:

> How many reports are pending or in triage? How many are drafts?

> Which of my reports are pending? Show me the first five titles.

> What is the status of my report titled “My practice report”?

If a chat says the connector has no inbox feature, check that Codex has connected to this checkout and start a fresh project chat. A tool run for counts uses `get_inbox_counts`; a title check uses `get_inbox_reports`. Each reads the browser result back into the same tool before answering. A browser-only answer does not verify the MCP connection.

Codex uses the connected Chrome or Computer control to read the **inbox list**. This workflow needs no PAT or draft approval. For counts, it clears the search and filters in a separate tab, reads the portal's “X of Y items shown” counter, then checks one status filter at a time. **Open** includes **Triage** and **Pending**. **Closed / Archived** includes several outcomes. The displayed inbox total is the denominator. Adding group counts to their child counts would double-count reports.

For a report lookup, Codex uses the list search and leaves every result unopened. It can show the title, status and number of matching results. A submission date or latest comment preview is returned only when explicitly labeled on the list. The observed row timestamp was **last updated**, and the inspected row had no comment preview. Missing fields are reported as unavailable. Report bodies, attachments and message histories stay outside the lookup. The MCP validates the browser's observations in memory; it keeps no inbox history. Metadata used to answer your question enters the Codex chat.

**How we checked this.** In a fresh Codex chat we asked for Pending and Triage counts, then for the status of one report by title. The tool trace showed a separate inbox tab, status filters, a list search and a readback to the MCP for each answer. No report detail page was opened. Automated tests cover grouped statuses, zero results, changed totals, duplicate titles, incomplete searches and the fields allowed in a result.

## Draft a report

1. Say **“Draft an Intigriti report.”** Codex asks which program you want. Paste the program link or an existing draft link.

   Codex drafts from the verified finding you already discussed. Otherwise, point it to your finding notes and PoC files. If several findings fit, choose one. Include how AI helped prepare the report.

2. Sign in and give explicit permission for that draft and its listed files. Codex then opens the program’s **Create submission** page or reopens the identified draft. The same program can reopen an existing draft, so Codex checks its identity before entering text.
3. Codex fills the approved fields, uploads selected evidence, and reopens the draft to check the saved fields and attachment rows. Its handoff distinguishes verified changes from anything still pending. Open the returned draft link for final review and submit it yourself when ready.

You can prepare a private local package and resume using its returned `draftId`. To inspect an existing draft, give Codex its exact link. Deletion requires a separate request for the specific live draft and confirmation at the platform’s destructive dialog.

Use ordinary requests such as “check the draft status” or “cancel the handoff.” Codex shows the complete evidence paths before obtaining your explicit approval in chat. A review ID identifies the request and is not evidence of a human decision.

To add evidence to an existing draft, paste its edit link and the paths of the files you want to attach. You can also give the existing title for Codex to check in the browser. This review covers only those files and requires no copy of the report text.

If your file is in Downloads, say “Attach the file called practice note.txt in my Downloads.” Check its name and location in the review. For a file in a different folder on Windows, right-click it in File Explorer, choose **Copy as path**, and paste that into the chat.

Before editing or uploading, Codex checks the current handoff, program and draft identity. Status, cancellation and browser-reported results are shared across local sessions. To take over a handoff from another session, inspect the live draft, cancel the old handoff and approve a fresh review. Cancelling stops future authorized steps; check Intigriti for edits or uploads already in progress.

## Privacy

Program lookups return Public programs by default. If the company permits sharing a restricted program with your Codex environment, add its GUID to the comma-separated `INTIGRITI_ALLOWED_PROGRAM_IDS` setting in `.env` and restart Codex. [Researcher terms](https://kb.intigriti.com/en/articles/5466165-researcher-terms-conditions)

The MCP stores plain-text snapshots and handoff records under `~/.intigriti-researcher-mcp/drafts`. Snapshots contain report text, evidence paths and file metadata. New snapshots also record a SHA-256 digest so the MCP can distinguish a file picker changing metadata from an edit to the file's contents. Handoff records contain local state and browser-reported outcomes. Evidence files stay at the paths you selected. Report inputs, tool results and requested payout details enter the Codex conversation. [Reporting and attachment limits](https://kb.intigriti.com/en/articles/5379086-how-to-write-and-submit-a-good-report)

## How we tested drafting

We used fresh Codex chats running GPT-6.1 Terra, a signed-in Windows browser, and synthetic text files. In a simulated first-time researcher session, the user described a practice report, pasted a program link, named a file in Downloads, and approved the review in ordinary chat. Codex created the draft and returned its link. In a follow-up chat it added a second file, reopened the same draft, and verified both attachment rows. We also ran setup in a clean copy with a blank token file. These were separate tests on a machine that already had Node.js and an authenticated browser.

| Scenario | Observed result |
| --- | --- |
| Wrong draft title | The title check rejected the mismatch before any edit or upload. |
| File edited after review | A change with the same filename, size and modification time ended the approval. Restoring the original bytes did not revive it. |
| Successful upload retried | Codex recovered the saved receipt. Reopening the draft showed one row for that file. |
| Different evidence with the same name and size | Codex preserved the existing file and recorded the new one as pending. |
| Portal disabled **Add attachments** | Codex left the existing attachments in place and reported the requested files as pending. |

To repeat the automated checks after installation, run `npm test` for regression coverage and `npm run test:draft` for ten offline draft scenarios. The offline checks start the shipped MCP server with isolated profiles and synthetic evidence. They need neither a PAT nor a browser. The separate `npm run test:live` command uses your PAT to check the six account lookups, including payouts.

## Current limitations

- **Browser access.** Local preparation works on its own. Saving on Intigriti requires a supported Codex browser or computer control, an interactive sign-in and a draft the account can edit. Browser or portal changes can interrupt the flow. If the file picker needs your input, select the reviewed file there.
- **Verification.** A saved receipt records what Codex observed after reopening the draft. A partial receipt lists what it could verify and what is still pending. Filename and size alone cannot identify the contents of an existing remote attachment. A local SHA-256 digest checks the local file.
- **Files and platforms.** The Downloads shortcut resolves a named file in the standard Downloads folder under your home directory. For a relocated folder, supply the full path. Automated tests cover Windows and Linux; the live browser results above are from Windows. Account lookups and browser sign-in use separate credentials.
- **Final review.** Check the report text, selected program, required fields and evidence in the portal before deciding whether to submit. Cancelling a handoff stops future authorized steps. Edits or uploads already in progress may have reached the portal.

## Possible future improvements

- Add a setup check that distinguishes a missing MCP connection, a missing PAT for account lookups and unavailable browser controls.
- Expand live testing to macOS, Linux desktops, relocated Downloads folders and more file-picker configurations.
- Show a clearer recovery view for interrupted uploads, with the verified and pending files side by side before a retry.

## License

Licensed under the [MIT License](LICENSE).
