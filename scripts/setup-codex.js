import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { protectPrivatePath } from "../src/private-permissions.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".codex");
const destination = path.join(directory, "config.toml");
const nextStep = 'Open a new chat in this Codex project and say "Help me make a practice report on Intigriti." Drafting uses your browser sign-in.';
const section = [
  "[mcp_servers.intigriti]",
  `command = ${JSON.stringify(process.execPath)}`,
  `args = [${JSON.stringify(path.join(root, "src", "index.js"))}]`,
  'env_vars = ["INTIGRITI_API_TOKEN", "INTIGRITI_ALLOWED_PROGRAM_IDS"]',
  "startup_timeout_sec = 20",
].join("\n");

async function setup() {
  const envFile = path.join(root, ".env");
  try {
    await writeFile(envFile, "INTIGRITI_API_TOKEN=\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "EISDIR") throw error;
    if (!(await stat(envFile)).isFile()) throw new Error(`${envFile} must be a regular file.`);
  }
  try { protectPrivatePath(envFile); } catch {
    throw new Error("Could not secure .env. Use a regular file owned by your account and allow setup to restrict its permissions.");
  }
  await mkdir(directory, { recursive: true });
  // Publish a complete file in one step. A simultaneous setup or an existing
  // user configuration wins the race without being truncated or replaced.
  const temp = path.join(directory, `.intigriti-${randomUUID()}.tmp`);
  await writeFile(temp, section + "\n", { flag: "wx", mode: 0o600 });
  try {
    try {
      await link(temp, destination);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = (await readFile(destination, "utf8")).replace(/\r\n/g, "\n");
      if (("\n" + existing + "\n").includes("\n" + section + "\n")) {
        console.log(`Intigriti is already configured in ${destination}`);
        console.log(nextStep);
        return;
      }
      console.error(
        `Kept the existing configuration at ${destination}.\n` +
        "Merge the section below into this file. If it already has an Intigriti entry, " +
        "update that entry in place.\n\n" + section,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`Configured Intigriti for Codex in ${destination}`);
    console.log(nextStep);
  } finally {
    await unlink(temp);
  }
}

setup().catch((error) => {
  console.error(`Could not configure Intigriti for Codex: ${error.message}`);
  process.exitCode = 1;
});
