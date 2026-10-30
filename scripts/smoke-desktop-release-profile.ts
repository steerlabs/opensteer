import { createHash } from "node:crypto";
import path from "node:path";
import { createId } from "../packages/core/src/ids.js";
import {
  PersonalDeploymentManifestSchema,
  PersonalRuntimeIdentitySchema,
} from "../apps/desktop/src/secrets/personal-deployment-store.js";
import { DeploymentCatalogSchema } from "../packages/client/src/connections/deployment-catalog.js";

/** Persist only the choice to start Personal; the app creates its database and credentials. */
export function personalSetupIntent(
  releaseBytes: string,
  home: string,
  hostPort: number,
  postgresPort: number,
) {
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
    workspaceRoot: path.join(home, "Workspaces"),
  });
}

/** The supervisor publishes this selection only after owner, Runner and Main readiness. */
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
