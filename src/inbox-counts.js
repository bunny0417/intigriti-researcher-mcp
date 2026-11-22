import { z } from "zod";

const inboxUrl = "https://app.intigriti.com/researcher/inbox";
const label = z.string().trim().min(1).max(100);
const labels = z.array(label).max(100);
const counter = z.string().min(1).max(100);
const observation = z.strictObject({
  inboxUrl: z.string().max(2048).describe("Unfiltered researcher inbox URL observed before reading counts."),
  menuStatuses: labels.optional().describe("Every checkbox label in the expanded Status menu. Required for a breakdown."),
  scope: z.strictObject({
    programs: z.literal("All"), search: z.literal(""), otherFilters: z.array(z.string()).max(0),
  }).describe("Confirm these list settings throughout the observation."),
  beforeCounter: counter.describe("Exact unfiltered 'X of Y items shown' text before the breakdown."),
  afterCounter: counter.describe("Exact unfiltered counter after clearing the last status."),
  readings: z.array(z.strictObject({
    selectedStatuses: labels.min(1).describe("All checked Status labels after choosing one filter, including any automatically checked children."),
    counter,
    activeFilterCount: z.literal(1).optional().describe("If supplied, copy the active filter count shown on the filter button."),
    filteredUrl: z.string().max(2048).optional().describe("Optional current filtered inbox URL observed in the browser."),
  })).max(100),
});

export const inboxCountShape = {
  statuses: labels.optional().describe("Omit to count every status shown on the portal. Use e.g. ['Pending','Triage'] for just these two, or [] for the inbox total only."),
  countsObservation: observation.optional().describe("Supply only after a live, signed-in read of the visible inbox list and filters."),
};
const argsSchema = z.strictObject(inboxCountShape);

export class InboxCountError extends Error {}

const aliases = new Map([
  ["drafts", "draft"], ["triaged", "triage"], ["in triage", "triage"],
  ["closed", "closed / archived"], ["archived", "closed / archived"],
  ["duplicates", "duplicate"],
]);
const normalize = value => value.toLowerCase().replace(/\s+/gu, " ").trim();
const requestKey = value => aliases.get(normalize(value)) ?? normalize(value);

// Each group is one portal filter. Selecting it also checks its child labels.
const statusGroups = new Map([
  ["open", ["triage", "pending"]],
  ["closed / archived", ["resolved", "duplicate", "accepted risk", "informative", "out of scope", "spam", "n/a"]],
]);

const portalFilters = [
  ["Draft", "draft"], ["Open", "open"], ["Triage", "triage"], ["Pending", "pending"],
  ["Accepted", "accepted"], ["Closed / Archived", "closed_archived"], ["Resolved", "resolved"],
  ["Duplicate", "duplicate"], ["Accepted risk", "accepted_risk"], ["Informative", "informative"],
  ["Out of scope", "out_of_scope"], ["Spam", "spam"], ["N/A", "na"],
];
const filterIdByStatus = new Map(portalFilters.map(([name, id]) => [normalize(name), id]));
const knownIds = new Set(filterIdByStatus.values());
const knownLabels = new Map(portalFilters.map(([name]) => [normalize(name), name]));

export function inboxStatusFilterUrl(requestedStatus) {
  const filter = filterIdByStatus.get(requestKey(requestedStatus));
  return filter ? inboxUrl + "?st=" + filter : undefined;
}

function distinct(items, key) {
  if (new Set(items.map(key)).size !== items.length) {
    throw new InboxCountError("Use each requested or observed status only once.");
  }
}

const numberText = "(0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+)";
const counterPattern = new RegExp("^" + numberText + "\\s+of\\s+" + numberText + "\\s+items?\\s+shown$", "i");
export function parseInboxCounter(text) {
  const match = typeof text === "string" && counterPattern.exec(text.trim().replace(/\s+/gu, " "));
  if (!match) throw new InboxCountError("Copy the full visible 'X of Y items shown' counter, including both numbers.");
  const shown = Number(match[1].replaceAll(",", ""));
  const total = Number(match[2].replaceAll(",", ""));
  if (!Number.isSafeInteger(total) || shown > total) throw new InboxCountError("The displayed inbox counter is inconsistent. Read it again.");
  return { shown, total };
}

