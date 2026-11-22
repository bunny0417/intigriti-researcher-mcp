# Intigriti Researcher MCP

![An AI brain controls a robotic MCP arm holding a program record](banner.png)

**v1.0.0 · Tested and supported on Codex only.** A local, read-only MCP server for browsing Intigriti programs, reviewing rule changes, and checking your payouts.

## Connect to Codex

1. Install Node.js 22 or newer and npm. Clone the repository and install the server.

   ```sh
   git clone https://github.com/bunny0417/intigriti-researcher-mcp.git
   cd intigriti-researcher-mcp
   npm ci
   npm run setup:codex
   ```

   Setup creates a local `.env` and configures `.codex/config.toml`. If setup reports an existing config, merge the section it prints into that file.

2. Sign in to your Intigriti researcher account, create a personal access token (PAT) with an expiry, and copy it when it appears. [Create a researcher token](https://app.intigriti.com/researcher/personal-access-tokens)

3. Open the project’s `.env` in a local editor, paste the token after the equals sign, and save the file. Git ignores this file.

   ```dotenv
   INTIGRITI_API_TOKEN=
   ```

4. Open the repository as a **trusted project** in Codex. If it’s already open, restart Codex to load the configuration. Try this prompt in a new chat.

   > Use Intigriti to show five open programs and their bounty ranges, including the currency.

## Available tools

| Tool | What it returns |
| --- | --- |
| `list_programs` | Program names, status, following state, bounty ranges and platform links |
| `get_program` | Current rules, version IDs and scope counts grouped by asset type and tier |
| `list_program_activity` | Changes for one program, including version IDs when available |
| `get_scope_version` | Scope counts by asset type and tier for a specific version |
| `get_rules_version` | Rules text, testing requirements and safe harbour status for a specific version |
| `list_payouts` | Your payout amounts, currencies, statuses and dates |

For a complete list, continue from `nextOffset` until it is `null`. A filtered page can be empty and still have a continuation.

## Privacy

By default, the server returns only programs marked Public. If a company permits sharing its restricted program data with your Codex environment, add its program GUID to the comma-separated `INTIGRITI_ALLOWED_PROGRAM_IDS` setting in `.env` and restart Codex. Tool results enter the chat, including personal payout details when you request them. [Intigriti researcher terms](https://kb.intigriti.com/en/articles/5466165-researcher-terms-conditions)

## Tests and license

Run `npm test` for the offline suite. With a researcher PAT configured, `npm run test:live` exercises all six tools against the live API, including personal payouts.

Licensed under the [MIT License](LICENSE).
