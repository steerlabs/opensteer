import type { TestProject } from "vitest/node";
import { createTestDatabaseRun } from "./test-database-admin.test-support.js";

/** Database-backed engine/device suites use the same run templates as integration. */
export default async function setup(_project: TestProject) {
  const host = process.env.OPENSTEER_TEST_DATABASE_URL;
  const controlPlane = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
  if (!host || !controlPlane)
    throw new Error("Tests require both Host and Control Plane database URLs");
  const run = await createTestDatabaseRun({ host, controlPlane });
  process.env.OPENSTEER_TEST_DATABASE_TEMPLATES = JSON.stringify(run.templates);
  return run.cleanup;
}
