import {
  DeploymentShapeSchema,
  deploymentSupportsSharing,
  localWorkspaceNamespace,
  createId,
  type EnvironmentId,
  type WorkspaceBacking,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { assertExecutionAllowedByDeployment } from "./index.js";

describe("deployment Workspace shape", () => {
  it.each([
    { kind: "personal" as const, sharing: false, namespace: "single-owner" },
    { kind: "server" as const, sharing: true, namespace: "owner-scoped" },
  ])("preserves $kind sharing and storage namespace", ({ kind, sharing, namespace }) => {
    const shape = { kind, defaultWorkspaceBacking: "local-directory" as const };
    expect(deploymentSupportsSharing(shape)).toBe(sharing);
    expect(localWorkspaceNamespace(shape)).toBe(namespace);
  });

  const environmentId = createId("environment") as EnvironmentId;
  const local: WorkspaceBacking = {
    bindingId: createId("workspaceBinding"),
    generation: 1,
    kind: "local-directory",
    ownerEnvironmentId: environmentId,
    storageAuthorityId: createId("storageAuthority"),
  };

  it("rejects remote execution for local-directory Workspaces", () => {
    const shape = DeploymentShapeSchema.parse({
      defaultWorkspaceBacking: "local-directory",
      kind: "server" as const,
    });
    expect(() =>
      assertExecutionAllowedByDeployment({
        backing: local,
        executionEnvironmentId: createId("environment"),
        shape,
      }),
    ).toThrow("only in its owning environment");
  });
});
