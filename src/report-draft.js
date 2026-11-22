import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export class ReportDraftError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ReportDraftError";
    if (code) this.code = code;
  }
}

const origin = "https://app.intigriti.com";
const guidPart = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const programPath = /^\/(?:researcher\/)?programs\/([a-z0-9._~-]+)\/([a-z0-9._~-]+)(?:\/detail)?\/?$/i;
const draftPath = new RegExp("^/researcher/(?:inbox/)?submissions/draft/(" + guidPart + ")/(" + guidPart + ")/create$", "i");
const maxAttachments = 32;
const maxSnapshotBytes = 4 * 1024 * 1024;
// The browser counts UTF-16 code units. Zod's JSON Schema length counts Unicode code points.
const shortText = (limit) => z.string().min(1).max(limit).refine(value => value.length <= limit && value.trim().length > 0);
const questions = z.array(z.strictObject({ question: shortText(1024), answer: shortText(8192) })).max(32);

const fieldShape = {
  title: shortText(100).optional(),
  description: shortText(30_000).describe("Researcher-supplied proof of concept or report body.").optional(),
  impact: shortText(15_000).optional(),
  asset: shortText(1024).optional(),
  vulnerabilityType: shortText(1024).optional(),
  severity: shortText(128).optional(),
  endpoint: shortText(1000).optional(),
  remediation: shortText(15_000).optional(),
  testingIp: shortText(256).optional(),
  aiDisclosure: shortText(2000).optional(),
  questions: questions.optional(),
};

export const reportDraftShape = {
  draftId: z.uuid().describe("Identifier of an immutable local snapshot. Resume it by ID. Use check mode after approval to verify and bind the observed destination.").optional(),
  programUrl: z.string().min(1).max(2048).describe("Intigriti program detail URL. Supply programUrl or draftUrl for a new snapshot.").optional(),
  draftUrl: z.string().min(1).max(2048).describe("Exact signed-in Intigriti draft edit URL observed in the official browser UI.").optional(),
  ...fieldShape,
  attachments: z.array(z.string().min(1).max(32767)).max(maxAttachments)
    .describe("Files the researcher selected. Use Downloads/filename when they name a file in Downloads. Otherwise use the full local path. The review shows the resolved path.").optional(),
  expectedTitle: shortText(100).describe("Existing draft title to match in the browser before editing. This value is never written to the portal.").optional(),
};

