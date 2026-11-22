// Build, install and start the real package under a disposable user profile.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const allowed = new Set([...manifest.files, "README.md", "LICENSE", "package.json"]);
assert.ok(process.env.npm_execpath, "Run npm run test:package from the source checkout.");
const npm = (args, cwd) => run(process.execPath, [process.env.npm_execpath, ...args], { cwd });
const tempRoot = await realpath(tmpdir());

for (let round = 1; round <= 5; round++) {
  const prefix = await mkdtemp(path.join(tempRoot, "intigriti-package-qa-"));
  const client = new Client({ name: "packaged-client-smoke", version: "1" });
  try {
    const pack = await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", prefix], root);
    const [archive] = JSON.parse(pack.stdout);
    assert.deepEqual(new Set(archive.files.map(file => file.path)), allowed);
    assert.ok(archive.files.every(file => !/(?:^|\/)(?:\.env|\.codex|QA\.md|PLAN\.md)(?:$|[./])/i.test(file.path)));
    await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline",
      "--prefix", prefix, path.join(prefix, archive.filename)], prefix);
    const installed = path.join(prefix, "node_modules", manifest.name);
    await run(process.execPath, [path.join(installed, "scripts", "setup-codex.js")], { cwd: prefix });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [path.join(installed, "src", "index.js")], cwd: prefix,
      env: { HOME: prefix, USERPROFILE: prefix, INTIGRITI_API_TOKEN: "", INTIGRITI_ALLOWED_PROGRAM_IDS: "" },
    }));
    const catalog = await client.listTools();
    assert.equal(catalog.tools.length, 9);
    const call = (name, args) => client.callTool({ name, arguments: args });
    assert.equal((await call("prepare_report_draft", {})).structuredContent.status, "awaiting_program");
    assert.equal((await call("get_inbox_reports", { listStatus: "Pending" })).structuredContent.status, "awaiting_inbox_read");
    assert.match((await call("list_payouts", {})).content[0].text, /confirmation form/);
    console.log(`Package round ${round}/5 passed: archive membership, clean installation, setup and stdio calls.`);
  } finally {
    await client.close();
    assert.equal(path.dirname(await realpath(prefix)), tempRoot);
    await rm(prefix, { recursive: true, force: true });
  }
}
