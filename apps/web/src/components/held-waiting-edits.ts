import { clientScopeKey } from "@opensteer/client/connections";
import { waitingDraftOutgoing, type HostClient, type WaitingDraft } from "@opensteer/client/host";
import type { ReturnedToDraft } from "./composer-drafts.js";

/**
 * Waiting-message edits a person was typing when their view went away for a
 * reason short of sign-out or another viewer (a same-viewer history rollback
 * unmounts the workspace, for one). The lease stays held and the words stay
 * here, keyed by login, task and message, until the view comes back and takes
 * them up again, or the message is found gone and the words go to the
 * composer. Sign-out and a change of viewer or login let each one go.
 */
export interface HeldWaitingEdit<Session, Draft> {
  readonly session: Session;
  readonly draft: Draft;
  /** Ends the lease the session holds; called when the words are let go. */
  readonly release: () => void;
}

const held = new Map<string, HeldWaitingEdit<unknown, unknown> & { readonly scope: string }>();
const watched = new WeakSet<HostClient>();

function key(scope: string, threadId: string, messageId: string) {
  return JSON.stringify([scope, threadId, messageId]);
}

/** The login a client acts for now, or null while it is not known. */
export function heldEditScope(client: HostClient): string | null {
  return clientScopeKey(client.connection?.getSnapshot().scope ?? null);
}

/** Keeps an edit for its view's return. */
export function holdWaitingEdit<Session, Draft>(
  client: HostClient,
  scope: string,
  threadId: string,
  messageId: string,
  edit: HeldWaitingEdit<Session, Draft>,
) {
  held.get(key(scope, threadId, messageId))?.release();
  held.set(key(scope, threadId, messageId), { ...edit, scope });
  watch(client);
}

/** The held edit of one message, taken out of the store; it is the caller's from here. */
export function takeWaitingEdit<Session, Draft>(
  scope: string,
  threadId: string,
  messageId: string,
): HeldWaitingEdit<Session, Draft> | undefined {
  const entry = held.get(key(scope, threadId, messageId));
  held.delete(key(scope, threadId, messageId));
  return entry as HeldWaitingEdit<Session, Draft> | undefined;
}

/** The held edits of one task under one login, by message. */
export function heldWaitingEdits(scope: string, threadId: string): readonly string[] {
  return [...held.keys()].flatMap((entry) => {
    const [heldScope, heldThread, messageId] = JSON.parse(entry) as [string, string, string];
    return heldScope === scope && heldThread === threadId ? [messageId] : [];
  });
}

/**
 * Once a task's queue is current again, an edit held for a message no longer waiting lets its
 * lease go and hands its words to the task's composer, so nothing typed is lost with it.
 */
export function returnGoneWaitingEdits(
  scope: string,
  threadId: string,
  waitingIds: readonly string[],
  handBack: (returned: ReturnedToDraft) => void,
) {
  const present = new Set(waitingIds);
  for (const messageId of heldWaitingEdits(scope, threadId)) {
    if (present.has(messageId)) continue;
    const edit = takeWaitingEdit<unknown, WaitingDraft>(scope, threadId, messageId);
    edit?.release();
    const words = edit && waitingDraftOutgoing(edit.draft);
    if (!words) continue;
    handBack({
      edit: (text) => (text.trim() ? `${words.text}\n\n${text}` : words.text),
      files: words.parts.flatMap((part) =>
        part.type === "artifact"
          ? [{ mediaType: part.mediaType, name: part.name, part, sizeBytes: part.sizeBytes ?? 0 }]
          : [],
      ),
      reason: "The message you were editing was taken before you saved; your words are here.",
    });
  }
}

/** Lets go of every edit not held for `scope`: null lets all of them go. */
function letGo(scope: string | null) {
  for (const [entry, edit] of held) {
    if (edit.scope === scope) continue;
    held.delete(entry);
    edit.release();
  }
}

function watch(client: HostClient) {
  if (watched.has(client)) return;
  watched.add(client);
  const check = () => {
    if (client.getSnapshot().session === "authentication-required") return letGo(null);
    const scope = heldEditScope(client);
    // A rollback can pass through no known login; only another login lets the words go.
    if (scope !== null) letGo(scope);
  };
  // A client without a shell to watch (a test double) keeps its edits until they are taken.
  client.subscribe?.(check);
  client.connection?.subscribe?.(check);
}

/** Test seam: forget every held edit between cases. */
export function resetHeldWaitingEditsForTests() {
  held.clear();
}
