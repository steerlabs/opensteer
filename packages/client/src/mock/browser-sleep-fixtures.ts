import type { BrowserPoolReport } from "../host/browser-sleep.js";

/** Every state a Cloud Computer's pooled browser and its tabs can be shown in. */
export const browserSleepScenes = [
  "awake",
  "asleep",
  "waking",
  "starting",
  "starting-update",
  "restarting",
  "failed",
  "failed-again",
  "reloaded",
  "reloaded-typed",
  "reloaded-by-you",
  "reloaded-security",
  "lost",
  "lost-typed",
] as const;
export type BrowserSleepScene = (typeof browserSleepScenes)[number];

/**
 * What a Home would report for one scene: the browser of the Cloud Computer `runnerId`, with
 * `tabId` the page the scene is about. `since` is when the phase began.
 */
export function mockBrowserPoolReport(
  scene: BrowserSleepScene,
  runnerId: string,
  tabId: string,
  since = "2026-11-20T09:00:00.000Z",
): BrowserPoolReport {
  const start = (reason: NonNullable<BrowserPoolReport["start"]>["reason"]) => ({
    reason,
    at: "2026-11-20T08:59:57.000Z",
  });
  const page = (outcome: "reloaded" | "lost", typed: boolean) => [
    { surfaceId: tabId, outcome, typed },
  ];
  switch (scene) {
    case "awake":
      return { runnerId, phase: "running", since };
    case "asleep":
      return { runnerId, phase: "parked", since };
    case "waking":
      return { runnerId, phase: "waking", since };
    case "starting":
      return { runnerId, phase: "starting", since, start: start("expired") };
    case "starting-update":
      return { runnerId, phase: "starting", since, start: start("update") };
    case "restarting":
      return { runnerId, phase: "restarting", since, start: start("person") };
    case "failed":
      return { runnerId, phase: "failed", since, failures: 1 };
    case "failed-again":
      return { runnerId, phase: "failed", since, failures: 2 };
    case "reloaded":
      return {
        runnerId,
        phase: "running",
        since,
        start: start("expired"),
        pages: page("reloaded", false),
      };
    case "reloaded-typed":
      return {
        runnerId,
        phase: "running",
        since,
        start: start("expired"),
        pages: page("reloaded", true),
      };
    case "reloaded-by-you":
      return {
        runnerId,
        phase: "running",
        since,
        start: start("person"),
        pages: page("reloaded", false),
      };
    case "reloaded-security":
      return {
        runnerId,
        phase: "running",
        since,
        start: start("security-update"),
        pages: page("reloaded", true),
      };
    case "lost":
      return {
        runnerId,
        phase: "running",
        since,
        start: start("host"),
        pages: page("lost", false),
      };
    case "lost-typed":
      return { runnerId, phase: "running", since, start: start("host"), pages: page("lost", true) };
  }
}
