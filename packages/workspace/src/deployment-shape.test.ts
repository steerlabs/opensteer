import {
  DeploymentShapeSchema,
  createId,
  type EnvironmentId,
  type WorkspaceBacking,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { assertExecutionAllowedByDeployment } from "./index.js";

describe("deployment Workspace shape", () => {
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
