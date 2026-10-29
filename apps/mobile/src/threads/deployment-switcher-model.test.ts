import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import type { DeploymentRow, DeploymentStatus } from "../client/deployment-rows.js";
import {
  deploymentSwitcherModel,
  sameDeploymentSwitcherModel,
} from "./deployment-switcher-model.js";

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

describe("the deployment switcher", () => {
  it("leads with the open deployment and checks it", () => {
    const rows = [row({ id: 1 }), row({ id: 2 }), row({ id: 3 })];
    const model = deploymentSwitcherModel(rows, deploymentId(3));

    expect(model.items.map((item) => item.deploymentId)).toEqual([
      deploymentId(3),
      deploymentId(1),
      deploymentId(2),
    ]);
    expect(model.items[0]).toMatchObject({ current: true, glyph: "checkmark" });
    expect(model.name).toBe("Deployment 3");
    expect(model.seeAll).toBe(false);
  });

  it("hands a long list over to the switcher screen rather than growing the menu", () => {
    const rows = Array.from({ length: 9 }, (_, index) => row({ id: index + 1 }));
    const model = deploymentSwitcherModel(rows, deploymentId(8));

    expect(model.items).toHaveLength(6);
    // The open one is checked even though the catalog lists it past the cut.
    expect(model.items[0]?.deploymentId).toBe(deploymentId(8));
    expect(model.seeAll).toBe(true);
  });

  it("is equal to itself while nothing it shows has changed", () => {
    const rows = [row({ id: 1 }), row({ id: 2, status: "offline" })];
    const first = deploymentSwitcherModel(rows, deploymentId(1));

    const rebuilt = deploymentSwitcherModel([...rows], deploymentId(1));
    expect(sameDeploymentSwitcherModel(first, rebuilt)).toBe(true);

    const cameBack = deploymentSwitcherModel(
      [row({ id: 1 }), row({ id: 2, status: "connected" })],
      deploymentId(1),
    );
    expect(sameDeploymentSwitcherModel(first, cameBack)).toBe(false);
  });
});
