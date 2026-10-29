import { expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { DesktopBridgeContext } from "../context.js";
import { passkeyHandlers } from "./passkeys.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
const requestId = "e2799da2-9fe9-438e-a160-47e275ee2703";
it.each(["app://opensteer/workspaces", "https://example.test"])(
  "authorizes the passkey method for %s",
  async (url) => {
    const frame = { url };
    const sender = { mainFrame: frame };
    const present = vi.fn(async () => {});
    const context = {
      options: { bridgeToken: "capability", passkeys: { available: () => true, present } },
    } as unknown as DesktopBridgeContext;
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    const handler = new Map(passkeyHandlers(context)).get(desktopBridgeChannels.passkeyPresent)!;
    if (url.startsWith("https:")) {
      await expect(
        handler(event, { bridgeToken: "capability", input: { requestId } }),
      ).rejects.toThrow();
      expect(present).not.toHaveBeenCalled();
    } else {
      await handler(event, { bridgeToken: "capability", input: { requestId } });
      expect(present).toHaveBeenCalledExactlyOnceWith(sender, requestId);
      await expect(
        handler(event, { bridgeToken: "wrong", input: { requestId } }),
      ).rejects.toThrow();
      await expect(
        handler(event, {
          bridgeToken: "capability",
          input: { requestId, origin: "https://example.test" },
        }),
      ).rejects.toThrow();
      await expect(
        handler({ ...event, senderFrame: { url } } as unknown as IpcMainInvokeEvent, {
          bridgeToken: "capability",
          input: { requestId },
        }),
      ).rejects.toThrow();
    }
  },
);
