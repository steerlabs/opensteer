import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DictationAvailability,
  DictationEvent,
  DictationPort,
} from "@opensteer/protocol/dictation";
import { DictationController, dictationView, type DictationTarget } from "./controller.js";

const installed: DictationAvailability = {
  available: true,
  locale: "en-US",
  languageName: "English",
  model: "installed",
  microphone: "granted",
};
type Payload = DictationEvent extends infer E
  ? E extends DictationEvent
    ? Omit<E, "session" | "seq">
    : never
  : never;
function setup(availability: DictationAvailability = installed) {
  let listener: (event: DictationEvent) => void = () => {};
  let id = 0;
  let seq = 0;
  const port: DictationPort = {
    availability: vi.fn(async () => availability),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    openMicrophoneSettings: vi.fn(async () => {}),
    subscribe: vi.fn((receive) => {
      listener = receive;
      return vi.fn();
    }),
  };
  const controller = new DictationController({
    port,
    createId: () => "00000000-0000-4000-8000-" + String(++id).padStart(12, "0"),
    now: () => Date.now(),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (timer) => clearTimeout(timer),
  });
  let draft = { text: "a bad day", selection: { start: 2, end: 5 } };
  const target: DictationTarget = {
    owner: "one",
    read: () => draft,
    commit: vi.fn((text, selection) => {
      draft = { text, selection };
    }),
  };
  const emit = (payload: Payload, override: Partial<{ session: string; seq: number }> = {}) => {
    listener({
      ...payload,
      session: "00000000-0000-4000-8000-" + String(id).padStart(12, "0"),
      seq: ++seq,
      ...override,
    } as DictationEvent);
  };
  const start = async () => {
    await controller.refresh();
    seq = 0;
    controller.start(target);
  };
  return {
    controller,
    port,
    target,
    emit,
    start,
    draft: () => draft,
    edit: (text: string) => {
      draft = { text, selection: { start: text.length, end: text.length } };
    },
  };
}
const text = (finalized: string[], volatile: string[] = []): Payload => ({
  type: "text",
  finalized,
  volatile,
});
const completed: Payload = { type: "ended", reason: "completed", error: null };
const runtimes: DictationController[] = [];
function runtime(availability?: DictationAvailability) {
  const fake = setup(availability);
  runtimes.push(fake.controller);
  return fake;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => {
  for (const controller of runtimes.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe("dictation controller", () => {
  it("previews without mutating the draft, preserves selection until speech, commits before resolving one finish promise", async () => {
    const f = runtime();
    await f.start();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "starting", preview: null });
    f.emit({ type: "listening" });
    expect(f.controller.getSnapshot().listeningSince).toBe(1000);
    f.emit(text([], []));
    expect(f.controller.getSnapshot().preview).toBeNull();
    f.emit(text([], ["good"]));
    expect(f.draft().text).toBe("a bad day");
    expect(f.controller.getSnapshot().preview).toEqual({
      text: "a good day",
      selection: { start: 6, end: 6 },
    });
    const snapshot = f.controller.getSnapshot();
    // A person moving the selection does not move the captured insertion range.
    f.target.read().selection = { start: 0, end: 0 };
    f.emit(text(["good"]));
    expect(f.controller.getSnapshot()).toBe(snapshot);
    const finish = f.controller.stop("one");
    expect(f.controller.stop("one")).toBe(finish);
    expect(f.port.stop).toHaveBeenCalledTimes(1);
    f.emit(completed);
    expect(await finish).toEqual({ kind: "committed", text: "a good day" });
    expect(f.target.commit).toHaveBeenCalledExactlyOnceWith("a good day", { start: 6, end: 6 });
    expect(await f.controller.stop("one")).toEqual({ kind: "idle" });
  });

  it("keeps level ticks off the snapshot store and fences duplicate and foreign events", async () => {
    const f = runtime();
    await f.start();
    const changed = vi.fn();
    const levels = vi.fn();
    f.controller.subscribe(changed);
    f.controller.subscribeLevel(levels);
    const snapshot = f.controller.getSnapshot();
    f.emit({ type: "level", level: 0.4 });
    f.emit(text(["wrong"]), { session: "00000000-0000-4000-8000-999999999999" });
    f.emit(text(["duplicate"]), { seq: 1 });
    expect(levels).toHaveBeenCalledExactlyOnceWith(0.4);
    expect(changed).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toBe(snapshot);
  });

  it("cancel restores the untouched draft and ignores late events and rejections", async () => {
    const f = runtime();
    let reject!: (error: Error) => void;
    vi.mocked(f.port.start).mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    await f.start();
    f.emit(text([], ["good"]));
    const finish = f.controller.stop("one");
    f.controller.cancel("one");
    reject(new Error("late"));
    f.emit(completed);
    expect(await finish).toEqual({ kind: "aborted" });
    expect(f.draft().text).toBe("a bad day");
    expect(f.target.commit).not.toHaveBeenCalled();
    expect(f.port.cancel).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot().notice).toBeNull();
  });

  it.each(["listening", "finishing"] as const)(
    "release while %s preserves the adopted edit and aborts send",
    async (phase) => {
      const f = runtime();
      await f.start();
      f.emit({ type: "listening" });
      f.emit(text([], ["good"]));
      const finish = phase === "finishing" ? f.controller.stop("one") : null;
      f.edit("a good! day");
      f.controller.release("other");
      expect(f.controller.getSnapshot().owner).toBe("one");
      f.controller.release("one");
      f.emit(text(["late"]));
      f.emit(completed);
      if (finish) expect(await finish).toEqual({ kind: "aborted" });
      expect(f.draft().text).toBe("a good! day");
      expect(f.target.commit).not.toHaveBeenCalled();
    },
  );

  it.each(["starting", "listening", "finishing"] as const)(
    "leave during %s aborts sending and retains the original commit target only after capture",
    async (phase) => {
      const f = runtime();
      await f.start();
      if (phase !== "starting") {
        f.emit({ type: "listening" });
        f.emit(text(["good"]));
      }
      const finish = phase === "finishing" ? f.controller.stop("one") : null;
      f.controller.leave("other");
      f.controller.leave("one");
      if (phase === "starting") {
        expect(f.port.cancel).toHaveBeenCalledTimes(1);
        expect(f.target.commit).not.toHaveBeenCalled();
      } else {
        const waiting = f.controller.stop("one");
        expect(await waiting).toEqual({ kind: "aborted" });
        if (finish) expect(waiting).toBe(finish);
        f.emit(completed);
        expect(f.draft().text).toBe("a good day");
      }
    },
  );

  it("appends when an external draft changed and never uses the new selection", async () => {
    const f = runtime();
    await f.start();
    f.emit(text(["good"]));
    f.edit("Recovered draft");
    const finish = f.controller.stop("one");
    f.emit(completed);
    expect(await finish).toEqual({ kind: "committed", text: "Recovered draft good" });
  });

  it("stops during starting without removing a selection; empty notice expires after five seconds", async () => {
    const f = runtime();
    await f.start();
    const finish = f.controller.stop("one");
    f.emit(completed);
    expect(await finish).toEqual({ kind: "empty" });
    expect(f.target.commit).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().notice).toMatchObject({ owner: "one", kind: "empty" });
    vi.advanceTimersByTime(4999);
    expect(f.controller.getSnapshot().notice).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(f.controller.getSnapshot().notice).toBeNull();
  });

  it.each(["gap", "rejection", "malformed"] as const)(
    "%s keeps received tentative text and terminates only once",
    async (failure) => {
      const f = runtime();
      await f.start();
      f.emit(text(["good"], ["words"]));
      if (failure === "rejection")
        vi.mocked(f.port.stop).mockRejectedValueOnce(new Error("transport"));
      const finish = f.controller.stop("one");
      if (failure === "gap") f.emit(text(["lost"]), { seq: 5 });
      if (failure === "malformed") f.emit({ type: "level", level: 2 });
      await Promise.resolve();
      f.emit(completed);
      expect(await finish).toEqual({ kind: "failed" });
      expect(f.draft().text).toBe("a good words day");
      expect(f.port.cancel).toHaveBeenCalledTimes(1);
      expect(f.target.commit).toHaveBeenCalledTimes(1);
      expect(f.controller.getSnapshot().notice?.kind).toBe(
        failure === "gap" ? "recognition-failed" : "service-unavailable",
      );
    },
  );

  it.each(["busy", "permission-denied"] as const)(
    "native %s fails finish-then-send and presents an owner scoped notice",
    async (error) => {
      const f = runtime();
      await f.start();
      const finish = f.controller.stop("one");
      f.emit({ type: "ended", reason: "failed", error });
      expect(await finish).toEqual({ kind: "failed" });
      expect(f.target.commit).not.toHaveBeenCalled();
      expect(f.controller.getSnapshot().notice).toMatchObject({
        owner: "one",
        kind: error,
        action: error === "permission-denied" ? "open-settings" : null,
      });
      f.controller.release("other");
      expect(f.controller.getSnapshot().notice).not.toBeNull();
      f.controller.release("one");
      expect(f.controller.getSnapshot().notice).toBeNull();
    },
  );

  it.each(["interrupted", "device-changed"] as const)(
    "%s commits final text but does not send",
    async (reason) => {
      const f = runtime();
      await f.start();
      f.emit(text(["good"]));
      const finish = f.controller.stop("one");
      f.emit({ type: "ended", reason, error: null });
      expect(await finish).toEqual({ kind: "failed" });
      expect(f.draft().text).toBe("a good day");
      expect(f.controller.getSnapshot().notice?.kind).toBe(reason);
    },
  );

  it("downloads across a leave without opening the mic, refreshes, and auto dismisses downloaded", async () => {
    const f = runtime({ ...installed, available: true, model: "download" });
    await f.start();
    f.controller.leave("one");
    f.emit({ type: "downloading", progress: 0.42 });
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "downloading", progress: 0.42 });
    f.emit(completed);
    expect(f.port.start).not.toHaveBeenCalled();
    expect(f.port.download).toHaveBeenCalledTimes(1);
    expect(f.port.availability).toHaveBeenCalledTimes(2);
    expect(f.controller.getSnapshot().notice?.message).toBe(
      "English is ready. Use the mic to dictate.",
    );
    vi.advanceTimersByTime(5000);
    expect(f.controller.getSnapshot().notice).toBeNull();
  });

  it("enforces one owner and the ten minute limit from listening, then commits", async () => {
    const f = runtime();
    await f.start();
    f.controller.start({ ...f.target, owner: "two" });
    vi.advanceTimersByTime(600_000);
    expect(f.port.stop).not.toHaveBeenCalled();
    f.emit({ type: "listening" });
    f.emit(text(["good"]));
    vi.advanceTimersByTime(599_999);
    expect(f.port.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.port.stop).toHaveBeenCalledTimes(1);
    f.emit(completed);
    expect(f.draft().text).toBe("a good day");
    expect(f.controller.getSnapshot().notice?.kind).toBe("limit");
    f.controller.dismissNotice();
    expect(f.controller.getSnapshot().notice).toBeNull();
    expect(f.port.start).toHaveBeenCalledTimes(1);
  });

  it("gates unknown/unavailable availability and keeps denied microphones visible with Settings action", async () => {
    const f = runtime({ ...installed, available: true, microphone: "denied" });
    f.controller.start(f.target);
    expect(f.port.start).not.toHaveBeenCalled();
    await f.start();
    expect(f.controller.getSnapshot().availability?.available).toBe(true);
    expect(f.controller.getSnapshot().notice).toMatchObject({
      kind: "permission-denied",
      action: "open-settings",
    });
    f.controller.openMicrophoneSettings();
    expect(f.port.openMicrophoneSettings).toHaveBeenCalledTimes(1);
    vi.mocked(f.port.availability).mockResolvedValue({ available: false, reason: "restricted" });
    await f.controller.refresh();
    f.controller.start(f.target);
    expect(f.controller.getSnapshot().notice).toBeNull();
    expect(f.port.start).not.toHaveBeenCalled();
    const absent = new DictationController({ port: null, createId: () => "" });
    runtimes.push(absent);
    await absent.refresh();
    expect(absent.getSnapshot().availability).toEqual({ available: false, reason: "platform" });
  });

  it("disposes native work, listeners and timers", async () => {
    const f = runtime();
    await f.start();
    f.emit({ type: "listening" });
    f.controller.dispose();
    vi.advanceTimersByTime(600_000);
    expect(f.port.cancel).toHaveBeenCalledTimes(1);
    expect(f.port.stop).not.toHaveBeenCalled();
    expect(vi.mocked(f.port.subscribe).mock.results[0]?.value).toHaveBeenCalledTimes(1);
  });
  it("newer availability wins overlapping refreshes and unchanged answers preserve identity", async () => {
    const f = runtime();
    let first!: (value: DictationAvailability) => void;
    vi.mocked(f.port.availability).mockReturnValueOnce(
      new Promise((resolve) => {
        first = resolve;
      }),
    );
    const older = f.controller.refresh();
    vi.mocked(f.port.availability).mockResolvedValue({ available: false, reason: "language" });
    await f.controller.refresh();
    const snapshot = f.controller.getSnapshot();
    first(installed);
    await older;
    await f.controller.refresh();
    expect(f.controller.getSnapshot()).toBe(snapshot);
  });

  it("a rejected start terminates with a notice and a fresh session ignores its late rejection", async () => {
    const f = runtime();
    vi.mocked(f.port.start).mockRejectedValueOnce(new Error("offline"));
    await f.start();
    await Promise.resolve();
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: "idle",
      notice: { kind: "service-unavailable" },
    });
    expect(f.port.cancel).toHaveBeenCalledTimes(1);
    await f.start();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "starting", notice: null });
    f.controller.release("one");
    expect(f.target.commit).not.toHaveBeenCalled();
  });

  it("cancelled downloads abort waiters without producing a downloaded notice", async () => {
    const f = runtime({ ...installed, available: true, model: "download" });
    await f.start();
    const finish = f.controller.stop("one");
    f.emit(completed);
    expect(await finish).toEqual({ kind: "aborted" });
    expect(f.controller.getSnapshot().notice).toBeNull();
    expect(f.port.cancel).toHaveBeenCalledTimes(1);
  });

  it("scopes stop and cancel to their owner, so another composer's Send never sends these words", async () => {
    const f = runtime();
    await f.start();
    f.emit({ type: "listening" });
    f.emit(text(["private words"]));
    expect(await f.controller.stop("two")).toEqual({ kind: "idle" });
    f.controller.cancel("two");
    expect(f.port.stop).not.toHaveBeenCalled();
    expect(f.port.cancel).not.toHaveBeenCalled();
    const two = dictationView(f.controller.getSnapshot(), "two");
    expect(two).toMatchObject({ visible: true, blocked: true, phase: "idle", preview: null });
    const one = dictationView(f.controller.getSnapshot(), "one");
    expect(one).toMatchObject({ blocked: false, phase: "listening", languageName: "English" });
    expect(one.preview?.text).toBe("a private words day");
  });

  it("does not report the limit after a manual stop that finalizes past ten minutes", async () => {
    const f = runtime();
    await f.start();
    f.emit({ type: "listening" });
    f.emit(text(["good"]));
    vi.advanceTimersByTime(599_000);
    const finish = f.controller.stop("one");
    vi.advanceTimersByTime(5_000);
    expect(f.port.stop).toHaveBeenCalledTimes(1);
    f.emit(completed);
    expect(await finish).toEqual({ kind: "committed", text: "a good day" });
    expect(f.controller.getSnapshot().notice).toBeNull();
  });

  it("keeps a cut-short tentative tail, and promises kept words only when there were some", async () => {
    const f = runtime();
    await f.start();
    f.emit({ type: "listening" });
    f.emit(text([], ["still tentative"]));
    f.emit({ type: "ended", reason: "interrupted", error: null });
    expect(f.draft().text).toBe("a still tentative day");
    expect(f.controller.getSnapshot().notice?.message).toBe(
      "Dictation stopped. Your words so far are in the message.",
    );
    await f.start();
    f.emit({ type: "listening" });
    f.emit({ type: "ended", reason: "interrupted", error: null });
    expect(f.controller.getSnapshot().notice?.message).toBe("Dictation stopped.");
  });

  it("reports a Settings failure only on the notice that offered Settings", async () => {
    const f = runtime({ ...installed, microphone: "denied" });
    await f.controller.refresh();
    let reject!: (error: Error) => void;
    vi.mocked(f.port.openMicrophoneSettings).mockReturnValueOnce(
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
    );
    f.controller.start(f.target);
    f.controller.openMicrophoneSettings();
    f.controller.start({ ...f.target, owner: "two" });
    reject(new Error("no Settings"));
    await vi.runAllTimersAsync();
    expect(f.controller.getSnapshot().notice).toMatchObject({
      owner: "two",
      kind: "permission-denied",
    });
    vi.mocked(f.port.openMicrophoneSettings).mockImplementationOnce(() => {
      throw new Error("no bridge");
    });
    f.controller.openMicrophoneSettings();
    expect(f.controller.getSnapshot().notice).toMatchObject({
      owner: "two",
      kind: "service-unavailable",
    });
  });

  it("starts nothing new while disposing, even from a subscriber reacting to idle", async () => {
    const f = runtime();
    await f.start();
    f.controller.subscribe(() => {
      if (f.controller.getSnapshot().phase === "idle") f.controller.start(f.target);
    });
    f.controller.dispose();
    f.controller.dispose();
    expect(f.port.start).toHaveBeenCalledTimes(1);
    expect(f.port.cancel).toHaveBeenCalledTimes(1);
  });
});
