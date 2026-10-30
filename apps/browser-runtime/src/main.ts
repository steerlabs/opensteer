import { browserProfileSnapshotVersion } from "@opensteer/browser-profile/snapshot";
import { createPublicKey, type KeyObject } from "node:crypto";
import type { BrowserAttachPublicKey } from "@opensteer/protocol";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
  HttpBrowserProfileStateClient,
  defaultAttachTicketReplayLedgerPath,
  sessionFilesRoot,
} from "@opensteer/browser-runtime-core";
import { randomUUID } from "node:crypto";
import { RunnerBootIdSchema, type RunnerDescriptor } from "@opensteer/protocol";
import {
  BrowserModuleRelay,
  FileRunnerIdentityStore,
  LocalBrowserRuntimeBridge,
  RunnerDataDirectoryLock,
  RunnerModuleConnection,
  moduleReadiness,
} from "@opensteer/runner-client";
import { PlaywrightChromiumLauncher } from "./browser/playwright-launcher.js";
import { readBrowserRuntimeConfig } from "./config.js";

async function main(): Promise<void> {
  const config = readBrowserRuntimeConfig();
  const publicKeys = new Map(config.publicKeys);
  const staticKeyIds = new Set(publicKeys.keys());
  const relayKeyIds = new Set<string>();
  const ticketVerifier = await Ed25519AttachTicketVerifier.create({
    replayLedgerPath: defaultAttachTicketReplayLedgerPath(config.profileRoot),
    resolvePublicKey: (keyId) => publicKeys.get(keyId) ?? null,
  });
  const launcher = new PlaywrightChromiumLauncher({
    probePasskeys: true,
    chromiumSandbox: config.chromiumSandbox,
    executablePath: config.executablePath,
    headless: config.headless,
    ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}),
  });
  const runtime = new BrowserRuntime({
    checkpointIntervalMs: config.checkpointIntervalMs,
    checkpointRetryMs: config.checkpointRetryMs,
    idleProfileHostTimeoutMs: config.idleProfileHostTimeoutMs,
    launcher,
    maxProfileHosts: config.maxProfileHosts,
    maxSessionsPerProfile: config.maxSessionsPerProfile,
    profileStateClient: new HttpBrowserProfileStateClient(
      config.profileStateTrustedHttpOrigin
        ? { trustedHttpOrigin: config.profileStateTrustedHttpOrigin }
        : {},
    ),
    runtimeId: config.runtimeId,
    sessionFilesRoot: sessionFilesRoot(config.profileRoot),
    ticketVerifier,
  });
  const server = new BrowserRuntimeServer({
    ...(config.bridgeToken
      ? {
          relayBridge: {
            token: config.bridgeToken,
            updateAttachKeys: (keys: readonly BrowserAttachPublicKey[]) => {
              const next = new Map<string, KeyObject>();
              for (const entry of keys) {
                const key = createPublicKey(entry.publicKeyPem);
                if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
                  throw new Error("The relay supplied a non-Ed25519 browser attach key.");
                }
                const configured = publicKeys.get(entry.keyId);
                if (staticKeyIds.has(entry.keyId) && configured && !configured.equals(key)) {
                  throw new Error("The relayed browser attach key conflicts with a static key.");
                }
                next.set(entry.keyId, key);
              }
              for (const keyId of relayKeyIds) {
                if (!staticKeyIds.has(keyId)) publicKeys.delete(keyId);
              }
              relayKeyIds.clear();
              for (const [keyId, key] of next) {
                if (!staticKeyIds.has(keyId)) {
                  publicKeys.set(keyId, key);
                  relayKeyIds.add(keyId);
                }
              }
            },
          },
        }
      : {}),
    host: config.host,
    port: config.port,
    runtime,
  });
  const address = await server.start();
  process.stdout.write(
    `${JSON.stringify({ event: "browser-runtime.ready", host: address.host, port: address.port })}\n`,
  );

  const relay = config.relay
    ? await startBrowserRelay({
        bridgeToken: config.relay.bridgeToken,
        controlCaPath: config.relay.controlCaPath,
        dataDirectory: config.relay.dataDirectory,
        enrollmentToken: config.relay.enrollmentToken,
        hostUrl: config.relay.hostUrl,
        headless: config.headless,
        passkeys: launcher.passkeys,
        localPort: address.port,
        name: config.relay.name,
        mode: config.relay.mode,
        runtimeId: config.runtimeId,
      })
    : undefined;

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await relay?.close();
    await server.close();
  };
  process.once("SIGINT", () => void close().catch(fail));
  process.once("SIGTERM", () => void close().catch(fail));
  // Another process reclaimed the data directory lease: this runtime no longer
  // owns the profile root it is relaying, so it stops and says why.
  relay?.onLost((reason) => {
    fail(reason);
    void close().catch(fail);
  });
}

