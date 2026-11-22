import assert from "node:assert/strict";
import test from "node:test";
import { getInboxCounts, InboxCountError, parseInboxCounter } from "../src/inbox-counts.js";

const inboxUrl = "https://app.intigriti.com/researcher/inbox";
const menu = ["Draft", "Triage", "Pending", "Closed / Archived", "Additional portal status"];
const observation = {
  inboxUrl, scope: { programs: "All", search: "", otherFilters: [] },
  menuStatuses: menu, beforeCounter: "1,234 of 1,234 items shown", afterCounter: "1234 of 1234 items shown",
  readings: [
    { selectedStatuses: ["Triage"], counter: "0 of 1,234 items shown" },
    { selectedStatuses: ["Pending"], counter: "17  of  1,234   items   shown", activeFilterCount: 1, filteredUrl: inboxUrl + "?st=pending" },
  ],
};

test("start directs Codex to a list-only browser read; an ordinary request cannot produce counts", () => {
  const start = getInboxCounts();
  assert.equal(start.openUrl, inboxUrl);
  assert.deepEqual(start.hostTools, ["@Chrome", "@Computer"]);
  assert.equal(start.requestedStatuses, "all");
  assert.equal(start.counts, undefined);
  assert.match(start.instructions.join(" "), /Do not open reports/);
  assert.deepEqual(getInboxCounts({ statuses: [] }).observationFields.readings, []);
  assert.throws(() => getInboxCounts({ statuses: ["triaged", "Triage"] }), InboxCountError);
});

test("uses the visible filtered counter, accounts for zeros and retains the account-wide denominator", () => {
  const result = getInboxCounts({ statuses: ["Pending", "triaged"], countsObservation: observation });
  assert.equal(result.status, "counts_read");
  assert.equal(result.totalReports, 1234);
  assert.deepEqual(result.counts, [{ status: "Pending", count: 17 }, { status: "Triage", count: 0 }]);
  assert.deepEqual(result.unobservedStatuses, []);
  assert.deepEqual(result.unavailableStatuses, []);
});

test("all statuses come from the menu; an unread or unavailable filter never appears as zero", () => {
  const partial = getInboxCounts({ countsObservation: observation });
  assert.equal(partial.status, "counts_partial");
  assert.deepEqual(partial.unobservedStatuses, ["Draft", "Closed / Archived", "Additional portal status"]);
  const extra = { selectedStatuses: ["Additional portal status"], counter: "1 of 1,234 items shown" };
  const targeted = getInboxCounts({ statuses: ["Additional portal status", "Obsolete"],
    countsObservation: { ...observation, readings: [extra] } });
  assert.deepEqual(targeted.counts, [{ status: "Additional portal status", count: 1 }]);
  assert.deepEqual(targeted.unavailableStatuses, ["Obsolete"]);
  assert.equal(targeted.status, "counts_partial");
  const total = getInboxCounts({ statuses: [], countsObservation: {
    ...observation, menuStatuses: undefined, readings: [], beforeCounter: "0 of 0 items shown", afterCounter: "0 of 0 items shown",
  } });
  assert.equal(total.status, "counts_read");
  assert.equal(total.totalReports, 0);
});

test("rejects partial-scope counters, duplicate observations and drifting totals", () => {
  const [triage, pending] = observation.readings;
  for (const change of [
    { inboxUrl: inboxUrl + "/submissions/example" }, { inboxUrl: inboxUrl + "?st=pending" },
    { scope: { ...observation.scope, search: "specific program" } },
    { scope: { ...observation.scope, programs: "A program" } },
    { scope: { ...observation.scope, otherFilters: ["severity"] } },
    { menuStatuses: ["Triage", "triage"] }, { readings: [triage, triage] },
    { readings: [{ ...triage, selectedStatuses: ["Triage", "Draft"] }] },
    { readings: [{ ...triage, activeFilterCount: 2 }] },
    { readings: [{ ...triage, selectedStatuses: ["wrong status"] }] },
    { readings: [{ ...triage, filteredUrl: pending.filteredUrl }] },
    { readings: [{ ...pending, filteredUrl: inboxUrl + "?st=pending&severity=high" }] },
    { readings: [{ ...pending, filteredUrl: inboxUrl + "?st=pending%2Ctriage" }] },
    { readings: [{ ...triage, counter: "1 of 1232 items shown" }] },
    { beforeCounter: "2 of 1234 items shown" }, { afterCounter: "1233 of 1233 items shown" },
  ]) {
    assert.throws(() => getInboxCounts({ countsObservation: { ...observation, ...change } }), InboxCountError);
  }
});

test("rejects approximations, malformed grouping and impossible counts", () => {
  assert.deepEqual(parseInboxCounter(" 1 of 1 item shown "), { shown: 1, total: 1 });
  for (const raw of ["about 12", "1 of 2", "3 of 2 items shown", "0 of 2,00 items shown",
    "-1 of 2 items shown", "0 of 9007199254740992 items shown", "1 of 2 items shown secret", null]) {
    assert.throws(() => parseInboxCounter(raw), InboxCountError);
  }
});

test("the two portal group selections are accepted as single filters and kept out of leaf counts", () => {
  const closed = ["Resolved", "Duplicate", "Accepted risk", "Informative", "Out of scope", "Spam", "N/A"];
  const completeMenu = ["Draft", "Open", "Triage", "Pending", "Accepted", "Closed / Archived", ...closed];
  const readings = [
    { selectedStatuses: ["Pending", "Open", "Triage"], counter: "13 of 24 items shown", filteredUrl: inboxUrl + "?st=open", activeFilterCount: 1 },
    { selectedStatuses: ["Closed / Archived", ...closed], counter: "9 of 24 items shown", filteredUrl: inboxUrl + "?st=closed_archived" },
    { selectedStatuses: ["Resolved"], counter: "2 of 24 items shown", filteredUrl: inboxUrl + "?st=resolved" },
  ];
  const fixture = { ...observation, beforeCounter: "24 of 24 items shown", afterCounter: "24 of 24 items shown", menuStatuses: completeMenu, readings };
  const request = { statuses: ["Open", "Archived", "Resolved"], countsObservation: fixture };
  const result = getInboxCounts(request);
  assert.equal(result.status, "counts_read");
  assert.equal(result.totalReports, 24);
  assert.deepEqual(result.groups, [
    { status: "Open", count: 13, includesStatuses: ["Triage", "Pending"] },
    { status: "Closed / Archived", count: 9, includesStatuses: closed },
  ]);
  assert.deepEqual(result.counts, [{ status: "Resolved", count: 2 }]);
  for (const bad of [
    { ...readings[0], selectedStatuses: ["Open"] },
    { ...readings[0], selectedStatuses: ["Open", "Pending", "Resolved"] },
    { ...readings[0], selectedStatuses: ["Open", "Triage", "Pending", "Pending"] },
    { ...readings[1], filteredUrl: inboxUrl + "?st=resolved" },
    { ...readings[2], filteredUrl: inboxUrl + "?st=open" },
  ]) assert.throws(() => getInboxCounts({ ...request, countsObservation: { ...fixture, readings: [bad] } }), InboxCountError);
});
