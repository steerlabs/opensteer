import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const modulePath = fileURLToPath(new URL("./inspector-signal.ts", import.meta.url));

/**
 * A Node that has received SIGUSR1, reporting whether an inspector is open.
 * It runs in its own process because the signal is process-wide.
 */
async function inspectorAfterSignal(refuse: boolean): Promise<string> {
  const script = `
    import inspector from "node:inspector";
    ${refuse ? `const { refuseInspectorSignal } = await import(${JSON.stringify(modulePath)}); refuseInspectorSignal(process);` : ""}
    process.kill(process.pid, "SIGUSR1");
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.stdout.write(String(inspector.url()));
    inspector.close();
  `;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
    // A free port, so a signal that does open an inspector cannot collide
    // with one somebody is already running.
    env: { ...process.env, NODE_OPTIONS: "--inspect-port=0" },
  });
  return stdout;
}

describe("refuseInspectorSignal", () => {
  it.skipIf(process.platform === "win32")(
    "leaves the process without an inspector after SIGUSR1",
    async () => {
      // The control: without the listener this Node opens one, which is what
      // the listener is there to prevent.
      expect(await inspectorAfterSignal(false)).toMatch(/^ws:\/\//u);
      expect(await inspectorAfterSignal(true)).toBe("undefined");
    },
  );

  it("guards the local Runner worker before it starts the Runner", async () => {
    // The worker is the utility process's entry module and runs on import, so
    // its order is checked where it is written.
    const worker = await readFile(
      fileURLToPath(new URL("../runner-worker.ts", import.meta.url)),
      "utf8",
    );
    const guarded = worker.indexOf("refuseInspectorSignal(process);");

    expect(guarded).toBeGreaterThan(-1);
    expect(guarded).toBeLessThan(worker.indexOf("runRunnerDaemon(process.env"));
  });
});
