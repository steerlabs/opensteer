import { expect, it } from "vitest";
import { DeploymentShapeSchema, deploymentPolicy, hostExposurePolicy } from "./index.js";
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
it("derives local supervision and Remote access from exposure, not from the personal kind", () => {
  expect(hostExposurePolicy({ kind: "personal" }, "loopback")).toMatchObject({
    colocatedHostingRunner: true,
    localOwnerClaim: true,
    operatorOwnerSetup: false,
    personalRemoteAccess: true,
  });
  expect(hostExposurePolicy({ kind: "personal" }, "networked")).toMatchObject({
    colocatedHostingRunner: true,
    localOwnerClaim: false,
    operatorOwnerSetup: true,
    personalRemoteAccess: false,
  });
  for (const exposure of ["loopback", "networked"] as const)
    expect(hostExposurePolicy({ kind: "team" }, exposure)).toMatchObject({
      colocatedHostingRunner: false,
      localOwnerClaim: false,
      operatorOwnerSetup: true,
      personalRemoteAccess: false,
      requiresAccountSignIn: true,
    });
});
