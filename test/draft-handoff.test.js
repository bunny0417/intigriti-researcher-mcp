import assert from "node:assert/strict";
import test from "node:test";
import { createNativeDraftHandoff, NativeHandoffError, publicHandoffRecord } from "../src/draft-handoff.js";

const id = "00000000-0000-4000-8000-000000000001";
const programUrl = "https://app.intigriti.com/programs/example/demo/detail";
const draftUrl = "https://app.intigriti.com/researcher/submissions/draft/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003/create";
const alias = draftUrl.replace("/researcher/", "/researcher/inbox/");
const otherUrl = draftUrl.replace("000000000003", "000000000004");
const draft = {
  status: "prepared_locally", draftId: id, draftPath: "/local/snapshots/example.json", programUrl, sourceProgramUrl: programUrl,
  fields: { title: "Example only", description: "Synthetic report.", aiDisclosure: "Formatting" },
  attachments: [{ path: "/local/evidence/fixture.png", name: "fixture.png", size: 16 }],
  missingFields: ["asset", "severity", "impact", "vulnerabilityType"],
};
const bound = { ...draft, draftUrl, boundProgramUrl: programUrl };
const complete = { draftUrl, programUrl, savedFields: Object.keys(draft.fields), uploadedFiles: ["fixture.png"] };

function observeBound(manager, snapshot, attempt) {
  manager.checkpoint(snapshot, attempt, { draftUrl: snapshot.draftUrl, programUrl: snapshot.sourceProgramUrl });
  return manager.checkpoint(snapshot, attempt);
}

test("first response requires a user decision and shows the destination, full fields and every file size", () => {
  const manager = createNativeDraftHandoff();
  const review = manager.start(draft);
  assert.equal(review.status, "awaiting_approval");
  assert.match(review.message, /^You must be signed in.*@Chrome or @Computer.*Approving.*Only you submit/);
  assert.deepEqual(review.review, { fields: draft.fields });
  assert.equal(review.destination, programUrl);
  assert.deepEqual(review.evidence, draft.attachments);
  assert.equal(review.nextAction, "ask_for_approval");
  assert.match(review.question, /1 reviewed file/);
  assert.deepEqual(review.afterApproval, { mode: "approve", draftId: id, approvalId: review.approvalId });
  assert.deepEqual(review.onDecline, { mode: "cancel", draftId: id });
  assert.ok(Object.keys(review).indexOf("question") < Object.keys(review).indexOf("review"));
  assert.match(review.instructions.join(" "), /path/i);
  assert.match(review.instructions.join(" "), /Wait for the response/);
  assert.deepEqual(review.missingFields, draft.missingFields);
  assert.equal(manager.start(draft).approvalId, review.approvalId);
  assert.ok(!Object.hasOwn(manager.status(id), "approvalId"));
  assert.ok(!Object.hasOwn(manager.status(id), "review"));
  review.review.fields.title = "Changed output";
  assert.equal(draft.fields.title, "Example only");
});

test("only the correct session and snapshot can consume the one-time challenge", () => {
  const manager = createNativeDraftHandoff();
  const review = manager.start(draft);
  assert.match(review.approvalId, /^[\w-]{43}$/);
  const restarted = createNativeDraftHandoff();
  restarted.start(draft);
  for (const token of [null, "approved", "A".repeat(44), review.approvalId + "\n"]) {
    assert.throws(() => manager.approve(draft, token), NativeHandoffError);
  }
  assert.throws(() => restarted.approve(draft, review.approvalId), NativeHandoffError);
  assert.throws(() => manager.approve({ ...draft, draftId: "another-id" }, review.approvalId), NativeHandoffError);
  const handoff = manager.approve(draft, review.approvalId);
  assert.equal(handoff.status, "ready_for_browser");
  assert.deepEqual(handoff.hostTools, ["@Chrome", "@Computer"]);
  assert.deepEqual(handoff.attachments, draft.attachments);
  assert.ok(!Object.hasOwn(handoff, "approvalId"));
  const instructions = handoff.instructions.join(" ");
  assert.equal(handoff.nextAction, "open_in_browser");
  assert.equal(handoff.openUrl, programUrl);
  assert.deepEqual(handoff.observe, ["programUrl"]);
  assert.deepEqual(handoff.checkArgs, { mode: "check", draftId: id, handoffId: handoff.handoffId });
  assert.ok(Object.keys(handoff).indexOf("checkArgs") < Object.keys(handoff).indexOf("fields"));
  assert.match(instructions, /Only the researcher submits/);
  assert.doesNotMatch(instructions, /Add attachments|Delete draft/);
  assert.throws(() => manager.approve(draft, review.approvalId), NativeHandoffError);
  assert.equal(manager.start(draft).status, "ready_for_browser");
});

