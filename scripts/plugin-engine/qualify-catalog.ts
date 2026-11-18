/**
 * Build every document of a catalog copy against the Host's framework and report what passes.
 *
 *   pnpm qualify:plugin-catalog <catalog directory> <report directory> [--concurrency 4] [--timeout 180] [--rewrite]
 *
 * The catalog directory holds `index.json` and the documents it lists (`{ package, files }`). Each
 * document is untrusted: it is built only through the engine's sandboxed build (`runtime.build`
 * with `retain: false`, compile and declaration inside workerd), never executed here. Builds link
 * the framework bundled with the Host, so the framework is never fetched; other declared packages
 * come from the npm registry as in a real install. Results append to `results.jsonl` in the report
 * directory, which must be outside this repository; a rerun skips documents already recorded.
 * `report.json` and `report.md` summarize them. `--rewrite` first rewrites each document with the
 * rules in `packages/plugin-engine/upstream-names.json`, as the catalog will serve it.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Effect, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Digest, SecureRandom } from "effect/crypto";
import {
  CodeFiles,
  SourceFiles,
  splitSource,
  toEffectRuntime,
} from "@opensteer/plugin-engine-sdk/core";
import { rewriteUpstreamSource } from "@opensteer/plugin-engine-catalog";
import { startRuntimeCheck } from "./runtime-check.ts";

const repository = resolve(import.meta.dirname, "../..");
const [catalogArgument, reportArgument, ...flags] = process.argv.slice(2);
if (catalogArgument === undefined || reportArgument === undefined)
  throw new Error(
    "Usage: qualify-catalog <catalog directory> <report directory> [--concurrency N] [--timeout seconds]",
  );
const flag = (name: string, fallback: number) => {
  const index = flags.indexOf(`--${name}`);
  const value = index === -1 ? fallback : Number(flags[index + 1]);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive integer`);
  return value;
};
const concurrency = flag("concurrency", 4);
const rewrite = flags.includes("--rewrite");
const timeoutSeconds = flag("timeout", 180);
const catalog = resolve(catalogArgument);
const reportDirectory = resolve(reportArgument);
if (!relative(repository, reportDirectory).startsWith(".."))
  throw new Error("The report directory must be outside the repository");

type Cause = "framework" | "dependency" | "source" | "timeout" | "other";
interface Result {
  readonly source: string;
  readonly framework: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly cause?: Cause;
  readonly stage?: string;
  readonly dependency?: string;
  readonly message?: string;
}

const Index = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ id: Schema.String, source: Schema.String })),
});
const Document = Schema.Struct({ files: SourceFiles });
const Manifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/** Framework surface missing in the Host's version: an import or protocol the build cannot find. */
const frameworkMissing =
  /does not provide an export named|No matching export in "node_modules\/apps|is not a function|Could not resolve "apps\/|protocol|apps version/iu;

const classify = (error: unknown): Pick<Result, "cause" | "stage" | "dependency" | "message"> => {
  const record = (typeof error === "object" && error !== null ? error : {}) as Record<
    string,
    unknown
  >;
  const tag = typeof record._tag === "string" ? record._tag : undefined;
  const stage = typeof record.stage === "string" ? record.stage : undefined;
  const dependency = typeof record.dependency === "string" ? record.dependency : undefined;
  const message = (
    typeof record.message === "string" && record.message !== ""
      ? record.message
      : (tag ?? String(error))
  ).slice(0, 2000);
  const base = {
    ...(stage === undefined ? {} : { stage }),
    ...(dependency === undefined ? {} : { dependency }),
    message,
  };
  if (tag === "TimeoutError") return { cause: "timeout", ...base };
  if (tag === "RuntimeProtocolUnsupported") return { cause: "framework", ...base };
  if (stage === "dependencies" && dependency !== "apps") return { cause: "dependency", ...base };
  if (frameworkMissing.test(message)) return { cause: "framework", ...base };
  if (stage === "compile" || stage === "source") return { cause: "source", ...base };
  return { cause: "other", ...base };
};

const index = Schema.decodeUnknownSync(Index)(
  JSON.parse(await readFile(join(catalog, "index.json"), "utf8")),
);
const sources = [...new Set(index.apps.map((entry) => entry.source))].sort();
await mkdir(reportDirectory, { recursive: true });
const resultsFile = join(reportDirectory, "results.jsonl");
const done = new Map<string, Result>();
for (const line of (await readFile(resultsFile, "utf8").catch(() => "")).split("\n"))
  if (line.trim() !== "") {
    const result = JSON.parse(line) as Result;
    done.set(result.source, result);
  }
const pending = sources.filter((source) => !done.has(source));
console.log(`${sources.length} documents, ${done.size} recorded, ${pending.length} to build`);