const inputSchema = z.strictObject(reportDraftShape);
const attachmentRecord = z.strictObject({
  path: z.string().min(1).max(32767), name: z.string().min(1).max(1024),
  size: z.int().positive().max(1_000_000_000),
  device: z.string(), inode: z.string(), modified: z.string(), changed: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
const snapshotSchema = z.strictObject({
  version: z.literal(1), draftId: z.uuid(),
  programUrl: reportDraftShape.programUrl, draftUrl: reportDraftShape.draftUrl,
  expectedTitle: reportDraftShape.expectedTitle,
  fields: z.strictObject(fieldShape),
  attachments: z.array(attachmentRecord).max(maxAttachments),
});

function validatedLink(value, pattern, label) {
  if (value === undefined) return undefined;
  // Match the original path before URL parsing can discard dot segments, queries or credentials.
  const route = value.startsWith(origin + "/") ? value.slice(origin.length) : "";
  const match = pattern.exec(route);
  if (!match || match[0] !== route || match.slice(1).some(part => part === "." || part === "..")) {
    throw new ReportDraftError(`Expected an exact Intigriti ${label} URL without credentials, query parameters or fragments.`);
  }
  return match;
}

function canonicalDraftUrl(value) {
  if (value === undefined) return undefined;
  const query = value.indexOf("?");
  let editUrl = value;
  if (query >= 0) {
    // The filtered inbox appends one company/program slug pair. It is navigation state.
    const suffix = value.slice(query);
    const match = /^\?program=([A-Za-z0-9._~-]+)(?:%2[Ff]|\/)([A-Za-z0-9._~-]+)$/.exec(suffix);
    if (!match || match[0] !== suffix || match.slice(1).some(part => part === "." || part === "..")) {
      throw new ReportDraftError("Draft edit links may only include a single company/program inbox filter.");
    }
    editUrl = value.slice(0, query);
  }
  return origin + validatedLink(editUrl, draftPath, "draft edit")[0];
}

function location(programUrl, draftUrl) {
  const program = validatedLink(programUrl, programPath, "program detail");
  const draft = canonicalDraftUrl(draftUrl);
  if (!program && !draft) throw new ReportDraftError("Provide programUrl or an observed draftUrl.");
  return {
    ...(program && { programUrl: origin + "/programs/" + program[1] + "/" + program[2] + "/detail" }),
    ...(draft && { draftUrl: draft }),
  };
}

function sameDraft(first, second) {
  const ids = url => validatedLink(url, draftPath, "draft edit").slice(1).join("/").toLowerCase();
  return ids(first) === ids(second);
}

export { location as canonicalReportLinks };

function validateFields(fields, draftUrl, attachments) {
  if (draftUrl && attachments?.length && Object.keys(fields).length === 0) return;
  if (!fields.title || !fields.description) throw new ReportDraftError("A new snapshot requires a title and a description.");
  if (fields.aiDisclosure && (fields.description + "\n\nAI disclosure: " + fields.aiDisclosure).length > 30_000) {
    throw new ReportDraftError("The description and appended AI disclosure exceed the form's 30,000-character limit.");
  }
  return fields;
}

function checkLocalPath(value) {
  const windows = process.platform === "win32";
  if (!path.isAbsolute(value) || /^[\\/]{2}/.test(value) || /[\x00-\x1f\x7f]/.test(value) ||
      (windows && (!/^[a-z]:[\\/]/i.test(value) || /[:*?"<>|]/.test(value.slice(2))))) {
    throw new ReportDraftError("Use an absolute local path without a network share, URL or device name.");
  }
  const parts = value.slice(path.parse(value).root.length).split(windows ? /[\\/]/ : "/").filter(Boolean);
  if (parts.some(part => part === "." || part === ".." ||
    (windows && (/[. ]$/.test(part) || /^(?:CON|NUL|PRN|AUX|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))))) {
    throw new ReportDraftError("Use a direct local path without traversal or device names.");
  }
  return parts;
}

function checkEvidencePath(value) {
  const parts = checkLocalPath(value);
  const privateComponent = /^(?:\.env(?:rc|[.-].*)?|\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.codex|\.intigriti-researcher-mcp|\.npmrc|[._]netrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|(?:credentials?|secrets?)(?:\..*)?)$/i;
  if (parts.some(part => privateComponent.test(part)) || /\.(?:pem|key|pfx|p12|kdbx)$/i.test(path.basename(value))) {
    throw new ReportDraftError("Credential and secret paths cannot be selected as report attachments.");
  }
}

async function verifiedDirectory(value, create) {
  const parts = checkLocalPath(value);
  let current = path.parse(value).root;
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT" || !create) throw error;
      try { await mkdir(current, { mode: 0o700 }); } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ReportDraftError("Use a directory path without symbolic links or junctions.");
  }
  return current;
}

// Keep one draft's worth of recent digests. The picker can change ctime on an
// otherwise identical file. Every new ctime requires reading the bytes again.
const recentDigests = new Map();

function sameFileVersion(first, second) {
  return second.isFile() && second.nlink === 1n && first.dev === second.dev &&
    first.ino === second.ino && first.size === second.size &&
    first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

async function evidenceDigest(actual, info) {
  const cached = recentDigests.get(actual);
  if (info.ino !== 0n && cached && sameFileVersion(info, cached.info)) return cached.digest;

  const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFileVersion(info, await file.stat({ bigint: true }))) {
      throw new ReportDraftError("An attachment changed while it was being checked.");
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = file.createReadStream({ autoClose: false, end: Number(info.size) - 1, highWaterMark: 256 * 1024 });
    for await (const chunk of stream) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    if (bytes !== Number(info.size) || !sameFileVersion(info, await file.stat({ bigint: true }))) {
      throw new ReportDraftError("An attachment changed while it was being checked.");
    }
    const digest = hash.digest("hex");
    recentDigests.delete(actual);
    if (recentDigests.size >= maxAttachments) recentDigests.delete(recentDigests.keys().next().value);
    recentDigests.set(actual, { info, digest });
    return digest;
  } finally {
    await file.close();
  }
}

async function evidence(value) {
  checkEvidencePath(value);
  await verifiedDirectory(path.dirname(value), false);
  const info = await lstat(value, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
    throw new ReportDraftError("Select a regular attachment file without symbolic links, junctions or hard links.");
  }
  const actual = await realpath(value);
  checkEvidencePath(actual);
  await access(actual, constants.R_OK);
  const image = /\.(?:png|jpe?g|gif)$/i.test(path.basename(actual));
  if (info.size <= 0n) throw new ReportDraftError("An attachment is empty.");
  if (info.size > (image ? 10_000_000n : 1_000_000_000n)) {
    throw new ReportDraftError("An attachment exceeds the platform limit of 10 MB for PNG/JPEG/GIF or 1 GB for other files.");
  }
  const sha256 = await evidenceDigest(actual, info);
  if (!sameFileVersion(info, await lstat(value, { bigint: true }))) {
    throw new ReportDraftError("An attachment changed while its metadata was being checked.");
  }
  const name = path.basename(actual);
  return { path: actual, name, size: Number(info.size), device: String(info.dev), inode: String(info.ino),
    modified: String(info.mtimeNs), changed: String(info.ctimeNs), sha256 };
}

async function inspectAttachments(paths) {
  const names = new Set();
  const records = [];
  for (const [index, value] of paths.entries()) {
    try {
      // A named file in the user's standard Downloads folder needs no search.
      const download = /^(?:~[\\/])?Downloads[\\/]([^\\/]+)$/u.exec(value);
      const input = process.platform === "win32" && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
      if (download && [".", ".."].includes(download[1])) throw new ReportDraftError("Specify a filename in Downloads.");
      const record = await evidence(download ? path.join(homedir(), "Downloads", download[1]) : input);
      const key = record.name.normalize("NFC").toLowerCase();
      if (names.has(key)) throw new ReportDraftError("Each attachment must have a distinct filename.");
      names.add(key);
      records.push(record);
    } catch (error) {
      const detail = error instanceof ReportDraftError ? error.message : "The file is missing or unreadable. On Windows, right-click the file, choose Copy as path, and paste it into the chat.";
      throw new ReportDraftError(`Attachment ${index + 1}: ${detail}`, "evidence_invalid");
    }
  }
  return records;
}

export async function publishJson(destination, data) {
  const body = JSON.stringify(data);
  if (Buffer.byteLength(body, "utf8") > maxSnapshotBytes) throw new ReportDraftError("The local draft exceeds the snapshot size limit.");
  const temporary = destination + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A hard link publishes the complete record without replacing an existing snapshot or binding.
    await link(temporary, destination);
  } finally {
    await unlink(temporary);
  }
}

export async function readJson(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxSnapshotBytes) {
    throw new ReportDraftError("The local draft record is invalid.");
  }
  function requirePrivate(record) {
    if (process.platform !== "win32" && (record.uid !== process.getuid() || (record.mode & 0o077) !== 0)) {
      throw new ReportDraftError("The local draft record must belong to your account and be private (0600).");
    }
  }
  requirePrivate(info);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const current = await handle.stat();
    if (info.dev !== current.dev || info.ino !== current.ino || !current.isFile() || current.size > maxSnapshotBytes) {
      throw new ReportDraftError("The local draft record changed while opening it.");
    }
    requirePrivate(current);
    const body = await handle.readFile("utf8");
    try { return JSON.parse(body); } catch {
      throw new ReportDraftError("The local draft record contains invalid JSON.");
    }
  } finally {
    await handle.close();
  }
}

// Publishing on an exclusive link makes the first observation win across processes.
// Always read the winning record, even if this call lost the race.
async function linkRecord(file, proposed) {
  try { return await readJson(file); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!proposed) return undefined;
  try { await publishJson(file, proposed); } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return readJson(file);
}

function checkPair(first, second) {
  if (first && second && !sameDraft(first, second)) {
    throw new ReportDraftError("This snapshot already refers to a different platform draft.");
  }
}

async function binding(snapshot, dir, observed) {
  const original = location(snapshot.programUrl, snapshot.draftUrl);
  if (observed) {
    if (!observed.draftUrl) throw new ReportDraftError("Binding requires the observed draft URL.");
    if (original.programUrl && original.programUrl !== observed.programUrl) {
      throw new ReportDraftError("The observed program must match the original program URL before binding.");
    }
    checkPair(original.draftUrl, observed.draftUrl);
  }
  const recordPath = path.join(dir, snapshot.draftId + ".link.json");
  const proposed = observed?.programUrl ? { version: 2, ...observed } : undefined;
  let record = await linkRecord(recordPath, proposed);
  if (record === undefined) return original.draftUrl ? { draftUrl: original.draftUrl } : {};
  const invalid = () => new ReportDraftError("The local draft link record is invalid.");
  if (typeof record?.draftUrl !== "string") throw invalid();
  const firstDraft = canonicalDraftUrl(record.draftUrl);
  checkPair(original.draftUrl, firstDraft);
  checkPair(observed?.draftUrl, firstDraft);
  if (record.version === 1) {
    // Old installations saved a draft pair without verifying the program.
    // Keep its original pair immutable while recording a positive observation separately.
    record = await linkRecord(path.join(dir, snapshot.draftId + ".verified-link.json"), proposed);
    if (record === undefined) {
      return original.draftUrl ? { draftUrl: original.draftUrl } : { unverifiedDraftUrl: firstDraft };
    }
  }
  if (record?.version !== 2 || typeof record.programUrl !== "string" || typeof record.draftUrl !== "string") throw invalid();
  const checked = location(record.programUrl, record.draftUrl);
  checkPair(checked.draftUrl, firstDraft);
  if ((original.programUrl && checked.programUrl !== original.programUrl) ||
      (observed?.programUrl && checked.programUrl !== observed.programUrl)) {
    throw new ReportDraftError("The bound program does not match this draft's program.");
  }
  return { draftUrl: original.draftUrl ?? firstDraft, boundProgramUrl: checked.programUrl };
}

function result(snapshot, draftPath, links) {
  const { draftId, programUrl, fields, attachments } = snapshot;
  return { status: "prepared_locally", draftId, draftPath, ...(programUrl && { programUrl, sourceProgramUrl: programUrl }), ...links,
    ...(snapshot.expectedTitle && { expectedTitle: snapshot.expectedTitle }),
    fields, attachments: attachments.map(({ path, name, size }) => ({ path, name, size })),
    missingFields: Object.keys(fields).length ? ["asset", "vulnerabilityType", "severity", "impact"].filter(key => !fields[key]) : [] };
}

export async function privateStore(directory, create) {
  const dir = await verifiedDirectory(directory, create);
  if (process.platform !== "win32") {
    const info = await lstat(dir);
    if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new ReportDraftError("The local draft directory must belong to your account and have mode 0700.");
    }
  }
  return dir;
}

