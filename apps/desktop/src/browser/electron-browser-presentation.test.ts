import type { BrowserProducerFrame } from "@opensteer/browser-runtime-core";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { browserPresentationRef } from "@opensteer/protocol";
import { browserVideoTestHeader } from "@opensteer/protocol/test-support/browser-video";
import {
  ElectronBrowserPresentation,
  electronBrowserPresentation,
  type OpensteerInputOwner,
} from "./electron-browser-presentation.js";
function fixture() {
  const events = new EventEmitter();
  const commands = vi.fn(
    async (method: string, _parameters?: Record<string, unknown>): Promise<unknown> => {
      if (method === "OpensteerInput.enable")
        return { documentGeneration: "document", authorityEpoch: "epoch" };
      if (method === "OpensteerVideo.start")
        return {
          streamId: browserVideoTestHeader.presentation.producerStreamId,
          backend: "software",
          capacity: 2,
          width: 128,
          height: 128,
          maxFps: 15,
        };
      if (method === "OpensteerInput.click") return { dispatched: false };
      return {};
    },
  );
  const owner: OpensteerInputOwner = {
    on: (event, callback) => {
      events.on(event, callback);
    },
    off: (event, callback) => {
      events.off(event, callback);
    },
    sendCommand: commands,
    detach: vi.fn(() => {
      events.emit("detach");
    }),
  };
  const port = new ElectronBrowserPresentation(() => owner);
  const options = {
    budget: { maxWidth: 128, maxHeight: 128, maxFps: 15, maxBitrate: 500000 },
    creditWindow: 2,
    onFrame: vi.fn<(frame: BrowserProducerFrame) => void>(),
    onStopped: vi.fn(),
  };
  return { events, commands, owner, port, options };
}
describe("private Electron browser presentation adapter", () => {
  it("refuses stock Electron explicitly", async () => {
    const port = electronBrowserPresentation({} as WebContents);
    await expect(port.start(fixture().options)).rejects.toThrow("patched Electron");
  });
  it("binds binary metadata to its enable authority and returns the sampled opaque certificate exactly once", async () => {
    const f = fixture();
    await f.port.start(f.options);
    const raw = {
      ...browserVideoTestHeader.presentation,
      streamId: browserVideoTestHeader.presentation.producerStreamId,
      generation: "1",
      sequence: "0",
      ptsUs: "1",
      key: true,
      codec: "avc1.42C01F",
      width: 128,
      height: 128,
      certifiedAtUs: "1",
      captureRequestedAtUs: "0",
    };
    const bytes = Buffer.from([0, 0, 0, 1, 0x65]);
    f.events.emit("video-chunk", {}, bytes, raw);
    expect(f.options.onFrame).toHaveBeenCalledOnce();
    const frame = f.options.onFrame.mock.calls[0]![0];
    expect(frame.payload).toBe(bytes);
    expect(frame.presentation).not.toHaveProperty("certifiedAtUs");
    raw.rasterCrop = { x: 0, y: 0, width: 128, height: 128 };
    expect(frame.presentation.rasterCrop.x).toBe(14);
    const reference = browserPresentationRef(browserVideoTestHeader);
    await f.port.ack("0", ["viewer"]);
    await f.port.hold("gesture", reference);
    expect(
      await f.port.click({ reference, seq: "9", rootCssPoint: { x: 50, y: 50 }, modifiers: 0 }),
    ).toEqual({ dispatched: false });
    expect(f.commands.mock.calls.filter(([name]) => name === "OpensteerInput.click")).toEqual([
      [
        "OpensteerInput.click",
        {
          documentGeneration: "document",
          authorityEpoch: "epoch",
          drawnRevision: "opaque-certificate",
          seq: "9",
          after: "0",
          rootCssPoint: { x: 50, y: 50 },
          button: "left",
          modifiers: 0,
        },
      ],
    ]);
    await f.port.stop();
    expect(f.owner.detach).toHaveBeenCalledOnce();
  });
  it("fences a previous incarnation's pending rate update from the new owner", async () => {
    const f = fixture();
    await f.port.start(f.options);
    const pending = Promise.withResolvers<unknown>();
    f.commands.mockImplementationOnce(async () => pending.promise);
    const old = f.port.budget({ ...f.options.budget, maxBitrate: 400000 });
    await f.port.stop();
    await f.port.start(f.options);
    await f.port.budget({ ...f.options.budget, maxBitrate: 300000 });
    expect(f.commands).toHaveBeenLastCalledWith(
      "OpensteerVideo.update",
      expect.objectContaining({ bitrate: 300000 }),
    );
    pending.resolve({});
    await old;
    expect(f.commands.mock.calls.filter(([name]) => name === "OpensteerVideo.update")).toHaveLength(
      2,
    );
    await f.port.stop();
  });
  it("fences immediately on native stop before deferred detach and ignores late chunks", async () => {
    const f = fixture();
    await f.port.start(f.options);
    f.events.emit("video-stopped");
    await expect(f.port.keyframe()).rejects.toThrow("ended");
    f.events.emit("video-chunk", {}, Buffer.alloc(1), {});
    await Promise.resolve();
    expect(f.options.onFrame).not.toHaveBeenCalled();
    expect(f.options.onStopped).toHaveBeenCalledExactlyOnceWith("source-ended");
    expect(f.owner.detach).toHaveBeenCalledOnce();
    await f.port.stop();
  });
});
