import {
  browserSignInProblemCopy,
  browserSiteLabel,
  chromeSignInAvailability,
  type ChromeSignInAvailability,
} from "@opensteer/client/host";
import type {
  BrowserSignInOutcome,
  BrowserSourceInspection,
} from "@opensteer/protocol/browser-sources";

export type DotTone = "green" | "amber" | "red" | "muted" | "ember";

/**
 * Where a sign-in stands, read the way every client reads it. An Allow may
 * name an offline Chrome: the Request finishes when that Chrome comes back.
 */
export function signInAvailability(
  inspection: BrowserSourceInspection | null,
): ChromeSignInAvailability | null {
  return inspection === null ? null : chromeSignInAvailability(inspection, { offlineCounts: true });
}

/** The card's one line under its title: where the sign-in stands right now. */
export function signInSummaryLine(
  availability: ChromeSignInAvailability | null,
  allowed: boolean,
  site: string,
): { readonly live: boolean; readonly text: string; readonly tone: DotTone } | null {
  if (allowed) return { live: true, text: "Allowed. Finishes when Chrome is back.", tone: "amber" };
  if (availability === null) return null;
  switch (availability.kind) {
    case "no-chrome":
      return { live: false, text: signInCopy("no-chrome", site, null).title, tone: "muted" };
    case "choices": {
      const [first] = availability.choices;
      const name = availability.choices.length === 1 ? (first?.name ?? null) : null;
      if (first?.online !== true) {
        return { live: false, text: signInCopy("chrome-offline", site, name).title, tone: "amber" };
      }
      return name === null
        ? { live: false, text: "Choose which Chrome to use", tone: "green" }
        : { live: false, text: `Ready in ${name}`, tone: "green" };
    }
    case "problem":
      return {
        live: false,
        text: signInCopy(availability.problem, site, availability.sourceName).title,
        tone: availability.problem === "chrome-offline" ? "amber" : "red",
      };
  }
}

export function signInCopy(
  problem: Parameters<typeof browserSignInProblemCopy>[0],
  site: string,
  sourceName: string | null,
): ReturnType<typeof browserSignInProblemCopy> {
  return browserSignInProblemCopy(problem, {
    connectHere: false,
    context: "request",
    site,
    sourceName,
  });
}

export function signInStatus(input: {
  readonly allowed: BrowserSignInOutcome | null;
  readonly availability: ChromeSignInAvailability | null;
  readonly error: string | null;
  readonly site: string;
}): {
  readonly detail: string | null;
  readonly live: boolean;
  readonly title: string;
  readonly tone: DotTone;
} {
  const { availability, site } = input;
  const domain = browserSiteLabel(site);
  if (input.allowed !== null) {
    const name = input.allowed.status === "problem" ? input.allowed.sourceName : null;
    return {
      detail: "Open Chrome on that computer. This finishes by itself.",
      live: true,
      title: `Allowed. Waiting for ${name ?? "Chrome"}`,
      tone: "amber",
    };
  }
  if (availability === null) {
    return input.error === null
      ? { detail: null, live: true, title: "Checking Chrome…", tone: "muted" }
      : {
          detail: `${input.error} It checks again by itself.`,
          live: false,
          title: "Chrome couldn’t be checked",
          tone: "muted",
        };
  }
  switch (availability.kind) {
    case "no-chrome": {
      const copy = signInCopy("no-chrome", site, null);
      return { detail: copy.fix, live: false, title: copy.title, tone: "muted" };
    }
    case "choices": {
      const [first] = availability.choices;
      const single = availability.choices.length === 1 ? (first ?? null) : null;
      if (first?.online !== true) {
        const copy = signInCopy("chrome-offline", site, single?.name ?? null);
        return {
          detail: `${copy.fix ?? ""} Allow now; this finishes by itself when Chrome opens.`.trim(),
          live: false,
          title: copy.title,
          tone: "amber",
        };
      }
      return single !== null
        ? {
            detail: "Allow signs your agent in now.",
            live: false,
            title: `${single.name} is signed in to ${domain}`,
            tone: "green",
          }
        : {
            detail: "Choose which one to use.",
            live: false,
            title: `Several Chrome profiles are signed in to ${domain}`,
            tone: "green",
          };
    }
    case "problem": {
      const copy = signInCopy(availability.problem, site, availability.sourceName);
      return {
        detail: `${copy.fix ?? ""} This updates by itself.`.trim(),
        live: false,
        title: copy.title,
        tone: availability.problem === "chrome-offline" ? "amber" : "red",
      };
    }
  }
}
