// Offline native-handoff contract checks through the shipped MCP stdio entry point.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const tool = "prepare_report_draft";
const rounds = 10;
const programUrl = "https://app.intigriti.com/programs/fixture/example/detail";
const draftRoute = "/submissions/draft/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/create";
const draftUrl = "https://app.intigriti.com/researcher" + draftRoute;
const draftAlias = "https://app.intigriti.com/researcher/inbox" + draftRoute;
const deferredEvidence = "deferred-intake-evidence.txt";
const samplePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1cAAAAASUVORK5CYII=",
  "base64",
);

async function withServer(profile, guard, run, elicit) {
  const capabilities = elicit ? { elicitation: { form: {} } } : {};
  const client = new Client({ name: "local-draft-acceptance", version: "1" }, { capabilities });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit);
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", guard, entry], cwd: profile,
      env: {
        HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
        INTIGRITI_API_TOKEN: "", INTIGRITI_ALLOWED_PROGRAM_IDS: "",
      },
    }));
    const { tools } = await client.listTools();
    assert.ok(tools.some(item => item.name === tool), "Draft tool missing from tools/list");
    assert.ok(!tools.some(item => /submit_report|finalize_submission/.test(item.name)));
    return await run(args => client.callTool({ name: tool, arguments: args }));
  } finally {
    await client.close();
  }
}

function unpack(response) {
  assert.ok(!response.isError, response.content[0]?.text);
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  return response.structuredContent;
}

function checkIntake(result, status) {
  assert.equal(result.status, status);
  assert.match(result.message, /authenticat|sign(?:ed)?[ -]in/i);
  assert.match(result.question, /\?/);
  assert.ok(Array.isArray(result.instructions) && result.instructions.length > 0);
  for (const key of ["draftPath", "draftId", "approvalId", "hostTools", "attachments", "evidence"]) {
    assert.ok(!Object.hasOwn(result, key), `Intake unexpectedly produced ${key}`);
  }
}

async function checkProgramIntake(invoke, profile) {
  const before = (await readdir(profile)).sort();
  const first = unpack(await invoke({}));
  checkIntake(first, "awaiting_program");
  assert.match(first.question, /program/i);
  const programOnly = unpack(await invoke({ programUrl: "https://app.intigriti.com/researcher/programs/fixture/example" }));
  checkIntake(programOnly, "awaiting_finding");
  assert.equal(programOnly.programUrl, programUrl);
  const directions = programOnly.instructions.join(" ");
  assert.match(directions, /existing|verified|already/i);
  assert.match(directions, /notes/i);
  assert.match(directions, /PoC|proof.of.concept/i);
  const existing = unpack(await invoke({ draftUrl: draftAlias + "?program=fixture%2Fexample" }));
  checkIntake(existing, "awaiting_finding");
  assert.equal(existing.draftUrl, draftAlias);
  const deferred = unpack(await invoke({ programUrl, attachments: [path.join(profile, deferredEvidence)] }));
  checkIntake(deferred, "awaiting_finding");
  await reject(invoke, { programUrl: "https://example.invalid/programs/fixture/example/detail" });
  assert.deepEqual((await readdir(profile)).sort(), before, "Intake created a snapshot or inspected deferred evidence");
}

