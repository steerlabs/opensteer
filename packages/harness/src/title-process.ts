import { OpensteerError } from "@opensteer/core";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { collectStreamText, spawnSupervised } from "./process-supervisor.js";
import type {
  HarnessGenerateTextContext,
  HarnessGenerateTextResult,
  HarnessProcessLaunch,
  HarnessSessionContext,
} from "./types.js";

export async function withBackgroundTextDirectory<T>(
  context: HarnessGenerateTextContext,
  signal: AbortSignal,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  await mkdir(context.scratchDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(context.scratchDirectory, "text-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function backgroundTextFailure(
  text: string,
): Extract<HarnessGenerateTextResult, { ok: false }> {
  const failure =
    /signed-out|not logged|logged out|auth|sign.?in|log.?in|credential|unauthorized|401/iu.test(
      text,
    )
      ? "signed-out"
      : /usage-limit|rate.?limit|usage.?limit|quota|capacity|RESOURCE_EXHAUSTED|credits.*depleted|429/iu.test(
            text,
          )
        ? "usage-limit"
        : /refus|denied|not allowed|permission/iu.test(text)
          ? "refused"
          : /unavailable|model.*(?:not found|unsupported|invalid)|ENOENT/iu.test(text)
            ? "unavailable"
            : "failed";
  return { ok: false, failure };
}

export async function backgroundTextResult(
  signal: AbortSignal,
  operation: () => Promise<string>,
): Promise<HarnessGenerateTextResult> {
  try {
    signal.throwIfAborted();
    const text = await operation();
    if (signal.aborted) return { ok: false, failure: "timeout" };
    return text.trim() && text.length <= 20_000
      ? { ok: true, text }
      : { ok: false, failure: "failed" };
  } catch (error) {
    if (signal.aborted) return { ok: false, failure: "timeout" };
    return backgroundTextFailure(error instanceof Error ? error.message : "");
  }
}

/**
 * A private, bounded reply; stderr never becomes a diagnostic containing the
 * request. `failure` matches what an engine writes to stderr when it can no
 * longer answer but would go on retrying, such as a provider refusing the
 * request: the process ends there, rather than at the budget.
 */
export async function runTitleProcess(
  context: Pick<HarnessSessionContext, "wrapProcessLaunch">,
  launch: HarnessProcessLaunch,
  signal: AbortSignal,
  stdin?: string,
  failure: RegExp = /authentication required|not authenticated|unauthorized|signed.out|rate.?limit|usage.?limit|quota|model.*(?:unavailable|not found|access denied)/iu,
): Promise<string> {
  signal.throwIfAborted();
  const child = spawnSupervised({
    ...context.wrapProcessLaunch(launch),
    maxOutputBytes: 64 * 1024,
  });
  const abort = () => void child.terminate(0).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  let refused = false;
  const stdout = collectStreamText(child.stdout);
  const stderr = (async () => {
    let text = "";
    for await (const chunk of child.stderr) {
      text = (text + chunk.toString("utf8")).slice(-16 * 1024);
      if (failure?.test(text) && !refused) {
        refused = true;
        abort();
      }
    }
    return text;
  })();
  // Both drains are observed even when spawn or shutdown fails.
  const drains = Promise.all([stdout, stderr]);
  void drains.catch(() => undefined);
  child.child.stdin.on("error", () => undefined);
  child.child.stdin.end(stdin);
  try {
    if (signal.aborted) abort();
    const exit = await child.exited;
    const [reply, diagnostic] = await drains;
    signal.throwIfAborted();
    if (refused)
      throw new OpensteerError({
        code: "harness_error",
        message: backgroundTextFailure(diagnostic).failure,
      });
    if (exit.code !== 0)
      throw new OpensteerError({
        code: "harness_error",
        message: backgroundTextFailure(diagnostic).failure,
        details: { exitCode: exit.code },
      });
    return reply;
  } finally {
    signal.removeEventListener("abort", abort);
    await child.terminate(0);
    await child.exited;
    await drains;
  }
}
