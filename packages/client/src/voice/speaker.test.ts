import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceSayMaxLength } from "@opensteer/protocol/voice";
import type { WaitingRequest } from "@opensteer/core";
import { VoiceSpeaker, voiceSpeakableText } from "./speaker.js";
import { voiceHost, voiceReply, voiceTestNow } from "./voice.test-support.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const fixture = voiceHost();
  const id = fixture.host.getSnapshot().homeThreadId!;
  const say = vi.fn(async (_text: string) => {});
  return {
    ...fixture,
    id,
    say,
    make: () =>
      new VoiceSpeaker({
        hostClient: fixture.host,
        baseline: fixture.host.getSnapshot(),
        startedAt: voiceTestNow,
        say,
      }),
  };
}

describe("VoiceSpeaker", () => {
  it("speaks only new durable replies, never settled streams, old history, input, or the start cut", () => {
    const f = setup();
    f.publish({
      transcripts: { [f.id]: [voiceReply("baseline", "already here", voiceTestNow + 1)] },
    });
    const speaker = f.make();
    const entries = [
      voiceReply("baseline"),
      voiceReply("old", "old", voiceTestNow - 1),
      voiceReply("cut", "cut", voiceTestNow),
      { ...voiceReply("stream:run"), streaming: false },
      { ...voiceReply("live"), streaming: true },
      { ...voiceReply("input"), messageKind: "input" as const },
      voiceReply("durable", "Hello"),
    ];
    f.publish({ transcripts: { [f.id]: entries } });
    expect(f.say).toHaveBeenCalledExactlyOnceWith("Hello");
    speaker.spoke();
    f.publish({ connection: "connecting", transcripts: {} });
    f.publish({ connection: "connected", transcripts: { [f.id]: entries } });
    expect(f.say).toHaveBeenCalledTimes(1);
    speaker.dispose();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.host.observeThread).toHaveBeenCalledExactlyOnceWith(f.id);
    expect(f.listeners.size).toBe(0);
    f.host.dispose();
  });

  it("keeps the latest two waiting speeches and advances only on spoke or its bounded fallback", async () => {
    const f = setup();
    const speaker = f.make();
    f.publish({ transcripts: { [f.id]: [voiceReply("one")] } });
    f.publish({
      transcripts: {
        [f.id]: [voiceReply("one"), voiceReply("two"), voiceReply("three"), voiceReply("four")],
      },
    });
    expect(f.say.mock.calls).toEqual([["one"]]);
    speaker.spoke();
    expect(f.say.mock.calls).toEqual([["one"], ["three"]]);
    await vi.advanceTimersByTimeAsync(15_000 + "three".length * 80);
    expect(f.say.mock.calls).toEqual([["one"], ["three"], ["four"]]);
    speaker.dispose();
    f.host.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("baselines Requests and rechecks queued Requests without reading their payload", () => {
    const f = setup();
    const request = (id: string) =>
      ({
        request: {
          id,
          status: "pending",
          originatingThreadId: f.id,
          payload: { secret: "never spoken" },
        },
        assignments: [],
      }) as unknown as WaitingRequest;
    f.publish({ waitingRequests: [request("existing")] });
    const speaker = f.make();
    f.publish({ transcripts: { [f.id]: [voiceReply("one")] } });
    f.publish({ waitingRequests: [request("existing"), request("resolved"), request("new")] });
    f.publish({ waitingRequests: [request("existing"), request("new")] });
    speaker.spoke();
    expect(f.say.mock.calls).toEqual([["one"], ["Chat needs you."]]);
    speaker.spoke();
    f.publish({ waitingRequests: [request("new")] });
    expect(f.say).toHaveBeenCalledTimes(2);
    speaker.dispose();
    f.host.dispose();
  });
});

it("converts Markdown and caps speech at the wire limit", () => {
  expect(
    voiceSpeakableText(
      "# Hello **there**\n- [A link](https://example.test)\n1. `inline`\n```ts\nsecret();\n```\n> Last _line_.",
    ),
  ).toBe("Hello there A link inline (code omitted) Last line.");
  expect(voiceSpeakableText("x".repeat(voiceSayMaxLength + 1))).toHaveLength(voiceSayMaxLength);
});
