import { describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { DesktopBridgeContext } from "../context.js";
import { viewerClipboardHandlers } from "./viewer-clipboard.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
const native = vi.hoisted(() => ({
  write: vi.fn(),
}));
vi.mock("electron", () => ({
  clipboard: { write: native.write },
  ClipboardItem: class {
    readonly data: Record<string, Blob>;
    constructor(data: Record<string, Blob>) {
      this.data = data;
    }
  },
}));

function setup(url = "app://opensteer/workspaces", main = true) {
  const frame = { url };
  const sender = { mainFrame: frame, setIgnoreMenuShortcuts: vi.fn(), paste: vi.fn() };
  const event = { sender, senderFrame: main ? frame : { url } } as unknown as IpcMainInvokeEvent;
  const context = { options: { bridgeToken: "capability" } } as unknown as DesktopBridgeContext;
  return { event, sender, handlers: new Map(viewerClipboardHandlers(context)) };
}
describe("native viewer clipboard authorization", () => {
  it("writes native text and HTML only after application renderer validation", async () => {
    native.write.mockClear();
    const { event, handlers } = setup();
    await handlers.get(desktopBridgeChannels.writeViewerClipboard)!(event, {
      bridgeToken: "capability",
      input: [
        { type: "text/plain", bytes: new TextEncoder().encode("copy") },
        { type: "text/html", bytes: new TextEncoder().encode("<b>copy</b>") },
      ],
    });
    expect(native.write).toHaveBeenCalledTimes(1);
    const argument = native.write.mock.calls[0]![0] as { data: Record<string, Blob> }[];
    expect(argument).toHaveLength(1);
    expect(await argument[0]!.data["text/plain"]!.text()).toBe("copy");
    expect(await argument[0]!.data["text/html"]!.text()).toBe("<b>copy</b>");
  });
  it.each([
    ["https://example.test/", true],
    ["app://opensteer/workspaces", false],
  ])("refuses %s main=%s before clipboard access", async (url, main) => {
    native.write.mockClear();
    const { event, handlers } = setup(url, main);
    await expect(
      handlers.get(desktopBridgeChannels.writeViewerClipboard)!(event, {
        bridgeToken: "capability",
        input: [{ type: "text/plain", bytes: new Uint8Array([65]) }],
      }),
    ).rejects.toThrow();
    expect(native.write).not.toHaveBeenCalled();
  });
  it("requests a trusted native paste only in the authorized application renderer", async () => {
    const { event, sender, handlers } = setup();
    await handlers.get(desktopBridgeChannels.pasteViewerClipboard)!(event, {
      bridgeToken: "capability",
    });
    expect(sender.paste).toHaveBeenCalledExactlyOnceWith();
  });
  it("sets menu suppression only for the authorized application renderer", async () => {
    const { event, sender, handlers } = setup();
    await handlers.get(desktopBridgeChannels.setViewerKeyboardActive)!(event, {
      bridgeToken: "capability",
      input: true,
    });
    expect(sender.setIgnoreMenuShortcuts).toHaveBeenCalledExactlyOnceWith(true);
  });
});
