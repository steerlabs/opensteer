import { BrowserWatchStore } from "../../packages/client/src/host/browser-watch.js";
import {
  BrowserSurfaceIdSchema,
  type BrowserSurfaceId,
} from "../../packages/protocol/src/browser.js";
import type { BrowserCommand, BrowserFrameStore } from "../../packages/client/src/host/client.js";
import {
  attachBrowserCanvas,
  drawnBrowserFrame,
} from "../../apps/web/src/components/browser/browser-presenter.js";
import { readMarker } from "./fixture.test-support.js";
import {
  resolveInputs,
  type InputRejection,
  type InputSample,
  type PresentedSample,
  type Scenario,
} from "./metrics.test-support.js";

export interface ViewerRun {
  readonly start: number;
  readonly end: number;
  readonly finished: number;
  readonly inputs: InputSample[];
  readonly rejections: InputRejection[];
  readonly pictures: PresentedSample[];
  readonly invalidMarkers: number;
  readonly errors: string[];
}
interface ViewerBenchmark {
  connect(options: { origin: string; sessionId: string; surfaceId: string }): Promise<void>;
  ready(epoch: number): Promise<void>;
  run(options: { epoch: number; scenario: Scenario; duration: number }): Promise<ViewerRun>;
  stop(): void;
}
declare global {
  interface Window {
    browserStreamBench: ViewerBenchmark;
  }
}

const canvas = document.querySelector("canvas")!;
const pictures: PresentedSample[] = [];
const errors: string[] = [];
const rejections: InputRejection[] = [];
const received = new Map<number, number>();
const waiters = new Set<() => void>();
let invalidMarkers = 0;
let control: BrowserWatchStore;
let watch: BrowserWatchStore;
let sessionId: string;
let surfaceId: BrowserSurfaceId;
let controlSequence = 0;
let stop = () => undefined;

function waitFor(condition: () => boolean, reason: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`${reason}; ${errors.join("; ")}`));
    }, timeoutMs);
    const check = () => {
      if (!condition()) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
    check();
  });
}

