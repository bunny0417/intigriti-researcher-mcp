import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "draft-confirm-")));
  const file = path.join(home, "evidence.txt");
  await writeFile(file, "Example evidence");
  let prompts = 0;
  const clients = [];
  async function connect() {
    const client = new Client({ name: "form-fixture", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    clients.push(client);
    client.setRequestHandler(ElicitRequestSchema, async () => {
      prompts++;
      return { action: "cancel" };
    });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
      env: { HOME: home, USERPROFILE: home, INTIGRITI_API_TOKEN: "", INTIGRITI_ALLOWED_PROGRAM_IDS: "" } });
    await client.connect(transport);
    return args => client.callTool({ name: "prepare_report_draft", arguments: args });
  }
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await rm(home, { recursive: true, force: true });
  });
  return { file, call: await connect(), connect, promptCount: () => prompts };
}

test("a researcher can identify one file by name in Downloads", async t => {
  const { file, call } = await fixture(t);
  const downloads = path.join(path.dirname(file), "Downloads");
  await mkdir(downloads);
  const selected = path.join(downloads, "my practice note.txt");
  await writeFile(selected, "Example note");
  const args = { programUrl: "https://app.intigriti.com/programs/example/demo/detail", title: "Practice", description: "QA" };
  const review = (await call({ ...args, attachments: ["Downloads/my practice note.txt"] })).structuredContent;
  assert.equal(review.status, "awaiting_approval");
  assert.deepEqual(review.evidence, [{ path: selected, name: "my practice note.txt", size: 12 }]);
  for (const invalid of ["Downloads/../evidence.txt", "Downloads/..", "Downloads/.env", "Downloads/missing.txt"]) {
    assert.equal((await call({ ...args, attachments: [invalid] })).isError, true);
  }
  if (process.platform === "win32") {
    assert.deepEqual((await call({ ...args, attachments: ['"' + selected + '"'] })).structuredContent.evidence, review.evidence);
  }
});

test("chat approval works when the client advertises forms but silently cancels them", async t => {
  const { file, call, promptCount } = await fixture(t);
  const input = { programUrl: "https://app.intigriti.com/programs/example/demo/detail",
    title: "Fixture title", description: "Example", attachments: [file] };
  const review = (await call(input)).structuredContent;
  assert.ok(review.instructions.join(" ").includes("fresh chat reply"));
  assert.equal(review.evidence[0].path, file);
  assert.equal((await call({ mode: "approve", draftId: review.draftId, approvalId: "x".repeat(43) })).isError, true);
  const result = await call({ mode: "approve", draftId: review.draftId, approvalId: review.approvalId });
  assert.equal(result.structuredContent.status, "ready_for_browser");
  assert.equal(promptCount(), 0);
  const { draftId, approvalId } = (await call(input)).structuredContent;
  await writeFile(file, "Replacement");
  assert.equal((await call({ mode: "approve", draftId, approvalId })).isError, true);
});

test("adding evidence to an existing draft needs no report body and checks the expected title", async t => {
  const { file, call } = await fixture(t);
  const draftUrl = "https://app.intigriti.com/researcher/inbox/submissions/draft/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/create";
  const expectedTitle = "Existing QA draft";
  const review = (await call({ draftUrl, expectedTitle, attachments: [file] })).structuredContent;
  assert.equal(review.status, "awaiting_approval");
  assert.deepEqual(review.review.fields, {});
  assert.deepEqual(review.missingFields, []);
  const { draftId, approvalId } = review;
  const consent = (await call({ mode: "approve", draftId, approvalId })).structuredContent;
  assert.deepEqual(consent.fields, {});
  const check = { mode: "check", draftId, draftUrl, handoffId: consent.handoffId };
  assert.equal((await call(check)).isError, true);
  assert.equal((await call({ ...check, observedTitle: "Different draft" })).isError, true);
  assert.equal((await call({ ...check, observedTitle: expectedTitle })).structuredContent.status, "handoff_checked");
  const saved = await call({ mode: "finish", draftId, handoffId: consent.handoffId,
    receipt: { draftUrl, savedFields: [], uploadedFiles: ["evidence.txt"] } });
  assert.equal(saved.structuredContent.status, "browser_reported_saved");
  const newReport = await call({ programUrl: "https://app.intigriti.com/programs/example/demo/detail", attachments: [file] });
  assert.equal(newReport.structuredContent.status, "awaiting_finding");
});

