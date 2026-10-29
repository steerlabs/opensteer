import { setTimeout as delay } from "node:timers/promises";
import {
  ChannelConnectionError,
  ChannelDeliveryError,
  imessageChannelProviderManifest,
  normalizePersonalAddress,
  type ChannelAdapter,
  type ChannelConnectionIssue,
  type ChannelConnectionIssueKind,
  type NormalizedChannelEvent,
} from "@opensteer/channel-core";
import type {
  ComputerUseIMessagePollResult,
  IMessageAccount,
  IMessagePosition,
  IMessageRow,
} from "@opensteer/protocol";

/** What the adapter needs of the Mac's Opensteer Computer Use helper. */
export interface IMessageHelperPort {
  account(): Promise<{
    readonly account: IMessageAccount | null;
    readonly end: IMessagePosition | null;
  }>;
  poll(params: {
    readonly accountId: string;
    readonly after: IMessagePosition;
    readonly limit: number;
    readonly owner: string;
  }): Promise<ComputerUseIMessagePollResult>;
  send(params: {
    readonly accountId: string;
    readonly key: string;
    readonly owner: string;
    readonly text: string;
    readonly to: string;
  }): Promise<{ readonly key: string; readonly sentAt: string }>;
}

/** The helper's refusal, in the words the helper and every hop to it use. */
export class IMessageHelperError extends Error {
  readonly code:
    "busy" | "failed" | "outcome-unknown" | "delivery-unconfirmed" | "permission-required";

  constructor(code: IMessageHelperError["code"], message: string) {
    super(message);
    this.name = "IMessageHelperError";
    this.code = code;
  }
}

/**
 * Where each channel is in its Mac's Messages history, kept by the Runner
 * beside its own identity: the helper keeps no position, so this is the
 * channel's only memory of what it has already handed to the Host.
 */
export interface IMessageCursorStore {
  read(accountId: string): Promise<string | null>;
  write(accountId: string, cursor: string): Promise<void>;
}

const pageSize = 100;

/**
 * iMessage through this Mac's Messages, read and sent by its helper.
 *
 * The transport polls: each poll asks for the rows after the cursor and
 * renews this channel's claim on the Apple account. The cursor moves past a
 * row only once the Host has recorded the text it held, or once the helper
 * said it was not a text to answer, so a text the Host did not record is
 * asked for again and the Host's dedupe on the row's guid makes the repeat
 * harmless. A reply is sent under the delivery's id as its key, and the
 * helper sends a key once, so `reconcile` has nothing to look up: the send
 * that follows it is the lookup.
 */
