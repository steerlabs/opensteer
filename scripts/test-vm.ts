import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { setFileMode } from "@opensteer/shared/privateFiles";
import { isNodeError } from "@opensteer/shared/nodeError";
import { tryKernelLock } from "@opensteer/shared/kernelLock";
import { holdQueuedSlot } from "./test-vm/slot-queue.js";
import { holdStorageLock } from "./test-vm/retention.js";
import { payloadThenSlot, timedWait } from "./test-vm/phases.js";
import { authorizeGoldenKey } from "./test-vm/golden-key.js";
import { vmSlotCount } from "./test-vm/slots.js";
import { retainHostStorage } from "./storage-retention.js";

const source = path.resolve(import.meta.dirname, "..");
const state = path.join(homedir(), ".local/state/opensteer");
const cache = path.join(homedir(), ".cache/opensteer/vm");
/** Vitest's shared results (docs/testing.md#integration-databases); guests start from a copy. */
const vitestCache = path.join(homedir(), ".cache/opensteer/vitest");
const locks = path.join(state, "vm/locks");
const gib = 1024 ** 3;
const usage =
  "Usage: pnpm test:vm -- [--mobile] [--inputs DIR] [--revision SHA] COMMAND [ARGS...] | --golden | --mobile-golden --tooling-inputs DIR";
const guiGolden = "opensteer-gui-golden";
const mobileGolden = "opensteer-mobile-golden";
const mobileReceipt = path.join(state, "vm-mobile-golden.json");
const stop = new AbortController();
let signalExitCode = 0;
let cleaning = false;
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
for (const signal of signals) {
  process.on(signal, () => {
    if (cleaning) return;
    signalExitCode = 128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal];
    stop.abort(new Error(`Interrupted by ${signal}`));
  });
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const payloadSchema = z.object({
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  sha256,
  bytes: z.number().int().nonnegative(),
  nativeDistributionSource: z.string(),
  builtAt: z.number(),
});
const toolingFile = z.object({ bytes: z.number().int().positive(), sha256 }).strict();
const toolingSchema = z
  .object({
    xcode: toolingFile.extend({ version: z.literal("27.1"), build: z.literal("27A9275") }),
    runtime: toolingFile.extend({ version: z.literal("27.1"), build: z.literal("24A94425") }),
  })
  .strict();
const inventorySchema = z.array(z.object({ Name: z.string(), State: z.string() }));
const provenanceSchema = z.object({ sourceRevision: z.string(), diffSha256: sha256 });
const releaseSchema = z.object({ binarySha256: sha256 }).passthrough();
const packageSchema = z.object({ packageManager: z.string().regex(/^pnpm@\d+\.\d+\.\d+$/u) });

type Phase = { seconds: number; exitCode?: number };
interface Job {
  runId: string;
  vm: string;
  command: string;
  cpu: number;
  memoryMiB: number;
  startedAt: number;
  phases: Record<string, Phase>;
  hostFreeBytesBefore: number;
  minimumHostFreeBytes: number;
  exitCode?: number;
  [key: string]: unknown;
}
interface RunOptions {
  name: string;
  timeout?: number;
  stdin?: string;
  check?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Retention runs below the floor: freeing space is its point. */
  floor?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellJoin(values: readonly string[]): string {
  return values.map(shellQuote).join(" ");
}

function freeBytes(): number {
  const disk = statfsSync(state);
  return disk.bavail * disk.bsize;
}

function expand(filename: string): string {
  return path.resolve(filename.replace(/^~(?=\/|$)/u, homedir()));
}

async function lock(filename: string, floor = true): Promise<number> {
  while (true) {
    stop.signal.throwIfAborted();
    if (floor && freeBytes() < 30 * gib) throw new Error("Host free space fell below 30 GiB");
    const descriptor = tryKernelLock(filename);
    if (descriptor !== undefined) return descriptor;
    await delay(200);
  }
}

function completion(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? 128 + (signal === "SIGKILL" ? 9 : 15)));
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") throw error;
  }
}

async function terminate(child: ChildProcess, finished: Promise<number>): Promise<void> {
  killGroup(child, "SIGTERM");
  const timer = setTimeout(() => killGroup(child, "SIGKILL"), 3_000);
  try {
    await finished;
  } finally {
    clearTimeout(timer);
    // The group leader may exit before a descendant does.
    killGroup(child, "SIGKILL");
  }
}

