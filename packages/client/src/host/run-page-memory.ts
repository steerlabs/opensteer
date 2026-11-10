import type { HostClient } from "./client.js";
import { freshRunPageMemory, type RunPageMemory } from "./run-page.js";

interface Held {
  memory: RunPageMemory;
  readonly listeners: Set<() => void>;
}

// Per attachment, so another Host or a sign-out starts from nothing; never persisted.
const held = new WeakMap<HostClient, Map<string, Held>>();

function heldFor(hostClient: HostClient, threadId: string): Held {
  let threads = held.get(hostClient);
  if (threads === undefined) held.set(hostClient, (threads = new Map()));
  let value = threads.get(threadId);
  if (value === undefined)
    threads.set(threadId, (value = { memory: freshRunPageMemory, listeners: new Set() }));
  return value;
}

/** What a person has done with one conversation's live page, for as long as this attachment lives. */
export function runPageMemory(hostClient: HostClient, threadId: string): RunPageMemory {
  return heldFor(hostClient, threadId).memory;
}

export function changeRunPageMemory(
  hostClient: HostClient,
  threadId: string,
  change: (memory: RunPageMemory) => RunPageMemory,
): void {
  const value = heldFor(hostClient, threadId);
  const next = change(value.memory);
  if (next === value.memory) return;
  value.memory = next;
  for (const listener of value.listeners) listener();
}

export function subscribeRunPageMemory(
  hostClient: HostClient,
  threadId: string,
  listener: () => void,
): () => void {
  const value = heldFor(hostClient, threadId);
  value.listeners.add(listener);
  return () => value.listeners.delete(listener);
}
