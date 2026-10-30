import { collectJourneyEvidence } from "./journey-artifacts.js";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { bindPath, validatePathBinding } from "./journey-paths.js";
import { stopLegacyGroup } from "./journey-legacy-stop.js";
import type { ProcessIdentity } from "./journey-processes.js";
import { stopRegisteredGroups } from "./journey-processes.js";
import { launchRegisteredWorkload } from "./journey-launch.js";
import {
  prepareAcceptedRun,
  acceptedRunResult,
  runtimeResourceJourney,
} from "./journey-preparation.js";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  authorizeRun,
  JOURNEY_NAMES,
  JOURNEY_TMP_PREFIX,
  journeyTemporaryDirectory,
  journeyApplicationDirectory,
  InventorySchema,
  CANONICAL_PATHS,
  LISTENER_POLICY,
  KEYCHAIN_PREFIX,
  NETWORK_EGRESS,
  NATIVE_RESOURCE_CACHE,
  PROCESS_PREFIXES,
  certify,
  guestAllowed,
  readRegistration,
  systemPorts,
  validateOutputDirectory,
  validateRegistration,
  legacyJourneyOutput,
  type Registration,
} from "./journey-isolation.js";

const names: readonly string[] = JOURNEY_NAMES;
const home = homedir();
const marker = path.join(home, ".opensteer-journeys/active.json");
const json = (file: string, value: unknown) => {
  bindPath(file);
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};
const read = (file: string): unknown => {
  bindPath(file);
  return JSON.parse(readFileSync(file, "utf8"));
};
const constants = {
  listenerPolicy: LISTENER_POLICY,
  temporaryPrefix: JOURNEY_TMP_PREFIX,
  keychainPrefix: KEYCHAIN_PREFIX,
  processPrefixes: PROCESS_PREFIXES,
  canonicalPaths: CANONICAL_PATHS,
  networkEgress: NETWORK_EGRESS,
  nativeResourceCache: NATIVE_RESOURCE_CACHE,
};
let interrupted = false;
let legacyRunning = false;
let legacyGroup: ProcessIdentity | undefined;
let interruptStop: Promise<void> | undefined;
let accepted = false;
const selected: string[] = [];
let registration: Registration | undefined;
let out = "";
let runId = "";
let sha = "";
const prepare: { step: string; seconds: number; exitCode: number }[] = [];
const results: {
  name: string;
  exitCode: number;
  seconds: number;
  outcome: string;
  crashReports: number;
  evidenceError?: string | undefined;
}[] = [];
const head = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
async function record(value = registration, includeMarker = true) {
  if (!value) return;
  validateRegistration(value, home);
  for (const file of [path.join(value.out, "owned.json"), ...(includeMarker ? [marker] : [])]) {
    bindPath(file);
    await replacePrivateFileAtomically(file, JSON.stringify(value, null, 2) + "\n");
  }
}
async function stopGroups(persist = true) {
  if (!registration) return;
  validateRegistration(registration, home);
  await stopRegisteredGroups(registration);
  if (persist) await record();
}
async function execute(command: string, log: string, env = process.env): Promise<number> {
  if (interrupted) return 1;
  validateRegistration(registration, home);
  bindPath(log);
  return launchRegisteredWorkload({
    command,
    log,
    env: { ...env, OPENSTEER_LEGACY_GRACEFUL_STOP: legacyRunning ? "1" : "0" },
    applicationRoot: registration?.temporary.find(
      (binding) => binding.path === env.OPENSTEER_JOURNEY_APPS,
    ),
    interrupted: () => interrupted,
    register: async (identity) => {
      const proposed = { ...registration!, groups: [...registration!.groups, identity] };
      await record(proposed);
      registration = proposed;
      if (legacyRunning) legacyGroup = identity;
    },
  });
}
function manifest(selected: string[]) {
  const { journeys, passed, exitCode } = acceptedRunResult(
    selected,
    results,
    prepare,
    interrupted,
    head() === sha,
  );
  json(path.join(out, "manifest.json"), { runId, sha, passed, prepare, journeys });
  return exitCode;
}
async function flight(phase: "preflight" | "postflight") {
  try {
    const old = readRegistration(marker) ?? readRegistration(path.join(out, "owned.json"));
    if (old) validateRegistration(old, home);
    if (phase === "postflight" && old && old.runId !== runId) throw Error("Active run ID mismatch");
    const ports = systemPorts(home, process.pid, old);
    const baseline =
      phase === "postflight"
        ? z
            .object({ runId: z.string(), clean: z.boolean(), after: InventorySchema })
            .parse(read(path.join(out, "preflight.json")))
        : undefined;
    if (baseline && baseline.runId !== runId) throw Error("Preflight run ID mismatch");
    const report = await certify(phase, ports, baseline?.clean ? baseline.after : undefined);
    // An interrupted marker may be retired only after all other inventories are clean.
    if (
      phase === "preflight" &&
      old &&
      !report.remaining.processes.length &&
      !report.remaining.listeners.length &&
      !report.remaining.apps.length &&
      !report.remaining.keychain.length &&
      !report.remaining.canonical.length &&
      !report.remaining.temporary.length
    ) {
      report.clean = true;
      report.exitCode = 0;
    }
    if (old) await record(old, existsSync(marker));
    if (phase === "postflight" && report.clean) {
      if (existsSync(marker)) {
        rmSync(marker);
        report.removed.push(".opensteer-journeys/active.json");
      }
      report.after.marker = existsSync(marker);
    }
    json(path.join(out, `${phase}.json`), { runId, constants, ...report });
    return report.exitCode;
  } catch (error) {
    const exitCode =
      phase === "postflight"
        ? 4
        : existsSync(marker) || existsSync(path.join(out, "owned.json"))
          ? 3
          : 2;
    json(path.join(out, `${phase}.json`), {
      runId,
      constants,
      clean: false,
      exitCode,
      error: String(error),
    });
    return exitCode;
  }
}
async function main() {
  if (!guestAllowed(home)) throw Error("Use the test guest");
  const args = process.argv.slice(2);
  const legacy = args.length === 0 || !args[0]!.startsWith("--");
  let phase: "preflight" | "postflight" | "run" = "run";
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--preflight" || arg === "--postflight") {
      if (phase !== "run") throw Error("Conflicting phases");
      phase = arg.slice(2) as "preflight" | "postflight";
    } else if (["--run-id", "--out", "--sha"].includes(arg)) {
      const value = args.shift();
      if (!value || value.startsWith("--")) throw Error(`Missing ${arg}`);
      if (arg === "--run-id") runId = value;
      else if (arg === "--out") out = value;
      else sha = value;
    } else if ((names.includes(arg) || arg === "mac-owner") && !selected.includes(arg))
      selected.push(arg);
    else throw Error(`Unknown argument: ${arg}`);
  }
  if (legacy) {
    runId =
      new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z/, "Z") +
      "-" +
      randomBytes(4).toString("hex");
    out = legacyJourneyOutput(home);
    sha = head();
  }
  const initialOutput = validateOutputDirectory(runId, out, home, legacy);
  mkdirSync(out, { recursive: true });
  validatePathBinding(initialOutput);
  if (phase !== "run") return flight(phase);
  if (!selected.length) selected.push(...names);
  if (legacy && (await flight("preflight")) !== 0) return 3;
  const pre = authorizeRun(read(path.join(out, "preflight.json")), runId, sha, head());
  if (
    !legacy &&
    (existsSync(path.join(out, "owned.json")) || existsSync(path.join(out, "manifest.json")))
  )
    throw Error("Run directory already used");
  accepted = true;
  if (!existsSync("/Applications/Xcode.app/Contents/Developer"))
    throw Error("Use Xcode-equipped guest");
  bindPath(path.dirname(marker));
  mkdirSync(path.dirname(marker), { recursive: true });
  registration = {
    version: 2,
    runId,
    out,
    output: bindPath(out),
    groups: [],
    keychain: [],
    temporary: selected.flatMap((name) => [
      bindPath(journeyTemporaryDirectory(runId, name)),
      ...(name === "mac-owner" ? [] : [bindPath(journeyApplicationDirectory(home, runId, name))]),
    ]),
    canonical: CANONICAL_PATHS.filter((p) => !pre.after.canonical.includes(p)).map((p) =>
      bindPath(path.join(home, p)),
    ),
  };
  await record();
  for (const file of ["results.jsonl", "manifest.json"]) {
    const target = path.join(out, file);
    bindPath(target);
    rmSync(target, { force: true });
  }
  const signal = () => {
    interrupted = true;
    interruptStop ??= (async () => {
      if (legacyGroup) await stopLegacyGroup(legacyGroup);
      await stopGroups(false);
    })().catch((error) => console.error(error));
  };
  process.on("SIGTERM", signal);
  process.on("SIGHUP", signal);
  process.on("SIGINT", signal);
  process.env.DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
  let setupFailed = false;
  try {
    setupFailed = !(await prepareAcceptedRun(
      (step, command) => execute(command, path.join(out, `prepare-${step}.log`)),
      () => interrupted,
      prepare,
    ));
    const resourceJourney = runtimeResourceJourney(selected);
    if (!setupFailed && resourceJourney) {
      const resources = path.join(out, resourceJourney, "resources");
      mkdirSync(path.dirname(resources), { recursive: true });
      const source =
        process.env.OPENSTEER_PERSONAL_E2E_RESOURCES ?? path.join(home, NATIVE_RESOURCE_CACHE);
      const start = performance.now();
      const exitCode = await execute(
        'pnpm exec tsx scripts/electron-native-browser-resources.ts "$OPENSTEER_NATIVE_RESOURCE_SOURCE" "$OPENSTEER_NATIVE_RESOURCE_DEST"',
        path.join(out, "prepare-native-resources.log"),
        {
          ...process.env,
          OPENSTEER_NATIVE_RESOURCE_SOURCE: source,
          OPENSTEER_NATIVE_RESOURCE_DEST: resources,
        },
      );
      prepare.push({
        step: "native-resources",
        seconds: (performance.now() - start) / 1000,
        exitCode,
      });
      setupFailed = exitCode !== 0;
      process.env.OPENSTEER_PERSONAL_E2E_RESOURCES = resources;
    }
    if (!setupFailed)
      for (const name of selected) {
        if (interrupted) break;
        const directory = path.join(out, name);
        mkdirSync(journeyTemporaryDirectory(runId, name), { recursive: true, mode: 0o700 });
        if (name !== "mac-owner") {
          const apps = journeyApplicationDirectory(home, runId, name);
          const original = registration.temporary.find((binding) => binding.path === apps)!;
          validatePathBinding(original);
          mkdirSync(apps, { recursive: true });
          validatePathBinding(original);
          registration.temporary = registration.temporary.map((binding) =>
            binding.path === apps ? bindPath(apps) : binding,
          );
          await record();
          for (const sub of ["config", "cache", "data", "downloads"])
            mkdirSync(path.join(directory, sub), { recursive: true });
        }
        const env =
          name === "mac-owner"
            ? {
                ...process.env,
                TMPDIR: journeyTemporaryDirectory(runId, name) + "/",
                OPENSTEER_LEGACY_TEMP_ROOT: journeyTemporaryDirectory(runId, name),
              }
            : {
                ...process.env,
                OPENSTEER_JOURNEY_OUT: directory,
                OPENSTEER_JOURNEY_APPS: journeyApplicationDirectory(home, runId, name),
                OPENSTEER_JOURNEY_KEYCHAIN_PREFIX: `${KEYCHAIN_PREFIX}${runId}-${name}-`,
                TMPDIR: journeyTemporaryDirectory(runId, name) + "/",
                XDG_CONFIG_HOME: path.join(directory, "config"),
                XDG_CACHE_HOME: path.join(directory, "cache"),
                XDG_DATA_HOME: path.join(directory, "data"),
                OPENSTEER_PERSONAL_E2E_ARTIFACT_DIR: directory,
                OPENSTEER_DISPLAY_E2E_ARTIFACT_DIR: directory,
                OPENSTEER_USB_E2E_ARTIFACT_DIR: directory,
                OPENSTEER_STATE_IMPORT_E2E_ARTIFACT_DIR: path.join(directory, "state-import"),
                OPENSTEER_PASSKEY_POLICY_E2E_ARTIFACT_DIR: path.join(directory, "passkey-policy"),
              };
        const startedAt = Date.now();
        const start = performance.now();
        legacyRunning = name === "mac-owner";
        const code = await execute(
          `bash scripts/journey-command.sh ${name}`,
          path.join(out, `${name}.log`),
          env,
        );
        await interruptStop;
        legacyRunning = false;
        legacyGroup = undefined;
        const evidence = await collectJourneyEvidence(
          home,
          startedAt,
          directory,
          name === "mac-owner" ? path.join(home, "opensteer-job/artifacts/mac-owner") : undefined,
        );
        if (evidence.evidenceError) console.error(evidence.evidenceError);
        execFileSync(
          process.execPath,
          [
            "scripts/journey-evidence.mjs",
            out,
            name,
            String(code),
            String((performance.now() - start) / 1000),
            String(evidence.crashReports),
            ...(evidence.evidenceError ? [evidence.evidenceError] : []),
          ],
          { stdio: "inherit" },
        );
        const lines = readFileSync(path.join(out, "results.jsonl"), "utf8").trim().split("\n");
        results.push(
          z
            .object({
              name: z.string(),
              exitCode: z.number(),
              seconds: z.number(),
              outcome: z.string(),
              crashReports: z.number().int().nonnegative(),
              evidenceError: z.string().optional(),
            })
            .parse(JSON.parse(lines.at(-1)!)),
        );
        await stopGroups();
        const ports = systemPorts(home, process.pid, registration);
        await ports.cleanup(ports.collect());
        await record();
        await delay(500);
      }
  } finally {
    await interruptStop;
    await stopGroups();
    const ports = systemPorts(home, process.pid, registration);
    await ports.cleanup(ports.collect());
    await record();
    manifest(selected);
    process.off("SIGTERM", signal);
    process.off("SIGHUP", signal);
    process.off("SIGINT", signal);
  }
  const code = manifest(selected);
  return legacy ? Math.max(code, await flight("postflight")) : code;
}
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    if (accepted) {
      manifest(selected);
      process.exitCode = 1;
    } else process.exitCode = 2;
  });
