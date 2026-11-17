import { expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import type {
  DesktopIphoneSetupBridge,
  DesktopIphoneSetupStatus,
} from "@opensteer/protocol/desktop";
import { createIphoneSetupPort } from "./iphone-setup.js";

function fixture() {
  const status: DesktopIphoneSetupStatus = {
    setupId: crypto.randomUUID(),
    deploymentId: createId("deployment"),
    stage: "add",
    state: "working",
    reason: null,
    action: "none",
    candidates: [],
    phone: null,
    suggestedName: "Phone screen",
    attachCommand: {
      type: "iphone.screen.attach",
      idempotencyKey: crypto.randomUUID(),
      driverRunnerId: createId("runner"),
      target: { kind: "new", name: "Chosen name" },
    },
    target: null,
    deviceId: null,
    driverGeneration: null,
    wifiEnabled: false,
  };
  const platform = {
    begin: vi.fn(async () => status),
    choose: vi.fn(async () => status),
    wifi: vi.fn(async () => status),
    add: vi.fn(async () => status),
    help: vi.fn(async () => status),
    retry: vi.fn(async () => status),
    complete: vi.fn(async () => ({
      ...status,
      state: "waiting" as const,
      reason: "assignment-pending" as const,
    })),
    failed: vi.fn(async () => ({
      ...status,
      state: "blocked" as const,
      reason: "host-offline" as const,
    })),
    status: vi.fn(async () => status),
    cancel: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    wifiStatus: vi.fn(),
    configureWifi: vi.fn(),
    detach: vi.fn(),
    completeDetach: vi.fn(),
    pendingDetaches: vi.fn(),
  } satisfies DesktopIphoneSetupBridge;
  const result = { type: "iphone.screen.attach", deviceId: createId("device"), generation: 2 };
  return { platform, status, result };
}
it("adds, dispatches the prepared Host command once, then completes, deduplicating in-flight attaches", async () => {
  const f = fixture();
  const dispatched = Promise.withResolvers<unknown>();
  const dispatch = vi.fn(() => dispatched.promise);
  const port = createIphoneSetupPort(f.platform, dispatch);
  const first = port.attach({ setupId: f.status.setupId, name: "Chosen name" });
  const duplicate = port.attach({ setupId: f.status.setupId, name: "Chosen name" });
  expect(first).toBe(duplicate);
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(f.status.attachCommand), {
    timeout: 1000,
  });
  expect(f.platform.complete).not.toHaveBeenCalled();
  dispatched.resolve(f.result);
  expect(await first).toMatchObject({ reason: "assignment-pending" });
  expect(f.platform.add).toHaveBeenCalledExactlyOnceWith({
    setupId: f.status.setupId,
    name: "Chosen name",
  });
  expect(dispatch).toHaveBeenCalledOnce();
  expect(f.platform.complete).toHaveBeenCalledExactlyOnceWith({
    setupId: f.status.setupId,
    result: f.result,
  });
});
it("reports dispatch failures and allows an idempotent retry", async () => {
  const f = fixture();
  const dispatch = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(f.result);
  const port = createIphoneSetupPort(f.platform, dispatch);
  expect(await port.attach({ setupId: f.status.setupId })).toMatchObject({
    reason: "host-offline",
  });
  expect(f.platform.failed).toHaveBeenCalledWith({
    setupId: f.status.setupId,
    reason: "host-offline",
  });
  expect(f.platform.complete).not.toHaveBeenCalled();
  await port.attach({ setupId: f.status.setupId });
  expect(f.platform.complete).toHaveBeenCalledOnce();
});
it("keeps a blocked add local without dispatching", async () => {
  const f = fixture();
  f.platform.add.mockResolvedValueOnce({
    ...f.status,
    state: "blocked",
    reason: "local-mapping-save-failed",
    attachCommand: null,
  });
  const dispatch = vi.fn();
  const port = createIphoneSetupPort(f.platform, dispatch);
  expect(await port.attach({ setupId: f.status.setupId })).toMatchObject({
    reason: "local-mapping-save-failed",
  });
  expect(dispatch).not.toHaveBeenCalled();
});
