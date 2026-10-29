import { expect, it } from "vitest";
import { registerLaunchedApp, type AppRegistrationPorts } from "./journey-app-registration.js";
import { bindPath, type PathIO } from "./journey-paths.js";
import type { ProcessRow } from "./journey-processes.js";
function setup() {
  const paths: PathIO = {
    lstat: () => ({ kind: "directory", dev: "1", ino: "1" }),
    realpath: (value) => value,
  };
  const wrapper: ProcessRow = {
    pid: 50,
    pgid: 50,
    ppid: 1,
    startedAt: "wrapper",
    command: "wrapper",
  };
  const app: ProcessRow = { pid: 60, pgid: 60, ppid: 1, startedAt: "app", command: "app" };
  const claim = { pid: 60, bundle: "/work/Fixture.app", startSeconds: 1, startMicroseconds: 2 };
  const actual = {
    pid: 60,
    pgid: 60,
    startSeconds: 1,
    startMicroseconds: 2,
    executable: "/work/Fixture.app/Contents/MacOS/Receiver",
  };
  const events: string[] = [];
  const ports: AppRegistrationPorts = {
    paths,
    processes: () => [wrapper, app],
    inspect: () => actual,
    register: async (identity) => {
      events.push(`registered:${identity.pid}`);
    },
    terminate: (pid) => {
      events.push(`terminated:${pid}`);
    },
  };
  const run = (peer = wrapper.pid) =>
    registerLaunchedApp(peer, wrapper, bindPath("/work", paths), claim, ports);
  return { actual, events, ports, run };
}
it("durably registers an in-bundle launch before acknowledging", async () => {
  const f = setup();
  await f.run();
  f.events.push("acknowledged");
  expect(f.events).toEqual(["registered:60", "acknowledged"]);
});
it("refuses a PID whose kernel executable is outside the bundle", async () => {
  const f = setup();
  f.actual.executable = "/unrelated/Receiver";
  await expect(f.run()).rejects.toThrow("outside");
  expect(f.events).toEqual([]);
});
it("refuses a reused PID even when its executable is unchanged", async () => {
  const f = setup();
  f.actual.startMicroseconds++;
  await expect(f.run()).rejects.toThrow("identity changed");
  expect(f.events).toEqual([]);
});
it("refuses a socket peer other than the registered wrapper", async () => {
  const f = setup();
  await expect(f.run(51)).rejects.toThrow("wrapper peer");
  expect(f.events).toEqual([]);
});
it("terminates only the verified launch PID if durable registration fails", async () => {
  const f = setup();
  f.ports.register = async () => {
    throw Error("journal failed");
  };
  await expect(f.run()).rejects.toThrow("journal failed");
  expect(f.events).toEqual(["terminated:60"]);
});
it("never terminates a PID reused during a failed registration", async () => {
  const f = setup();
  f.ports.register = async () => {
    f.actual.startMicroseconds++;
    throw Error("journal failed");
  };
  await expect(f.run()).rejects.toThrow("journal failed");
  expect(f.events).toEqual([]);
});
it("rejects bundle roots replaced after registration", async () => {
  const f = setup();
  const original = f.ports.paths.lstat;
  f.ports.paths.lstat = (value) => ({
    ...original(value)!,
    ino: value === "/work" ? "replaced" : "1",
  });
  const root = {
    path: "/work",
    realPath: "/work",
    ancestors: [{ path: "/work", realPath: "/work", dev: "1", ino: "1" }],
  };
  await expect(
    registerLaunchedApp(
      50,
      { pid: 50, pgid: 50, startedAt: "wrapper" },
      root,
      { pid: 60, bundle: "/work/Fixture.app", startSeconds: 1, startMicroseconds: 2 },
      f.ports,
    ),
  ).rejects.toThrow("ancestor changed");
});
