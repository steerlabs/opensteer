import { expect, it } from "vitest";
import { DeploymentShapeSchema, hostExposurePolicy } from "./index.js";
it("refuses the removed deployment kinds and backing axis", () => {
  expect(DeploymentShapeSchema.safeParse({ kind: "server" }).success).toBe(false);
  expect(DeploymentShapeSchema.safeParse({ kind: "team" }).success).toBe(false);
  expect(
    DeploymentShapeSchema.safeParse({
      kind: "personal",
      defaultWorkspaceBacking: "local-directory",
    }).success,
  ).toBe(false);
});
it("derives local supervision and Remote access from exposure", () => {
  expect(hostExposurePolicy("loopback")).toMatchObject({
    localOwnerClaim: true,
    operatorOwnerSetup: false,
    personalRemoteAccess: true,
  });
  expect(hostExposurePolicy("networked")).toMatchObject({
    localOwnerClaim: false,
    operatorOwnerSetup: true,
    personalRemoteAccess: false,
  });
});
