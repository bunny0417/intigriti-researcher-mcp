import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createNativeDraftHandoff, NativeHandoffError, nativeReceiptSchema, publicHandoffRecord } from "./draft-handoff.js";
import { canonicalReportLinks, privateStore, publishJson, readJson } from "./report-draft.js";
import { discardPickerAttempt } from "./picker-files.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const link = z.string().max(2048).optional();
const receipt = nativeReceiptSchema.extend({
  pendingFields: nativeReceiptSchema.shape.pendingFields.unwrap(),
  pendingFiles: nativeReceiptSchema.shape.pendingFiles.unwrap(),
});
const recordSchema = z.strictObject({
  status: z.enum(["awaiting_approval", "ready_for_browser", "evidence_changed", "expired", "cancelled", "browser_reported_partial", "browser_reported_saved"]),
  digest, cancelId: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(), direct: link, sourceProgramUrl: link, observedProgramUrl: link, pinnedUrl: link,
  checked: z.boolean(), observed: z.boolean().optional(), expiresAt: z.int(), forgetAt: z.int(),
  receipt: receipt.optional(), priorReceipt: receipt.optional(),
});
const revisionSchema = z.strictObject({
  version: z.literal(1), revision: z.int().positive(), owner: z.uuid(), record: recordSchema.nullable(), attemptHash: digest.optional(),
});

function validRecord(data) {
  if (!data) return true;
  const terminal = data.status.startsWith("browser_reported_");
  if (terminal !== Boolean(data.receipt)) return false;
  if (terminal && (data.status === "browser_reported_partial") !== Boolean(data.receipt.pendingFiles.length + data.receipt.pendingFields.length)) return false;
  try {
    for (const program of [data.sourceProgramUrl, data.observedProgramUrl]) if (program) canonicalReportLinks(program, undefined);
    for (const draft of [data.direct, data.pinnedUrl]) if (draft) canonicalReportLinks(undefined, draft);
    for (const item of [data.receipt, data.priorReceipt]) if (item) canonicalReportLinks(item.programUrl, item.draftUrl);
    return true;
  } catch { return false; }
}

async function latest(dir) {
  const entries = (await readdir(dir)).filter(n => /^\d{10}\.json$/.test(n)).sort();
  if (!entries.length) return { revision: 0 };
  const file = entries.at(-1);
  const row = await readJson(path.join(dir, file));
  if (!revisionSchema.safeParse(row).success || row.revision !== Number(file.slice(0, 10)) || !validRecord(row.record)) {
    throw new NativeHandoffError("Invalid local handoff journal. Inspect the draft before continuing.");
  }
  return row;
}

// A revision is published with an exclusive hard link. Two processes cannot
// both change the same revision. A crash needs no lock-file recovery.
export function createHandoffJournal() {
  const owner = randomUUID();
  const secrets = new Map();
  const queues = new Map();

  async function transition(draft, operation, apply, handoffId) {
    const time = Date.now();
    for (const [key, secret] of secrets) if (time >= secret.until) secrets.delete(key);
    const id = draft.draftId;
    const location = path.join(path.dirname(draft.draftPath), id + ".handoff");
    if (operation !== "start") {
      try { await privateStore(location, false); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (operation === "status" || operation === "cancel") {
          return { draftId: id, status: "prepared_locally", nextAction: "none",
            message: "The local preview exists. It has no browser handoff or active approval to cancel." };
        }
        throw new NativeHandoffError("Request a review for this draft first.");
      }
    } else {
      await privateStore(location, true);
    }
    for (let retry = 0; retry < 16; retry++) {
      const last = await latest(location);
      const sameSession = last.owner === owner;
      const item = last.record && structuredClone(last.record);
      if (sameSession && item && secrets.has(id)) {
        const { token, attempt } = secrets.get(id);
        Object.assign(item, { token, attempt });
      }
      const records = new Map(item ? [[id, item]] : []);
      const manager = createNativeDraftHandoff({ records });
      const state = manager.status(id);
      if (!sameSession && item) {
        if (operation === "start" && state.status === "ready_for_browser") {
          return { ...state, message: "This handoff belongs to another Codex session. Inspect the live draft. Cancel the old handoff before starting a fresh review here." };
        }
        if (operation === "start" && state.status === "awaiting_approval") item.status = "expired";
        if (["approve", "check", "finish", "review"].includes(operation)) {
          // A checked attempt stopped by an evidence change can still report
          // its observed result. Neither this nor a receipt replay grants edits.
          const receiptOnly = item.receipt || (item.status === "evidence_changed" && item.checked);
          if (operation === "finish" && receiptOnly && handoffId && hash(handoffId) === last.attemptHash) item.attempt = handoffId;
          else throw new NativeHandoffError("This session has no matching approval. Inspect the handoff status and request a fresh review.");
        }
      }
      let output, failure;
      try { output = apply(manager); } catch (error) {
        if (!(error instanceof NativeHandoffError)) throw error;
        // A failed comparison can invalidate a previously issued approval.
        failure = error;
      }
      const next = records.get(id);
      const record = next ? JSON.parse(JSON.stringify(publicHandoffRecord(next))) : null;
      // A replacement review can share a timestamp and public fields with the
      // old review. Its new secret still belongs to a different session.
      if (isDeepStrictEqual(last.record ?? null, record) &&
          !(operation === "start" && !sameSession && next?.token)) {
        if (failure) throw failure;
        return output;
      }
      const revision = last.revision + 1;
      try {
        await publishJson(path.join(location, String(revision).padStart(10, "0") + ".json"), {
          version: 1, revision, owner, record, ...(next?.attempt && { attemptHash: hash(next.attempt) }),
        });
      } catch (error) {
        if (error.code === "EEXIST") continue;
        throw error;
      }
      if (next?.token || next?.attempt) secrets.set(id, {
        token: next.token, attempt: next.attempt, until: next.token ? next.expiresAt : next.forgetAt,
      });
      else secrets.delete(id);
      if (last.attemptHash && next?.status !== "ready_for_browser" && last.record?.status === "ready_for_browser") {
        await discardPickerAttempt(draft, last.attemptHash);
      }
      if (failure) throw failure;
      return output;
    }
    throw new NativeHandoffError("The draft changed concurrently. Check its status and retry.");
  }

  return function transact(draft, operation, apply, handoffId) {
    const id = draft.draftId;
    const next = (queues.get(id) ?? Promise.resolve()).then(() => transition(draft, operation, apply, handoffId));
    const tail = next.catch(() => {});
    queues.set(id, tail);
    return next.finally(() => { if (queues.get(id) === tail) queues.delete(id); });
  };
}