function handoff(statuses) {
  const totalOnly = statuses?.length === 0;
  const requested = statuses && new Set(statuses.map(requestKey));
  const filterUrls = Object.fromEntries(portalFilters.filter(([name]) => !requested || requested.has(normalize(name)))
    .map(([name, id]) => [name, inboxUrl + "?st=" + id]));
  return {
    status: "awaiting_inbox_read", nextAction: "read_inbox_list", openUrl: inboxUrl, hostTools: ["@Chrome", "@Computer"],
    requestedStatuses: statuses ?? "all",
    instructions: [
      "Open openUrl in a separate tab with @Chrome, or use @Computer if available. Follow the control's own instructions. Let the researcher handle sign-in. Stay on the inbox list. Do not open reports, drafts, messages or history.",
      "Clear active filters in this tab. Use Programs: All and an empty search. Read only the search value, filter controls and 'X of Y items shown' counter. Use scoped browser reads. If the control needs an accessibility snapshot, extract only those controls and counters before printing any output. Do not print the whole inbox or enumerate report rows for counts.",
      ...(totalOnly ? [] : [
        "Open Show filters > Status and copy every label as menuStatuses. From a clear filter, choose one requested label at a time (every label for all). You may use filterUrls in the browser for labels present in the menu. Confirm the actual selection each time. Open and Closed / Archived also check their children automatically. After the list settles, copy the counter and all checked labels. Omit unreadable readings; use zero only when shown.",
      ]),
      "Return to the unfiltered list and read the ending counter. Call this tool again with the same statuses and countsObservation. If sign-in, the list or its counters cannot be verified, report what is unavailable.",
    ],
    ...(!totalOnly && { filterUrls }),
    observationFields: { inboxUrl: "observed clean inbox URL", scope: { programs: "All", search: "", otherFilters: [] },
      ...(totalOnly ? {} : { menuStatuses: "complete visible Status checkbox labels" }),
      beforeCounter: "unfiltered counter", afterCounter: "ending unfiltered counter",
      readings: totalOnly ? [] : [{ selectedStatuses: ["all checked labels for this single filter"], counter: "observed filtered counter" }] },
  };
}

function checkFilteredUrl(url, status) {
  // The portal manages its own filter slugs. Reject report URLs and combined filters.
  const match = /^https:\/\/app\.intigriti\.com\/researcher\/inbox\/?\?st=([a-zA-Z0-9_-]+)$/.exec(url);
  if (!match || match[0] !== url) {
    throw new InboxCountError("A filtered URL must identify the researcher inbox with one Status filter only.");
  }
  const expectedId = filterIdByStatus.get(normalize(status));
  if (expectedId ? expectedId !== match[1] : knownIds.has(match[1])) {
    throw new InboxCountError("The filtered inbox URL does not match the selected Status checkbox.");
  }
  return match[1];
}

function selectedFilter(selected, menuByKey) {
  const checked = selected.map(normalize);
  if (checked.some(key => !menuByKey.has(key)) || new Set(checked).size !== checked.length) {
    throw new InboxCountError("Read the checked labels from the current Status menu.");
  }
  const group = checked.find(key => statusGroups.has(key));
  if (group) {
    const children = statusGroups.get(group);
    if (children.length + 1 === checked.length && children.every(key => checked.includes(key))) return group;
  } else if (checked.length === 1) {
    return checked[0];
  }
  throw new InboxCountError("Clear the filters and select one status. Copy every checkbox it selects, including automatic group children.");
}

