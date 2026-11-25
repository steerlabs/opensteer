import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { sendHeartbeat } from "@opensteer/shared/heartbeat";
import {
  accountClient,
  accountRefused,
  workloadIdentityToken,
  type AccountApi,
} from "./account.js";
import { CloudflareDns } from "./cloudflare.js";
import { loadConfig } from "./config.js";
import { discoverHome } from "./discovery.js";
import { GoogleCompute } from "./google-compute.js";
import {
  PoolNetworkMismatchError,
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
 * T3: Runs the Home pass and pool pass in separate `try` blocks so one failing Home does not
 * stop pool work, nor a failing pool pass stop Homes.
 */
export async function runProvisionerTick(options: {
  readonly reconciler: Pick<Reconciler, "pass">;
  readonly poolReconciler?: Pick<PoolReconciler, "pass"> | undefined;
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
  }

  if (!failed && !options.signal.aborted) options.heartbeat?.();
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
    throw new PoolNetworkMismatchError(
      `OPENSTEER_POOL_HOME_CIDR (${homeCidr}) is not the subnet's range (${range ?? "unknown"})`,
    );
}

/** How often a provisioner asks again for a lease another one holds. */
const leaseRetryMs = 10_000;

/**
 * Takes the lease, waiting inside the process while another provisioner holds it (P2): an upgrade
 * no longer means exit, restart and a refusal every few seconds until it runs out. Says once when
 * the wait begins and once when it ends. False when told to stop first; any other refusal throws.
 */
export async function holdLease(input: {
  readonly account: Pick<AccountApi, "acquire">;
  readonly signal: AbortSignal;
  readonly retryMs: number;
  readonly log: (line: Readonly<Record<string, unknown>>) => void;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<boolean> {
  let waitingSince: number | undefined;
  for (;;) {
    try {
      await input.account.acquire(input.signal);
      if (waitingSince !== undefined)
        input.log({
          event: "home-provisioner.lease.acquired",
          waitedMs: Date.now() - waitingSince,
        });
      return true;
    } catch (error) {
      const held =
        error instanceof RemoteRequestError && error.service === "Account" && error.status === 409;
      if (!held || input.signal.aborted) {
        if (input.signal.aborted) return false;
        throw error;
      }
      if (waitingSince === undefined) {
        waitingSince = Date.now();
        input.log({ event: "home-provisioner.lease.waiting" });
      }
    }
    await input.sleep(input.retryMs);
    if (input.signal.aborted) return false;
  }
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
  let held = false;
  const stop = () => shutdown.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await checkPoolNetwork(googleProvider, config.pool.homeCidr, shutdown.signal);
    held = await holdLease({
      account,
      signal: shutdown.signal,
      retryMs: leaseRetryMs,
      log: (line) => console.log(JSON.stringify(line)),
      sleep: (ms) => delay(ms, undefined, { signal: shutdown.signal }).catch(() => {}),
    });
    if (!held) return;
    console.log(JSON.stringify({ event: "home-provisioner.started" }));
    while (!shutdown.signal.aborted) {
      const waitMs = await runProvisionerTick({
        reconciler,
        poolReconciler,
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
    // A clean stop gives the lease back, so the next provisioner starts at once (P2).
    if (held)
      await account
        .release?.(AbortSignal.timeout(5_000))
        .then((released) =>
          console.log(JSON.stringify({ event: "home-provisioner.lease.released", released })),
        )
        .catch(logFailure);
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
