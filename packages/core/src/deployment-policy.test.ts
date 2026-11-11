import { expect, it } from "vitest";
import { DeploymentShapeSchema, deploymentPolicy } from "./index.js";
it("refuses the removed deployment kind and backing axis", () => {
  expect(DeploymentShapeSchema.safeParse({ kind: "server" }).success).toBe(false);
  expect(
    DeploymentShapeSchema.safeParse({
      kind: "personal",
      defaultWorkspaceBacking: "local-directory",
    }).success,
  ).toBe(false);
});
it("constructs private execution only for personal installations", () => {
  expect(deploymentPolicy({ kind: "personal" }).services).toEqual({ personal: true, team: false });
  expect(deploymentPolicy({ kind: "team" }).services).toEqual({ personal: false, team: true });
});
