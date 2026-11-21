import { setTimeout as delay } from "node:timers/promises";
import { accountClient, accountRefused, workloadIdentityToken } from "./account.js";
import { CloudflareDns } from "./cloudflare.js";
import { loadConfig } from "./config.js";
import { discoverHome } from "./discovery.js";
import { GoogleCompute } from "./google-compute.js";
import { HetznerCloud } from "./hetzner.js";
import { ProviderRateLimited, provisionerFailure, RemoteRequestError } from "./http.js";
import { Reconciler } from "./reconcile.js";

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
    config.provider === "google" ? "google" : undefined,
  );
  const reconciler = new Reconciler({
    account,
    onError: logFailure,
    orphanGraceMs: config.orphanGraceMs,
    provider:
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
        : new HetznerCloud({
            ...http,
            token: config.hetznerToken,
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
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await account.acquire(shutdown.signal);
    console.log(JSON.stringify({ event: "home-provisioner.started" }));
    while (!shutdown.signal.aborted) {
      let waitMs = config.intervalMs;
      try {
        await reconciler.pass(shutdown.signal);
      } catch (error) {
        // A provider rate limit postpones the next pass until the provider accepts requests.
        if (error instanceof ProviderRateLimited)
          waitMs = Math.max(waitMs, error.retryAt - Date.now());
        if (!shutdown.signal.aborted) logFailure(error);
        if (
          accountRefused(error) ||
          (error instanceof RemoteRequestError &&
            error.service === "Account" &&
            error.status === 409)
        )
          throw error;
      }
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

function logFailure(error: unknown): void {
  console.error(JSON.stringify(provisionerFailure(error)));
}

main().catch((error: unknown) => {
  logFailure(error);
  process.exitCode = 1;
});
