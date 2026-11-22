// Optional integration test. Requires a local Codex CLI with app-server support.
// The simulated frontend answers test forms. No model turn or browser is started.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const payout = { id: "OFFLINE", amount: { value: 12, currency: "EUR" }, status: { id: 1, value: "Pending" }, createdAt: 1, paidAt: null };
const programId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000002";
const domains = { id: versionId, createdAt: 1, content: [] };
const rulesOfEngagement = { id: versionId, createdAt: 1, content: {
  description: "Offline rules", safeHarbour: true,
  testingRequirements: { intigritiMe: false, automatedTooling: null, userAgent: null, requestHeader: null },
} };
const program = { id: programId, name: "Offline program", handle: "example", following: true,
  confidentialityLevel: { id: 4, value: "Public" }, status: { id: 3, value: "Open" }, type: { id: 1, value: "Bug bounty" },
  industry: null, webLinks: { detail: "https://app.intigriti.com/programs/fixture/example/detail" },
  domains, rulesOfEngagement, minBounty: payout.amount, maxBounty: payout.amount };
const activity = { programId, type: { id: 1, value: "Scope change" }, following: true, createdAt: 2, activity: { toVersionId: versionId } };
const page = row => ({ records: [row], maxCount: 1 });
const fixtures = { programs: page(program), ["programs/" + programId]: program, "programs/activities": page(activity),
  ["programs/" + programId + "/domains/" + versionId]: { domains },
  ["programs/" + programId + "/rules-of-engagements/" + versionId]: { rulesOfEngagement }, payouts: page(payout) };
const offlineGuard = "data:text/javascript," + encodeURIComponent(`
  import assert from 'node:assert/strict';
  import { Socket } from 'node:net';
  import { homedir } from 'node:os';
  assert.equal(homedir(), process.env.INTIGRITI_FIXTURE_PROFILE);
  assert.equal(process.env.INTIGRITI_API_TOKEN, 'offline-fixture');
  Socket.prototype.connect = () => { throw Error('Offline test'); };
  const routes = ${JSON.stringify(fixtures)};
  globalThis.fetch = async (url, options) => {
    assert.equal(url.origin, 'https://api.intigriti.com');
    const base = '/external/researcher/v1/';
    assert.ok(url.pathname.startsWith(base));
    const route = url.pathname.slice(base.length);
    assert.ok(Object.hasOwn(routes, route));
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer offline-fixture');
    return Response.json(routes[route]);
  };
`);

