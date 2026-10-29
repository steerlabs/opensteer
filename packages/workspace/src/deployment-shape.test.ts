import {
  DeploymentShapeSchema,
  createId,
  type EnvironmentId,
  type WorkspaceBacking,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { assertBackingAllowedByDeployment, assertExecutionAllowedByDeployment } from "./index.js";

describe("deployment Workspace shape", () => {
  const environmentId = createId("environment") as EnvironmentId;
  const local: WorkspaceBacking = {
    bindingId: createId("workspaceBinding"),
    generation: 1,
    kind: "local-directory",
    ownerEnvironmentId: environmentId,
    storageAuthorityId: createId("storageAuthority"),
  };
  const portableFs: WorkspaceBacking = {
    generation: 1,
    kind: "portablefs",
    serviceId: "svc",
    volumeId: "vol-1",
  };

  it("admits a local directory on a Deployment whose default is PortableFS", () => {
    const shape = DeploymentShapeSchema.parse({
      defaultWorkspaceBacking: "portablefs",
      kind: "server" as const,
    });
    expect(() => assertBackingAllowedByDeployment(shape, local)).not.toThrow();
  });

  it("rejects PortableFS when the Deployment has no PortableFS authority", () => {
    const shape = DeploymentShapeSchema.parse({
      defaultWorkspaceBacking: "local-directory",
      kind: "server" as const,
    });
    expect(() => assertBackingAllowedByDeployment(shape, portableFs)).toThrow(
      "no PortableFS storage authority",
    );
  });

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
