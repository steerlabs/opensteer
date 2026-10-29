import { createId, type DeploymentId } from "@opensteer/core";
import type { DesktopLocalExecutionStatus } from "@opensteer/protocol/desktop";
import { describe, expect, it, vi } from "vitest";
import { observeLocalExecutionStatus } from "./local-execution-status.js";

describe("observeLocalExecutionStatus", () => {
  it("delivers an unexpected background failure after the initial running state", async () => {
    const deploymentId = createId("deployment");
    let pushed: ((status: DesktopLocalExecutionStatus) => void) | undefined;
    const running = status(deploymentId, "running");
    const listener = vi.fn();
    const unsubscribe = vi.fn();
    const detach = observeLocalExecutionStatus(
      {
        getLocalExecutionStatus: vi.fn(async () => running),
        onLocalExecutionStatusChanged: (next) => {
          pushed = next;
          return unsubscribe;
        },
      },
      deploymentId,
      listener,
      vi.fn(),
    );
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(running));

    const failed = status(deploymentId, "failed");
    pushed?.(failed);
    expect(listener).toHaveBeenLastCalledWith(failed);

    detach();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not overwrite a pushed failure with an older initial response", async () => {
    const deploymentId = createId("deployment");
    let pushed: ((status: DesktopLocalExecutionStatus) => void) | undefined;
    let resolveInitial: ((status: DesktopLocalExecutionStatus) => void) | undefined;
    const initial = new Promise<DesktopLocalExecutionStatus>((resolve) => {
      resolveInitial = resolve;
    });
    const listener = vi.fn();
    observeLocalExecutionStatus(
      {
        getLocalExecutionStatus: vi.fn(() => initial),
        onLocalExecutionStatusChanged: (next) => {
          pushed = next;
          return () => undefined;
        },
      },
      deploymentId,
      listener,
      vi.fn(),
    );

    const failed = status(deploymentId, "failed");
    pushed?.(failed);
    resolveInitial?.(status(deploymentId, "running"));
    await initial;

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(failed);
  });
});

function status(
  deploymentId: DeploymentId,
  state: "failed" | "running",
): DesktopLocalExecutionStatus {
  return {
    available: true,
    computerName: "Alex's MacBook Pro",
    deploymentId,
    mayRunAgents: true,
    platform: "macos",
    portableFs: {
      binaryPath: null,
      detail: "Optional shared storage is not installed.",
      installAvailable: true,
      issue: null,
      state: "missing",
      version: null,
    },
    runAgents: true,
    runner: {
      detail: state === "failed" ? "Local agents stopped unexpectedly." : "Ready",
      enrolled: true,
      environmentId: createId("environment"),
      runnerId: createId("runner"),
      state,
    },
    schemaVersion: 4,
  };
}