export function createIMessageAdapter(options: {
  readonly cursors: IMessageCursorStore;
  readonly helper: IMessageHelperPort | null;
  readonly pollIntervalMs?: number;
}): ChannelAdapter {
  const { cursors, helper } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;

  return {
    manifest: imessageChannelProviderManifest,

    connection: {
      async inspect() {
        if (!helper)
          return notReady(issue("imessage.desktop_missing", "configuration", desktopMissing));
        let found;
        try {
          found = await helper.account();
        } catch (error) {
          return notReady(helperIssue(error));
        }
        if (!found.account)
          return notReady(issue("imessage.signed_out", "configuration", signedOut));
        return {
          capabilities: ["messages.receive", "messages.send"],
          identity: {
            accountDisplayName: found.account.handle ?? "iMessage",
            connectionDisplayName: `iMessage · ${found.account.handle ?? found.account.id}`,
            externalAccountId: found.account.id,
            // One channel per Apple account: the Host refuses a second.
            externalIdentityId: found.account.id,
            handle: found.account.handle,
            metadata: { initialCursor: encodeCursor(found.end ?? { guid: null, rowId: 0 }) },
          },
          issues: [],
          ready: true,
        };
      },

      async run(input) {
        if (!helper) throw stop(issue("imessage.desktop_missing", "configuration", desktopMissing));
        let cursor = await startingCursor(cursors, input.accountId, input.initialCursor);
        let ready = false;
        while (!input.signal.aborted) {
          let polled: ComputerUseIMessagePollResult;
          try {
            polled = await helper.poll({
              accountId: input.expectedAccountExternalId,
              after: cursor,
              limit: pageSize,
              owner: input.accountId,
            });
          } catch (error) {
            if (error instanceof IMessageHelperError && error.code === "permission-required") {
              throw waitFor(issue("imessage.permission", "permissions", error.message));
            }
            throw error;
          }
          const refusal = pollRefusal(polled);
          if (refusal) throw refusal;
          if (!ready) {
            ready = true;
            await input.onReady();
          }
          const moved = await deliver(
            polled.rows,
            cursor,
            input.expectedAccountExternalId,
            input.onEvent,
          );
          if (moved.cursor !== cursor) {
            cursor = moved.cursor;
            await cursors.write(input.accountId, encodeCursor(cursor));
          }
          // A full page may have more behind it; a short one, or one the Host
          // refused part of, waits for the next round.
          if (moved.complete && polled.rows.length === pageSize) continue;
          await delay(pollIntervalMs, undefined, { signal: input.signal }).catch(() => undefined);
        }
      },
    },

    outbound: {
      async reconcile() {
        return { kind: "unknown" as const };
      },

      async send(input) {
        if (!helper) throw new ChannelDeliveryError(desktopMissing, "retryable");
        const text = input.delivery.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n\n")
          .trim();
        try {
          const receipt = await helper.send({
            accountId: input.lease.externalAccountId,
            key: input.delivery.id,
            owner: input.lease.accountId,
            text: text.length > 0 ? text : "(No text content)",
            to: input.destination.externalUserId ?? input.destination.externalConversationId,
          });
          return { receipt: { key: receipt.key, sentAt: receipt.sentAt } };
        } catch (error) {
          if (error instanceof IMessageHelperError) {
            throw new ChannelDeliveryError(
              error.message,
              // The helper has durable evidence of an unconfirmed attempt.
              // It will never repeat it; leave its explanation for the owner.
              error.code === "delivery-unconfirmed"
                ? "dead"
                : error.code === "outcome-unknown"
                  ? "unknown"
                  : "retryable",
            );
          }
          // A reply whose answer never came back may have been sent.
          throw new ChannelDeliveryError("The Mac did not answer the send.", "unknown");
        }
      },
    },
  };
}

const desktopMissing = "iMessage needs the Opensteer desktop app on this Mac.";
const signedOut = "Messages on this Mac is not signed in to iMessage.";

/**
 * The texts in one page, each recorded by the Host before the cursor passes
 * it. `complete` is false when the Host refused one: the cursor stops before
 * it, and the next round asks for it again.
 */
async function deliver(
  rows: readonly IMessageRow[],
  from: IMessagePosition,
  accountExternalId: string,
  onEvent: (event: NormalizedChannelEvent) => Promise<void>,
): Promise<{ readonly complete: boolean; readonly cursor: IMessagePosition }> {
  let cursor = from;
  for (const row of rows) {
    if (row.message) {
      try {
        await onEvent(normalized(row, row.message, accountExternalId));
      } catch {
        return { complete: false, cursor };
      }
    }
    cursor = { guid: row.guid || null, rowId: row.rowId };
  }
  return { complete: true, cursor };
}

function normalized(
  row: IMessageRow,
  message: NonNullable<IMessageRow["message"]>,
  accountExternalId: string,
): NormalizedChannelEvent {
  // The form the owner's handles were linked in; an address of no known form
  // stays as Messages wrote it, a sender like any other stranger.
  const sender = normalizePersonalAddress(message.handle) ?? message.handle;
  return {
    accountExternalId,
    actor: { displayName: message.handle, externalUserId: sender },
    content: [{ text: message.text, type: "text" }],
    // A one-to-one conversation is the sender: v1 has no other kind.
    conversation: {
      displayName: null,
      externalConversationId: sender,
      externalScopeId: null,
      externalThreadId: null,
      type: "dm",
    },
    eventId: row.guid,
    occurredAt: message.sentAt,
    provider: "imessage",
    providerMessageId: row.guid,
    trigger: "direct-message",
  };
}

