import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import {
  bestEffortLog,
  bounded,
  command,
  fileTrace,
  stopCaptured,
} from "../scripts/smoke-desktop-release-command.js";

const full = () => {
  throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
};

it("settles and releases the child when trace and fallback writes both fail", async () => {
  const roots = new Set<number>();
  const trace = fileTrace("observer.log", bestEffortLog({ write: full, fallback: full }));
  await expect(
    command(
      process.execPath,
      ["-e", 'console.log("query.start"); console.error("detail"); process.exit(3)'],
      2000,
      roots,
      trace,
    ),
  ).rejects.toThrow(/"code":3.*query\.start.*detail/s);
  expect(roots.size).toBe(0);
  await expect(command(process.execPath, ["-e", ""], 2000, roots, trace)).resolves.toBe("");
});

it("bounds the stderr fallback for failed diagnostic writes", () => {
  const fallback: string[] = [];
  const log = bestEffortLog({
    write: full,
    fallback: (text) => fallback.push(text),
    fallbackBytes: 80,
  });
  for (let index = 0; index < 10; index++) log("observer.log", `${"x".repeat(30)}\n`);
  expect(fallback.join("")).toMatch(/^observer\.log write failed: Error: no space left on device/);
  expect(fallback.join("").length).toBe(80);
});

it("keeps stopping captured PIDs when one cannot be stopped or logged", () => {
  const killed: number[] = [];
  const note = (text: string) =>
    bestEffortLog({ write: full, fallback: full })("cleanup.log", text);
  stopCaptured([11, 12, 13], note, (pid) => {
    killed.push(pid);
    if (pid === 11) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
  });
  expect(killed).toEqual([11, 12, 13]);
});

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
