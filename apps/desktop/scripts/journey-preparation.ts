export const JOURNEY_PREPARATION = [
  ["install", "CI=true pnpm -r install --frozen-lockfile"],
  ["helper", "pnpm build:computer-use-helper"],
  ["broker", "pnpm build:passwords-broker"],
  ["desktop", "pnpm build"],
  [
    "electron",
    "node node_modules/electron/install.js && pnpm exec tsup --config scripts/tsup.electron-smoke.config.ts",
  ],
  ["policy-fixture", "pnpm exec tsx scripts/test-support/build-passwords-policy-fixture.ts"],
  ["peer", "xcrun swiftc scripts/journey-peer.swift -o .electron-smoke/journey-peer"],
] as const;

import { summarizeJourneys, type JourneyRow } from "./journey-isolation.js";
export interface PreparationRow {
  step: string;
  seconds: number;
  exitCode: number;
}
/** Folded quit also needs current-source runtime services when electron runs alone. */
export function runtimeResourceJourney(selected: readonly string[]) {
  if (selected.includes("native-browser")) return "native-browser";
  if (selected.includes("electron")) return "electron";
  return undefined;
}
export async function prepareAcceptedRun(
  execute: (step: string, command: string) => Promise<number>,
  interrupted: () => boolean,
  rows: PreparationRow[],
): Promise<boolean> {
  for (const [step, command] of JOURNEY_PREPARATION) {
    if (interrupted()) return false;
    const start = performance.now();
    const exitCode = await execute(step, command);
    rows.push({ step, exitCode, seconds: (performance.now() - start) / 1000 });
    if (exitCode !== 0 || interrupted()) return false;
  }
  return true;
}
export function acceptedRunResult(
  selected: string[],
  results: JourneyRow[],
  prepare: PreparationRow[],
  interrupted: boolean,
  sameHead = true,
) {
  return summarizeJourneys(
    selected,
    results,
    !interrupted &&
      sameHead &&
      prepare.length >= JOURNEY_PREPARATION.length &&
      prepare.every((row) => row.exitCode === 0),
  );
}
