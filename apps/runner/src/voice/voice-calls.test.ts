import { withTimeout } from "@opensteer/shared/withTimeout";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { Deferred } from "@opensteer/harness";
import { voiceLeaseMs, voiceMaxCallMs } from "@opensteer/protocol";
import { VoiceCalls, type RunnerVoiceCall } from "./voice-calls.js";
const owners: VoiceCalls[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});
const user = createId("user"),
  other = createId("user"),
  harnessInstanceId = createId("harnessInstance");
function fakeCall(): RunnerVoiceCall & {
  stop: ReturnType<typeof vi.fn>;
  say: ReturnType<typeof vi.fn>;
} {
  const closed = new Deferred<void>();
  return {
    answer: "answer",
    closed: closed.promise,
    say: vi.fn(async () => undefined),
    stop: vi.fn(async () => {
      closed.resolve();
    }),
  };
}
async function fixture(open: ConstructorParameters<typeof VoiceCalls>[1] = async () => fakeCall()) {
  const launch = vi.fn(open);
  const directory = await mkdtemp(join(tmpdir(), "opensteer-voice-owner-"));
  directories.push(directory);
  await mkdir(join(directory, "call-leftover"));
  const owner = new VoiceCalls(directory, launch);
  owners.push(owner);
  return { owner, open: launch, directory };
}
const start = (sessionId = randomUUID()) => ({
  action: "start" as const,
  harnessInstanceId,
  sessionId,
  offer: "offer",
});
describe("Runner voice owner", () => {
  it("deduplicates pending and started admission, checks owners and sweeps leftovers", async () => {
    const ready = new Deferred<RunnerVoiceCall>();
    const opened = new Deferred<void>();
    const f = await fixture(
      vi.fn(async () => {
        opened.resolve();
        return ready.promise;
      }),
    );
    const command = start();
    const first = f.owner.handle(user, command);
    const second = f.owner.handle(user, command);
    await withTimeout(opened.promise, 1_000, {
      timeoutError: () => new Error("Voice startup never reached the driver"),
    });
    expect(await readdir(f.directory)).toEqual([]);
    expect(await f.owner.handle(other, command)).toMatchObject({
      ok: false,
      reason: "voice-ended",
    });
    const call = fakeCall();
    ready.resolve(call);
    expect(await first).toEqual({ ok: true, answer: "answer" });
    expect(await second).toEqual(await first);
    expect(await f.owner.handle(user, command)).toEqual(await first);
    expect(f.open).toHaveBeenCalledTimes(1);
    for (const action of ["say", "renew", "stop"] as const)
      expect(
        await f.owner.handle(
          other,
          action === "say"
            ? { action, sessionId: command.sessionId, harnessInstanceId, text: "no" }
            : { action, sessionId: command.sessionId, harnessInstanceId },
        ),
      ).toMatchObject({ ok: false, reason: "voice-ended" });
    await f.owner.handle(user, {
      action: "say",
      sessionId: command.sessionId,
      harnessInstanceId,
      text: "hello",
    });
    expect(call.say).toHaveBeenCalledWith("hello");
    await f.owner.handle(user, { action: "stop", sessionId: command.sessionId, harnessInstanceId });
    expect(call.stop).toHaveBeenCalledTimes(1);
    expect(
      await f.owner.handle(user, {
        action: "stop",
        sessionId: command.sessionId,
        harnessInstanceId,
      }),
    ).toEqual({ ok: true });
    expect(await f.owner.handle(user, command)).toMatchObject({
      reason: "voice-ended",
    });
  });
  it("replaces the same person's call and fences late close callbacks", async () => {
    const f = await fixture();
    const first = start(),
      second = start();
    await f.owner.handle(user, first);
    const call = await f.open.mock.results[0]!.value;
    await f.owner.handle(user, second);
    expect(call.stop).toHaveBeenCalledTimes(1);
    expect(
      await f.owner.handle(user, {
        action: "renew",
        sessionId: first.sessionId,
        harnessInstanceId,
      }),
    ).toMatchObject({ reason: "voice-ended" });
    expect(
      await f.owner.handle(user, {
        action: "renew",
        sessionId: second.sessionId,
        harnessInstanceId,
      }),
    ).toEqual({ ok: true });
    await f.owner.close();
    expect((await f.open.mock.results[1]!.value).stop).toHaveBeenCalledTimes(1);
  });
  it("refuses an account mismatch for every operation without ending the owner's call", async () => {
    const f = await fixture();
    const command = start();
    await f.owner.handle(user, command);
    const wrongAccount = createId("harnessInstance");
    expect(
      await f.owner.handle(user, { ...command, harnessInstanceId: wrongAccount }),
    ).toMatchObject({ reason: "voice-ended" });
    for (const action of ["renew", "say", "stop"] as const) {
      const input =
        action === "say"
          ? { action, sessionId: command.sessionId, harnessInstanceId: wrongAccount, text: "no" }
          : { action, sessionId: command.sessionId, harnessInstanceId: wrongAccount };
      expect(await f.owner.handle(user, input)).toMatchObject({ reason: "voice-ended" });
    }
    const call = await f.open.mock.results[0]!.value;
    expect(call.stop).not.toHaveBeenCalled();
    expect(
      await f.owner.handle(user, {
        action: "renew",
        sessionId: command.sessionId,
        harnessInstanceId,
      }),
    ).toEqual({ ok: true });
  });
  it("renews the lease but never beyond the hard cap", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const command = start();
    await f.owner.handle(user, command);
    const call = await f.open.mock.results[0]!.value;
    await vi.advanceTimersByTimeAsync(voiceLeaseMs - 1);
    expect(
      await f.owner.handle(user, {
        action: "renew",
        sessionId: command.sessionId,
        harnessInstanceId,
      }),
    ).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(voiceLeaseMs);
    expect(call.stop).toHaveBeenCalledOnce();
    const capped = start();
    await f.owner.handle(user, capped);
    const second = await f.open.mock.results[1]!.value;
    for (let elapsed = 0; elapsed < voiceMaxCallMs; elapsed += 20_000) {
      await vi.advanceTimersByTimeAsync(20_000);
      await f.owner.handle(user, {
        action: "renew",
        sessionId: capped.sessionId,
        harnessInstanceId,
      });
    }
    expect(second.stop).toHaveBeenCalledOnce();
    expect(
      await f.owner.handle(user, {
        action: "say",
        sessionId: capped.sessionId,
        harnessInstanceId,
        text: "late",
      }),
    ).toMatchObject({ reason: "voice-ended" });
  });
  it("refuses an expired lease even before its timer callback runs", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const command = start();
    await f.owner.handle(user, command);
    const call = await f.open.mock.results[0]!.value;
    vi.setSystemTime(Date.now() + voiceLeaseMs);
    expect(
      await f.owner.handle(user, {
        action: "renew",
        sessionId: command.sessionId,
        harnessInstanceId,
      }),
    ).toMatchObject({ reason: "voice-ended" });
    expect(call.stop).toHaveBeenCalledOnce();
  });
  it("stops pending startup and every call on shutdown", async () => {
    const begun = new Deferred<void>();
    const open = vi.fn(async (input?: { signal: AbortSignal }) => {
      begun.resolve();
      await new Promise<void>((_resolve, reject) =>
        input?.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }),
      );
      return fakeCall();
    });
    const f = await fixture(open);
    const starting = f.owner.handle(user, start());
    await withTimeout(begun.promise, 1_000, {
      timeoutError: () => new Error("Voice startup never reached the driver"),
    });
    await f.owner.close();
    expect(await starting).toMatchObject({ ok: false });
    expect(await f.owner.handle(user, start())).toMatchObject({
      reason: "voice-ended",
    });
  });
});