const started = performance.now();
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* startRuntimeCheck({ directory: join(reportDirectory, "work") });
      const runtime = toEffectRuntime(started.runtime, started.blobs);
      let completed = 0;
      yield* Effect.forEach(
        pending,
        (source) =>
          Effect.gen(function* () {
            const document = yield* Effect.tryPromise(() =>
              readFile(join(catalog, source), "utf8"),
            ).pipe(Effect.map((text) => Schema.decodeUnknownSync(Document)(JSON.parse(text))));
            const split = splitSource(
              rewrite
                ? Schema.decodeUnknownSync(SourceFiles)(rewriteUpstreamSource(document.files).files)
                : document.files,
            );
            const manifest = split.code.find((file) => file.path === "package.json");
            const framework =
              (manifest === undefined
                ? undefined
                : Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(
                    manifest.content,
                  ).pipe((option) => (option._tag === "Some" ? option.value : undefined))
                    ?.dependencies?.apps) ?? "none";
            const begin = performance.now();
            const outcome = yield* runtime
              .build({
                files: Schema.decodeUnknownSync(CodeFiles)(split.code),
                public: split.public.map((file) => file.path.slice("ui/public/".length)),
                retain: false,
              })
              .pipe(Effect.timeout(`${timeoutSeconds} seconds`), Effect.result);
            const result: Result = {
              source,
              framework,
              ms: Math.round(performance.now() - begin),
              ...(outcome._tag === "Success"
                ? { ok: true }
                : { ok: false, ...classify(outcome.failure) }),
            };
            yield* Effect.promise(() => appendFile(resultsFile, JSON.stringify(result) + "\n"));
            done.set(source, result);
            completed += 1;
            if (completed % 25 === 0 || !result.ok)
              console.log(
                `${completed}/${pending.length} ${source} ${result.ok ? "ok" : `${result.cause}: ${result.message?.split("\n")[0]}`}`,
              );
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => console.error(`${source} could not be read`, cause)),
            ),
          ),
        { concurrency, discard: true },
      );
    }),
  ).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provide([Digest.layerWebCrypto, SecureRandom.layerWebCrypto]),
  ),
);
const wallMs = Math.round(performance.now() - started);

const results = [...done.values()];
const percentile = (values: number[], p: number) =>
  values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.floor(values.length * p))]!;
const summarize = (subset: Result[]) => {
  const times = subset.map((result) => result.ms).sort((a, b) => a - b);
  const failures = subset.filter((result) => !result.ok);
  const byCause: Record<string, { count: number; reasons: Record<string, string[]> }> = {};
  for (const failure of failures) {
    const group = (byCause[failure.cause ?? "other"] ??= { count: 0, reasons: {} });
    group.count += 1;
    // Group by the first line with locations and quoted names removed.
    const reason = (failure.message ?? "")
      .split("\n")[0]!
      .replace(/[\w./-]+:\d+:\d+: /gu, "")
      .replace(/"[^"]*"/gu, '"…"')
      .slice(0, 200);
    (group.reasons[reason] ??= []).push(failure.source);
  }
  return {
    documents: subset.length,
    passed: subset.length - failures.length,
    failed: failures.length,
    byCause,
    buildMs: {
      total: times.reduce((sum, value) => sum + value, 0),
      median: percentile(times, 0.5),
      p90: percentile(times, 0.9),
      max: times.at(-1) ?? 0,
    },
  };
};
const versions = [...new Set(results.map((result) => result.framework))].sort();
const report = {
  catalog,
  concurrency,
  timeoutSeconds,
  rewrite,
  lastRunWallMs: wallMs,
  all: summarize(results),
  byFramework: Object.fromEntries(
    versions.map((version) => [
      version,
      summarize(results.filter((result) => result.framework === version)),
    ]),
  ),
};
await writeFile(join(reportDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n");
const section = (title: string, summary: ReturnType<typeof summarize>) =>
  [
    `## ${title}`,
    "",
    `${summary.passed} of ${summary.documents} built; ${summary.failed} failed.`,
    `Build time per document: median ${summary.buildMs.median} ms, p90 ${summary.buildMs.p90} ms, max ${summary.buildMs.max} ms, sum ${summary.buildMs.total} ms.`,
    "",
    ...Object.entries(summary.byCause).flatMap(([cause, group]) => [
      `### ${cause}: ${group.count}`,
      "",
      ...Object.entries(group.reasons)
        .sort((a, b) => b[1].length - a[1].length)
        .map(
          ([reason, list]) =>
            `- ${list.length} × ${reason || "(no message)"}: ${list.slice(0, 8).join(", ")}${list.length > 8 ? ", …" : ""}`,
        ),
      "",
    ]),
  ].join("\n");
await writeFile(
  join(reportDirectory, "report.md"),
  [
    "# Catalog qualification against the Host's framework",
    "",
    `Catalog: ${catalog}${rewrite ? ", rewritten with upstream-names.json" : ""}. Concurrency ${concurrency}, timeout ${timeoutSeconds} s. Last run's wall time: ${wallMs} ms.`,
    "",
    section("All documents", report.all),
    ...versions.map((version) =>
      section(`Documents declaring apps ${version}`, report.byFramework[version]!),
    ),
  ].join("\n"),
);
console.log(JSON.stringify({ ...report.all, byCause: undefined }, null, 2));
console.log(`Report: ${join(reportDirectory, "report.md")}`);