const defaultDirectory = () => path.join(homedir(), ".intigriti-researcher-mcp", "drafts");

async function restore(draftId, directory, { verifyFiles, observed }) {
  if (!z.uuid().safeParse(draftId).success) throw new ReportDraftError("Invalid local draft ID.");
  try {
    const dir = await privateStore(directory, false);
    const id = draftId.toLowerCase();
    const file = path.join(dir, id + ".json");
    const saved = snapshotSchema.safeParse(await readJson(file));
    if (!saved.success || saved.data.draftId !== id) throw new ReportDraftError("The local draft record is invalid.");
    const snapshot = saved.data;
    validateFields(snapshot.fields, snapshot.draftUrl, snapshot.attachments);
    if (verifyFiles) {
      const current = await inspectAttachments(snapshot.attachments.map(item => item.path));
      for (const [i, record] of current.entries()) {
        const savedFile = snapshot.attachments[i];
        const matches = savedFile.path === record.path && savedFile.name === record.name &&
          savedFile.size === record.size && savedFile.device === record.device &&
          savedFile.inode === record.inode && savedFile.modified === record.modified &&
          (savedFile.sha256 ? savedFile.sha256 === record.sha256 : savedFile.changed === record.changed);
        if (!matches) {
          throw new ReportDraftError(`Attachment ${i + 1}: the attachment changed since preparation. Review a new snapshot with the intended files.`, "evidence_invalid");
        }
      }
    }
    return result(snapshot, file, await binding(snapshot, dir, observed));
  } catch (error) {
    if (error instanceof ReportDraftError) throw error;
    if (error.code === "ENOENT") throw new ReportDraftError("Local draft snapshot was not found.", "draft_not_found");
    throw new ReportDraftError("Could not read or bind the local draft record. Check its directory and permissions.");
  }
}

