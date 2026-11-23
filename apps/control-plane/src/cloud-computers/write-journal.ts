/**
 * Shared journal transitions for pending provider/agent writes (T10).
 * Both pool host provider writes and pool slot agent writes share the same
 * begin -> send -> finish / recoverAfter state machine.
 */
export interface JournalWriteEntry {
  readonly token: string;
  readonly kind: string;
  readonly recoverAfter?: string | undefined;
  readonly dispatched?: boolean | undefined;
}

export const writeGraceMs = 3 * 60_000;
export const dispatchedWriteGraceMs = 15 * 60_000;

export type JournalTransition<W extends JournalWriteEntry> =
  { readonly allowed: false } | { readonly allowed: true; readonly nextWrites?: readonly W[] };

export function finishJournalWrite<W extends JournalWriteEntry>(
  writes: readonly W[],
  token: string,
): readonly W[] {
  return writes.filter((entry) => entry.token !== token);
}

export function beginJournalWrite<W extends JournalWriteEntry>(
  writes: readonly W[],
  write: W,
  now: Date,
): JournalTransition<W> {
  if (writes.some((entry) => entry.kind === write.kind)) {
    return { allowed: false };
  }
  return {
    allowed: true,
    nextWrites: [
      ...writes,
      {
        ...write,
        dispatched: false,
        recoverAfter: new Date(now.getTime() + writeGraceMs).toISOString(),
      },
    ],
  };
}

export function sendOrRecoverJournalWrite<W extends JournalWriteEntry>(
  writes: readonly W[],
  operation: "send" | "recover",
  token: string,
  now: Date,
  canSend: (write: W) => boolean,
): JournalTransition<W> {
  const write = writes.find((entry) => entry.token === token);
  if (!write) {
    return { allowed: operation === "recover" };
  }
  const expired = !!write.recoverAfter && Date.parse(write.recoverAfter) <= now.getTime();
  if (operation === "send") {
    if (!canSend(write) || expired) return { allowed: false };
    if (write.dispatched) return { allowed: true };
    return {
      allowed: true,
      nextWrites: writes.map((entry) =>
        entry.token === write.token
          ? {
              ...entry,
              dispatched: true,
              recoverAfter: new Date(now.getTime() + dispatchedWriteGraceMs).toISOString(),
            }
          : entry,
      ),
    };
  }
  if (!expired) return { allowed: false };
  return {
    allowed: true,
    nextWrites: writes.filter((entry) => entry.token !== token),
  };
}
