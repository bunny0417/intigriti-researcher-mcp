// Opt-in authenticated acceptance test. All tool calls use the shipped stdio entry point.
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const names = [
  "get_program", "get_rules_version", "get_scope_version",
  "list_payouts", "list_program_activity", "list_programs",
];
const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const rounds = 10;
const coverage = { activityRow: false, payoutRow: false, followedContinuation: false };

// Fixed diagnostic messages keep account data out of assertion output.
function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  const data = result.structuredContent;
  check(data && isDeepStrictEqual(data, JSON.parse(result.content[0].text)), `${name}: MCP representations differ`);
  return data;
}

function checkPage(page, offset, limit) {
  check(Array.isArray(page.records) && page.records.length <= limit, "Page size is invalid");
  if (page.nextOffset !== null) {
    check(Number.isInteger(page.nextOffset) && page.nextOffset > offset && page.nextOffset <= offset + limit,
      "Continuation did not advance within the requested window");
  }
}

async function selectPrograms(client) {
  const candidates = [];
  let offset = 0;
  do {
    const page = await call(client, "list_programs", { statusId: 3, limit: 20, offset });
    checkPage(page, offset, 20);
    for (const card of page.records) {
      check(card.confidentialityLevel.id === 4 && card.status.id === 3, "Seed catalog returned an unexpected visibility or status");
      const response = await client.callTool({ name: "get_program", arguments: { programId: card.id } });
      // Open programs can still require accepting updated terms in the platform.
      if (response.isError && response.content[0]?.text.startsWith("Intigriti denied access.")) continue;
      check(!response.isError, "Could not read a public program during sample selection");
      const detail = response.structuredContent;
      if (detail.domains?.content && detail.rulesOfEngagement?.content) candidates.push(card);
      if (candidates.length === 3) break;
    }
    offset = page.nextOffset;
  } while (candidates.length < 3 && offset !== null && offset < 60);
  check(candidates.length > 0, "Need an accessible public program with a scope and rules version for this test");
  return candidates;
}

function checkCards(catalog, filters) {
  checkPage(catalog, filters.offset, filters.limit);
  for (const p of catalog.records) {
    check(p.status.id === filters.statusId && p.confidentialityLevel.id === 4, "Catalog status or visibility mismatch");
    check(filters.typeId === undefined || p.type.id === filters.typeId, "Program type filter mismatch");
    check(filters.following === undefined || p.following === filters.following, "Program following filter mismatch");
  }
}

async function runRound(client, round, samples) {
  const card = samples[(round - 1) % samples.length];
  const programId = round % 2 ? card.id : card.id.toUpperCase();
  const limit = [1, 5, 20, 50, 100][(round - 1) % 5];
  const offset = round % 3;
  const filters = { statusId: round === 8 ? 4 : round === 9 ? 5 : 3, limit, offset };
  if (round % 2 === 0) filters.typeId = round === 4 ? 2 : card.type.id;
  if (round % 3 === 0) filters.following = round % 2 === 0;
  const catalog = await call(client, "list_programs", filters);
  checkCards(catalog, filters);
  if (catalog.nextOffset !== null && round % 2 === 1) {
    const next = { ...filters, offset: catalog.nextOffset };
    checkCards(await call(client, "list_programs", next), next);
    coverage.followedContinuation = true;
  }

  const detail = await call(client, "get_program", { programId });
  check(detail.id === card.id && detail.name === card.name && detail.webLinks.detail === card.webLinks.detail,
    "Program identity or link differed between catalog and detail");
  const scope = await call(client, "get_scope_version", { programId, versionId: detail.domains.id });
  check(isDeepStrictEqual(detail.domains, scope), "Scope differs between the detail and saved version");
  check(scope.content.groups.reduce((n, group) => n + group.count, 0) === scope.content.total,
    "Scope group counts do not add up");
  const rules = await call(client, "get_rules_version", { programId, versionId: detail.rulesOfEngagement.id });
  check(isDeepStrictEqual(detail.rulesOfEngagement, rules), "Rules differ between the detail and saved version");

  const since = Math.floor(Date.now() / 1000) - 365 * 86400;
  const activities = { programId, limit: 100, offset };
  if (round % 2 === 0) activities.createdSince = since;
  if (round % 3 === 0) activities.following = card.following;
  const changes = await call(client, "list_program_activity", activities);
  checkPage(changes, offset, 100);
  for (const event of changes.records) {
    check(event.programId === card.id, "Activity returned a different program");
    check(activities.createdSince === undefined || event.createdAt >= since, "Activity date filter mismatch");
    check(activities.following === undefined || event.following === activities.following, "Activity following filter mismatch");
    coverage.activityRow = true;
  }

  const payoutArgs = { limit: 1, offset: 0 };
  if (round % 3 === 0) payoutArgs.paidSince = since;
  if (round % 3 === 1) payoutArgs.createdSince = since;
  const payouts = await call(client, "list_payouts", payoutArgs);
  checkPage(payouts, 0, 1);
  for (const p of payouts.records) {
    check(typeof p.amount.value === "number" && typeof p.amount.currency === "string", "Invalid payout amount or currency");
    check(payoutArgs.createdSince === undefined || p.createdAt >= since, "Payout creation filter mismatch");
    check(payoutArgs.paidSince === undefined || (p.paidAt !== null && p.paidAt >= since), "Payout payment filter mismatch");
    // Use a real upstream status; the researcher contract defines it as an integer.
    const filtered = await call(client, "list_payouts", { limit: 1, statusId: p.status.id });
    check(filtered.records.length === 1 && filtered.records[0].status.id === p.status.id, "Payout status filter mismatch");
    coverage.payoutRow = true;
  }
}

let samples;
try {
  for (let round = 1; round <= rounds; round++) {
    const client = new Client({ name: "intigriti-live-acceptance", version: "1" });
    const env = { INTIGRITI_ALLOWED_PROGRAM_IDS: "" };
    if (process.env.INTIGRITI_API_TOKEN !== undefined) env.INTIGRITI_API_TOKEN = process.env.INTIGRITI_API_TOKEN;
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env }));
      const { tools } = await client.listTools();
      check(isDeepStrictEqual(tools.map(t => t.name).sort(), names), "Unexpected tool catalog");
      check(tools.every(t => t.annotations?.readOnlyHint === true), "Missing read-only annotation");
      samples ??= await selectPrograms(client);
      await runRound(client, round, samples);
      console.log(`Round ${round}/${rounds} passed: fresh stdio connection and all six live tools.`);
    } finally {
      await client.close();
    }
  }
  console.log(`Live data encountered: ${JSON.stringify(coverage)}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
