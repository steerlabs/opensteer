import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { DesktopLocalStop, localStopFileStore } from "./local-stop.js";

const at = "2026-11-20T09:00:00.000Z";

function fixture() {
  const store = {
    load: vi.fn(
      async () => ({ stopped: false, at: null }) as { stopped: boolean; at: string | null },
    ),
    save: vi.fn(async (_choice: { stopped: boolean; at: string | null }) => {}),
  };
  const restart = vi.fn(async () => {});
  const log = vi.fn();
  const service = new DesktopLocalStop({ store, restart, log, now: () => new Date(at) });
  return { log, service, store, restart };
}

it("saves Stop before restarting and serializes Resume behind it", async () => {
  const { service, store, restart, log } = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  restart.mockImplementationOnce(() => {
    expect(store.save).toHaveBeenCalledWith({ stopped: true, at });
    expect(service.agentsStoppedSince).toBe(at);
    entered.resolve();
    return release.promise;
  });
  await service.restore();
  const started = performance.now();
  const stop = service.stop();
  await entered.promise;
  expect(service.phase).toBe("stopping");
  expect(service.stoppedAt).toBeNull();
  const resume = service.resume();
  expect(restart).toHaveBeenCalledOnce();
  release.resolve();
  await Promise.all([stop, resume]);
  console.info(
    `Serialized Stop and Resume with a stub Runner: ${(performance.now() - started).toFixed(1)} ms`,
  );
  expect(restart).toHaveBeenCalledTimes(2);
  expect(store.save).toHaveBeenLastCalledWith({ stopped: false, at: null });
  expect(service.phase).toBe("running");
  expect(log).toHaveBeenCalledWith(
    "desktop.local-stop.restarted",
    expect.objectContaining({
      elapsedMs: expect.any(Number),
    }),
  );
});

it("stops on a save failure and reports that the choice may be lost", async () => {
  const { service, store, restart } = fixture();
  await service.restore();
  store.save.mockRejectedValueOnce(new Error("disk full"));
  await service.stop();
  expect(restart).toHaveBeenCalledOnce();
  expect(service.phase).toBe("stopped");
  expect(service.problem).toBeTruthy();
});

it("offers Resume without claiming confirmed Stop after unproved shutdown", async () => {
  const { service, restart } = fixture();
  restart.mockRejectedValueOnce(
    new Error("Couldn't confirm that one device connection on this Mac stopped."),
  );
  await service.restore();
  await service.stop();
  expect(service.phase).toBe("stopped");
  expect(service.stoppedAt).toBeNull();
  expect(service.problem).toContain("Couldn’t confirm everything stopped");
  expect(service.problem).toContain("Couldn't confirm that one device connection");
  await service.resume();
  expect(service.phase).toBe("running");
});

it("restores each saved mode and fails closed on unreadable state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-stop-unit-"));
  try {
    const file = path.join(root, "choice.json");
    const store = localStopFileStore(file);
    const restore = async () => {
      const service = new DesktopLocalStop({ store, restart: async () => {}, log: vi.fn() });
      await service.restore();
      return service;
    };
    expect((await restore()).phase).toBe("running");
    await store.save({ stopped: true, at });
    expect((await restore()).agentsStoppedSince).toBe(at);
    await writeFile(file, "{broken");
    const unreadable = await restore();
    expect(unreadable.phase).toBe("stopped");
    expect(unreadable.stoppedAt).toBeNull();
    expect(unreadable.problem).toMatch(/Resume/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports an uncontained earlier boot when restoring Stop", async () => {
  const { service, store } = fixture();
  store.load.mockResolvedValueOnce({ stopped: true, at });
  await service.restore();
  service.noteUncontainedBoot(at);
  expect(service.phase).toBe("stopped");
  expect(service.stoppedAt).toBeNull();
  expect(service.problem).toBe("Couldn’t confirm everything stopped");
});

it("queues Stop behind the update handoff's final idle check", async () => {
  const { service, store, restart } = fixture();
  await service.restore();
  const handoffEntered = Promise.withResolvers<void>();
  const handoffFinished = Promise.withResolvers<void>();
  const handoff = service.whileModeStable(async () => {
    handoffEntered.resolve();
    await handoffFinished.promise;
  });
  await handoffEntered.promise;
  const stop = service.stop();
  expect(store.save).not.toHaveBeenCalled();
  expect(restart).not.toHaveBeenCalled();
  handoffFinished.resolve();
  await Promise.all([handoff, stop]);
  expect(store.save).toHaveBeenCalledWith({ stopped: true, at });
});

