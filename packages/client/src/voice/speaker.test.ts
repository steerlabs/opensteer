import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceSayMaxLength } from "@opensteer/protocol/voice";
import type { RunEntry } from "../host/client.js";
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
        say,
      }),
  };
}

describe("VoiceSpeaker", () => {
  it("speaks only replies newer than Chat's newest message at start, never settled streams, history or input", () => {
    const f = setup();
    f.publish({
      transcripts: { [f.id]: [voiceReply("baseline", "already here", voiceTestNow + 1)] },
    });
    const speaker = f.make();
    const entries = [
      voiceReply("baseline"),
      voiceReply("old", "old", voiceTestNow - 1),
      voiceReply("cut", "cut", voiceTestNow + 1),
      { ...voiceReply("stream:run", "s", voiceTestNow + 2), streaming: false },
      { ...voiceReply("live", "l", voiceTestNow + 2), streaming: true },
      { ...voiceReply("input", "i", voiceTestNow + 2), messageKind: "input" as const },
      voiceReply("durable", "Hello", voiceTestNow + 2),
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
    speaker.speaking();
    speaker.spoke();
    expect(f.say.mock.calls).toEqual([["one"], ["three"]]);
    await vi.advanceTimersByTimeAsync(15_000 + "three".length * 80);
    expect(f.say.mock.calls).toEqual([["one"], ["three"], ["four"]]);
    speaker.dispose();
    f.host.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits out the voice's own acknowledgement and is not finished by it", () => {
    const f = setup();
    const speaker = f.make();
    speaker.speaking();
    f.publish({ transcripts: { [f.id]: [voiceReply("one"), voiceReply("two")] } });
    expect(f.say).not.toHaveBeenCalled();
    speaker.spoke();
    expect(f.say.mock.calls).toEqual([["one"]]);
    // An acknowledgement that began before the relay ends without finishing it.
    speaker.spoke();
    expect(f.say.mock.calls).toEqual([["one"]]);
    speaker.speaking();
    speaker.spoke();
    expect(f.say.mock.calls).toEqual([["one"], ["two"]]);
    speaker.dispose();
    f.host.dispose();
  });

  it.each([
    ["ahead of", -3_600_000],
    ["behind", 3_600_000],
  ])("judges new replies in the Host's clock when this device runs %s it", (_, skew) => {
    const f = setup();
    const host = voiceTestNow + skew;
    f.publish({ transcripts: { [f.id]: [voiceReply("history", "history", host)] } });
    const speaker = f.make();
    f.publish({
      transcripts: {
        [f.id]: [
          voiceReply("older", "older", host - 60_000),
          voiceReply("history", "history", host),
          voiceReply("new", "New reply", host + 500),
        ],
      },
    });
    expect(f.say.mock.calls).toEqual([["New reply"]]);
    speaker.dispose();
    f.host.dispose();
  });

  it("uses run-only history to keep older replies silent while speaking new replies", () => {
    const f = setup();
    const run: RunEntry = {
      createdAt: new Date(voiceTestNow).toISOString(),
      id: "run:history",
      kind: "run",
      error: null,
      replyMessageId: null,
      runId: "history",
      status: "running",
    };
    const history = [
      run,
      { ...run, id: "run:older", createdAt: new Date(voiceTestNow - 1_000).toISOString() },
      { ...run, id: "run:invalid", createdAt: "invalid" },
    ];
    f.publish({ transcripts: { [f.id]: history } });
    const speaker = f.make();
    const older = voiceReply("older", "Old private reply", voiceTestNow - 1);
    f.publish({ transcripts: { [f.id]: [older, ...history] } });
    expect(f.say).not.toHaveBeenCalled();
    f.publish({
      transcripts: {
        [f.id]: [older, ...history, voiceReply("new", "New reply", voiceTestNow + 1)],
      },
    });
    expect(f.say.mock.calls).toEqual([["New reply"]]);
    speaker.dispose();
    f.host.dispose();
  });

  it("treats Chat history that loads after the call began as history", () => {
    const f = setup();
    const { [f.id]: _loaded, ...unloaded } = f.host.getSnapshot().transcriptWindows;
    f.publish({ transcriptWindows: unloaded, transcripts: {} });
    const speaker = f.make();
    const yesterday = voiceTestNow - 86_400_000;
    const window = { threadId: f.id, byteCount: 0, hasMore: false, itemCount: 1, nextBefore: null };
    f.publish({
      transcriptWindows: { ...unloaded, [f.id]: { ...window, totalItems: 1 } },
      transcripts: { [f.id]: [voiceReply("old", "Old private reply", yesterday)] },
    });
    expect(f.say).not.toHaveBeenCalled();
    f.publish({
      transcripts: {
        [f.id]: [
          voiceReply("old", "Old private reply", yesterday),
          voiceReply("new", "New reply", yesterday + 1_000),
        ],
      },
    });
    expect(f.say.mock.calls).toEqual([["New reply"]]);
    speaker.dispose();
    f.host.dispose();
  });

  it("speaks every reply in a Chat that voice creates during the call", () => {
    const f = voiceHost("absent");
    const say = vi.fn(async (_text: string) => {});
    const speaker = new VoiceSpeaker({ hostClient: f.host, baseline: f.host.getSnapshot(), say });
    const window = {
      threadId: "chat",
      byteCount: 0,
      hasMore: false,
      itemCount: 1,
      nextBefore: null,
    };
    f.publish({
      homeThreadId: "chat",
      transcriptWindows: { chat: { ...window, totalItems: 1 } },
      transcripts: { chat: [voiceReply("first", "Four.", voiceTestNow - 86_400_000)] },
    });
    expect(say.mock.calls).toEqual([["Four."]]);
    speaker.dispose();
    f.host.dispose();
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
    speaker.speaking();
    speaker.spoke();
    expect(f.say.mock.calls).toEqual([["one"], ["Chat needs you."]]);
    speaker.speaking();
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
