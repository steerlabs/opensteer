import { PublicBrowserEgressProxy } from "./egress-proxy.js";

async function main(): Promise<void> {
  const proxy = new PublicBrowserEgressProxy({
    host: process.env.OPENSTEER_BROWSER_EGRESS_HOST?.trim() || "127.0.0.1",
    port: port(process.env.OPENSTEER_BROWSER_EGRESS_PORT),
  });
  const address = await proxy.start();
  process.stdout.write(`${JSON.stringify({ event: "browser-egress.ready", ...address })}\n`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await proxy.close();
  };
  process.once("SIGINT", () => void close().catch(fail));
  process.once("SIGTERM", () => void close().catch(fail));
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