/**
 * Turns this process into a browser-only Runner.
 *
 * It enrolls with the Host like any other computer, opens the browser module's
 * stream, and drives its own Chromium back through the loopback bridge it just
 * started. Nothing about the Host has to know where this process is.
 */
async function startBrowserRelay(options: {
  readonly bridgeToken: string;
  readonly controlCaPath: string | undefined;
  readonly dataDirectory: string;
  readonly enrollmentToken: string | undefined;
  readonly hostUrl: URL;
  readonly headless: boolean;
  readonly passkeys: 1 | undefined;
  readonly localPort: number;
  readonly name: string;
  readonly mode: import("@opensteer/core").RuntimeMode;
  readonly runtimeId: string;
}): Promise<{
  close(): Promise<void>;
  onLost(listener: (reason: Error) => void): void;
}> {
  const lock = await RunnerDataDirectoryLock.acquire(options.dataDirectory);
  const identityStore = new FileRunnerIdentityStore({
    dataDirectory: options.dataDirectory,
    environmentless: true,
  });
  const identity = await identityStore.loadOrCreate();
  const bridge = new LocalBrowserRuntimeBridge({
    bridgeToken: options.bridgeToken,
    runtimeId: options.runtimeId,
    url: new URL(`http://127.0.0.1:${options.localPort}`),
  });
  const module = new BrowserModuleRelay(bridge);
  const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
  const connection = new RunnerModuleConnection({
    bootId,
    ...(options.controlCaPath ? { controlCaPath: options.controlCaPath } : {}),
    descriptor: (current): RunnerDescriptor => ({
      bootId,
      capabilities: [],
      modules: {
        browser: {
          runtimeId: options.runtimeId,
          profileSnapshotVersion: browserProfileSnapshotVersion,
          stateImport: true,
          fileStaging: true,
          cdpBoundary: 1,
          ...(options.headless ? { editing: 2 as const, clipboard: true } : {}),
          sharedControl: 1,
          targetControl: 1,
          navigationVersion: 1,
          workspaceTabRestoreVersion: 1,
          captureRegion: 1,
          ...(options.passkeys ? { passkeys: options.passkeys } : {}),
        },
      },
      name: options.name,
      runnerId: current.runnerId,
      runnerKind: "managed",
      runtimeVersion: "0.0.0",
    }),
    ...(options.enrollmentToken ? { enrollmentToken: options.enrollmentToken } : {}),
    hostOrigin: options.hostUrl,
    identity,
    identityStore,
    logger: {
      error: (message, context) =>
        process.stderr.write(
          `${JSON.stringify({ ...context, event: "browser-runtime.relay", message })}\n`,
        ),
      info: (message, context) =>
        process.stdout.write(
          `${JSON.stringify({ ...context, event: "browser-runtime.relay", message })}\n`,
        ),
    },
    module: "browser",
    mode: options.mode,
    onStream: (stream) => module.attach(stream),
    onStreamClosed: () => module.detach(),
    onStreamFrame: (frame, isBinary) => module.handleFrame(frame, isBinary),
    readiness: () => moduleReadiness("browser", "ready"),
  });
  const stop = new AbortController();
  const run = connection.run(stop.signal);
  return {
    close: async () => {
      stop.abort();
      await run;
      await lock.release();
    },
    onLost: (listener) => lock.onLost(listener),
  };
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown browser runtime failure.";
  // A failed shutdown aggregates each profile's own failure; the operator needs those.
  const causes =
    error instanceof AggregateError
      ? error.errors.map((cause: unknown) =>
          cause instanceof Error ? cause.message : String(cause),
        )
      : [];
  process.stderr.write(
    `${JSON.stringify({ event: "browser-runtime.failed", message, ...(causes.length ? { causes } : {}) })}\n`,
  );
  process.exitCode = 1;
}

void main().catch(fail);
