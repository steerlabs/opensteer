import { processStopTimeoutMs } from "@opensteer/shared/processControl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stopHost } from "./host-stop.js";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

function fixture(close: () => Promise<void>) {
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const exit = vi.fn();
  const runtime = { app: { log }, close, closingStep: () => "HTTP server" };
  return {
    exit,
    log,
    stop: () => stopHost(runtime as unknown as Parameters<typeof stopHost>[0], "SIGTERM", exit),
  };
}

it("exits once closed, so a leftover handle cannot hold the process until it is killed", async () => {
  const { exit, stop } = fixture(() => Promise.resolve());
  await stop();
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("names the stuck step before the supervisor's kill", async () => {
  const { exit, log, stop } = fixture(() => new Promise(() => undefined));
  void stop();
  await vi.advanceTimersByTimeAsync(processStopTimeoutMs - 1);
  expect(log.warn).toHaveBeenCalledWith(
    { step: "HTTP server" },
    "Opensteer Host still shutting down",
  );
  expect(exit).not.toHaveBeenCalled();
});

it("reports a failed close and exits non-zero", async () => {
  const failure = new Error("database refused");
  const { exit, log, stop } = fixture(() => Promise.reject(failure));
  await stop();
  expect(log.error).toHaveBeenCalledWith(
    { err: failure, step: "HTTP server" },
    "Opensteer Host did not close cleanly",
  );
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
});
