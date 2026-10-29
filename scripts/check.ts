import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { holdCheckoutWrites } from "@opensteer/shared/kernelLock";
import { runBounded } from "./command-runner.js";

export const checkPhases = [["typecheck", "build"], ["lint", "format:check"], ["test"]] as const;
export const checkRecipe: readonly string[] = checkPhases.flat();

/**
 * Runs the check recipe phase by phase. Steps sharing a phase run together and
 * print their whole output, under their name, as each one ends; a lone step
 * streams. A failed step stops its siblings, and the recipe fails once every
 * process they started has exited.
 */
export async function runCheckSteps(options: {
  root: string;
  signal: AbortSignal;
  run?: typeof runBounded;
  write?: (text: string) => void;
}): Promise<void> {
  const run = options.run ?? runBounded;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const command = { cwd: options.root, timeoutMs: 1_800_000, signal: options.signal };
  const logs = await mkdtemp(path.join(tmpdir(), "opensteer-check-"));
  try {
    for (const phase of checkPhases) {
      if (phase.length === 1) {
        write(`pnpm ${phase[0]}\n`);
        await run("pnpm", [phase[0]], { ...command, inheritOutput: true });
        continue;
      }
      write(`pnpm ${phase.join(", ")}: running together\n`);
      const siblingFailed = new AbortController();
      const signal = AbortSignal.any([options.signal, siblingFailed.signal]);
      const failed = await Promise.all(
        phase.map(async (step) => {
          const outputFile = path.join(logs, `${step.replace(/\W/gu, "-")}.log`);
          const started = performance.now();
          let failure: unknown;
          try {
            await run("pnpm", [step], { ...command, signal, outputFile });
          } catch (error) {
            failure = error;
            if (!signal.aborted) siblingFailed.abort(new Error(`pnpm ${step} failed`));
          }
          const stopped = failure !== undefined && failure === signal.reason;
          const reason = failure instanceof Error ? failure.message : String(failure);
          const output = await readFile(outputFile, "utf8").catch(() => "");
          const seconds = ((performance.now() - started) / 1000).toFixed(0);
          write(
            (failure === undefined
              ? `pnpm ${step} passed after ${seconds} s:\n`
              : stopped
                ? `pnpm ${step} stopped after ${seconds} s (${reason}):\n`
                : `pnpm ${step} failed after ${seconds} s:\n`) +
              (output.endsWith("\n") || !output ? output : `${output}\n`) +
              // A step that never started says why only here.
              (failure === undefined || stopped ? "" : `${reason}\n`),
          );
          return failure === undefined || stopped ? [] : [step];
        }),
      );
      options.signal.throwIfAborted();
      const steps = failed.flat();
      if (steps.length)
        throw new Error(`${steps.map((step) => `pnpm ${step}`).join(", ")} failed; output above`);
    }
  } finally {
    await rm(logs, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "..");
  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error("Checks interrupted"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, interrupt);
  let work: { release(): void } | undefined;
  try {
    work = await holdCheckoutWrites(root, { purpose: "pnpm check", signal: stop.signal });
    await runCheckSteps({ root, signal: stop.signal });
  } finally {
    work?.release();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.removeListener(signal, interrupt);
  }
}
