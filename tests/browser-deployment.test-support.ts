import {
  hostApiVersion,
  hostApiVersionHeader,
} from "../packages/deployment-authority/src/index.js";
import {
  configurePersonalRemoteAccess,
  enrollmentToken,
} from "../apps/host/src/runtime/personal-machine.test-support.js";
import { execFileSync } from "node:child_process";
import { createPublicKey, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { afterEach, describe, expect, vi } from "vitest";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import {
  startVerticalStack,
  type VerticalStack,
} from "../apps/host/src/agents/vertical-stack.test-support.js";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  defaultAttachTicketReplayLedgerPath,
  Ed25519AttachTicketVerifier,
  sessionFilesRoot,
  type LaunchedBrowser,
} from "../packages/browser-runtime-core/src/index.js";
import { CodexHarnessDriver } from "../packages/harness-codex/src/codex-driver.js";
import {
  HarnessRegistry,
  isolatedServiceHarnessRuntimeBoundary,
} from "../packages/harness/src/index.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
export const executablePath = [
  process.env.OPENSTEER_CHROMIUM_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
export const run = databaseUrl && executablePath ? describe : describe.skip;
const fakeCodex = fileURLToPath(
  new URL("../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs", import.meta.url),
);
export const browserHarness = fileURLToPath(
  new URL("../apps/runner/browser-harness/browser-harness.mjs", import.meta.url),
);

const cleanup: Array<{
  readonly label: string;
  readonly run: () => Promise<unknown>;
  readonly stage: number;
}> = [];
export function addCleanup(label: string, run: () => Promise<unknown>, stage = 1): void {
  cleanup.push({ label, run, stage });
}

export function browserCleanupArtifactDirectory(): string {
  return (
    process.env.OPENSTEER_BROWSER_CLEANUP_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), `opensteer-browser-cleanup-${process.pid}`)
  );
}

