import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { bounded, command } from "../scripts/smoke-desktop-release-command.js";

it("retains both streams and process status on abnormal exit", async () => {
  const events: Record<string, unknown>[] = [];
  await expect(
    command(
      process.execPath,
      ["-e", 'console.log("query.start"); console.error("detail"); process.exit(7)'],
      2000,
      new Set(),
      (event) => events.push(event),
    ),
  ).rejects.toThrow(/"code":7.*"signal":null.*"killed":false.*query.start.*detail/s);
  expect(events[0]).toMatchObject({ event: "command.start", startedAt: expect.any(String) });
  expect(events[1]).toMatchObject({ event: "command.spawn", spawnedAt: expect.any(String) });
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: "command.stdout", text: "query.start\n" }),
      expect.objectContaining({ event: "command.stderr", text: "detail\n" }),
    ]),
  );
});

it("identifies a killed hanging child and releases its captured identity", async () => {
  const roots = new Set<number>();
  await expect(
    command(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 100, roots),
  ).rejects.toThrow(/"signal":"SIGKILL","killed":true/);
  expect(roots.size).toBe(0);
});

it("distinguishes the outer bound from child and application failures", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  try {
    const result = bounded(
      "window",
      12000,
      () => new Promise(() => {}),
      new AbortController(),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12000);
    expect(String(await result)).toMatch(/outer bound.*12000/);
  } finally {
    vi.useRealTimers();
  }
});

it("runs the observer diagnostics against fake frameworks without accessing the screen", () => {
  execFileSync("python3", ["tests/smoke-desktop-release-observer.test.py"], {
    timeout: 2000,
    stdio: "pipe",
  });
});

it("distinguishes an abnormal signal from the command timeout", async () => {
  await expect(
    command(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")'], 2000, new Set()),
  ).rejects.toThrow(/"signal":"SIGTERM","killed":false/);
});