test("a direct attachment-only review identifies the existing draft without offering field edits", () => {
  const manager = createNativeDraftHandoff();
  const filesOnly = { ...draft, fields: {}, programUrl: undefined, sourceProgramUrl: undefined,
    draftUrl, expectedTitle: "Existing report" };
  const review = manager.start(filesOnly);
  assert.match(review.question, /attachments only/);
  assert.equal(review.expectedTitle, "Existing report");
  assert.throws(() => manager.approve({ ...filesOnly, expectedTitle: "Different" }, review.approvalId), NativeHandoffError);
  const approved = manager.approve(filesOnly, manager.start(filesOnly).approvalId);
  assert.equal(approved.expectedTitle, filesOnly.expectedTitle);
  assert.equal(approved.openUrl, draftUrl);
  assert.deepEqual(approved.observe, ["draftUrl", "observedTitle"]);
  assert.match(approved.instructions.join(" "), /expectedTitle/);
  for (const observed of [{ draftUrl }, { draftUrl, observedTitle: "Different report" }, { observedTitle: filesOnly.expectedTitle }]) {
    assert.throws(() => manager.checkpoint(filesOnly, approved.handoffId, observed), NativeHandoffError);
  }
  assert.throws(() => manager.checkpoint(filesOnly, approved.handoffId), NativeHandoffError);
  manager.checkpoint(filesOnly, approved.handoffId, { draftUrl, observedTitle: filesOnly.expectedTitle });
  const checked = manager.checkpoint(filesOnly, approved.handoffId);
  assert.equal(checked.nextAction, "upload_and_verify_files");
  assert.match(checked.instructions.join(" "), /attachments only.*savedFields as an empty array/);
  assert.doesNotMatch(checked.instructions.join(" "), /CodeMirror|Fill Title/);
});

test("changed fields, local evidence identity, missing fields, or destination require fresh approval", () => {
  for (const change of [
    { fields: { ...draft.fields, title: "Changed" } }, { draftPath: "/other/location" },
    { attachments: [{ ...draft.attachments[0], path: "/other/fixture.png" }] },
    { attachments: [{ ...draft.attachments[0], size: 15 }] },
    { attachments: [] }, { missingFields: [] }, { programUrl: programUrl.replace("/demo/", "/other/") },
    { draftUrl }, // A new destination before user approval is a different review.
  ]) {
    const manager = createNativeDraftHandoff();
    const pending = manager.start(draft);
    assert.throws(() => manager.approve({ ...draft, ...change }, pending.approvalId), NativeHandoffError);
    assert.equal(manager.status(id).status, "expired");
    assert.notEqual(manager.start(draft).approvalId, pending.approvalId);
  }
  const manager = createNativeDraftHandoff();
  const review = manager.start(bound);
  assert.equal(manager.approve({ ...bound, draftUrl: alias + "?program=example%2Fdemo" }, review.approvalId).status, "ready_for_browser");
});

test("unanswered, expired and cancelled approvals never authorize a receipt", () => {
  let clock = 100;
  const manager = createNativeDraftHandoff({ now: () => clock, ttlMs: 50, retentionMs: 500 });
  const old = manager.start(draft);
  assert.throws(() => manager.finish(bound, complete), NativeHandoffError);
  clock = 150;
  assert.equal(manager.status(id).status, "expired");
  assert.throws(() => manager.approve(draft, old.approvalId), NativeHandoffError);
  const renewed = manager.start(draft);
  assert.notEqual(old.approvalId, renewed.approvalId);
  assert.equal(manager.cancel(id).status, "cancelled");
  assert.throws(() => manager.approve(draft, renewed.approvalId), NativeHandoffError);
  const last = manager.start(draft);
  manager.approve(draft, last.approvalId);
  assert.equal(manager.cancel(id).status, "cancelled");
  assert.throws(() => manager.finish(bound, complete), NativeHandoffError);
  clock += 501;
  assert.equal(manager.status(id).status, "not_found");
});

