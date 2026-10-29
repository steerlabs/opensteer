import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/**
 * What a Host reachable only from its own machine still owes itself once it is
 * listening: a first-owner code nobody had to copy anywhere, and an enrollment
 * for the co-located Main Runner the deployment owns. Either is null when that
 * step is already durably complete.
 */
export interface LocalBootstrap {
  readonly runnerEnrollmentToken: string | null;
  readonly setupUrl: string | null;
}

const pollIntervalMs = 150;
const defaultTimeoutMs = 60_000;

export function parseOpenBrowser(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  if (value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new Error("OPENSTEER_OPEN_BROWSER must be true or false");
}

/**
 * Polls until the Host answers. A Host that is still migrating its database can
 * take a few seconds, and a `hosted` Host never registers the route at all, so
 * a 404 is a definitive "nothing to do here" rather than something to wait on.
 */
export async function waitForLocalBootstrap(
  hostUrl: URL,
  signal: AbortSignal,
  timeoutMs = defaultTimeoutMs,
): Promise<LocalBootstrap | null> {
  const endpoint = new URL("/v1/local-bootstrap", hostUrl);
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted) {
    try {
      const response = await fetch(endpoint, { headers: { accept: "application/json" }, signal });
      if (response.status === 404) return null;
      if (response.ok) return (await response.json()) as LocalBootstrap;
    } catch {
      // The Host is not listening yet.
    }
    if (Date.now() >= deadline) {
      throw new Error(`The Opensteer Host did not become ready at ${hostUrl.origin}`);
    }
    await delay(pollIntervalMs, undefined, { signal }).catch(() => undefined);
  }
  return null;
}

/** Resolves once something answers on the origin, so the browser opens to a page. */
export async function waitForOrigin(
  origin: URL,
  signal: AbortSignal,
  timeoutMs = defaultTimeoutMs,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted) {
    try {
      await fetch(origin, { redirect: "manual", signal });
      return true;
    } catch {
      // The dev server is still starting.
    }
    if (Date.now() >= deadline) return false;
    await delay(pollIntervalMs, undefined, { signal }).catch(() => undefined);
  }
  return false;
}

export function openBrowser(target: string): void {
  const [command, ...arguments_] =
    process.platform === "darwin"
      ? ["open", target]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", target]
        : ["xdg-open", target];
  if (!command) return;
  try {
    const child = spawn(command, arguments_, { detached: true, stdio: "ignore" });
    child.once("error", () => undefined);
    child.unref();
  } catch {
    // Printing the URL is the fallback, and the caller always does that.
  }
}
