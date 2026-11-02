import "../../../../src/runtime.js";
import { registerRootComponent } from "expo";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useRef, useState, type ComponentRef, type RefObject } from "react";
import { AppState, Dimensions, Platform, Text, View } from "react-native";
import type { BrowserFrameStore, BrowserFrameView } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { useNativeBrowserPicture } from "../../../../src/browser/native-browser-picture.js";
import { decodeDisplayFrame } from "../../../../src/computers/phone-display.js";
import {
  NativeDisplay,
  nativePictureView,
  phoneDisplayBinary,
  type DisplayFrameMetadata,
  type NativeDecoder,
} from "../../../../src/computers/phone-display-native.js";

// A Metro entry for a Release build of the real app binary. The native module,
// picture hook and frame hand-off are production code; only the frame store and
// the coordinator that screenshots the simulator are fixtures.
void SplashScreen.hideAsync().catch(() => undefined);
const coordinator = `http://${Platform.OS === "android" ? "10.0.2.2" : "127.0.0.1"}:18766`;
const backdrop: Color = [128, 128, 128];
type Color = readonly [number, number, number];
type Rect = { x: number; y: number; width: number; height: number };
type Probe = { x: number; y: number; color: Color; label: string };

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(coordinator + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status} ${JSON.stringify(result)}`);
  return result;
}
const log = (type: string, details: unknown = {}) =>
  void post("/event", { type, details, at: Date.now() }).catch(() => undefined);
async function fixture(name: string): Promise<Uint8Array> {
  const response = await fetch(`${coordinator}/fixture/${name}`);
  if (!response.ok) throw new Error(`fixture ${name} ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
/** Split synthetic Annex B fixtures at their access-unit delimiters. */
function accessUnits(bytes: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 4 < bytes.length; i++) {
    const size =
      bytes[i] === 0 && bytes[i + 1] === 0
        ? bytes[i + 2] === 1
          ? 3
          : bytes[i + 2] === 0 && bytes[i + 3] === 1
            ? 4
            : 0
        : 0;
    if (!size) continue;
    if ((bytes[i + size]! & 31) === 9) starts.push(i);
    i += size - 1;
  }
  return starts.map((start, i) => bytes.subarray(start, starts[i + 1] ?? bytes.length));
}
/** The bytes behind a header in one buffer, as the browser watch hands them over. */
function offsetBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = 7;
  const buffer = new ArrayBuffer(prefix + bytes.byteLength + 5);
  new Uint8Array(buffer).fill(0xee);
  new Uint8Array(buffer, prefix, bytes.byteLength).set(bytes);
  return new Uint8Array(buffer, prefix, bytes.byteLength);
}

class FixtureFrames implements BrowserFrameStore {
  private readonly frames = new Map<string, BrowserFrameView>();
  private readonly listeners = new Set<{ tab: string | undefined; listener: () => void }>();
  get = (_session: string, tab?: string) => this.frames.get(tab ?? "") ?? null;
  subscribe = (_session: string, listener: () => void, tab?: string) => {
    const entry = { tab, listener };
    this.listeners.add(entry);
    return () => void this.listeners.delete(entry);
  };
  put(tab: string, frame: BrowserFrameView) {
    this.frames.set(tab, frame);
    for (const entry of this.listeners)
      if (entry.tab === undefined || entry.tab === tab) entry.listener();
  }
}

const tabs = [
  BrowserSurfaceIdSchema.parse("fixture-tab-one"),
  BrowserSurfaceIdSchema.parse("fixture-tab-two"),
] as const;
let frameId = 0;
function browserFrame(
  tab: (typeof tabs)[number],
  bytes: Uint8Array,
  width: number,
  height: number,
  revision: number,
): BrowserFrameView {
  return {
    data: offsetBytes(bytes),
    header: {
      encoding: "jpeg",
      frameId: ++frameId,
      geometryRevision: revision,
      rasterWidth: width,
      rasterHeight: height,
      surfaceId: tab,
      viewportWidth: width * 10,
      viewportHeight: height * 10,
    },
  };
}

