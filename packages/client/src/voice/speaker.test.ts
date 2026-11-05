import { createId } from "@opensteer/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceStartError } from "./contract.js";
import { VoiceSpeaker } from "./speaker.js";
import { settle, voiceHost, voiceTestNow } from "./voice.test-support.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(voiceTestNow);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const waiting = (id: string, originatingThreadId: string, status = "pending") => ({
  assignments: [],
  request: { id, originatingThreadId, status },
});

function setup(say = vi.fn(async (_id: string, _text: string) => {})) {
  const f = voiceHost();
  const callThreadId = createId("thread");
  const onError = vi.fn();
  const speaker = new VoiceSpeaker({
    baseline: f.host.getSnapshot(),
    callThreadId,
    hostClient: f.host,
    onError,
    say,
  });
  return { ...f, callThreadId, onError, say, speaker };
}

describe("VoiceSpeaker", () => {
  it("announces a task's new Request by title once, and leaves the agent's own to it", async () => {
    const f = setup();
    const task = createId("thread");
    f.publish({
      waitingRequests: [waiting("own", f.callThreadId), waiting("task", task)] as never,
    });
    await settle();
    f.publish({
      waitingRequests: [waiting("own", f.callThreadId), waiting("task", task)] as never,
    });
    await settle();
    expect(f.say).toHaveBeenCalledExactlyOnceWith("request:task", "A task needs you.");
    f.speaker.dispose();
    f.host.dispose();
  });

  it("drops a Request answered before its turn to be said", async () => {
    let finish!: () => void;
    const say = vi.fn(
      (_id: string, _text: string) => new Promise<void>((resolve) => (finish = resolve)),
    );
    const f = setup(say);
    const task = createId("thread");
    f.publish({ waitingRequests: [waiting("first", task), waiting("second", task)] as never });
    f.publish({ waitingRequests: [waiting("first", task)] as never });
    finish();
    await settle();
    expect(say).toHaveBeenCalledExactlyOnceWith("request:first", "A task needs you.");
    f.speaker.dispose();
    f.host.dispose();
  });

  it("sends an unknown outcome again under the same id, and stops on a refusal", async () => {
    const say = vi
      .fn<(id: string, text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("unknown"))
      .mockRejectedValueOnce(new VoiceStartError("refused"));
    const f = setup(say);
    f.publish({ waitingRequests: [waiting("task", createId("thread"))] as never });
    await vi.advanceTimersByTimeAsync(300);
    expect(say.mock.calls.map(([id]) => id)).toEqual(["request:task", "request:task"]);
    expect(f.onError).toHaveBeenCalledTimes(1);
    f.speaker.dispose();
    f.host.dispose();
  });
});