test("a program-first receipt needs the actual bound GUID pair and matching program, with no unreviewed items", () => {
  const manager = createNativeDraftHandoff();
  const attempt = manager.approve(draft, manager.start(draft).approvalId).handoffId;
  assert.throws(() => manager.finish(draft, complete, attempt), NativeHandoffError);
  manager.checkpoint(draft, attempt, { draftUrl, programUrl });
  assert.deepEqual(manager.checkpoint(bound, attempt).receiptFileNames, ["fixture.png"]);
  assert.throws(() => manager.finish(bound, { ...complete, uploadedFiles: [draft.attachments[0].path] }, attempt), /filenames only.*retry finish/i);
  for (const receipt of [
    { ...complete, programUrl: undefined }, { ...complete, programUrl: programUrl.replace("demo", "other") },
    { ...complete, draftUrl: otherUrl }, { ...complete, draftUrl: draftUrl + "?token=anything" },
    { ...complete, savedFields: ["asset"] }, { ...complete, uploadedFiles: ["/local/evidence/fixture.png"] },
    { ...complete, uploadedFiles: ["unrelated.log"] }, { ...complete, savedFields: ["title", "title"] },
    { ...complete, pendingFiles: ["fixture.png"] }, { ...complete, savedFields: [], pendingFields: [] },
    { ...complete, notes: "unreviewed content" },
  ]) assert.throws(() => manager.finish(bound, receipt, attempt), NativeHandoffError);
  assert.equal(manager.status(id).status, "ready_for_browser");
  const recorded = manager.finish(bound, { ...complete, draftUrl: alias }, attempt);
  assert.equal(recorded.status, "browser_reported_saved");
  assert.match(recorded.message, /host reported/);
  assert.deepEqual(recorded.receipt.pendingFiles, []);
  assert.deepEqual(manager.finish(bound, { ...complete, savedFields: [...complete.savedFields].reverse() }, attempt), recorded);
  assert.throws(() => manager.finish(bound, { ...complete, uploadedFiles: [] }, attempt), NativeHandoffError);
  assert.equal(manager.start(bound).status, "browser_reported_saved");
});

test("a directly approved draft cannot be replaced by a different bound destination", () => {
  const direct = { ...draft, programUrl: undefined, sourceProgramUrl: undefined, draftUrl };
  const manager = createNativeDraftHandoff();
  const attempt = manager.approve(direct, manager.start(direct).approvalId).handoffId;
  assert.throws(() => manager.checkpoint(direct, attempt), NativeHandoffError);
  assert.throws(() => manager.finish(direct, { ...complete, programUrl: undefined }, attempt), NativeHandoffError);
  observeBound(manager, direct, attempt);
  assert.throws(() => manager.finish({ ...direct, draftUrl: otherUrl }, { ...complete, draftUrl: otherUrl }, attempt), NativeHandoffError);
  assert.equal(manager.finish(direct, { ...complete, programUrl: undefined }, attempt).status, "browser_reported_saved");
});

test("direct-only draft accepts an optional observed program and pins that observation without inventing a source", () => {
  const direct = { ...draft, programUrl: undefined, sourceProgramUrl: undefined, draftUrl };
  const manager = createNativeDraftHandoff();
  const attempt = manager.approve(direct, manager.start(direct).approvalId).handoffId;
  const checked = manager.checkpoint(direct, attempt, { draftUrl: alias, programUrl });
  assert.equal(checked.programUrl, programUrl);
  assert.throws(() => manager.checkpoint(direct, attempt), NativeHandoffError);
  const associated = { ...direct, boundProgramUrl: programUrl };
  manager.checkpoint(associated, attempt);
  const unrelated = programUrl.replace("demo", "other");
  assert.throws(() => manager.checkpoint(associated, attempt, { draftUrl, programUrl: unrelated }), NativeHandoffError);
  assert.throws(() => manager.finish(associated, { ...complete, programUrl: unrelated }, attempt), NativeHandoffError);
  assert.equal(manager.finish(associated, complete, attempt).receipt.programUrl, programUrl);
});

