import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  journeySteps,
  passkeyJourneySteps,
  JourneyResultSchema,
} from "./native-browser-journey-contract.js";
import { homedir } from "node:os";
import { NativeSmokeArtifacts } from "./electron-native-browser-artifacts.js";
import { watchNativeCaseProcess } from "./electron-native-browser-process.js";

assert.equal(process.platform, "darwin", "Native browser journey requires a macOS VM");
const runFile = promisify(execFile);
assert.match(
  (await runFile("/usr/sbin/sysctl", ["-n", "hw.model"])).stdout,
  /VirtualMac/,
  "Refusing native input outside the VM",
);
const passkeys = process.argv.includes("--passkeys");
const selection = {
  ids: new Set(Object.keys(passkeys ? passkeyJourneySteps : journeySteps)),
  noSerial: false,
  args: [],
};
const watchdogMs = z.coerce
  .number()
  .int()
  .min(60_000)
  .max(60 * 60_000)
  .default(5 * 60_000)
  .parse(process.env.OPENSTEER_NATIVE_SMOKE_WATCHDOG_MS);
const desktop = path.resolve(import.meta.dirname, "..");
const artifactRoot = path.resolve(
  process.env.OPENSTEER_JOURNEY_OUT ??
    path.join(homedir(), "opensteer-job/artifacts/native-browser"),
);
await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
const run = await realpath(
  await mkdtemp(path.join(artifactRoot, `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-`)),
);
const artifacts = new NativeSmokeArtifacts(run, selection.ids);
const captureRequest = z.object({
  type: z.literal("native-window-capture"),
  requestId: z.uuid(),
  pid: z.number().int().positive(),
  windowId: z.number().int().positive(),
  file: z.string().min(1),
});
process.stdout.write(`Native browser smoke artifacts: ${run}\n`);
let childPid: number | undefined;
try {
  await assertScreenUnlocked();
  assert.equal(
    process.platform,
    "darwin",
    "This input/capture harness currently requires macOS; Windows/Linux need native adapters.",
  );
  const resources = process.env.OPENSTEER_PERSONAL_E2E_RESOURCES;
  assert(
    resources,
    "OPENSTEER_PERSONAL_E2E_RESOURCES must name a validated current-source Personal runtime resource tree.",
  );
  const helper = path.join(run, "native-input");
  await command(
    "xcrun",
    [
      "swiftc",
      "-module-cache-path",
      path.join(run, "swift-cache"),
      path.join(desktop, "scripts/electron-native-browser-input.swift"),
      "-o",
      helper,
    ],
    "swift-build",
  );
  const compositeHelper = path.join(run, "capture-owned-composite");
  await command(
    "xcrun",
    [
      "swiftc",
      "-module-cache-path",
      path.join(run, "swift-cache"),
      "-parse-as-library",
      path.join(desktop, "scripts/electron-native-browser-capture.swift"),
      "-o",
      compositeHelper,
    ],
    "swift-capture-build",
  );
  const electron: unknown = createRequire(path.join(desktop, "package.json"))("electron");
  assert.equal(typeof electron, "string");
  const revision = (await runFile("git", ["rev-parse", "HEAD"], { cwd: desktop })).stdout.trim();
  const diff = (
    await runFile("git", ["diff", "HEAD"], { cwd: desktop, maxBuffer: 16 * 1024 * 1024 })
  ).stdout;
  const bundleHashes = Object.fromEntries(
    await Promise.all(
      [
        ".electron-smoke/electron-native-browser-child.js",
        "dist/main.js",
        "dist/preload.cjs",
        "dist/web/index.html",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(path.join(desktop, file)))
          .digest("hex"),
      ]),
    ),
  );
  const provenance = await readFile(
    path.join(resources, "native-smoke-provenance.json"),
    "utf8",
  ).catch(() => null);
  artifacts.json("manifest.json", {
    started: new Date().toISOString(),
    revision,
    diffSha256: createHash("sha256").update(diff).digest("hex"),
    bundleHashes,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    electron,
    resources: path.resolve(resources),
    provenance: provenance ? (JSON.parse(provenance) as unknown) : null,
    rendererSha256: createHash("sha256")
      .update(readFileSync(path.join(desktop, "dist/web/index.html")))
      .digest("hex"),
    requiredVisualEvidence: "owned-window CoreGraphics screenshots; no page screenshot fallback",
    command: passkeys
      ? "pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh passkeys"
      : "pnpm test:vm -- pnpm test:native-browser-journey",
    selection: { ids: [...selection.ids], noSerial: selection.noSerial, args: selection.args },
    watchdogMs,
    execution: passkeys
      ? "two owned Electron launches; notice-only and native-capable"
      : "one owned Electron process tree; serial lifecycle steps",
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENSTEER_NATIVE_SMOKE_RUN: run,
    OPENSTEER_NATIVE_SMOKE_INPUT: helper,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const outcomes: ({ id: string; childPid: number | undefined; directory: string } & Awaited<
    ReturnType<typeof watchNativeCaseProcess>
  >)[] = [];
  for (const id of passkeys ? ["notice", "journey"] : ["journey"]) {
    const expectedIds = passkeys
      ? [id === "notice" ? "passkeys-notice" : "passkeys"]
      : [...selection.ids];
    await assertScreenUnlocked();
    const caseStarted = performance.now();
    const childRun = path.join(run, "case-runs", id);
    await mkdir(path.join(childRun, "logs"), { recursive: true, mode: 0o700 });
    const child = spawn(
      electron as string,
      [
        path.join(import.meta.dirname, "electron-native-browser-child.js"),
        ...(passkeys ? ["--passkeys", ...(id === "notice" ? ["--passkeys-notice"] : [])] : []),
      ],
      {
        cwd: desktop,
        env: { ...env, OPENSTEER_NATIVE_SMOKE_RUN: childRun },
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    childPid = child.pid;
    // Screen Recording is attributed to the responsible app. The shell's Node
    // parent has access; the repo's unsigned Electron bundle does not inherit it.
    let captures = Promise.resolve();
    const captureOwners = new Map<number, { directory: string; parentPid: number }>();
    assert(child.pid);
    captureOwners.set(child.pid, { directory: childRun, parentPid: process.pid });
    child.on("message", (message: unknown) => {
      const registration = z
        .object({
          type: z.literal("native-capture-child"),
          pid: z.number().int().positive(),
          parentPid: z.number().int().positive(),
          directory: z.string(),
        })
        .safeParse(message);
      if (registration.success) {
        const directory = path.resolve(registration.data.directory);
        const parentOwner = captureOwners.get(registration.data.parentPid);
        assert(parentOwner, "Capture child parent must already be registered");
        const relative = path.relative(parentOwner.directory, directory);
        assert(
          relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
          "Nested capture directory must be private to this run",
        );
        assert.notEqual(registration.data.pid, child.pid);
        captureOwners.set(registration.data.pid, {
          directory,
          parentPid: registration.data.parentPid,
        });
        artifacts.event("parent.capture.childRegistered", registration.data);
        return;
      }
      const request = captureRequest.safeParse(message);
      if (!request.success) {
        artifacts.event("parent.capture.rejected", { error: request.error.message });
        return;
      }
      const respond = async () => {
        const attempts: unknown[] = [];
        let result: unknown;
        let observedWindow: unknown;
        try {
          const { pid, windowId, file } = request.data;
          const owner = captureOwners.get(pid);
          assert(owner, "Capture target must be a registered owned Electron child");
          if (pid !== child.pid) {
            const parentPid = Number(
              (
                await runFile("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 5000 })
              ).stdout.trim(),
            );
            assert.equal(
              parentPid,
              owner.parentPid,
              "Nested capture target must descend through its registered owned parent",
            );
          }
          assert(path.isAbsolute(file), "Capture output must be absolute");
          const directory = await realpath(path.dirname(file));
          const relative = path.relative(owner.directory, directory);
          assert(
            relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative),
            "Capture output must stay inside this run's private directory",
          );
          assert.equal(path.extname(file), ".png");
          // Named states may be refreshed by a scenario. Only ordinary files in
          // this private run may be overwritten, never symlink targets.
          await lstat(file).then(
            (metadata) => {
              assert(
                metadata.isFile() && !metadata.isSymbolicLink(),
                "Capture output must be an ordinary file",
              );
            },
            (error: unknown) => {
              assert(z.object({ code: z.literal("ENOENT") }).safeParse(error).success);
            },
          );
          const inventory = z
            .object({
              pid: z.literal(pid),
              window: z.object({
                kCGWindowNumber: z.literal(windowId),
                kCGWindowOwnerPID: z.literal(pid),
                kCGWindowIsOnscreen: z.boolean().optional(),
                kCGWindowBounds: z.object({
                  X: z.number().finite(),
                  Y: z.number().finite(),
                  Width: z.number().positive(),
                  Height: z.number().positive(),
                }),
              }),
            })
            .parse(
              JSON.parse(
                (
                  await runFile(helper, ["capture-window", String(pid), String(windowId)], {
                    timeout: 5_000,
                  })
                ).stdout,
              ),
            );
          observedWindow = inventory;
          const bounds = inventory.window.kCGWindowBounds;
          const modes = [
            {
              method: "owned-composite",
              executable: compositeHelper,
              args: [String(pid), String(windowId), file],
            },
            {
              method: "window",
              executable: "/usr/sbin/screencapture",
              args: ["-x", "-o", "-T", "0", "-l", String(windowId), file],
            },
            ...(inventory.window.kCGWindowIsOnscreen
              ? [
                  {
                    method: "screen-region",
                    executable: "/usr/sbin/screencapture",
                    args: [
                      "-x",
                      "-T",
                      "0",
                      "-R",
                      `${Math.floor(bounds.X)},${Math.floor(bounds.Y)},${Math.ceil(bounds.Width)},${Math.ceil(bounds.Height)}`,
                      file,
                    ],
                  },
                ]
              : []),
          ];
          for (const mode of modes) {
            const startedNs = String(process.hrtime.bigint());
            try {
              const commandResult = await runFile(mode.executable, mode.args, { timeout: 5_000 });
              const bytes = await readFile(file);
              assert(
                bytes.length > 1000 &&
                  bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
                "OS capture did not produce a nonempty PNG",
              );
              attempts.push({
                ...mode,
                startedNs,
                endedNs: String(process.hrtime.bigint()),
                ok: true,
                stdout: commandResult.stdout,
              });
              result = {
                ok: true,
                method: mode.method,
                window: inventory.window,
                attempts,
                parentPid: process.pid,
              };
              break;
            } catch (error) {
              attempts.push({
                ...mode,
                startedNs,
                endedNs: String(process.hrtime.bigint()),
                ok: false,
                error: captureError(error),
              });
            }
          }
          assert(result, "Every OS capture command failed");
        } catch (error) {
          result = {
            ok: false,
            error: captureError(error),
            attempts,
            inventory: observedWindow,
            parentPid: process.pid,
          };
        }
        const response = {
          type: "native-window-capture-result",
          requestId: request.data.requestId,
          result,
        };
        artifacts.json(`logs/window-captures/${request.data.requestId}.json`, {
          request: request.data,
          ...response,
        });
        if (child.connected)
          child.send(response, (error) => {
            if (error)
              artifacts.event("parent.capture.replyFailure", {
                requestId: request.data.requestId,
                error: captureError(error),
              });
          });
      };
      captures = captures.then(respond).catch((error: unknown) => {
        artifacts.event("parent.capture.failure", {
          requestId: request.data.requestId,
          error: captureError(error),
        });
      });
    });
    const stdout = createWriteStream(path.join(childRun, "logs/child-stdout.log"));
    const stderr = createWriteStream(path.join(childRun, "logs/child-stderr.log"));
    assert(child.stdout && child.stderr);
    child.stdout.pipe(stdout);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(stderr);
    let screenFailure: unknown;
    let checkingScreen = false;
    const screenWatch = setInterval(() => {
      if (checkingScreen || screenFailure) return;
      checkingScreen = true;
      void assertScreenUnlocked()
        .catch((error: unknown) => {
          screenFailure = error;
          child.kill("SIGTERM");
        })
        .finally(() => {
          checkingScreen = false;
        });
    }, 2_000);
    const outcome = await watchNativeCaseProcess(child, watchdogMs, () => {
      artifacts.event("parent.caseWatchdog", { id, childPid: child.pid, watchdogMs });
    }).finally(() => clearInterval(screenWatch));
    const parentElapsedMs = performance.now() - caseStarted;
    await captures;
    await Promise.all([
      new Promise<void>((resolve) => stdout.end(resolve)),
      new Promise<void>((resolve) => stderr.end(resolve)),
    ]);
    const prefix = path.relative(run, childRun);
    artifacts.json(`${prefix}/parent-exit.json`, {
      id,
      childPid: child.pid,
      ...outcome,
      observedAt: new Date().toISOString(),
    });
    artifacts.json(`${prefix}/process-cleanup.json`, {
      postgres: outcome.postgresCleanup,
      survivingOwnedPids: outcome.survivingOwnedPids,
      inspectionErrors: outcome.inspectionErrors,
    });
    outcomes.push({ id, childPid: child.pid, directory: prefix, ...outcome });
    const summary = z
      .object({
        cases: z.array(
          z.object({
            id: z.string(),
            status: z.enum(["PASS", "FAIL"]),
            measurements: z.object({ seconds: z.number() }),
            reason: z.string().optional(),
          }),
        ),
      })
      .parse(JSON.parse(await readFile(path.join(childRun, "summary.json"), "utf8")));
    const cleanProcess =
      outcome.code === 0 &&
      !outcome.timedOut &&
      !outcome.survivingOwnedPids.length &&
      !outcome.inspectionErrors.length;
    for (const row of summary.cases) {
      artifacts.result(row.id, row.status, {
        measurements: row.measurements,
        evidence: [`${prefix}/cases/${row.id}/result.json`, `${prefix}/process-cleanup.json`],
        ...(row.reason ? { reason: row.reason } : {}),
      });
    }
    const result = JourneyResultSchema.parse({
      status:
        summary.cases.length === expectedIds.length &&
        expectedIds.every((expected) => summary.cases.some((row) => row.id === expected)) &&
        summary.cases.every((row) => row.status === "PASS")
          ? "PASS"
          : "FAIL",
      steps: summary.cases.map((row) => ({
        id: row.id,
        status: row.status,
        seconds: row.measurements.seconds,
        ...(row.reason ? { error: row.reason } : {}),
      })),
    });
    const final = {
      ...result,
      status: cleanProcess ? result.status : "FAIL",
      process: outcome,
      seconds: parentElapsedMs / 1000,
      run,
    };
    artifacts.json("result.json", final);
    await writeFile(path.join(artifactRoot, "result.json"), JSON.stringify(final, null, 2) + "\n");
    assert.equal(outcome.code, 0, "Journey process failed");
    assert.equal(outcome.timedOut, false);
    assert.deepEqual(outcome.survivingOwnedPids, []);
    assert.deepEqual(outcome.inspectionErrors, []);
    assert.equal(result.status, "PASS");
  }
  if (passkeys) {
    const completed = [...artifacts.results.values()];
    assert.equal(completed.length, selection.ids.size);
    const result = JourneyResultSchema.parse({
      status: completed.every((row) => row.status === "PASS") ? "PASS" : "FAIL",
      steps: completed.map((row) => ({
        id: row.id,
        status: row.status,
        seconds: z.object({ seconds: z.number() }).parse(row.measurements).seconds,
      })),
    });
    const final = { ...result, run, processes: outcomes };
    artifacts.json("result.json", final);
    await writeFile(path.join(artifactRoot, "result.json"), JSON.stringify(final, null, 2) + "\n");
  }
} catch (error) {
  artifacts.json("parent-failure.json", {
    error: error instanceof Error ? error.stack : String(error),
    childPid,
  });
  if (!(await readFile(path.join(run, "summary.json"), "utf8").catch(() => "")))
    artifacts.remaining(
      `Preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  const previous = await readFile(path.join(run, "result.json"), "utf8")
    .then((value) => JourneyResultSchema.parse(JSON.parse(value)))
    .catch(() => null);
  const failure = {
    status: "FAIL",
    run,
    error: error instanceof Error ? error.message : String(error),
    steps:
      previous?.steps ??
      [...selection.ids].map((id) => ({
        id,
        status: "FAIL",
        seconds: 0,
        error: "Not run: journey setup or process failed",
      })),
  };
  artifacts.json("result.json", failure);
  await writeFile(path.join(artifactRoot, "result.json"), JSON.stringify(failure, null, 2) + "\n");
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
await rm(path.join(run, "swift-cache"), { recursive: true, force: true });
process.stdout.write(`Results: ${run}/result.json\n`);

function captureError(error: unknown): unknown {
  const details = z
    .object({
      code: z.union([z.string(), z.number()]).nullable().optional(),
      signal: z.string().nullable().optional(),
      killed: z.boolean().optional(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
    })
    .safeParse(error);
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(details.success ? details.data : {}),
  };
}

async function command(executable: string, args: string[], name: string): Promise<void> {
  const child = spawn(executable, args, { cwd: desktop, stdio: ["ignore", "pipe", "pipe"] });
  const log = createWriteStream(path.join(run, `logs/${name}.log`));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await new Promise<void>((resolve) => log.end(resolve));
  assert.equal(code, 0, `${name} failed; see logs/${name}.log`);
}

async function assertScreenUnlocked(): Promise<void> {
  const consoleSession = (
    await runFile("/usr/sbin/ioreg", ["-n", "Root", "-d1"], { timeout: 3000 })
  ).stdout;
  if (/"(?:CGSSessionScreenIsLocked|IOConsoleLocked)"\s*=\s*Yes/.test(consoleSession)) {
    await writeFile(path.join(run, "BLOCKED.md"), "The Mac locked; certification stopped.\n");
    artifacts.json("BLOCKED.json", {
      reason: "The Mac locked; certification stopped.",
      observedAt: new Date().toISOString(),
    });
    throw new Error("The Mac locked; certification stopped. See BLOCKED.json.");
  }
}
