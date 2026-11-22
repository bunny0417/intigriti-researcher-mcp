import assert from "node:assert/strict";
import test from "node:test";
import { InboxLookupError, lookupInboxReport } from "../src/inbox-lookup.js";

const inboxUrl = "https://app.intigriti.com/researcher/inbox";
const reference = "QA-SAMPLE123";
const title = "Synthetic example for the inbox";
const url = "https://app.intigriti.com/researcher/submissions/" + reference;
const draftUrl = inboxUrl + "/submissions/draft/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/create";
const row = { title, status: "Pending", url };
const read = (report, extra = {}) => lookupInboxReport({ report, lookupObservation: {
  inboxUrl: inboxUrl + "?search=" + encodeURIComponent(report), search: report, scope: { programs: "All", otherFilters: [] }, counter: "1 of 200 items shown",
  examined: 1, matches: [row], ...extra,
} });

test("lookup starts at the list and never instructs the host to open any result", () => {
  const state = lookupInboxReport({ report: reference });
  assert.equal(state.openUrl, inboxUrl);
  assert.equal(state.nextAction, "search_inbox_list");
  assert.deepEqual(state.hostTools, ["@Chrome", "@Computer"]);
  assert.match(state.instructions.join(" "), /Never click or visit any result, draft, report link, message, comment thread, history or attachment/);
  assert.throws(() => lookupInboxReport({ report: "https://elsewhere.invalid/pretend" }), InboxLookupError);
  assert.throws(() => lookupInboxReport({ report: draftUrl }), /draft.*title/);
  assert.throws(() => lookupInboxReport({ report: url + "?token=private" }), InboxLookupError);
  assert.throws(() => lookupInboxReport({ report: url + "#comment" }), InboxLookupError);
  const pastedLink = lookupInboxReport({ report: url });
  assert.equal(pastedLink.openUrl, inboxUrl);
  assert.equal(pastedLink.report, reference);
  assert.equal(read(url, { search: reference, inboxUrl: inboxUrl + "?search=" + reference }).status, "report_found");
});

test("visible rows match exact references or titles and exclude unrelated fields and URLs", () => {
  for (const report of [title, title.toUpperCase(), reference.toLowerCase()]) {
    const state = read(report);
    assert.equal(state.status, "report_found");
    assert.equal(state.shown, 1);
    assert.equal(state.total, 200);
    assert.deepEqual(state.report, { title, status: "Pending", submittedAt: null, lastCommentPreview: null });
  }
  assert.equal(read("Synthetic").status, "not_found");
  assert.equal(read(title, { inboxUrl: inboxUrl + "?search=" + encodeURIComponent(title) }).status, "report_found");
  assert.equal(read(title, { matches: [{ ...row, url: draftUrl, status: "Draft" }] }).report.status, "Draft");
  assert.equal(read(reference, { matches: [{ ...row, url: "/researcher/submissions/" + reference + "?search=" + reference }] }).status, "report_found");
  assert.equal(read(title, { matches: [{ ...row, url: draftUrl + "?search=" + encodeURIComponent(title), status: "Draft" }] }).status, "report_found");
  assert.throws(() => read(reference, { matches: [{ ...row, url: draftUrl }] }), InboxLookupError);
});

test("only explicitly labeled dates and comment previews are available on a found report", () => {
  const submitted = { label: "Submitted on", value: "20 March 2025" };
  const preview = { label: "Last comment", value: "Synthetic preview." };
  assert.deepEqual(read(title, { matches: [{ ...row, submissionDate: submitted, lastCommentPreview: preview }] }).report,
    { title, status: "Pending", submittedAt: submitted.value, lastCommentPreview: preview.value });
  for (const extra of [{ submissionDate: { ...submitted, label: "Last activity" } }, { rowDate: "03/20/2025" },
    { lastCommentPreview: { ...preview, label: "Comment history" } }, { body: "not list metadata" }, { severity: "high" }]) {
    assert.throws(() => read(title, { matches: [{ ...row, ...extra }] }), InboxLookupError);
  }
});

test("duplicate titles are ambiguous, and a partly inspected search cannot establish a unique title or absence", () => {
  const second = { ...row, url: url.replace(reference, "QA-SAMPLE456"), status: "Triage" };
  const result = read(title, { matches: [row, second], examined: 2, counter: "2 of 200 items shown" });
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.choices.map(r => Object.keys(r)), Array(2).fill(["title", "status", "submittedAt", "lastCommentPreview"]));
  assert.equal(result.report, undefined);
  assert.equal(read(title, { counter: "12 of 200 items shown" }).status, "lookup_partial");
  assert.equal(read(reference, { counter: "12 of 200 items shown" }).status, "report_found");
  assert.equal(read(title, { matches: [], examined: 0 }).status, "lookup_partial");
  assert.equal(read(title, { matches: [], examined: 0, counter: "0 of 200 items shown" }).status, "not_found");
  assert.throws(() => read(title, { matches: [row, row], counter: "2 of 200 items shown", examined: 2 }), InboxLookupError);
  assert.throws(() => read(title, { examined: 3 }), InboxLookupError);
});

