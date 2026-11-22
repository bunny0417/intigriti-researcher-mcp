import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindReportDraft, prepareReportDraft, readDraftForReceipt, ReportDraftError } from "../src/report-draft.js";
import { discardPickerFiles, stagePickerFiles } from "../src/picker-files.js";

const programUrl = "https://app.intigriti.com/programs/example/demo/detail";
const draftUrl = "https://app.intigriti.com/researcher/inbox/submissions/draft/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/create";
const alias = draftUrl.replace("/inbox", "");
const other = draftUrl.replace("000000000002", "000000000003");
const note = { programUrl, title: "Synthetic report", description: "Researcher-supplied text." };

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "report-draft-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "local-store");
  const prepare = args => prepareReportDraft(args, { directory });
  const bind = (id, links) => bindReportDraft(id, links, { directory });
  const forReceipt = id => readDraftForReceipt(id, { directory });
  return { root, directory, prepare, bind, forReceipt };
}

test("prepares and resumes a private immutable snapshot, keeping notes separate from attachment metadata", async t => {
  const { root, directory, prepare } = await fixture(t);
  const evidence = path.join(root, "screenshot.png");
  await writeFile(evidence, "synthetic-only-attachment-content");
  const args = { ...note, programUrl: programUrl.replace("/programs", "/researcher/programs"),
    asset: "Demo application", impact: "Synthetic observation", aiDisclosure: "Text formatting",
    attachments: [evidence], questions: [{ question: "Browser?", answer: "Synthetic fixture" }] };
  const one = await prepare(args);
  assert.equal(one.status, "prepared_locally");
  assert.equal(one.programUrl, programUrl);
  assert.ok(!Object.hasOwn(one, "draftUrl"));
  assert.deepEqual(one.attachments, [{ path: evidence, name: "screenshot.png", size: 33 }]);
  assert.deepEqual(one.missingFields, ["vulnerabilityType", "severity"]);
  assert.equal(one.fields.aiDisclosure, args.aiDisclosure);
  assert.deepEqual(one.fields.questions, args.questions);
  assert.ok(!Object.hasOwn(one.fields, "testingIp"));
  assert.equal(path.dirname(one.draftPath), directory);
  const contents = await readFile(one.draftPath, "utf8");
  assert.ok(!contents.includes("synthetic-only-attachment-content"));
  assert.deepEqual(await prepare({ draftId: one.draftId }), one);
  const two = await prepare(args);
  assert.notEqual(one.draftId, two.draftId);
  assert.equal(await readFile(one.draftPath, "utf8"), contents);
  if (process.platform !== "win32") {
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(one.draftPath)).mode & 0o777, 0o600);
  }
});

test("canonical program and observed draft links are strictly validated before any write", async t => {
  const { directory, prepare, bind } = await fixture(t);
  const wrong = [
    programUrl + "?token=private", programUrl + "#draft", programUrl + "\n",
    programUrl.replace("https:", "http:"), programUrl.replace("app.", "user@app."),
    programUrl.replace("app.intigriti.com", "app.intigriti.com.invalid"),
    programUrl.replace("/demo/", "/../"), programUrl.replace("/demo/", "/%2e%2e/"),
  ];
  for (const url of wrong) await assert.rejects(prepare({ ...note, programUrl: url }), ReportDraftError);
  for (const url of [draftUrl + "?token=private", draftUrl + "#x", draftUrl.replace("/create", "/submit"), draftUrl.replace("4000", "zzzz")]) {
    await assert.rejects(prepare({ ...note, draftUrl: url }), ReportDraftError);
  }
  await assert.rejects(prepare({ title: "Note", description: "No destination" }), /programUrl or/);
  await assert.rejects(lstat(directory), { code: "ENOENT" });
  const saved = await prepare({ draftUrl: alias, title: note.title, description: note.description });
  assert.ok(!Object.hasOwn(saved, "programUrl"));
  assert.equal(saved.draftUrl, alias);
  assert.deepEqual(saved.missingFields, ["asset", "vulnerabilityType", "severity", "impact"]);
  assert.equal((await bind(saved.draftId, { draftUrl })).draftUrl, alias);
  await assert.rejects(bind(saved.draftId, { draftUrl: other }), /different platform draft/);
});