test("status and decline distinguish a local-only preview from an unknown draft", async t => {
  const { call } = await fixture(t);
  const { draftId, nextAction } = (await call({ mode: "local", programUrl: "https://app.intigriti.com/programs/example/demo/detail",
    title: "Preview only", description: "Synthetic preview." })).structuredContent;
  assert.equal(nextAction, "show_local_preview");
  for (const mode of ["status", "cancel"]) {
    assert.equal((await call({ mode, draftId })).structuredContent.status, "prepared_locally");
    assert.equal((await call({ mode, draftId: "40d5dc2b-c57d-4119-82b8-b43b92f00144" })).structuredContent.status, "not_found");
  }
  const pending = (await call({ draftId })).structuredContent;
  assert.equal(pending.status, "awaiting_approval");
  assert.equal((await call({ mode: "cancel", draftId })).structuredContent.status, "cancelled");
  assert.equal((await call({ mode: "approve", draftId, approvalId: pending.approvalId })).isError, true);
});

test("only a matching capability can revoke approval for changed evidence, even after exact restoration", async t => {
  const { call, connect, file } = await fixture(t);
  const draftUrl = "https://app.intigriti.com/researcher/submissions/draft/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/create";
  const fileUpdate = async body => {
    await writeFile(file, body);
    await utimes(file, 1700000000, 1700000000);
  };
  await fileUpdate("review A");
  const review = (await call({ draftUrl, attachments: [file] })).structuredContent;
  const { draftId } = review;
  const status = async client => (await client({ mode: "status", draftId })).structuredContent.status;
  await fileUpdate("change B");
  assert.equal((await call({ ...review.afterApproval, approvalId: "x".repeat(43) })).isError, true);
  assert.equal((await call({ draftId })).isError, true);
  assert.equal(await status(call), "awaiting_approval");
  assert.match((await call(review.afterApproval)).content[0].text, /approval has ended/i);
  await fileUpdate("review A");
  assert.equal(await status(call), "evidence_changed");
  assert.equal((await call(review.afterApproval)).isError, true);
  const renewed = (await call({ draftId })).structuredContent;
  assert.notEqual(renewed.approvalId, review.approvalId);
  const handoff = (await call(renewed.afterApproval)).structuredContent;
  const checked = (await call({ ...handoff.checkArgs, draftUrl })).structuredContent;
  await fileUpdate("change B");
  assert.equal((await call({ ...checked.checkBeforeEditOrUpload, handoffId: "z".repeat(43) })).isError, true);
  assert.equal(await status(call), "ready_for_browser");
  assert.match((await call(checked.checkBeforeEditOrUpload)).content[0].text, /approval has ended/i);
  await fileUpdate("review A");
  const peer = await connect();
  assert.equal(await status(peer), "evidence_changed");
  assert.equal((await call(checked.checkBeforeEditOrUpload)).isError, true);
  assert.equal((await peer(checked.checkBeforeEditOrUpload)).isError, true);
  const receipt = { ...checked.finishArgs, receipt: { draftUrl, savedFields: [], uploadedFiles: [] } };
  assert.equal((await peer({ ...receipt, handoffId: "z".repeat(43) })).isError, true);
  const partial = (await peer(receipt)).structuredContent;
  assert.equal(partial.status, "browser_reported_partial");
  assert.deepEqual(partial.receipt.pendingFiles, ["evidence.txt"]);
  assert.deepEqual((await call(receipt)).structuredContent, partial);
});
