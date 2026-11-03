import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserPresentationSession,
  type BrowserPresentationPort,
  type BrowserProducerFrame,
} from "./browser-presentation-session.js";
import {
  browserPresentationRef,
  DisplayStreamIdSchema,
  type BrowserVideoFrameHeader,
} from "@opensteer/protocol";
const payload = readFileSync(
  new URL(
    "../../../../apps/mobile/modules/phone-display/tests/native/fixtures/lime-key-128x128.h264",
    import.meta.url,
  ),
);
function fixture() {
  let source: Parameters<BrowserPresentationPort["start"]>[0] | null = null;
  const port: BrowserPresentationPort = {
    start: vi.fn<BrowserPresentationPort["start"]>(async (options) => {
      source = options;
      return {
        producerStreamId: "00000000-0000-4000-8000-000000000002",
        capacity: { backend: "software", maxSessions: 1, maxFps: 15 },
      };
    }),
    budget: vi.fn(async () => undefined),
    keyframe: vi.fn(async () => undefined),
    ack: vi.fn(async () => undefined),
    hold: vi.fn(async () => undefined),
    presented: vi.fn(async () => undefined),
    recover: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    click: vi.fn(async () => ({ dispatched: true })),
    stop: vi.fn(async () => undefined),
  };
  const session = new BrowserPresentationSession(port);
  const frames: BrowserVideoFrameHeader[] = [];
  const stopped = vi.fn();
  const frame = (sequence: number): BrowserProducerFrame => ({
    generation: "1",
    sequence: String(sequence),
    ptsUs: String(sequence),
    key: true,
    codec: "avc1.420015",
    width: 128,
    height: 128,
    payload,
    presentation: {
      producerStreamId: "00000000-0000-4000-8000-000000000002",
      documentGeneration: "document",
      authorityEpoch: "epoch",
      drawnRevision: `certificate-${sequence}`,
      appliedThrough: "0",
      frameSinkId: "1:2",
      surfaceId: "selected",
      frameToken: String(sequence),
      capturedAtUs: String(sequence),
      sourceWidth: 128,
      sourceHeight: 128,
      deviceScaleFactor: 1,
      rootCssWidth: 128,
      rootCssHeight: 128,
      visualViewport: { width: 128, height: 128, offsetX: 1000, offsetY: 2000, scale: 1 },
      crop: { x: 0, y: 0, width: 128, height: 128 },
      rasterCrop: { x: 0, y: 0, width: 128, height: 128 },
    },
  });
  return {
    port,
    session,
    frames,
    stopped,
    emit: (sequence: number) => source!.onFrame(frame(sequence)),
    start: () =>
      session.start(
        DisplayStreamIdSchema.parse("dsp_00000000-0000-4000-8000-000000000001"),
        { maxWidth: 128, maxHeight: 128, maxFps: 15, maxBitrate: 500000 },
        2,
        (header) => frames.push(header),
        stopped,
      ),
  };
}
describe("native browser presentation ownership", () => {
  it("claims a gesture before an asynchronous native click and keeps its pin through cancellation", async () => {
    const f = fixture();
    await f.start();
    f.emit(1);
    await f.session.ack(1, ["viewer"]);
    const reference = browserPresentationRef(f.frames[0]!);
    await f.session.gesture("viewer", "pending", reference, "begin");
    const dispatched = Promise.withResolvers<{ dispatched: boolean }>();
    vi.mocked(f.port.click).mockReturnValueOnce(dispatched.promise);
    const first = f.session.click("viewer", "pending", reference, { x: 64, y: 32 }, 0);
    await vi.waitFor(() => expect(f.port.click, "native click started").toHaveBeenCalledOnce(), {
      timeout: 1000,
    });
    await expect(
      f.session.click("viewer", "pending", reference, { x: 64, y: 32 }, 0),
    ).rejects.toThrow();
    await f.session.gesture("viewer", "pending", reference, "cancel");
    expect(f.port.release).not.toHaveBeenCalled();
    dispatched.resolve({ dispatched: true });
    await first;
    expect(f.port.release).toHaveBeenCalledExactlyOnceWith("viewer:gesture:pending");
    await f.session.stop();
  });
  it("retains an idle presented certificate and samples its crop for exactly one native call", async () => {
    const f = fixture();
    await f.start();
    f.emit(1);
    await f.session.ack(1, ["viewer"]);
    const reference = browserPresentationRef(f.frames[0]!);
    await f.session.presented("viewer", reference);
    await f.session.gesture("viewer", "gesture", reference, "begin");
    f.emit(2);
    await f.session.ack(2, ["viewer"]);
    await f.session.presented("viewer", browserPresentationRef(f.frames[1]!));
    expect(await f.session.click("viewer", "gesture", reference, { x: 64, y: 32 }, 0)).toEqual({
      dispatched: true,
    });
    expect(f.port.click).toHaveBeenCalledExactlyOnceWith({
      reference,
      seq: "1",
      rootCssPoint: { x: 64, y: 32 },
      modifiers: 0,
    });
    await expect(
      f.session.click("viewer", "gesture", reference, { x: 64, y: 32 }, 0),
    ).rejects.toThrow();
    await f.session.stop();
  });
  it("waits for native offer transfer when presentation crosses the source ACK", async () => {
    const f = fixture();
    await f.start();
    f.emit(1);
    const reference = browserPresentationRef(f.frames[0]!);
    const presented = f.session.presented("viewer", reference);
    const ack = Promise.withResolvers<void>();
    vi.mocked(f.port.ack).mockReturnValueOnce(ack.promise);
    const admitted = f.session.ack(1, ["viewer"]);
    expect(f.port.presented).not.toHaveBeenCalled();
    ack.resolve();
    await admitted;
    await presented;
    expect(f.port.presented).toHaveBeenCalledOnce();
    await f.session.stop();
  });
  it("releases a disconnected viewer's offered, current and pending gesture holds", async () => {
    const f = fixture();
    await f.start();
    f.emit(1);
    await f.session.ack(1, ["viewer"]);
    const ref = browserPresentationRef(f.frames[0]!);
    await f.session.gesture("viewer", "pending", ref, "begin");
    await f.session.release("viewer");
    expect(f.port.release).toHaveBeenCalledWith("viewer:gesture:pending");
    await expect(f.session.click("viewer", "pending", ref, { x: 1, y: 1 }, 0)).rejects.toThrow();
    await f.session.stop();
  });
  it("fences late media and rejects a missing reference without native input", async () => {
    const f = fixture();
    await f.start();
    f.emit(1);
    await f.session.ack(1, []);
    const ref = browserPresentationRef(f.frames[0]!);
    await expect(f.session.gesture("other", "gesture", ref, "begin")).rejects.toThrow();
    expect(f.port.click).not.toHaveBeenCalled();
    await f.session.stop();
    f.emit(2);
    expect(f.frames).toHaveLength(1);
  });
});
