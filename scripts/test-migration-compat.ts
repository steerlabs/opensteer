import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runBounded } from "./command-runner.js";
import { runIntegrationTests } from "./test-integration.js";

export const migrationTimeoutMs = 30_000;
const revision = z.string().regex(/^[a-f0-9]{40}$/u);

export async function migrationBaseline(
  explicit?: string,
  deployed: () => Promise<string | undefined> = async () => undefined,
  run = runBounded,
): Promise<string> {
  const selected = explicit ?? (await deployed());
  if (!selected)
    throw new Error("No previous release from deployed state; pass --baseline <released SHA>");
  const baseline = revision.parse(selected);
  const head = revision.parse((await run("git", ["rev-parse", "HEAD"])).trim());
  if (baseline === head) throw new Error("Migration baseline must not equal HEAD");
  try {
    await run("git", ["merge-base", "--is-ancestor", baseline, head]);
  } catch (error) {
    throw new Error("Migration baseline must be an ancestor of HEAD", { cause: error });
  }
  return baseline;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      baseline: { type: "string" },
      "verify-controls": { type: "boolean" },
      testNamePattern: { type: "string" },
    },
  });
  const root = resolve(import.meta.dirname, "..");
  const packageManager = process.env.npm_execpath;
  if (!packageManager) throw new Error("Run through pnpm test:migration-compat");
  const stop = new AbortController();
  const cancel = () => stop.abort(new Error("Migration compatibility interrupted"));
  const run: typeof runBounded = (command, args, options) =>
    runBounded(command, args, { cwd: root, ...options, signal: stop.signal });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, cancel);
  let directory: string | undefined;
  let baseline: string | undefined;
  let failure: unknown;
  const started = performance.now();
  try {
    baseline = await migrationBaseline(values.baseline, async () => undefined, run);
    directory = await mkdtemp(join(tmpdir(), "opensteer-migration-compat-"));
    const source = join(directory, "source");
    await run(
      "git",
      ["archive", "--format=tar", `--output=${join(directory, "source.tar")}`, baseline],
      { cwd: root },
    );
    await mkdir(source);
    await run("tar", ["-xf", join(directory, "source.tar"), "-C", source]);
    // The old store resolves its own frozen production closure; frontend/dev tools are unused.
    await run(
      process.execPath,
      [
        packageManager,
        "--filter-prod",
        "@opensteer/database...",
        "--filter-prod",
        "@opensteer/control-plane...",
        "install",
        "--prod",
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
      { cwd: source, timeoutMs: 120_000 },
    );
    console.info(
      `Previous-release source and production dependencies ready in ${((performance.now() - started) / 1000).toFixed(2)} s`,
    );
    console.info(
      `Migration compatibility baseline: ${baseline}; migration bound: ${migrationTimeoutMs} ms per authority`,
    );
    await runIntegrationTests({
      config: "vitest.migration-compat.config.ts",
      ...(values.testNamePattern ? { vitestArguments: ["-t", values.testNamePattern] } : {}),
      signal: stop.signal,
      environment: {
        ...process.env,
        OPENSTEER_MIGRATION_BASELINE_ROOT: source,
        OPENSTEER_MIGRATION_BASELINE_SHA: baseline,
        OPENSTEER_MIGRATION_COMPAT_CONTROLS: values["verify-controls"] ? "1" : "0",
        OPENSTEER_LOCK_ORDER_MODE: "off",
      },
    });
    console.info(
      `Migration compatibility completed in ${((performance.now() - started) / 1000).toFixed(2)} s`,
    );
  } catch (error) {
    failure = stop.signal.aborted ? stop.signal.reason : error;
    throw failure;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, cancel);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
