import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export class ReportDraftError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReportDraftError";
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
  draftId: z.uuid().describe("Resume an immutable local snapshot. Supply only this ID, optionally with the observed draftUrl to associate it once.").optional(),
  programUrl: z.string().min(1).max(2048).describe("Intigriti program detail URL. Supply programUrl or draftUrl for a new snapshot.").optional(),
  draftUrl: z.string().min(1).max(2048).describe("Exact signed-in Intigriti draft edit URL observed in the official browser UI.").optional(),
  ...fieldShape,
  attachments: z.array(z.string().min(1).max(32767)).max(maxAttachments)
    .describe("Absolute paths to evidence files explicitly selected by the researcher. Only metadata is recorded.").optional(),
};

const inputSchema = z.strictObject(reportDraftShape);
const attachmentRecord = z.strictObject({
  path: z.string().min(1).max(32767), name: z.string().min(1).max(1024),
  size: z.int().positive().max(1_000_000_000),
  device: z.string(), inode: z.string(), modified: z.string(), changed: z.string(),
});
const snapshotSchema = z.strictObject({
  version: z.literal(1), draftId: z.uuid(),
  programUrl: reportDraftShape.programUrl, draftUrl: reportDraftShape.draftUrl,
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

function validateFields(fields) {
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
  const after = await lstat(value, { bigint: true });
  if (!after.isFile() || after.dev !== info.dev || after.ino !== info.ino || after.ctimeNs !== info.ctimeNs) {
    throw new ReportDraftError("An attachment changed while its metadata was being checked.");
  }
  const name = path.basename(actual);
  const image = /\.(?:png|jpe?g|gif)$/i.test(name);
  if (info.size <= 0n) throw new ReportDraftError("An attachment is empty.");
  if (info.size > (image ? 10_000_000n : 1_000_000_000n)) {
    throw new ReportDraftError("An attachment exceeds the platform limit of 10 MB for PNG/JPEG/GIF or 1 GB for other files.");
  }
  return { path: actual, name, size: Number(info.size), device: String(info.dev), inode: String(info.ino),
    modified: String(info.mtimeNs), changed: String(info.ctimeNs) };
}

async function inspectAttachments(paths) {
  const names = new Set();
  const records = [];
  for (const [index, value] of paths.entries()) {
    try {
      const record = await evidence(value);
      const key = record.name.normalize("NFC").toLowerCase();
      if (names.has(key)) throw new ReportDraftError("Each attachment must have a distinct filename.");
      names.add(key);
      records.push(record);
    } catch (error) {
      const detail = error instanceof ReportDraftError ? error.message : "The file is missing or unreadable.";
      throw new ReportDraftError(`Attachment ${index + 1}: ${detail}`);
    }
  }
  return records;
}

async function publishJson(destination, data) {
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

async function readJson(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxSnapshotBytes) {
    throw new ReportDraftError("The local draft record is invalid.");
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const current = await handle.stat();
    if (info.dev !== current.dev || info.ino !== current.ino || !current.isFile() || current.size > maxSnapshotBytes) {
      throw new ReportDraftError("The local draft record changed while opening it.");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function boundDraftUrl(file, original, supplied) {
  if (original) {
    if (supplied && !sameDraft(original, supplied)) throw new ReportDraftError("This snapshot already refers to a different platform draft.");
    return original;
  }
  if (supplied) {
    try { await publishJson(file, { version: 1, draftUrl: supplied }); } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  let binding;
  try { binding = await readJson(file); } catch (error) {
    if (!supplied && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (binding?.version !== 1 || typeof binding.draftUrl !== "string") throw new ReportDraftError("The local draft link record is invalid.");
  const stored = canonicalDraftUrl(binding.draftUrl);
  if (supplied && !sameDraft(stored, supplied)) throw new ReportDraftError("This snapshot already refers to a different platform draft.");
  return stored;
}

function result(snapshot, draftPath, draftUrl) {
  const { draftId, programUrl, fields, attachments } = snapshot;
  return { status: "prepared_locally", draftId, draftPath, ...(programUrl && { programUrl }), ...(draftUrl && { draftUrl }),
    fields, attachments: attachments.map(({ path, name, size }) => ({ path, name, size })),
    missingFields: ["asset", "vulnerabilityType", "severity", "impact"].filter(key => !fields[key]) };
}

async function privateStore(directory, create) {
  const dir = await verifiedDirectory(directory, create);
  if (process.platform !== "win32") {
    const info = await lstat(dir);
    if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new ReportDraftError("The local draft directory must belong to your account and have mode 0700.");
    }
  }
  return dir;
}

export async function prepareReportDraft(args, { directory = path.join(homedir(), ".intigriti-researcher-mcp", "drafts") } = {}) {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) throw new ReportDraftError("Invalid draft inputs. Check the field types and length limits.");
  const { draftId, programUrl, draftUrl, attachments, ...fields } = parsed.data;
  try {
    if (draftId) {
      if (Object.keys(parsed.data).some(key => key !== "draftId" && key !== "draftUrl")) {
        throw new ReportDraftError("Resume with draftId alone, or with the observed draftUrl to bind it.");
      }
      const supplied = canonicalDraftUrl(draftUrl);
      const dir = await privateStore(directory, false);
      const id = draftId.toLowerCase();
      const file = path.join(dir, id + ".json");
      const saved = snapshotSchema.safeParse(await readJson(file));
      if (!saved.success || saved.data.draftId !== id) throw new ReportDraftError("The local draft record is invalid.");
      const snapshot = saved.data;
      const original = location(snapshot.programUrl, snapshot.draftUrl);
      validateFields(snapshot.fields);
      const current = await inspectAttachments(snapshot.attachments.map(item => item.path));
      if (current.some((record, i) => Object.keys(record).some(key => record[key] !== snapshot.attachments[i][key]))) {
        throw new ReportDraftError("An attachment changed since preparation. The snapshot is preserved. Prepare a new snapshot with the intended files.");
      }
      return result(snapshot, file, await boundDraftUrl(path.join(dir, id + ".link.json"), original.draftUrl, supplied));
    }
    const links = location(programUrl, draftUrl);
    validateFields(fields);
    const evidence = await inspectAttachments(attachments ?? []);
    const dir = await privateStore(directory, true);
    const id = randomUUID();
    const file = path.join(dir, id + ".json");
    const snapshot = { version: 1, draftId: id, ...links, fields, attachments: evidence };
    await publishJson(file, snapshot);
    return result(snapshot, file, links.draftUrl);
  } catch (error) {
    if (error instanceof ReportDraftError) throw error;
    if (error.code === "ENOENT" && draftId) throw new ReportDraftError("Local draft snapshot was not found.");
    throw new ReportDraftError("Could not read or write the local draft record. Check the draft directory and its permissions.");
  }
}
