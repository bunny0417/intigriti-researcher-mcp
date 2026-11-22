import { z } from "zod";

// The researcher API describes identifiers as .NET GUIDs.
const guidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const guid = z.string().regex(guidPattern).toLowerCase();
const label = z.string().max(256);
const enumeration = z.object({ id: z.int32(), value: label });
const money = z.object({ value: z.number(), currency: z.string().min(1).max(32) });
const publicLevel = 4;
const appOrigin = "https://app.intigriti.com";
const programPath = /^\/(?:researcher\/)?programs\/[a-z0-9._~-]+\/[a-z0-9._~-]+(?:\/detail)?\/?$/i;

export class ViewError extends Error {
  constructor() {
    super("Intigriti returned data in an unexpected format.");
    this.name = "ViewError";
    this.code = "invalid_upstream_response";
  }
}

function parse(schema, raw) {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ViewError();
  return result.data;
}

export function isVisible(raw, allowedIds = new Set()) {
  if (typeof raw?.id !== "string" || !guidPattern.test(raw.id)) return false;
  if (allowedIds.has(raw.id.toLowerCase())) return true;
  const level = raw.confidentialityLevel;
  return level?.id === publicLevel && level.value === "Public";
}

function appUrl(value) {
  if (!value) return null;
  if (!value.startsWith("/") && !URL.canParse(value)) return null;
  if (!URL.canParse(value, appOrigin)) return null;
  const url = new URL(value, appOrigin);
  return url.origin === appOrigin && !url.username && !url.password ? url : null;
}

function programLink(value) {
  let url = appUrl(value);
  if (url?.pathname === "/auth/dashboard") {
    // Researcher API links may wrap the program path in a dashboard redirect.
    url = appUrl(url.searchParams.get("redirect"));
  }
  return url && programPath.test(url.pathname) ? appOrigin + url.pathname : null;
}

const program = z.object({
  id: guid,
  name: z.string().max(1024),
  handle: label,
  following: z.boolean(),
  confidentialityLevel: enumeration,
  status: enumeration,
  type: enumeration,
  industry: label.nullable(),
  webLinks: z.object({ detail: z.string().transform(programLink) }),
});
const card = program.extend({ minBounty: money, maxBounty: money });

export function programCard(raw) {
  return parse(card, raw);
}

const version = z.object({ id: guid, createdAt: z.int() });
const scopeEntry = z.object({ type: enumeration, tier: enumeration });

export function scopeVersion(rawVersion) {
  const { id, createdAt } = parse(version, rawVersion);
  const { content } = rawVersion;
  if (content === null) return { id, createdAt, content: null };
  if (!Array.isArray(content)) throw new ViewError();

  const groups = new Map();
  for (const entry of content) {
    const { type, tier } = parse(scopeEntry, entry);
    const key = JSON.stringify([type, tier]);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { type, tier, count: 1 });
  }
  return { id, createdAt, content: { total: content.length, groups: [...groups.values()] } };
}

const requirements = z.object({
  intigritiMe: z.boolean(),
  automatedTooling: z.int32().nullable(),
  userAgent: z.string().nullable(),
  requestHeader: z.string().nullable(),
});
const rules = version.extend({
  content: z.object({
    description: z.string(),
    testingRequirements: requirements,
    safeHarbour: z.boolean(),
  }).nullable(),
});

export function rulesVersion(rawVersion) {
  const result = parse(rules, rawVersion);
  const { content } = result;
  if (content === null) return result;

  // Zod projected fresh objects. Keep the upstream response untouched.
  const truncatedFields = [];
  function bounded(value, limit, field) {
    if (value === null || value.length <= limit) return value;
    truncatedFields.push(field);
    return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "");
  }

  content.description = bounded(content.description, 12000, "description");
  for (const field of ["userAgent", "requestHeader"]) {
    const key = "testingRequirements." + field;
    content.testingRequirements[field] = bounded(content.testingRequirements[field], 1024, key);
  }
  content.truncatedFields = truncatedFields;
  return result;
}

export function programDetail(raw) {
  const summary = parse(program, raw);
  return {
    ...summary,
    domains: scopeVersion(raw.domains),
    rulesOfEngagement: raw.rulesOfEngagement === null ? null : rulesVersion(raw.rulesOfEngagement),
  };
}

// The API documents these version references on certain activity variants.
// Other variants can contain unrelated or private fields.
const activity = z.object({
  programId: guid,
  type: enumeration,
  createdAt: z.int(),
  following: z.boolean(),
  activity: z.object({
    fromVersionId: guid.nullable().default(null),
    toVersionId: guid.nullable().default(null),
  }),
});

export function activityRecord(raw) {
  return parse(activity, raw);
}

const payout = z.object({
  id: z.string().min(1).max(256),
  amount: money,
  status: enumeration,
  createdAt: z.int(),
  paidAt: z.int().nullable(),
});

export function payoutRecord(raw) {
  return parse(payout, raw);
}