window.browserStreamBench = {
  connect: async (options) => {
    sessionId = options.sessionId;
    surfaceId = BrowserSurfaceIdSchema.parse(options.surfaceId);
    const connect = (mode: "watch" | "control") => () => {
      const socket = new WebSocket(
        `${options.origin.replace("http", "ws")}/v1/browser-sessions/${sessionId}/connect?mode=${mode}&editing=1`,
      );
      socket.addEventListener("error", () => errors.push(`${mode} socket error`));
      socket.addEventListener("close", (event) => {
        if (event.code !== 1000) errors.push(`${mode} closed ${event.code}: ${event.reason}`);
      });
      return socket;
    };
    const onMessage: NonNullable<BrowserWatchStore["onMessage"]> = (_session, message) => {
      if (message.type === "browser.error") {
        if (
          message.error.reason === "browser-input-overload" &&
          message.inputSequence !== undefined
        )
          rejections.push({
            first: message.inputSequenceStart ?? message.inputSequence,
            last: message.inputSequence,
            reason: message.error.reason,
          });
        else errors.push(`${message.error.reason ?? message.error.code}: ${message.error.message}`);
        for (const check of waiters) check();
      }
    };
    control = new BrowserWatchStore(connect("control"), "control", onMessage, () => 60_000);
    watch = new BrowserWatchStore(
      connect("watch"),
      "watch",
      onMessage,
      () => 60_000,
      () => false,
      undefined,
      () => true,
      () => true,
    );
    const receipt = watch.subscribe(sessionId, surfaceId, () => {
      const state = watch.get(sessionId, surfaceId);
      if (state.error) errors.push(state.error);
      if (state.frame && !received.has(state.frame.header.frameId))
        received.set(state.frame.header.frameId, performance.now());
      for (const check of waiters) check();
    });
    const controls = control.subscribe(sessionId, surfaceId, () => {
      for (const check of waiters) check();
    });
    const source: BrowserFrameStore = {
      get: (id) => watch.get(id, surfaceId).frame,
      subscribe: (id, listener) => watch.subscribe(id, surfaceId, listener),
      claim: (id, _surface, token) => watch.claim(id, surfaceId, token),
      accept: (id, _surface, token) => watch.accept(id, surfaceId, token),
      rasterDemand: (id) => watch.rasterDemand(id, surfaceId),
      invalidationKey: watch.invalidationKey,
    };
    const detach = attachBrowserCanvas(source, sessionId, surfaceId, canvas, (frame) => {
      const at = performance.now();
      const decoded = readMarker(canvas, frame.header.viewportWidth);
      if (decoded)
        pictures.push({
          ...decoded,
          at,
          frameId: frame.header.frameId,
          receivedAt: received.get(frame.header.frameId)!,
        });
      else invalidMarkers++;
      for (const check of waiters) check();
    });
    const releaseControl = control.retain(sessionId, surfaceId, { picture: false });
    const releaseWatch = watch.retain(sessionId, surfaceId, {
      frameWindow: true,
      rasterDemand: true,
    });
    stop = () => {
      detach();
      receipt();
      controls();
      releaseWatch();
      releaseControl();
      watch.dispose();
      control.dispose();
    };
    await waitFor(
      () => control.get(sessionId, surfaceId).admitted === true,
      "Control was not admitted",
    );
    controlSequence++;
    control.send(sessionId, surfaceId, {
      type: "viewport.follow",
      surfaceId,
      width: 800,
      height: 600,
    });
  },
  ready: (epoch) =>
    waitFor(
      () => pictures.some((picture) => picture.epoch === epoch && picture.value === 0),
      `No baseline pixels for epoch ${epoch}`,
    ),
  run: async ({ epoch, scenario, duration }) => {
    const inputs: InputSample[] = [];
    const initialInvalid = invalidMarkers;
    const start = performance.now();
    const sentence = "A quick browser stream feels responsive.";
    let expected = 0;
    const command = (message: BrowserCommand) => {
      const geometryRevision = drawnBrowserFrame(canvas)?.header.geometryRevision;
      control.send(
        sessionId,
        surfaceId,
        message.type === "input.wheel" || message.type === "input.pointer"
          ? { ...message, geometryRevision }
          : message,
      );
      return ++controlSequence;
    };
    const pointer = (action: "down" | "up") =>
      command({
        type: "input.pointer",
        action,
        button: "left",
        buttons: action === "down" ? 1 : 0,
        clickCount: 1,
        modifiers: [],
        x: 0.4,
        y: 0.2,
        viewportWidth: 800,
        viewportHeight: 600,
        surfaceId,
      });
    if (scenario.endsWith("scroll")) {
      // Fixed-duration open-loop motion; source/transport coalescing remains observable.
      await new Promise<void>((resolve, reject) => {
        let next = start;
        const tick = () => {
          try {
            const now = performance.now();
            if (now - start >= duration * 1000) {
              resolve();
              return;
            }
            if (now + 0.1 < next) {
              requestAnimationFrame(tick);
              return;
            }
            next += 1000 / 60;
            expected += 12;
            const sequence = command({
              type: "input.wheel",
              surfaceId,
              deltaX: 0,
              deltaY: 12,
              modifiers: [],
              x: 0.5,
              y: 0.5,
              viewportWidth: 800,
              viewportHeight: 600,
            });
            inputs.push({ at: now, expected, sequence });
            requestAnimationFrame(tick);
          } catch (error) {
            reject(new Error(String(error)));
          }
        };
        requestAnimationFrame(tick);
      });
    } else {
      // Discrete latency probes wait for pixels: a rejected key would invalidate length-based attribution.
      const count = scenario === "typing" ? sentence.length : 8;
      for (let index = 0; index < count; index++) {
        expected++;
        const at = performance.now();
        if (scenario === "typing") {
          const char = sentence[index]!;
          const code =
            char === " " ? "Space" : char === "." ? "Period" : `Key${char.toUpperCase()}`;
          const sequence = command({
            type: "input.key",
            action: "down",
            code,
            key: char,
            text: char,
            modifiers: [],
            surfaceId,
          });
          inputs.push({ at, expected, sequence });
          command({ type: "input.key", action: "up", code, key: char, modifiers: [], surfaceId });
        } else {
          const sequence = pointer("down");
          inputs.push({ at, expected, sequence });
          pointer("up");
        }
        await waitFor(
          () =>
            pictures.some(
              (picture) =>
                picture.epoch === epoch &&
                picture.value >= (resolveInputs(inputs, rejections).at(-1)?.expected ?? 0),
            ),
          `Input ${expected} never appeared in pixels for ${scenario}`,
          5_000,
        );
      }
    }
    const end = performance.now();
    try {
      await waitFor(
        () =>
          pictures.some(
            (picture) =>
              picture.epoch === epoch &&
              picture.value >= (resolveInputs(inputs, rejections).at(-1)?.expected ?? 0),
          ),
        `Final input ${expected} never appeared in pixels for ${scenario}`,
      );
    } catch (error) {
      errors.push(
        `${String(error)}; last presented state ${pictures.findLast((picture) => picture.epoch === epoch)?.value}`,
      );
    }
    return {
      start,
      end,
      finished: performance.now(),
      inputs,
      rejections: rejections.filter((range) =>
        inputs.some((input) => input.sequence! >= range.first && input.sequence! <= range.last),
      ),
      pictures: pictures.filter((picture) => picture.epoch === epoch),
      invalidMarkers: invalidMarkers - initialInvalid,
      errors: [...errors],
    };
  },
  stop: () => stop(),
};
