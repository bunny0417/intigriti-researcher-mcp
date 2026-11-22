import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareReportDraft, ReportDraftError } from "../src/report-draft.js";

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
  return { root, directory, prepare };
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
  const { directory, prepare } = await fixture(t);
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
  assert.equal((await prepare({ draftId: saved.draftId, draftUrl })).draftUrl, alias);
  await assert.rejects(prepare({ draftId: saved.draftId, draftUrl: other }), /different platform draft/);
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
  await assert.rejects(prepare({ draftId: "00000000-0000-4000-8000-000000000003" }), /not found/);
});

test("accepts only the inbox's program filter and strips it on creation, binding and resume", async t => {
  const { directory, prepare } = await fixture(t);
  const filter = "?program=example-co%2Fmy_program";
  const direct = await prepare({ ...note, draftUrl: alias + filter });
  assert.equal(direct.draftUrl, alias);
  assert.equal((await prepare({ draftId: direct.draftId })).draftUrl, alias);
  assert.equal((await prepare({ draftId: direct.draftId, draftUrl: draftUrl + filter })).draftUrl, alias);
  const saved = await prepare(note);
  assert.equal((await prepare({ draftId: saved.draftId, draftUrl: draftUrl + filter })).draftUrl, draftUrl);
  assert.equal((await prepare({ draftId: saved.draftId, draftUrl: alias + "?program=example-co/my_program" })).draftUrl, draftUrl);
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
    await assert.rejects(prepare({ draftId: saved.draftId, draftUrl: alias + suffix }), ReportDraftError);
  }
  await assert.rejects(prepare({ ...note, draftUrl: alias.replace("app.", "user@app.") + filter }), ReportDraftError);
  await assert.rejects(prepare({ ...note, programUrl: programUrl + filter }), ReportDraftError);
});

test("once-only binding survives concurrent calls and never overwrites immutable snapshot", async t => {
  const { directory, prepare } = await fixture(t);
  const saved = await prepare(note);
  const contents = await readFile(saved.draftPath, "utf8");
  const calls = await Promise.allSettled([draftUrl, alias, other].map(url => prepare({ draftId: saved.draftId, draftUrl: url })));
  const bound = await prepare({ draftId: saved.draftId });
  const competingWon = bound.draftUrl === other;
  assert.equal(calls.filter(call => call.status === "fulfilled").length, competingWon ? 1 : 2);
  assert.ok(calls.filter(call => call.status === "rejected").every(call => call.reason instanceof ReportDraftError));
  assert.deepEqual(await prepare({ draftId: saved.draftId, draftUrl: bound.draftUrl }), bound);
  assert.equal(await readFile(saved.draftPath, "utf8"), contents);
  assert.equal((await readdir(directory)).length, 2);
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
