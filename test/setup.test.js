import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "Intigriti setup "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts");
  const setup = path.join(scripts, "setup-codex.js");
  await mkdir(scripts);
  await copyFile(new URL("../scripts/setup-codex.js", import.meta.url), setup);
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const directory = path.join(root, ".codex");
  return {
    root, directory, config: path.join(directory, "config.toml"),
    setup: () => run(process.execPath, [setup], {
      env: { ...process.env, INTIGRITI_API_TOKEN: "sentinel-token" },
    }),
  };
}

test("concurrent installs produce one secret-free project config with absolute paths", async (t) => {
  const project = await fixture(t);
  await Promise.all([project.setup(), project.setup()]);
  const config = await readFile(project.config, "utf8");
  assert.ok(config.includes(`command = ${JSON.stringify(process.execPath)}`));
  assert.ok(config.includes(`args = [${JSON.stringify(path.join(project.root, "src", "index.js"))}]`));
  assert.ok(config.includes('env_vars = ["INTIGRITI_API_TOKEN", "INTIGRITI_ALLOWED_PROGRAM_IDS"]'));
  assert.ok(!config.includes("sentinel-token"));
  assert.deepEqual(await readdir(project.directory), ["config.toml"]);
  const envFile = path.join(project.root, ".env");
  assert.equal(await readFile(envFile, "utf8"), "INTIGRITI_API_TOKEN=\n");
  const populated = "INTIGRITI_API_TOKEN=synthetic-local-token\n";
  await writeFile(envFile, populated);
  const { stdout } = await project.setup();
  assert.match(stdout, /already configured/);
  assert.equal(await readFile(project.config, "utf8"), config);
  assert.equal(await readFile(envFile, "utf8"), populated);
});

test("an existing config with a different Intigriti entry is preserved byte-for-byte", async (t) => {
  const project = await fixture(t);
  const original = '[mcp_servers.intigriti]\r\ncommand = "custom-command"\r\n';
  await mkdir(project.directory);
  await writeFile(project.config, original);
  await assert.rejects(project.setup(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /update that entry in place/);
    assert.match(error.stderr, /\[mcp_servers\.intigriti\]/);
    assert.ok(!error.stderr.includes("sentinel-token"));
    return true;
  });
  assert.equal(await readFile(project.config, "utf8"), original);
});

test("setup identifies a directory at the token file path before claiming success", async (t) => {
  const project = await fixture(t);
  await mkdir(path.join(project.root, ".env"));
  await assert.rejects(project.setup(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /\.env.*regular file/i);
    return true;
  });
  await assert.rejects(readFile(project.config), { code: "ENOENT" });
});
