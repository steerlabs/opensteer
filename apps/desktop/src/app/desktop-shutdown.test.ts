import { EventEmitter } from "node:events";
import type { App, PowerMonitor } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopShutdown, desktopShutdownTimeoutMs } from "./desktop-shutdown.js";

let signals: Map<"SIGINT" | "SIGTERM", ReturnType<typeof process.listeners>>;
beforeEach(() => {
  signals = new Map(
    ["SIGINT", "SIGTERM"].map((name) => [name as "SIGINT" | "SIGTERM", process.listeners(name)]),
  );
  vi.useFakeTimers();
});
afterEach(() => {
  for (const [name, existing] of signals)
    for (const listener of process.listeners(name))
      if (!existing.includes(listener)) process.removeListener(name, listener);
  vi.useRealTimers();
});
function fixture() {
  const application = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const log = vi.fn();
  const shutdown = new DesktopShutdown({
    application: application as unknown as Pick<App, "on" | "exit">,
    power: new EventEmitter() as unknown as Pick<PowerMonitor, "on">,
    log,
  });
  return { application, log, shutdown };
}
it.each([500, 60_000])(
  "a hung cleanup bounded at %s ms aborts and still dispatches every later owner before the quit deadline",
  async (timeoutMs) => {
    const { shutdown, application, log } = fixture();
    let signal: AbortSignal | undefined;
    shutdown.add({
      component: "injected",
      step: "never-settles",
      order: 10,
      timeoutMs,
      stop: (value) => {
        signal = value;
        return new Promise<void>(() => undefined);
      },
    });
    const stopped: string[] = [];
    for (const [order, component] of [
      "remote-access",
      "local-runners",
      "messaging",
      "browser",
      "runner",
      "host",
      "postgresql",
    ].entries())
      shutdown.add({
        component,
        step: "stop",
        order: 20 + order,
        timeoutMs: 1000,
        stop: () => {
          stopped.push(component);
        },
      });
    shutdown.request("test");
    expect(shutdown.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(Math.min(timeoutMs, desktopShutdownTimeoutMs - 500));
    expect(signal?.aborted).toBe(true);
    expect(stopped).toEqual([
      "remote-access",
      "local-runners",
      "messaging",
      "browser",
      "runner",
      "host",
      "postgresql",
    ]);
    expect(application.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log).toHaveBeenCalledWith("desktop.shutdown.finished", {
      failed: true,
      elapsedMs: Math.min(timeoutMs, desktopShutdownTimeoutMs - 500),
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("aggregate disposal errors retain every cause, continue cleanup, and repeated quit never cancels or repeats cleanup", async () => {
  const { shutdown, application, log } = fixture();
  const fail = vi.fn(() => {
    throw new AggregateError(
      [
        new Error("injected browser disposal failure", {
          cause: new Error("injected native cause"),
        }),
        new Error("injected second cause"),
      ],
      "injected shutdown failure",
    );
  });
  const finish = vi.fn();
  shutdown.add({ component: "browser", step: "stop", order: 10, timeoutMs: 1000, stop: fail });
  shutdown.add({ component: "host", step: "stop", order: 20, timeoutMs: 1000, stop: finish });
  shutdown.request("first");
  shutdown.request("again");
  await vi.advanceTimersByTimeAsync(0);
  expect(fail).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledOnce();
  for (const phrase of [
    "injected browser disposal failure",
    "injected native cause",
    "injected second cause",
  ])
    expect(
      log.mock.calls.some(
        ([event, fields]) =>
          event === "desktop.shutdown.step.failed" && String(fields.message).includes(phrase),
      ),
    ).toBe(true);
  expect(log).toHaveBeenCalledWith("desktop.shutdown.request-repeated", { reason: "again" });
  expect(application.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "update shutdown cleans up before handoff and bounds Squirrel termination (throws=%s)",
  async (throws) => {
    const { shutdown, application } = fixture();
    const sequence: string[] = [];
    shutdown.add({
      component: "personal",
      step: "stop",
      order: 10,
      timeoutMs: 1000,
      stop: () => {
        sequence.push("children-stopped");
      },
    });
    const install = () => {
      sequence.push("windows-destroyed-and-install");
      application.emit("before-quit", { preventDefault: prevented });
      if (throws) throw new Error("private URL must not be logged");
    };
    const prevented = vi.fn();
    shutdown.requestUpdate(install);
    shutdown.request("repeated");
    await vi.advanceTimersByTimeAsync(0);
    expect(sequence).toEqual(["children-stopped", "windows-destroyed-and-install"]);
    expect(prevented).not.toHaveBeenCalled();
    if (!throws) expect(application.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(desktopShutdownTimeoutMs);
    expect(application.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("installs a ready update on ordinary quit only after cleanup", async () => {
  const { shutdown, application } = fixture();
  const calls: string[] = [];
  shutdown.add({
    component: "child",
    step: "stop",
    order: 1,
    timeoutMs: 100,
    stop: () => {
      calls.push("stop");
    },
  });
  shutdown.setUpdateInstaller(() => {
    calls.push("install");
  });
  application.emit("before-quit", { preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toEqual(["stop", "install"]);
  expect(application.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(desktopShutdownTimeoutMs);
  expect(application.exit).toHaveBeenCalledWith(1);
});
