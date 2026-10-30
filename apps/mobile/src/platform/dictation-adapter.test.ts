import { describe, expect, it, vi } from "vitest";
import { DictationController } from "@opensteer/client/dictation";
import { createDictationPort, type NativeDictation } from "./dictation-adapter.js";
import { dictationPort } from "./dictation.js";
const id = "00000000-0000-4000-8000-000000000001";
function bridge() {
  let receive: ((input: unknown) => void) | undefined;
  const native: NativeDictation = {
    availability: async () =>
      JSON.stringify({
        available: true,
        locale: "en-US",
        languageName: "English",
        model: "installed",
        microphone: "granted",
      }),
    start: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    openMicrophoneSettings: vi.fn(async () => undefined),
    addListener: (_, listener) => {
      receive = listener;
      return {
        remove: () => {
          receive = undefined;
        },
      };
    },
  };
  const port = createDictationPort(native);
  return {
    native,
    port,
    emit: (input: unknown) => receive?.(input),
    event: (payload: object) => receive?.({ json: JSON.stringify({ session: id, ...payload }) }),
  };
}
describe("mobile dictation boundary", () => {
  it("has no native port on Android or other unsupported platforms", () =>
    expect(dictationPort).toBeNull());
  it("rejects malformed availability without trusting native data", async () => {
    const b = bridge();
    b.native.availability = async () => '{"available":true}';
    await expect(b.port.availability()).rejects.toThrow();
  });
  it.each([
    { json: "{" },
    { json: JSON.stringify({ session: id, seq: 3, type: "level", level: 2 }) },
    null,
  ])("terminates malformed input once, cancels and keeps received words", async (bad) => {
    const b = bridge();
    let text = "";
    const controller = new DictationController({ port: b.port, createId: () => id });
    await controller.refresh();
    controller.start({
      owner: "one",
      read: () => ({ text, selection: { start: 0, end: 0 } }),
      commit: (next) => {
        text = next;
      },
    });
    b.event({ seq: 1, type: "listening" });
    b.event({ seq: 2, type: "text", finalized: [], volatile: ["hello"] });
    const finish = controller.stop();
    b.emit(bad);
    b.emit(bad);
    await expect(finish).resolves.toEqual({ kind: "failed" });
    expect(text).toBe("hello");
    await vi.waitFor(() => expect(b.native.cancel).toHaveBeenCalledOnce());
    expect(controller.getSnapshot().notice?.kind).toBe("service-unavailable");
    controller.dispose();
  });
  it("accepts start before sending an immediate cancel to Swift", async () => {
    const b = bridge();
    let acknowledge!: () => void;
    b.native.start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const started = b.port.start(id);
    const cancelled = b.port.cancel(id);
    await Promise.resolve();
    expect(b.native.start).toHaveBeenCalledWith(id);
    expect(b.native.cancel).not.toHaveBeenCalled();
    acknowledge();
    await Promise.all([started, cancelled]);
    expect(b.native.cancel).toHaveBeenCalledWith(id);
  });
  it("retains delivered tentative words if the iOS background task expires", async () => {
    const b = bridge();
    let text = "";
    const controller = new DictationController({ port: b.port, createId: () => id });
    await controller.refresh();
    controller.start({
      owner: "one",
      read: () => ({ text, selection: { start: 0, end: 0 } }),
      commit: (next) => {
        text = next;
      },
    });
    b.event({ seq: 1, type: "text", finalized: [], volatile: ["last words"] });
    b.event({ seq: 2, type: "ended", reason: "interrupted", error: null });
    expect(text).toBe("last words");
    controller.dispose();
  });
});
