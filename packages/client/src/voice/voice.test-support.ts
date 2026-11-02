import { vi } from "vitest";
import { createId } from "@opensteer/core";
import { WorkspaceTabLineageSchema } from "@opensteer/protocol";
import { MockHostClient } from "../mock/index.js";
import type { HostSnapshot, MessageEntry } from "../host/client.js";
import type { VoiceCallEvent, VoiceMediaPort, VoiceProvider } from "./contract.js";

export const voiceTestId = "12345678-1234-4123-8123-123456789abc";
export const voiceTestNow = Date.parse("2026-10-30T12:00:00.000Z");

export function voiceSavedTabs(snapshot: HostSnapshot): HostSnapshot {
  const home = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
  const runId = createId("run");
  const sessionId = "bsn_00000000-0000-4000-8000-000000000001";
  const at = new Date(voiceTestNow).toISOString();
  const group = WorkspaceTabLineageSchema.parse({
    id: sessionId,
    revision: 1,
    createdAt: at,
    session: {
      id: sessionId,
      createdAt: at,
      updatedAt: at,
      origin: "workspace",
      access: "full-control",
      placement: { kind: "runner", runnerId: createId("runner") },
      profileId: null,
      runtimeId: "test",
      state: "closed",
      workspaceId: home.workspaceId,
    },
    tabs: Array.from({ length: 36 }, (_, index) => ({
      kind: "browser",
      id: index === 0 ? "tab_gmail" : `tab_saved${index}`,
      sessionId,
      title: index === 0 ? "Gmail" : "Saved tab",
      site: "https://mail.google.com",
      order: index,
      openerId: null,
      state: "suspended",
      createdAt: new Date(voiceTestNow - (36 - index) * 1000).toISOString(),
    })),
  });
  return {
    ...snapshot,
    workspaceTabRestoreVersion: 1,
    workspaceTabs: [group],
    browserSessions: [],
    threads: snapshot.threads.map((thread) =>
      thread.id === home.id ? { ...thread, status: "running" } : thread,
    ),
    runQueue: [{ id: runId, threadId: home.id, status: "running", runOrdinal: 1, createdAt: at }],
    transcripts: {
      ...snapshot.transcripts,
      [home.id]: [
        {
          kind: "place",
          id: "place-gmail",
          runId,
          createdAt: at,
          title: "Gmail",
          site: "https://mail.google.com",
          place: { kind: "browser", sessionId: group.id, surfaceId: group.tabs![0]!.id },
        },
      ],
    },
  };
}

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
    releaseStream: vi.fn(),
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

/**
 * Runs, in fake time, every timer and continuation the step under test
 * scheduled. Polling with `vi.waitFor` advances fake time only per real-time
 * check, so a loaded machine starved it of steps.
 */
export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10);
}