it("keeps looking for Home Stop proof after local containment, keeps Resume usable, and confirms when proof arrives", async () => {
  const proof = Promise.withResolvers<boolean>();
  const confirm = vi.fn((_stoppedSince: string, _signal: AbortSignal) => proof.promise);
  const service = new DesktopLocalStop({
    store: { load: async () => ({ stopped: false, at: null }), save: async () => {} },
    restart: async () => {},
    confirm,
    log: vi.fn(),
    now: () => new Date(at),
  });
  await service.restore();
  await service.stop();

  expect(service.phase).toBe("stopped");
  expect(service.stoppedAt).toBeNull();
  expect(service.problem).toBeNull();
  expect(service.confirming).toBe(true);
  expect(confirm).toHaveBeenCalledWith(at, expect.any(AbortSignal));

  proof.resolve(true);
  await vi.waitFor(() => expect(service.stoppedAt).toBe(at));
  expect(service.confirming).toBe(false);
  expect(service.problem).toBeNull();
});

it("marks Home confirmation overdue after 30 s while continuing to look, then confirms when proof arrives", async () => {
  vi.useFakeTimers();
  try {
    const proof = Promise.withResolvers<boolean>();
    const emissions: Array<{
      confirming: boolean;
      confirmOverdue: boolean;
      stoppedAt: string | null;
    }> = [];
    const service = new DesktopLocalStop({
      store: { load: async () => ({ stopped: false, at: null }), save: async () => {} },
      restart: async () => {},
      confirm: () => proof.promise,
      log: vi.fn(),
      now: () => new Date(at),
    });
    service.subscribe(() => {
      emissions.push({
        confirming: service.confirming,
        confirmOverdue: service.confirmOverdue,
        stoppedAt: service.stoppedAt,
      });
    });
    await service.restore();
    await service.stop();

    expect(service.confirming).toBe(true);
    expect(service.confirmOverdue).toBe(false);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(service.confirming).toBe(true);
    expect(service.confirmOverdue).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(service.confirming).toBe(true);
    expect(service.confirmOverdue).toBe(true);
    expect(service.stoppedAt).toBeNull();
    expect(service.problem).toBeNull();
    expect(emissions.at(-1)).toEqual({
      confirming: true,
      confirmOverdue: true,
      stoppedAt: null,
    });

    proof.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.confirming).toBe(false);
    expect(service.confirmOverdue).toBe(false);
    expect(service.stoppedAt).toBe(at);
    expect(emissions.at(-1)).toEqual({
      confirming: false,
      confirmOverdue: false,
      stoppedAt: at,
    });
  } finally {
    vi.useRealTimers();
  }
});

it("cancels an in-flight Home proof look and ignores late answers on Resume or a second Stop", async () => {
  const at2 = "2026-11-20T09:05:00.000Z";
  let clock = at;
  const calls: Array<{
    stoppedSince: string;
    signal: AbortSignal;
    deferred: PromiseWithResolvers<boolean>;
  }> = [];
  const service = new DesktopLocalStop({
    store: { load: async () => ({ stopped: false, at: null }), save: async () => {} },
    restart: async () => {},
    confirm: (stoppedSince, signal) => {
      const deferred = Promise.withResolvers<boolean>();
      calls.push({ stoppedSince, signal, deferred });
      return deferred.promise;
    },
    log: vi.fn(),
    now: () => new Date(clock),
  });
  await service.restore();

  // First Stop starts look #1; Resume aborts it and ignores a late confirmation.
  await service.stop();
  expect(calls).toHaveLength(1);
  await service.resume();
  expect(calls[0]!.signal.aborted).toBe(true);
  calls[0]!.deferred.resolve(true);
  await Promise.resolve();
  expect(service.phase).toBe("running");
  expect(service.stoppedAt).toBeNull();

  // Second Stop while stopped aborts the previous Stop's look and accepts only its own proof.
  await service.stop();
  expect(calls).toHaveLength(2);
  clock = at2;
  await service.stop();
  expect(calls).toHaveLength(3);
  expect(calls[1]!.signal.aborted).toBe(true);
  calls[1]!.deferred.resolve(true);
  await Promise.resolve();
  expect(service.stoppedAt).toBeNull();
  expect(service.confirming).toBe(true);

  calls[2]!.deferred.resolve(true);
  await vi.waitFor(() => expect(service.stoppedAt).toBe(at2));
  expect(service.confirming).toBe(false);
});

