import { describe, expect, it } from "vitest";
import type { DeploymentAccessSnapshot } from "@opensteer/protocol/desktop";
import { settleAccountLinkOperation } from "./use-personal-account-link.js";

describe("settleAccountLinkOperation", () => {
  it("waits for the link operation to settle before reporting the link", async () => {
    const bridge = accessBridge(snapshot({ linkStatus: "unlinked", operation: "linking" }));
    const settled = settleAccountLinkOperation({ bridge, operation: "link" });

    bridge.emit(snapshot({ linkStatus: "unlinked", operation: "linking" }));
    bridge.emit(snapshot({ linkStatus: "linked", operation: null }));

    await expect(settled).resolves.toMatchObject({ kind: "linked", succeeded: true });
  });

  it("resolves immediately when the bridge already reports a linked deployment", async () => {
    const bridge = accessBridge(snapshot({ linkStatus: "linked", operation: null }));

    await expect(settleAccountLinkOperation({ bridge, operation: "link" })).resolves.toMatchObject({
      kind: "linked",
      succeeded: true,
    });
  });

  /**
   * The state the old success toast swallowed: the Host has committed the
   * link, the Account has not activated it, and the operation slot is empty.
   * Neither a success nor a failure — an unfinished thing with a next step.
   */
  it("reports a link left activating as pending, never as success", async () => {
    const bridge = accessBridge(snapshot({ linkStatus: "unlinked", operation: "linking" }));
    const settled = settleAccountLinkOperation({ bridge, operation: "link" });

    bridge.emit(snapshot({ linkStatus: "activating", operation: "linking" }));
    bridge.emit(snapshot({ linkStatus: "activating", operation: null }));

    const outcome = await settled;
    expect(outcome.kind).toBe("activation-pending");
    expect(outcome.succeeded).toBe(false);
    expect(outcome.message).toContain("Finish adding");
  });

  it("treats a repair-needing link and another Account as failures of the link", async () => {
    const repair = accessBridge(snapshot({ linkStatus: "unlinked", operation: "linking" }));
    const settledRepair = settleAccountLinkOperation({ bridge: repair, operation: "link" });
    repair.emit(snapshot({ linkStatus: "needs-repair", operation: null }));

    const elsewhere = accessBridge(snapshot({ linkStatus: "unlinked", operation: "linking" }));
    const settledElsewhere = settleAccountLinkOperation({ bridge: elsewhere, operation: "link" });
    elsewhere.emit(snapshot({ linkStatus: "linked-elsewhere", operation: null }));

    await expect(settledRepair).resolves.toMatchObject({
      kind: "needs-repair",
      succeeded: false,
    });
    await expect(settledElsewhere).resolves.toMatchObject({
      kind: "linked-elsewhere",
      succeeded: false,
    });
  });

  it("settles a repair once the records stop disagreeing", async () => {
    const bridge = accessBridge(snapshot({ linkStatus: "needs-repair", operation: "repairing" }));
    const settled = settleAccountLinkOperation({ bridge, operation: "repair" });

    bridge.emit(snapshot({ linkStatus: "unlinked", operation: null }));

    await expect(settled).resolves.toMatchObject({ kind: "repaired", succeeded: true });
  });

  it("keeps waiting while a different operation holds the machine", async () => {
    const bridge = accessBridge(snapshot({ linkStatus: "unlinked", operation: "linking" }));
    let resolved = false;
    const settled = settleAccountLinkOperation({ bridge, operation: "link" }).then((outcome) => {
      resolved = true;
      return outcome;
    });

    bridge.emit(snapshot({ linkStatus: "unlinked", operation: "other" }));
    await Promise.resolve();
    expect(resolved).toBe(false);

    bridge.emit(snapshot({ linkStatus: "linked", operation: null }));
    await expect(settled).resolves.toMatchObject({ kind: "linked" });
  });

  it("does not report success while the link status is still unlinked mid-sign-in", async () => {
    const bridge = accessBridge(snapshot({ linkStatus: "unlinked", operation: "authorizing" }));
    let resolved = false;
    const settled = settleAccountLinkOperation({ bridge, operation: "link" }).then((status) => {
      resolved = true;
      return status;
    });

    bridge.emit(snapshot({ linkStatus: "unlinked", operation: "authorizing" }));
    await Promise.resolve();
    expect(resolved).toBe(false);

    bridge.emit(snapshot({ linkStatus: "linked", operation: null }));
    await expect(settled).resolves.toMatchObject({ kind: "linked" });
  });

  it("rejects when aborted so callers can stop the resume on unmount", async () => {
    const bridge = accessBridge(snapshot({ linkStatus: "unlinked", operation: "linking" }));
    const controller = new AbortController();
    const settled = settleAccountLinkOperation({
      bridge,
      operation: "link",
      signal: controller.signal,
    });

    controller.abort();

    await expect(settled).rejects.toThrow("interrupted");
  });

  it("rejects without subscribing when the caller already unmounted", async () => {
    const bridge = accessBridge(snapshot({ linkStatus: "unlinked", operation: "linking" }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      settleAccountLinkOperation({ bridge, operation: "link", signal: controller.signal }),
    ).rejects.toThrow("interrupted");
    expect(bridge.listenerCount()).toBe(0);
  });

  it("settles an unlink once the deployment reports unlinked", async () => {
    const bridge = accessBridge(snapshot({ linkStatus: "linked", operation: "unlinking" }));
    const settled = settleAccountLinkOperation({ bridge, operation: "unlink" });

    bridge.emit(snapshot({ linkStatus: "unlinked", operation: null }));

    await expect(settled).resolves.toMatchObject({ kind: "unlinked", succeeded: true });
  });
});

function snapshot(input: {
  readonly linkStatus:
    | "activating"
    | "linked"
    | "linked-elsewhere"
    | "needs-repair"
    | "unlinked"
    | "unlinking"
    | "unavailable";
  readonly operation:
    "authorizing" | "failed" | "linking" | "other" | "repairing" | "unlinking" | null;
}): DeploymentAccessSnapshot {
  return {
    account: { available: true, status: "signed-in" },
    deployments: [],
    directoryFailure: null,
    personalSetup: null,
    personalAccountLink: {
      account: null,
      deploymentId: null,
      displayName: null,
      status: input.linkStatus,
      unlinkStep: null,
    },
    revision: 1,
    selectedDeploymentId: null,
    unavailable: [],
  } as DeploymentAccessSnapshot;
}

function accessBridge(initial: DeploymentAccessSnapshot) {
  const listeners = new Set<(next: DeploymentAccessSnapshot) => void>();
  let current = initial;
  return {
    emit(next: DeploymentAccessSnapshot) {
      current = next;
      for (const listener of listeners) listener(next);
    },
    getDeploymentAccessSnapshot: () => Promise.resolve(current),
    listenerCount: () => listeners.size,
    onDeploymentAccessSnapshotChanged(listener: (next: DeploymentAccessSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
