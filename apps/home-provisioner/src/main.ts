import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { accountClient, accountRefused, workloadIdentityToken } from "./account.js";
import { CloudflareDns } from "./cloudflare.js";
import { loadConfig } from "./config.js";
import { discoverHome } from "./discovery.js";
import { GoogleCompute } from "./google-compute.js";
import { ProviderRateLimited, provisionerFailure, RemoteRequestError } from "./http.js";
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
 * T3: Runs the Home pass and pool pass in separate `try` blocks so one failing Home does not
 * stop pool work, nor a failing pool pass stop Homes.
 */
export async function runProvisionerTick(options: {
  readonly reconciler: Pick<Reconciler, "pass">;
  readonly poolReconciler?: Pick<PoolReconciler, "pass"> | undefined;
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
  }

  return waitMs;
}

/**
 * Every Home's firewall opens the network this provisioner reports with its lease (its
 * OPENSTEER_POOL_HOME_CIDR): it must be the subnet's own range, where it creates Homes and pool
 * hosts, or the Homes would open the wrong network or none that reaches their pool host.
 */
export async function checkPoolNetwork(
  provider: Pick<GoogleCompute, "subnetRange">,
  homeCidr: string,
  signal: AbortSignal,
): Promise<void> {
  const range = await provider.subnetRange(signal);
  if (range !== homeCidr)
    throw new Error(
      `OPENSTEER_POOL_HOME_CIDR (${homeCidr}) is not the subnet's range (${range ?? "unknown"})`,
    );
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
    // Pool hosts are created in the Homes' own subnet (google-compute.ts, createPoolHost).
    config.pool.homeCidr,
    config.pool.adminPort,
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
  // Every Cloud Computer's browser runs in the pool, so its reconciliation always runs.
  const poolReconciler = account.pool
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
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await checkPoolNetwork(googleProvider, config.pool.homeCidr, shutdown.signal);
    await account.acquire(shutdown.signal);
    console.log(JSON.stringify({ event: "home-provisioner.started" }));
    while (!shutdown.signal.aborted) {
      const waitMs = await runProvisionerTick({
        reconciler,
        poolReconciler,
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
