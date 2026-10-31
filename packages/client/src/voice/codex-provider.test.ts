import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostApiClient } from "@opensteer/protocol";
import { voiceRenewIntervalMs } from "@opensteer/protocol/voice";
import type { VoiceCallEvent, VoiceMediaPort } from "./contract.js";
import { createCodexVoiceProvider } from "./codex-provider.js";
import { voiceTestId } from "./voice.test-support.js";

class FakePeer extends EventTarget {
  iceGatheringState = "complete";
  connectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  channel = {
    onmessage: null as ((event: { data: string }) => void) | null,
    send: vi.fn(),
    close: vi.fn(),
  };
  addTransceiver = vi.fn();
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({
    type: "offer",
    sdp: "offer",
  }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
  });
  setRemoteDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {});
  close = vi.fn(() => {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  });
  getStats = vi.fn(
    async () =>
      new Map([
        ["input", { type: "media-source", kind: "audio", audioLevel: 0.4 }],
        ["output", { type: "inbound-rtp", kind: "audio", audioLevel: 2 }],
        ["video", { type: "inbound-rtp", kind: "video", audioLevel: 1 }],
      ]),
  );
  receive(data: unknown) {
    this.channel.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(agent = false) {
  const peer = new FakePeer();
  const track = { enabled: true, stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const stopPlayback = vi.fn();
  const media: VoiceMediaPort = {
    getUserMedia: vi.fn(async () => stream),
    releaseStream: vi.fn((released: MediaStream) => {
      for (const each of released.getTracks()) each.stop();
    }),
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    unavailableReason: () => null,
    playRemote: vi.fn(() => stopPlayback),
  };
  const rpc = {
    "voice.start": vi.fn<HostApiClient["voice.start"]>(async () => ({
      ok: true,
      data: { answer: "answer" },
    })),
    "voice.renew": vi.fn<HostApiClient["voice.renew"]>(async () => ({ ok: true, data: {} })),
    "voice.say": vi.fn<HostApiClient["voice.say"]>(async () => ({ ok: true, data: {} })),
    "voice.stop": vi.fn<HostApiClient["voice.stop"]>(async () => ({ ok: true, data: {} })),
  };
  const events: VoiceCallEvent[] = [];
  const abort = new AbortController();
  const provider = createCodexVoiceProvider({
    media,
    rpc,
    agent,
    environmentId: "environment",
    harnessInstanceId: "account",
    createId: () => voiceTestId,
  });
  return {
    peer,
    track,
    stream,
    stopPlayback,
    media,
    rpc,
    agent,
    events,
    abort,
    open: () => provider.open({ signal: abort.signal, onEvent: (event) => events.push(event) }),
  };
}

function refusal(reason: string) {
  return {
    ok: false as const,
    error: { code: "conflict" as const, message: "Refused", reason, retryable: false },
  };
}

describe("Codex voice provider", () => {
  it("negotiates sendrecv audio, plays remote audio, receives V3, meters, mutes, renews and closes without any channel writes", async () => {
    const f = setup();
    const call = await f.open();
    expect(f.media.getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(f.peer.addTransceiver).toHaveBeenCalledWith(f.track, {
      direction: "sendrecv",
      streams: [f.stream],
    });
    expect(f.peer.createDataChannel).toHaveBeenCalledWith("oai-events", { ordered: true });
    expect(f.rpc["voice.start"]).toHaveBeenCalledWith(
      {
        sessionId: voiceTestId,
        environmentId: "environment",
        harnessInstanceId: "account",
        offer: "offer",
      },
      { signal: f.abort.signal },
    );
    expect(f.peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "answer" });
    f.peer.ontrack?.({ streams: [f.stream] });
    expect(f.media.playRemote).toHaveBeenCalledWith(f.stream);
    f.peer.receive("not-json");
    f.peer.receive({ type: "delegation.created", item: { content: [] } });
    f.peer.receive({ type: "input_transcript.added", item: { text: 42 } });
    f.peer.receive({ type: "turn.created", turn: { role: "user" } });
    f.peer.receive({ type: "input_transcript.added", item: { text: "Show", future: true } });
    f.peer.receive({ type: "input_transcript.added", item: { text: " Gmail" } });
    f.peer.receive({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "Show Gmail" },
    });
    f.peer.receive({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "Show Gmail" },
    });
    f.peer.receive({ type: "turn.created", turn: { role: "assistant" } });
    f.peer.receive({ type: "output_transcript.added", item: { text: "Sure" } });
    f.peer.receive({ type: "output_transcript.added", item: { text: ", checking" } });
    f.peer.receive({ type: "turn.done", turn: { role: "assistant" } });
    f.peer.receive({ type: "input_transcript.added", item: { text: "Next" } });
    f.peer.receive({ type: "turn.done", turn: { role: "user" } });
    expect(f.events).toEqual([
      { type: "hearing", text: "Show" },
      { type: "hearing", text: "Show Gmail" },
      { type: "heard", text: "Show Gmail", turnId: "turn:1" },
      { type: "speaking", text: "Sure" },
      { type: "speaking", text: "Sure, checking" },
      { type: "spoke" },
      { type: "hearing", text: "Next" },
      { type: "heard", text: "Next", turnId: "turn:2" },
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.events.at(-1)).toEqual({ type: "level", input: 0.4, output: 1 });
    call.setMuted(true);
    expect(f.track.enabled).toBe(false);
    call.setMuted(false);
    expect(f.track.enabled).toBe(true);
    await call.say("Hello");
    expect(f.rpc["voice.say"]).toHaveBeenCalledWith({
      environmentId: "environment",
      harnessInstanceId: "account",
      sessionId: voiceTestId,
      text: "Hello",
    });
    await vi.advanceTimersByTimeAsync(voiceRenewIntervalMs - 100);
    expect(f.rpc["voice.renew"]).toHaveBeenCalledTimes(1);
    await call.close();
    await call.close();
    expect(f.peer.close).toHaveBeenCalledTimes(1);
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.stopPlayback).toHaveBeenCalledTimes(1);
    expect(f.rpc["voice.stop"]).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)).toEqual({ type: "closed", reason: "stopped" });
    expect(f.peer.channel.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends the gathered offer only after ICE completes or its three-second cap", async () => {
    const f = setup();
    f.peer.iceGatheringState = "gathering";
    const opening = f.open();
    await vi.waitFor(
      () => expect(f.peer.setLocalDescription, "local offer was never set").toHaveBeenCalled(),
      { timeout: 100 },
    );
    expect(f.rpc["voice.start"]).not.toHaveBeenCalled();
    f.peer.localDescription = { type: "offer", sdp: "with candidates" };
    await vi.advanceTimersByTimeAsync(3_000);
    const call = await opening;
    expect(f.rpc["voice.start"].mock.calls[0]?.[0].offer).toBe("with candidates");
    await call.close();

    const g = setup();
    g.peer.iceGatheringState = "gathering";
    const second = g.open();
    await vi.waitFor(
      () => expect(g.peer.setLocalDescription, "second offer was never set").toHaveBeenCalled(),
      { timeout: 100 },
    );
    g.peer.iceGatheringState = "complete";
    g.peer.dispatchEvent(new Event("icegatheringstatechange"));
    await (await second).close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["voice-runner-unsupported", "update-computer"],
    ["voice-engine-unsupported", "update-codex"],
    ["voice-account-unavailable", "no-account"],
    ["voice-refused", "refused"],
    ["other", "connection-failed"],
  ])("maps %s to %s and releases the microphone", async (reason, failure) => {
    const f = setup();
    f.rpc["voice.start"].mockResolvedValue(refusal(reason));
    await expect(f.open()).rejects.toMatchObject({ failure });
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.peer.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["NotAllowedError", "permission-denied"],
    ["NotFoundError", "microphone-unavailable"],
    ["NotReadableError", "microphone-unavailable"],
  ])("maps microphone %s", async (name, failure) => {
    const f = setup();
    vi.mocked(f.media.getUserMedia).mockRejectedValue(Object.assign(new Error(), { name }));
    await expect(f.open()).rejects.toMatchObject({ failure });
    expect(f.rpc["voice.start"]).not.toHaveBeenCalled();
  });

  it("checks platform availability before asking for permission", async () => {
    const f = setup();
    f.media.unavailableReason = () => "insecure-context";
    await expect(f.open()).rejects.toMatchObject({ failure: "insecure-context" });
    expect(f.media.getUserMedia).not.toHaveBeenCalled();
  });

  it("cancels a pending start immediately and stops a late admission with the same sessionId", async () => {
    const f = setup();
    let admit!: (result: Awaited<ReturnType<HostApiClient["voice.start"]>>) => void;
    f.rpc["voice.start"].mockImplementation(
      () =>
        new Promise((resolve) => {
          admit = resolve;
        }),
    );
    const opening = f.open();
    const rejected = expect(opening).rejects.toMatchObject({ failure: "connection-failed" });
    await vi.waitFor(
      () => expect(f.rpc["voice.start"], "start was never submitted").toHaveBeenCalled(),
      { timeout: 100 },
    );
    f.abort.abort();
    await rejected;
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.rpc["voice.stop"]).toHaveBeenCalledWith({
      sessionId: voiceTestId,
      environmentId: "environment",
      harnessInstanceId: "account",
    });
    admit({ ok: true, data: { answer: "late" } });
    await opening.catch(() => {});
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.rpc["voice.stop"]).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a microphone granted after cancellation", async () => {
    const f = setup();
    let grant!: (stream: MediaStream) => void;
    vi.mocked(f.media.getUserMedia).mockImplementation(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const opening = f.open();
    const rejected = expect(opening).rejects.toMatchObject({ failure: "connection-failed" });
    f.abort.abort();
    await rejected;
    grant(f.stream);
    await Promise.resolve();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.rpc["voice.start"]).not.toHaveBeenCalled();
  });

  it("keeps one caption per turn when V3 sends a turn's words before announcing it", async () => {
    const f = setup();
    const call = await f.open();
    // The order the live backend uses: words, then the turn that holds them.
    f.peer.receive({ type: "turn.created", turn: { role: "user", transcript: "What is" } });
    f.peer.receive({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "What is two plus two?" },
    });
    f.peer.receive({ type: "output_transcript.added", item: { text: " Yep," } });
    f.peer.receive({
      type: "turn.created",
      turn: { id: "a1", role: "assistant", transcript: " Yep," },
    });
    f.peer.receive({ type: "output_transcript.added", item: { text: " still four." } });
    f.peer.receive({
      type: "turn.done",
      turn: { id: "a1", role: "assistant", transcript: " Yep, still four." },
    });
    expect(f.events.filter((event) => event.type !== "level")).toEqual([
      { type: "hearing", text: "What is" },
      { type: "heard", text: "What is two plus two?", turnId: "turn:1" },
      { type: "speaking", text: "Yep," },
      { type: "speaking", text: "Yep," },
      { type: "speaking", text: "Yep, still four." },
      { type: "speaking", text: "Yep, still four." },
      { type: "spoke" },
    ]);
    await call.close();
  });

  it.each(["failed", "closed"])("ends exactly once on peer %s", async (state) => {
    const f = setup();
    const call = await f.open();
    f.peer.connectionState = state;
    f.peer.onconnectionstatechange?.();
    await call.close();
    expect(f.events).toEqual([{ type: "closed", reason: "connection-lost" }]);
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes on renewal refusal and ignores any later speech or meter callback", async () => {
    const f = setup();
    f.rpc["voice.renew"].mockResolvedValue(refusal("voice-ended"));
    const call = await f.open();
    await vi.advanceTimersByTimeAsync(voiceRenewIntervalMs);
    expect(f.events.at(-1)).toEqual({ type: "closed", reason: "replaced" });
    const count = f.events.length;
    f.peer.receive({ type: "turn.done", turn: { role: "user", transcript: "late" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.events).toHaveLength(count);
    await expect(call.say("late")).rejects.toMatchObject({ failure: "connection-failed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports expiry when renewal finds the call ended after a full missed lease", async () => {
    const f = setup();
    f.rpc["voice.renew"]
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(refusal("voice-ended"));
    await f.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.events.at(-1)).toEqual({ type: "closed", reason: "expired" });
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels while gathering ICE and clears the listener and deadline", async () => {
    const f = setup();
    f.peer.iceGatheringState = "gathering";
    const opening = f.open();
    const rejected = expect(opening).rejects.toMatchObject({ failure: "connection-failed" });
    await vi.waitFor(
      () => expect(f.peer.setLocalDescription, "offer was never set").toHaveBeenCalled(),
      { timeout: 100 },
    );
    f.abort.abort();
    await rejected;
    expect(f.rpc["voice.stop"]).toHaveBeenCalledWith({
      sessionId: voiceTestId,
      environmentId: "environment",
      harnessInstanceId: "account",
    });
    expect(f.rpc["voice.start"]).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up even if a native release throws, and rejects speech on a refused call", async () => {
    const f = setup();
    const call = await f.open();
    f.peer.ontrack?.({ streams: [f.stream] });
    f.peer.close.mockImplementation(() => {
      throw new Error("native close failed");
    });
    f.rpc["voice.say"].mockResolvedValue(refusal("voice-ended"));
    await expect(call.say("hello")).rejects.toMatchObject({ failure: "connection-failed" });
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.stopPlayback).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)).toEqual({ type: "closed", reason: "replaced" });
    await call.close();
    expect(f.rpc["voice.stop"]).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it.each([false, true])("negotiates agent support only when advertised (%s)", async (advertised) => {
  const f = setup(advertised);
  f.rpc["voice.start"].mockResolvedValue({
    ok: true,
    data: { answer: "answer", agent: advertised },
  });
  const call = await f.open();
  const sent = f.rpc["voice.start"].mock.calls[0]![0];
  expect("agent" in sent).toBe(advertised);
  expect(call.agent).toBe(advertised);
  await call.close();
});
it("falls back when the Runner does not accept agent mode", async () => {
  const f = setup(true);
  const call = await f.open();
  expect(call.agent).toBe(false);
  await call.close();
});
