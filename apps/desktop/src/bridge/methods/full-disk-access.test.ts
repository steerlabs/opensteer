import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { DesktopBridgeContext } from "../context.js";
import { handleCheckFullDiskAccess } from "./full-disk-access.js";

describe("full disk access bridge", () => {
  it("rejects an unauthorized renderer before invoking the service", async () => {
    const fullDiskAccess = controller();
    const context = bridgeContext(fullDiskAccess);

    await expect(
      handleCheckFullDiskAccess(context)(event("https://attacker.invalid"), {
        bridgeToken: "b".repeat(43),
      }),
    ).rejects.toThrow(/bundled Opensteer application/i);
    expect(fullDiskAccess.check).not.toHaveBeenCalled();
  });
});

function controller() {
  return {
    check: vi.fn(async () => false),
    closePanel: vi.fn(async () => undefined),
    request: vi.fn(async () => undefined),
  };
}

function bridgeContext(fullDiskAccess: ReturnType<typeof controller>): DesktopBridgeContext {
  return {
    downloadsSenders: new Set(),
    accessSenders: new Set(),
    localExecutionSenders: new Map(),
    options: { bridgeToken: "b".repeat(43), fullDiskAccess },
    personalRemoteSenders: new Set(),
    trackedHostSenders: new Set(),
  } as unknown as DesktopBridgeContext;
}

function event(url = "app://opensteer/full-access"): IpcMainInvokeEvent {
  const mainFrame = { url };
  return {
    sender: { id: 7, isDestroyed: () => false, mainFrame, once: vi.fn(), send: vi.fn() },
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
}
