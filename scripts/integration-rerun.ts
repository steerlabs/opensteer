/**
 * `pnpm integration:rerun <attempt>`: a diagnostic that reruns the failing
 * files of a complete, unfiltered integration run on the same SHA, in a clean
 * pinned worktree under the same lock-order mode, and prints whether the
 * failures reproduced as JSON. It writes no receipt and decides nothing for a
 * merge or release; it always exits 1 so no driver reads it as a pass. See
 * docs/testing.md#same-sha-reruns.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runBounded } from "./command-runner.js";
import {
  compareRerun,
  readRunRecord,
  recordBlockers,
  runRecordsDirectory,
  type RecordedCase,
  type RunRecord,
} from "./run-record.js";

const identity = ({ file, project, titlePath }: RecordedCase) => ({ file, project, titlePath });

/** Colima shares home, not Darwin's per-user temporary directory. */
export async function createRerunWorktree(sha: string): Promise<string> {
  const directory = path.join(homedir(), ".local/state/opensteer/reruns");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(directory, `${sha}-`));
}

export type RerunDecision =
  | { category: "blocked"; problems: string[] }
  | { category: "passed-on-same-sha-rerun"; flakes: ReturnType<typeof identity>[] };

/** The files whose cases failed. */
const failedFiles = (record: RunRecord) => [
  ...new Set((record.reporter?.cases ?? []).filter((c) => c.state === "failed").map((c) => c.file)),
];

/** Why a run cannot be the original of a same-SHA decision: only test failures may remain. */
export function originalProblems(original: RunRecord): string[] {
  const problems = recordBlockers(original);
  if (original.envelope?.filtered)
    problems.push("a filtered run cannot stand for the whole recipe");
  if (
    original.envelope &&
    JSON.stringify(original.envelope.contract.recipe) !== JSON.stringify(["pnpm test:integration"])
  )
    problems.push("not the integration recipe");
  if (!failedFiles(original).length) problems.push("no case failed");
  return problems.map((problem) => `original: ${problem}`);
}

export function decideRerun(original: RunRecord, rerun: RunRecord): RerunDecision {
  const blocked = (problems: string[]): RerunDecision => ({ category: "blocked", problems });
  const problems = originalProblems(original);
  const cases = original.reporter?.cases ?? [];
  const files = failedFiles(original);
  problems.push(...recordBlockers(rerun).map((problem) => `rerun: ${problem}`));
  const contract = (record: RunRecord) => JSON.stringify(record.envelope?.contract);
  if (rerun.envelope && contract(rerun) !== contract(original))
    problems.push("rerun: another SHA, tree, toolchain or input contract");
  if (problems.length || !rerun.reporter) return blocked(problems);
  const compared = compareRerun(cases, rerun.reporter.cases, files);
  if (compared.problems.length) return blocked(compared.problems);
  return { category: "passed-on-same-sha-rerun", flakes: compared.flakes.map(identity) };
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { help: { type: "boolean" } },
    allowPositionals: true,
  });
  const usage = "Usage: pnpm integration:rerun <run-record attempt directory>\n";
  if (values.help || positionals.length !== 1) throw new Error(usage);
  const attempt = path.resolve(positionals[0]!);
  const original = readRunRecord(attempt);
  const envelope = original.envelope;
  const problems = originalProblems(original);
  if (problems.length || !envelope) return print({ category: "blocked", problems });
  const sha = envelope.contract.identity.sourceRevision!;
  const repository = path.resolve(import.meta.dirname, "..");
  const worktree = await createRerunWorktree(sha);
  const run = (
    executable: string,
    args: readonly string[],
    options: Parameters<typeof runBounded>[2] = {},
  ) => runBounded(executable, args, { timeoutMs: 600_000, inheritOutput: true, ...options });
  try {
    // A clean pinned checkout of the original's exact commit.
    await run("git", ["-C", repository, "worktree", "add", "--detach", worktree, sha]);
    if (
      (await run("git", ["-C", worktree, "rev-parse", "HEAD^{tree}"])) !==
      envelope.contract.identity.tree
    )
      throw new Error(
        `The worktree's tree is not the original's ${envelope.contract.identity.tree}`,
      );
    await run("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree, timeoutMs: 1_200_000 });
    const files = failedFiles(original);
    const rerunDirectory = path.join(runRecordsDirectory, sha, `rerun-${randomUUID().slice(0, 8)}`);
    await run("pnpm", ["test:integration", "--", ...files], {
      cwd: worktree,
      timeoutMs: 7_200_000,
      env: {
        OPENSTEER_LOCK_ORDER_MODE: envelope.contract.inputs["lock-order"] ?? "off",
        OPENSTEER_RUN_RECORD_ATTEMPT: rerunDirectory,
      },
      // The record, not the exit status, decides.
    }).catch(() => undefined);
    print({ ...decideRerun(original, readRunRecord(rerunDirectory)), rerun: rerunDirectory });
  } finally {
    await run("git", ["-C", repository, "worktree", "remove", "--force", worktree]).catch(() =>
      rm(worktree, { recursive: true, force: true }),
    );
  }
}

function print(result: object) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  // Never 0: a diagnostic, never a pass.
  process.exitCode = 1;
}
