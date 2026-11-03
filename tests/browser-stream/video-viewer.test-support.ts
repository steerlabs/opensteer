import { BrowserWatchStore } from "../../packages/client/src/host/browser-watch.js";
import {
  attachBrowserCanvas,
  browserVideoDecoderStats,
} from "../../apps/web/src/components/browser/browser-presenter.js";
import type { BrowserServerMessage } from "../../packages/protocol/src/index.js";
const canvas = document.querySelector("canvas")!;
const decodedOutputs: {
  timestamp?: number;
  at?: number;
  error?: string;
  width?: number;
  height?: number;
}[] = [];
const received = new Map<number, { at: number; bytes: number }>();
const OriginalDecoder = window.VideoDecoder;
window.VideoDecoder = class extends OriginalDecoder {
  constructor(init: VideoDecoderInit) {
    super({
      output: (frame) => {
        decodedOutputs.push({
          timestamp: frame.timestamp,
          at: performance.now(),
          width: frame.displayWidth,
          height: frame.displayHeight,
        });
        init.output(frame);
      },
      error: (error) => {
        decodedOutputs.push({ error: error.name });
        init.error(error);
      },
    });
  }
};
let store: BrowserWatchStore | null = null;
let stop: () => void = () => undefined;
let admitted = Promise.withResolvers<void>();
export interface FixtureVideoPicture {
  sequence: number;
  at: number;
  pixel: number[];
  certificate: string;
  bytes: number | null;
  receiptToDecodeMs: number | null;
  decodeToCanvasMs: number | null;
}
const pictures: FixtureVideoPicture[] = [];
const waiting = new Set<() => void>();
function next(sequence: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiting.delete(check);
      reject(
        new Error(
          `Video fixture never presented ${sequence}: ${JSON.stringify({ outputs: decodedOutputs, decoding: typeof VideoDecoder, stats: browserVideoDecoderStats(canvas), diagnostics: store?.diagnostics })}`,
        ),
      );
    }, 10000);
    const check = () => {
      if (!pictures.some((p) => p.sequence >= sequence)) return;
      clearTimeout(timeout);
      waiting.delete(check);
      resolve();
    };
    waiting.add(check);
    check();
  });
}
export function start(options: {
  control: string;
  media: string;
  sessionId: string;
  surfaceId: string;
  mode: "control" | "watch";
  decoder: HardwareAcceleration;
}): void {
  const onMessage = (_s: string, message: BrowserServerMessage) => {
    if (message.type === "browser.error") throw new Error(message.error.message);
  };
  admitted = Promise.withResolvers<void>();
  store = new BrowserWatchStore(
    () => new WebSocket(options.control),
    options.mode,
    onMessage,
    () => 60000,
    () => false,
    undefined,
    () => true,
    () => false,
    {
      selected: () => true,
      connect: () => {
        const socket = new WebSocket(options.media);
        socket.addEventListener("message", ({ data }) => {
          if (typeof data === "string") admitted.resolve();
        });
        return socket;
      },
    },
  );
  const release = store.retain(options.sessionId, options.surfaceId);
  const current = store;
  const unreceive = current.video.onFrame(options.sessionId, options.surfaceId, (frame) => {
    received.set(frame.header.sequence, { at: performance.now(), bytes: frame.payload.byteLength });
    frame.done();
  });
  const detach = attachBrowserCanvas(
    {
      video: current.video,
      get: (s, t) => current.get(s, t!).frame,
      subscribe: (s, listener, t) => current.subscribe(s, t!, listener),
    },
    options.sessionId,
    options.surfaceId,
    true,
    canvas,
    (frame) => {
      const video = frame.video;
      if (!video) throw new Error("Fixture did not use H.264");
      const at = performance.now();
      const receipt = received.get(video.sequence);
      const output = decodedOutputs.find((o) => o.timestamp === video.sequence - 1);
      pictures.push({
        bytes: receipt?.bytes ?? null,
        receiptToDecodeMs: receipt && output?.at ? output.at - receipt.at : null,
        decodeToCanvasMs: output?.at ? at - output.at : null,
        sequence: video.sequence,
        at: performance.now(),
        pixel: [...canvas.getContext("2d")!.getImageData(64, 64, 1, 1).data],
        certificate: video.presentation.drawnRevision,
      });
      for (const check of waiting) check();
    },
    false,
    { acceleration: options.decoder },
  );
  stop = () => {
    unreceive();
    detach();
    release();
    current.dispose();
    store = null;
  };
}
Object.assign(window, {
  videoFixture: { start, ready: () => admitted.promise, next, pictures, stop: () => stop() },
});
