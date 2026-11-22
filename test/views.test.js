import assert from "node:assert/strict";
import test from "node:test";
import {
  activityRecord, isVisible, payoutRecord, programCard, programDetail,
  rulesVersion, scopeVersion, ViewError,
} from "../src/views.js";

const id = "00000000-0000-0000-0000-0000000000ab";
const versionId = "00000000-0000-0000-0000-0000000000cd";
const version = { id: versionId, createdAt: 1700000000 };
const publicLevel = { id: 4, value: "Public" };
const status = { id: 3, value: "Open" };
const tier = { id: 1, value: "Tier 1" };
const url = { id: 2, value: "URL" };
const program = {
  id, name: "Example", handle: "example", confidentialityLevel: publicLevel,
  following: false, status, type: { id: 1, value: "Bug bounty" }, industry: null,
  webLinks: { detail: "https://app.intigriti.com/programs/example/example/detail" },
};
const amount = { value: 50.5, currency: "EUR" };
const card = { ...program, minBounty: amount, maxBounty: { value: 250, currency: "USD" } };
const requirements = { intigritiMe: true, automatedTooling: 0, userAgent: null, requestHeader: "" };
const terms = { description: "Read the conditions", safeHarbour: false, testingRequirements: requirements };

test("visibility requires the documented Public pair or a locally permitted program GUID", () => {
  assert.equal(isVisible(program), true);
  for (const level of [null, "Public", { id: 1, value: "Public" }, { id: 4, value: "Registered" }, { id: 4 }]) {
    assert.equal(isVisible({ ...program, confidentialityLevel: level }), false);
  }
  const permitted = new Set([id, "bad-id"]);
  assert.equal(isVisible({ id: id.toUpperCase(), confidentialityLevel: { id: 1, value: "Invite only" } }, permitted), true);
  assert.equal(isVisible({ id: "bad-id", confidentialityLevel: publicLevel }, permitted), false);
  assert.equal(isVisible(null), false);
});

test("program cards retain amounts in their original currency and select fields explicitly", () => {
  const projected = programCard({ ...card, addedByPlatform: "private", status: { ...status, secret: true } });
  assert.deepEqual(projected, card);
});

test("program links accept only platform detail paths and strip extraneous data", () => {
  function detailLink(detail) { return programCard({ ...card, webLinks: { detail } }).webLinks.detail; }
  assert.equal(detailLink("/researcher/programs/company/program?a=1#secret"),
    "https://app.intigriti.com/researcher/programs/company/program");
  assert.equal(detailLink(program.webLinks.detail), program.webLinks.detail);
  for (const rejected of [
    "https://outside.invalid/programs/example/example/detail",
    "https://app.intigriti.com.example.invalid/programs/example/example",
    "https://user@app.intigriti.com/programs/example/example",
    "http://app.intigriti.com/programs/example/example",
    "https://app.intigriti.com/programs/example/example/%2fsecret",
    "https://app.intigriti.com/assets/example",
    "https://app.intigriti.com:1234/programs/example/example",
    "javascript:alert(1)", "not a URL",
  ]) assert.equal(detailLink(rejected), null);
});

test("dashboard redirects expose only the canonical same-origin program link", () => {
  const dashboard = "https://app.intigriti.com/auth/dashboard";
  const expected = "https://app.intigriti.com/programs/example/sample/detail";
  const redirect = dashboard + "?redirect=%2Fprograms%2Fexample%2Fsample%2Fdetail";
  const cases = [
    [redirect, expected],
    [redirect + "%3Fsession%3Dexample%23private", expected],
    [dashboard + "?redirect=" + encodeURIComponent("https://elsewhere.invalid/programs/example/sample/detail"), null],
    [dashboard, null],
  ];
  for (const [detail, canonical] of cases) {
    assert.equal(programCard({ ...card, webLinks: { detail } }).webLinks.detail, canonical);
  }
});

test("scope groups by the combination of type and tier without exporting assets", () => {
  const out = { id: 5, value: "Out of scope" };
  const domain = { type: url, tier, endpoint: "private.invalid", description: "private", requiredSkills: [] };
  const input = { ...version, content: [domain, domain, { ...domain, tier: out }] };
  assert.deepEqual(scopeVersion(input), {
    ...version, content: { total: 3, groups: [{ type: url, tier, count: 2 }, { type: url, tier: out, count: 1 }] },
  });
  assert.deepEqual(scopeVersion({ ...version, content: [] }).content, { total: 0, groups: [] });
  assert.equal(scopeVersion({ ...version, content: null }).content, null);
});

test("program details project the current rules, scope summary and null versions", () => {
  const domains = { ...version, content: [] };
  const rulesOfEngagement = { ...version, content: terms, attachments: [{ url: "https://private.invalid" }] };
  assert.deepEqual(programDetail({ ...program, domains, rulesOfEngagement }), {
    ...program,
    domains: { ...version, content: { total: 0, groups: [] } },
    rulesOfEngagement: { ...version, content: { ...terms, truncatedFields: [] } },
  });
  assert.equal(programDetail({ ...program, domains, rulesOfEngagement: null }).rulesOfEngagement, null);
  assert.deepEqual(rulesVersion({ ...version, content: null }), { ...version, content: null });
});

test("scope aggregation stops reading a malformed upstream array at its first invalid entry", () => {
  const content = [null];
  Object.defineProperty(content, 1, {
    get() { assert.fail("scopeVersion continued reading after rejecting the first entry"); },
  });
  assert.throws(() => scopeVersion({ ...version, content }), ViewError);
});

test("long rules text and testing fields carry individual truncation notices", () => {
  const description = "x".repeat(11999) + "👍";
  const long = { ...terms, description, testingRequirements: { ...requirements, requestHeader: "a".repeat(1025) } };
  const result = rulesVersion({ ...version, content: long }).content;
  assert.equal(result.description, "x".repeat(11999));
  assert.equal(result.testingRequirements.requestHeader.length, 1024);
  assert.deepEqual(result.truncatedFields, ["description", "testingRequirements.requestHeader"]);
  assert.equal(long.description, description);
});

test("activity and payout records discard subtype fields and keep nullable values", () => {
  const activity = { programId: id, type: status, following: true, createdAt: 5, activity: { toVersionId: versionId } };
  assert.deepEqual(activityRecord({ ...activity, activity: { ...activity.activity, notes: "private" } }), {
    ...activity, activity: { fromVersionId: null, toVersionId: versionId },
  });
  const payout = { id: "PAYOUT-1", status, amount, createdAt: 1700000000, paidAt: null };
  assert.deepEqual(payoutRecord({ ...payout, bankDetails: "private", amount: { ...amount, invoice: "private" } }), payout);
});

test("malformed shapes surface a fixed error without reflecting their contents", () => {
  for (const [convert, invalid] of [
    [programCard, { ...card, status: "private" }],
    [programDetail, []],
    [scopeVersion, { ...version, content: [{}] }],
    [rulesVersion, { ...version, content: "private" }],
    [activityRecord, { programId: id }],
    [payoutRecord, { id: "private" }],
  ]) {
    assert.throws(() => convert(invalid), error => error instanceof ViewError &&
      error.code === "invalid_upstream_response" && !error.message.includes("private"));
  }
});
