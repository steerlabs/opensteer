import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { acquireProfileRootLock } from "./profile-root-lock.js";

it("excludes a second standalone process and releases its OS lock on process death", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "standalone-profile-lock-"));
  const script = `import { acquireProfileRootLock } from ${JSON.stringify(new URL("./profile-root-lock.ts", import.meta.url).href)};
    await acquireProfileRootLock(process.argv[1]); process.send("ready"); process.on("message", () => {});`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type", "module", "-e", script, root],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const exited = once(child, "exit");
  const deadline = <T>(promise: Promise<T>, message: string) =>
    withTimeout(promise, 3000, { timeoutError: () => new Error(message) });
  try {
    await deadline(once(child, "message"), "Standalone OS lock owner never became ready");
    await expect(acquireProfileRootLock(root)).rejects.toThrow(/in use/);
    child.kill("SIGKILL");
    await deadline(exited, "Standalone OS lock owner never exited");
    const release = await acquireProfileRootLock(root);
    release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await deadline(exited, "Standalone OS lock owner cleanup stalled");
    await rm(root, { recursive: true, force: true });
  }
});