const observationSchema = z.strictObject({
  draftUrl: z.string().min(1).max(2048), programUrl: reportDraftShape.programUrl,
});

export async function bindReportDraft(draftId, observation, { directory = defaultDirectory() } = {}) {
  const checked = observationSchema.safeParse(observation);
  if (!checked.success) throw new ReportDraftError("Binding requires an observed Intigriti draft URL and, for a program-first report, the observed program URL.");
  const { programUrl, draftUrl } = checked.data;
  return restore(draftId, directory, { verifyFiles: true, observed: location(programUrl, draftUrl) });
}

// Finish verifies a host observation against the immutable approved metadata.
// All paths that can hand off a file for upload use the live evidence checks.
export function readDraftForReceipt(draftId, { directory = defaultDirectory() } = {}) {
  return restore(draftId, directory, { verifyFiles: false });
}

export async function prepareReportDraft(args, { directory = defaultDirectory() } = {}) {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) throw new ReportDraftError("Invalid draft inputs. Check the field types and length limits.");
  const { draftId, programUrl, draftUrl, attachments, expectedTitle, ...fields } = parsed.data;
  try {
    if (draftId) {
      if (Object.keys(parsed.data).length !== 1) throw new ReportDraftError("Resume with draftId alone. Use check mode with the approved handoff to bind an observed destination.");
      return await restore(draftId, directory, { verifyFiles: true });
    }
    const links = location(programUrl, draftUrl);
    if (expectedTitle && !draftUrl) throw new ReportDraftError("An expected title requires an existing draft link.");
    validateFields(fields, draftUrl, attachments);
    const evidence = await inspectAttachments(attachments ?? []);
    const dir = await privateStore(directory, true);
    const id = randomUUID();
    const file = path.join(dir, id + ".json");
    const snapshot = { version: 1, draftId: id, ...links, ...(expectedTitle && { expectedTitle }), fields, attachments: evidence };
    await publishJson(file, snapshot);
    return result(snapshot, file, links.draftUrl ? { draftUrl: links.draftUrl } : {});
  } catch (error) {
    if (error instanceof ReportDraftError) throw error;
    if (error.code === "ENOENT" && draftId) throw new ReportDraftError("Local draft snapshot was not found.");
    throw new ReportDraftError("Could not read or write the local draft record. Check the draft directory and its permissions.");
  }
}
