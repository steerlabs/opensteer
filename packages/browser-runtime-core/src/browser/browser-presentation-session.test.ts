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

      rootCssWidth: 128,
      rootCssHeight: 128,

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
  it("claims each gesture once before asynchronous native dispatch", async () => {
    const f = fixture();
    await f.start();
    f.emit(1);
    await f.session.ack(1);
    const reference = browserPresentationRef(f.frames[0]!);
    const dispatched = Promise.withResolvers<{ dispatched: boolean }>();
    vi.mocked(f.port.click).mockReturnValueOnce(dispatched.promise);
    const first = f.session.click("viewer", "gesture", reference, { x: 64, y: 32 }, 0);
    await expect(
      f.session.click("viewer", "gesture", reference, { x: 64, y: 32 }, 0),
    ).resolves.toEqual({ dispatched: false });
    expect(f.port.click).toHaveBeenCalledExactlyOnceWith({
      reference,
      seq: "1",
      rootCssPoint: { x: 64, y: 32 },
      modifiers: 0,
    });
    dispatched.resolve({ dispatched: true });
    await first;
    await f.session.stop();
  });
  it("returns ordinary refusals before dispatch for unavailable certificates and outside points", async () => {
    const f = fixture();
    await f.start();
    f.emit(1);
    await f.session.ack(1);
    const reference = browserPresentationRef(f.frames[0]!);
    await expect(
      f.session.click("viewer", "outside", reference, { x: 128, y: 0 }, 0),
    ).resolves.toEqual({ dispatched: false });
    await expect(
      f.session.click("viewer", "missing", { ...reference, sequence: 100 }, { x: 1, y: 1 }, 0),
    ).resolves.toEqual({ dispatched: false });
    expect(f.port.click).not.toHaveBeenCalled();
    await f.session.stop();
    f.emit(2);
    expect(f.frames).toHaveLength(1);
  });
  it("keeps source credit independent of viewer presentation and resolves non-click input geometry", async () => {
    const f = fixture();
    await f.start();
    for (let n = 1; n <= 10; n++) {
      f.emit(n);
      await f.session.ack(n);
    }
    expect(f.port.ack).toHaveBeenCalledTimes(10);
    expect(f.session.resolvePoint(0.5, 0.25, 128, 128, 0)).toEqual({ x: 64, y: 32 });
    expect(f.session.resolvePoint(0.5, 0.25, 128, 128, 1)).toBeNull();
    await f.session.stop();
  });
});
