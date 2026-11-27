/**
 * Every web journey (`scripts/<name>-journey.ts`), in one place. Each runs the production web
 * build against the mock Host in headless Chromium. `pnpm test:journeys` (run-journeys.ts) is the
 * one way they run: all of them, or one shard. CI's browser-journeys job runs every shard, and
 * Check fails unless together they ran every journey listed here, so a journey that stops
 * holding fails a check instead of rotting unseen. `journeys.test.ts` fails when a journey file
 * is in neither list.
 */

export interface WebJourney {
  /** `scripts/<name>-journey.ts`, run by the package script `test:<name>`. */
  readonly name: string;
  /** Wall time on a Mac, build included; shards are balanced by it. */
  readonly seconds: number;
}

export const webJourneys: readonly WebJourney[] = [
  { name: "agent-cursors", seconds: 5 },
  { name: "browser-downloads", seconds: 12 },
  { name: "browser-navigation", seconds: 2 },
  { name: "browser-sleep", seconds: 65 },
  { name: "computer-windows", seconds: 2 },
  { name: "connected-agents-now", seconds: 14 },
  { name: "connection-consent-scroll", seconds: 8 },
  { name: "large-transcript", seconds: 5 },
  { name: "long-thread", seconds: 52 },
  { name: "model-picker", seconds: 9 },
  { name: "omnibox", seconds: 34 },
  { name: "sidebar-search", seconds: 20 },
  { name: "sidebar-split", seconds: 63 },
  { name: "start-page-computers", seconds: 5 },
  { name: "tab-activation", seconds: 2 },
  { name: "tab-drag", seconds: 89 },
  { name: "tab-groups", seconds: 4 },
  { name: "tab-profile-filter", seconds: 9 },
  { name: "tab-reopen", seconds: 2 },
  { name: "task-done", seconds: 5 },
  { name: "task-marks", seconds: 6 },
  { name: "transcript-links", seconds: 11 },
  { name: "transcript-presentation", seconds: 10 },
];

/** Journeys that `pnpm test:journeys` does not run, each with why and where it runs instead. */
export const journeysRunElsewhere: Readonly<Record<string, string>> = {
  "remote-editing":
    "Drives Chromium, Firefox and WebKit; CI installs only Chromium. Run it by hand with `tsx scripts/remote-editing-journey.ts` where all three are installed.",
};

/**
 * Shard `index` (1-based) of `count`: the longest journeys first, each to the shard with the
 * least time so far, so every journey is in exactly one shard and the shards take about as long.
 */
export function journeyShard(
  journeys: readonly WebJourney[],
  index: number,
  count: number,
): readonly WebJourney[] {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > count
  )
    throw new Error(`No shard ${index} of ${count}.`);
  const shards = Array.from({ length: count }, () => ({
    seconds: 0,
    journeys: [] as WebJourney[],
  }));
  const longestFirst = [...journeys].sort(
    (a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name),
  );
  for (const journey of longestFirst) {
    const least = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
    least.journeys.push(journey);
    least.seconds += journey.seconds;
  }
  return shards[index - 1]!.journeys.sort((a, b) => a.name.localeCompare(b.name));
}
