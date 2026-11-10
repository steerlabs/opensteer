import type { HostClient } from "./client.js";
import { freshRunPageMemory, type RunPageMemory, type RunPageShown } from "./run-page.js";

/** The edge between the page and the conversation, which folds the page. */
export const runPageHandleHeight = 20;
/** A page with no picture to show is a row this tall, never a large empty box. */
export const runPageRowHeight = 52;
/** Before a picture says otherwise, a page is the shape of a desktop browser. */
export const runPageDesktopAspect = 1.6;
/** How much of the conversation stays in view under the page, at standard text size. */
export const runPageKeptTranscript = 132;

/** What a conversation shows of its Run's page, read by whatever stands for it folded. */
export interface RunPageView {
  readonly memory: RunPageMemory;
  readonly runId: string | null;
  readonly shown: RunPageShown;
  /** Whether there is room to open it here; without it, the folded picture opens the full tab. */
  readonly room: boolean;
}

export const freshRunPageView: RunPageView = {
  memory: freshRunPageMemory,
  runId: null,
  shown: "none",
  room: true,
};

interface Held {
  view: RunPageView;
  readonly listeners: Set<() => void>;
}

// Per attachment, so another Host or a sign-out starts from nothing; never persisted.
const held = new WeakMap<HostClient, Map<string, Held>>();

function heldFor(hostClient: HostClient, threadId: string): Held {
  let threads = held.get(hostClient);
  if (threads === undefined) held.set(hostClient, (threads = new Map()));
  let value = threads.get(threadId);
  if (value === undefined)
    threads.set(threadId, (value = { view: freshRunPageView, listeners: new Set() }));
  return value;
}

/** One conversation's page, for as long as this attachment lives. */
export function runPageView(hostClient: HostClient, threadId: string): RunPageView {
  return heldFor(hostClient, threadId).view;
}

export function changeRunPageView(
  hostClient: HostClient,
  threadId: string,
  change: (view: RunPageView) => RunPageView,
): void {
  const value = heldFor(hostClient, threadId);
  const next = change(value.view);
  if (
    next.memory === value.view.memory &&
    next.runId === value.view.runId &&
    next.shown === value.view.shown &&
    next.room === value.view.room
  )
    return;
  value.view = next;
  for (const listener of value.listeners) listener();
}

export function subscribeRunPageView(
  hostClient: HostClient,
  threadId: string,
  listener: () => void,
): () => void {
  const value = heldFor(hostClient, threadId);
  value.listeners.add(listener);
  return () => value.listeners.delete(listener);
}