test("exact finish replay leaves the completed durable state and expiry unchanged", () => {
  let clock = 500;
  const records = new Map();
  const manager = createNativeDraftHandoff({ records, now: () => clock, retentionMs: 50 });
  const attempt = manager.approve(bound, manager.start(bound).approvalId).handoffId;
  observeBound(manager, bound, attempt);
  manager.finish(bound, complete, attempt);
  const before = publicHandoffRecord(records.get(id));
  clock += 10;
  manager.finish(bound, complete, attempt);
  assert.deepEqual(publicHandoffRecord(records.get(id)), before);
});

test("saved and partial receipts outlive authorization in memory and after a journal restore", () => {
  for (const partial of [false, true]) {
    let clock = 500;
    const records = new Map();
    const options = { records, now: () => clock, retentionMs: 50, ttlMs: 10 };
    const manager = createNativeDraftHandoff(options);
    const handoff = manager.approve(bound, manager.start(bound).approvalId);
    observeBound(manager, bound, handoff.handoffId);
    const receipt = partial ? { ...complete, uploadedFiles: [] } : complete;
    const outcome = manager.finish(bound, receipt, handoff.handoffId);
    clock += 500;
    assert.deepEqual(manager.status(id), outcome);
    assert.ok(!Object.hasOwn(records.get(id), "attempt"));
    assert.throws(() => manager.finish(bound, receipt, handoff.handoffId), NativeHandoffError);
    const restored = createNativeDraftHandoff({ ...options, records: new Map([[id, publicHandoffRecord(records.get(id))]]) });
    assert.deepEqual(restored.status(id), outcome);
    const resume = restored.start(bound);
    if (!partial) {
      assert.deepEqual(resume, outcome);
      assert.ok(!Object.hasOwn(resume, "approvalId"));
      continue;
    }
    assert.equal(resume.status, "awaiting_approval");
    assert.deepEqual(resume.priorReceipt, outcome.receipt);
    assert.throws(() => restored.finish(bound, complete, handoff.handoffId), NativeHandoffError);
    const next = restored.approve(bound, resume.approvalId);
    assert.notEqual(next.handoffId, handoff.handoffId);
    clock += 500;
    assert.equal(restored.status(id).status, "expired");
    assert.deepEqual(restored.status(id).priorReceipt, outcome.receipt);
  }
});

test("an expired unfinished attempt leaves an advisory status without authorizing another action", () => {
  let clock = 150;
  const records = new Map();
  const manager = createNativeDraftHandoff({ records, now: () => clock, retentionMs: 100, ttlMs: 10 });
  const attempt = manager.approve(bound, manager.start(bound).approvalId);
  clock += 200;
  assert.equal(manager.status(id).status, "expired");
  assert.match(manager.status(id).message, /Inspect the draft/);
  assert.ok(!Object.hasOwn(records.get(id), "attempt"));
  assert.throws(() => manager.checkpoint(bound, attempt.handoffId, { draftUrl, programUrl }), NativeHandoffError);
  const review = manager.start(bound);
  clock += 200;
  assert.equal(manager.status(id).status, "expired");
  assert.ok(!Object.hasOwn(records.get(id), "token"));
  assert.throws(() => manager.approve(bound, review.approvalId), NativeHandoffError);
});

test("a partial host report derives pending items and a retry needs a new review tied to the same draft", () => {
  const manager = createNativeDraftHandoff();
  const first = manager.start(draft);
  const original = manager.approve(draft, first.approvalId).handoffId;
  manager.checkpoint(draft, original, { draftUrl, programUrl });
  manager.checkpoint(bound, original);
  const partial = manager.finish(bound, { ...complete, savedFields: ["title"], uploadedFiles: [] }, original);
  assert.equal(partial.status, "browser_reported_partial");
  assert.deepEqual(partial.receipt.pendingFields, ["description", "aiDisclosure"]);
  assert.deepEqual(partial.receipt.pendingFiles, ["fixture.png"]);
  assert.throws(() => manager.start({ ...bound, draftUrl: otherUrl }), NativeHandoffError);
  const resume = manager.start(bound);
  assert.equal(resume.status, "awaiting_approval");
  assert.deepEqual(resume.priorReceipt, partial.receipt);
  assert.notEqual(resume.approvalId, first.approvalId);
  assert.throws(() => manager.finish(bound, complete), NativeHandoffError);
  const handoff = manager.approve(bound, resume.approvalId);
  assert.deepEqual(handoff.priorReceipt, partial.receipt);
  assert.notEqual(handoff.handoffId, original);
  assert.throws(() => manager.finish(bound, complete, original), NativeHandoffError);
  assert.throws(() => manager.checkpoint(bound, handoff.handoffId), NativeHandoffError);
  observeBound(manager, bound, handoff.handoffId);
  assert.equal(manager.finish(bound, complete, handoff.handoffId).status, "browser_reported_saved");
});

