import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { DesktopBridgeContext } from "../context.js";
import { handleOpenExternalUrl, handlePickFolder } from "./window.js";

describe("openExternalUrl", () => {
  it("keeps the general external-link route to HTTPS", async () => {
    const openExternal = vi.fn(async () => undefined);
    const context = bridgeContext(openExternal);

    await expect(
      handleOpenExternalUrl(context)(event(), {
        bridgeToken: "b".repeat(43),
        input: { url: "x-apple.systempreferences:com.apple.preference.security" },
      }),
    ).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens only the Chrome connect page on loopback", async () => {
    const openExternal = vi.fn(async () => undefined);
    const open = (url: string) =>
      handleOpenExternalUrl(bridgeContext(openExternal))(event(), {
        bridgeToken: "b".repeat(43),
        input: { url },
      });

    for (const url of [
      "http://127.0.0.1:4000/connect/chrome#osc1.abc",
      "http://localhost:4000/connect/chrome",
      "http://[::1]:4000/connect/chrome#osc1.abc",
    ]) {
      await expect(open(url)).resolves.toEqual({ opened: true });
    }
    for (const url of [
      "http://127.0.0.1:4000/",
      "http://127.0.0.1:8080/admin/delete",
      "http://127.0.0.1:4000/connect/chrome?next=/admin",
      "http://127.0.0.1:4000/connect/chrome/extra",
      "http://user:secret@127.0.0.1:4000/connect/chrome",
      "http://example.com/connect/chrome",
    ]) {
      await expect(open(url)).rejects.toThrow();
    }
    expect(openExternal).toHaveBeenCalledTimes(3);
  });
});

describe("pickFolder", () => {
  it("refuses a caller outside the bundled main frame", async () => {
    const pickFolder = vi.fn(async () => "/Users/person/Projects");
    const context = bridgeContext(
      vi.fn(async () => undefined),
      pickFolder,
    );

    await expect(
      handlePickFolder(context)(event("https://attacker.invalid"), {
        bridgeToken: "b".repeat(43),
      }),
    ).rejects.toThrow("Desktop bridge sender is not the bundled");
    expect(pickFolder).not.toHaveBeenCalled();
  });
});

function bridgeContext(
  openExternal: (url: string) => Promise<void>,
  pickFolder: () => Promise<string | null> = async () => null,
): DesktopBridgeContext {
  return {
    downloadsSenders: new Set(),
    accessSenders: new Set(),
    localExecutionSenders: new Map(),
    options: { bridgeToken: "b".repeat(43), portal: { openExternal, pickFolder } },
    personalRemoteSenders: new Set(),
    trackedHostSenders: new Set(),
  } as unknown as DesktopBridgeContext;
}

function event(url = "app://opensteer/computers"): IpcMainInvokeEvent {
  const mainFrame = { url };
  return {
    sender: { id: 7, isDestroyed: () => false, mainFrame, once: vi.fn(), send: vi.fn() },
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
}
