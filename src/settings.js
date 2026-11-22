import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const projectEnv = new URL("../.env", import.meta.url);

export function readSettings(file = projectEnv, env = process.env) {
  const token = env.INTIGRITI_API_TOKEN;
  const allowedProgramIds = env.INTIGRITI_ALLOWED_PROGRAM_IDS;
  if (token !== undefined && allowedProgramIds !== undefined) return { token, allowedProgramIds };
  let local = {};
  try {
    local = parseEnv(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error("Could not read the MCP project's .env file. Check its permissions and format.");
    }
  }
  return {
    token: token ?? local.INTIGRITI_API_TOKEN,
    allowedProgramIds: allowedProgramIds ?? local.INTIGRITI_ALLOWED_PROGRAM_IDS,
  };
}