/** Aspect-fit, centred: computed here independently of the native layout it checks. */
function fit(box: Rect, width: number, height: number): Rect {
  const scale = Math.min(box.width / width, box.height / height);
  return {
    x: box.x + (box.width - width * scale) / 2,
    y: box.y + (box.height - height * scale) / 2,
    width: width * scale,
    height: height * scale,
  };
}
const at = (rect: Rect, fx: number, fy: number) => ({
  x: rect.x + rect.width * fx,
  y: rect.y + rect.height * fy,
});
function redBlue(rect: Rect): Probe[] {
  return [
    { ...at(rect, 0.25, 0.5), color: [255, 0, 0], label: "red left half" },
    { ...at(rect, 0.75, 0.5), color: [0, 0, 255], label: "blue right half" },
  ];
}
function greenYellow(rect: Rect): Probe[] {
  return [
    { ...at(rect, 0.5, 0.25), color: [0, 255, 0], label: "green top half" },
    { ...at(rect, 0.5, 0.75), color: [255, 255, 0], label: "yellow bottom half" },
  ];
}
const blank = (probes: Probe[]): Probe[] =>
  probes.map((probe) => ({ ...probe, color: backdrop, label: `${probe.label} cleared` }));

type Waiter<T> = { test: (value: T) => boolean; resolve: (value: T) => void };
function deferredStream<T>() {
  const seen: T[] = [];
  let waiters: Waiter<T>[] = [];
  return {
    seen,
    push(value: T) {
      seen.push(value);
      const ready = waiters.filter((waiter) => waiter.test(value));
      waiters = waiters.filter((waiter) => !ready.includes(waiter));
      for (const waiter of ready) waiter.resolve(value);
    },
    /** The next value passing `test`, or the latest one already seen if it passes. */
    next(test: (value: T) => boolean, what: string, ms = 4_000, current = false): Promise<T> {
      const latest = seen.at(-1);
      if (current && seen.length > 0 && test(latest as T)) return Promise.resolve(latest as T);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`never happened within ${ms} ms: ${what}`)),
          ms,
        );
        waiters.push({
          test,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        });
      });
    },
  };
}

function BrowserPicture(props: {
  frames: FixtureFrames;
  tab: string;
  visible: boolean;
  settle: (delivery: BrowserFrameView) => void;
  drawn: (delivery: BrowserFrameView | null) => void;
  cleared: (generation: number) => void;
}) {
  const [Picture] = useState(nativePictureView);
  const picture = useNativeBrowserPicture({
    enabled: Picture !== null,
    visible: props.visible,
    frames: props.frames,
    sessionId: "fixture-session",
    tabId: props.tab,
    settle: props.settle,
  });
  const report = props.drawn;
  useEffect(() => report(picture.drawn), [picture.drawn, report]);
  if (Picture === null) return <Text>no picture view</Text>;
  return (
    <Picture
      ref={picture.view}
      onCleared={(event) => {
        props.cleared(event.nativeEvent.generation);
        picture.cleared(event);
      }}
      style={{ flex: 1 }}
    />
  );
}

