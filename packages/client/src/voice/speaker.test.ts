import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceSayMaxLength } from "@opensteer/protocol/voice";
import type { RunEntry, ToolEntry } from "../host/client.js";
import type { WaitingRequest } from "@opensteer/core";
import { VoiceStartError } from "./contract.js";
import { VoiceSpeaker, voiceSpeakableText } from "./speaker.js";
import { settle, voiceHost, voiceReply, voiceTestNow } from "./voice.test-support.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const fixture = voiceHost();
  const id = fixture.host.getSnapshot().homeThreadId!;
  const say = vi.fn(async (_id: string, _text: string) => {});
  return {
    ...fixture,
    id,
    say,
    /** What reached the call, as `[id, text]`. */
    said: () => say.mock.calls,
    make: () =>
      new VoiceSpeaker({
        hostClient: fixture.host,
        baseline: fixture.host.getSnapshot(),
        callThreadId,
        say,
      }),
  };
}

const callThreadId = "thread_call";

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
    expect(f.say).toHaveBeenCalledExactlyOnceWith("message:durable", "Hello");
    f.publish({ connection: "connecting", transcripts: {} });
    f.publish({ connection: "connected", transcripts: { [f.id]: entries } });
    expect(f.say).toHaveBeenCalledTimes(1);
    speaker.dispose();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.host.observeThread).toHaveBeenCalledExactlyOnceWith(f.id);
    expect(f.listeners.size).toBe(0);
    f.host.dispose();
  });

  it("forwards every new reply once, in order, one at a time, dropping none", async () => {
    const f = setup();
    const accepted: (() => void)[] = [];
    f.say.mockImplementation(() => new Promise<void>((resolve) => accepted.push(resolve)));
    const speaker = f.make();
    f.publish({ transcripts: { [f.id]: [voiceReply("one")] } });
    f.publish({
      transcripts: {
        [f.id]: [voiceReply("one"), voiceReply("two"), voiceReply("three"), voiceReply("four")],
      },
    });
    // The next goes only once the call accepted the one before it.
    expect(f.said()).toEqual([["message:one", "one"]]);
    for (const _ of ["two", "three", "four"]) {
      accepted.shift()!();
      await settle();
    }
    expect(f.said()).toEqual([
      ["message:one", "one"],
      ["message:two", "two"],
      ["message:three", "three"],
      ["message:four", "four"],
    ]);
    accepted.shift()!();
    // Republishing the same replies, as a reconnect does, forwards nothing again.
    f.publish({ transcripts: { [f.id]: [voiceReply("one"), voiceReply("four")] } });
    await settle();
    expect(f.say).toHaveBeenCalledTimes(4);
    speaker.dispose();
    f.host.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends an unknown outcome again under the same id, and stops on a refusal", async () => {
    const f = setup();
    const onError = vi.fn();
    f.say.mockRejectedValueOnce(new TypeError("offline"));
    const speaker = new VoiceSpeaker({
      hostClient: f.host,
      baseline: f.host.getSnapshot(),
      callThreadId,
      say: f.say,
      onError,
    });
    f.publish({ transcripts: { [f.id]: [voiceReply("one"), voiceReply("two")] } });
    await settle();
    expect(f.said()).toEqual([["message:one", "one"]]);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.said()).toEqual([
      ["message:one", "one"],
      ["message:one", "one"],
      ["message:two", "two"],
    ]);
    f.say.mockRejectedValueOnce(new VoiceStartError("connection-failed"));
    f.publish({
      transcripts: { [f.id]: [voiceReply("one"), voiceReply("two"), voiceReply("three")] },
    });
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.say).toHaveBeenCalledTimes(4);
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
    expect(f.said()).toEqual([["message:new", "New reply"]]);
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
      // A live stream is stamped by this device, whose clock runs an hour ahead.
      {
        completedAt: null,
        createdAt: new Date(voiceTestNow + 3_600_000).toISOString(),
        id: "reasoning:history:block",
        kind: "reasoning" as const,
        runId: "history",
        state: "streaming" as const,
        text: "Thinking",
      },
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
    expect(f.said()).toEqual([["message:new", "New reply"]]);
    speaker.dispose();
    f.host.dispose();
  });

  it("keeps older replies silent behind a history page of only settled tool activity", () => {
    const f = setup();
    // Drawn live on a device an hour ahead, settled by the Host's completion.
    const tool: ToolEntry = {
      arguments: {},
      callId: "call",
      completedAt: new Date(voiceTestNow).toISOString(),
      createdAt: new Date(voiceTestNow + 3_600_000).toISOString(),
      id: "tool:history:call",
      integration: null,
      isError: false,
      kind: "tool",
      output: undefined,
      runId: "history",
      state: "done",
      streamText: "",
      tool: null,
    };
    f.publish({ transcripts: { [f.id]: [tool] } });
    const speaker = f.make();
    const older = voiceReply("older", "Old private reply", voiceTestNow - 1);
    f.publish({ transcripts: { [f.id]: [older, tool] } });
    expect(f.say).not.toHaveBeenCalled();
    f.publish({
      transcripts: { [f.id]: [older, tool, voiceReply("new", "New reply", voiceTestNow + 1)] },
    });
    expect(f.said()).toEqual([["message:new", "New reply"]]);
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
    expect(f.said()).toEqual([["message:new", "New reply"]]);
    speaker.dispose();
    f.host.dispose();
  });

  it("speaks every reply in a Chat that voice creates during the call", () => {
    const f = voiceHost("absent");
    const say = vi.fn(async (_id: string, _text: string) => {});
    const speaker = new VoiceSpeaker({
      hostClient: f.host,
      baseline: f.host.getSnapshot(),
      callThreadId,
      say,
    });
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
    expect(say.mock.calls).toEqual([["message:first", "Four."]]);
    speaker.dispose();
    f.host.dispose();
  });

  it("announces new Requests by title only, once each, and skips one answered first", async () => {
    const f = setup();
    const request = (id: string, originatingThreadId = f.id) =>
      ({
        request: {
          id,
          status: "pending",
          originatingThreadId,
          payload: { secret: "never spoken" },
        },
        assignments: [],
      }) as unknown as WaitingRequest;
    f.publish({ waitingRequests: [request("existing")] });
    const accepted: (() => void)[] = [];
    f.say.mockImplementation(() => new Promise<void>((resolve) => accepted.push(resolve)));
    const speaker = f.make();
    f.publish({ transcripts: { [f.id]: [voiceReply("one")] } });
    f.publish({
      waitingRequests: [
        request("existing"),
        request("resolved"),
        request("new"),
        request("mine", callThreadId),
      ],
    });
    f.publish({
      waitingRequests: [request("existing"), request("new"), request("mine", callThreadId)],
    });
    for (let index = 0; index < 3; index += 1) {
      accepted.shift()?.();
      await settle();
    }
    expect(f.said()).toEqual([
      ["message:one", "one"],
      ["request:new", "Chat needs you."],
      ["request:mine", "Check your screen, I need your OK."],
    ]);
    f.publish({ waitingRequests: [request("new")] });
    await settle();
    expect(f.say).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(f.said())).not.toContain("never spoken");
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
