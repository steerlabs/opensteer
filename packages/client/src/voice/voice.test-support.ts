import { vi } from "vitest";
import { MockHostClient } from "../mock/index.js";
import type { HostSnapshot, MessageEntry } from "../host/client.js";
import type { VoiceCallEvent, VoiceMediaPort, VoiceProvider } from "./contract.js";

export const voiceTestId = "12345678-1234-4123-8123-123456789abc";
export const voiceTestNow = Date.parse("2026-10-30T12:00:00.000Z");

/** Mock domain commands stay real; tests can publish snapshots without starting its timed engines. */
export function voiceHost(initialHome: "seeded" | "absent" = "seeded") {
  const host = new MockHostClient({
    latencyMs: 0,
    places: "absent",
    initialHome,
    now: () => new Date(voiceTestNow),
  });
  const original = host.getSnapshot;
  let snapshot: HostSnapshot = { ...original(), voiceAvailable: true };
  const listeners = new Set<() => void>();
  vi.spyOn(host, "getSnapshot").mockImplementation(() => snapshot);
  host.subscribe(() => {
    snapshot = { ...original(), voiceAvailable: true };
    for (const listener of listeners) listener();
  });
  vi.spyOn(host, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const release = vi.fn<() => void>();
  vi.spyOn(host, "observeThread").mockReturnValue(release);
  return {
    host,
    release,
    listeners,
    publish(patch: Partial<HostSnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
    sync() {
      this.publish({ ...original(), voiceAvailable: true });
    },
  };
}

export function voiceReply(id: string, body = id, createdAt = voiceTestNow + 1): MessageEntry {
  return {
    id,
    body,
    createdAt: new Date(createdAt).toISOString(),
    kind: "message",
    messageKind: "assistant",
    runId: "run:reply",
    author: { kind: "platform", cause: "assistant-message" },
  };
}

export function semanticVoice() {
  let event: (event: VoiceCallEvent) => void = () => {};
  let signal: AbortSignal | null = null;
  const call = {
    say: vi.fn(async (_text: string) => {}),
    setMuted: vi.fn<(muted: boolean) => void>(),
    close: vi.fn(async () => {}),
  };
  const provider: VoiceProvider = {
    open: vi.fn(async (input) => {
      event = input.onEvent;
      signal = input.signal;
      return call;
    }),
  };
  const media: VoiceMediaPort = {
    unavailableReason: () => null,
    getUserMedia: vi.fn(),
    createPeerConnection: vi.fn(),
    playRemote: vi.fn(),
    keepAwake: vi.fn(),
    openMicrophoneSettings: vi.fn(),
  };
  return {
    provider,
    call,
    media,
    emit: (input: VoiceCallEvent) => event(input),
    signal: () => signal,
  };
}
