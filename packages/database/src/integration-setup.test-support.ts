import { mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { inject } from "vitest";
import type {} from "./integration-global-setup.test-support.js";

const slot = Number(process.env.VITEST_POOL_ID);
const databases = inject("integrationDatabases");
const pair = Number.isInteger(slot) && slot > 0 ? databases[slot - 1] : undefined;
if (!pair) throw new Error(`No integration databases provisioned for worker slot ${slot}`);
process.env.OPENSTEER_TEST_DATABASE_URL = pair.host;
process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL = pair.controlPlane;

const directory = process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY!;
const file = basename(process.env.VITEST_WORKER_ID!);
const suffix = `${basename(directory)}-${slot}-${file}`;
for (const [key, value] of Object.entries(process.env)) {
  if (!value || !key.startsWith("OPENSTEER_")) continue;
  if (
    key.endsWith("_ARTIFACT_DIR") ||
    key.endsWith("_EVIDENCE_DIR") ||
    [
      "OPENSTEER_EXECUTION_PLANE_E2E_OUTPUT",
      "OPENSTEER_CONVERSATION_DELIVERY_OUTPUT",
      "OPENSTEER_HOME_ACCEPTANCE_OUTPUT",
      "OPENSTEER_ATTACHMENT_E2E_OUTPUT",
      "OPENSTEER_CONVERSATION_CLIENT_OUTPUT",
    ].includes(key)
  )
    process.env[key] = join(value, suffix);
  else if (key.endsWith("_ARTIFACT_PATH") || key.endsWith("_EVIDENCE")) {
    process.env[key] = join(dirname(value), suffix, basename(value));
    mkdirSync(dirname(process.env[key]!), { recursive: true });
  }
}
for (const key of [
  "OPENSTEER_SHARED_BROWSER_E2E_ARTIFACT_DIR",
  "OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR",
  "OPENSTEER_PROPOSAL_CREDENTIAL_ARTIFACT_DIR",
  "OPENSTEER_BROWSER_SOURCE_E2E_ARTIFACT_DIR",
  "OPENSTEER_STATE_IMPORT_E2E_ARTIFACT_DIR",
  "OPENSTEER_PASSKEY_POLICY_E2E_ARTIFACT_DIR",
  "OPENSTEER_CDP_BOUNDARY_E2E_ARTIFACT_DIR",
]) {
  process.env[key] ??= join(directory, "artifacts", `${slot}-${file}`, key.toLowerCase());
}
