import type { BrowserProducerFrame } from "@opensteer/browser-runtime-core";
import { readFileSync } from "node:fs";
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
          width: 128,
          height: 128,
        };
      if (method === "OpensteerInput.click") return { dispatched: false };
      if (
        [
          "OpensteerVideo.update",
          "OpensteerVideo.ack",
          "OpensteerVideo.requestKeyframe",
          "OpensteerVideo.stop",
          "OpensteerInput.disable",
        ].includes(method)
      )
        return {};
      throw new Error(`Unexpected producer command ${method}`);
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
      certificate: browserVideoTestHeader.presentation,
      rasterCrop: browserVideoTestHeader.presentation.rasterCrop,
      streamId: browserVideoTestHeader.presentation.producerStreamId,
      sequence: "0",
      timestampUs: "1",
      keyframe: true,
      width: 128,
      height: 128,
      certifiedAtUs: "1",
      captureRequestedAtUs: "0",
    };
    const bytes = readFileSync(
      new URL(
        "../../../mobile/modules/phone-display/tests/native/fixtures/lime-key-128x128.h264",
        import.meta.url,
      ),
    );
    f.events.emit("video-chunk", {}, bytes, raw);
    expect(f.options.onFrame).toHaveBeenCalledOnce();
    const frame = f.options.onFrame.mock.calls[0]![0];
    expect(frame.payload).toBe(bytes);
    expect(frame.presentation).not.toHaveProperty("certifiedAtUs");
    raw.rasterCrop = { x: 0, y: 0, width: 128, height: 128 };
    expect(frame.presentation.rasterCrop.x).toBe(14);
    const reference = browserPresentationRef(browserVideoTestHeader);
    await f.port.ack("0");
    expect(f.commands).toHaveBeenLastCalledWith("OpensteerVideo.ack", {
      streamId: raw.streamId,
      sequence: "0",
    });
    await f.port.budget({ ...f.options.budget, maxWidth: 256 });
    expect(f.commands).toHaveBeenLastCalledWith("OpensteerVideo.update", {
      streamId: raw.streamId,
      bitrate: 500000,
      maxFps: 15,
    });
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
  it("does not stop a new owner when a retired enable finishes late", async () => {
    const f = fixture();
    const enabled = Promise.withResolvers<unknown>();
    f.commands.mockImplementationOnce(() => enabled.promise);
    const old = f.port.start(f.options);
    const rejected = expect(old).rejects.toThrow("ended during enable");
    await f.port.stop();
    await f.port.start(f.options);
    enabled.resolve({ documentGeneration: "document", authorityEpoch: "epoch" });
    await rejected;
    await expect(f.port.keyframe()).resolves.toBeUndefined();
    expect(f.commands).toHaveBeenLastCalledWith(
      "OpensteerVideo.requestKeyframe",
      expect.objectContaining({ streamId: browserVideoTestHeader.presentation.producerStreamId }),
    );
    await f.port.stop();
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

describe("private popup and committed keyboard bridge", () => {
  it("preserves successor identity when an old close arrives and releases every listener on stop", async () => {
    const f = fixture();
    const onPopup = vi.fn();
    await f.port.start({ ...f.options, onPopup });
    const state = { kind: "select", multiple: false, rtl: false, items: [] };
    const open = (popupId: string) =>
      f.events.emit("message", {}, "OpensteerPopup.opened", {
        documentGeneration: "document",
        authorityEpoch: "epoch",
        frameId: "main",
        popupId,
        revision: "9007199254740993",
        state,
      });
    open("old");
    open("next");
    f.events.emit("message", {}, "OpensteerPopup.closed", { popupId: "old", reason: "accepted" });
    expect(onPopup.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "closed",
      ref: { popupId: "old" },
      reason: "applied",
    });
    f.events.emit("message", {}, "OpensteerPopup.updated", {
      popupId: "next",
      revision: "9007199254740994",
      state,
    });
    expect(onPopup.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "updated",
      ref: { popupId: "next", revision: "9007199254740994" },
    });
    await f.port.stop();
    expect(f.events.listenerCount("message")).toBe(0);
    const count = onPopup.mock.calls.length;
    open("late");
    expect(onPopup).toHaveBeenCalledTimes(count);
  });
  it("captures once, carries Space text exactly once, and never recaptures a refused action", async () => {
    const f = fixture();
    const original = f.commands.getMockImplementation()!;
    f.commands.mockImplementation(async (method, p) =>
      method === "OpensteerInput.edit"
        ? {
            dispatched: p?.type === "capture" || p?.seq !== "4",
            focusToken: p?.seq === "4" ? "" : "focus",
          }
        : original(method, p),
    );
    await f.port.start(f.options);
    let seq = 0;
    const next = () => String(++seq);
    await f.port.edit(
      { type: "keyDown", key: " ", code: "Space", keyCode: 32, modifiers: 0, text: " " },
      next,
    );
    await f.port.edit(
      { type: "keyUp", key: " ", code: "Space", keyCode: 32, modifiers: 0, text: "" },
      next,
    );
    expect(await f.port.edit({ type: "insertText", text: "commit" }, next)).toEqual({
      dispatched: false,
    });
    const edits = f.commands.mock.calls
      .filter((c) => c[0] === "OpensteerInput.edit")
      .map((c) => c[1]);
    expect(edits.map((p) => p?.seq)).toEqual(["1", "2", "3", "4"]);
    expect(edits.map((p) => p?.text)).toEqual(["", " ", "", "commit"]);
    await f.port.stop();
  });
  it("never logs synthetic secrets from labels, values, malformed state or native errors", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture();
    await f.port.start({ ...f.options, onPopup: vi.fn() });
    const canary = "synthetic-popup-secret-canary";
    f.events.emit("message", {}, "OpensteerPopup.opened", {
      documentGeneration: "document",
      authorityEpoch: "epoch",
      frameId: "main",
      popupId: "p",
      revision: "1",
      state: {
        kind: "color",
        rtl: false,
        items: [],
        value: canary,
        alpha: true,
        colorSpace: "malformed-" + canary,
      },
    });
    expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain(canary);
    await f.port.stop();
  });
});