// The list exposes the applied filter in both the URL and the checked controls.
export function verifyInboxStatusFilter(requestedStatus, selectedStatuses, filteredUrl) {
  const checked = labels.min(1).safeParse(selectedStatuses);
  if (!checked.success || !label.safeParse(requestedStatus).success) {
    throw new InboxCountError("Copy the requested Status and the actual checked labels from the inbox list.");
  }
  const observed = new Map(checked.data.map(name => [normalize(name), name]));
  const key = selectedFilter(checked.data, observed);
  if (key !== requestKey(requestedStatus) && key !== normalize(requestedStatus)) {
    throw new InboxCountError("The checked Status filter differs from the requested listing.");
  }
  const status = knownLabels.get(key) ?? observed.get(key);
  checkFilteredUrl(filteredUrl, status);
  const allowedRowStatuses = [status, ...(statusGroups.get(key) ?? []).map(child => knownLabels.get(child))];
  if (key === "closed / archived") allowedRowStatuses.push("Closed", "Archived");
  return { status, allowedRowStatuses };
}

export function previewInboxCounts(input = {}) {
  const parsed = argsSchema.safeParse(input);
  if (!parsed.success) throw new InboxCountError("Check the count request. Use one applied Status filter per reading with its checked labels, Programs: All, an empty search and no other filters.");
  const { statuses, countsObservation: observed } = parsed.data;
  if (statuses) distinct(statuses, requestKey);
  if (!observed) return handoff(statuses);
  if (observed.inboxUrl !== inboxUrl && observed.inboxUrl !== inboxUrl + "/") {
    throw new InboxCountError("Start and finish on the unfiltered Intigriti researcher inbox list.");
  }
  const before = parseInboxCounter(observed.beforeCounter);
  const after = parseInboxCounter(observed.afterCounter);
  if (before.shown !== before.total || after.shown !== after.total || before.total !== after.total) {
    throw new InboxCountError("The unfiltered inbox total changed or a filter was active. Clear filters and repeat the read.");
  }
  const menu = observed.menuStatuses ?? [];
  if (!menu.length && statuses?.length !== 0) throw new InboxCountError("Read all Status checkbox labels before reporting a breakdown.");
  distinct(menu, normalize);
  const menuByKey = new Map(menu.map(value => [normalize(value), value]));
  const requested = statuses ?? menu;
  const targetLabels = [];
  const unavailableStatuses = [];
  for (const name of requested) {
    const portalLabel = menuByKey.get(normalize(name)) ?? menuByKey.get(requestKey(name));
    if (portalLabel) targetLabels.push(portalLabel);
    else unavailableStatuses.push(name);
  }
  const countsByLabel = new Map();
  const observedFilterIds = new Set();
  for (const reading of observed.readings) {
    const observedLabel = menuByKey.get(selectedFilter(reading.selectedStatuses, menuByKey));
    if (!targetLabels.includes(observedLabel) || countsByLabel.has(observedLabel)) {
      throw new InboxCountError("A count was duplicated or did not correspond to a requested Status checkbox.");
    }
    if (reading.filteredUrl) {
      const filterId = checkFilteredUrl(reading.filteredUrl, observedLabel);
      if (observedFilterIds.has(filterId)) throw new InboxCountError("Two status readings used the same filtered inbox URL.");
      observedFilterIds.add(filterId);
    }
    const { shown, total } = parseInboxCounter(reading.counter);
    if (total !== before.total) throw new InboxCountError("The inbox total changed during filtering. Repeat the read before reporting counts.");
    countsByLabel.set(observedLabel, shown);
  }
  const unobservedStatuses = targetLabels.filter(value => !countsByLabel.has(value));
  const counts = [];
  const groups = [];
  for (const status of targetLabels) {
    if (!countsByLabel.has(status)) continue;
    const count = countsByLabel.get(status);
    const children = statusGroups.get(normalize(status));
    if (children) groups.push({ status, count, includesStatuses: children.map(key => menuByKey.get(key)) });
    else counts.push({ status, count });
  }
  return {
    status: unavailableStatuses.length || unobservedStatuses.length ? "counts_partial" : "counts_read",
    inboxUrl, totalReports: before.total,
    counts, groups, unobservedStatuses, unavailableStatuses,
  };
}
