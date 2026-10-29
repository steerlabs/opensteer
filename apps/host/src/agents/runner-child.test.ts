import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ExecutionContainment, executionScopeVariable } from "@opensteer/runner";
import { forkRunnerChild } from "./runner-child.test-support.js";

// Failure cases: ownership begins only after readiness; close is ignored;
// the leader exits but descendants retain its group; a close promise finishes
// before process exit. These drive small real Node children, without Host/DB/native helpers.
it.for(["before-ready", "ignores-close", "orphan", "detached"])(
  "owns and reaps a Runner child: %s",
  async (scenario, context) => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-runner-owner-"));
    const containment = new ExecutionContainment({ bootId: "child", dataDirectory: directory });
    const owned: (() => Promise<void>)[] = [];
    const running = forkRunnerChild(
      fileURLToPath(new URL("./runner-child-fixture.test-support.mjs", import.meta.url)),
      {
        args: [scenario],
        gracefulCloseMs: 20,
        termGraceMs: 20,
        environment: { [executionScopeVariable]: containment.scope("preparation") },
        afterStop: async () => {
          expect(await containment.reapBoot()).toBe("proven");
        },
      },
      (close) => owned.push(close),
    );
    const descendant = Promise.withResolvers<number | undefined>();
    const observed = new Promise<void>((resolve, reject) => {
      running.child.once("error", reject);
      running.child.once("message", (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "descendant" in message &&
          typeof message.descendant === "number"
        )
          descendant.resolve(message.descendant);
        else descendant.resolve(undefined);
        resolve();
      });
    });
    let descendantPid: number | undefined;
    context.onTestFinished(async () => {
      // Also clean the original implementation during the failing-first run.
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }
      if (running.child.exitCode === null && running.child.signalCode === null)
        running.child.kill("SIGKILL");
      await running.exited;
    });
    await observed;
    descendantPid = await descendant.promise;
    const ownedBeforeReady = owned.length === 1;
    expect(ownedBeforeReady).toBe(true);
    await owned[0]!();
    expect(running.child.exitCode !== null || running.child.signalCode !== null).toBe(true);
    expect(() => process.kill(-running.child.pid!, 0)).toThrowError(
      expect.objectContaining({ code: "ESRCH" }),
    );
    if (descendantPid)
      expect(() => process.kill(descendantPid!, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" }),
      );
    const evidence = await mkdtemp(join(tmpdir(), "opensteer-runner-child-"));
    await writeFile(
      join(evidence, `${scenario}.json`),
      JSON.stringify(
        { scenario, ownedBeforeReady, pid: running.child.pid, descendantPid, groupGone: true },
        null,
        2,
      ),
    );
    console.info(`Runner child ownership evidence: ${evidence}`);
  },
);
