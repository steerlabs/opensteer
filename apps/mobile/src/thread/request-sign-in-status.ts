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
import { sentenceOf } from "../ui/sentence-addresses.js";
import { sentence, type SentencePart } from "../ui/sentence-parts.js";

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
): {
  readonly live: boolean;
  /** Its words, the site they name drawn as an address. */
  readonly text: readonly SentencePart[];
  readonly tone: DotTone;
} | null {
  if (allowed)
    return { live: true, text: ["Allowed. Finishes when that browser is back."], tone: "amber" };
  if (availability === null) return null;
  switch (availability.kind) {
    case "no-chrome":
      return { live: false, text: copyTitle(signInCopy("no-chrome", site, null)), tone: "muted" };
    case "choices": {
      const [first] = availability.choices;
      const name = availability.choices.length === 1 ? (first?.name ?? null) : null;
      if (first?.online !== true) {
        return {
          live: false,
          text: copyTitle(signInCopy("chrome-offline", site, name)),
          tone: "amber",
        };
      }
      return name === null
        ? { live: false, text: ["Choose which Chrome to use"], tone: "green" }
        : { live: false, text: [`Ready in ${name}`], tone: "green" };
    }
    case "problem":
      return {
        live: false,
        text: copyTitle(signInCopy(availability.problem, site, availability.sourceName)),
        tone: availability.problem === "chrome-offline" ? "amber" : "red",
      };
  }
}

/** A problem's title as it was made: the site it names an address. */
function copyTitle(copy: ReturnType<typeof browserSignInProblemCopy>): readonly SentencePart[] {
  return sentenceOf(copy.titleParts);
}

/** A problem's fix as it was made, then words of the card's own after it. */
function fixThen(
  copy: ReturnType<typeof browserSignInProblemCopy>,
  words: string,
): readonly SentencePart[] {
  return copy.fixParts === null ? [words] : [...sentenceOf(copy.fixParts), ` ${words}`];
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
  /** What happens next; one that names the site comes as parts too. */
  readonly detail: readonly SentencePart[] | null;
  readonly live: boolean;
  /** Its words; one that names the site comes as parts, the site drawn as an address. */
  readonly title: string | readonly SentencePart[];
  readonly tone: DotTone;
} {
  const { availability, site } = input;
  const domain = browserSiteLabel(site);
  if (input.allowed !== null) {
    const name = input.allowed.status === "problem" ? input.allowed.sourceName : null;
    const offline = signInCopy("chrome-offline", site, name);
    return {
      detail: fixThen(offline, "This finishes by itself."),
      live: true,
      title: `Allowed. Waiting for ${name ?? "Chrome"}`,
      tone: "amber",
    };
  }
  if (availability === null) {
    return input.error === null
      ? { detail: null, live: true, title: "Checking Chrome…", tone: "muted" }
      : {
          detail: [`${input.error} It checks again by itself.`],
          live: false,
          title: "Chrome couldn’t be checked",
          tone: "muted",
        };
  }
  switch (availability.kind) {
    case "no-chrome": {
      const copy = signInCopy("no-chrome", site, null);
      return {
        detail: copy.fixParts === null ? null : sentenceOf(copy.fixParts),
        live: false,
        title: copyTitle(copy),
        tone: "muted",
      };
    }
    case "choices": {
      const [first] = availability.choices;
      const single = availability.choices.length === 1 ? (first ?? null) : null;
      if (first?.online !== true) {
        const copy = signInCopy("chrome-offline", site, single?.name ?? null);
        return {
          detail: fixThen(copy, "Allow now; this finishes by itself when it opens."),
          live: false,
          title: copyTitle(copy),
          tone: "amber",
        };
      }
      return single !== null
        ? {
            detail: ["Allow signs your agent in now."],
            live: false,
            title: [`${single.name} is signed in to `, { address: domain }],
            tone: "green",
          }
        : {
            detail: ["Choose which one to use."],
            live: false,
            title: sentence`Several Chrome profiles are signed in to ${domain}`,
            tone: "green",
          };
    }
    case "problem": {
      const copy = signInCopy(availability.problem, site, availability.sourceName);
      return {
        detail: fixThen(copy, "This updates by itself."),
        live: false,
        title: copyTitle(copy),
        tone: availability.problem === "chrome-offline" ? "amber" : "red",
      };
    }
  }
}
