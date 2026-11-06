// @vitest-environment happy-dom
import type { HostSnapshot } from "@opensteer/client/host";
import type { VoiceTarget } from "@opensteer/client/voice";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVoiceCursor, voiceRowKey, type VoiceCursor } from "./voice-cursor.js";
import { CursorMotion } from "./workspace/cursor-motion.js";
import { ownCursor } from "./workspace/task-mark.js";

const thread: VoiceTarget = { kind: "thread", threadId: "thr_1" };

let cursor: VoiceCursor;
function Harness() {
  cursor = useVoiceCursor();
  return <>{cursor.layer}</>;
}

let container: HTMLElement;
let unmount: () => Promise<void>;
let row: HTMLElement;
let frames: FrameRequestCallback[];
const runFrames = () =>
  act(async () => {
    for (const frame of frames.splice(0)) frame(0);
  });

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.splice(id - 1, 1));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = `
    <li data-voice-row="thr_1"><a>Task</a></li>
    <section class="voice-island"><span class="voice-cursor"></span></section>`;
  row = document.querySelector("li")!;
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 100, 200, 30));
  document.elementFromPoint = () => row.querySelector("a");
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));
  unmount = () => act(async () => root.unmount());
});

afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const flying = () => document.querySelector(".voice-glide .acur");

it("flies to a row the person can see, after the show has already happened", async () => {
  const navigate = vi.fn();
  cursor.show(thread, true, navigate);
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(flying()).toBeNull();
  await runFrames();
  expect(flying()).not.toBeNull();
  expect(document.querySelector(".voice-island")?.hasAttribute("data-away")).toBe(true);
});

it.each<[string, () => void]>([
  ["the window is not in front", () => vi.mocked(document.hasFocus).mockReturnValue(false)],
  ["the row is not in the sidebar", () => row.remove()],
  ["something covers the row", () => (document.elementFromPoint = () => document.body)],
  [
    "reduced motion is on",
    () => vi.stubGlobal("matchMedia", () => ({ matches: true }) as MediaQueryList),
  ],
  ["no pill is left to leave from", () => document.querySelector(".voice-island")?.remove()],
  [
    "the way there crosses a native page",
    () => {
      const stage = document.createElement("div");
      stage.className = "browser-stage";
      stage.dataset.native = "true";
      vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(new DOMRect(-500, -500, 2000, 2000));
      document.body.append(stage);
    },
  ],
])("still opens the show, with no cursor, when %s", async (_, arrange) => {
  arrange();
  const navigate = vi.fn();
  cursor.show(thread, true, navigate);
  await runFrames();
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(flying()).toBeNull();
});

it("leaves a show that isn't the call's alone", async () => {
  const navigate = vi.fn();
  cursor.show(thread, false, navigate);
  await runFrames();
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(flying()).toBeNull();
});

it("never reaches for a browser tab across a desktop's native page", async () => {
  document.documentElement.classList.add("electron-shell");
  try {
    const navigate = vi.fn();
    const target = { kind: "place", destination: { kind: "browser" } } as VoiceTarget;
    cursor.show(target, true, navigate);
    await runFrames();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(flying()).toBeNull();
  } finally {
    document.documentElement.classList.remove("electron-shell");
  }
});

it("names a place's row the same way however its destination was spelled", () => {
  const row = { appKey: "numbers", computerSessionId: "s1", kind: "app", machineId: "mac" };
  const show = {
    kind: "app",
    machineId: "mac",
    source: null,
    appKey: "numbers",
    computerSessionId: "s1",
  };
  const key = (destination: unknown) => voiceRowKey({ kind: "place", destination } as VoiceTarget);
  expect(key(show)).toBe(key(row));
  expect(key({ ...row, appKey: "pages" })).not.toBe(key(row));
  expect(key({ kind: "browser", sessionId: "a", tabId: "t" })).toBe(
    key({ kind: "browser", sessionId: "b", tabId: "t" }),
  );
});

it("keeps opening shows when one arrives mid-glide, and gives up on one it can't follow", async () => {
  const navigate = vi.fn();
  cursor.show(thread, true, navigate);
  await runFrames();
  expect(flying()).not.toBeNull();

  row.remove();
  cursor.show(thread, true, navigate);
  expect(navigate).toHaveBeenCalledTimes(2);
  await runFrames();
  expect(document.querySelector(".voice-island")?.hasAttribute("data-away")).toBe(false);
});

it("lets a newer glide finish when the one it replaced lands on its way out", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const place = vi.spyOn(CursorMotion.prototype, "place");
  const leave = vi.spyOn(CursorMotion.prototype, "leave");
  try {
    cursor.show(thread, true, () => undefined);
    await runFrames();
    const landed = place.mock.calls.at(-1)?.[2]?.landed;
    cursor.show(thread, true, () => undefined);
    // The old glide's own frame was queued first, so it lands before the new one starts.
    landed?.();
    await runFrames();
    vi.advanceTimersByTime(2_000);
    expect(leave).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("lets a new glide take off while the last one is fading", async () => {
  const leave = vi.spyOn(CursorMotion.prototype, "leave");
  cursor.show(thread, true, () => undefined);
  await runFrames();
  // A show it can't follow fades the cursor; the next one takes off during that fade.
  row.remove();
  cursor.show(thread, true, () => undefined);
  await runFrames();
  const faded = leave.mock.calls.at(-1)?.[1];
  document.body.prepend(row);
  cursor.show(thread, true, () => undefined);
  await act(async () => {
    for (const frame of frames.splice(0)) frame(0);
    faded?.();
  });
  expect(flying()).not.toBeNull();
});

it("clears the cursor when a fade ends with no new glide", async () => {
  const leave = vi.spyOn(CursorMotion.prototype, "leave");
  cursor.show(thread, true, () => undefined);
  await runFrames();
  row.remove();
  cursor.show(thread, true, () => undefined);
  await runFrames();
  const faded = leave.mock.calls.at(-1)?.[1];
  // Another show it can't follow changes nothing: the first fade still ends the layer.
  cursor.show(thread, true, () => undefined);
  await runFrames();
  await act(async () => faded?.());
  expect(flying()).toBeNull();
});

it("keeps Voice's color on the tasks it started, and only those", () => {
  const tasks = {
    activeTasks: [],
    tasks: null,
    threads: [
      { id: "thr_started", parentThreadId: "thr_voice" },
      { id: "thr_other", parentThreadId: "thr_chat" },
    ],
    voiceThreadId: "thr_voice",
    workspaceTasks: {},
  } as unknown as HostSnapshot;
  expect(ownCursor("thr_started", false, tasks)).toBe(true);
  expect(ownCursor("thr_voice", false, tasks)).toBe(true);
  expect(ownCursor("thr_chat", true, tasks)).toBe(true);
  expect(ownCursor("thr_other", false, tasks)).toBe(false);
  expect(ownCursor("thr_unknown", false, tasks)).toBe(false);
  expect(ownCursor("thr_other", false, { ...tasks, voiceThreadId: null })).toBe(false);
});
