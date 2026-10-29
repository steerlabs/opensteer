import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeFullDiskAccess, watchFullDiskAccess } from "./full-disk-access.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe.skipIf(process.platform === "win32")("probeFullDiskAccess", () => {
  it("reads the helper's two admitted answers", async () => {
    await expect(probeFullDiskAccess(await helper("echo granted"))).resolves.toBe(true);
    await expect(probeFullDiskAccess(await helper("echo denied"))).resolves.toBe(false);
  });

  it("refuses to guess from an answer it does not recognize", async () => {
    await expect(probeFullDiskAccess(await helper("echo maybe"))).rejects.toThrow(
      "unrecognized macOS Full Disk Access answer: maybe",
    );
    await expect(probeFullDiskAccess(await helper("exit 0"))).rejects.toThrow(
      "unrecognized macOS Full Disk Access answer:",
    );
  });

  it("reports the helper's own stderr when the probe fails", async () => {
    await expect(
      probeFullDiskAccess(
        await helper('echo "full-disk-access is only meaningful on macOS" >&2\nexit 1'),
      ),
    ).rejects.toThrow(
      "could not probe macOS Full Disk Access: full-disk-access is only meaningful on macOS",
    );
  });
});

describe("watchFullDiskAccess", () => {
  it("re-probes on the cadence the current answer chooses and announces only changes", async () => {
    vi.useFakeTimers();
    const answers = [false, false, true, true];
    let index = 0;
    const probe = vi.fn(async () => answers[Math.min(index++, answers.length - 1)] ?? false);
    const changes: boolean[] = [];
    const watch = watchFullDiskAccess({
      deniedIntervalMs: 5_000,
      grantedIntervalMs: 60_000,
      helperBinary: "/opt/opensteer/opensteer-native-fs",
      initial: false,
      onChange: (value) => void changes.push(value),
      probe,
      signal: new AbortController().signal,
    });
    try {
      await vi.advanceTimersByTimeAsync(4_999);
      expect(probe).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledWith("/opt/opensteer/opensteer-native-fs");
      expect(changes).toEqual([]);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(changes).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changes).toEqual([true]);

      // The grant is held now, so the next probe is a minute out, not 5s.
      await vi.advanceTimersByTimeAsync(59_999);
      expect(probe).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(probe).toHaveBeenCalledTimes(4);
      expect(changes).toEqual([true]);
    } finally {
      watch.stop();
    }
  });

  it("announces a revoked grant and returns to the denied cadence", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => false);
    const changes: boolean[] = [];
    const watch = watchFullDiskAccess({
      deniedIntervalMs: 5_000,
      grantedIntervalMs: 60_000,
      helperBinary: "helper",
      initial: true,
      onChange: (value) => void changes.push(value),
      probe,
      signal: new AbortController().signal,
    });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(changes).toEqual([false]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(changes).toEqual([false]);
    } finally {
      watch.stop();
    }
  });

  it("keeps the previous answer when a probe fails and reports it once", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const probe = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("the helper is missing");
      return true;
    });
    const changes: boolean[] = [];
    const errors: unknown[] = [];
    const watch = watchFullDiskAccess({
      deniedIntervalMs: 5_000,
      grantedIntervalMs: 60_000,
      helperBinary: "helper",
      initial: false,
      onChange: (value) => void changes.push(value),
      onError: (error) => void errors.push(error),
      probe,
      signal: new AbortController().signal,
    });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changes).toEqual([]);
      expect(errors.map((error) => (error as Error).message)).toEqual(["the helper is missing"]);
      // The failure did not move the stored answer, so the watch is still on the
      // denied cadence and the next probe's `true` is still a change.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changes).toEqual([true]);
    } finally {
      watch.stop();
    }
  });

  it("retries an announcement that failed rather than dropping the change", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => true);
    let attempts = 0;
    const errors: unknown[] = [];
    const watch = watchFullDiskAccess({
      deniedIntervalMs: 5_000,
      grantedIntervalMs: 60_000,
      helperBinary: "helper",
      initial: false,
      onChange: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Host connection is not open");
      },
      onError: (error) => void errors.push(error),
      probe,
      signal: new AbortController().signal,
    });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(attempts).toBe(1);
      expect(errors).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(2);
    } finally {
      watch.stop();
    }
  });

  it("stops on its own signal and never starts on an aborted one", async () => {
    vi.useFakeTimers();
    const lifetime = new AbortController();
    const probe = vi.fn(async () => true);
    const watch = watchFullDiskAccess({
      deniedIntervalMs: 5_000,
      helperBinary: "helper",
      initial: false,
      onChange: () => undefined,
      probe,
      signal: lifetime.signal,
    });
    lifetime.abort(new Error("Runner connection closed"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(0);
    watch.stop();

    const aborted = AbortSignal.abort(new Error("already over"));
    const second = watchFullDiskAccess({
      deniedIntervalMs: 5_000,
      helperBinary: "helper",
      initial: false,
      onChange: () => undefined,
      probe,
      signal: aborted,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(0);
    second.stop();
  });

  it("makes no further announcement after stop", async () => {
    vi.useFakeTimers();
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const changes: boolean[] = [];
    const watch = watchFullDiskAccess({
      deniedIntervalMs: 5_000,
      helperBinary: "helper",
      initial: false,
      onChange: (value) => void changes.push(value),
      probe: () => pending,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    watch.stop();
    release(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changes).toEqual([]);
  });
});

async function helper(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-full-access-test-"));
  directories.push(directory);
  const path = join(directory, "opensteer-native-fs");
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o700);
  return path;
}
