/**
 * Another Opensteer, for the lifecycle lock tests: a separate process that
 * takes the lock exactly as desktop main does, prints `held`, and holds it
 * until its standard input closes or it is killed. When the lock stays taken
 * past `<wait ms>` it prints `busy` instead.
 *
 * Run with `node --import tsx lifecycle-lock-holder.fixture.ts <lock> <wait ms>`.
 */
import { once } from "node:events";
import { withComputerUseHelperLifecycleLock } from "./helper-install.js";

const [lockPath, waitMs] = process.argv.slice(2);
if (!lockPath || !waitMs) throw new Error("Usage: lifecycle-lock-holder <lock path> <wait ms>");

// A waiter's backoff timers do not keep a process alive; this one exists to wait.
const alive = setInterval(() => undefined, 1_000);
try {
  await withComputerUseHelperLifecycleLock(
    { deadline: { at: Date.now() + Number(waitMs) }, lockPath },
    async () => {
      process.stdout.write("held\n");
      process.stdin.resume();
      await once(process.stdin, "end");
    },
  );
  process.stdout.write("released\n");
} catch {
  process.stdout.write("busy\n");
} finally {
  clearInterval(alive);
}
