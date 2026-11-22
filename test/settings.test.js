import assert from "node:assert/strict";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { readSettings } from "../src/settings.js";

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

test("reads only connector settings and honors each explicit environment override", async (t) => {
  const file = await settingsFile(t);
  await writeFile(file, [
    "INTIGRITI_API_TOKEN='file-token'",
    "INTIGRITI_ALLOWED_PROGRAM_IDS=first,second",
    "UNRELATED_SETTING=ignored",
  ].join("\n"));
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
