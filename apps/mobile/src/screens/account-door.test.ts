import { DeploymentIdSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import type { DeploymentRow } from "../client/deployment-rows.js";
import {
  accountFlowCanContinue,
  deploymentCanOpen,
  deploymentOpenLabel,
  eligibleSingletonDeployment,
} from "./account-door.js";

function row(input: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    accountManaged: true,
    deploymentId: DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001"),
    kindLabel: "Server",
    name: "Production",
    origin: "https://production.example.com",
    signIn: null,
    status: "signed-in",
    verification: null,
    ...input,
  };
}

describe("Deployments presentation", () => {
  it("auto-opens only one eligible row after Account sign-in", () => {
    const eligible = row();
    const blocked = row({
      deploymentId: DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000002"),
      status: "update-required",
      verification: "host-too-old",
    });
    expect(eligibleSingletonDeployment([eligible, blocked])).toBe(eligible);
    expect(eligibleSingletonDeployment([eligible, row({ name: "Staging" })])).toBeNull();
    expect(eligibleSingletonDeployment([blocked])).toBeNull();
  });
});

describe("deployment row action", () => {
  it.each(["unverified", "update-required"] as const)(
    "turns %s into an explanation instead of a selection",
    (status) => {
      const blocked = row({
        status,
        verification: status === "unverified" ? "identity-mismatch" : "client-too-old",
      });
      expect(deploymentCanOpen(blocked)).toBe(false);
      expect(deploymentOpenLabel(blocked)).toBe("Show why Production cannot open");
    },
  );
});

describe("Account flow continuation", () => {
  const current = {
    active: true,
    currentGeneration: 3,
    currentSelection: "deployment-a",
    expectedGeneration: 3,
    expectedSelection: "deployment-a",
  } as const;

  it("continues only while its screen, generation and selection are current", () => {
    expect(accountFlowCanContinue(current)).toBe(true);
  });

  it.each([
    ["dismissed", { active: false }],
    ["superseded", { currentGeneration: 4 }],
    ["selection changed", { currentSelection: "deployment-b" }],
  ] as const)("stops when the flow is %s", (_reason, change) => {
    expect(accountFlowCanContinue({ ...current, ...change })).toBe(false);
  });
});
