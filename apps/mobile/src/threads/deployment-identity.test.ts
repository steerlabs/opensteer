import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import type { DeploymentRow, DeploymentStatus } from "../client/deployment-rows.js";
import { deploymentIdentity, sameDeploymentIdentity } from "./deployment-identity.js";

function deploymentId(tail: number): DeploymentId {
  return DeploymentIdSchema.parse(`dep_0192f4a1-1111-4000-8000-${String(tail).padStart(12, "0")}`);
}

function row(input: {
  readonly id: number;
  readonly name?: string;
  readonly status?: DeploymentStatus;
}): DeploymentRow {
  return {
    accountManaged: false,
    deploymentId: deploymentId(input.id),
    kindLabel: "Server",
    name: input.name ?? `Deployment ${input.id}`,
    origin: "https://example.com",
    signIn: input.status === "needs-sign-in" ? "host-oauth" : null,
    status: input.status ?? "connected",
    verification: null,
  };
}

describe("the open deployment's identity", () => {
  it("names the open deployment, and says when it has left this phone", () => {
    const rows = [row({ id: 1 }), row({ id: 2, name: "Studio", status: "offline" })];

    expect(deploymentIdentity(rows, deploymentId(2))).toMatchObject({
      mark: { initial: "S" },
      name: "Studio",
      status: "Offline",
    });
    expect(deploymentIdentity(rows, deploymentId(9))).toMatchObject({
      mark: { initial: "•" },
      name: "Deployment",
      status: "No longer on this phone",
    });
  });

  it("is equal to itself while nothing it shows has changed", () => {
    const rows = [row({ id: 1 }), row({ id: 2, status: "offline" })];
    const first = deploymentIdentity(rows, deploymentId(1));

    // Another deployment changing is not this one changing.
    const otherMoved = deploymentIdentity(
      [row({ id: 1 }), row({ id: 2, status: "connected" })],
      deploymentId(1),
    );
    expect(sameDeploymentIdentity(first, otherMoved)).toBe(true);

    const wentOffline = deploymentIdentity(
      [row({ id: 1, status: "offline" }), row({ id: 2 })],
      deploymentId(1),
    );
    expect(sameDeploymentIdentity(first, wentOffline)).toBe(false);
  });
});
