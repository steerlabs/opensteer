import { describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { DesktopBridgeContext } from "../context.js";
import { dictationHandlers } from "./dictation.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";

describe("dictation bridge", () => {
  it("authorizes the application main frame and parses commands before native work", async () => {
    const command = vi.fn(async () => undefined);
    const context = {
      options: { bridgeToken: "secret", dictation: { command } },
    } as unknown as DesktopBridgeContext;
    const frame = { url: "app://opensteer/" };
    const event = {
      sender: { mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    const handlers = new Map(dictationHandlers(context));
    const start = handlers.get(desktopBridgeChannels.dictationStart)!;
    const input = { session: "00000000-0000-4000-8000-000000000001" };
    await expect(async () => start(event, { bridgeToken: "wrong", input })).rejects.toThrow(
      "capability",
    );
    await expect(async () =>
      start({ ...event, senderFrame: {} } as IpcMainInvokeEvent, { bridgeToken: "secret", input }),
    ).rejects.toThrow("main application frame");
    await expect(async () =>
      start(event, { bridgeToken: "secret", input: { ...input, owner: 1 } }),
    ).rejects.toThrow();
    expect(command).not.toHaveBeenCalled();
    await start(event, { bridgeToken: "secret", input });
    expect(command).toHaveBeenCalledWith(event.sender, "start", input);
  });
});
