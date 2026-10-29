import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import {
  harnessRuntimeExpectedVersion,
  shippedHarnessCatalogEntry,
  shippedHarnessKinds,
  type ShippedHarnessKind,
} from "../packages/core/src/harness-catalog.js";

/*
 * The engines this tree ships, against what their publishers have released.
 *
 *   pnpm engines                 which pins are behind
 *   pnpm engines verify          execute every shipped CLI and assert its pin
 *   pnpm engines update [kind…]  move pins to the latest releases
 *
 * An update rewrites the pnpm catalog, reinstalls, and records what each new
 * binary actually prints for `--version` in the harness catalog, using the
 * same resolution the Runner launches it by. It qualifies nothing: the checks
 * and `pnpm test:engines` decide whether the new engines may ship.
 */

const repositoryRoot = resolve(import.meta.dirname, "..");
const workspacePath = resolve(repositoryRoot, "pnpm-workspace.yaml");
const harnessCatalogPath = resolve(repositoryRoot, "packages/core/src/harness-catalog.ts");
const stableVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export interface EngineRelease {
  readonly kind: ShippedHarnessKind;
  readonly npmPackage: string;
  readonly pinned: string;
  readonly latest: string;
}

export interface EngineUpdate {
  readonly kind: ShippedHarnessKind;
  readonly npmPackage: string;
  readonly from: string;
  readonly to: string;
  readonly runtimeVersion: string;
}

export function compareStableVersions(left: string, right: string): number {
  const components = (version: string): readonly bigint[] => {
    if (!stableVersionPattern.test(version)) {
      throw new Error(`Expected a stable x.y.z version, got ${JSON.stringify(version)}`);
    }
    return version.split(".").map(BigInt);
  };
  const leftParts = components(left);
  const rightParts = components(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0n) - (rightParts[index] ?? 0n);
    if (difference !== 0n) return difference > 0n ? 1 : -1;
  }
  return 0;
}

export function releasesToUpdate(
  releases: readonly EngineRelease[],
  kinds: readonly ShippedHarnessKind[],
): readonly EngineRelease[] {
  return releases.filter(
    (release) =>
      kinds.includes(release.kind) && compareStableVersions(release.latest, release.pinned) > 0,
  );
}

export async function engineReleases(
  fetchLatest: (npmPackage: string) => Promise<string> = latestNpmVersion,
  kinds: readonly ShippedHarnessKind[] = shippedHarnessKinds,
): Promise<readonly EngineRelease[]> {
  const catalog = pnpmCatalog(await readFile(workspacePath, "utf8"));
  return Promise.all(
    [...new Set(kinds)].map(async (kind) => {
      const npmPackage = enginePackage(kind);
      const pinned = catalog[npmPackage];
      if (!pinned) throw new Error(`pnpm-workspace.yaml does not pin ${npmPackage}`);
      return { kind, latest: await fetchLatest(npmPackage), npmPackage, pinned };
    }),
  );
}

export async function updateEngines(
  kinds: readonly ShippedHarnessKind[],
  fetchLatest: (npmPackage: string) => Promise<string> = latestNpmVersion,
): Promise<readonly EngineUpdate[]> {
  const behind = releasesToUpdate(await engineReleases(fetchLatest, kinds), kinds);
  if (behind.length === 0) return [];

  let workspace = await readFile(workspacePath, "utf8");
  for (const release of behind) {
    workspace = withCatalogPin(workspace, release.npmPackage, release.pinned, release.latest);
  }
  await writeFile(workspacePath, workspace);
  await run("pnpm", ["install", "--no-frozen-lockfile"]);

  // Imported only now, so every engine package it resolves is the one just
  // installed rather than one this process already loaded.
  const { harnessRuntimeVersionMismatches } =
    await import("../apps/runner/src/harness/verify-harness-runtimes.js");
  const printed = new Map(
    (await harnessRuntimeVersionMismatches(process.execPath)).map((mismatch) => [
      mismatch.kind,
      mismatch.actual,
    ]),
  );
  const { catalog, updates } = recordRuntimeVersions(
    await readFile(harnessCatalogPath, "utf8"),
    behind,
    printed,
  );
  if (
    updates.some((update) => update.runtimeVersion !== harnessRuntimeExpectedVersion(update.kind))
  ) {
    await writeFile(harnessCatalogPath, catalog);
  }
  return updates;
}