test("picker metadata changes preserve approval, while same-size edits and replacement files invalidate it", async t => {
  const { root, prepare } = await fixture(t);
  const evidence = path.join(root, "synthetic-evidence.txt");
  const stamp = new Date("2025-01-01T00:00:00Z");
  await writeFile(evidence, "sample A");
  await utimes(evidence, stamp, stamp);
  const draft = await prepare({ ...note, attachments: [evidence] });
  const { ctimeNs: initialChange } = await lstat(evidence, { bigint: true });
  // The Windows picker modified the file's change time while keeping its last write time.
  await chmod(evidence, 0o444);
  await chmod(evidence, 0o600);
  assert.notEqual((await lstat(evidence, { bigint: true })).ctimeNs, initialChange);
  assert.deepEqual(await prepare({ draftId: draft.draftId }), draft);

  await writeFile(evidence, "sample B");
  await utimes(evidence, stamp, stamp);
  await assert.rejects(prepare({ draftId: draft.draftId }), /Attachment 1:.*changed/i);

  await rename(evidence, path.join(root, "previous.txt"));
  await writeFile(evidence, "sample A");
  await utimes(evidence, stamp, stamp);
  await assert.rejects(prepare({ draftId: draft.draftId }), /Attachment 1:.*changed/i);
});

test("legacy evidence without a digest resumes only while all original metadata matches", async t => {
  const { root, prepare } = await fixture(t);
  const evidence = path.join(root, "legacy.txt");
  await writeFile(evidence, "fixture");
  const saved = await prepare({ ...note, attachments: [evidence] });
  const snapshot = JSON.parse(await readFile(saved.draftPath, "utf8"));
  delete snapshot.attachments[0].sha256;
  await writeFile(saved.draftPath, JSON.stringify(snapshot));
  assert.deepEqual(await prepare({ draftId: saved.draftId }), saved);
  await chmod(evidence, 0o444);
  await chmod(evidence, 0o600);
  await assert.rejects(prepare({ draftId: saved.draftId }), /attachment changed/i);
});

test("browser picker receives private read-only copies of the exact reviewed bytes", async t => {
  const { root, prepare } = await fixture(t);
  const file = path.join(root, "source proof.txt");
  const token = "a".repeat(43);
  const bytes = "reviewed bytes";
  await writeFile(file, bytes);
  const draft = await prepare({ ...note, attachments: [file] });
  const [first, second] = await Promise.all([stagePickerFiles(draft, token), stagePickerFiles(draft, token)]);
  assert.deepEqual(first, second);
  const staged = first[0];
  assert.equal(staged.name, path.basename(file));
  assert.equal(path.basename(staged.path), staged.name);
  assert.notEqual(staged.path, file);
  assert.ok(!staged.path.includes(token));
  assert.equal((await lstat(staged.path)).mode & 0o222, 0);
  // Change the actual source in the window before the picker reads its path.
  await writeFile(file, "unseen content");
  assert.equal(await readFile(staged.path, "utf8"), bytes);
  await discardPickerFiles(draft, token);
  await discardPickerFiles(draft, token);
  await assert.rejects(lstat(staged.path), { code: "ENOENT" });
  assert.equal(await readFile(file, "utf8"), "unseen content");
});

test("staging rejects source changes before copying and cleans up partial output", async t => {
  const { root, directory, prepare, forReceipt } = await fixture(t);
  const files = [path.join(root, "one"), path.join(root, "two")];
  for (const file of files) await writeFile(file, "old");
  const draft = await prepare({ ...note, attachments: files });
  await writeFile(files[1], "new");
  await assert.rejects(stagePickerFiles(draft, "b".repeat(43)), { code: "evidence_invalid" });
  assert.deepEqual(await readdir(directory), [path.basename(draft.draftPath)]);
  await assert.rejects(stagePickerFiles(await forReceipt(draft.draftId), "b".repeat(43)), { code: "evidence_invalid" });
});

test("staged copies are attempt-scoped and altered copies fail closed", async t => {
  const { root, prepare } = await fixture(t);
  const file = path.join(root, "evidence");
  await writeFile(file, "selected");
  const draft = await prepare({ ...note, attachments: [file] });
  const [one] = await stagePickerFiles(draft, "c".repeat(43));
  const [two] = await stagePickerFiles(draft, "d".repeat(43));
  assert.notEqual(one.path, two.path);
  await chmod(one.path, 0o600);
  await writeFile(one.path, "modified");
  await chmod(one.path, 0o400);
  await assert.rejects(stagePickerFiles(draft, "c".repeat(43)), { code: "evidence_invalid" });
  await assert.rejects(lstat(one.path), { code: "ENOENT" });
  assert.equal(await readFile(two.path, "utf8"), "selected");
  await discardPickerFiles(draft, "d".repeat(43));
});

