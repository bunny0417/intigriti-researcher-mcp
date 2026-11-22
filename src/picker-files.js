import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { protectPrivatePath } from "./private-permissions.js";
import { copyReviewedAttachment, evidenceDigest, privateStore, ReportDraftError, reviewedAttachments } from "./report-draft.js";

const lifetime = 24 * 60 * 60 * 1000;
const queues = new Map();
const digestPattern = /^[0-9a-f]{64}$/;
// Once protected, only the researcher and OS administrators can change the
// directory or its access rules. Notice replacements by their filesystem ID.
const secured = new Map();

async function secureDirectory(dir) {
  const info = await lstat(dir, { bigint: true });
  const identity = info.dev + ":" + info.ino;
  if (!info.isDirectory()) throw new ReportDraftError("Expected a private picker directory.");
  if (info.ino === 0n || secured.get(dir) !== identity) {
    protectPrivatePath(dir, { directory: true });
    if (secured.size >= 64) secured.delete(secured.keys().next().value);
    secured.set(dir, identity);
  }
}

function attemptHash(token) {
  if (typeof token !== "string" || token.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new ReportDraftError("A current approved handoff is required for evidence staging.");
  }
  return createHash("sha256").update(token).digest("hex");
}

function directoryFor(draft, hash) {
  if (!z.uuid().safeParse(draft.draftId).success || path.basename(draft.draftPath) !== draft.draftId + ".json" ||
      typeof hash !== "string" || hash.length !== 64 || !digestPattern.test(hash)) {
    throw new ReportDraftError("Invalid picker directory identity.");
  }
  return path.join(path.dirname(draft.draftPath), draft.draftId + "." + hash + ".picker");
}

async function serialized(dir, task) {
  const next = (queues.get(dir) ?? Promise.resolve()).then(task);
  const tail = next.catch(() => {});
  queues.set(dir, tail);
  try { return await next; }
  finally { if (queues.get(dir) === tail) queues.delete(dir); }
}

// Only remove regular files directly inside our named attempt directory.
// Refuse links and nested directories, including junctions.
async function clear(dir) {
  try { await privateStore(dir, false); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  await secureDirectory(dir);
  for (const name of await readdir(dir)) {
    const file = path.join(dir, name);
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1) throw new ReportDraftError("Unexpected item in the private picker directory.");
    if (process.platform === "win32") await chmod(file, 0o600);
    await unlink(file);
  }
  await rmdir(dir);
  secured.delete(dir);
}

// Recover crash leftovers when the next attachment handoff uses this store.
async function reap(store) {
  const cutoff = Date.now() - lifetime;
  for (const name of await readdir(store)) {
    const [id, hash, suffix, extra] = name.split(".");
    if (suffix !== "picker" || extra !== undefined || !z.uuid().safeParse(id).success || !digestPattern.test(hash)) continue;
    const dir = path.join(store, name);
    try {
      const info = await lstat(dir);
      if (info.isDirectory() && info.mtimeMs < cutoff) await serialized(dir, () => clear(dir));
    } catch {
      // Another process may have removed it, or the directory may have been
      // replaced by an unsafe item. Leave it alone and check other attempts.
    }
  }
}

async function pickerCopy(dir, record) {
  // The basename comes from the verified source handle's canonical path.
  const file = path.join(dir, record.name);
  let output;
  try { output = await open(file, "wx", 0o600); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (output) {
    try {
      await copyReviewedAttachment(record, output);
      await output.sync();
      await output.chmod(0o400);
    } finally {
      await output.close();
    }
  }
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(record.size) ||
      (info.mode & 0o222n) !== 0n || await evidenceDigest(file, info) !== record.sha256) {
    throw new ReportDraftError("The private picker copy differs from the reviewed evidence.", "evidence_invalid");
  }
  return { name: record.name, size: record.size, path: file };
}

export async function stagePickerFiles(draft, handoffId) {
  const records = reviewedAttachments(draft);
  if (!records.length) return [];
  const dir = directoryFor(draft, attemptHash(handoffId));
  const store = await privateStore(path.dirname(dir), false);
  await secureDirectory(store);
  // Reap outside the per-attempt queue to avoid re-entering our own lock.
  await reap(store);
  return serialized(dir, async () => {
    try {
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      await privateStore(dir, false);
      await secureDirectory(dir);
      const files = [];
      for (const record of records) files.push(await pickerCopy(dir, record));
      return files;
    } catch {
      await clear(dir).catch(() => {});
      throw new ReportDraftError("Could not stage the reviewed attachment bytes in a private read-only picker copy. Check the evidence and available disk space before starting a fresh review.", "evidence_invalid");
    }
  });
}

export async function discardPickerAttempt(draft, hash) {
  const dir = directoryFor(draft, hash);
  await serialized(dir, () => clear(dir));
}

export function discardPickerFiles(draft, handoffId) {
  return discardPickerAttempt(draft, attemptHash(handoffId));
}
