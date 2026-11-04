import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { voiceLeaseMs, voiceMaxCallMs } from "@opensteer/protocol";
import { VoiceCalls } from "./voice-calls.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "voice-owner-"));
  const calls = new VoiceCalls(directory, 100);
  const owner = createId("user"),
    runId = createId("run"),
    sessionId = randomUUID();
  const abort = new AbortController();
  cleanups.push(async () => {
    await calls.close();
    await rm(directory, { recursive: true, force: true });
  });
  const admit = (admittedAt = Date.now()) =>
    calls.admit({
      owner,
      runId,
      sessionId,
      admittedAt,
      signal: abort.signal,
      end: () => abort.abort(),
    });
  return {
    calls,
    owner,
    runId,
    sessionId,
    abort,
    admit,
    command: { action: "start" as const, runId, sessionId, offer: "offer" },
  };
}
it("pairs either order, shares duplicate answers and serializes deduplicated speech", async () => {
  const f = await fixture();
  const start = f.calls.handle(f.owner, f.command);
  const call = f.admit();
  expect(await call.offer).toBe("offer");
  call.answer("answer");
  expect(await start).toEqual({ ok: true, answer: "answer" });
  expect(await f.calls.handle(f.owner, f.command)).toEqual(await start);
  const spoken: string[] = [],
    notes: string[] = [];
  call.connect({
    speak: async (text) => {
      spoken.push(text);
    },
    note: async (text) => {
      notes.push(text);
    },
  });
  await call.speak("turn:1", "first");
  await f.calls.handle(f.owner, { ...f.command, action: "say", id: "chat:1", text: "second" });
  await call.speak("turn:2", "third");
  await f.calls.handle(f.owner, { ...f.command, action: "say", id: "chat:1", text: "second" });
  expect(spoken).toEqual(["first", "second", "third"]);
  expect(notes).toEqual([expect.stringContaining("The person was just told: second")]);
  f.abort.abort();
  expect(await f.calls.handle(f.owner, f.command)).toMatchObject({
    ok: false,
    reason: "voice-ended",
  });
});
it("bounds unknown Runs and offers", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const unknown = f.calls.handle(f.owner, f.command);
  await vi.advanceTimersByTimeAsync(101);
  expect(await unknown).toMatchObject({ ok: false, reason: "voice-ended" });
});
it("renews the lease, expires it, and enforces admission cap", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const call = f.admit();
  const start = f.calls.handle(f.owner, f.command);
  call.answer("a");
  await start;
  await vi.advanceTimersByTimeAsync(voiceLeaseMs - 1);
  expect(await f.calls.handle(f.owner, { ...f.command, action: "renew" })).toEqual({ ok: true });
  await vi.advanceTimersByTimeAsync(voiceLeaseMs);
  expect(call.signal.aborted).toBe(true);
  const g = await fixture();
  const capped = g.admit(Date.now() - voiceMaxCallMs + 10);
  await vi.advanceTimersByTimeAsync(10);
  expect(capped.signal.aborted).toBe(true);
});
it("notes view changes once, rejects mismatched controls and bounds a missing offer", async () => {
  const f = await fixture();
  const call = f.admit();
  const notes: string[] = [];
  call.connect({
    speak: async () => undefined,
    note: async (text) => {
      notes.push(text);
    },
  });
  const view = { threadId: createId("thread"), tabId: null };
  const command = { ...f.command, action: "context" as const, view };
  expect(await f.calls.handle(f.owner, command)).toEqual({ ok: true });
  expect(await f.calls.handle(f.owner, command)).toEqual({ ok: true });
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain(`thread ${view.threadId} / tab none`);
  expect(await f.calls.handle(createId("user"), command)).toMatchObject({
    ok: false,
    reason: "voice-ended",
  });
  expect(await f.calls.handle(f.owner, { ...command, runId: createId("run") })).toMatchObject({
    ok: false,
    reason: "voice-ended",
  });
  vi.useFakeTimers();
  const g = await fixture();
  const missing = g.admit();
  const timed = expect(missing.offer).rejects.toMatchObject({ reason: "voice-ended" });
  await vi.advanceTimersByTimeAsync(100);
  await timed;
  expect(missing.signal.aborted).toBe(true);
});
