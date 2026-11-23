import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  browserReturnNotes,
  browserSleepFromHome,
  browserTabReturnOf,
  browserWakeSteps,
  noteKey,
  type BrowserSleep,
  type BrowserTabNote,
  type BrowserTabReturn,
} from "../host/browser-sleep.js";
import type { TabId } from "@opensteer/core";
import type { HostClient } from "../host/client.js";

export interface BrowserSleepState {
  readonly browser: BrowserSleep;
  readonly tab: BrowserTabReturn;
  /**
   * How long this device has watched the current wait, in steps of `browserWakeSteps`: the view
   * renders again only when the line could change, never on a running clock.
   */
  readonly elapsedMs: number;
  /** The note this tab shows now, until the person has seen it. */
  readonly note: BrowserTabNote | null;
  /** Names the note shown, so a view can tell when the person moved on from it. */
  readonly noteKey: string | null;
  /** The person has seen the note: it leaves and does not come back. */
  readonly seen: () => void;
}

/** What the hook reads: a page view's client may hold no more than its snapshot. */
export type BrowserSleepClient = Pick<HostClient, "getSnapshot"> &
  Partial<Pick<HostClient, "subscribe">>;

const quiet = () => () => {};

/**
 * One tab's browser sleep, for a view of that tab. For every Home without a pooled browser this
 * is `not-pooled` with no note, and nothing in the view changes.
 */
export function useBrowserSleep(
  hostClient: BrowserSleepClient,
  tabId: string | null,
  /** The viewed tab row's `reopenedAt`: its last wake opened it again at its address (TS7). */
  reopenedAt?: number | null,
): BrowserSleepState {
  const tabs = hostClient.getSnapshot().tabs;
  const computerId = useSyncExternalStore(
    useCallback(
      (listener: () => void) =>
        tabId === null ? () => {} : tabs.subscribeTab(tabId as TabId, listener),
      [tabs, tabId],
    ),
    useCallback(() => {
      const listed = tabId === null ? undefined : tabs.get(tabId as TabId);
      return listed?.kind === "page" ? listed.computer.computerId : null;
    }, [tabs, tabId]),
  );
  const pools = useSyncExternalStore(
    hostClient.subscribe ?? quiet,
    useCallback(() => hostClient.getSnapshot().browserPools, [hostClient]),
  );
  const view = useMemo(() => {
    const reported = browserSleepFromHome(pools, computerId, tabId);
    return { ...reported, tab: browserTabReturnOf(reported.tab, reopenedAt) };
  }, [computerId, pools, reopenedAt, tabId]);
  const elapsedMs = useWaitElapsed(view.browser);
  const notes = browserReturnNotes(hostClient);
  useSyncExternalStore(notes.subscribe, notes.version, notes.version);
  const note = computerId && tabId ? notes.note(computerId, tabId, view.tab) : null;
  const tab = view.tab;
  const key =
    note && tab.kind !== "kept" && computerId && tabId ? noteKey(computerId, tabId, tab) : null;
  const seen = useCallback(() => {
    if (computerId && tabId) notes.seen(computerId, tabId, tab);
  }, [computerId, notes, tab, tabId]);
  return { browser: view.browser, tab, elapsedMs, note, noteKey: key, seen };
}

/**
 * Time is this device's own, from when it first saw this wait: the Home's clock may differ from
 * this one, and what the person waited is what this device saw.
 */
function useWaitElapsed(browser: BrowserSleep): number {
  const wait =
    browser.kind === "waking" || browser.kind === "starting" || browser.kind === "restarting"
      ? `${browser.computerId}:${browser.kind}:${browser.since}`
      : null;
  const [watched, setWatched] = useState<{ wait: string; from: number } | null>(null);
  const [, setStep] = useState(0);
  const from = wait === null ? null : watched?.wait === wait ? watched.from : null;
  useEffect(() => {
    if (wait !== null && watched?.wait !== wait) setWatched({ wait, from: Date.now() });
  }, [wait, watched?.wait]);
  const elapsedMs = from === null ? 0 : Date.now() - from;
  const next = browserWakeSteps.find((step) => step > elapsedMs);
  useEffect(() => {
    if (from === null || next === undefined) return;
    const timer = setTimeout(() => setStep(next), next - (Date.now() - from));
    return () => clearTimeout(timer);
  }, [from, next]);
  return elapsedMs;
}
