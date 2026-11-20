import { createId } from "@opensteer/core";
import { expect, it, vi } from "vitest";
import { AgentAdmission } from "./agent-admission.js";
import { HostedHomeStop, type HostedHomeStopHost } from "./hosted-home-stop.js";
import { DesktopLocalStop, type LocalStopStore } from "./local-stop.js";

const ok = <T>(data: T) => ({ ok: true as const, data });

function home(input: { readonly dispatch?: HostedHomeStopHost["commands.dispatch"] } = {}) {
  const running = createId("thread");
  const waiting = createId("thread");
  const done = createId("thread");
  const runs = new Map([
    [
      running,
      [
        { id: createId("run"), status: "running" },
        { id: createId("run"), status: "queued" },
      ],
    ],
    [waiting, [{ id: createId("run"), status: "waiting" }]],
  ]);
  const interrupted: { runId: string; threadId: string }[] = [];
  const host = {
    "personal.shell.get": vi.fn(async () =>
      ok({
        tasks: [
          { id: running, status: "running" },
          { id: waiting, status: "waiting" },
          { id: done, status: "done" },
        ],
      }),
    ),
    "thread.snapshot.get": vi.fn(async ({ threadId }: { threadId: string }) =>
      ok({
        thread: { id: threadId },
        queue: {
          runs: (runs.get(threadId as never) ?? []).map((run) => ({
            ...run,
            revision: 1,
            finishing: false,
          })),
        },
      }),
    ),
    "commands.dispatch":
      input.dispatch ??
      vi.fn(async (command: { runId: string; threadId: string }) => {
        interrupted.push({ runId: command.runId, threadId: command.threadId });
        return ok({ type: "run.interrupt" });
      }),
  } as unknown as HostedHomeStopHost;
  return { done, host, interrupted, running, runs, waiting };
}

it("ends the hosted Home's running and waiting work through the Home's own Stop, leaving queued Runs held", async () => {
  const { host, interrupted, running, runs, waiting } = home();
  const stop = new HostedHomeStop({
    hostedHome: async () => ({ deploymentId: "dep_home", state: "ready" }),
    host: () => host,
  });
  await stop.pause();
  expect(interrupted).toEqual([
    { runId: runs.get(running)![0]!.id, threadId: running },
    { runId: runs.get(waiting)![0]!.id, threadId: waiting },
  ]);
  expect(host["commands.dispatch"]).toHaveBeenCalledWith(
    expect.objectContaining({ type: "run.interrupt", idempotencyKey: expect.any(String) }),
    expect.anything(),
  );
});

it("has nothing to end when this Mac hosts no Home or its Home is not running", async () => {
  const { host } = home();
  for (const hosted of [null, { deploymentId: "dep_home", state: "stopped" as const }]) {
    await new HostedHomeStop({ hostedHome: async () => hosted, host: () => host }).pause();
  }
  expect(host["personal.shell.get"]).not.toHaveBeenCalled();
});

it("says Stop did not finish, with a retry, when the Home's Stop is not confirmed", async () => {
  let reachable = false;
  const dispatch = vi.fn(async () => {
    if (!reachable) throw new Error("unreachable");
    return ok({ type: "run.interrupt" });
  });
  const { host } = home({ dispatch: dispatch as never });
  const admission = new AgentAdmission();
  const store: LocalStopStore = {
    load: async () => ({ stopped: false, at: null }),
    save: async () => {},
  };
  const quiet = { pause: () => undefined, resume: () => undefined };
  const local = new DesktopLocalStop({
    admission,
    computerUse: quiet,
    runners: quiet,
    home: new HostedHomeStop({
      hostedHome: async () => ({ deploymentId: "dep_home", state: "ready" }),
      host: () => host,
    }),
    store,
    log: vi.fn(),
  });
  await local.restore();
  await expect(local.stop()).rejects.toThrow(/didn’t stop \(tasks on this Mac’s Home\)/);
  expect(local.phase).toBe("failed");
  expect(local.stoppedAt).toBeNull();
  expect(local.problem).toMatch(/Press Stop everything to try again/);
  reachable = true;
  await local.stop();
  expect(local.phase).toBe("stopped");
  expect(local.problem).toBeNull();
});
