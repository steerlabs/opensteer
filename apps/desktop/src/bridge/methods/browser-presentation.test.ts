import { ZodError } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { DesktopBridgeContext } from "../context.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import { browserPresentationHandlers } from "./browser-presentation.js";

describe("presentation IPC validation (A05/A06)", () => {
  it.each([
    [desktopBridgeChannels.browserIsLocal, { sessionId: "invalid" }],
    [
      desktopBridgeChannels.browserPresentationUpdate,
      { presentationId: "invalid", rect: { x: 0, y: 0, width: 100, height: 100 } },
    ],
    [
      desktopBridgeChannels.browserPresentationUpdate,
      {
        presentationId: "00000000-0000-4000-8000-000000000001",
        rect: { x: 0, y: 0, width: 1e9, height: 100 },
      },
    ],
    [
      desktopBridgeChannels.browserIsLocal,
      { sessionId: "bsn_00000000-0000-4000-8000-000000000001", runtimeId: "injected" },
    ],
  ])("rejects malformed %s input before invoking the manager: %j", async (channel, input) => {
    const manager = { isLocal: vi.fn(), update: vi.fn() };
    const context = {
      options: { bridgeToken: "token", browserPresentation: manager },
    } as unknown as DesktopBridgeContext;
    const frame = { url: "app://opensteer/index.html" };
    const event = {
      sender: { mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    const handler = new Map(browserPresentationHandlers(context)).get(channel)!;
    await expect(handler(event, { bridgeToken: "token", input })).rejects.toBeInstanceOf(ZodError);
    expect(manager.isLocal).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });
});
