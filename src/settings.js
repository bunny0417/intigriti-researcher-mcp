import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { verifyPrivateFile } from "./private-permissions.js";

const projectEnv = new URL("../.env", import.meta.url);

export function readSettings(file = projectEnv, env = process.env) {
  const token = env.INTIGRITI_API_TOKEN;
  const allowedProgramIds = env.INTIGRITI_ALLOWED_PROGRAM_IDS;
  if (token !== undefined && allowedProgramIds !== undefined) return { token, allowedProgramIds };
  let local = {};
  try {
    const expected = verifyPrivateFile(file);
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const actual = fstatSync(fd, { bigint: true });
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.nlink !== 1n) {
        throw new Error("Token file changed.");
      }
      local = parseEnv(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error("Could not read the MCP project's private .env file. Run npm run setup:codex under your own account to secure its permissions.");
    }
  }
  return {
    token: token ?? local.INTIGRITI_API_TOKEN,
    allowedProgramIds: allowedProgramIds ?? local.INTIGRITI_ALLOWED_PROGRAM_IDS,
  };
}