async function round(profile, n) {
  const cwd = path.join(profile, "project");
  await mkdir(cwd);
  const env = { CODEX_HOME: profile, USERPROFILE: profile, HOME: profile, TMP: profile, TEMP: profile,
    APPDATA: profile, LOCALAPPDATA: profile, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" };
  for (const key of ["SystemRoot", "WINDIR", "PATH", "COMSPEC", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawn(process.platform === "win32" ? "codex.exe" : "codex",
    ["app-server", "--stdio", "-c", "analytics.enabled=false"], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  const requests = new Map();
  let nextId = 0;
  let expectedForm;
  let formCount = 0;
  const send = packet => child.stdin.write(JSON.stringify(packet) + "\n");
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      requests.set(id, { resolve, reject });
      send({ id, method, params });
    });
  }
  function fail(error) {
    for (const item of requests.values()) item.reject(error);
    requests.clear();
  }
  child.once("error", fail);
  child.once("close", () => fail(new Error("Codex app-server stopped.")));
  child.stdin.on("error", fail);
  createInterface({ input: child.stdout }).on("line", line => {
    try {
      const packet = JSON.parse(line);
      if (packet.id === undefined) return;
      if (packet.method) {
        assert.equal(packet.method, "mcpServer/elicitation/request");
        assert.equal(packet.params.serverName, "fixture");
        assert.equal(packet.params.mode, "form");
        assert.equal(packet.params.requestedSchema.properties.confirmed.type, "boolean");
        assert.ok(expectedForm && packet.params.message.includes(expectedForm.text));
        const { action } = expectedForm;
        expectedForm = undefined;
        formCount++;
        send({ id: packet.id, result: { action, content: action === "accept" ? { confirmed: true } : null, _meta: null } });
        return;
      }
      const pending = requests.get(packet.id);
      if (!pending) return;
      requests.delete(packet.id);
      if (packet.error) pending.reject(new Error(packet.error.message));
      else pending.resolve(packet.result);
    } catch (error) { fail(error); }
  });
  const timer = setTimeout(() => fail(new Error("Codex host check timed out.")), 60000);
  try {
    await request("initialize", { clientInfo: { name: "intigriti_qa", title: "Offline QA", version: "1" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized" });
    const settings = { command: process.execPath, args: ["--import", offlineGuard, entry], env: {
      USERPROFILE: profile, HOME: profile, INTIGRITI_FIXTURE_PROFILE: profile, INTIGRITI_API_TOKEN: "offline-fixture", INTIGRITI_ALLOWED_PROGRAM_IDS: "",
    } };
    const { thread } = await request("thread/start", { ephemeral: true, cwd, approvalPolicy: "on-request", sandbox: "read-only",
      config: { mcp_servers: { fixture: settings } } });
    const call = (tool, args) => request("mcpServer/tool/call", { threadId: thread.id, server: "fixture", tool, arguments: args });
    const read = async (tool, args) => {
      const reply = await call(tool, args);
      assert.ok(!reply.isError, tool + " failed");
      return reply.structuredContent;
    };
    assert.deepEqual((await read("list_programs", { following: true })).records.map(row => row.id), [programId]);
    assert.equal((await read("get_program", { programId })).rulesOfEngagement.content.description, "Offline rules");
    assert.deepEqual((await read("list_program_activity", { programId })).records.map(row => row.activity.toVersionId), [versionId]);
    assert.equal((await read("get_scope_version", { programId, versionId })).content.total, 0);
    assert.equal((await read("get_rules_version", { programId, versionId })).content.safeHarbour, true);
    const draft = { programUrl: "https://app.intigriti.com/programs/fixture/example/detail", title: "Host QA " + n, description: "Offline fixture." };
    const counter = n + " of " + n + " items shown";
    const counts = { statuses: [], countsObservation: { inboxUrl: "https://app.intigriti.com/researcher/inbox",
      scope: { programs: "All", search: "", otherFilters: [] }, beforeCounter: counter, afterCounter: counter, readings: [] } };
    const title = "Offline report " + n;
    const inboxUrl = counts.countsObservation.inboxUrl;
    const lookup = { report: title, lookupObservation: {
      inboxUrl: inboxUrl + "?search=" + encodeURIComponent(title), search: title, scope: { programs: "All", otherFilters: [] },
      counter: "1 of " + n + " items shown", examined: 1, matches: [{ position: 1, title, status: "Pending" }],
    } };
    assert.equal((await read("get_inbox_reports", { report: title })).openUrl, inboxUrl);
    for (const action of ["decline", "accept"]) {
      const review = (await call("prepare_report_draft", draft)).structuredContent;
      assert.equal(review.status, "awaiting_approval");
      expectedForm = { text: draft.title, action };
      const grant = (await call("prepare_report_draft", review.requestConfirmation)).structuredContent;
      assert.equal(grant.status, action === "accept" ? "ready_for_browser" : "cancelled");
      assert.equal(Boolean(grant.handoffId), action === "accept");
      if (grant.handoffId) assert.equal((await call("prepare_report_draft", grant.onDecline)).structuredContent.status, "cancelled");
      expectedForm = { text: "totalReports", action };
      const inbox = (await call("get_inbox_counts", counts)).structuredContent;
      assert.equal(inbox.status, action === "accept" ? "counts_read" : "inbox_unconfirmed");
      assert.equal(inbox.totalReports, action === "accept" ? n : undefined);
      expectedForm = { text: title, action };
      const report = await read("get_inbox_reports", lookup);
      assert.equal(report.status, action === "accept" ? "report_found" : "inbox_unconfirmed");
      assert.deepEqual(report.report, action === "accept" ? { title, status: "Pending", submittedAt: null, lastCommentPreview: null } : undefined);
      expectedForm = { text: "payout", action };
      const earnings = await call("list_payouts", { limit: 1 });
      if (action === "accept") assert.deepEqual(earnings.structuredContent.records, [payout]);
      else {
        assert.equal(earnings.isError, true);
        assert.match(earnings.content[0].text, /declined/);
        assert.equal(earnings.structuredContent, undefined);
      }
    }
    assert.equal(formCount, 8);
    console.log("Codex host round " + n + "/5 passed all nine tools and eight native form decisions.");
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
    await closed;
  }
}

const parent = await realpath(tmpdir());
for (let n = 1; n <= 5; n++) {
  const profile = await mkdtemp(path.join(parent, "intigriti-host-smoke-"));
  assert.equal(path.dirname(profile), parent);
  try { await round(profile, n); }
  finally { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