it("never lets Home proof override failed local containment, handles permanent Home refusal, and waits for boot containment after restore()", async () => {
  // 1. Permanent Home refusal surfaces an error and ends the look.
  const refused = new DesktopLocalStop({
    store: { load: async () => ({ stopped: false, at: null }), save: async () => {} },
    restart: async () => {},
    confirm: async () => {
      throw new Error("Personal Host refused the setup read (unauthorized): sign in required");
    },
    log: vi.fn(),
    now: () => new Date(at),
  });
  await refused.restore();
  await refused.stop();
  await vi.waitFor(() => expect(refused.confirming).toBe(false));
  expect(refused.stoppedAt).toBeNull();
  expect(refused.problem).toContain("Couldn’t confirm everything stopped");
  expect(refused.problem).toContain("Personal Host refused");

  // 2. Failed local containment (restart error) never starts a Home proof look.
  const confirmOnLocalFail = vi.fn(async () => true);
  const localFailed = new DesktopLocalStop({
    store: { load: async () => ({ stopped: false, at: null }), save: async () => {} },
    restart: async () => {
      throw new Error("Runner did not exit");
    },
    confirm: confirmOnLocalFail,
    log: vi.fn(),
    now: () => new Date(at),
  });
  await localFailed.restore();
  await localFailed.stop();
  expect(confirmOnLocalFail).not.toHaveBeenCalled();
  expect(localFailed.stoppedAt).toBeNull();
  expect(localFailed.problem).toContain("Couldn’t confirm everything stopped");

  // 3. restore() under a saved Stop does NOT start looking or show a timestamp
  //    before boot containment is reported, even when Home proof is available immediately.
  const immediateConfirm = vi.fn(async () => true);
  const reopened = new DesktopLocalStop({
    store: { load: async () => ({ stopped: true, at }), save: async () => {} },
    restart: async () => {},
    confirm: immediateConfirm,
    log: vi.fn(),
    now: () => new Date(at),
  });
  await reopened.restore();
  await Promise.resolve();
  expect(reopened.phase).toBe("stopped");
  expect(reopened.stoppedAt).toBeNull();
  expect(reopened.confirming).toBe(false);
  expect(reopened.problem).toBeNull();
  expect(immediateConfirm).not.toHaveBeenCalled();

  // Once the supervisor reports the boot contained, it looks for Home proof and confirms.
  reopened.noteContainedBoot(at);
  await vi.waitFor(() => expect(reopened.stoppedAt).toBe(at));
  expect(immediateConfirm).toHaveBeenCalledExactlyOnceWith(at, expect.any(AbortSignal));
  expect(reopened.confirming).toBe(false);
  expect(reopened.problem).toBeNull();

  // If the boot is reported uncontained instead, show the problem line and ignore any late Home proof or contained signal.
  const uncontainedConfirm = vi.fn(async () => true);
  const uncontained = new DesktopLocalStop({
    store: { load: async () => ({ stopped: true, at }), save: async () => {} },
    restart: async () => {},
    confirm: uncontainedConfirm,
    log: vi.fn(),
    now: () => new Date(at),
  });
  await uncontained.restore();
  uncontained.noteUncontainedBoot(at);
  uncontained.noteContainedBoot(at);
  await Promise.resolve();
  expect(uncontainedConfirm).not.toHaveBeenCalled();
  expect(uncontained.stoppedAt).toBeNull();
  expect(uncontained.confirming).toBe(false);
  expect(uncontained.problem).toBe("Couldn’t confirm everything stopped");

  // Even if contained arrived first and Home proof was pending, a late uncontained boot revokes it and ignores late Home proof.
  const lateProof = Promise.withResolvers<boolean>();
  let lateSignal: AbortSignal | undefined;
  const revoked = new DesktopLocalStop({
    store: { load: async () => ({ stopped: true, at }), save: async () => {} },
    restart: async () => {},
    confirm: (_since, signal) => {
      lateSignal = signal;
      return lateProof.promise;
    },
    log: vi.fn(),
    now: () => new Date(at),
  });
  await revoked.restore();
  revoked.noteContainedBoot(at);
  expect(revoked.confirming).toBe(true);
  revoked.noteUncontainedBoot(at);
  expect(lateSignal?.aborted).toBe(true);
  lateProof.resolve(true);
  await Promise.resolve();
  expect(revoked.stoppedAt).toBeNull();
  expect(revoked.confirming).toBe(false);
  expect(revoked.problem).toBe("Couldn’t confirm everything stopped");
});

it("does not confirm or log home-confirmed when the look stops without proof (false) before controller abort", async () => {
  const proof = Promise.withResolvers<boolean>();
  const log = vi.fn();
  const service = new DesktopLocalStop({
    store: { load: async () => ({ stopped: false, at: null }), save: async () => {} },
    restart: async () => {},
    confirm: () => proof.promise,
    log,
    now: () => new Date(at),
  });
  await service.restore();
  await service.stop();
  expect(service.confirming).toBe(true);

  proof.resolve(false);
  await vi.waitFor(() => expect(service.confirming).toBe(false));
  expect(service.stoppedAt).toBeNull();
  expect(log).not.toHaveBeenCalledWith("desktop.local-stop.home-confirmed", expect.anything());
});
