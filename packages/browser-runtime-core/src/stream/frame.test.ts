import { describe, expect, it, vi } from "vitest";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { flushMicrotasks, jpeg } from "../test-support/fakes.js";
import {
  decodeBrowserFrame,
  encodeBrowserFrame,
  readImageDimensions,
  type BrowserFrame,
} from "./frame.js";
import { LatestFrameStream } from "./latest-frame-stream.js";

const surfaceId = BrowserSurfaceIdSchema.parse("surface_test");

describe("browser frame envelope", () => {
  it("round-trips a validated length-prefixed header and payload", () => {
    const frame = browserFrame(7, jpeg(640, 360));
    expect(decodeBrowserFrame(encodeBrowserFrame(frame))).toEqual(frame);
  });

  it("reads JPEG and PNG dimensions without decoding pixels", () => {
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(800, 16);
    png.writeUInt32BE(600, 20);
    expect(readImageDimensions(jpeg(1_024, 768), "jpeg")).toEqual({ height: 768, width: 1_024 });
    expect(readImageDimensions(png, "png")).toEqual({ height: 600, width: 800 });
    expect(readImageDimensions(Buffer.from("not an image"), "jpeg")).toBeNull();
  });

  it("rejects malformed binary envelopes", () => {
    expect(() => decodeBrowserFrame(Buffer.from([0, 0, 0, 20, 1]))).toThrow(/invalid/);
  });
});

describe("LatestFrameStream", () => {
  it("keeps one in-flight frame and only the newest pending frame", async () => {
    const firstWrite = deferred();
    const sent: number[] = [];
    const sink = {
      sendFrame: vi.fn(async (frame: BrowserFrame) => {
        sent.push(frame.header.frameId);
        if (frame.header.frameId === 1) await firstWrite.promise;
      }),
    };
    const stream = new LatestFrameStream(sink);

    stream.enqueue(browserFrame(1));
    stream.enqueue(browserFrame(2));
    stream.enqueue(browserFrame(3));
    expect(sent).toEqual([1]);
    firstWrite.resolve();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(sent).toEqual([1, 3]);
    expect(stream.stats()).toEqual({ delivered: 2, dropped: 1 });
  });

  it("stops after a sink failure without growing a pending queue", async () => {
    const error = new Error("slow consumer");
    const onError = vi.fn();
    const stream = new LatestFrameStream({ sendFrame: () => Promise.reject(error) }, onError);
    stream.enqueue(browserFrame(1));
    stream.enqueue(browserFrame(2));
    await flushMicrotasks();
    stream.enqueue(browserFrame(3));

    expect(onError).toHaveBeenCalledWith(error);
    expect(stream.stats()).toEqual({ delivered: 0, dropped: 1 });
  });
});

function browserFrame(frameId: number, data = jpeg(32, 24)): BrowserFrame {
  return {
    data,
    header: {
      encoding: "jpeg",
      frameId,
      rasterHeight: 24,
      rasterWidth: 32,
      surfaceId,
      viewportHeight: 720,
      viewportWidth: 1_280,
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