async function digest(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    if (!cleaning) stop.signal.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function main(): Promise<void> {
  process.umask(0o077);
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const mobileBootstrap = args[0] === "--mobile-golden";
  const guiBootstrap = args.length === 1 && args[0] === "--golden";
  const goldenMode = guiBootstrap || mobileBootstrap;
  let tooling: string | undefined;
  let manifest: z.infer<typeof toolingSchema> | undefined;
  if (mobileBootstrap) {
    if (args.length !== 3 || args[1] !== "--tooling-inputs") throw new Error(usage);
    tooling = expand(args[2]!);
    if (realpathSync(tooling) !== tooling || !lstatSync(tooling).isDirectory())
      throw new Error("Tooling inputs must be a real directory, without symlink components");
    for (const name of ["manifest.json", "xcode.tar", "runtime.tar"]) {
      const filename = path.join(tooling, name);
      if (!lstatSync(filename).isFile() || realpathSync(filename) !== filename)
        throw new Error(`Tooling input must be a regular non-symlink file: ${name}`);
    }
    manifest = toolingSchema.parse(
      JSON.parse(readFileSync(path.join(tooling, "manifest.json"), "utf8")),
    );
    if (tooling.includes(":"))
      throw new Error("Tooling input path cannot contain a share separator");
    for (const [name, entry] of [
      ["xcode.tar", manifest.xcode],
      ["runtime.tar", manifest.runtime],
    ] as const) {
      const filename = path.join(tooling, name);
      if (statSync(filename).size !== entry.bytes || (await digest(filename)) !== entry.sha256)
        throw new Error(`Tooling input integrity failed: ${name}`);
    }
  }
  const mobileJob = args[0] === "--mobile";
  if (mobileJob) args.shift();
  let inputShare: string | undefined;
  if (args[0] === "--inputs") {
    if (!args[1]) throw new Error(usage);
    inputShare = expand(args[1]!);
    if (
      realpathSync(inputShare) !== inputShare ||
      !lstatSync(inputShare).isDirectory() ||
      inputShare.includes(":")
    )
      throw new Error(
        "Inputs must be a real directory without symlink components or share separators",
      );
    args.splice(0, 2);
  }
  const baseGolden = mobileJob ? mobileGolden : guiGolden;
  let revision = "HEAD";
  if (!goldenMode && args[0] === "--revision") {
    if (args.length < 3) throw new Error(usage);
    revision = args[1]!;
    args.splice(0, 2);
  }
  if (!args.length || (!goldenMode && args[0]!.startsWith("--"))) throw new Error(usage);
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("GUI test VMs require an Apple silicon Mac and Tart.");
  }
  // A bad count is refused before anything is created or queued.
  const count = vmSlotCount();
  for (const directory of [state, cache, locks]) mkdirSync(directory, { recursive: true });
  // macOS runs at most two guests; each guest's vCPU budget bounds its run. A job
  // takes its slot once its payload is ready, so waiting for one holds no guest.
  let slot: { release(): void } | undefined;
  const takeSlot = () =>
    holdQueuedSlot(locks, {
      label: "VM slot",
      count,
      purpose: ["pnpm test:vm", ...process.argv.slice(2)].join(" "),
      signal: stop.signal,
    });
  // The outer finally also covers artifact setup and preflight failures.
  try {
    await execute();
  } finally {
    slot?.release();
  }

  async function execute(): Promise<void> {
    const runId =
      new Date()
        .toISOString()
        .replace(/[-:]/gu, "")
        .replace(/\.\d{3}Z$/u, "Z") +
      "-" +
      randomUUID().slice(0, 8);
    const out = path.join(state, "vm-runs", runId);
    mkdirSync(out, { recursive: true });
    const vm = goldenMode
      ? mobileBootstrap
        ? mobileGolden
        : guiGolden
      : `opensteer-gui-job-${runId}`;
    const initialFree = freeBytes();
    const facts: Job = {
      runId,
      vm,
      baseGolden: mobileBootstrap ? guiGolden : baseGolden,
      command: shellJoin(args),
      // Retention reads the owner: a finished job's or a dead runner's clone may go.
      pid: process.pid,
      checkout: realpathSync(source),
      cpu: 6,
      memoryMiB: 16384,
      startedAt: Date.now() / 1000,
      phases: {},
      hostFreeBytesBefore: initialFree,
      minimumHostFreeBytes: initialFree,
    };
    const key = expand(
      process.env.OPENSTEER_VM_SSH_KEY ?? path.join(state, "vm-golden/id_ed25519"),
    );
    let boot: ChildProcess | undefined;
    let bootFinished: Promise<number> | undefined;
    let cloned = false;
    let ssh: string[] | undefined;
    let succeeded = false;
    let exportCode: number | undefined;
    let failure: unknown;

    function save(): void {
      const temporary = path.join(out, "job.json.tmp");
      writeFileSync(temporary, JSON.stringify(facts, null, 2));
      renameSync(temporary, path.join(out, "job.json"));
    }

    async function run(
      argv: string[],
      options: RunOptions,
    ): Promise<{ code: number; output: string }> {
      if (!cleaning) stop.signal.throwIfAborted();
      const started = performance.now();
      const log = openSync(path.join(out, `${options.name}.log`), "a", 0o600);
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", log],
        detached: true,
      });
      const finished = completion(child);
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        // Keep command logs on disk; only small query results are needed in memory.
        writeFileSync(log, chunk);
        output = (output + chunk.toString("utf8")).slice(-4 * 1024 * 1024);
      });
      child.stdin?.on("error", () => undefined);
      if (options.stdin !== undefined) child.stdin?.end(options.stdin);
      let code = 1;
      let commandFailure: Error | undefined;
      let termination: Promise<void> | undefined;
      const abort = (error: Error) => {
        if (commandFailure) return;
        commandFailure = error;
        termination = terminate(child, finished);
        void termination.catch(() => undefined);
      };
      const canceled = () => abort(new Error("VM command interrupted"));
      if (!cleaning) stop.signal.addEventListener("abort", canceled, { once: true });
      const poll = setInterval(() => {
        try {
          const free = freeBytes();
          facts.minimumHostFreeBytes = Math.min(facts.minimumHostFreeBytes, free);
          if (
            options.floor !== false &&
            !["export", "stop", "delete", "remove-build-checkout"].includes(options.name) &&
            free < 30 * gib
          ) {
            abort(new Error("Host free space fell below 30 GiB"));
          }
          if (performance.now() - started > (options.timeout ?? 180) * 1000) {
            abort(new Error(`${options.name} timed out`));
          }
        } catch (error) {
          abort(error instanceof Error ? error : new Error(String(error)));
        }
      }, 200);
      try {
        code = await finished;
        if (termination) await termination;
        if (commandFailure) throw commandFailure;
        if (options.check !== false && code !== 0)
          throw new Error(`${options.name} failed (exit ${code}); see ${out}`);
        return { code, output };
      } finally {
        clearInterval(poll);
        stop.signal.removeEventListener("abort", canceled);
        closeSync(log);
        facts.phases[options.name] = {
          seconds: (performance.now() - started) / 1000,
          exitCode: code,
        };
        save();
      }
    }

    async function query(argv: string[], name: string, timeout = 30): Promise<string> {
      return (await run(argv, { name, timeout })).output.trim();
    }

    async function inventory() {
      return inventorySchema.parse(
        JSON.parse(await query(["tart", "list", "--format", "json"], "inventory")),
      );
    }

    async function virtualizationPids(): Promise<number[]> {
      const rows = await query(["ps", "-axo", "pid=,comm="], "process-inventory");
      return rows
        .split("\n")
        .filter((row) => row.trimEnd().endsWith("/com.apple.Virtualization.VirtualMachine"))
        .map((row) => Number(row.trim().split(/\s+/u)[0]));
    }

    async function launch(shares: string[]): Promise<void> {
      const started = performance.now();
      const previous = new Set(await virtualizationPids());
      const log = openSync(path.join(out, "boot.log"), "a", 0o600);
      try {
        boot = spawn(
          "tart",
          ["run", vm, "--no-graphics", "--no-audio", "--no-clipboard", ...shares],
          {
            stdio: ["ignore", log, log],
            detached: true,
          },
        );
        bootFinished = completion(boot);
        // Attach immediately, even if spawn fails before the first SSH query.
        void bootFinished.catch(() => undefined);
      } finally {
        closeSync(log);
      }
      facts.tartPid = boot.pid;
      const ip = await query(["tart", "ip", vm, "--wait", "120"], "ip", 125);
      ssh = [
        "ssh",
        "-i",
        key,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=3",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `UserKnownHostsFile=${path.join(out, "known_hosts")}`,
        `admin@${ip}`,
      ];
      if (guiBootstrap && !facts.provisioned) {
        const askpass = path.join(out, "askpass");
        writeFileSync(askpass, '#!/bin/sh\nprintf "%s\\n" admin\n', { mode: 0o700 });
        Object.assign(process.env, {
          SSH_ASKPASS: askpass,
          SSH_ASKPASS_REQUIRE: "force",
          DISPLAY: ":0",
        });
        ssh = [
          "ssh",
          "-o",
          "ConnectTimeout=3",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `UserKnownHostsFile=${path.join(out, "known_hosts")}`,
          `admin@${ip}`,
        ];
      }
      while (true) {
        if (
          boot.exitCode !== null ||
          boot.signalCode !== null ||
          performance.now() - started > 150_000
        ) {
          throw new Error("Guest did not become SSH-ready");
        }
        const ok = await run([...ssh, "true"], { name: "ssh-poll", timeout: 10, check: false });
        if (ok.code === 0) break;
        await delay(1000);
      }
      facts.phases.bootToSsh = { seconds: (performance.now() - started) / 1000 };
      facts.ip = ip;
      facts.virtualizationPids = (await virtualizationPids()).filter((pid) => !previous.has(pid));
      save();
    }

    async function preparePayload(actual: string): Promise<string> {
      const destination = path.join(cache, actual);
      const descriptor = await timedWait(facts.phases, "payload-lock-wait", () =>
        lock(path.join(cache, `${actual}.lock`)),
      );
      try {
        const manifest = path.join(destination, "payload.json");
        let payload: z.infer<typeof payloadSchema>;
        let built = false;
        if (existsSync(manifest)) {
          payload = payloadSchema.parse(JSON.parse(readFileSync(manifest, "utf8")));
          facts.buildCacheHit = true;
        } else {
          facts.buildCacheHit = false;
          const seed = expand(
            process.env.OPENSTEER_VM_NATIVE_RESOURCES ?? path.join(cache, "native-resources"),
          );
          if (!existsSync(path.join(seed, "personal-runtime/release.json"))) {
            throw new Error(
              "Set OPENSTEER_VM_NATIVE_RESOURCES to validated native smoke resources (see docs/testing.md).",
            );
          }
          const temporary = path.join(cache, `${actual}.building-${runId}`);
          const buildSource = path.join(temporary, "src");
          let storage: number | undefined;
          try {
            storage = await timedWait(facts.phases, "storage-wait", async () => {
              await retainHostStorage({ source, signal: stop.signal });
              return holdStorageLock(state, "shared", stop.signal);
            });
            mkdirSync(temporary);
            await run(["git", "worktree", "add", "--detach", buildSource, actual], {
              name: "checkout",
              cwd: source,
            });
            await run(["pnpm", "install", "--frozen-lockfile"], {
              name: "install",
              timeout: 600,
              cwd: buildSource,
            });
            await run(["pnpm", "--filter", "@opensteer/desktop", "build"], {
              name: "build-desktop",
              timeout: 600,
              cwd: buildSource,
            });
            await run(
              ["pnpm", "--filter", "@opensteer/desktop", "build:electron-native-browser-smoke"],
              { name: "build-smoke", timeout: 300, cwd: buildSource },
            );
            await run(
              [
                "pnpm",
                "exec",
                "tsx",
                "apps/desktop/scripts/electron-native-browser-resources.ts",
                seed,
                path.join(temporary, "resources"),
              ],
              { name: "build-resources", timeout: 600, cwd: buildSource },
            );
            await run(
              [
                "pnpm",
                "--filter",
                "@opensteer/desktop",
                "exec",
                "node",
                "-e",
                "require(require('node:path').join(require.resolve('electron/package.json'), '..', 'install.js'))",
              ],
              { name: "install-electron", timeout: 300, cwd: buildSource },
            );
            const supervisor = path.join(temporary, "resources/process-supervisor");
            const binary = path.join(supervisor, "opensteer-process-supervisor");
            await setFileMode(binary, 0o700);
            copyFileSync(
              path.join(
                buildSource,
                "apps/desktop/generated-native/darwin-arm64/opensteer-process-supervisor",
              ),
              binary,
            );
            const release = path.join(supervisor, "release.json");
            const metadata = releaseSchema.parse(JSON.parse(readFileSync(release, "utf8")));
            metadata.binarySha256 = await digest(binary);
            await setFileMode(release, 0o600);
            writeFileSync(release, JSON.stringify(metadata));
            const provenance = provenanceSchema.parse(
              JSON.parse(
                readFileSync(
                  path.join(temporary, "resources/native-smoke-provenance.json"),
                  "utf8",
                ),
              ),
            );
            if (
              provenance.sourceRevision !== actual ||
              provenance.diffSha256 !== createHash("sha256").digest("hex")
            ) {
              throw new Error("Resources do not match the clean source SHA.");
            }
            const archive = path.join(temporary, "payload.tar");
            await run(
              ["tar", "--exclude=src/.git", "-cf", archive, "-C", temporary, "src", "resources"],
              {
                name: "package",
                timeout: 600,
                env: { COPYFILE_DISABLE: "1" },
              },
            );
            payload = {
              sourceSha: actual,
              sha256: await digest(archive),
              bytes: statSync(archive).size,
              nativeDistributionSource: seed,
              builtAt: Date.now() / 1000,
            };
            await run(["git", "worktree", "remove", "--force", buildSource], {
              name: "remove-build-checkout",
              cwd: source,
            });
            rmSync(path.join(temporary, "resources"), { recursive: true, force: true });
            writeFileSync(path.join(temporary, "payload.json"), JSON.stringify(payload, null, 2));
            stop.signal.throwIfAborted();
            if (existsSync(destination)) rmSync(destination, { recursive: true });
            renameSync(temporary, destination);
            built = true;
          } finally {
            // Build teardown must run even when the abort signal is already set.
            const wasCleaning = cleaning;
            cleaning = true;
            try {
              if (existsSync(buildSource))
                await run(["git", "worktree", "remove", "--force", buildSource], {
                  name: "remove-build-checkout",
                  cwd: source,
                });
              rmSync(temporary, { recursive: true, force: true });
            } finally {
              cleaning = wasCleaning;
              if (storage !== undefined) closeSync(storage);
            }
          }
        }
        // This job hashed a payload it built moments ago; a cached one is verified again.
        if (
          payload.sourceSha !== actual ||
          (!built && (await digest(path.join(destination, "payload.tar"))) !== payload.sha256)
        ) {
          throw new Error(
            `Payload integrity check failed; remove this SHA cache and retry: ${destination}`,
          );
        }
        facts.payload = payload;
        // Retention keeps the configured most recently used payloads.
        writeFileSync(path.join(destination, "last-used"), `${runId}\n`);
        save();
        return destination;
      } finally {
        closeSync(descriptor);
      }
    }

    /** Reclaims old outputs, then requires working space; after checks that need no lock. */
    async function admitStorage(): Promise<void> {
      // Old outputs go first, so the floor counts what they freed. The admission
      // lock keeps other jobs from cloning or booting meanwhile.
      const retention = await lock(path.join(locks, "admission"), false);
      try {
        const output = async (argv: string[], name: string) =>
          (await run(argv, { name, timeout: 60, floor: false })).output;
        const log = (line: string) => appendFileSync(path.join(out, "retention.log"), `${line}\n`);
        try {
          facts.retentionReclaimedBytes = await retainHostStorage({
            source,
            vm: {
              vms: async () =>
                inventorySchema.parse(
                  JSON.parse(
                    await output(["tart", "list", "--format", "json"], "retention-inventory"),
                  ),
                ),
              // pgrep exits 1 only when nothing matches; an error keeps the clone.
              running: async (name) =>
                (
                  await run(["pgrep", "-f", "--", name], {
                    name: "retention-processes",
                    timeout: 60,
                    check: false,
                    floor: false,
                  })
                ).code !== 1,
              deleteVm: async (name) => {
                await output(["tart", "delete", name], "retention-delete");
              },
            },
            log,
            signal: stop.signal,
          });
        } catch (error) {
          // Only cancellation stops the job; space it could not reclaim meets the floor below.
          stop.signal.throwIfAborted();
          facts.retentionError = error instanceof Error ? error.message : String(error);
          log(`retention stopped: ${facts.retentionError}`);
        }
      } finally {
        closeSync(retention);
      }
      if (freeBytes() < 40 * gib)
        throw new Error("Need 40 GiB free before admission (30 GiB floor plus working space)");
    }

    console.log(out);
    save();
    try {
      facts.checkoutHead = await query(["git", "-C", source, "rev-parse", "HEAD"], "checkout-head");
      if (goldenMode) {
        // A golden build keeps its slot from the start.
        slot = await timedWait(facts.phases, "slot-wait", takeSlot);
        await timedWait(facts.phases, "storage-admission", admitStorage);
        const admission = await lock(path.join(locks, "admission"));
        try {
          const rows = await inventory();
          if (rows.some((row) => row.Name === vm))
            throw new Error(`Refusing to overwrite existing golden: ${vm}`);
          if (rows.filter((row) => row.State === "running").length >= 2)
            throw new Error("Two Tart guests already running");
          if (mobileBootstrap) {
            if (await query(["git", "-C", source, "status", "--porcelain"], "source-status"))
              throw new Error("Source must be clean before mobile bootstrap");
            if (!rows.some((row) => row.Name === guiGolden && row.State === "stopped"))
              throw new Error("GUI golden must exist and be stopped for mobile bootstrap");
            if (!existsSync(key)) throw new Error("Existing GUI golden SSH key is required");
          }
          const provision = path.join(out, "provision");
          cpSync(path.join(import.meta.dirname, "test-vm"), provision, { recursive: true });
          if (mobileBootstrap)
            writeFileSync(
              path.join(provision, "mobile-input-manifest.json"),
              JSON.stringify(manifest),
              {
                mode: 0o600,
              },
            );
          copyFileSync(
            path.join(source, "apps/desktop/scripts/electron-native-browser-input.swift"),
            path.join(provision, "native-input.swift"),
          );
          if (!mobileBootstrap)
            facts.goldenKey = await authorizeGoldenKey({
              key,
              authorizedKeys: path.join(provision, "authorized_keys"),
              generate: () =>
                run(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", key], {
                  name: "generate-key",
                }),
              derivePublic: () => query(["ssh-keygen", "-y", "-f", key], "check-key"),
            });
          const tools = path.join(out, "tools");
          if (!mobileBootstrap) {
            mkdirSync(tools);
            copyFileSync(realpathSync(process.execPath), path.join(tools, "node"));
            const manager = packageSchema.parse(
              JSON.parse(readFileSync(path.join(source, "package.json"), "utf8")),
            ).packageManager;
            await run(["npm", "pack", "--ignore-scripts", manager, "--pack-destination", out], {
              name: "download-pnpm",
            });
            await run(
              ["tar", "-xzf", path.join(out, `pnpm-${manager.slice(5)}.tgz`), "-C", tools],
              {
                name: "unpack-pnpm",
              },
            );
            renameSync(path.join(tools, "package"), path.join(tools, "pnpm-package"));
            writeFileSync(
              path.join(tools, "pnpm"),
              '#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/pnpm-package/bin/pnpm.cjs" "$@"\n',
              { mode: 0o700 },
            );
          }
          cloned = true;
          process.env.TART_NO_AUTO_PRUNE = "1";
          const base = mobileBootstrap
            ? guiGolden
            : "ghcr.io/cirruslabs/macos-tahoe-base@sha256:4aaa751fa7538902d73c767f27a066fc87e83f183069da4e4b5022863abd4c77";
          facts.baseImage = base;
          await run(["tart", "clone", base, vm], { name: "clone", timeout: 1800 });
          await run(
            [
              "tart",
              "set",
              vm,
              "--cpu",
              "6",
              "--memory",
              "16384",
              "--display",
              "1280x800px",
              "--no-display-refit",
            ],
            { name: "configure" },
          );
          if (mobileBootstrap) {
            await run(["tart", "set", vm, "--disk-size", "100"], { name: "expand-mobile-disk" });
            facts.tooling = manifest;
          }
          const shares = [
            `--dir=provision:${provision}:ro`,
            ...(mobileBootstrap ? [`--dir=tooling:${tooling!}:ro`] : [`--dir=tools:${tools}:ro`]),
            `--dir=artifacts:${out}`,
          ];
          await launch(shares);
          await run(
            [
              ...ssh!,
              `bash "/Volumes/My Shared Files/provision/${mobileBootstrap ? "provision-mobile.sh" : "provision-guest.sh"}"`,
            ],
            {
              name: "provision",
              timeout: 1200,
            },
          );
          facts.provisioned = true;
          await shutdown("shutdown");
          await launch(shares);
          await run(
            [
              ...ssh!,
              `bash "/Volumes/My Shared Files/provision/${mobileBootstrap ? "verify-mobile.sh" : "verify-permissions.sh"}"`,
            ],
            {
              name: "cold-verify",
              timeout: mobileBootstrap ? 300 : 180,
            },
          );
          await shutdown("cold-shutdown");
          if (mobileBootstrap) {
            const temporary = `${mobileReceipt}.${runId}.tmp`;
            writeFileSync(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
            renameSync(temporary, mobileReceipt);
          }
          succeeded = true;
        } finally {
          closeSync(admission);
        }
      } else {
        const actual = await query(
          [
            "git",
            "-C",
            source,
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${revision}^{commit}`,
          ],
          "revision",
        );
        if (await query(["git", "-C", source, "status", "--porcelain"], "source-status"))
          throw new Error(
            "Source must be clean, including untracked files; commit before running VM tests.",
          );
        if (!existsSync(key))
          throw new Error(
            "Golden SSH key missing: run pnpm test:vm:golden or set OPENSTEER_VM_SSH_KEY.",
          );
        if (mobileJob) {
          facts.tooling = toolingSchema.parse(JSON.parse(readFileSync(mobileReceipt, "utf8")));
        }
        facts.sha = actual;
        await timedWait(facts.phases, "storage-admission", admitStorage);
        const prepared = await payloadThenSlot({
          phases: facts.phases,
          preparePayload: () => preparePayload(actual),
          takeSlot,
        });
        slot = prepared.slot;
        const payloadDir = prepared.payload;
        const common = await query(
          ["git", "-C", source, "rev-parse", "--path-format=absolute", "--git-common-dir"],
          "git-common-dir",
        );
        const admission = await lock(path.join(locks, "admission"));
        try {
          const rows = await inventory();
          if (!rows.some((row) => row.Name === baseGolden && row.State === "stopped"))
            throw new Error("Golden must exist and be stopped; see pnpm test:vm:golden");
          if (rows.filter((row) => row.State === "running").length >= 2)
            throw new Error("Two Tart guests already running");
          cloned = true;
          process.env.TART_NO_AUTO_PRUNE = "1";
          await run(["tart", "clone", baseGolden, vm], { name: "clone" });
          await run(
            [
              "tart",
              "set",
              vm,
              "--cpu",
              "6",
              "--memory",
              "16384",
              "--display",
              "1280x800px",
              "--no-display-refit",
            ],
            { name: "configure" },
          );
          await launch([
            `--dir=payload:${payloadDir}:ro`,
            ...(inputShare ? [`--dir=inputs:${inputShare}:ro`] : []),
            `--dir=git:${common}:ro`,
            ...(existsSync(vitestCache) ? [`--dir=vitest-cache:${vitestCache}:ro`] : []),
            `--dir=artifacts:${out}`,
          ]);
        } finally {
          closeSync(admission);
        }
        const guest = String.raw`set -euo pipefail
export PATH="$HOME/opensteer-tools:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" LANG=en_US.UTF-8
share='/Volumes/My Shared Files'
root="$HOME/opensteer-job"
mkdir -p "$root/src" "$root/artifacts"
git init -q "$root/src"
git -C "$root/src" fetch --depth=1 "$share/git" "$1"
git -C "$root/src" checkout --detach FETCH_HEAD
tar -xf "$share/payload/payload.tar" -C "$root" --no-same-owner
test "$(git -C "$root/src" rev-parse HEAD)" = "$1"
test -z "$(git -C "$root/src" status --porcelain --untracked-files=no)"
if [ -d "$share/vitest-cache" ]; then
  mkdir -p "$HOME/.cache/opensteer"
  cp -R "$share/vitest-cache" "$HOME/.cache/opensteer/vitest"
fi
node --version
pnpm --version
sw_vers
stat -f '%Su %u' /dev/console
`;
        // The toolchain check reads only Xcode and the simulator, so it overlaps staging.
        const setup = await Promise.allSettled([
          run([...ssh!, `/bin/bash -s -- ${shellQuote(actual)}`], {
            name: "staging",
            timeout: 600,
            stdin: guest,
          }),
          ...(mobileJob
            ? [
                run([...ssh!, "bash -s -- --inventory"], {
                  name: "mobile-toolchain",
                  stdin: readFileSync(
                    path.join(import.meta.dirname, "test-vm/verify-mobile.sh"),
                    "utf8",
                  ),
                }),
              ]
            : []),
        ]);
        for (const result of setup) if (result.status === "rejected") throw result.reason;
        const remote =
          'set -e; export PATH="$HOME/opensteer-tools:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" LANG=en_US.UTF-8; cd "$HOME/opensteer-job/src/apps/desktop"; export OPENSTEER_PERSONAL_E2E_RESOURCES="$HOME/opensteer-job/resources" OPENSTEER_PERSONAL_E2E_ARTIFACT_DIR="$HOME/opensteer-job/artifacts/native" OPENSTEER_QUIT_E2E_ARTIFACT_DIR="$HOME/opensteer-job/artifacts/quit"; ';
        facts.suiteStartedAt = Date.now() / 1000;
        const result = await run(
          [...ssh!, `/bin/bash -c ${shellQuote(remote + shellJoin(args))}`],
          { name: "suite", timeout: 1800, check: false },
        );
        facts.suiteEndedAt = Date.now() / 1000;
        facts.exitCode = result.code;
        succeeded = result.code === 0;
      }
      facts.exitCode ??= 0;
    } catch (error) {
      failure = error;
      facts.exitCode = signalExitCode || 1;
      facts.error = error instanceof Error ? error.message : String(error);
    } finally {
      cleaning = true;
      if (ssh && !goldenMode) {
        try {
          exportCode = (
            await run(
              [
                ...ssh,
                'rsync -a --exclude="*.app" --exclude="resources/" --exclude="connector-resources/" "$HOME/opensteer-job/artifacts/" "/Volumes/My Shared Files/artifacts/guest/"',
              ],
              { name: "export", timeout: 120, check: false },
            )
          ).code;
        } catch (error) {
          facts.exportError = String(error);
        }
      }
      if (cloned) {
        const started = performance.now();
        try {
          const result = await run(["tart", "stop", vm], {
            name: "stop",
            timeout: 20,
            check: false,
          });
          if (result.code !== 0) facts.stopError = `tart stop exited ${result.code}`;
        } catch (error) {
          facts.stopError = String(error);
        }
        if (boot && bootFinished) {
          try {
            await terminate(boot, bootFinished);
          } catch (error) {
            facts.stopError = String(error);
          }
        }
        if (!goldenMode || !succeeded) {
          try {
            await run(["tart", "delete", vm], { name: "delete", timeout: 30 });
          } catch (error) {
            facts.deleteError = String(error);
          }
        }
        facts.phases.teardown = { seconds: (performance.now() - started) / 1000 };
      }
      facts.endedAt = Date.now() / 1000;
      facts.hostFreeBytesAfter = freeBytes();
      try {
        const rows = await inventory();
        facts.cloneDeleted = cloned ? !rows.some((row) => row.Name === vm) : null;
        if (
          cloned &&
          (!goldenMode || !succeeded
            ? !facts.cloneDeleted
            : !rows.some((row) => row.Name === vm && row.State === "stopped"))
        ) {
          facts.exitCode = 1;
          failure = new Error(`VM cleanup failed; inspect ${out}`);
        }
        if (succeeded && !goldenMode && exportCode !== 0) {
          facts.exitCode = 1;
          failure = new Error(`Artifact export failed; inspect ${out}`);
        }
      } catch (error) {
        facts.exitCode = 1;
        facts.cleanupError = String(error);
        failure = error;
      }
      if (mobileBootstrap && cloned && failure) rmSync(mobileReceipt, { force: true });
      if (mobileBootstrap && succeeded && !failure) facts.mobileGoldenReady = true;
      save();
    }
    if (failure) throw failure;
    process.exitCode = facts.exitCode;

    async function shutdown(name: string): Promise<void> {
      await run([...ssh!, "sudo shutdown -h now"], { name, check: false });
      if (!boot || !bootFinished) throw new Error("Guest was not started");
      const stopped = bootFinished;
      await new Promise<void>((resolve, reject) => {
        const canceled = () => reject(new Error("Guest shutdown interrupted"));
        const timer = setTimeout(
          () => reject(new Error("Guest did not stop within 60 seconds")),
          60_000,
        );
        stop.signal.addEventListener("abort", canceled, { once: true });
        void stopped
          .then(() => resolve(), reject)
          .finally(() => {
            clearTimeout(timer);
            stop.signal.removeEventListener("abort", canceled);
          });
        if (stop.signal.aborted) canceled();
      });
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = signalExitCode || 1;
}
