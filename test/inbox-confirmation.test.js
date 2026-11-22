import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.js";

const inboxUrl = "https://app.intigriti.com/researcher/inbox";
const scope = { programs: "All", search: "", otherFilters: [] };
const count = { statuses: ["Pending"], countsObservation: {
  inboxUrl, menuStatuses: ["Pending"], scope,
  beforeCounter: "23 of 23 items shown", afterCounter: "23 of 23 items shown",
  readings: [{ selectedStatuses: ["Pending"], counter: "7 of 23 items shown" }],
} };
const row = { title: "Synthetic title", status: "Pending", position: 1 };
const lookup = { report: row.title, lookupObservation: {
  inboxUrl: inboxUrl + "?search=" + encodeURIComponent(row.title), search: row.title,
  scope: { programs: "All", otherFilters: [] }, counter: "1 of 23 items shown", examined: 1, matches: [row],
} };
const list = { listStatus: "Pending", listObservation: {
  inboxUrl: inboxUrl + "?st=pending", scope, selectedStatuses: ["Pending"], counter: "1 of 23 items shown", rows: [row],
} };
const accepted = { action: "accept", content: { confirmed: true } };

async function connect(t, reply) {
  const prompts = [];
  const client = new Client({ name: "inbox-review-test", version: "1" },
    { capabilities: reply ? { elicitation: { form: {} } } : {} });
  if (reply) client.setRequestHandler(ElicitRequestSchema, req => {
    prompts.push(req.params);
    return reply(prompts.length);
  });
  const server = createServer({});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  t.after(() => client.close());
  return { prompts, call: (name, args) => client.callTool({ name, arguments: args }) };
}

test("the MCP obtains a fresh researcher confirmation for counts, title search and status list", async t => {
  const { prompts, call } = await connect(t, () => accepted);
  for (const [name, args, status] of [
    ["get_inbox_counts", count, "counts_read"], ["get_inbox_reports", lookup, "report_found"],
    ["get_inbox_reports", list, "reports_listed"], ["get_inbox_counts", count, "counts_read"],
  ]) {
    const previous = prompts.length;
    const result = await call(name, args);
    assert.equal(result.structuredContent?.status, status, result.content[0].text);
    assert.equal(result.structuredContent.source, "researcher_confirmed_inbox_list");
    assert.equal(prompts.length, previous + 1);
    assert.match(prompts.at(-1).message, /Compare these values with your current signed-in Intigriti inbox list/);
    assert.match(prompts.at(-1).message, /Pending/);
    assert.match(prompts.at(-1).message, name === "get_inbox_counts" ? /7/ : /Synthetic title/);
  }
});

test("client observations alone cannot claim a browser result when host form is unavailable", async t => {
  const { call } = await connect(t);
  for (const args of [count, lookup, list]) {
    const result = await call(args === count ? "get_inbox_counts" : "get_inbox_reports", args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.doesNotMatch(result.content[0].text, /Synthetic title|counts_read|report_found|reports_listed/);
  }
});

test("decline, cancel and unchecked accept yield no counts and cannot be replayed as confirmed", async t => {
  for (const response of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { confirmed: false } }]) {
    const { call } = await connect(t, () => response);
    const result = await call("get_inbox_counts", count);
    assert.equal(result.structuredContent.status, "inbox_unconfirmed");
    assert.equal(result.structuredContent.totalReports, undefined);
    assert.equal(result.structuredContent.source, undefined);
    const forged = await call("get_inbox_counts", { ...count, confirmed: true, source: "researcher_confirmed_inbox_list" });
    assert.equal(forged.isError, true);
  }
});

test("long lists require every page; a declined page withholds all rows", async t => {
  const { call, prompts } = await connect(t, page => page === 2 ? { action: "decline" } : accepted);
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...row, title: "Synthetic row " + i, position: i + 1,
    lastCommentPreview: { label: "Last comment", value: "safe".repeat(495) + "\u202e<end>" } }));
  const result = await call("get_inbox_reports", { ...list, listObservation: {
    ...list.listObservation, rows, counter: "5 of 23 items shown",
  } });
  assert.equal(prompts.length, 2);
  assert.equal(result.structuredContent?.status, "inbox_unconfirmed");
  assert.equal(result.structuredContent.reports, undefined);
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt.message, /\u202e|<end>/);
    assert.match(prompt.message, /Synthetic row/);
  }
});

test("initial requests and malformed row metadata never elicit a form", async t => {
  const { call, prompts } = await connect(t, () => accepted);
  const start = await call("get_inbox_reports", { listStatus: "Pending" });
  assert.equal(start.structuredContent.status, "awaiting_inbox_read");
  assert.equal(start.structuredContent.observationFields.rows[0].url, undefined);
  const malformed = await call("get_inbox_reports", { ...list, listObservation: {
    ...list.listObservation, rows: [{ ...row, url: inboxUrl + "/submissions/QA-1234" }],
  } });
  assert.equal(malformed.isError, true);
  assert.equal(prompts.length, 0);
});
