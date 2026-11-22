import assert from "node:assert/strict";
import { chmod, link, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { readSettings } from "../src/settings.js";
import { protectPrivatePath } from "../src/private-permissions.js";

async function settingsFile(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "intigriti-settings-"));
  const file = pathToFileURL(path.join(directory, ".env"));
  t.after(async () => {
    await rm(file, { force: true });
    await rmdir(directory);
  });
  return file;
}

test("a missing .env allows discovery with absent or environment-only settings", async (t) => {
  const file = await settingsFile(t);
  assert.deepEqual(readSettings(file, {}), { token: undefined, allowedProgramIds: undefined });
  assert.deepEqual(readSettings(file, { INTIGRITI_API_TOKEN: "synthetic" }), {
    token: "synthetic", allowedProgramIds: undefined,
  });
});

test("explicit settings work even when the project env file cannot be read", async (t) => {
  const file = await settingsFile(t);
  // Reading the containing directory as a file would fail on Windows.
  const unreadable = new URL(".", file);
  assert.deepEqual(readSettings(unreadable, {
    INTIGRITI_API_TOKEN: "",
    INTIGRITI_ALLOWED_PROGRAM_IDS: "",
  }), { token: "", allowedProgramIds: "" });
});

test("runtime refuses a broadly accessible token file until setup secures it", async t => {
  const file = await settingsFile(t);
  await writeFile(file, "INTIGRITI_API_TOKEN=fixture-only");
  if (process.platform !== "win32") await chmod(file, 0o644);
  assert.throws(() => readSettings(file, {}), /setup:codex/);
  protectPrivatePath(file);
  assert.equal(readSettings(file, {}).token, "fixture-only");
  const alias = new URL("alias", file);
  await link(file, alias);
  try {
    assert.throws(() => readSettings(file, {}), /setup:codex/);
    assert.throws(() => protectPrivatePath(alias), /single-link/);
  } finally { await rm(alias); }
});

test("reads only connector settings and honors each explicit environment override", async (t) => {
  const file = await settingsFile(t);
  await writeFile(file, [
    "INTIGRITI_API_TOKEN='file-token'",
    "INTIGRITI_ALLOWED_PROGRAM_IDS=first,second",
    "UNRELATED_SETTING=ignored",
  ].join("\n"));
  protectPrivatePath(file);
  assert.deepEqual(readSettings(file, {}), {
    token: "file-token", allowedProgramIds: "first,second",
  });
  assert.deepEqual(readSettings(file, { INTIGRITI_API_TOKEN: "" }), {
    token: "", allowedProgramIds: "first,second",
  });
  assert.deepEqual(readSettings(file, { INTIGRITI_ALLOWED_PROGRAM_IDS: "only-this" }), {
    token: "file-token", allowedProgramIds: "only-this",
  });
});
