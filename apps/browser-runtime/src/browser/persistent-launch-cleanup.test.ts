import { watch } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { PlaywrightChromiumLauncher } from "./playwright-launcher.js";
import { nativeProfileRequest } from "./native-profile.test-support.js";

it("reaps a persistent Chromium child that never returns its protocol handshake", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hung-native-launch-"));
  const pidFile = path.join(root, "owned-pid");
  const executable = path.join(root, "never-connect.mjs");
  await writeFile(
    executable,
    `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`,
  );
  await chmod(executable, 0o700);
  const started = Promise.withResolvers<void>();
  const watcher = watch(root, (_event, name) => {
    if (name === "owned-pid") started.resolve();
  });
  let pid: number | undefined;
  try {
    const launcher = new PlaywrightChromiumLauncher({
      executablePath: executable,
      headless: true,
      chromiumSandbox: false,
    });
    const directory = path.join(root, "native");
    await mkdir(directory);
    const launching = launcher.launch({
      ...nativeProfileRequest(directory),
      remainingBudgetMs: 500,
    });
    const refused = launching.then(
      () => {
        throw new Error("Hung browser unexpectedly launched");
      },
      (error) => error,
    );
    void refused.then((error) => {
      if (!pid) started.reject(error);
    });
    await withTimeout(started.promise, 1000, {
      timeoutError: () => new Error("Owned launch child never started"),
    });
    pid = Number(await readFile(pidFile, "utf8"));
    const error = await withTimeout(refused, 1500, {
      timeoutError: () => new Error("Persistent launch did not finish its child cleanup"),
    });
    expect(error.message).toMatch(/Timeout.*exceeded/);
    expect(() => process.kill(pid!, 0)).toThrow(/ESRCH/);
  } finally {
    watcher.close();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        expect(error).toMatchObject({ code: "ESRCH" });
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
