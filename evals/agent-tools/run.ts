import { parseArgs } from "node:util";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { ModelSelectionSchema, harnessRuntimeExpectedVersion } from "@opensteer/core";
import { inspectClaudeExecutable } from "@opensteer/harness-claude";
import { parseCases } from "./cases.js";
import { grade } from "./grader.js";
import {
  compareBaseline,
  fingerprint,
  ResultSchema,
  summary,
  type ComparableRow,
} from "./report.js";
import { prepareEngine, runEngine, type Engine } from "./engine.js";
import { startFakeHost } from "./host.js";

const checkout = resolve(import.meta.dirname, "../..");
const integer = z.coerce.number().int().positive();
const parsed = parseArgs({
  options: {
    engine: { type: "string", default: "claude" },
    model: { type: "string" },
    effort: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string" },
    concurrency: { type: "string", default: "2" },
    baseline: { type: "string" },
    out: { type: "string" },
    "regression-budget": { type: "string", default: "0" },
    help: { type: "boolean", default: false },
  },
});
if (parsed.values.help) {
  console.log(
    "pnpm eval:agent-tools --engine claude|codex [--model ID] [--effort VALUE] [--case ID] [--samples N] [--concurrency N] [--baseline results.jsonl] [--out DIR] [--regression-budget N]",
  );
} else {
  await main();
}
async function main() {
  const engine: Engine = z.enum(["claude", "codex"]).parse(parsed.values.engine);
  const concurrency = integer.max(16).parse(parsed.values.concurrency);
  const samples =
    parsed.values.samples === undefined ? undefined : integer.parse(parsed.values.samples);
  const budget = z.coerce.number().int().nonnegative().parse(parsed.values["regression-budget"]);
  const corpusDir = join(import.meta.dirname, "cases");
  const files = (await readdir(corpusDir)).filter((name) => name.endsWith(".ndjson")).sort();
  const corpus = parseCases(
    (await Promise.all(files.map((name) => readFile(join(corpusDir, name), "utf8")))).join("\n"),
  );
  const filters = parsed.values.case?.flatMap((value) => value.split(","));
  if (filters?.some((id) => !corpus.some((c) => c.id === id)))
    throw new Error("Unknown case filter");
  const cases = corpus.filter(
    (c) => (!c.engines || c.engines.includes(engine)) && (!filters || filters.includes(c.id)),
  );
  if (!cases.length) throw new Error("No cases selected");
  let output = resolve(
    parsed.values.out ??
      join(
        homedir(),
        ".local/state/opensteer/evals",
        `${new Date().toISOString().replaceAll(":", "-")}-${engine}`,
      ),
  );
  const inside = relative(checkout, output);
  if (inside === "" || (inside !== ".." && !inside.startsWith("../") && !isAbsolute(inside)))
    throw new Error("Eval output must be outside the checkout");
  await mkdir(output, { recursive: true, mode: 0o700 });
  output = await realpath(output);
  const resolvedRelative = relative(await realpath(checkout), output);
  if (
    resolvedRelative === "" ||
    (resolvedRelative !== ".." &&
      !resolvedRelative.startsWith("../") &&
      !isAbsolute(resolvedRelative))
  )
    throw new Error("Resolved eval output must be outside the checkout");
  const resultFile = await open(join(output, "results.jsonl"), "ax", 0o600);
  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error("Eval interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const rows: ComparableRow[] = [];
  let baseline: ComparableRow[] = [];
  let regressions: string[] = [];
  let identity: unknown = { engine, status: "initializing" };
  let error: string | undefined;
  let initialized = false;
  let inspectionClose: (() => Promise<void>) | undefined;
  let persistence = Promise.resolve();
  const inspectionRoot = await mkdtemp(join(tmpdir(), "opensteer-eval-inspect-"));
  try {
    const inspected = await prepareEngine(inspectionRoot, engine, stop.signal);
    inspectionClose = inspected.close;
    const model = parsed.values.model
      ? inspected.models.find((m) => m.modelId === parsed.values.model)
      : engine === "codex"
        ? (inspected.models.find((m) => m.modelId === "gpt-6.1-sol") ??
          inspected.models.find((m) => m.isDefault))
        : inspected.models.find((m) => m.isDefault);
    if (!model || model.unavailableReason)
      throw new Error(
        `Requested/default model is not available: ${parsed.values.model ?? "default"}`,
      );
    const effortOption = model.options.find(
      (option) => option.id === "effort" || option.id === "reasoningEffort",
    );
    const effort =
      parsed.values.effort ??
      (effortOption?.type === "select" ? effortOption.defaultValue : undefined) ??
      "default";
    if (
      parsed.values.effort &&
      (!effortOption ||
        effortOption.type !== "select" ||
        !effortOption.values.some((v) => v.value === effort))
    )
      throw new Error(`Effort ${effort} is not offered by ${model.modelId}`);
    const selection = ModelSelectionSchema.parse({
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.nativeModelId ? { nativeModelId: model.nativeModelId } : {}),
      options: parsed.values.effort && effortOption ? { [effortOption.id]: effort } : {},
    });
    let engineVersion: string;
    if (engine === "claude") {
      const installed = await inspectClaudeExecutable(
        process.env.OPENSTEER_CLAUDE_EXECUTABLE ?? "claude",
        inspected.environment,
      );
      if (installed.status !== "available") throw new Error(installed.detail);
      engineVersion = `Claude Code ${installed.version}`;
    } else {
      engineVersion = harnessRuntimeExpectedVersion(engine);
    }
    identity = {
      engine,
      accessMode: "full-access",
      runtimeBoundary: "isolated-service",
      engineVersion,
      model: selection.modelId,
      providerId: selection.providerId,
      ...(selection.nativeModelId ? { nativeModelId: selection.nativeModelId } : {}),
      effort,
      corpus: fingerprint(cases),
    };
    const runFingerprint = fingerprint(identity);
    if (parsed.values.baseline) {
      baseline = (await readFile(parsed.values.baseline, "utf8"))
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => ResultSchema.parse(JSON.parse(line)));
      compareBaseline(
        baseline,
        baseline,
        cases.map((c) => c.id),
        runFingerprint,
      );
    }
    const commit = (
      await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: checkout })
    ).stdout.trim();
    await writeFile(
      join(output, "run.json"),
      JSON.stringify(
        {
          identity,
          fingerprint: runFingerprint,
          commit,
          samples: samples ?? "adaptive-2+1",
          concurrency,
          cases: cases.map((c) => c.id),
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(output, "corpus.ndjson"),
      `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
    );
    initialized = true;
    let next = 0;
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
        while (!stop.signal.aborted) {
          const c = cases[next++];
          if (!c) return;
          const passes: boolean[] = [];
          for (
            let sample = 1;
            sample <= (samples ?? 2) ||
            (samples === undefined && sample === 3 && passes[0] !== passes[1]);
            sample++
          ) {
            if (stop.signal.aborted) return;
            let root: string | undefined;
            const transcriptPath = join(output, `${c.id}-${sample}.transcript.jsonl`);
            const transcript = await open(transcriptPath, "ax", 0o600);
            const started = Date.now();
            let engineClose: (() => Promise<void>) | undefined;
            let host: Awaited<ReturnType<typeof startFakeHost>> | undefined;
            let finalText = "";
            const usage: unknown[] = [];
            const nativeCalls: unknown[] = [];
            let treatment = { prompt: "unavailable", schema: "unavailable" };
            let sampleError: string | undefined;
            let complete = false;
            try {
              root = await mkdtemp(join(tmpdir(), "opensteer-eval-sample-"));
              const p = await prepareEngine(root, engine, stop.signal, inspected.models);
              engineClose = p.close;
              for (const [path, content] of Object.entries(c.fixtures)) {
                const target = join(p.workspace, path);
                await mkdir(dirname(target), { recursive: true });
                await writeFile(target, content);
              }
              host = await startFakeHost(c);
              const result = await runEngine({
                prepared: p,
                testCase: c,
                host,
                selection,
                checkout,
                signal: AbortSignal.any([stop.signal, AbortSignal.timeout(180_000)]),
                onTurnStart: () => {
                  finalText = "";
                  nativeCalls.splice(0);
                },
                onEvent: async (event) => {
                  await transcript.write(`${JSON.stringify(event)}\n`);
                  if (event.type === "run.usage") usage.push(event.data);
                  if (event.type === "tool.started") nativeCalls.push(event.data);
                  if (event.type === "assistant.message")
                    finalText = event.data.content
                      .flatMap((part) => (part.type === "text" ? [part.text] : []))
                      .join("\n");
                },
              });
              finalText = result.finalText;
              treatment = result.treatment;
              complete = true;
            } catch (cause) {
              sampleError = String(cause);
            } finally {
              const cleanup = await Promise.allSettled([
                host?.close(),
                engineClose?.(),
                transcript.close(),
                ...(root ? [rm(root, { recursive: true, force: true })] : []),
              ]);
              const cleanupFailure = cleanup.find((result) => result.status === "rejected");
              if (cleanupFailure?.status === "rejected") {
                complete = false;
                sampleError = [sampleError, `Cleanup failed: ${String(cleanupFailure.reason)}`]
                  .filter(Boolean)
                  .join("; ");
              }
            }
            const calls = host?.calls ?? [];
            const checks = grade(c.expect, calls, finalText);
            const row = {
              caseId: c.id,
              sample,
              samplePolicy: samples ?? ("adaptive" as const),
              kind: c.kind,
              area: c.area,
              profile: c.profile,
              role: c.role,
              fingerprint: runFingerprint,
              identity,
              treatment,
              complete,
              pass: complete && checks.every((check) => check.pass),
              calls,
              nativeCalls,
              invalidCalls: calls.filter((call) => !call.valid),
              finalText,
              usage,
              durationMs: Date.now() - started,
              checks,
              transcriptPath,
              ...(sampleError ? { error: sampleError } : {}),
            };
            persistence = persistence.then(async () => {
              await resultFile.write(`${JSON.stringify(row)}\n`);
              await resultFile.sync();
            });
            await persistence;
            rows.push(row);
            passes.push(row.pass);
            console.log(
              `${engine} ${c.id} #${sample}: ${row.complete ? (row.pass ? "PASS" : "FAIL") : `INCOMPLETE ${sampleError}`} (${rows.length} samples)`,
            );
          }
        }
      }),
    );
    const failedWorker = workers.find((worker) => worker.status === "rejected");
    if (failedWorker?.status === "rejected") throw failedWorker.reason;
    if (baseline.length)
      regressions = compareBaseline(
        baseline,
        rows,
        cases.map((c) => c.id),
        runFingerprint,
      );
  } catch (cause) {
    error = String(cause);
  } finally {
    const cleanup = await Promise.allSettled([
      resultFile.close(),
      inspectionClose?.(),
      rm(inspectionRoot, { recursive: true, force: true }),
    ]);
    const cleanupFailure = cleanup.find((result) => result.status === "rejected");
    if (cleanupFailure?.status === "rejected")
      error = `Cleanup failed: ${String(cleanupFailure.reason)}`;
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    const incomplete =
      !initialized ||
      stop.signal.aborted ||
      rows.some((row) => !row.complete) ||
      cases.some((c) => rows.filter((r) => r.caseId === c.id).length < (samples ?? 2));
    await writeFile(
      join(output, "summary.md"),
      `${summary(cases, rows, baseline, regressions, identity)}\nRun status: ${incomplete || error ? "INCOMPLETE" : "complete"}.${error ? `\n\n${error}\n` : ""}`,
    );
    if (error || incomplete || regressions.length > budget) process.exitCode = 1;
    console.log(`Artifacts: ${output}`);
    if (error) console.error(error);
  }
}
