import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { safeMessage } from "@opensteer/shared/safeMessage";

const executeFile = promisify(execFile);

const probeTimeoutMs = 10_000;
const probeOutputMaxBytes = 4 * 1_024;

/** Re-probe cadence while the grant is missing: a person is waiting on it. */
const deniedProbeIntervalMs = 5_000;
/** Re-probe cadence once it is held: only a revocation is left to notice. */
const grantedProbeIntervalMs = 60_000;

/**
 * Whether macOS lets the process running this computer's Opensteer Runner open
 * protected data.
 *
 * The helper answers rather than this process, because macOS attributes the
 * permission to the responsible process or app and the only way to read it is
 * to attempt a gated open from that process tree. Exactly two answers are
 * admitted: anything else is a broken helper, and guessing from it would put a
 * fabricated fact on the machine's descriptor.
 */
export async function probeFullDiskAccess(helperBinary: string): Promise<boolean> {
  let stdout: string;
  try {
    const result = await executeFile(helperBinary, ["full-disk-access"], {
      encoding: "utf8",
      maxBuffer: probeOutputMaxBytes,
      timeout: probeTimeoutMs,
    });
    stdout = result.stdout;
  } catch (error) {
    throw new Error(
      `The native filesystem helper could not probe macOS Full Disk Access: ${failure(error)}`,
    );
  }
  const answer = stdout.trim();
  if (answer === "granted") return true;
  if (answer === "denied") return false;
  throw new Error(
    `The native filesystem helper gave an unrecognized macOS Full Disk Access answer: ${answer.slice(0, 200)}`,
  );
}

export interface FullDiskAccessWatch {
  /** Idempotent: the abort signal calls it too. */
  stop(): void;
}

export interface FullDiskAccessWatchOptions {
  readonly deniedIntervalMs?: number;
  readonly grantedIntervalMs?: number;
  readonly helperBinary: string;
  /** What the descriptor already says, so an unchanged answer stays silent. */
  readonly initial: boolean;
  readonly onChange: (fullDiskAccess: boolean) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly probe?: (helperBinary: string) => Promise<boolean>;
  readonly signal: AbortSignal;
}

/** The injectable parts of the watch, for a caller that only forwards them. */
export type FullDiskAccessProbeOptions = Pick<
  FullDiskAccessWatchOptions,
  "deniedIntervalMs" | "grantedIntervalMs" | "probe"
>;

/**
 * Watches the macOS grant for as long as its caller lives.
 *
 * macOS raises no event when a person turns the switch, so the only way to
 * learn is to ask again. The cadence follows the current answer because the two
 * states are not symmetric: while it is denied somebody is standing at System
 * Settings waiting for Opensteer to notice, and while it is granted the only
 * thing left to catch is a revocation nobody is watching for.
 */
export function watchFullDiskAccess(options: FullDiskAccessWatchOptions): FullDiskAccessWatch {
  const probe = options.probe ?? probeFullDiskAccess;
  const deniedIntervalMs = options.deniedIntervalMs ?? deniedProbeIntervalMs;
  const grantedIntervalMs = options.grantedIntervalMs ?? grantedProbeIntervalMs;
  let current = options.initial;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    options.signal.removeEventListener("abort", stop);
  };
  if (options.signal.aborted) return { stop: () => undefined };
  options.signal.addEventListener("abort", stop, { once: true });

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), current ? grantedIntervalMs : deniedIntervalMs);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    try {
      const next = await probe(options.helperBinary);
      if (stopped) return;
      if (next !== current) {
        // The stored answer advances only once the change has been announced,
        // so an announcement that failed is retried on the next probe instead
        // of leaving the Host describing a grant this machine no longer has.
        await options.onChange(next);
        current = next;
      }
    } catch (error) {
      // A probe that failed says nothing about the grant, so the last answer
      // stands rather than degrading to "denied" on a transient failure.
      options.onError?.(error);
    }
    schedule();
  };

  schedule();
  return { stop };
}

/** The helper's own stderr, which says which probe failed and why. */
function failure(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim().slice(0, 500);
  }
  return safeMessage(error, {
    fallback: "the helper did not say why",
    maximumLength: 500,
    singleLine: true,
  });
}
