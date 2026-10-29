import { DeploymentIdSchema } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import type { DeploymentRow } from "../client/deployment-rows.js";
import { deploymentRecoveryLabel, runDeploymentRecovery } from "./deployment-recovery.js";

function row(input: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    accountManaged: true,
    deploymentId: DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001"),
    kindLabel: "Server",
    name: "Production",
    origin: "https://production.example.com",
    signIn: "host-oauth",
    status: "needs-sign-in",
    verification: null,
    ...input,
  };
}

function recoveryHarness() {
  const calls: string[] = [];
  return {
    calls,
    client: {
      openDeployment: vi.fn(async () => {
        calls.push("open-deployment");
      }),
      refreshDirectory: vi.fn(async () => {
        calls.push("refresh-directory");
      }),
      signIn: vi.fn(async () => {
        calls.push("host-sign-in");
      }),
      signInAccount: vi.fn(async () => {
        calls.push("account-sign-in");
      }),
    },
    navigation: {
      navigate: vi.fn(() => {
        calls.push("pairing-code");
      }),
    },
  };
}

describe("deployment recovery", () => {
  it("opens the pairing form without retrying a refused session exchange", async () => {
    const harness = recoveryHarness();
    const deployment = row({ sessionFailure: "pairing-required", signIn: "pairing-code" });

    await runDeploymentRecovery(harness.client, harness.navigation, deployment);

    expect(harness.calls).toEqual(["pairing-code"]);
    expect(harness.navigation.navigate).toHaveBeenCalledWith("AddPersonal");
    expect(deploymentRecoveryLabel(deployment)).toBe("Enter a pairing code");
  });

  it("renews Account authorization before retrying an account-required deployment", async () => {
    const harness = recoveryHarness();
    const deployment = row({ sessionFailure: "account-required", signIn: "account-grant" });

    await runDeploymentRecovery(harness.client, harness.navigation, deployment);

    expect(harness.calls).toEqual(["account-sign-in", "refresh-directory", "open-deployment"]);
    expect(harness.client.openDeployment).toHaveBeenCalledWith(deployment.deploymentId);
    expect(deploymentRecoveryLabel(deployment)).toBe("Sign in with Opensteer");
  });

  it("stops an Account recovery when authorization fails", async () => {
    const harness = recoveryHarness();
    harness.client.signInAccount.mockRejectedValueOnce(new Error("cancelled"));

    await expect(
      runDeploymentRecovery(
        harness.client,
        harness.navigation,
        row({ sessionFailure: "account-required", signIn: "account-grant" }),
      ),
    ).rejects.toThrow("cancelled");

    expect(harness.client.refreshDirectory).not.toHaveBeenCalled();
    expect(harness.client.openDeployment).not.toHaveBeenCalled();
  });
});