test("rejects off-list observations, wrong search and hostile or non-report row URLs", () => {
  for (const bad of [url, draftUrl, inboxUrl, inboxUrl + "/foo", inboxUrl + "?st=closed", inboxUrl + "#bad", inboxUrl + "?search=elsewhere",
    inboxUrl + "?search=" + reference + "&search=" + reference, inboxUrl + "?search=" + reference + "&st=closed",
    inboxUrl.replace("app.intigriti.com", "app.intigriti.com.example.invalid"), inboxUrl + "/../inbox"]) {
    assert.throws(() => read(reference, { inboxUrl: bad }), InboxLookupError);
  }
  for (const bad of ["https://example.invalid/" + reference, url + "#fragment", url + "/comments", "https://app.intigriti.com/researcher/submissions/../" + reference, url + "?token=secret", url + "?search=other", url + "?st=pending", url + "?search=" + reference + "#history"]) {
    assert.throws(() => read(reference, { matches: [{ ...row, url: bad }] }), InboxLookupError);
  }
  assert.throws(() => read(reference, { search: "something else" }), InboxLookupError);
  assert.throws(() => read(reference, { scope: { programs: "One program", otherFilters: [] } }), InboxLookupError);
});

const list = (listStatus, details = {}, limit) => lookupInboxReport({ listStatus, limit, listObservation: {
  inboxUrl: inboxUrl + "?st=pending", selectedStatuses: ["Pending"], counter: "1 of 200 items shown",
  scope: { programs: "All", search: "", otherFilters: [] }, rows: [{ ...row, url: url + "?st=pending", status: "PENDING" }], ...details,
} });

test("a filtered list returns only visible permitted metadata and accounts for unlisted results", () => {
  const start = lookupInboxReport({ listStatus: "Pending" });
  assert.equal(start.limit, 20);
  assert.equal(start.openUrl, inboxUrl + "?st=pending");
  assert.match(start.instructions.join(" "), /Never click or visit/);
  const one = list("Pending");
  assert.equal(one.status, "reports_listed");
  assert.deepEqual(one.reports, [{ title, status: "PENDING", submittedAt: null, lastCommentPreview: null }]);
  assert.equal(one.shown, 1);
  assert.equal(one.total, 200);
  assert.equal(one.remaining, 0);
  assert.equal(one.truncated, false);
  const capped = list("Pending", { counter: "8 of 200 items shown" }, 1);
  assert.equal(capped.status, "reports_listed");
  assert.equal(capped.truncated, true);
  assert.equal(capped.remaining, 7);
  assert.equal(list("Pending", { counter: "8 of 200 items shown" }).status, "reports_partial");
  assert.deepEqual(list("Pending", { counter: "0 of 200 items shown", rows: [] }).reports, []);
  assert.throws(() => list("Pending", { rows: [row, row], counter: "2 of 200 items shown" }), InboxLookupError);
  assert.throws(() => list("Pending", { rows: [row, row], counter: "1 of 200 items shown" }), InboxLookupError);
});

test("filtered lists verify the requested scope and retain the portal's actual badge for a grouped filter", () => {
  assert.throws(() => list("Triage"));
  assert.throws(() => list("Pending", { inboxUrl: inboxUrl + "?st=triage" }));
  assert.throws(() => list("Pending", { selectedStatuses: ["Pending", "Accepted"] }));
  assert.throws(() => list("Pending", { rows: [{ ...row, url: url + "?st=triage" }] }));
  assert.throws(() => list("Pending", { scope: { programs: "All", search: reference, otherFilters: [] } }));
  assert.throws(() => list("Pending", { rows: [{ ...row, status: "TRIAGE" }] }));
  const closed = list("Closed / Archived", {
    selectedStatuses: ["Closed / Archived", "Resolved", "Duplicate", "Accepted risk", "Informative", "Out of scope", "Spam", "N/A"],
    inboxUrl: inboxUrl + "?st=closed_archived",
    rows: [{ ...row, status: "ARCHIVED", url: url + "?st=closed_archived" }],
  });
  assert.equal(closed.reports[0].status, "ARCHIVED");
  for (const input of [{}, { report: reference, listStatus: "Pending" }, { report: reference, limit: 1 },
    { listStatus: "Pending", limit: 101 }]) {
    assert.throws(() => lookupInboxReport(input), InboxLookupError);
  }
});
