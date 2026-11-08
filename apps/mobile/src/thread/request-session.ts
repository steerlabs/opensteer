import { hasSecretRequestFields, type Request } from "@opensteer/core";
import type { BrowserAccessSelection } from "@opensteer/client/host";
import type { PasswordSignInCard } from "@opensteer/protocol";
import type { BrowserSignInOutcome } from "@opensteer/protocol/browser-sources";
import { useState, useSyncExternalStore } from "react";
import type { RequestFormDraft, RequestSubmission } from "./request-form-model.js";

/**
 * What a person has started answering, held apart from the card and the sheet
 * because they are different routes and both answer the same Request. Closing
 * the sheet to read the Thread and opening it again finds every answer where it
 * was left, and a retry from either keeps the key of the answer it repeats.
 */
export interface RequestSession {
  answers: RequestFormDraft;
  /** Undefined means untouched, so the agent's suggestion still applies. */
  browserName: string | undefined;
  browserSelection: BrowserAccessSelection | null | undefined;
  chosenSourceId: string | null;
  /** An Allow the Host kept pending: Chrome is offline and it finishes by itself. */
  allowed: BrowserSignInOutcome | null;
  failure: string | null;
  held: RequestSubmission | null;
  heldPasswordKey: string | null;
  heldSignIn: { readonly key: string; readonly signature: string } | null;
  passwordCard: PasswordSignInCard | null;
  pendingId: string | null;
  /** The answer in flight, from whichever surface sent it. */
  responding: boolean;
  /** The sheet is up, so the card under it stops asking Chrome as well. */
  sheetOpen: boolean;
  version: number;
  readonly listeners: Set<() => void>;
}

function createSession(): RequestSession {
  return {
    allowed: null,
    answers: {},
    browserName: undefined,
    browserSelection: undefined,
    chosenSourceId: null,
    failure: null,
    held: null,
    heldPasswordKey: null,
    heldSignIn: null,
    listeners: new Set(),
    passwordCard: null,
    pendingId: null,
    responding: false,
    sheetOpen: false,
    version: 0,
  };
}

/** Oldest out first: a Request nobody finished answering is only ever a few bytes. */
const sessionLimit = 32;
const sessions = new Map<string, RequestSession>();

function sharedSession(requestId: string): RequestSession {
  const existing = sessions.get(requestId);
  if (existing !== undefined) return existing;
  const created = createSession();
  sessions.set(requestId, created);
  if (sessions.size > sessionLimit) {
    for (const [id, session] of sessions) {
      if (!session.responding && session.listeners.size === 0) {
        sessions.delete(id);
        break;
      }
    }
  }
  return created;
}

/**
 * A secret stays with the one surface it was typed into and goes when that
 * closes, because this store outlives every screen and every signed-in person.
 */
export function useRequestSession(request: Request): RequestSession {
  const [session] = useState(() =>
    hasSecretRequestFields(request) ? createSession() : sharedSession(request.id),
  );
  useSyncExternalStore(
    (listener) => {
      session.listeners.add(listener);
      return () => session.listeners.delete(listener);
    },
    () => session.version,
  );
  return session;
}

export function updateRequestSession(
  session: RequestSession,
  change: Partial<Omit<RequestSession, "listeners" | "version">>,
): void {
  Object.assign(session, change);
  session.version += 1;
  for (const listener of session.listeners) listener();
}

/** Test seam: forget every session between cases. */
export function resetRequestSessionsForTests(): void {
  sessions.clear();
}