test("cancellation revokes checkpoint and stale receipt even after the same snapshot is reapproved", () => {
  const manager = createNativeDraftHandoff();
  const first = manager.approve(bound, manager.start(bound).approvalId);
  assert.match(first.handoffId, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!Object.hasOwn(manager.status(id), "handoffId"));
  observeBound(manager, bound, first.handoffId);
  manager.cancel(id);
  assert.throws(() => manager.checkpoint(bound, first.handoffId), NativeHandoffError);
  const second = manager.approve(bound, manager.start(bound).approvalId);
  assert.notEqual(second.handoffId, first.handoffId);
  assert.throws(() => manager.checkpoint(bound, second.handoffId), NativeHandoffError);
  observeBound(manager, bound, second.handoffId);
  for (const stale of [first.handoffId, undefined, "A".repeat(43)]) {
    assert.throws(() => manager.finish(bound, complete, stale), NativeHandoffError);
    assert.throws(() => manager.checkpoint(bound, stale), NativeHandoffError);
  }
  const saved = manager.finish(bound, complete, second.handoffId);
  assert.deepEqual(manager.finish(bound, complete, second.handoffId), saved);
  assert.throws(() => manager.finish(bound, complete, first.handoffId), NativeHandoffError);
});

test("program-first legacy and restarted bindings must verify source program before any edit", () => {
  const legacy = { ...draft, unverifiedDraftUrl: draftUrl };
  const manager = createNativeDraftHandoff();
  const review = manager.start(legacy);
  assert.equal(review.unverifiedDraftUrl, draftUrl);
  assert.equal(review.draftUrl, undefined);
  const attempt = manager.approve(legacy, review.approvalId).handoffId;
  const unrelated = programUrl.replace("/demo/", "/different/");
  assert.throws(() => manager.checkpoint(legacy, attempt), NativeHandoffError);
  assert.throws(() => manager.checkpoint(legacy, attempt, { draftUrl }), NativeHandoffError);
  assert.throws(() => manager.checkpoint(legacy, attempt, { draftUrl, programUrl: unrelated }), NativeHandoffError);
  assert.throws(() => manager.checkpoint(legacy, attempt, { draftUrl: otherUrl, programUrl }), NativeHandoffError);
  manager.checkpoint(legacy, attempt, { draftUrl: alias, programUrl });
  assert.throws(() => manager.checkpoint(legacy, attempt), NativeHandoffError);
  assert.throws(() => manager.checkpoint({ ...bound, boundProgramUrl: unrelated }, attempt), NativeHandoffError);
  manager.checkpoint(bound, attempt);
  assert.throws(() => manager.finish(bound, { ...complete, programUrl: undefined }, attempt), NativeHandoffError);
  const restarted = createNativeDraftHandoff();
  const fresh = restarted.approve(bound, restarted.start(bound).approvalId);
  assert.throws(() => restarted.checkpoint(bound, fresh.handoffId), NativeHandoffError);
  observeBound(restarted, bound, fresh.handoffId);
  assert.throws(() => restarted.finish(bound, { ...complete, programUrl: undefined }, fresh.handoffId), NativeHandoffError);
});