test("a legacy snapshot can stage after validation and abandoned copies expire", async t => {
  const { root, prepare } = await fixture(t);
  const file = path.join(root, "legacy evidence");
  await writeFile(file, "legacy bytes");
  const draft = await prepare({ ...note, attachments: [file] });
  const old = JSON.parse(await readFile(draft.draftPath, "utf8"));
  delete old.attachments[0].sha256;
  await writeFile(draft.draftPath, JSON.stringify(old));
  const restored = await prepare({ draftId: draft.draftId });
  const [abandoned] = await stagePickerFiles(restored, "e".repeat(43));
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(path.dirname(abandoned.path), expired, expired);
  const [fresh] = await stagePickerFiles(restored, "f".repeat(43));
  await assert.rejects(lstat(abandoned.path), { code: "ENOENT" });
  assert.equal(await readFile(fresh.path, "utf8"), "legacy bytes");
  await discardPickerFiles(restored, "f".repeat(43));
});

test("stage and cleanup reject reparented pickers without touching the link target", async t => {
  const { root, prepare } = await fixture(t);
  const evidence = path.join(root, "fixture.txt");
  await writeFile(evidence, "reviewed");
  const draft = await prepare({ ...note, attachments: [evidence] });
  const token = "g".repeat(43);
  const [picker] = await stagePickerFiles(draft, token);
  const dir = path.dirname(picker.path);
  await discardPickerFiles(draft, token);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  const unrelated = path.join(outside, path.basename(evidence));
  await writeFile(unrelated, "unrelated");
  await symlink(outside, dir, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(stagePickerFiles(draft, token), { code: "evidence_invalid" });
  await assert.rejects(discardPickerFiles(draft, token), /junction|symbolic link/);
  assert.equal(await readFile(unrelated, "utf8"), "unrelated");
});

test("program URL variants from the read tools normalize to one detail URL and resume by UUID", async t => {
  const { prepare } = await fixture(t);
  for (const prefix of ["/programs/", "/researcher/programs/"]) {
    for (const suffix of ["", "/", "/detail", "/detail/"]) {
      const url = "https://app.intigriti.com" + prefix + "example/demo" + suffix;
      const state = await prepare({ ...note, programUrl: url });
      assert.equal(state.programUrl, programUrl);
      const restored = await prepare({ draftId: state.draftId.toUpperCase() });
      assert.equal(restored.draftId, state.draftId);
      assert.equal(restored.programUrl, programUrl);
    }
  }
  for (const url of [programUrl + "//", programUrl.replace("/detail", "/edit"), programUrl.replace("example/demo/detail", "../demo")]) {
    await assert.rejects(prepare({ ...note, programUrl: url }), ReportDraftError);
  }
});

test("validates UTF-16 form and combined disclosure limits, resume exclusivity and unknown input", async t => {
  const { prepare } = await fixture(t);
  const state = await prepare({ ...note, title: "😀".repeat(50), description: "z".repeat(30_000), impact: "z".repeat(15_000), endpoint: "e".repeat(1000) });
  for (const args of [
    { ...note, title: "😀".repeat(51) }, { ...note, title: "   " }, { ...note, description: "z".repeat(30_001) },
    { ...note, endpoint: "e".repeat(1001) }, { ...note, impact: "z".repeat(15_001) },
    { ...note, remediation: "z".repeat(15_001) }, { ...note, description: "z".repeat(29_989), aiDisclosure: "a" },
    { draftId: state.draftId, attachments: [] }, { draftId: state.draftId, severity: "low" },
    { ...note, questions: [{ question: "Q" }] }, { ...note, send: true },
  ]) await assert.rejects(prepare(args), ReportDraftError);
  await assert.rejects(prepare({ draftId: "00000000-0000-4000-8000-000000000003" }), {
    name: "ReportDraftError", code: "draft_not_found", message: "Local draft snapshot was not found.",
  });
});

test("accepts only the inbox's program filter and strips it on creation, binding and resume", async t => {
  const { directory, prepare, bind } = await fixture(t);
  const filter = "?program=example-co%2Fmy_program";
  const direct = await prepare({ ...note, draftUrl: alias + filter });
  assert.equal(direct.draftUrl, alias);
  assert.equal((await prepare({ draftId: direct.draftId })).draftUrl, alias);
  assert.equal((await bind(direct.draftId, { programUrl, draftUrl: draftUrl + filter })).draftUrl, alias);
  const saved = await prepare(note);
  assert.equal((await bind(saved.draftId, { programUrl, draftUrl: draftUrl + filter })).draftUrl, draftUrl);
  assert.equal((await bind(saved.draftId, { programUrl, draftUrl: alias + "?program=example-co/my_program" })).draftUrl, draftUrl);
  assert.equal((await prepare({ draftId: saved.draftId })).draftUrl, draftUrl);
  for (const file of await readdir(directory)) assert.ok(!(await readFile(path.join(directory, file), "utf8")).includes("?program="));
  const bad = [
    "?program=", "?program=one", "?program=%2Ftwo", "?program=one%2F", "?program=one%2Ftwo%2Fthree",
    "?program=one%252Ftwo", "?program=..%2Ftwo", "?program=one%2F.", "?program=one%2Ftwo&program=one%2Ftwo",
    "?program=one%2Ftwo&next=away", "?program=one%2Ftwo#", "?program=one%2Ftwo&",
    "?program=https%3A%2F%2Felsewhere.invalid", "?redirect=one%2Ftwo", "?program=one%2Ftwo%23there",
  ];
  for (const suffix of bad) {
    await assert.rejects(prepare({ ...note, draftUrl: alias + suffix }), ReportDraftError);
    await assert.rejects(bind(saved.draftId, { programUrl, draftUrl: alias + suffix }), ReportDraftError);
  }
  await assert.rejects(prepare({ ...note, draftUrl: alias.replace("app.", "user@app.") + filter }), ReportDraftError);
  await assert.rejects(prepare({ ...note, programUrl: programUrl + filter }), ReportDraftError);
});

test("once-only binding survives concurrent calls and never overwrites immutable snapshot", async t => {
  const { directory, prepare, bind } = await fixture(t);
  const saved = await prepare(note);
  const contents = await readFile(saved.draftPath, "utf8");
  const calls = await Promise.allSettled([draftUrl, alias, other].map(url => bind(saved.draftId, { draftUrl: url, programUrl })));
  const bound = await prepare({ draftId: saved.draftId });
  const competingWon = bound.draftUrl === other;
  assert.equal(calls.filter(call => call.status === "fulfilled").length, competingWon ? 1 : 2);
  assert.ok(calls.filter(call => call.status === "rejected").every(call => call.reason instanceof ReportDraftError));
  assert.deepEqual(await bind(saved.draftId, { draftUrl: bound.draftUrl, programUrl }), bound);
  assert.equal(bound.sourceProgramUrl, programUrl);
  assert.equal(bound.boundProgramUrl, programUrl);
  assert.equal(await readFile(saved.draftPath, "utf8"), contents);
  assert.equal((await readdir(directory)).length, 2);
});

test("a program-first binding requires a positive matching observation before a sidecar is created", async t => {
  const { directory, prepare, bind, forReceipt } = await fixture(t);
  const saved = await prepare(note);
  const { draftId } = saved;
  const original = await readFile(saved.draftPath);
  assert.equal(saved.sourceProgramUrl, programUrl);
  for (const wrong of [undefined, programUrl.replace("/demo/", "/another/")]) {
    await assert.rejects(bind(draftId, { programUrl: wrong, draftUrl }), /observed program/);
  }
  await assert.rejects(prepare({ draftId, draftUrl }), /draftId alone/);
  assert.deepEqual(await readdir(directory), [path.basename(saved.draftPath)]);
  assert.deepEqual(await forReceipt(draftId), saved);
  const checked = await bind(draftId, { programUrl: programUrl.replace("/programs/", "/researcher/programs/"), draftUrl });
  assert.equal(checked.boundProgramUrl, programUrl);
  assert.equal(checked.sourceProgramUrl, programUrl);
  assert.deepEqual(await readFile(saved.draftPath), original);
});

test("a legacy link alone is not an observed association and cannot be replaced during confirmation", async t => {
  const { directory, prepare, bind, forReceipt } = await fixture(t);
  const saved = await prepare(note);
  const legacy = path.join(directory, saved.draftId + ".link.json");
  const record = JSON.stringify({ version: 1, draftUrl: alias });
  await writeFile(legacy, record, { mode: 0o600 });
  const pending = await prepare({ draftId: saved.draftId });
  assert.equal(pending.sourceProgramUrl, programUrl);
  assert.equal(pending.unverifiedDraftUrl, alias);
  assert.equal(pending.draftUrl, undefined);
  assert.equal(pending.boundProgramUrl, undefined);
  await assert.rejects(bind(saved.draftId, { draftUrl, programUrl: programUrl.replace("/demo/", "/wrong/") }));
  await assert.rejects(bind(saved.draftId, { draftUrl: other, programUrl }), /different platform draft/);
  assert.equal((await readdir(directory)).length, 2);
  const bound = await bind(saved.draftId, { draftUrl, programUrl });
  assert.equal(bound.draftUrl, alias);
  assert.equal(bound.boundProgramUrl, programUrl);
  assert.equal(bound.unverifiedDraftUrl, undefined);
  assert.deepEqual(await forReceipt(saved.draftId), bound);
  assert.equal(await readFile(legacy, "utf8"), record);
  assert.equal((await readdir(directory)).length, 3);
});

test("a directly supplied draft retains its GUID pair and pins any observed program once", async t => {
  const { prepare, bind, forReceipt } = await fixture(t);
  const saved = await prepare({ draftUrl, title: note.title, description: note.description });
  assert.equal(saved.sourceProgramUrl, undefined);
  assert.equal((await bind(saved.draftId, { draftUrl: alias })).boundProgramUrl, undefined);
  const bound = await bind(saved.draftId, { draftUrl: alias, programUrl });
  assert.equal(bound.boundProgramUrl, programUrl);
  assert.equal(bound.draftUrl, draftUrl);
  await assert.rejects(bind(saved.draftId, { draftUrl: other, programUrl }), /different platform draft/);
  await assert.rejects(bind(saved.draftId, { draftUrl, programUrl: programUrl.replace("/demo/", "/wrong/") }), /bound program/);
  assert.deepEqual(await forReceipt(saved.draftId), bound);
});

test("a snapshot supplied with both destinations keeps both identities and requires their observed match", async t => {
  const { directory, prepare, bind, forReceipt } = await fixture(t);
  const saved = await prepare({ ...note, draftUrl: alias });
  const { draftId } = saved;
  assert.equal(saved.sourceProgramUrl, programUrl);
  assert.equal(saved.draftUrl, alias);
  assert.equal(saved.boundProgramUrl, undefined);
  for (const observation of [{ draftUrl }, { draftUrl, programUrl: programUrl.replace("/demo/", "/wrong/") }, { draftUrl: other, programUrl }]) {
    await assert.rejects(bind(draftId, observation), ReportDraftError);
  }
  assert.deepEqual(await readdir(directory), [path.basename(saved.draftPath)]);
  assert.deepEqual(await forReceipt(draftId), saved);
  const checked = await bind(draftId, { draftUrl, programUrl });
  assert.equal(checked.draftUrl, alias);
  assert.equal(checked.boundProgramUrl, programUrl);
  assert.equal(checked.sourceProgramUrl, programUrl);
  assert.deepEqual(await forReceipt(draftId), checked);
});

test("a receipt can inspect approved immutable facts after evidence moves, while resume and bind still recheck files", async t => {
  const { root, prepare, bind, forReceipt } = await fixture(t);
  const evidence = path.join(root, "synthetic-proof.txt");
  await writeFile(evidence, "a sample");
  const snapshot = await prepare({ ...note, attachments: [evidence] });
  const bound = await bind(snapshot.draftId, { draftUrl, programUrl });
  await writeFile(evidence, "changed example");
  assert.deepEqual(await forReceipt(snapshot.draftId), bound);
  await assert.rejects(prepare({ draftId: snapshot.draftId }), /attachment changed/i);
  await rm(evidence);
  await assert.rejects(prepare({ draftId: snapshot.draftId }), /missing or unreadable/);
  await assert.rejects(bind(snapshot.draftId, { draftUrl, programUrl }), /missing or unreadable/);
  assert.deepEqual(await forReceipt(snapshot.draftId), bound);
});

test("rejects POSIX records that allow other accounts access", { skip: process.platform === "win32" }, async t => {
  const { directory, prepare, bind, forReceipt } = await fixture(t);
  const saved = await prepare(note);
  await bind(saved.draftId, { draftUrl, programUrl });
  for (const file of [saved.draftPath, path.join(directory, saved.draftId + ".link.json")]) {
    await chmod(file, 0o644);
    await assert.rejects(prepare({ draftId: saved.draftId }), /must .*private/);
    await assert.rejects(forReceipt(saved.draftId), /must .*private/);
    await chmod(file, 0o600);
  }
});

test("rejects remote and private evidence paths, unreadable or empty files and ambiguous basenames", async t => {
  const { root, directory, prepare } = await fixture(t);
  const empty = path.join(root, "empty.txt");
  await writeFile(empty, "");
  await mkdir(path.join(root, "one"));
  await mkdir(path.join(root, "two"));
  const duplicate = [path.join(root, "one", "notes.txt"), path.join(root, "two", "NOTES.TXT")];
  for (const file of duplicate) await writeFile(file, "sample");
  for (const value of [empty, root, path.join(root, ".env"), path.join(root, ".ssh", "id_rsa"), "relative.txt",
    "https://example.invalid/test", "\\\\example.invalid\\share\\file", "//example.invalid/share/file", path.join(root, "private-sentinel-missing")]) {
    await assert.rejects(prepare({ ...note, attachments: [value] }), error =>
      error instanceof ReportDraftError && !error.message.includes("private-sentinel") && !error.message.includes(root));
  }
  await assert.rejects(prepare({ ...note, attachments: duplicate }), /distinct filename/);
  await assert.rejects(lstat(directory), { code: "ENOENT" });
});

test("applies the documented limits by selected filename and revalidates stale or missing evidence", async t => {
  const { root, prepare } = await fixture(t);
  const image = path.join(root, "evidence.JPEG");
  await writeFile(image, "fixture");
  await truncate(image, 10_000_000);
  const saved = await prepare({ ...note, attachments: [image] });
  assert.equal(saved.attachments[0].size, 10_000_000);
  await truncate(image, 10_000_001);
  await assert.rejects(prepare({ ...note, attachments: [image] }), /platform limit/);
  await truncate(image, 128);
  const contents = await readFile(saved.draftPath, "utf8");
  await assert.rejects(prepare({ draftId: saved.draftId }), /attachment changed/i);
  await rm(image);
  await assert.rejects(prepare({ draftId: saved.draftId }), /missing or unreadable/);
  assert.equal(await readFile(saved.draftPath, "utf8"), contents);
});

test("blocks hard-linked evidence and directory junctions, including in a configured storage location", async t => {
  const { root, prepare } = await fixture(t);
  const base = path.join(root, "base");
  await mkdir(base);
  const source = path.join(base, "original.txt");
  const alias = path.join(root, "renamed.txt");
  await writeFile(source, "sample");
  await link(source, alias);
  await assert.rejects(prepare({ ...note, attachments: [alias] }), /hard links/);
  const shortcut = path.join(root, "shortcut");
  await symlink(base, shortcut, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepare({ ...note, attachments: [path.join(shortcut, "original.txt")] }), /junctions/);
  await assert.rejects(prepareReportDraft(note, { directory: path.join(shortcut, "store") }), /junctions/);
  await assert.rejects(lstat(path.join(base, "store")), { code: "ENOENT" });
});

test("sanitizes invalid or corrupted snapshots", async t => {
  const { prepare } = await fixture(t);
  const saved = await prepare(note);
  await writeFile(saved.draftPath, "sensitive-corrupt-content");
  await assert.rejects(prepare({ draftId: saved.draftId }), error => error instanceof ReportDraftError && !error.message.includes("sensitive-corrupt"));
});

test("rejects a shared POSIX storage directory", { skip: process.platform === "win32" }, async t => {
  const { directory, prepare } = await fixture(t);
  await mkdir(directory);
  await chmod(directory, 0o755);
  await assert.rejects(prepare(note), /mode 0700/);
  assert.deepEqual(await readdir(directory), []);
});
