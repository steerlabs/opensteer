import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { sendHeartbeat } from "@opensteer/shared/heartbeat";
import {
  accountClient,
  accountRefused,
  workloadIdentityToken,
  type PoolAccountApi,
} from "./account.js";
import { CloudflareDns } from "./cloudflare.js";
import { loadConfig } from "./config.js";
import { discoverHome } from "./discovery.js";
import { GoogleCompute } from "./google-compute.js";
import {
  PoolConfigMismatchError,
  ProviderRateLimited,
  provisionerFailure,
  RemoteRequestError,
} from "./http.js";
import { httpPoolAgentClient } from "./pool-agent-client.js";
import { PoolReconciler } from "./pool-reconcile.js";
import { Reconciler } from "./reconcile.js";

function isFatalAccountError(error: unknown): boolean {
  return (
    accountRefused(error) ||
    (error instanceof RemoteRequestError && error.service === "Account" && error.status === 409)
  );
}

/**
 * T3 + T9: Runs the Home pass and pool pass in separate `try` blocks so one failing Home does not
 * stop pool work, nor a failing pool pass stop Homes. When pooling is enabled on Account while this
 * Google provisioner has no pool key, reports a loud mismatch error on every pass.
 */
export async function runProvisionerTick(options: {
  readonly reconciler: Pick<Reconciler, "pass">;
  readonly poolReconciler?: Pick<PoolReconciler, "pass"> | undefined;
  readonly poolProbe?: Pick<PoolAccountApi, "isPoolEnabled"> | undefined;
  readonly intervalMs: number;
  readonly signal: AbortSignal;
  readonly onError: (error: unknown) => void;
  /** Called after a tick in which every pass finished without an error. */
  readonly heartbeat?: () => void;
  readonly now?: () => number;
}): Promise<number> {
  const now = options.now ?? Date.now;
  let waitMs = options.intervalMs;
  let failed = false;
  const onError = (error: unknown) => {
    failed = true;
    options.onError(error);
  };

  try {
    await options.reconciler.pass(options.signal);
  } catch (error) {
    if (error instanceof ProviderRateLimited) {
      waitMs = Math.max(waitMs, error.retryAt - now());
    }
    if (!options.signal.aborted) onError(error);
    if (isFatalAccountError(error)) throw error;
  }

  if (options.signal.aborted) return waitMs;

  if (options.poolReconciler) {
    try {
      await options.poolReconciler.pass(options.signal);
    } catch (error) {
      if (error instanceof ProviderRateLimited) {
        waitMs = Math.max(waitMs, error.retryAt - now());
      }
      if (!options.signal.aborted) onError(error);
      if (isFatalAccountError(error)) throw error;
    }
  } else if (options.poolProbe?.isPoolEnabled) {
    try {
      if (await options.poolProbe.isPoolEnabled(options.signal)) {
        onError(new PoolConfigMismatchError());
      }
    } catch (error) {
      if (!options.signal.aborted) onError(error);
      if (isFatalAccountError(error)) throw error;
    }
  }

  if (!failed && !options.signal.aborted) options.heartbeat?.();
  return waitMs;
}

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid provisioner configuration");
    process.exitCode = 1;
    return;
  }

  const http = { timeoutMs: config.timeoutMs };
  const account = accountClient(
    config.accountOrigin,
    workloadIdentityToken(config.accountOrigin.origin, http),
    http,
    undefined,
    "google",
    Boolean(config.pool),
  );
  const googleProvider = new GoogleCompute({
    ...http,
    project: config.project,
    zone: config.zone,
    network: config.network,
    subnet: config.subnet,
    diskType: config.diskType,
    diskSizeGb: config.diskSizeGb,
    actionTimeoutMs: config.actionTimeoutMs,
    log: (entry) => console.error(JSON.stringify(entry)),
  });
  const reconciler = new Reconciler({
    account,
    onError: logFailure,
    orphanGraceMs: config.orphanGraceMs,
    provider: googleProvider,
    dns: new CloudflareDns({
      ...http,
      token: config.cloudflareToken,
      zoneId: config.zoneId,
      domain: config.domain,
    }),
    discover: discoverHome(http),
    accountOrigin: config.accountOrigin,
    image: config.image,
    defaultRegion: config.region,
    defaultServerType: config.serverType,
    readinessTimeoutMs: config.readinessTimeoutMs,
    concurrency: config.concurrency,
  });
  // S8: pool reconciliation runs only when pooling is configured.
  const poolReconciler =
    config.pool && account.pool
      ? new PoolReconciler({
          account: account.pool,
          provider: googleProvider,
          agent: httpPoolAgentClient({
            provisionerKey: config.pool.provisionerPrivateKey,
            timeoutMs: config.timeoutMs,
          }),
          accountOrigin: config.accountOrigin,
          image: config.image,
          pool: config.pool,
          readinessTimeoutMs: config.readinessTimeoutMs,
          orphanGraceMs: config.orphanGraceMs,
          concurrency: config.concurrency,
          onError: logFailure,
        })
      : undefined;
  const poolProbe = config.pool ? undefined : account.pool;
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await account.acquire(shutdown.signal);
    console.log(JSON.stringify({ event: "home-provisioner.started" }));
    while (!shutdown.signal.aborted) {
      const waitMs = await runProvisionerTick({
        reconciler,
        poolReconciler,
        poolProbe,
        intervalMs: config.intervalMs,
        signal: shutdown.signal,
        onError: logFailure,
        heartbeat: () =>
          sendHeartbeat(config.heartbeatUrl, {
            onError: (status) =>
              console.error(JSON.stringify({ event: "home-provisioner.heartbeat.failed", status })),
          }),
      });
      if (!shutdown.signal.aborted) {
        await delay(waitMs, undefined, { signal: shutdown.signal }).catch(() => {});
      }
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    console.log(JSON.stringify({ event: "home-provisioner.stopped" }));
  }
}

function logFailure(error: unknown) {
  console.error(JSON.stringify(provisionerFailure(error)));
}

/** X5: Structured fatal logging and non-zero exit for the provisioner entry point. */
export async function runMainWithFatalHandling(
  run: () => Promise<void>,
  onFatal: (error: unknown) => void = logFailure,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    onFatal(error);
    process.exitCode = 1;
  }
}

export function isMainModule(argv1: string | undefined, metaUrl: string): boolean {
  if (!argv1) return false;
  try {
    return pathToFileURL(resolve(argv1)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  void runMainWithFatalHandling(main);
}
