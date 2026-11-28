import { readBrowserEgressUpstream } from "./egress-config.js";
import { BrowserEgressRefusalCounts, PublicBrowserEgressProxy } from "./egress-proxy.js";
import { shutdownSignals } from "@opensteer/shared/processControl";

async function main(): Promise<void> {
  const upstream = await readBrowserEgressUpstream(process.env);
  const refusals =
    process.env.OPENSTEER_BROWSER_EGRESS_DEBUG === "1"
      ? new BrowserEgressRefusalCounts()
      : undefined;
  const proxy = new PublicBrowserEgressProxy({
    host: process.env.OPENSTEER_BROWSER_EGRESS_HOST?.trim() || "127.0.0.1",
    port: port(process.env.OPENSTEER_BROWSER_EGRESS_PORT),
    ...activatedSocket(process.env),
    upstreamRequired: process.env.OPENSTEER_BROWSER_EGRESS_UPSTREAM_REQUIRED === "true",
    // A pool host sizes this for one browser (round D, D1).
    ...(process.env.OPENSTEER_BROWSER_EGRESS_MAX_CONNECTIONS
      ? { maxConnections: Number(process.env.OPENSTEER_BROWSER_EGRESS_MAX_CONNECTIONS) }
      : {}),
    ...(upstream ? { upstream } : {}),
    // A diagnostics pool host asks for refusal counts on stderr (round D, D5): a reason and a
    // count, every ten seconds; never where a person browsed.
    ...(refusals ? { onRefusal: (event) => refusals.add(event) } : {}),
  });
  if (refusals)
    setInterval(() => {
      for (const line of refusals.take())
        process.stderr.write(`${JSON.stringify({ event: "browser-egress.refused", ...line })}\n`);
    }, 10_000).unref();
  const address = await proxy.start();
  process.stdout.write(`${JSON.stringify({ event: "browser-egress.ready", ...address })}\n`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await proxy.close();
  };
  for (const signal of shutdownSignals) process.once(signal, () => void close().catch(fail));
}

/**
 * systemd socket activation (sd_listen_fds): exactly one listening socket at fd 3, meant for
 * this process. A pool host keeps a parked slot's socket open while no proxy process runs.
 */
function activatedSocket(environment: NodeJS.ProcessEnv): { listenFd?: number } {
  if (environment.LISTEN_FDS === undefined) return {};
  if (environment.LISTEN_FDS !== "1" || environment.LISTEN_PID !== String(process.pid))
    throw new Error("browser-egress takes exactly one activated socket.");
  return { listenFd: 3 };
}

function port(value: string | undefined): number {
  if (!value) return 4_313;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("OPENSTEER_BROWSER_EGRESS_PORT must be an integer from 1 through 65535.");
  }
  return parsed;
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown browser egress failure.";
  process.stderr.write(`${JSON.stringify({ event: "browser-egress.failed", message })}\n`);
  process.exitCode = 1;
}

void main().catch(fail);
