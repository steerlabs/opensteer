import { readFileSync } from "node:fs";
import { loadControlPlaneMigrationConfig } from "../config.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { ControlPlaneError } from "../server/errors.js";
import { AgentDirectoryStore } from "./store.js";

const usage =
  "Usage: agent-directory-operator-main.js list | add <json-file> | update <id> <json-file> | remove <id>";

async function main([action, first, second, ...rest]: readonly string[]): Promise<void> {
  const config = loadControlPlaneMigrationConfig();
  const db = createControlPlaneDatabase({
    connectionString: config.databaseUrl,
    maxConnections: 1,
  });
  const store = new AgentDirectoryStore(db);
  try {
    let result: unknown;
    if (action === "list" && !first) {
      result = await store.list();
    } else if (action === "add" && first && !second) {
      result = await store.add(readJsonFile(first));
    } else if (action === "update" && first && second && rest.length === 0) {
      result = await store.update(first, readJsonFile(second));
    } else if (action === "remove" && first && !second) {
      result = await store.remove(first);
    } else {
      throw new ControlPlaneError("bad_request", usage);
    }
    console.info(JSON.stringify(result));
  } finally {
    await db.destroy();
  }
}

function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ControlPlaneError("bad_request", `Could not read ${path}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ControlPlaneError("bad_request", `Invalid JSON in ${path}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(
    error instanceof ControlPlaneError ? error.message : "Agent directory operator command failed",
  );
  process.exitCode = 1;
});