test("pre-Create check is limited to the active unbound source program and never permits an edit or receipt", () => {
  const manager = createNativeDraftHandoff();
  const attempt = manager.approve(draft, manager.start(draft).approvalId).handoffId;
  assert.throws(() => manager.checkpoint(draft, attempt, { programUrl: programUrl.replace("demo", "other") }), NativeHandoffError);
  assert.equal(manager.checkpoint(draft, attempt, { programUrl }).status, "program_checked");
  assert.throws(() => manager.checkpoint(draft, attempt), NativeHandoffError);
  assert.throws(() => manager.finish(draft, complete, attempt), NativeHandoffError);
  manager.checkpoint(draft, attempt, { programUrl, draftUrl });
  assert.throws(() => manager.checkpoint(draft, attempt, { programUrl }), NativeHandoffError);
  assert.throws(() => manager.checkpoint(bound, attempt, { programUrl }), NativeHandoffError);
  const another = createNativeDraftHandoff();
  const cancelled = another.approve(draft, another.start(draft).approvalId).handoffId;
  another.cancel(id);
  assert.throws(() => another.checkpoint(draft, cancelled, { programUrl }), NativeHandoffError);
});

test("restored journal contains no capabilities or evidence paths and preserves an interrupted GUID pin", () => {
  const original = new Map();
  const manager = createNativeDraftHandoff({ records: original });
  const review = manager.start(draft);
  assert.ok(!JSON.stringify(publicHandoffRecord(original.get(id))).includes(review.approvalId));
  const active = manager.approve(draft, review.approvalId);
  manager.checkpoint(draft, active.handoffId, { draftUrl, programUrl });
  const saved = publicHandoffRecord(original.get(id));
  assert.equal(saved.pinnedUrl, draftUrl);
  assert.ok(!Object.hasOwn(saved, "token"));
  assert.ok(!Object.hasOwn(saved, "attempt"));
  assert.ok(!JSON.stringify(saved).includes(draft.attachments[0].path));
  const resumed = createNativeDraftHandoff({ records: new Map([[id, saved]]) });
  assert.throws(() => resumed.checkpoint(draft, active.handoffId, { draftUrl, programUrl }), NativeHandoffError);
  const next = resumed.start(draft);
  assert.equal(next.status, "awaiting_approval");
  assert.equal(next.unverifiedDraftUrl, draftUrl);
  const fresh = resumed.approve(draft, next.approvalId);
  assert.notEqual(fresh.handoffId, active.handoffId);
  assert.throws(() => resumed.checkpoint(draft, fresh.handoffId, { draftUrl: otherUrl, programUrl }), NativeHandoffError);
  resumed.checkpoint(draft, fresh.handoffId, { draftUrl, programUrl });
  resumed.checkpoint(bound, fresh.handoffId);
});

test("current receipt never silently promotes a historical observation to newly verified work", () => {
  const manager = createNativeDraftHandoff();
  const first = manager.approve(bound, manager.start(bound).approvalId);
  observeBound(manager, bound, first.handoffId);
  const partial = manager.finish(bound, { ...complete, savedFields: ["title"], uploadedFiles: [] }, first.handoffId);
  const next = manager.approve(bound, manager.start(bound).approvalId);
  observeBound(manager, bound, next.handoffId);
  const updated = manager.finish(bound, { ...complete, savedFields: ["description", "aiDisclosure"] }, next.handoffId);
  assert.equal(updated.status, "browser_reported_partial");
  assert.deepEqual(updated.receipt.pendingFields, ["title"]);
  assert.deepEqual(updated.priorReceipt, partial.receipt);
  assert.deepEqual(updated.receipt.uploadedFiles, ["fixture.png"]);
  assert.ok(!Object.hasOwn(updated, "handoffId"));
});

test("an explicit ready resume returns current host steps and evidence only for the same snapshot and pin", () => {
  const manager = createNativeDraftHandoff();
  const attempt = manager.approve(draft, manager.start(draft).approvalId);
  const resumed = manager.start(draft);
  assert.deepEqual(resumed.hostTools, ["@Chrome", "@Computer"]);
  assert.deepEqual(resumed.instructions, attempt.instructions);
  assert.equal(resumed.handoffId, attempt.handoffId);
  assert.throws(() => manager.start({ ...draft, attachments: [] }), NativeHandoffError);
  assert.throws(() => manager.start(bound), NativeHandoffError);
  manager.checkpoint(draft, attempt.handoffId, { programUrl, draftUrl });
  assert.throws(() => manager.checkpoint(draft, attempt.handoffId, { programUrl, draftUrl: otherUrl }), NativeHandoffError);
  assert.equal(manager.start(bound).draftUrl, draftUrl);
  assert.throws(() => manager.start({ ...bound, draftUrl: otherUrl }), NativeHandoffError);
});
