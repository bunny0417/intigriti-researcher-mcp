import assert from "node:assert/strict";
import test from "node:test";
import { createNativeDraftHandoff, NativeHandoffError } from "../src/draft-handoff.js";

const id = "00000000-0000-4000-8000-000000000001";
const programUrl = "https://app.intigriti.com/programs/example/demo/detail";
const draftUrl = "https://app.intigriti.com/researcher/submissions/draft/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003/create";
const alias = draftUrl.replace("/researcher/", "/researcher/inbox/");
const otherUrl = draftUrl.replace("000000000003", "000000000004");
const draft = {
  status: "prepared_locally", draftId: id, draftPath: "/local/snapshots/example.json", programUrl,
  fields: { title: "Example only", description: "Synthetic report.", aiDisclosure: "Formatting" },
  attachments: [{ path: "/local/evidence/fixture.png", name: "fixture.png", size: 16 }],
  missingFields: ["asset", "severity", "impact", "vulnerabilityType"],
};
const bound = { ...draft, draftUrl };
const complete = { draftUrl, programUrl, savedFields: Object.keys(draft.fields), uploadedFiles: ["fixture.png"] };

test("first response requires a user decision and shows the destination, full fields and every file size", () => {
  const manager = createNativeDraftHandoff();
  const review = manager.start(draft);
  assert.equal(review.status, "awaiting_approval");
  assert.match(review.message, /^You must be signed in.*@Chrome or @Computer.*Approving.*Only you submit/);
  assert.deepEqual(review.review, { fields: draft.fields });
  assert.equal(review.destination, programUrl);
  assert.deepEqual(review.evidence, [{ name: "fixture.png", size: 16 }]);
  assert.doesNotMatch(JSON.stringify(review), /\/local\/evidence\/fixture/);
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
  for (const term of ["active control's own instructions", "never switch controls to bypass", "normal picker"]) assert.ok(instructions.includes(term), term);
  for (const term of ["If neither is available", "Create submission", "binding succeeds", "CodeMirror", "Read back", "Add attachments", "destructive confirmation"]) assert.ok(instructions.includes(term), term);
  assert.throws(() => manager.approve(draft, review.approvalId), NativeHandoffError);
  assert.equal(manager.start(draft).status, "ready_for_browser");
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
  manager.approve(draft, manager.start(draft).approvalId);
  assert.throws(() => manager.finish(draft, complete), NativeHandoffError);
  for (const receipt of [
    { ...complete, programUrl: undefined }, { ...complete, programUrl: programUrl.replace("demo", "other") },
    { ...complete, draftUrl: otherUrl }, { ...complete, draftUrl: draftUrl + "?token=anything" },
    { ...complete, savedFields: ["asset"] }, { ...complete, uploadedFiles: ["/local/evidence/fixture.png"] },
    { ...complete, uploadedFiles: ["unrelated.log"] }, { ...complete, savedFields: ["title", "title"] },
    { ...complete, pendingFiles: ["fixture.png"] }, { ...complete, savedFields: [], pendingFields: [] },
    { ...complete, notes: "unreviewed content" },
  ]) assert.throws(() => manager.finish(bound, receipt), NativeHandoffError);
  assert.equal(manager.status(id).status, "ready_for_browser");
  const recorded = manager.finish(bound, { ...complete, draftUrl: alias });
  assert.equal(recorded.status, "browser_reported_saved");
  assert.match(recorded.message, /host reported/);
  assert.deepEqual(recorded.receipt.pendingFiles, []);
  assert.deepEqual(manager.finish(bound, { ...complete, savedFields: [...complete.savedFields].reverse() }), recorded);
  assert.throws(() => manager.finish(bound, { ...complete, uploadedFiles: [] }), NativeHandoffError);
  assert.equal(manager.start(bound).status, "browser_reported_saved");
});

test("a directly approved draft cannot be replaced by a different bound destination", () => {
  const direct = { ...draft, programUrl: undefined, draftUrl };
  const manager = createNativeDraftHandoff();
  manager.approve(direct, manager.start(direct).approvalId);
  assert.throws(() => manager.finish({ ...direct, draftUrl: otherUrl }, { ...complete, draftUrl: otherUrl }), NativeHandoffError);
  assert.equal(manager.finish(direct, { ...complete, programUrl: undefined }).status, "browser_reported_saved");
});

test("a partial host report derives pending items and a retry needs a new review tied to the same draft", () => {
  const manager = createNativeDraftHandoff();
  const first = manager.start(draft);
  manager.approve(draft, first.approvalId);
  const partial = manager.finish(bound, { ...complete, savedFields: ["title"], uploadedFiles: [] });
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
  assert.equal(manager.finish(bound, complete).status, "browser_reported_saved");
});