export function recordRuntimeVersions(
  source: string,
  releases: readonly EngineRelease[],
  printed: ReadonlyMap<ShippedHarnessKind, string>,
): { readonly catalog: string; readonly updates: readonly EngineUpdate[] } {
  const unexpected = [...printed.keys()].filter(
    (kind) => !releases.some((release) => release.kind === kind),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Engines not being updated print an unexpected --version: ${unexpected.join(", ")}`,
    );
  }
  let catalog = source;
  const updates = releases.map((release): EngineUpdate => {
    const expected = harnessRuntimeExpectedVersion(release.kind);
    const runtimeVersion = printed.get(release.kind) ?? expected;
    if (!runtimeVersion) throw new Error(`${release.npmPackage} printed an empty --version`);
    if (runtimeVersion !== expected) {
      catalog = withExpectedVersion(catalog, release.kind, expected, runtimeVersion);
    }
    return {
      from: release.pinned,
      kind: release.kind,
      npmPackage: release.npmPackage,
      runtimeVersion,
      to: release.latest,
    };
  });
  return { catalog, updates };
}

export function withCatalogPin(
  workspace: string,
  npmPackage: string,
  from: string,
  to: string,
): string {
  const key = npmPackage.startsWith("@") ? `"${npmPackage}"` : npmPackage;
  const line = `  ${key}: ${from}\n`;
  if (workspace.split(line).length !== 2) {
    throw new Error(`pnpm-workspace.yaml does not pin ${npmPackage} at ${from} exactly once`);
  }
  return workspace.replace(line, `  ${key}: ${to}\n`);
}

export function withExpectedVersion(
  source: string,
  kind: ShippedHarnessKind,
  from: string,
  to: string,
): string {
  const entryStart = `    kind: ${JSON.stringify(kind)},`;
  if (source.split(entryStart).length !== 2) {
    throw new Error(`The harness catalog does not declare ${kind} exactly once`);
  }
  const start = source.indexOf(entryStart);
  const end = source.indexOf("\n  },", start);
  if (end === -1) throw new Error(`The harness catalog has no end for ${kind}`);
  const entry = source.slice(start, end);
  const literal = `expectedVersion: ${JSON.stringify(from)},`;
  if (entry.split(literal).length !== 2) {
    throw new Error(
      `The harness catalog does not state ${JSON.stringify(from)} for ${kind} exactly once`,
    );
  }
  return `${source.slice(0, start)}${entry.replace(literal, `expectedVersion: ${JSON.stringify(to)},`)}${source.slice(end)}`;
}

/** The pinned version of each shipped engine, as `pnpm engines` reads it from the pnpm catalog. */
export function enginePins(workspace: string): Readonly<Record<string, string | undefined>> {
  const catalog = pnpmCatalog(workspace);
  return Object.fromEntries(
    shippedHarnessKinds.map((kind) => [enginePackage(kind), catalog[enginePackage(kind)]]),
  );
}

function enginePackage(kind: ShippedHarnessKind): string {
  const { runtime } = shippedHarnessCatalogEntry(kind);
  if (runtime.shape === "installed") throw new Error(`${kind} ships no runtime`);
  return runtime.npmPackage;
}

function pnpmCatalog(workspace: string): Readonly<Record<string, string>> {
  const parsed = parse(workspace) as { readonly catalog?: Readonly<Record<string, unknown>> };
  return Object.fromEntries(
    Object.entries(parsed.catalog ?? {}).map(([name, version]) => [name, String(version)]),
  );
}

async function latestNpmVersion(npmPackage: string): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${npmPackage}/latest`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`npm answered HTTP ${response.status} for ${npmPackage}`);
  const { version } = (await response.json()) as { readonly version?: unknown };
  if (typeof version !== "string" || !stableVersionPattern.test(version)) {
    throw new Error(`npm reported no stable latest version for ${npmPackage}`);
  }
  return version;
}

function run(command: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...arguments_], {
      cwd: repositoryRoot,
      shell: false,
      // Standard output carries only the summary, which a workflow reuses.
      stdio: ["ignore", 2, 2],
    });
    child.once("error", rejectPromise);
    child.once("close", (code) =>
      code === 0
        ? resolvePromise()
        : rejectPromise(new Error(`${command} ${arguments_.join(" ")} exited ${code ?? "early"}`)),
    );
  });
}

function requestedKinds(arguments_: readonly string[]): readonly ShippedHarnessKind[] {
  if (arguments_.length === 0) return shippedHarnessKinds;
  return arguments_.map((argument) => {
    const kind = shippedHarnessKinds.find((candidate) => candidate === argument);
    if (!kind) throw new Error(`${argument} is not an engine this tree ships`);
    return kind;
  });
}

async function main(arguments_: readonly string[]): Promise<void> {
  const [command, ...rest] = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (command === "verify") {
    if (rest.length > 0)
      throw new Error("pnpm engines verify checks every shipped engine; no arguments expected");
    const { harnessRuntimeVersionMismatches } =
      await import("../apps/runner/src/harness/verify-harness-runtimes.js");
    const mismatches = await harnessRuntimeVersionMismatches(process.execPath);
    if (mismatches.length > 0) {
      throw new Error(
        mismatches
          .map(
            ({ kind, executable, actual, expected }) =>
              `${kind}: ${executable} printed ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
          )
          .join("\n"),
      );
    }
    for (const kind of shippedHarnessKinds) {
      process.stdout.write(
        `${kind}: --version verified (${harnessRuntimeExpectedVersion(kind)})\n`,
      );
    }
    return;
  }
  if (command === undefined) {
    for (const release of await engineReleases()) {
      const comparison = compareStableVersions(release.latest, release.pinned);
      const state =
        comparison === 0
          ? "current"
          : comparison > 0
            ? `behind: ${release.latest}`
            : `ahead of npm: ${release.latest}`;
      process.stdout.write(`${release.kind} ${release.npmPackage} ${release.pinned} (${state})\n`);
    }
    return;
  }
  if (command !== "update") throw new Error(`Unknown command ${command}`);
  const updates = await updateEngines(requestedKinds(rest));
  if (updates.length === 0) {
    process.stdout.write("No newer engine releases found.\n");
    return;
  }
  for (const update of updates) {
    process.stdout.write(
      `${update.kind}: ${update.npmPackage} ${update.from} → ${update.to} (${update.runtimeVersion})\n`,
    );
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
