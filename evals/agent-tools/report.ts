import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type { EvalCase } from "./cases.js";
import { majority } from "./grader.js";

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export const ResultSchema = z.object({
  samplePolicy: z.union([z.number().int().positive(), z.literal("adaptive")]).optional(),
  caseId: z.string(),
  sample: z.number().int().positive(),
  pass: z.boolean(),
  complete: z.boolean(),
  fingerprint: z.string(),
  treatment: z.strictObject({ prompt: z.string(), schema: z.string() }),
});
export type ComparableRow = z.infer<typeof ResultSchema>;
export function caseOutcome(rows: readonly ComparableRow[]): "pass" | "fail" | "incomplete" {
  const samples = [...rows].sort((a, b) => a.sample - b.sample);
  const policy = samples[0]?.samplePolicy ?? 1;
  const expected = policy === "adaptive" ? (samples[0]?.pass !== samples[1]?.pass ? 3 : 2) : policy;
  if (
    !samples.length ||
    samples.length !== expected ||
    samples.some(
      (row, index) =>
        !row.complete || row.sample !== index + 1 || (row.samplePolicy ?? 1) !== policy,
    )
  )
    return "incomplete";
  return majority(samples.map((row) => row.pass)) ? "pass" : "fail";
}
export function compareBaseline(
  baseline: readonly ComparableRow[],
  current: readonly ComparableRow[],
  ids: readonly string[],
  expectedFingerprint: string,
): string[] {
  const seen = new Set<string>();
  for (const row of baseline) {
    if (!ids.includes(row.caseId)) throw new Error(`Baseline contains unknown case: ${row.caseId}`);
    if (row.fingerprint !== expectedFingerprint)
      throw new Error("Baseline fingerprint differs (engine/model/effort/version/corpus)");
    if (!row.complete) throw new Error(`Baseline incomplete: ${row.caseId}`);
    const key = `${row.caseId}:${row.sample}`;
    if (seen.has(key)) throw new Error(`Baseline duplicate sample: ${key}`);
    seen.add(key);
  }
  for (const id of ids) {
    const samples = baseline.filter((row) => row.caseId === id).sort((a, b) => a.sample - b.sample);
    if (!samples.length) throw new Error(`Baseline missing case: ${id}`);
    const policy = samples[0]!.samplePolicy ?? 1;
    const expected =
      policy === "adaptive" ? (samples[0]?.pass !== samples[1]?.pass ? 3 : 2) : policy;
    if (
      samples.length !== expected ||
      samples.some((row, index) => row.sample !== index + 1 || (row.samplePolicy ?? 1) !== policy)
    )
      throw new Error(`Baseline incomplete samples: ${id}`);
  }
  for (const id of ids)
    if (caseOutcome(current.filter((row) => row.caseId === id)) === "incomplete")
      throw new Error(`Current incomplete samples: ${id}`);
  return ids.filter(
    (id) =>
      majority(baseline.filter((row) => row.caseId === id).map((row) => row.pass)) &&
      !majority(current.filter((row) => row.caseId === id).map((row) => row.pass)),
  );
}
export function summary(
  cases: readonly EvalCase[],
  rows: readonly ComparableRow[],
  baseline: readonly ComparableRow[],
  regressions: readonly string[],
  identity: unknown,
): string {
  const lines = [
    "# Agent tool-use evaluation",
    "",
    `Identity: \`${JSON.stringify(identity)}\``,
    "",
    `Completed samples: ${rows.filter((row) => row.complete).length}/${rows.length}. Case majority passes: ${cases.filter((c) => caseOutcome(rows.filter((r) => r.caseId === c.id)) === "pass").length}/${cases.length}.`,
    "",
    `Regressions: ${regressions.join(", ") || "none"}.`,
    "",
    "| Group | Outcome | Samples passed | Sample rate | Baseline delta |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  const groups = new Map<string, readonly string[]>([
    ...cases.map((c) => [`case:${c.id}`, [c.id]] as const),
    ...[...new Set(cases.map((c) => c.kind))].map(
      (kind) => [`kind:${kind}`, cases.filter((c) => c.kind === kind).map((c) => c.id)] as const,
    ),
    ...[...new Set(cases.map((c) => c.area))].map(
      (area) => [`area:${area}`, cases.filter((c) => c.area === area).map((c) => c.id)] as const,
    ),
  ]);
  for (const [name, ids] of groups) {
    const group = rows.filter((row) => ids.includes(row.caseId));
    const old = baseline.filter((row) => ids.includes(row.caseId));
    const incomplete = ids.some(
      (id) => caseOutcome(rows.filter((r) => r.caseId === id)) === "incomplete",
    );
    const outcome = name.startsWith("case:")
      ? caseOutcome(group)
      : incomplete
        ? "incomplete"
        : "complete";
    const rate = group.length
      ? group.filter((row) => row.complete && row.pass).length / group.length
      : 0;
    const oldRate = old.length ? old.filter((row) => row.pass).length / old.length : 0;
    lines.push(
      `| ${name} | ${outcome} | ${group.filter((r) => r.complete && r.pass).length}/${group.length} | ${incomplete ? "—" : `${(rate * 100).toFixed(1)}%`} | ${old.length && !incomplete ? `${((rate - oldRate) * 100).toFixed(1)} pp` : "—"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