function Journey() {
  const frames = useRef(new FixtureFrames()).current;
  const [box, setBox] = useState({ width: 300, height: 200 });
  const [visible, setVisible] = useState(true);
  const [tab, setTab] = useState<(typeof tabs)[number]>(tabs[0]);
  const [pictureMounted, setPictureMounted] = useState(true);
  const [videoMounted, setVideoMounted] = useState(false);
  const [status, setStatus] = useState("starting");
  const pictureBox = useRef<ComponentRef<typeof View>>(null);
  const videoBox = useRef<ComponentRef<typeof View>>(null);
  const decoder = useRef<NativeDecoder | null>(null);
  const drawn = useRef(deferredStream<BrowserFrameView | null>()).current;
  const cleared = useRef(deferredStream<number>()).current;
  const settled = useRef(new Map<number, number>()).current;
  const ready = useRef(deferredStream<{ epoch: string; width: number; height: number }>()).current;
  const keyframes = useRef(deferredStream<string>()).current;
  const settle = useRef((delivery: BrowserFrameView) => {
    settled.set(delivery.header.frameId, (settled.get(delivery.header.frameId) ?? 0) + 1);
    log("settled", { frameId: delivery.header.frameId });
  }).current;
  const reportDrawn = useRef((delivery: BrowserFrameView | null) => {
    log(
      "drawn",
      delivery && {
        frameId: delivery.header.frameId,
        raster: [delivery.header.rasterWidth, delivery.header.rasterHeight],
      },
    );
    drawn.push(delivery);
  }).current;
  const reportCleared = useRef((generation: number) => {
    log("cleared", { generation });
    cleared.push(generation);
  }).current;

  useEffect(() => {
    const measure = (view: RefObject<ComponentRef<typeof View> | null>) =>
      new Promise<Rect>((resolve, reject) => {
        if (view.current === null) return reject(new Error("view not mounted"));
        view.current.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
      });
    const settledLayout = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    const check = async (
      step: string,
      probes: Probe[],
      options: { never?: boolean; ms?: number } = {},
    ) => {
      setStatus(step);
      const screen = Dimensions.get("screen");
      const window = Dimensions.get("window");
      await post("/check", {
        step,
        probes,
        screen: { width: screen.width, height: screen.height },
        window: { width: window.width, height: window.height },
        ...options,
      });
    };
    /** Another app takes over until `probes` leave the screen; resolves once this app is active again. */
    const background = async (step: string, probes: Probe[]) => {
      let left = false;
      let subscription: { remove(): void } | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const returned = new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`never happened within 20000 ms: ${step} returned to active`)),
          20_000,
        );
        subscription = AppState.addEventListener("change", (state) => {
          if (state !== "active") left = true;
          else if (left) resolve();
        });
      });
      try {
        const screen = Dimensions.get("screen");
        const window = Dimensions.get("window");
        await post("/background", {
          step,
          probes,
          screen: { width: screen.width, height: screen.height },
          window: { width: window.width, height: window.height },
        });
        await returned;
      } finally {
        clearTimeout(timer);
        subscription?.remove();
      }
    };
    const expect = async (step: string, condition: boolean, details: unknown = {}) => {
      await post("/assert", { step, passed: condition, details });
    };
    const drawnFrame = (frame: BrowserFrameView | null, what: string) =>
      drawn.next((value) => value === frame, what, 4_000, true);

    const pictures = async () => {
      await expect("binary declares presentation version", phoneDisplayBinary());
      await expect("named picture view resolves", nativePictureView() !== null);
      const [redBlueJpeg, greenYellowJpeg] = await Promise.all([
        fixture("red-blue-64x48.jpg"),
        fixture("green-yellow-48x64.jpg"),
      ]);

      // First picture, handed over as a Uint8Array whose byteOffset is not zero.
      const first = browserFrame(tabs[0], redBlueJpeg, 64, 48, 1);
      await expect(
        "frame bytes start past the buffer start",
        (first.data as Uint8Array).byteOffset > 0,
        { byteOffset: (first.data as Uint8Array).byteOffset },
      );
      frames.put(tabs[0], first);
      await drawnFrame(first, "first picture drawn");
      await expect(
        "drawn picture settled once when drawn",
        settled.get(first.header.frameId) === 1,
      );
      let area = await measure(pictureBox);
      const firstRect = fit(area, 64, 48);
      await check("picture-first", [
        ...redBlue(firstRect),
        { x: area.x + 3, y: area.y + area.height / 2, color: backdrop, label: "letterbox" },
      ]);

      // A burst across new geometry: the queue keeps one decode and the newest waiting.
      const burst = [
        browserFrame(tabs[0], greenYellowJpeg, 48, 64, 2),
        browserFrame(tabs[0], redBlueJpeg, 64, 48, 3),
        browserFrame(tabs[0], greenYellowJpeg, 48, 64, 4),
      ] as const;
      const before = drawn.seen.length;
      for (const frame of burst) frames.put(tabs[0], frame);
      await drawnFrame(burst[2], "newest burst picture drawn");
      const during = drawn.seen.slice(before).filter((value) => value !== null);
      // An intermediate picture may be drawn only if it truly reached the screen; the last drawn must be the newest.
      await expect("burst ends on newest geometry", during.at(-1) === burst[2], {
        drawn: during.map((value) => value?.header.frameId),
      });
      await expect(
        "burst settled every delivery exactly once",
        burst.every((frame) => settled.get(frame.header.frameId) === 1),
        { settled: Object.fromEntries(settled) },
      );
      await expect(
        "input header is the drawn raster",
        during.at(-1)?.header.rasterWidth === 48 && during.at(-1)?.header.rasterHeight === 64,
      );
      await check("picture-new-geometry", greenYellow(fit(area, 48, 64)));

      // The view's own size changes; the shown picture re-lays out without a new delivery.
      setBox({ width: 200, height: 300 });
      await settledLayout();
      area = await measure(pictureBox);
      await expect(
        "box resized",
        Math.round(area.width) === 200 && Math.round(area.height) === 300,
        area,
      );
      await check("picture-view-resized", greenYellow(fit(area, 48, 64)));

      // Hidden: pixels and the input picture go together; deliveries return at once.
      const shownProbes = greenYellow(fit(area, 48, 64));
      setVisible(false);
      await drawnFrame(null, "drawn cleared on hide");
      await check("picture-hidden", blank(shownProbes));
      const hiddenFrame = browserFrame(tabs[0], redBlueJpeg, 64, 48, 5);
      frames.put(tabs[0], hiddenFrame);
      await expect(
        "hidden delivery returned at once",
        settled.get(hiddenFrame.header.frameId) === 1,
      );
      setVisible(true);
      await settledLayout();
      await check(
        "picture-shown-again-waits-for-a-new-delivery",
        [...shownProbes, ...redBlue(fit(area, 64, 48))],
        { never: true, ms: 800 },
      );
      const afterShow = browserFrame(tabs[0], redBlueJpeg, 64, 48, 6);
      frames.put(tabs[0], afterShow);
      await drawnFrame(afterShow, "picture after showing again");
      await check("picture-shown-again", redBlue(fit(area, 64, 48)));

      // Another tab: the old tab's pixels go before anything aims at the new one.
      setTab(tabs[1]);
      await drawnFrame(null, "drawn cleared on tab change");
      await check("picture-tab-changed", blank(redBlue(fit(area, 64, 48))));
      const otherTab = browserFrame(tabs[1], greenYellowJpeg, 48, 64, 1);
      frames.put(tabs[1], otherTab);
      await drawnFrame(otherTab, "other tab picture drawn");
      await check("picture-other-tab", greenYellow(fit(area, 48, 64)));

      // Background: the view clears itself and tells JavaScript, which stops aiming at it.
      const clearedBefore = cleared.seen.length;
      await background("picture-left-foreground", greenYellow(fit(area, 48, 64)));
      // The event may already have arrived while another app was in front.
      if (cleared.seen.length === clearedBefore)
        await cleared
          .next(() => true, "native cleared event after background", 6_000)
          .catch(() => undefined);
      await expect("native cleared on background", cleared.seen.length > clearedBefore, {
        cleared: cleared.seen,
      });
      await drawnFrame(null, "drawn cleared on background");
      await check("picture-after-background", blank(greenYellow(fit(area, 48, 64))));
      const afterBackground = browserFrame(tabs[1], redBlueJpeg, 64, 48, 2);
      frames.put(tabs[1], afterBackground);
      await drawnFrame(afterBackground, "picture after returning to foreground");
      await check("picture-after-foreground", redBlue(fit(area, 64, 48)));

      // Unmount: every delivery this view took is returned exactly once.
      setPictureMounted(false);
      await settledLayout();
      const counts = [...settled.values()];
      await expect(
        "every delivery settled exactly once",
        counts.length === frameId && counts.every((count) => count === 1),
        { frameId, settled: Object.fromEntries(settled) },
      );
    };

    const video = async () => {
      setVideoMounted(true);
      await keyframes.next(() => true, "keyframe request when the display joins the window");
      const native = decoder.current;
      if (native === null) throw new Error("display decoder ref missing");
      const binary = phoneDisplayBinary();
      const [key, delta] = await Promise.all([
        fixture("lime-key-64x64.h264"),
        fixture("blue-delta-64x64.h264"),
      ]);
      const frame = (
        epoch: string,
        key: boolean,
        pts: number,
        replayed = false,
      ): DisplayFrameMetadata => ({ epoch, width: 64, height: 64, pts, key, replayed });
      const area = await measure(videoBox);
      const center = (color: Color, label: string): Probe[] => [
        { ...at(fit(area, 64, 64), 0.5, 0.5), color, label },
      ];
      const black: Color = [0, 0, 0];

      await native.reset("e1");
      await check("video-reset-black", center(black, "flushed"));
      const keyBytes = offsetBytes(key);
      await expect("video bytes start past the buffer start", keyBytes.byteOffset > 0);
      const readyE1 = ready.next((value) => value.epoch === "e1", "onReady for e1");
      await expect(
        "key frame accepted as bytes",
        await decodeDisplayFrame(native, binary, keyBytes, frame("e1", true, 0)),
      );
      const announced = await readyE1;
      await expect(
        "onReady names the source epoch and size",
        announced.epoch === "e1" && announced.width === 64 && announced.height === 64,
        announced,
      );
      await check("video-key", center([0, 255, 0], "lime key frame"));
      await expect(
        "delta accepted",
        await decodeDisplayFrame(native, binary, offsetBytes(delta), frame("e1", false, 500_000)),
      );
      await check("video-delta", center([0, 0, 255], "blue delta frame"));
      await expect(
        "stale epoch refused",
        !(await decodeDisplayFrame(native, binary, offsetBytes(key), frame("e0", true, 0))),
      );
      await expect(
        "one onReady per epoch",
        ready.seen.filter((value) => value.epoch === "e1").length === 1,
      );

      // Replay rebuilds the reference picture without showing it or announcing readiness.
      await native.reset("e2");
      await check("video-reset-clears", center(black, "flushed"));
      const readyCount = ready.seen.length;
      await expect(
        "replayed key accepted",
        await decodeDisplayFrame(
          native,
          binary,
          offsetBytes(key),
          frame("e2", true, 1_000_000, true),
        ),
      );
      await check("video-replay-not-shown", center([0, 255, 0], "replayed key frame"), {
        never: true,
        ms: 1_200,
      });
      await expect("no onReady for a replayed picture", ready.seen.length === readyCount);
      const readyE2 = ready.next((value) => value.epoch === "e2", "onReady for e2 after replay");
      await expect(
        "live delta after replay accepted",
        await decodeDisplayFrame(native, binary, offsetBytes(delta), frame("e2", false, 1_500_000)),
      );
      await readyE2;
      await check("video-live-after-replay", center([0, 0, 255], "blue delta after replay"));

      // Background resets the decoder; the old epoch is refused until JavaScript starts a new one.
      await background("video-left-foreground", center([0, 0, 255], "blue delta"));
      await expect(
        "old epoch refused after background",
        !(await decodeDisplayFrame(
          native,
          binary,
          offsetBytes(delta),
          frame("e2", false, 2_000_000),
        )),
      );
      await check("video-after-background", center(black, "cleared on background"));
      await native.reset("e3");
      const readyE3 = ready.next((value) => value.epoch === "e3", "onReady for e3");
      // The base64 path older JavaScript uses still decodes on this binary.
      await expect(
        "base64 key accepted",
        await decodeDisplayFrame(native, false, key, frame("e3", true, 3_000_000)),
      );
      await readyE3;
      await check("video-base64-key", center([0, 255, 0], "lime key via base64"));
      // Mac encoder geometry, reference loss, static refresh and generation changes.
      for (const [name, width, height] of [
        ["mac", 1512, 982],
        ["resized", 1280, 800],
      ] as const) {
        const units = accessUnits(await fixture(`${name}.h264`));
        const epoch = `mac-${name}`;
        const metadata = (key: boolean, replayed = false): DisplayFrameMetadata => ({
          epoch,
          width,
          height,
          key,
          replayed,
          pts: key ? 0 : 500_000,
        });
        const pixels = (color: Color): Probe[] => [
          { ...at(fit(area, width, height), 0.5, 0.5), color, label: name },
        ];
        await native.reset(epoch);
        await expect(
          `${name} initial delta fenced`,
          !(await decodeDisplayFrame(native, binary, units[1]!, metadata(false))),
        );
        await expect(
          `${name} replay key admitted`,
          await decodeDisplayFrame(native, binary, units[0]!, metadata(true, true)),
        );
        await check(`${name}-replay-hidden`, pixels([0, 255, 0]), { never: true, ms: 800 });
        const first = ready.next((value) => value.epoch === epoch, `${name} onReady`);
        await expect(
          `${name} delta admitted`,
          await decodeDisplayFrame(native, binary, units[1]!, metadata(false)),
        );
        await first;
        await check(`${name}-delta`, pixels([0, 0, 255]));
        await expect(
          `${name} invalid sample dropped`,
          !(await decodeDisplayFrame(native, binary, new Uint8Array(), metadata(false))),
        );
        await expect(
          `${name} delta after drop fenced`,
          !(await decodeDisplayFrame(native, binary, units[1]!, metadata(false))),
        );
        await expect(
          `${name} key restores references`,
          await decodeDisplayFrame(native, binary, units[0]!, metadata(true)),
        );
        await check(`${name}-key`, pixels([0, 255, 0]));
        await expect(
          `${name} equal PTS refresh admitted`,
          await decodeDisplayFrame(native, binary, units[0]!, metadata(true)),
        );
        await check(`${name}-static-refresh`, pixels([0, 255, 0]));
        await background(`${name}-background`, pixels([0, 255, 0]));
        await check(`${name}-background-cleared`, pixels(black));
        await expect(
          `${name} return delta fenced`,
          !(await decodeDisplayFrame(native, binary, units[1]!, metadata(false))),
        );
        const returned = ready.next(
          (value) => value.epoch === epoch,
          `${name} ready after background`,
          6000,
        );
        await expect(
          `${name} return key admitted`,
          await decodeDisplayFrame(native, binary, units[0]!, metadata(true)),
        );
        await returned;
        await check(`${name}-returned`, pixels([0, 255, 0]));
      }
      setVideoMounted(false);
    };

    void (async () => {
      try {
        await post("/start", { platform: Platform.OS, version: Platform.Version });
        await pictures();
        await video();
        setStatus("done");
        await post("/done", { failed: false });
      } catch (error) {
        const message =
          error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
        setStatus(`failed: ${message}`);
        await post("/done", { failed: true, message }).catch(() => undefined);
      }
    })();
    // The journey runs once per launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: "#000000",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
      }}
    >
      <View ref={pictureBox} collapsable={false} style={{ ...box, backgroundColor: "#808080" }}>
        {pictureMounted ? (
          <BrowserPicture
            frames={frames}
            tab={tab}
            visible={visible}
            settle={settle}
            drawn={reportDrawn}
            cleared={reportCleared}
          />
        ) : null}
      </View>
      <View
        ref={videoBox}
        collapsable={false}
        style={{ width: 160, height: 160, backgroundColor: "#808080" }}
      >
        {videoMounted ? (
          <NativeDisplay
            ref={decoder}
            onReady={(event) => {
              log("ready", event.nativeEvent);
              ready.push(event.nativeEvent);
            }}
            onNeedsKeyframe={(event) => {
              log("needs-keyframe", event.nativeEvent);
              keyframes.push(event.nativeEvent.epoch);
            }}
            style={{ flex: 1 }}
          />
        ) : null}
      </View>
      <Text style={{ color: "#ffffff", position: "absolute", bottom: 40 }}>{status}</Text>
    </View>
  );
}

registerRootComponent(Journey);
