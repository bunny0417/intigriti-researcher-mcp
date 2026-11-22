import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ResearcherClient } from "./client.js";
import { createServer, parseAllowedIds } from "./server.js";
import { readSettings } from "./settings.js";

let allowedIds;
let settings;
try {
  settings = readSettings();
  allowedIds = parseAllowedIds(settings.allowedProgramIds);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const client = new ResearcherClient({ token: settings.token });
const server = createServer(client, allowedIds);
await server.connect(new StdioServerTransport());