afterEach(async (context) => {
  const directory = browserCleanupArtifactDirectory();
  await mkdir(directory, { recursive: true });
  const report = path.join(directory, `${randomUUID()}.jsonl`);
  const failures: unknown[] = [];
  for (const { label, run } of cleanup
    .splice(0)
    .reverse()
    .sort((a, b) => a.stage - b.stage)) {
    const started = performance.now();
    const record = (outcome: string, error?: unknown) =>
      appendFile(
        report,
        JSON.stringify({
          test: context.task.name,
          label,
          outcome,
          elapsedMs: performance.now() - started,
          ...(error ? { error: inspect(error, { depth: 8 }) } : {}),
        }) + "\n",
      );
    await record("started");
    try {
      await run();
      await record("closed");
    } catch (error) {
      failures.push(new Error(`Cleanup of ${label} failed`, { cause: error }));
      await record("failed", error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Browser Sessions cleanup failed");
}, 90_000);

export async function deployment(
  browser: Pick<Browser, "runtimeId" | "bridgeToken" | "url" | "close"> | undefined,
  options: {
    readonly scenario?: string;
    readonly maxConcurrentRuns?: number;
    readonly activityClock?: import("@opensteer/shared/clock").Clock;
  } = {},
): Promise<VerticalStack> {
  const harnesses = () => {
    const registry = new HarnessRegistry();
    registry.registerDriver(
      new CodexHarnessDriver({
        launch: {
          arguments: [
            fakeCodex,
            `--scenario=${options.scenario ?? "browser-agent"}`,
            "--unique-threads",
          ],
          executable: process.execPath,
        },
      }),
    );
    return registry;
  };
  const stack = await startVerticalStack({
    ...(browser ? { browser, beforeHostClose: () => browser.close() } : {}),
    ...(options.activityClock ? { browserActivityClock: options.activityClock } : {}),
    browserHarnessExecutable: browserHarness,
    catalogTimeoutMs: 15_000,
    databaseUrl: databaseUrl!,
    harnesses,
    harnessInstance: { config: {}, driverKind: "codex", sourceId: "openai", stateKind: "isolated" },
    harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
    runTimeoutMs: 90_000,
    maxConcurrentRuns: options.maxConcurrentRuns ?? 1,
  });
  addCleanup("deployment", () => stack.close(), 0);
  // The stack owns browser teardown ordering, including cancellation during startup.
  return stack;
}

export async function browserAvailable(stack: VerticalStack): Promise<void> {
  await waitFor(async () => {
    const bootstrap = await stack.api["bootstrap.get"]({});
    return bootstrap.ok && bootstrap.data.browser.available;
  }, 30_000);
}

export interface Browser {
  readonly runtimeId: string;
  readonly bridgeToken: string;
  readonly url: URL;
  health(): ReturnType<BrowserRuntime["health"]>;
  close(): Promise<void>;
}

/** This computer's Chromium behind the loopback bridge its Runner relays for. */
export async function startBrowser(
  options: {
    onLaunch?: (
      browser: LaunchedBrowser,
      request: import("../packages/browser-runtime-core/src/index.js").BrowserLaunchRequest,
    ) => void;
  } = {},
): Promise<Browser> {
  const profileRoot = await mkdtemp(path.join(tmpdir(), "opensteer-browser-e2e-"));
  addCleanup("local browser files", () => rm(profileRoot, { force: true, recursive: true }));
  const bridgeToken = randomBytes(32).toString("base64url");
  const keys = new Map<string, KeyObject>();
  const launcher = new PlaywrightChromiumLauncher({
    chromiumSandbox: false,
    executablePath: executablePath!,
    headless: true,
  });
  const runtime = new BrowserRuntime({
    localProfiles: { root: profileRoot },
    launcher: {
      localProfiles: launcher.localProfiles,
      launch: async (request, signal) => {
        const browser = await launcher.launch(request, signal);
        options.onLaunch?.(browser, request);
        return browser;
      },
    },
    runtimeId: "browser-e2e",
    sessionFilesRoot: sessionFilesRoot(profileRoot),
    ticketVerifier: await Ed25519AttachTicketVerifier.create({
      replayLedgerPath: defaultAttachTicketReplayLedgerPath(profileRoot),
      resolvePublicKey: (keyId) => keys.get(keyId) ?? null,
    }),
  });
  const server = new BrowserRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    relayBridge: {
      token: bridgeToken,
      updateAttachKeys: (entries) => {
        keys.clear();
        for (const entry of entries) keys.set(entry.keyId, createPublicKey(entry.publicKeyPem));
      },
    },
    runtime,
  });
  const address = await server.start();
  return {
    runtimeId: "browser-e2e",
    bridgeToken,
    health: () => runtime.health(),
    close: async () => {
      await server.close();
      expect(runtime.health()).toMatchObject({
        state: "closed",
        sessionCount: 0,
        profileHostCount: 0,
      });
    },
    url: new URL(`http://${address.host}:${address.port}/`),
  };
}

/** An abrupt Chromium exit: nothing is saved on the way down. */
export function killChromium(parentPid: number): void {
  const pids = execFileSync("pgrep", ["-P", String(parentPid), "-f", executablePath!], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) process.kill(Number(pid), "SIGKILL");
}

export async function createProfile(
  stack: VerticalStack,
  name = "Marketplace account",
): Promise<string> {
  const machines = await stack.api["machines.list"]({});
  if (!machines.ok) throw new Error(machines.error.message);
  const browserComputers = machines.data.machines.filter((machine) => machine.modules.browser);
  expect(browserComputers).toHaveLength(1);
  const created = await stack.api["commands.dispatch"]({
    idempotencyKey: randomUUID(),
    input: { name, homeRunnerId: browserComputers[0]!.id },
    type: "browser.profile.create",
  });
  if (!created.ok || created.data.type !== "browser.profile.create") {
    throw new Error("Could not create the profile");
  }
  return created.data.profile.id;
}

export async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  await vi.waitFor(
    async () => expect(await predicate(), "Deployment state did not become ready").toBe(true),
    { timeout: timeoutMs, interval: 50 },
  );
}

export async function enrollBrowserComputer(stack: VerticalStack, name: string) {
  await configurePersonalRemoteAccess(
    {
      runtime: stack.host,
      ownerHeaders: {
        cookie: stack.sessionCookie,
        origin: stack.hostOrigin.origin,
        [hostApiVersionHeader]: String(hostApiVersion),
      },
    },
    { schemaVersion: 1, mode: "private", routeOrigin: "https://personal.browser.test" },
  );
  return enrollmentToken(stack, {
    allowedModules: ["browser"],
    idempotencyKey: randomUUID(),
    name,
  });
}
