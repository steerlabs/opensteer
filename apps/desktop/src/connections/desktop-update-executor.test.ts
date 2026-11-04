import { expect, it, vi } from "vitest";
import type { DesktopSupervisorOutput } from "@opensteer/protocol/desktop-supervisor";
import type { DesktopUpdateOperation } from "@opensteer/protocol/maintenance";
import type { DesktopUpdater } from "../app/desktop-updater.js";
import { DesktopSupervisorRefusal, type DesktopSupervisor } from "./desktop-supervisor.js";
import { DesktopUpdateExecutor, desktopUpdateDeliveryRetryMs } from "./desktop-update-executor.js";

it.each(["staged", "installing"] as const)(
  "reconciles a %s operation only after a new incarnation, without downloading or restarting",
  async (phase) => {
    for (const currentVersion of ["1.0.0", "1.0.1"]) {
      let receive!: (message: DesktopSupervisorOutput) => void;
      const acknowledge = vi.fn(async () => {});
      const remoteAction = vi.fn();
      const install = vi.fn();
      const executor = new DesktopUpdateExecutor({
        supervisor: {
          incarnationId: crypto.randomUUID(),
          subscribe: (listener: typeof receive) => {
            receive = listener;
            return () => {};
          },
          acknowledge,
          state: () => {},
        } as unknown as DesktopSupervisor,
        updater: {
          state: () => ({ currentVersion }),
          subscribe: () => () => {},
          remoteAction,
        } as unknown as DesktopUpdater,
        install,
      });
      try {
        const operation: DesktopUpdateOperation = {
          id: crypto.randomUUID(),
          state: phase,
          targetVersion: "1.0.1",
          fromVersion: "1.0.0",
          incarnationId: crypto.randomUUID(),
          intent: { action: "update" },
          detail: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        receive({ type: "desktop-update.operation", operation });
        await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce(), { timeout: 1000 });
        expect(acknowledge).toHaveBeenCalledWith(
          expect.objectContaining({
            state: currentVersion === "1.0.1" ? "succeeded" : "failed",
            detail: currentVersion === "1.0.1" ? null : "not-applied",
            targetVersion: "1.0.1",
          }),
        );
        expect(remoteAction).not.toHaveBeenCalled();
        expect(install).not.toHaveBeenCalled();
      } finally {
        executor.stop();
      }
    }
  },
);

it("keeps retrying the settled result when its acknowledgement is lost", async () => {
  vi.useFakeTimers();
  let receive!: (message: DesktopSupervisorOutput) => void;
  const states: string[] = [];
  const acknowledge = vi.fn(async (message: { state: string }) => {
    states.push(message.state);
    if (states.length < 3) throw new Error("Lost acknowledgement");
  });
  const executor = new DesktopUpdateExecutor({
    supervisor: {
      incarnationId: crypto.randomUUID(),
      subscribe: (listener: typeof receive) => {
        receive = listener;
        return () => {};
      },
      acknowledge,
      state: () => {},
    } as unknown as DesktopSupervisor,
    updater: {
      state: () => ({ currentVersion: "1.0.1" }),
      subscribe: () => () => {},
      remoteAction: vi.fn(),
    } as unknown as DesktopUpdater,
    install: vi.fn(),
  });
  try {
    receive({
      type: "desktop-update.operation",
      operation: {
        id: crypto.randomUUID(),
        state: "installing",
        targetVersion: "1.0.1",
        fromVersion: "1.0.0",
        incarnationId: crypto.randomUUID(),
        intent: { action: "update" },
        detail: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    await vi.advanceTimersByTimeAsync(desktopUpdateDeliveryRetryMs * 3);
    expect(states).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    executor.stop();
    vi.useRealTimers();
  }
});

function reconciling(acknowledge: (message: { operationId: string }) => Promise<void>) {
  let receive!: (message: DesktopSupervisorOutput) => void;
  const executor = new DesktopUpdateExecutor({
    supervisor: {
      incarnationId: crypto.randomUUID(),
      subscribe: (listener: typeof receive) => {
        receive = listener;
        return () => {};
      },
      acknowledge,
      state: () => {},
    } as unknown as DesktopSupervisor,
    updater: {
      state: () => ({ currentVersion: "1.0.1" }),
      subscribe: () => () => {},
      remoteAction: vi.fn(),
    } as unknown as DesktopUpdater,
    install: vi.fn(),
  });
  const publish = () => {
    const id = crypto.randomUUID();
    receive({
      type: "desktop-update.operation",
      operation: {
        id,
        state: "installing",
        targetVersion: "1.0.1",
        fromVersion: "1.0.0",
        incarnationId: crypto.randomUUID(),
        intent: { action: "update" },
        detail: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    return id;
  };
  return { executor, publish };
}

it("delivers a settled result before starting the next operation, without re-running it", async () => {
  vi.useFakeTimers();
  const delivered: string[] = [];
  let lost = true;
  const { executor, publish } = reconciling(async ({ operationId }) => {
    delivered.push(operationId);
    if (lost) {
      lost = false;
      throw new Error("Lost acknowledgement");
    }
  });
  try {
    const first = publish();
    await vi.advanceTimersByTimeAsync(0);
    const second = publish();
    await vi.advanceTimersByTimeAsync(desktopUpdateDeliveryRetryMs * 3);
    expect(delivered).toEqual([first, first, second]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    executor.stop();
    vi.useRealTimers();
  }
});

it("keeps a staged update open when its installing acknowledgement is lost", async () => {
  vi.useFakeTimers();
  let receive!: (message: DesktopSupervisorOutput) => void;
  const states: string[] = [];
  const acknowledge = vi.fn(async (message: { state: string }) => {
    states.push(message.state);
    if (message.state === "installing" && states.length < 5)
      throw new Error("Lost acknowledgement");
  });
  const install = vi.fn(async () => {});
  const incarnationId = crypto.randomUUID();
  const executor = new DesktopUpdateExecutor({
    supervisor: {
      incarnationId,
      subscribe: (listener: typeof receive) => {
        receive = listener;
        return () => {};
      },
      acknowledge,
      state: () => {},
    } as unknown as DesktopSupervisor,
    updater: {
      state: () => ({ currentVersion: "1.0.0" }),
      subscribe: () => () => {},
      remoteAction: (run: (action: unknown) => Promise<void>) =>
        run({ download: async () => {}, restart: (handoff: () => Promise<void>) => handoff() }),
    } as unknown as DesktopUpdater,
    install,
  });
  try {
    receive({
      type: "desktop-update.operation",
      operation: {
        id: crypto.randomUUID(),
        state: "staged",
        targetVersion: "1.0.1",
        fromVersion: "1.0.0",
        incarnationId,
        intent: { action: "update" },
        detail: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    await vi.advanceTimersByTimeAsync(desktopUpdateDeliveryRetryMs * 4);
    expect(states).not.toContain("failed");
    expect(states.filter((state) => state === "installing")).toHaveLength(5);
    expect(install).toHaveBeenCalledOnce();
  } finally {
    executor.stop();
    vi.useRealTimers();
  }
});

it("stops retrying a result the Host refused", async () => {
  vi.useFakeTimers();
  const acknowledge = vi.fn(async () => {
    throw new DesktopSupervisorRefusal("Refused");
  });
  const { executor, publish } = reconciling(acknowledge);
  try {
    publish();
    await vi.advanceTimersByTimeAsync(desktopUpdateDeliveryRetryMs * 3);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    executor.stop();
    vi.useRealTimers();
  }
});
