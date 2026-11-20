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
  expect(service.problem).toMatch(/Couldn't confirm/);
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
