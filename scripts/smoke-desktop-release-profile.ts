import { createHash } from "node:crypto";
import { createId } from "../packages/core/src/ids.js";
import {
  PersonalDeploymentManifestSchema,
  PersonalRuntimeIdentitySchema,
} from "../apps/desktop/src/secrets/personal-deployment-store.js";
import { DeploymentCatalogSchema } from "../packages/client/src/connections/deployment-catalog.js";

/** Persist only the choice to start Personal; the app creates its database and credentials. */
export function personalSetupIntent(releaseBytes: string, hostPort: number, postgresPort: number) {
  const release = PersonalRuntimeIdentitySchema.parse({
    ...PersonalRuntimeIdentitySchema.omit({ manifestSha256: true })
      .strip()
      .parse(JSON.parse(releaseBytes)),
    manifestSha256: createHash("sha256").update(releaseBytes).digest("hex"),
  });
  const now = new Date().toISOString();
  return PersonalDeploymentManifestSchema.parse({
    createdAt: now,
    updatedAt: now,
    revision: 0,
    schemaVersion: 3,
    databaseInitialized: false,
    ownerInitialized: false,
    hostKeyFingerprint: null,
    deploymentId: createId("deployment"),
    environmentId: createId("environment"),
    hostInstanceId: createId("hostInstance"),
    runnerId: createId("runner"),
    setupIntentId: crypto.randomUUID(),
    name: "Release launch check",
    hostPort,
    postgresPort,
    release,
  });
}

/** The supervisor publishes this selection only after owner, Runner and agent-home readiness. */
export function personalSelectionReady(serialized: string, deploymentId: string): boolean {
  const catalog = DeploymentCatalogSchema.parse(JSON.parse(serialized));
  return (
    catalog.selectedDeploymentId === deploymentId &&
    catalog.deployments.some(
      (entry) =>
        entry.authority.document.deploymentId === deploymentId && entry.kind === "personal",
    )
  );
}

/** Normal HOME is permitted only on disposable test infrastructure. */
export function assertEphemeralRunner(
  environment: Readonly<Record<string, string | undefined>>,
  guest: boolean,
): void {
  if (
    guest ||
    (environment.CI === "true" &&
      !!environment.RUNNER_TEMP?.trim() &&
      path.isAbsolute(environment.RUNNER_TEMP))
  )
    return;
  throw Error(
    "External desktop launch check requires an ephemeral CI runner (CI=true and RUNNER_TEMP) or the test:vm guest marker; refusing to use the host HOME",
  );
}
