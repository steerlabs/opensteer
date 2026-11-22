import { setTimeout as delay } from "node:timers/promises";
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
import { HetznerCloud } from "./hetzner.js";
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
  readonly now?: () => number;
}): Promise<number> {
  const now = options.now ?? Date.now;
  let waitMs = options.intervalMs;

  try {
    await options.reconciler.pass(options.signal);
  } catch (error) {
    if (error instanceof ProviderRateLimited) {
      waitMs = Math.max(waitMs, error.retryAt - now());
    }
    if (!options.signal.aborted) options.onError(error);
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
      if (!options.signal.aborted) options.onError(error);
      if (isFatalAccountError(error)) throw error;
    }
  } else if (options.poolProbe?.isPoolEnabled) {
    try {
      if (await options.poolProbe.isPoolEnabled(options.signal)) {
        options.onError(new PoolConfigMismatchError());
      }
    } catch (error) {
      if (!options.signal.aborted) options.onError(error);
      if (isFatalAccountError(error)) throw error;
    }
  }

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
  const poolConfigured = config.provider === "google" ? Boolean(config.pool) : undefined;
  const account = accountClient(
    config.accountOrigin,
    workloadIdentityToken(config.accountOrigin.origin, http),
    http,
    undefined,
    config.provider === "google" ? "google" : undefined,
    poolConfigured,
  );
  const googleProvider =
    config.provider === "google"
      ? new GoogleCompute({
          ...http,
          project: config.project,
          zone: config.zone,
          network: config.network,
          subnet: config.subnet,
          diskType: config.diskType,
          diskSizeGb: config.diskSizeGb,
          actionTimeoutMs: config.actionTimeoutMs,
          log: (entry) => console.error(JSON.stringify(entry)),
        })
      : undefined;
  const reconciler = new Reconciler({
    account,
    onError: logFailure,
    orphanGraceMs: config.orphanGraceMs,
    provider:
      googleProvider ??
      new HetznerCloud({
        ...http,
        token: config.provider === "hetzner" ? config.hetznerToken : "",
        actionTimeoutMs: config.actionTimeoutMs,
      }),
    dns: new CloudflareDns({ ...http, token: config.cloudflareToken, zoneId: config.zoneId }),
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
    config.provider === "google" && config.pool && googleProvider && account.pool
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
  const poolProbe = config.provider === "google" && !config.pool ? account.pool : undefined;
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

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  void main();
}
