import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHandoffJournal } from "../src/handoff-journal.js";
import { prepareReportDraft } from "../src/report-draft.js";

const url = "https://app.intigriti.com/researcher/submissions/draft/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/create";
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "handoff-journal-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return prepareReportDraft({ draftUrl: url, title: "Example", description: "Offline fixture" }, { directory });
}

test("same-tick review replacement invalidates the previous session across independent journals", async t => {
  const d = await fixture(t);
  t.mock.method(Date, "now", () => 1780000000000);
  const a = createHandoffJournal(), b = createHandoffJournal();
  const first = await a(d, "start", m => m.start(d));
  const replacement = await b(d, "start", m => m.start(d));
  assert.notEqual(first.approvalId, replacement.approvalId);
  await assert.rejects(a(d, "approve", m => m.approve(d, first.approvalId)));
  const grant = await b(d, "approve", m => m.approve(d, replacement.approvalId));
  assert.equal(grant.status, "ready_for_browser");
  const otherSession = await a(d, "start", m => m.start(d));
  assert.equal(otherSession.status, "ready_for_browser");
  assert.ok(!otherSession.handoffId);
  for (const stale of [undefined, first.onDecline.cancelId, replacement.onDecline.cancelId]) {
    await assert.rejects(a(d, "cancel", m => m.cancel(d.draftId, stale)), /does not match/);
  }
  assert.equal((await b(d, "status", m => m.status(d.draftId))).status, "ready_for_browser");
  assert.equal((await a(d, "cancel", m => m.cancel(d.draftId, otherSession.onDecline.cancelId))).status, "cancelled");
  await assert.rejects(b(d, "check", m => m.checkpoint(d, grant.handoffId, { draftUrl: url })));
  assert.equal((await b(d, "status", m => m.status(d.draftId))).status, "cancelled");
  const dir = path.join(path.dirname(d.draftPath), d.draftId + ".handoff");
  for (const file of await readdir(dir)) {
    const serialized = await readFile(path.join(dir, file), "utf8");
    for (const secret of [first.approvalId, replacement.approvalId, grant.handoffId, d.fields.description]) {
      assert.ok(!serialized.includes(secret), "Journal retained a raw secret or report body");
    }
  }
});

test("two simultaneous reviewers cannot both approve; a fresh session can recover an exact final receipt", async t => {
  const d = await fixture(t);
  const a = createHandoffJournal(), b = createHandoffJournal();
  const managers = [a, b];
  const reviews = await Promise.all(managers.map(j => j(d, "start", m => m.start(d))));
  const grants = await Promise.allSettled(managers.map((j, i) => j(d, "approve", m => m.approve(d, reviews[i].approvalId))));
  assert.equal(grants.filter(v => v.status === "fulfilled").length, 1);
  const winner = grants.findIndex(v => v.status === "fulfilled");
  const key = grants[winner].value.handoffId, j = managers[winner];
  await j(d, "check", m => m.checkpoint(d, key, { draftUrl: url }), key);
  await j(d, "check", m => m.checkpoint(d, key), key);
  const receipt = { draftUrl: url, savedFields: ["title", "description"], uploadedFiles: [] };
  const saved = await j(d, "finish", m => m.finish(d, receipt, key), key);
  const restarted = createHandoffJournal();
  assert.deepEqual(await restarted(d, "status", m => m.status(d.draftId)), saved);
  assert.deepEqual(await restarted(d, "finish", m => m.finish(d, receipt, key), key), saved);
  await assert.rejects(restarted(d, "finish", m => m.finish(d, receipt, "bogus"), "bogus"));
  await assert.rejects(restarted(d, "finish", m => m.finish(d, { ...receipt, savedFields: [] }, key), key));
});

test("a malformed local revision cannot masquerade as a submitted report or a saved receipt", async t => {
  const d = await fixture(t), journal = createHandoffJournal();
  await journal(d, "start", m => m.start(d));
  const file = path.join(path.dirname(d.draftPath), d.draftId + ".handoff", "0000000001.json");
  const row = JSON.parse(await readFile(file, "utf8"));
  for (const state of ["submitted", "browser_reported_saved"]) {
    await writeFile(file, JSON.stringify({ ...row, record: { ...row.record, status: state } }));
    await assert.rejects(journal(d, "status", m => m.status(d.draftId)), /invalid local handoff journal/i);
  }
});