/**
 * The channel's place, from this Runner's store; else, before the channel was
 * ever connected, where setup said to start. A channel that was connected
 * and has no place here lost it — a wiped data directory, another Runner —
 * and picking one would either replay answered texts or skip unanswered ones.
 */
async function startingCursor(
  cursors: IMessageCursorStore,
  accountId: string,
  initialCursor: string | null,
): Promise<IMessagePosition> {
  const kept = await cursors.read(accountId);
  if (kept) {
    const position = decodeCursor(kept);
    if (position) return position;
  }
  const initial = initialCursor ? decodeCursor(initialCursor) : null;
  if (!initial) {
    throw stop(
      issue(
        "imessage.cursor_lost",
        "configuration",
        "This Mac lost its place in the channel's Messages history. Remove the iMessage channel and add it again.",
      ),
    );
  }
  await cursors.write(accountId, encodeCursor(initial));
  return initial;
}

/**
 * What stops the channel. The Mac's own state — the account's claim, the
 * account Messages is signed into — is waited out, because the person fixes
 * it on the Mac; a rebuilt history is not, because no fix brings the place
 * back.
 */
function pollRefusal(polled: ComputerUseIMessagePollResult): ChannelConnectionError | null {
  if (polled.claim === "busy") {
    return waitFor(
      issue(
        "imessage.claimed",
        "configuration",
        "Another Opensteer on this Mac is using this Apple account's iMessage.",
      ),
    );
  }
  if (polled.account === "changed") {
    return waitFor(
      issue(
        "imessage.account_changed",
        "credentials",
        "Messages on this Mac is signed in to a different Apple account than this channel was set up with.",
      ),
    );
  }
  if (polled.account === "signed-out") {
    return waitFor(issue("imessage.signed_out", "configuration", signedOut));
  }
  if (polled.cursor === "rebuilt") {
    return stop(
      issue(
        "imessage.history_rebuilt",
        "configuration",
        "Messages on this Mac rebuilt its history, so the channel stopped rather than answer texts twice. Remove the iMessage channel and add it again.",
      ),
    );
  }
  return null;
}

/** `<row id>:<guid>`, the guid empty at the start of an empty history. */
export function encodeCursor(position: IMessagePosition): string {
  return `${position.rowId}:${position.guid ?? ""}`;
}

export function decodeCursor(cursor: string): IMessagePosition | null {
  const separator = cursor.indexOf(":");
  if (separator < 1) return null;
  const rowText = cursor.slice(0, separator);
  if (!/^\d{1,16}$/u.test(rowText)) return null;
  const rowId = Number(rowText);
  const guid = cursor.slice(separator + 1);
  if (!Number.isSafeInteger(rowId) || guid.length > 256) return null;
  return { guid: guid.length > 0 ? guid : null, rowId };
}

function helperIssue(error: unknown): ChannelConnectionIssue {
  if (error instanceof IMessageHelperError && error.code === "permission-required") {
    return issue("imessage.permission", "permissions", error.message);
  }
  return issue(
    "imessage.unavailable",
    "transport",
    error instanceof Error ? error.message.slice(0, 500) : "The Mac did not answer.",
  );
}

function issue(
  code: string,
  kind: ChannelConnectionIssueKind,
  message: string,
): ChannelConnectionIssue {
  return { code, kind, message, missing: [] };
}

function notReady(found: ChannelConnectionIssue) {
  return { capabilities: [], identity: null, issues: [found], ready: false };
}

/** Needs a person, and nothing will change until the channel is set up again. */
function stop(found: ChannelConnectionIssue): ChannelConnectionError {
  return new ChannelConnectionError(found, { retryable: false });
}

/** Needs a person at the Mac, and the channel resumes once they have fixed it. */
function waitFor(found: ChannelConnectionIssue): ChannelConnectionError {
  return new ChannelConnectionError(found, { retryable: true });
}
