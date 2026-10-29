/**
 * An integration run's record, written by its three owned phases into one
 * attempt directory: the reporter (`reporter.json`), the global teardown
 * (`teardown.json`) and the launcher (`envelope.json`, after its child exits).
 * Proof and every same-SHA decision read only a complete record; logs are
 * diagnostics. See docs/testing.md#same-sha-reruns.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const runRecordsDirectory = path.join(homedir(), ".local/state/opensteer/run-records");
/** The attempt directory a launcher's Vitest child and global teardown write into. */
export const runRecordVariable = "OPENSTEER_RUN_RECORD";

const state = z.enum(["passed", "failed", "skipped", "pending"]);
const caseSchema = z.strictObject({
  file: z.string(),
  project: z.string(),
  titlePath: z.array(z.string()),
  state,
});
export type RecordedCase = z.infer<typeof caseSchema>;
const reporterSchema = z.strictObject({
  expected: z.array(z.string()),
  modules: z.array(
    z.strictObject({ file: z.string(), state: z.string(), errors: z.array(z.string()) }),
  ),
  cases: z.array(caseSchema),
  suiteErrors: z.array(z.strictObject({ file: z.string(), message: z.string() })),
  unhandledErrors: z.array(z.string()),
  reporterErrors: z.array(z.strictObject({ hook: z.string(), message: z.string() })),
  reason: z.string(),
  /** Written last, after every reporter's `onTestRunEnd` settled. */
  dispatched: z.literal(true),
});
const teardownSchema = z.strictObject({ completed: z.literal(true), errors: z.array(z.string()) });
export const contractSchema = z.strictObject({
  identity: z.record(z.string(), z.string()),
  suite: z.string(),
  recipe: z.array(z.string()),
  inputs: z.record(z.string(), z.string()),
});
const envelopeSchema = z.strictObject({
  attempt: z.string(),
  contract: contractSchema,
  argv: z.array(z.string()),
  /** Vitest arguments narrowed the run, so it cannot stand for the whole recipe. */
  filtered: z.boolean(),
  exit: z.strictObject({ code: z.number().nullable(), signal: z.string().nullable() }),
  cleanup: z.strictObject({ ok: z.boolean(), error: z.string().optional() }),
  launcherError: z.string().optional(),
});

export interface RunRecord {
  readonly directory: string;
  readonly reporter?: z.infer<typeof reporterSchema> | undefined;
  readonly teardown?: z.infer<typeof teardownSchema> | undefined;
  readonly envelope?: z.infer<typeof envelopeSchema> | undefined;
  /** Parts that exist but do not parse. */
  readonly malformed: readonly string[];
}

export function readRunRecord(directory: string): RunRecord {
  const malformed: string[] = [];
  const part = <T>(name: string, schema: z.ZodType<T>): T | undefined => {
    let raw: string;
    try {
      raw = readFileSync(path.join(directory, name), "utf8");
    } catch {
      return undefined;
    }
    try {
      return schema.parse(JSON.parse(raw));
    } catch {
      malformed.push(name);
      return undefined;
    }
  };
  return {
    directory,
    reporter: part("reporter.json", reporterSchema),
    teardown: part("teardown.json", teardownSchema),
    envelope: part("envelope.json", envelopeSchema),
    malformed,
  };
}

/** Everything that keeps a record from accounting for its run, beyond test-case failures. */
export function recordBlockers(record: RunRecord): string[] {
  const { reporter, teardown, envelope } = record;
  const blockers = record.malformed.map((name) => `${name} is malformed`);
  if (!reporter) blockers.push("the reporter wrote no completed record");
  if (!teardown) blockers.push("the global teardown wrote no completion");
  if (!envelope) blockers.push("the launcher wrote no envelope");
  if (reporter) {
    for (const error of reporter.reporterErrors)
      blockers.push(`reporter ${error.hook} failed: ${error.message}`);
    for (const error of reporter.unhandledErrors) blockers.push(`unhandled error: ${error}`);
    for (const module of reporter.modules)
      for (const error of module.errors) blockers.push(`${module.file}: ${error}`);
    for (const error of reporter.suiteErrors) blockers.push(`${error.file}: ${error.message}`);
    const ended = new Set(
      reporter.modules
        .filter((module) => !["queued", "pending"].includes(module.state))
        .map((module) => module.file),
    );
    for (const file of reporter.expected)
      if (!ended.has(file)) blockers.push(`${file} never finished`);
    if (reporter.reason === "interrupted") blockers.push("the run was interrupted");
  }
  for (const error of teardown?.errors ?? []) blockers.push(`global teardown failed: ${error}`);
  if (envelope) {
    if (envelope.launcherError !== undefined)
      blockers.push(`launcher failed: ${envelope.launcherError}`);
    if (!envelope.cleanup.ok) blockers.push(`launcher cleanup failed: ${envelope.cleanup.error}`);
    if (envelope.exit.signal) blockers.push(`the run ended by ${envelope.exit.signal}`);
    const failed = reporter?.cases.some((testCase) => testCase.state === "failed") ?? false;
    if (envelope.exit.code === 0 && failed) blockers.push("the run exited 0 although cases failed");
    if (envelope.exit.code !== 0 && reporter && !failed && !envelope.exit.signal)
      blockers.push(`the run exited ${envelope.exit.code} without a failed case`);
  }
  return blockers;
}

export const identityKey = (testCase: Pick<RecordedCase, "file" | "project" | "titlePath">) =>
  JSON.stringify([testCase.file, testCase.project, testCase.titlePath]);

/** The original final state the rerun must reach, or better. */
const reaches = (original: RecordedCase["state"], rerun: RecordedCase["state"]) =>
  original === "failed" || original === "passed"
    ? rerun === "passed"
    : rerun === "passed" || rerun === "skipped" || rerun === "pending";

/**
 * Whether a rerun of the original's failing files accounts for each of their
 * cases one-to-one, every one reaching its original state or better. A group
 * of cases sharing one identity maps ambiguously, so it counts only when its
 * size matches and every member passed on the rerun.
 */
export function compareRerun(
  original: readonly RecordedCase[],
  rerun: readonly RecordedCase[],
  files: readonly string[],
): { problems: string[]; flakes: RecordedCase[] } {
  const group = (cases: readonly RecordedCase[]) => {
    const groups = new Map<string, RecordedCase[]>();
    for (const testCase of cases.filter((value) => files.includes(value.file)))
      groups.set(identityKey(testCase), [...(groups.get(identityKey(testCase)) ?? []), testCase]);
    return groups;
  };
  const before = group(original);
  const after = group(rerun);
  const problems: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key) ?? [];
    const now = after.get(key) ?? [];
    const name = JSON.parse(key).slice(0, 1).concat(JSON.parse(key)[2]).join(" > ");
    if (was.length !== now.length)
      problems.push(`${name}: ${was.length} case(s) originally, ${now.length} on the rerun`);
    else if (was.length > 1) {
      if (!now.every((testCase) => testCase.state === "passed"))
        problems.push(`${name}: ${was.length} cases share this identity and not all passed`);
    } else if (!reaches(was[0]!.state, now[0]!.state))
      problems.push(`${name}: ${was[0]!.state} originally, ${now[0]!.state} on the rerun`);
  }
  return { problems, flakes: original.filter((testCase) => testCase.state === "failed") };
}