function checkReview(review, draft) {
  assert.equal(review.status, "awaiting_approval");
  assert.equal(review.draftId, draft.draftId);
  assert.match(review.approvalId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(review.destination, draft.draftUrl ?? draft.programUrl);
  assert.deepEqual(review.review.fields, draft.fields);
  assert.deepEqual(review.missingFields, draft.missingFields);
  assert.deepEqual(review.evidence, draft.attachments, "Review must identify the exact canonical paths, names and sizes");
  assert.equal(review.nextAction, "ask_for_approval");
  assert.match(review.question, /\?/);
  assert.ok(!Object.hasOwn(review, "handoffId"), "Unapproved review granted an attempt capability");
  assert.match(review.message, /signed in/i);
  assert.match(review.instructions.join(" "), /fresh chat reply|explicit user-facing confirmation|native user confirmation/i);
}

async function testHostHandoff(invoke, draft, firstApproval, round, withPeer) {
  const { draftId } = draft;
  const review = unpack(await invoke({ draftId }));
  checkReview(review, draft);
  const approve = review.requestConfirmation;
  assert.deepEqual(approve, { mode: "approve", draftId, approvalId: review.approvalId });
  const receipt = {
    ...(draft.programUrl ? { programUrl: draft.programUrl } : {}), draftUrl,
    savedFields: Object.keys(draft.fields), uploadedFiles: draft.attachments.map(file => file.name),
  };
  const wrongId = "x".repeat(43);
  const badCheck = { mode: "check", draftId, handoffId: wrongId, programUrl, draftUrl };
  await reject(invoke, badCheck);
  await reject(invoke, { mode: "local", draftId, draftUrl });
  await reject(invoke, { draftId, draftUrl });
  await reject(invoke, { mode: "approve", draftId });
  await reject(invoke, { ...approve, approvalId: "x".repeat(43) });
  if (firstApproval) await reject(invoke, { ...approve, approvalId: firstApproval });
  await reject(invoke, { mode: "finish", draftId, receipt, handoffId: wrongId });
  // The fixture host independently answers the elicitation request.
  let handoff = unpack(await invoke(approve));
  assert.equal(handoff.status, "ready_for_browser");
  assert.deepEqual(handoff.hostTools, ["@Chrome", "@Computer"]);
  assert.deepEqual(handoff.fields, draft.fields);
  assert.deepEqual(handoff.attachments, draft.attachments.map(({ name, size }) => ({ name, size })));
  assert.match(handoff.handoffId, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(handoff.handoffId, review.approvalId);
  assert.match(handoff.instructions[0], /@Chrome[\s\S]*@Computer/);
  assert.equal(handoff.nextAction, "open_in_browser");
  assert.equal(handoff.openUrl, draft.draftUrl ?? draft.programUrl);
  assert.deepEqual(handoff.observe, draft.draftUrl ? ["draftUrl", ...(draft.sourceProgramUrl ? ["programUrl"] : [])] : ["programUrl"]);
  assert.match(handoff.instructions.join(" "), /only the researcher submits/i);
  await reject(invoke, approve);
  let check = handoff.checkArgs;
  let finish = { mode: "finish", draftId, handoffId: handoff.handoffId, receipt };
  let superseded;
  await reject(invoke, check);
  await reject(invoke, finish);
  if (draft.sourceProgramUrl) {
    await reject(invoke, { ...check, draftUrl });
    await reject(invoke, { ...check, programUrl: programUrl.replace("/example/", "/wrong/"), draftUrl });
    if (!draft.draftUrl) {
      const preCreate = unpack(await invoke({ ...check, programUrl }));
      assert.equal(preCreate.status, "program_checked");
      assert.equal(preCreate.nextAction, "open_or_create_draft");
      assert.deepEqual(preCreate.checkArgs, { ...check, programUrl });
      await reject(invoke, finish);
    }
  }
  const observed = { draftUrl, ...(draft.programUrl && { programUrl }) };
  const checked = unpack(await invoke({ ...check, ...observed }));
  assert.equal(checked.pickerFiles.length, draft.attachments.length);
  for (const [index, staged] of checked.pickerFiles.entries()) {
    assert.notEqual(staged.path, draft.attachments[index].path);
    assert.equal(staged.name, draft.attachments[index].name);
    assert.deepEqual(await readFile(staged.path), await readFile(draft.attachments[index].path));
  }
  assert.equal(checked.status, "handoff_checked");
  assert.equal(checked.nextAction, "fill_and_verify_draft");
  assert.deepEqual(checked.checkBeforeEditOrUpload, check);
  assert.match(checked.instructions.join(" "), /reopen the same bound draft/i);
  assert.equal(unpack(await invoke(check)).status, "handoff_checked");
  const bound = unpack(await invoke({ mode: "local", draftId }));
  assert.ok([draftUrl, draftAlias].includes(bound.draftUrl));
  if (draft.programUrl) assert.equal(bound.boundProgramUrl, programUrl);
  await reject(invoke, { ...check, ...observed, draftUrl: draftUrl.replace("000002/create", "000003/create") });
  await reject(invoke, { ...finish, receipt: { ...receipt, uploadedFiles: ["unapproved-file.txt"] } });

  if (round === 3) {
    await withPeer(async peer => {
      const visible = unpack(await peer({ mode: "status", draftId }));
      assert.equal(visible.status, "ready_for_browser");
      assert.ok(!Object.hasOwn(visible, "handoffId"));
      await reject(peer, check);
      await reject(peer, review.onDecline);
      assert.equal(unpack(await peer(visible.onDecline)).status, "cancelled");
    });
    await reject(invoke, check);
    await reject(invoke, finish);
    superseded = finish;
    const fresh = unpack(await invoke({ draftId }));
    handoff = unpack(await invoke({ ...approve, approvalId: fresh.approvalId }));
    assert.notEqual(handoff.handoffId, check.handoffId);
    check = { ...check, handoffId: handoff.handoffId };
    finish = { ...finish, handoffId: handoff.handoffId };
    await reject(invoke, check);
    assert.equal(unpack(await invoke({ ...check, ...observed })).status, "handoff_checked");
    await reject(invoke, superseded);
  }
  if (round === 4) {
    const lost = draft.attachments[0];
    await unlink(lost.path);
    await reject(invoke, check);
    await reject(invoke, { mode: "local", draftId });
    receipt.pendingFiles = [lost.name];
    receipt.uploadedFiles = receipt.uploadedFiles.filter(name => name !== lost.name);
  }
  const outcome = unpack(await invoke(finish));
  if (superseded) await reject(invoke, superseded);
  assert.equal(outcome.status, round === 4 ? "browser_reported_partial" : "browser_reported_saved");
  assert.deepEqual(outcome.receipt.pendingFiles, receipt.pendingFiles ?? []);
  assert.equal(unpack(await invoke({ mode: "status", draftId })).status, outcome.status);
  assert.deepEqual(unpack(await invoke(finish)), outcome, "Replaying the same host receipt changed its outcome");
  return { outcome, finish, superseded };
}

async function reject(call, args) {
  assert.equal((await call(args)).isError, true, "Expected a rejected draft request");
}

async function checkChangedEvidence(invoke, profile) {
  const file = path.join(profile, "stale-review.txt");
  await writeFile(file, "Approved fixture");
  const review = unpack(await invoke({
    programUrl, title: "Synthetic stale manifest", description: "Fixture.",
    attachments: [file],
  }));
  await appendFile(file, " changed after review");
  await reject(invoke, { mode: "approve", draftId: review.draftId, approvalId: review.approvalId });
}

// Vary one failure mode per round in addition to the successful create and resume.
async function exerciseFailure(round, call, args, draft, profile) {
  const resume = { draftId: draft.draftId };
  switch (round) {
    case 1: return reject(call, { ...args, programUrl: "https://example.invalid/programs/fixture/example/detail" });
    case 2: return reject(call, { ...args, attachments: ["relative.txt"] });
    case 3: return reject(call, { ...args, attachments: [path.join(profile, "missing.txt")] });
    case 4: return reject(call, { ...args, attachments: [profile] });
    case 5: {
      const large = path.join(profile, "oversized.png");
      await writeFile(large, "");
      await truncate(large, 10_000_001);
      return reject(call, { ...args, attachments: [large] });
    }
    case 6: return reject(call, { draftId: "../outside" });
    case 7: return reject(call, { ...args, unexpectedField: "example" });
    case 8: return reject(call, { ...resume, action: "submit" });
    case 9:
      await appendFile(args.attachments[0], "changed");
      return reject(call, resume);
    case 10:
      await unlink(args.attachments[0]);
      return reject(call, resume);
  }
}

async function runRound(round, root, guard) {
  const profile = path.join(root, `profile ${round}`);
  await mkdir(profile);
  const note = path.join(profile, "example evidence — 研究.txt");
  const image = path.join(profile, "sample.png");
  const fileBody = `Synthetic attachment bytes for round ${round}.\n`;
  await writeFile(note, fileBody);
  await writeFile(image, samplePng);
  const fields = {
    title: `Fixture draft ${round}`, description: "Synthetic researcher notes.\nSecond line.",
    impact: "Example impact", asset: "Example asset", vulnerabilityType: "Other", severity: "Low",
    endpoint: "https://example.invalid/example", remediation: "Example follow-up",
    testingIp: "192.0.2.1", aiDisclosure: "Assisted with formatting.",
    questions: [{ question: "Review complete?", answer: "Yes" }],
  };
  if (round === 2) delete fields.impact;
  const location = round === 10 ? { draftUrl } : round === 8 ? { programUrl, draftUrl } : { programUrl };
  const args = { ...location, ...fields, attachments: [note, image] };
  let draft;
  let snapshot;
  let firstApproval;
  await withServer(profile, guard, async invoke => {
    await checkProgramIntake(invoke, profile);
    const call = args => invoke({ mode: "local", ...args });
    if (round % 2 === 0) {
      const initial = unpack(await invoke(args));
      draft = unpack(await call({ draftId: initial.draftId }));
      checkReview(initial, draft);
      firstApproval = initial.approvalId;
    } else {
      draft = unpack(await call(args));
    }
    assert.equal(draft.status, "prepared_locally");
    assert.match(draft.draftId, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
    for (const [key, url] of Object.entries(location)) assert.equal(draft[key], url);
    assert.deepEqual(draft.fields, fields);
    assert.deepEqual(draft.missingFields, round === 2 ? ["impact"] : []);
    const relative = path.relative(profile, await realpath(draft.draftPath));
    assert.ok(relative && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative), "Draft escaped test home");
    const metadata = [];
    for (const file of args.attachments) {
      metadata.push({ path: await realpath(file), name: path.basename(file), size: (await stat(file)).size });
    }
    assert.deepEqual(draft.attachments, metadata);
    assert.equal(draft.sourceProgramUrl, location.programUrl);
    assert.equal(draft.boundProgramUrl, undefined);
    await reject(call, { draftId: draft.draftId, draftUrl });
    snapshot = await readFile(draft.draftPath, "utf8");
    assert.ok(snapshot.includes(fields.title));
    assert.ok(!snapshot.includes(fileBody.trim()), "Draft unexpectedly copied attachment bytes");
    assert.ok(!snapshot.includes("INTIGRITI_API_TOKEN"), "Draft serialized token configuration");
    await reject(call, { ...args, submit: true });
  });
  let prompts = 0;
  const elicit = async ({ params }) => {
    prompts++;
    assert.ok(params.message.includes(draft.fields.title));
    assert.ok(params.message.includes(JSON.stringify(note)));
    return { action: "accept", content: { confirmed: true } };
  };
  const withPeer = run => withServer(profile, guard, run);
  const { outcome, finish, superseded } = await withServer(profile, guard, async invoke => {
    const call = args => invoke({ mode: "local", ...args });
    assert.deepEqual(unpack(await call({ draftId: draft.draftId })), draft);
    const completed = await testHostHandoff(invoke, draft, firstApproval, round, withPeer);
    if (round === 9) await checkChangedEvidence(invoke, profile);
    await exerciseFailure(round, call, args, draft, profile);
    assert.equal(await readFile(draft.draftPath, "utf8"), snapshot);
    assert.deepEqual(await readFile(image), samplePng);
    return completed;
  }, elicit);
  assert.equal(prompts, round === 3 ? 2 : 1, "Every new consent must have one host confirmation");
  // A new server can read the durable outcome, including pending items even
  // when a selected file was deleted. It cannot reuse that attempt for edits.
  await withPeer(async peer => {
    assert.deepEqual(unpack(await peer({ mode: "status", draftId: draft.draftId })), outcome);
    assert.deepEqual(unpack(await peer(finish)), outcome);
    if (superseded) await reject(peer, superseded);
    await reject(peer, { mode: "check", draftId: draft.draftId, handoffId: finish.handoffId });
    await reject(peer, { ...finish, handoffId: "x".repeat(43) });
  });
}

async function main() {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, "Intigriti draft acceptance "));
  assert.equal(path.dirname(root), parent);
  try {
    // Verify Node's actual home resolution in each child before importing the server.
    const guard = path.join(root, "offline-guard.mjs");
    await writeFile(guard, [
      'import assert from "node:assert/strict";',
      'import childProcess from "node:child_process";',
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      'import { homedir } from "node:os";',
      'import { Socket } from "node:net";',
      'import path from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'assert.equal(homedir(), process.cwd());',
      'assert.equal(process.env.INTIGRITI_API_TOKEN, "");',
      'assert.equal(process.env.INTIGRITI_ALLOWED_PROGRAM_IDS, "");',
      'function offline() { throw new Error("Network disabled in local draft acceptance"); }',
      'globalThis.fetch = offline;',
      'Socket.prototype.connect = offline;',
      'for (const name of ["spawn", "spawnSync", "exec", "execFile", "fork"]) childProcess[name] = offline;',
      'const read = fs.readFileSync;',
      'fs.readFileSync = (file, ...args) => {',
      '  const name = file instanceof URL ? fileURLToPath(file) : String(file);',
      '  if (path.basename(name) === ".env") throw new Error("Token file disabled in local draft acceptance");',
      '  return read(file, ...args);',
      '};',
      // Record even swallowed attempts to inspect a file supplied before a finding.
      `const deferred = path.join(process.cwd(), ${JSON.stringify(deferredEvidence)});`,
      'for (const method of ["access", "lstat", "stat", "open", "readFile", "realpath"]) {',
      '  const original = fs.promises[method];',
      '  fs.promises[method] = (file, ...args) => {',
      '    if (file === deferred) {',
      '      fs.writeFileSync("unexpected-intake-inspection", method);',
      '      throw new Error("Intake inspected a deferred attachment");',
      '    }',
      '    return original.call(fs.promises, file, ...args);',
      '  };',
      '}',
      'syncBuiltinESMExports();',
    ].join("\n"));
    for (let round = 1; round <= rounds; round++) {
      await runRound(round, root, pathToFileURL(guard).href);
      console.log(`Round ${round}/${rounds} passed: program-first intake, draft persistence and native Codex handoff.`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
