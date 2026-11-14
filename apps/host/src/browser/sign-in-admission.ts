import { OpensteerError, isLoopbackHostname } from "@opensteer/core";
import { browserSiteDomain, browserSiteFromUrl } from "@opensteer/browser-profile/source-state";
import { BrowserSessionIdSchema, type BrowserSessionId } from "@opensteer/protocol";
import type { PersonalHostAccessRouteEnvelope } from "@opensteer/deployment-authority";

/**
 * Sites no sign-in may reach. Loopback addresses hold this Host's own
 * session cookie on a Personal Deployment (and every local dev server's);
 * the sites of the Deployment's canonical origin and remote route hold it
 * everywhere else. An agent signed in there could approve its own Requests.
 */
export function signInSiteRefusal(options: {
  readonly canonicalOrigin: string;
  readonly currentRoute: () => Promise<PersonalHostAccessRouteEnvelope | null>;
}): (site: string) => Promise<boolean> {
  return async (site) => {
    const host = browserSiteDomain(site);
    if (isLoopbackHostname(host) || host === "0.0.0.0" || host === "[::]") return true;
    const route = await options.currentRoute();
    return [options.canonicalOrigin, route?.document.route.origin].some(
      (origin) => origin !== undefined && ownSiteHost(origin) === host,
    );
  };
}

/** The site host of one of this Deployment's own origins, or null when it has none. */
function ownSiteHost(origin: string): string | null {
  try {
    return browserSiteDomain(browserSiteFromUrl(origin));
  } catch {
    // An origin with no site of its own (an intranet name) is not one any
    // sign-in can name either, so nothing needs refusing for it.
    return null;
  }
}

/**
 * Sliding-window limits kept in memory, so a restart forgets them. A call is
 * admitted only when every key is under its limit, and then counts against all.
 */
export function admitWithin(
  ledger: Map<string, number[]>,
  now: number,
  windowMs: number,
  limits: readonly (readonly [key: string, max: number])[],
): boolean {
  const recent = limits.map(
    ([key, max]) =>
      [key, max, (ledger.get(key) ?? []).filter((at) => now - at < windowMs)] as const,
  );
  if (recent.some(([, max, calls]) => calls.length >= max)) return false;
  for (const [key, , calls] of recent) ledger.set(key, [...calls, now]);
  if (ledger.size > 10_000) {
    for (const [key, calls] of ledger) {
      if (calls.every((at) => now - at >= windowMs)) ledger.delete(key);
    }
  }
  return true;
}

const signInWindowMs = 10 * 60_000;
const maxSignInsPerTargetSite = 3;
const maxSignInsPerRun = 30;

/** Bounds how often one Run may start sign-ins, per target and site and overall. */
export function admitSignIn(
  ledger: Map<string, number[]>,
  now: number,
  input: { readonly runId: string; readonly target: string; readonly site: string },
): boolean {
  return admitWithin(ledger, now, signInWindowMs, [
    [`site\0${input.target}\0${input.site}`, maxSignInsPerTargetSite],
    [`run\0${input.runId}`, maxSignInsPerRun],
  ]);
}

export function parseSignInSite(input: string): string {
  try {
    return browserSiteFromUrl(input);
  } catch (error) {
    throw new OpensteerError({
      code: "bad_request",
      message: error instanceof Error ? error.message : "Choose one website.",
    });
  }
}

export function parseSignInSessionId(input: string): BrowserSessionId {
  const parsed = BrowserSessionIdSchema.safeParse(input);
  if (!parsed.success) {
    throw new OpensteerError({ code: "bad_request", message: "Browser Session ID is invalid." });
  }
  return parsed.data;
}
