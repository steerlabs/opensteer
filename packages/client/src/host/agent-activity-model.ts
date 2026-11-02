import type {
  AssignmentSummary,
  BrowserTabWriteInput,
  WaitingRequest,
  MessageAuthor,
  IntegrationCallSubject,
  ThreadWriteInput,
} from "@opensteer/core";
import type { TriggerWriteInput } from "@opensteer/triggers";
import { readComputerUseResultHeadline, readComputerStepHeadline } from "@opensteer/protocol";
import { isRecord } from "@opensteer/shared/isRecord";
import type {
  AssignmentEntry,
  DelegationEntry,
  MessageEntry,
  PlaceEntry,
  ReasoningEntry,
  RequestReceiptEntry,
  RunEntry,
  NodeEntry,
  ToolEntry,
  TranscriptEntry,
} from "./client.js";
import { browserSiteLabel } from "./browser-sign-in.js";
import { browserSignInStep, readBrowserSignInResult, type BrowserSignInStep } from "./passwords.js";
import { requestWaitingOnAssignment } from "./waiting-requests.js";
import { isTerminalRunEntryStatus } from "./transcript.js";

/**
 * How a Thread's transcript reads, decided once for every client.
 *
 * An agent's turn is a chronological stream of prose and compact tool rows.
 * Reasoning and messages always stand on their own; only adjacent tool steps
 * can fold into a digest. Web, desktop and mobile draw this structure with their own
 * controls; none of them decides what belongs together or what a step is
 * called.
 */

/**
 * The glyph a trace row asks for, named rather than drawn: this module decides
 * what a step *is*, and each application draws that from its own icon set. The
 * names are the web's, because that set is the one the product already speaks.
 */
export type ActivityIcon =
  | "alert-circle"
  | "asterisk"
  | "browser"
  | "check-circle"
  | "file"
  | "folder"
  | "globe"
  | "laptop"
  | "list"
  | "pencil"
  | "puzzle"
  | "search"
  | "share"
  | "sparkles"
  | "stop"
  | "terminal";

/**
 * A step's state as the reader should weigh it.
 *
 * `error` is a step that reported failure — a command that exited non-zero, a
 * page that would not load. The agent reads that result and carries on, so it
 * is information, never alarm: only a Run that failed is drawn as a failure,
 * and that is the Run's outcome, not a step's tone.
 *
 * `stopped` is a call that never returned, and also a Computer use step that
 * stopped before finishing: its result carries a fresh observation, so the
 * agent has what it needs to carry on and nothing failed.
 */
export type ActivityTone = "decided" | "done" | "error" | "running" | "stopped";

export type ActivitySurface = "browser";

/** Everything that happens inside a turn's work, the agent's own notes included. */
export type WorkEntry =
  MessageEntry | NodeEntry | PlaceEntry | ReasoningEntry | RequestReceiptEntry | ToolEntry;

export type ActivityFeedEntry = Exclude<
  TranscriptEntry,
  {
    kind:
      | "assignment"
      | "assignment-return"
      | "delivery"
      | "message"
      | "place"
      | "request-wait"
      | "selection"
      | "withdrawn";
  }
>;

/**
 * One contiguous stretch of a Run. A Run is one turn unless something arrived
 * in the middle of it — a steer, another Thread's result — in which case each
 * stretch is its own turn, and the Run's outcome sits with the last one.
 */
export interface Turn {
  readonly personWaiting?: boolean;
  readonly startedBy?: MessageAuthor;
  readonly source?: {
    readonly author: MessageAuthor;
    readonly createdAt: string;
    readonly task?: AssignmentEntry["assignment"];
  };

  /**
   * The Run goes on in a later stretch, after a message that joined it: this
   * stretch says only what it did, and the reply in progress is the later one's.
   */
  readonly continued?: boolean;
  readonly inputQueuePaused?: boolean;
  /** Why the Thread's queued work has not started, as `threadStartHold` words it. */
  readonly startHold?: string | null;
  /** The Run, on its latest stretch only: it is what says the turn is live and how it ended. */
  readonly run: RunEntry | null;
  readonly runId: string | null;
  /**
   * What the Run answered: the message the Host recorded as its reply when it
   * completed. It stays in `work` where it happened; this names it.
   */
  readonly reply: MessageEntry | null;
  /**
   * Steps, and everything the agent wrote, in the order it happened. A
   * subagent stands where it started, in place of the call that started it.
   */
  readonly work: readonly WorkEntry[];
  /** What each subagent did, by node id: its steps and the subagents it started. */
  readonly subagentWork: Readonly<Record<string, readonly WorkEntry[]>>;
  /**
   * Work this turn handed to other Threads. Each stays with the turn that
   * started it, below what the agent said about it, however far the turn went on.
   */
  readonly assignments: readonly AssignmentEntry[];
}

export type TranscriptGroup =
  | { readonly key: string; readonly kind: "assignment"; readonly entry: AssignmentEntry }
  | { readonly key: string; readonly kind: "delegation"; readonly entry: DelegationEntry }
  | {
      readonly key: string;
      readonly kind: "message";
      readonly entry: MessageEntry;
      /** It joined a Run already under way, as a steer does, rather than starting one. */
      readonly joinedRun?: true;
    }
  | { readonly key: string; readonly kind: "turn"; readonly turn: Turn };

/**
 * The transcript in reading order. Entries keep their first-arrival order; a
 * turn gathers only what is adjacent and belongs to the same Run, so nothing
 * is pulled out of the position it arrived in.
 */
export function groupTranscriptEntries(
  entries: readonly TranscriptEntry[],
  {
    inputQueuePaused = false,
    startHold = null,
    assignments = {},
  }: {
    readonly inputQueuePaused?: boolean;
    readonly startHold?: string | null;
    readonly assignments?: Readonly<Record<string, AssignmentSummary>>;
  } = {},
): TranscriptGroup[] {
  type Slot =
    | { readonly group: TranscriptGroup; readonly kind: "group" }
    | {
        /** The message that joined the Run this stretch carries on, if one opened it. */
        readonly after?: string;
        readonly entries: TranscriptEntry[];
        readonly kind: "stretch";
        readonly runId: string | null;
      };

  const slots: Slot[] = [];
  // A turn that answered while its work ran on in the background ends there:
  // what the Run does next is a turn of its own, with a reply of its own.
  const turnReplies = new Set(
    entries.flatMap((entry) => (entry.kind === "run" ? (entry.turnReplyMessageIds ?? []) : [])),
  );
  let open: Extract<Slot, { kind: "stretch" }> | null = null;
  // Each subagent's stretch: its later steps belong with it, wherever the
  // Run's own agent has got to since.
  const nodeStretch = new Map<string, Extract<Slot, { kind: "stretch" }>>();
  const runsDrawn = new Set<string>();
  for (const entry of entries) {
    // The composer shows the current AI choice; its retained history is state, not conversation.
    if (entry.kind === "selection") continue;
    if (entry.kind === "delegation") {
      // Another Thread's result arriving is news, not this Run's work: it can
      // land long after the Run that asked for it has replied.
      open = null;
      slots.push({ group: { entry, key: entry.id, kind: "delegation" }, kind: "group" });
      continue;
    }
    // Work handed on belongs to the turn that handed it on. Only one no Run
    // started — an automation's — stands on its own.
    if (entry.kind === "assignment" && entry.runId === null) {
      open = null;
      slots.push({ group: { entry, key: entry.id, kind: "assignment" }, kind: "group" });
      continue;
    }
    // A task's outcome starts what follows. Its card already shows how the task
    // ended, and the reply after it says what came back, so it draws nothing.
    if (entry.kind === "assignment-return") {
      open = null;
      continue;
    }
    if (entry.kind === "message" && entry.addressedToUserId) {
      slots.push({ group: { entry, key: entry.id, kind: "message" }, kind: "group" });
      open = { after: entry.id, entries: [], kind: "stretch", runId: entry.runId };
      slots.push(open);
      continue;
    }
    if (entry.kind === "message" && (entry.messageKind === "input" || entry.runId === null)) {
      open = null;
      // A Run's first entry follows the message that seeds it, so a Run already
      // drawn above is one this message joined while it ran.
      const joinedRun =
        entry.messageKind === "input" && entry.runId !== null && runsDrawn.has(entry.runId);
      slots.push({
        group: { entry, key: entry.id, kind: "message", ...(joinedRun ? { joinedRun } : {}) },
        kind: "group",
      });
      // A message a Run took — its seed, or one that joined it while it ran —
      // is answered by what that Run does next, so the Run carries on after
      // it even before it has done anything more.
      if (entry.messageKind === "input" && entry.runId !== null) {
        open = { after: entry.id, entries: [], kind: "stretch", runId: entry.runId };
        slots.push(open);
      }
      continue;
    }
    // A withdrawn message left nothing to read, and an outcome whose message
    // is not loaded has nothing to sit on; their markers, and an open wait's,
    // only serve a page merge.
    if (entry.kind === "withdrawn" || entry.kind === "delivery" || entry.kind === "request-wait")
      continue;
    if (entry.kind === "run" && entry.runId === null) continue;
    const owner =
      entry.kind === "tool" ? entry.nodeId : entry.kind === "node" ? entry.parentNodeId : null;
    const home = owner ? nodeStretch.get(owner) : undefined;
    if (home && home !== open) {
      home.entries.push(entry);
      if (entry.kind === "node") nodeStretch.set(entry.nodeId, home);
      continue;
    }
    if (open === null || open.runId !== entry.runId) {
      open = { entries: [], kind: "stretch", runId: entry.runId };
      slots.push(open);
    }
    open.entries.push(entry);
    if (entry.runId !== null) runsDrawn.add(entry.runId);
    if (entry.kind === "node") nodeStretch.set(entry.nodeId, open);
    if (entry.kind === "message" && turnReplies.has(entry.id)) open = null;
  }

  const runs = new Map<string, RunEntry>();
  const lastStretch = new Map<string, Extract<Slot, { kind: "stretch" }>>();
  for (const slot of slots) {
    if (slot.kind !== "stretch" || slot.runId === null) continue;
    lastStretch.set(slot.runId, slot);
    for (const entry of slot.entries) if (entry.kind === "run") runs.set(slot.runId, entry);
  }

  const inputsByRun = new Map<string | null, MessageEntry[]>();
  const returnsByRun = new Map<
    string | null,
    Extract<TranscriptEntry, { kind: "assignment-return" }>
  >();
  const assignmentsById = new Map(Object.entries(assignments));
  for (const entry of entries) {
    if (entry.kind === "message" && entry.messageKind === "input") {
      const inputs = inputsByRun.get(entry.runId) ?? [];
      inputs.push(entry);
      inputsByRun.set(entry.runId, inputs);
    } else if (entry.kind === "assignment-return" && !returnsByRun.has(entry.runId)) {
      returnsByRun.set(entry.runId, entry);
    } else if (entry.kind === "assignment") {
      assignmentsById.set(entry.assignment.id, entry.assignment);
    }
  }

  const groups: TranscriptGroup[] = [];
  for (const slot of slots) {
    if (slot.kind === "group") {
      groups.push(slot.group);
      continue;
    }
    const { runId } = slot;
    const run =
      runId !== null && lastStretch.get(runId) === slot ? (runs.get(runId) ?? null) : null;
    // A steer or a turn's reply can split a Run, and each reply is in whichever
    // stretch it was written.
    const runEntry = runId === null ? undefined : runs.get(runId);
    const replies = new Set([
      ...(runEntry?.replyMessageId ? [runEntry.replyMessageId] : []),
      ...(runEntry?.turnReplyMessageIds ?? []),
    ]);
    const continued = runId !== null && lastStretch.get(runId) !== slot;
    const inputs = inputsByRun.get(runId) ?? [];
    const returning = returnsByRun.get(runId);
    const returnId =
      returning?.assignmentId ??
      (runEntry?.startedBy?.kind === "platform" && runEntry.startedBy.cause === "assignment-result"
        ? runEntry.startedBy.referenceId
        : undefined);
    const task = returnId ? assignmentsById.get(returnId) : undefined;
    const seed = inputs.find((entry) => entry.author.kind !== "human");
    const startedBy = runEntry?.startedBy;
    const turn = {
      ...(startedBy ? { startedBy } : {}),
      personWaiting:
        startedBy === undefined ||
        runEntry?.personWaiting === true ||
        inputs.some((entry) => entry.author.kind === "human"),
      ...(startedBy && startedBy.kind !== "human"
        ? {
            source: {
              author: startedBy,
              createdAt: returning?.createdAt ?? seed?.createdAt ?? runEntry!.createdAt,
              ...(task ? { task } : {}),
            },
          }
        : {}),
      ...turnFrom(slot.entries, runId, run, replies),
      ...(continued ? { continued } : {}),
      inputQueuePaused,
      startHold,
    };
    if (!turnHasContent(turn)) continue;
    // A stretch is named by where it began — the Run's own start, or the first
    // entry after whatever interrupted it — so neither streaming nor loading
    // an earlier page renames a turn a reader has open. One with nothing in it
    // yet is named by the message it follows.
    const head = slot.entries.find((entry) => entry.kind === "run") ?? slot.entries[0];
    const key = head ? head.id : slot.after ? `after:${slot.after}` : (runId ?? "none");
    groups.push({ key: `turn:${key}`, kind: "turn", turn });
  }
  return groups;
}

function turnFrom(
  entries: readonly TranscriptEntry[],
  runId: string | null,
  run: RunEntry | null,
  replies: ReadonlySet<string>,
): Turn {
  const assignments = entries.filter(
    (entry): entry is AssignmentEntry => entry.kind === "assignment",
  );
  const all = entries.filter(
    (entry): entry is WorkEntry =>
      entry.kind !== "run" && entry.kind !== "delegation" && entry.kind !== "assignment",
  );
  const spawnCalls = new Set(
    all.flatMap((entry) =>
      entry.kind === "node" && entry.originCallId !== null ? [entry.originCallId] : [],
    ),
  );
  const work: WorkEntry[] = [];
  const subagentWork: Record<string, WorkEntry[]> = {};
  for (const entry of all) {
    // A subagent stands in place of the call that started it, at any depth.
    if (entry.kind === "tool" && spawnCalls.has(entry.callId)) continue;
    const owner = workOwner(entry);
    if (owner !== null) {
      (subagentWork[owner] ??= []).push(entry);
      continue;
    }
    work.push(entry);
  }
  const reply =
    work.findLast(
      (entry): entry is MessageEntry => entry.kind === "message" && replies.has(entry.id),
    ) ?? null;
  return { assignments, reply, run, runId, subagentWork, work };
}

/** The subagent a step belongs to, or null for the Run's own agent. */
function workOwner(entry: WorkEntry): string | null {
  if (entry.kind === "tool") return entry.nodeId ?? null;
  if (entry.kind === "node") return entry.parentNodeId;
  return null;
}

function turnHasContent(turn: Turn): boolean {
  if (turn.work.length > 0 || turn.assignments.length > 0) return true;
  return (
    turn.run !== null && (!isTerminalRunEntryStatus(turn.run.status) || hasRunOutcome(turn.run))
  );
}

/**
 * Whether a finished Run has anything to say below its reply: a failure, a
 * stop, or that it completed without writing a reply. A Run that simply
 * answered says nothing more.
 */
export function hasRunOutcome(run: RunEntry): boolean {
  return (
    run.status === "failed" ||
    run.status === "interrupted" ||
    (run.status === "completed" && run.replyMessageId === null)
  );
}

/* ---- The turn's head ---- */

export type TurnState = "live" | "settled" | "stopping" | "waiting";

/**
 * Where the turn is. The Run says so when this is its latest stretch; an
 * earlier stretch, or one whose Run is on a page not loaded, is live only
 * while one of its own steps still is.
 */
export function turnState(turn: Turn): TurnState {
  const { run } = turn;
  if (run !== null) {
    if (isTerminalRunEntryStatus(run.status) || (run.status === "queued" && turn.inputQueuePaused))
      return "settled";
    if (run.stopping === true) return "stopping";
    return run.status === "waiting" ? "waiting" : "live";
  }
  return turn.work.some(isProducing) ? "live" : "settled";
}

/**
 * Whether a task's turn has steps to fold behind its status line. The line
 * leads the turn whether it is live or settled, so finishing changes only its
 * words. A turn that only spoke has nothing to fold.
 */
export function turnFolds(turn: Turn): boolean {
  return turn.work.some((entry) => entry.kind !== "message");
}

/**
 * Whether a task's turn shows its whole story. Under way, it is told as it
 * happens: what the agent says between the steps it takes, in order. Settled,
 * it folds to its last word. The reader's own choice, once made, holds.
 */
export function turnOpen(turn: Turn, chosen: boolean | null): boolean {
  return chosen ?? turnState(turn) !== "settled";
}

/**
 * What a folded turn still shows: its last word — the reply the Run named, or
 * else the last thing the agent wrote. What it said on the way is part of the
 * story behind the status line, so it never runs into the answer.
 */
export function turnWords(turn: Turn): readonly WorkEntry[] {
  const last = turn.reply ?? turn.work.findLast((entry) => entry.kind === "message");
  return last === undefined ? [] : [last];
}

/** Why a live turn's Run is still queued, when the client knows; otherwise null. */
function turnStartHold(turn: Turn): string | null {
  return turn.run?.status === "queued" && turnState(turn) === "live"
    ? (turn.startHold ?? null)
    : null;
}

/* ---- A conversation ---- */

/**
 * What a conversation shows of one turn. Opensteer's reply is its message, and
 * while its turn is under way Opensteer is composing one. Everything else the
 * turn did and wrote is its steps, which a reader opens on request. The tasks
 * it started and how its Run ended are drawn beside these, as they are
 * everywhere else.
 */
export interface ConversationTurn {
  readonly composing: boolean;
  /** What the reply under way is doing, in words, while it is being composed. */
  readonly composingLabel: string | null;
  /** Whether there is anything behind the reply to open. */
  readonly detailed: boolean;
  readonly reply: MessageEntry | null;
  /** Why the turn's Run has not started, said where typing would stand. */
  readonly startHold: string | null;
  readonly steps: readonly WorkEntry[];
}

export function conversationTurn(turn: Turn): ConversationTurn {
  const startHold = turn.personWaiting === false ? null : turnStartHold(turn);
  // A Run working in the background is not writing anything, nobody is writing
  // for one that has not started, and one a message joined is writing its
  // reply after that message, not here.
  const composing =
    turn.personWaiting !== false &&
    startHold === null &&
    turn.reply === null &&
    turn.continued !== true &&
    turnState(turn) === "live" &&
    turn.run?.background !== true;
  const work = stepsOf(turn);
  const last = work.at(-1);
  // Drafts are not steps, wherever the live stream is drawn. A trailing
  // recorded message remains provisional until more work follows it. A message
  // recorded into an earlier draft slot stays a step until the Run names its reply.
  const steps = composing
    ? work.filter(
        (entry) => entry.kind !== "message" || (entry.streaming !== true && entry !== last),
      )
    : work;
  return {
    composing,
    composingLabel: composing ? liveLabel(turn, "live") : null,
    detailed: steps.length > 0,
    reply: turn.reply,
    startHold,
    steps,
  };
}

/** A group as a conversation draws it. */
export interface ConversationRow {
  readonly group: TranscriptGroup;
  /**
   * What the row is drawn under, kept from the moment it is drawn. It is for
   * drawing only: a turn is named by its group's key everywhere else.
   */
  readonly key: string;
}

interface ConversationRowOptions {
  readonly waitingRequests?: readonly WaitingRequest[];
  readonly atComputer: (turn: Turn) => boolean;
  readonly live: boolean;
}

/**
 * What a conversation draws, in order: every group except a turn with nothing
 * of its own to show. The stretch of a reply before a message that joined it,
 * or a reply waiting on an approval, holds only steps, which that reply's
 * Activity shows; drawn, it would leave an empty row between the person's
 * messages. `live` is whether the transcript can say a reply is being written.
 * `atComputer` is whether the screen draws a live turn for its work on a
 * computer, which only the screen can say: it holds the Macs its reader is
 * shown and the Stops they pressed there.
 *
 * The reply under way after a message that joined it is drawn under that
 * message's place from the moment it is empty, so its first step does not
 * draw it afresh and its typing does not start over; every other row is drawn
 * under its group's key.
 */
export function conversationRows(
  groups: readonly TranscriptGroup[],
  options: ConversationRowOptions,
): readonly ConversationRow[] {
  const rows: ConversationRow[] = [];
  const automaticRuns = new Set(
    groups.flatMap((group) =>
      group.kind === "turn" &&
      group.turn.startedBy !== undefined &&
      group.turn.startedBy.kind !== "human"
        ? [group.turn.runId]
        : [],
    ),
  );
  for (const original of groups) {
    const group =
      original.kind === "turn" && original.turn.personWaiting === false
        ? {
            ...original,
            turn: {
              ...original.turn,
              assignments: original.turn.assignments.filter((entry) =>
                conversationAssignmentNeedsReader(entry, options.waitingRequests),
              ),
            },
          }
        : original;
    if (
      group.kind === "assignment" &&
      group.entry.assignment.origin !== "run" &&
      !conversationAssignmentNeedsReader(group.entry, options.waitingRequests)
    )
      continue;
    if (
      group.kind === "message" &&
      group.entry.messageKind === "input" &&
      group.entry.author.kind !== "human" &&
      group.entry.runId !== null &&
      automaticRuns.has(group.entry.runId)
    )
      continue;
    if (group.kind === "turn" && !conversationTurnShows(group.turn, options)) continue;
    const previous = rows.at(-1)?.group;
    const joined =
      group.kind === "turn" &&
      previous?.kind === "message" &&
      previous.entry.messageKind === "input" &&
      previous.entry.runId !== null &&
      previous.entry.runId === group.turn.runId;
    rows.push({ group, key: joined ? `turn:after:${previous.entry.id}` : group.key });
  }
  return rows;
}

/**
 * Its reply, typing or why it has not started, the tasks it handed out, how
 * its Run ended, or its work on a computer.
 */
function conversationTurnShows(turn: Turn, { atComputer, live }: ConversationRowOptions): boolean {
  if (turn.personWaiting === false)
    return turn.reply !== null || turn.assignments.length > 0 || (live && atComputer(turn));
  const { composing, reply, startHold } = conversationTurn(turn);
  return (
    reply !== null ||
    turn.assignments.length > 0 ||
    (turn.run !== null && (hasRunOutcome(turn.run) || (turn.run.attempt ?? 1) > 1)) ||
    (live && (composing || startHold !== null || atComputer(turn)))
  );
}

/** Only decisions and failures interrupt Chat for work nobody asked to follow. */
export function conversationAssignmentNeedsReader(
  entry: AssignmentEntry,
  waiting: readonly WaitingRequest[] = [],
): boolean {
  return (
    requestWaitingOnAssignment(waiting, entry.assignment.id) !== null ||
    entry.assignment.status === "failed"
  );
}

/** A silent reply uses the Run's whole elapsed time, including waiting. */
export function silentRunLabel(run: RunEntry): string {
  if (!run.startedAt) return "Worked";
  return `Worked for ${formatDuration(Math.max(0, Date.parse(run.endedAt ?? run.createdAt) - Date.parse(run.startedAt)))}`;
}

/* ---- Activity ---- */

/** Which reply's Activity to show: the one under way, else the latest; or one turn's own. */
export type ConversationActivitySelection =
  { readonly kind: "latest" } | { readonly key: string; readonly kind: "turn" };

/**
 * What one reply did, as Activity shows it. A message that joins a Run splits
 * it into stretches around that message, and only the last of them carries
 * the reply; so a reply's Activity is every stretch of its Run since the reply
 * before it, gathered into one turn. Nothing the Run did is left in a stretch
 * that no reply leads to.
 */
export interface ConversationActivity {
  /** The key of the turn it ends with: the reply's, or the one still at work. */
  readonly key: string;
  /** Every turn it gathers, so that any of their keys finds it. */
  readonly keys: readonly string[];
  /** The reply is still under way: being written, waiting on the reader, or stopping. */
  readonly live: boolean;
  readonly reply: MessageEntry | null;
  /** What it did and said on the way, in order: `conversationTurn`'s steps of `turn`. */
  readonly steps: readonly WorkEntry[];
  /** Its stretches as one turn, which draws those steps with the reply's own state. */
  readonly turn: Turn;
}

/** Every reply's Activity in a conversation, in the order the replies stand. */
export function conversationActivities(
  groups: readonly TranscriptGroup[],
): readonly ConversationActivity[] {
  interface Gathering {
    readonly keys: string[];
    last: number;
    readonly turns: Turn[];
  }
  const gathered: Gathering[] = [];
  // Each Run's stretches since its last reply, which the next reply ends.
  const open = new Map<string, Gathering>();
  groups.forEach((group, index) => {
    if (group.kind !== "turn") return;
    const { runId } = group.turn;
    let exchange = runId === null ? undefined : open.get(runId);
    if (!exchange) {
      exchange = { keys: [], last: index, turns: [] };
      gathered.push(exchange);
    }
    exchange.keys.push(group.key);
    exchange.turns.push(group.turn);
    exchange.last = index;
    if (runId === null) return;
    if (group.turn.reply === null) open.set(runId, exchange);
    else open.delete(runId);
  });
  return gathered
    .sort((left, right) => left.last - right.last)
    .map(({ keys, turns }) => {
      const turn = joinedTurn(turns);
      return {
        key: keys.at(-1) ?? "",
        keys,
        live: turn.reply === null && turnState(turn) !== "settled",
        reply: turn.reply,
        steps: conversationTurn(turn).steps,
        turn,
      };
    });
}

/**
 * The Activity to show. The latest is the reply under way, or once there is
 * none the latest reply that did or said anything. A turn's own is the reply
 * whose stretches include it; null for a turn the transcript no longer holds.
 */
export function conversationActivityTurn(
  groups: readonly TranscriptGroup[],
  selection: ConversationActivitySelection,
): ConversationActivity | null {
  const activities = conversationActivities(groups);
  if (selection.kind === "turn") {
    return activities.find(({ keys }) => keys.includes(selection.key)) ?? null;
  }
  return (
    activities.findLast(({ live }) => live) ??
    activities.findLast(({ reply, steps }) => reply !== null || steps.length > 0) ??
    null
  );
}

/**
 * Which reply's Activity holds a step on the way to it — a message said
 * there, or the record of a Request answered there — or null for a message
 * the conversation shows itself. A search or a link that names such a step
 * opens that Activity rather than the conversation. The answer is the key of
 * the turn the step is in: it already holds something, so the reply going on
 * does not rename it, as it can the stretch a reply has only just begun.
 */
export function conversationTurnRevealing(
  groups: readonly TranscriptGroup[],
  entryId: string,
): string | null {
  const activity = conversationActivities(groups).find(({ steps }) =>
    steps.some(({ id }) => id === entryId),
  );
  if (!activity) return null;
  const holding = groups.find(
    (group) =>
      group.kind === "turn" &&
      activity.keys.includes(group.key) &&
      group.turn.work.some(({ id }) => id === entryId),
  );
  return holding?.key ?? null;
}

/** A Run's stretches as one turn: the last one's state, and all they did in order. */
function joinedTurn(turns: readonly Turn[]): Turn {
  const [only] = turns;
  const last = turns.at(-1);
  if (!last || !only) throw new Error("A reply gathers at least one turn.");
  if (turns.length === 1) return only;
  const subagentWork: Record<string, WorkEntry[]> = {};
  for (const turn of turns) {
    for (const [nodeId, work] of Object.entries(turn.subagentWork)) {
      (subagentWork[nodeId] ??= []).push(...work);
    }
  }
  return {
    ...last,
    assignments: turns.flatMap((turn) => turn.assignments),
    subagentWork,
    work: turns.flatMap((turn) => turn.work),
  };
}

/**
 * How far into a transcript its reader has been shown, by the Host's message
 * sequence. Active intermediate messages hold back the watermark until a reply
 * or addressed message settles their stretch, even if the Run continues.
 * A Run whose own entry is not loaded is under way while its turn still is.
 */
export function observedSequence(
  entries: readonly TranscriptEntry[],
  conversation: boolean,
): string | null {
  let unshown: bigint | null = null;
  if (conversation) {
    const runs = new Map<string, RunEntry>();
    const addressed = new Map<string, bigint>();
    for (const entry of entries) {
      if (
        entry.kind === "message" &&
        entry.addressedToUserId &&
        entry.published !== false &&
        entry.runId &&
        entry.sequence !== undefined
      ) {
        const sequence = BigInt(entry.sequence);
        if (sequence > (addressed.get(entry.runId) ?? -1n)) addressed.set(entry.runId, sequence);
      }
      if (entry.kind === "run" && entry.runId !== null) runs.set(entry.runId, entry);
    }
    for (const group of groupTranscriptEntries(entries)) {
      if (group.kind !== "turn") continue;
      const run = group.turn.runId === null ? undefined : runs.get(group.turn.runId);
      const underWay = run
        ? !isTerminalRunEntryStatus(run.status)
        : turnState(group.turn) !== "settled";
      // A turn that has answered shows what it wrote, though its Run goes on.
      if (!underWay || group.turn.reply !== null) continue;
      for (const entry of group.turn.work) {
        if (entry.kind !== "message" || entry.sequence === undefined) continue;
        const sequence = BigInt(entry.sequence);
        // An addressed message makes the preceding stretch observable while its Run continues.
        if (sequence <= (addressed.get(entry.runId ?? "") ?? -1n)) continue;
        if (unshown === null || sequence < unshown) unshown = sequence;
      }
    }
  }
  let furthest: bigint | null = null;
  for (const entry of entries) {
    if (entry.kind !== "message" || entry.published === false) continue;
    if (entry.sequence === undefined) continue;
    const sequence = BigInt(entry.sequence);
    if (unshown !== null && sequence >= unshown) continue;
    if (furthest === null || sequence > furthest) furthest = sequence;
  }
  return furthest === null ? null : furthest.toString();
}

/** Only published messages the transcript shows can be missed by its reader. */
export function incomingTranscriptMessages(
  entries: readonly TranscriptEntry[],
  viewerUserId: string | null,
  conversation: boolean,
): readonly (MessageEntry & { readonly sequence: string })[] {
  // A turn's intermediate messages are inside its steps. Only its reply is
  // a message in the conversation, even after that turn has finished.
  const messages = conversation
    ? groupTranscriptEntries(entries).flatMap((group) =>
        group.kind === "message"
          ? [group.entry]
          : group.kind === "turn" && group.turn.reply !== null
            ? [group.turn.reply]
            : [],
      )
    : entries.filter((entry): entry is MessageEntry => entry.kind === "message");
  return messages.filter(
    (entry): entry is MessageEntry & { readonly sequence: string } =>
      entry.kind === "message" &&
      entry.sequence !== undefined &&
      entry.published !== false &&
      entry.streaming !== true &&
      !(entry.author.kind === "human" && entry.author.userId === viewerUserId),
  );
}

/** What a turn did and wrote on the way to its reply. */
function stepsOf(turn: Turn): readonly WorkEntry[] {
  return turn.reply === null ? turn.work : turn.work.filter((entry) => entry !== turn.reply);
}

function isProducing(entry: WorkEntry): boolean {
  return (
    (entry.kind === "tool" && entry.state === "running") ||
    (entry.kind === "node" && entry.status === "running") ||
    (entry.kind === "reasoning" && entry.state === "streaming") ||
    (entry.kind === "message" && entry.streaming === true)
  );
}

/**
 * A turn's status line, in words alone. What the work consisted of, and which
 * of its steps failed, is in the steps the line opens: the agent reads a
 * failed step and carries on, so a count of them beside the line would only
 * alarm. A Run that failed says so below the turn.
 */
export interface WorkSummary {
  /** While live, what the agent is doing now; once settled, how long it took. */
  readonly label: string;
  readonly state: TurnState;
}

/**
 * A task's turn's status line, or null when it has none. The line stands while
 * the turn is under way, when it has steps to open, and when its Run ended
 * without a reply, which only the line can say; a turn that settled on its
 * words alone did no work to sum up.
 */
export function workSummary(turn: Turn): WorkSummary | null {
  const { run } = turn;
  const state = turnState(turn);
  const silent = run?.status === "completed" && run.replyMessageId === null;
  if (state === "settled" && !turnFolds(turn) && !silent) return null;
  if (run?.status === "queued" && turn.inputQueuePaused) return { label: "Queued", state };
  if (state !== "settled") return { label: liveLabel(turn, state), state };
  // The work is what came before the reply: writing the answer is not more of it.
  const steps = stepsOf(turn);
  const duration = workDuration(steps);
  const onlyThinking = steps.length > 0 && steps.every((entry) => entry.kind === "reasoning");
  const verb = onlyThinking ? "Thought" : "Worked";
  return {
    label:
      silent && run.endedAt ? silentRunLabel(run) : duration ? `${verb} for ${duration}` : verb,
    state,
  };
}

/** One app on a Mac, or the whole phone, named by the Host's resolved subject. */
type ComputerPlace =
  | ({ readonly kind: "app" } & Readonly<NonNullable<IntegrationCallSubject["computerApp"]>>)
  | ({ readonly kind: "phone" } & Readonly<NonNullable<IntegrationCallSubject["phone"]>>);

function computerPlace(tool: ToolEntry): ComputerPlace | null {
  const subject = tool.integration;
  if (subject?.computerApp) return { kind: "app", ...subject.computerApp };
  if (subject?.phone) return { kind: "phone", ...subject.phone };
  return null;
}

/**
 * Where a live turn's latest step happened. A failed step that never reached
 * the computer is not the agent being there. A phone's action leaves its name
 * to the place beside it, so the live line says the name only once.
 */
export type TurnComputer = ComputerPlace & { readonly action: string };

export function turnComputer(turn: Turn): TurnComputer | null {
  if (turnState(turn) !== "live") return null;
  const latest = turn.work.findLast((entry): entry is ToolEntry => entry.kind === "tool");
  const place = latest ? computerPlace(latest) : null;
  if (!latest || !place || toolTone(latest) === "error") return null;
  return {
    ...place,
    action:
      latest.state === "running" && isComputerUseCall(latest)
        ? place.kind === "phone" && latest.integration?.effect === "read"
          ? "Looking"
          : toolPresentation(latest).activeLabel
        : place.kind === "app"
          ? `Using ${place.app}`
          : "Using",
  };
}

function liveLabel(turn: Turn, state: Exclude<TurnState, "settled">): string {
  if (state === "stopping") return "Stopping";
  if (state === "waiting") return "Waiting for you";
  // The turn is over; what it started runs on in the background.
  if (turn.run?.background) {
    const live = [...turn.work, ...Object.values(turn.subagentWork).flat()].filter(
      (entry) => entry.kind === "node" && entry.status === "running",
    ).length;
    return live > 0 ? `Background · ${countNoun(live, "task")}` : "Background";
  }
  const computer = turnComputer(turn);
  if (computer) {
    if (computer.kind === "phone") {
      const preposition =
        computer.action === "Using" ? " " : computer.action === "Looking" ? " at " : " on ";
      return `${computer.action}${preposition}${computer.computer}`;
    }
    return `${computer.action} on ${computer.computer}`;
  }
  for (let index = turn.work.length - 1; index >= 0; index -= 1) {
    const entry = turn.work[index];
    if (entry?.kind === "tool" && entry.state === "running") {
      return toolPresentation(entry).activeLabel;
    }
    if (entry?.kind === "reasoning" && entry.state === "streaming") return "Thinking";
    if (entry?.kind === "node" && entry.status === "running") return `Subagent: ${entry.title}`;
  }
  for (let index = turn.work.length - 1; index >= 0; index -= 1) {
    const entry = turn.work[index];
    if (entry?.kind !== "message") break;
    if (entry.streaming === true) return "Writing";
  }
  const startHold = turnStartHold(turn);
  if (startHold !== null) return startHold;
  if (turn.run?.status === "queued" || turn.run?.status === "starting") return "Starting";
  return "Working";
}

/**
 * From the first thing the agent did to the last, less what it waited on a
 * person for. A decision is the person's, so its receipt bounds no work: it
 * can come long after a durable Request let the Run finish.
 */
function workDuration(work: readonly WorkEntry[]): string | null {
  const done = work.filter((entry) => entry.kind !== "request");
  const started = done
    .map((entry) => Date.parse(entry.createdAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  const completed = done
    .map((entry) =>
      Date.parse(
        entry.kind === "tool" || entry.kind === "reasoning"
          ? (entry.completedAt ?? entry.createdAt)
          : entry.createdAt,
      ),
    )
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  if (started === undefined || completed === undefined || completed < started) return null;
  const waits = work
    .flatMap((entry) =>
      entry.kind === "request" && entry.waitedSince !== undefined
        ? [[Date.parse(entry.waitedSince), Date.parse(entry.createdAt)] as const]
        : [],
    )
    .sort(([left], [right]) => left - right);
  let waited = 0;
  let counted = started;
  for (const [from, to] of waits) {
    const begin = Math.max(from, counted);
    const end = Math.min(to, completed);
    if (end <= begin) continue;
    waited += end - begin;
    counted = end;
  }
  return formatDuration(completed - started - waited);
}

function countNoun(count: number, noun: string): string {
  const plural = noun === "search" ? "searches" : `${noun}s`;
  return `${count} ${count === 1 ? noun : plural}`;
}

/* ---- The digest ---- */

/**
 * Prose interrupts a tool group. Keeping it as a sibling prevents a tool or
 * run-status disclosure from owning the visibility of something the agent said.
 */
export type WorkRow =
  | {
      readonly entries: readonly (RequestReceiptEntry | ToolEntry)[];
      /** What the row's steps share, so a renderer can lay a Computer use row out as a timeline. */
      readonly group: StepGroup | null;
      readonly head: ActivityStepHead;
      readonly key: string;
      readonly kind: "steps";
    }
  | { readonly entry: MessageEntry; readonly key: string; readonly kind: "note" }
  /** A subagent: its own steps are the turn's `subagentWork` under its node id. */
  | {
      readonly entry: NodeEntry;
      readonly head: ActivityStepHead;
      readonly key: string;
      readonly kind: "subagent";
    }
  /** Where the Run began acting in a browser tab: a point in the trace, not a span. */
  | { readonly entry: PlaceEntry; readonly key: string; readonly kind: "place" }
  | { readonly entry: ReasoningEntry; readonly key: string; readonly kind: "reasoning" };

export type StepGroup = "command" | "computer" | "edit" | "explore" | "integrations" | "web";

// Bounds what a long turn mounts and redraws on each streamed step on a phone.
export const traceWindowRows = 30;

/**
 * The rows an open trace draws: its latest, where the story is, with how many
 * earlier ones wait behind one control. A kept entry extends the window back
 * to its row, including when it belongs to a digest. The last word stays drawn.
 */
export function traceWindow(
  rows: readonly WorkRow[],
  { showAll, keep }: { readonly showAll: boolean; readonly keep: string | null },
): { rows: readonly WorkRow[]; hidden: number } {
  let hidden = showAll ? 0 : Math.max(0, rows.length - traceWindowRows);
  if (keep !== null && hidden > 0) {
    const index = rows.findIndex((row) =>
      row.kind === "steps" ? row.entries.some((entry) => entry.id === keep) : row.entry.id === keep,
    );
    if (index >= 0) hidden = Math.min(hidden, index);
  }
  return { rows: hidden === 0 ? rows : rows.slice(hidden), hidden };
}

/**
 * Rows are only ever appended to or grown at the end, so a row's key — its
 * first entry — is stable while the turn streams, and a row a reader opened
 * stays open.
 */
export function workRows(work: readonly WorkEntry[]): WorkRow[] {
  type Steps = {
    entries: (RequestReceiptEntry | ToolEntry)[];
    group: StepGroup | null;
    /** Steps join a row only when they share this: the group, and for Computer use the app and Runner. */
    joinKey: string | null;
    key: string;
    kind: "steps";
  };
  const result: (Exclude<WorkRow, { kind: "steps" }> | Steps)[] = [];

  for (const entry of work) {
    const last = result.at(-1);
    if (entry.kind === "message") {
      result.push({ entry, key: `note:${entry.id}`, kind: "note" });
      continue;
    }
    if (entry.kind === "reasoning") {
      result.push({ entry, key: `reasoning:${entry.id}`, kind: "reasoning" });
      continue;
    }
    if (entry.kind === "node") {
      result.push({ entry, head: nodeHead(entry), key: `subagent:${entry.id}`, kind: "subagent" });
      continue;
    }
    if (entry.kind === "place") {
      result.push({ entry, key: `place:${entry.id}`, kind: "place" });
      continue;
    }
    const group = entry.kind === "tool" ? stepGroup(toolPresentation(entry).kind) : null;
    const joinKey = entry.kind === "tool" && group !== null ? groupJoinKey(entry, group) : null;
    if (last?.kind === "steps" && joinKey !== null && last.joinKey === joinKey) {
      last.entries.push(entry);
      continue;
    }
    const row = {
      entries: [entry],
      group,
      joinKey,
      key: `row:${entry.id}`,
      kind: "steps" as const,
    };
    result.push(row);
  }

  return result.map((row) =>
    row.kind !== "steps"
      ? row
      : {
          entries: row.entries,
          group: row.group,
          head: rowHead(row.entries, row.group),
          key: row.key,
          kind: "steps",
        },
  );
}

/**
 * Computer use folds steps on one app or phone. Runner ids keep computers
 * apart even when they share a display name.
 */
function groupJoinKey(tool: ToolEntry, group: StepGroup): string {
  if (group !== "computer") return group;
  const place = computerPlace(tool);
  return place
    ? place.kind === "phone"
      ? `phone:${place.runnerId}`
      : `computer:${place.bundleId}\u0000${place.runnerId}`
    : group;
}

function stepGroup(kind: StepKind): StepGroup | null {
  switch (kind) {
    case "command":
      return "command";
    case "list":
    case "read":
    case "search":
      return "explore";
    case "edit":
      return "edit";
    case "computer":
      return "computer";
    case "integration-lookup":
      return "integrations";
    case "web-page":
    case "web-search":
      return "web";
    default:
      return null;
  }
}

function rowHead(
  entries: readonly (RequestReceiptEntry | ToolEntry)[],
  group: StepGroup | null,
): ActivityStepHead {
  const [first] = entries;
  if (first === undefined) throw new Error("A tool group must contain a step");
  if (group === "computer" && first.kind === "tool") return computerRowHead(entries, first);
  if (entries.length === 1 || group === null) return activityStepHead(first);

  const tools = entries.filter((entry): entry is ToolEntry => entry.kind === "tool");
  const running = tools.findLast((entry) => entry.state === "running");
  const errors = errorCount(tools);
  const tone: ActivityTone = running
    ? "running"
    : tools.some((entry) => entry.state === "stopped")
      ? "stopped"
      : errors === tools.length
        ? "error"
        : "done";
  const live = running ? toolPresentation(running) : null;
  const liveDetail = live ? live.hint || live.activeLabel : null;
  const presentations = tools.map(toolPresentation);

  switch (group) {
    case "command":
      return {
        detail: liveDetail ?? "",
        detailKind: "code",
        duration: null,
        errors,
        icon: "terminal",
        label: running ? "Running commands" : `Ran ${tools.length} commands`,
        tone,
      };
    case "explore":
      return {
        detail: liveDetail ?? exploreCounts(presentations),
        detailKind: liveDetail ? "code" : "prose",
        duration: null,
        errors,
        icon: "search",
        label: running ? "Exploring" : "Explored",
        tone,
      };
    case "edit": {
      const paths = [...new Set(presentations.flatMap((presentation) => presentation.paths))];
      return {
        detail: paths.map(baseName).join(", "),
        detailKind: "code",
        duration: null,
        errors,
        icon: "pencil",
        label: running
          ? "Editing files"
          : `Edited ${paths.length > 1 ? `${paths.length} files` : paths.length === 1 ? baseName(paths[0] ?? "") : `${tools.length} times`}`,
        tone,
      };
    }
    case "computer":
      throw new Error("A Computer use row has its own head");
    case "integrations": {
      // Every search here was a Mac listing its apps, or some were integration lookups.
      const listingApps = tools.every(listsAppsOnMac);
      const searches = tools.filter((entry) => entry.tool?.name === "integration_search");
      const looked = [...new Set(presentations.map((presentation) => presentation.hint))];
      return {
        detail:
          liveDetail ??
          (searches.length > 0
            ? searchedFor(searches.map((entry) => stringField(effectiveArguments(entry), "query")))
            : looked.filter(Boolean).join(", ")),
        detailKind: "prose",
        duration: null,
        errors,
        icon: "puzzle",
        label: running
          ? listingApps
            ? "Listing apps on a Mac"
            : "Looking up integrations"
          : listingApps
            ? "Listed apps on a Mac"
            : "Looked up integrations",
        tone,
      };
    }
    case "web": {
      const searches = presentations.filter(
        (presentation) => presentation.kind === "web-search",
      ).length;
      const pages = presentations.length - searches;
      return {
        detail:
          liveDetail ??
          [
            searches > 0 ? countNoun(searches, "search") : "",
            pages > 0 ? countNoun(pages, "page") : "",
          ]
            .filter(Boolean)
            .join(", "),
        detailKind: liveDetail ? "code" : "prose",
        duration: null,
        errors,
        icon: "globe",
        label: running
          ? "Browsing the web"
          : pages === 0
            ? "Searched the web"
            : searches === 0
              ? `Read ${pages} pages`
              : "Browsed the web",
        tone,
      };
    }
  }
}

/**
 * One app or phone, however many steps it took. A Mac row names the app and
 * the Mac; a phone row names the phone once. Reading how to act stays in the
 * row but is not counted as a step taken on the computer. A step that stopped before finishing only paints the row while
 * it is the latest thing that happened, so a stop the agent recovered from
 * reads as done.
 */
function computerRowHead(
  entries: readonly (RequestReceiptEntry | ToolEntry)[],
  first: ToolEntry,
): ActivityStepHead {
  const place = computerPlace(first);
  const tools = entries.filter((entry): entry is ToolEntry => entry.kind === "tool");
  const errors = errorCount(tools);
  if (tools.length === 1) {
    const head = activityStepHead(first);
    return {
      ...head,
      detail:
        head.detail ||
        (first.state === "running" && place?.kind !== "phone" ? "" : computerStepPlace(first)),
      detailKind: "prose",
    };
  }
  const app = place?.kind === "phone" ? place.computer : (place?.app ?? "an app");
  const running = tools.findLast((entry) => entry.state === "running");
  if (running) {
    return {
      detail:
        place?.kind === "phone" &&
        running.integration?.effect === "read" &&
        isComputerUseCall(running)
          ? "Looking"
          : toolPresentation(running).activeLabel,
      detailKind: "prose",
      duration: null,
      errors,
      icon: "laptop",
      label: `Using ${app}`,
      tone: "running",
    };
  }
  const calls = tools.filter(isComputerUseCall).length;
  const latest = tools.at(-1);
  return {
    detail: [
      calls > 0 ? countNoun(calls, "step") : "",
      place?.kind === "app" ? `on ${place.computer}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    detailKind: "prose",
    duration: null,
    errors,
    icon: "laptop",
    label: `Used ${app}`,
    tone: latest ? toolTone(latest) : "done",
  };
}

/**
 * Where a Computer use step happened outside its row. A phone is named only
 * when the step itself does not already name it.
 */
function computerStepPlace(tool: ToolEntry): string {
  const place = computerPlace(tool);
  if (!place) return "";
  if (place.kind === "phone") return computerStepNamesPlace(tool) ? "" : place.computer;
  return computerStepNamesPlace(tool)
    ? `on ${place.computer}`
    : `${place.app} on ${place.computer}`;
}

function listsAppsOnMac(tool: ToolEntry): boolean {
  return (
    tool.tool?.name === "integration_search" &&
    stringField(effectiveArguments(tool), "runnerId") !== null
  );
}

function exploreCounts(presentations: readonly ToolPresentation[]): string {
  const reads = presentations.filter((presentation) => presentation.kind === "read").length;
  const searches = presentations.length - reads;
  return [
    reads > 0 ? `${reads} ${reads === 1 ? "file" : "files"}` : "",
    searches > 0 ? countNoun(searches, "search") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function thoughtHead(thoughts: readonly ReasoningEntry[]): ActivityStepHead {
  const streaming = thoughts.some((entry) => entry.state === "streaming");
  const last = thoughts.at(-1);
  const elapsed = thoughts.reduce((sum, entry) => sum + (elapsedMilliseconds(entry) ?? 0), 0);
  return {
    detail: last ? reasoningHeadline(last.text) : "",
    detailKind: "prose",
    duration: null,
    errors: 0,
    icon: "asterisk",
    label: streaming
      ? "Thinking"
      : elapsed >= 1_000
        ? `Thought for ${formatDuration(elapsed)}`
        : "Thought",
    tone: streaming ? "running" : "done",
  };
}

/* ---- Steps ---- */

/**
 * One step's row, however the step was produced. Reasoning, tool calls and
 * resolved decisions reduce to the same shape, so a renderer never branches
 * on an entry kind to draw a head.
 */
export interface ActivityStepHead {
  detail: string;
  detailKind: "code" | "prose";
  duration: string | null;
  /** How many of the steps under this head reported an error. */
  errors: number;
  icon: ActivityIcon;
  label: string;
  /** The Workspace surface this step's work lives on, for a client that can show it. */
  surface?: ActivitySurface;
  tone: ActivityTone;
}

export function activityStepHead(
  entry: DelegationEntry | NodeEntry | ReasoningEntry | RequestReceiptEntry | ToolEntry,
): ActivityStepHead {
  switch (entry.kind) {
    case "node":
      return nodeHead(entry);
    case "delegation":
      return delegationHead(entry);
    case "request":
      return {
        detail: entry.outcome,
        detailKind: "prose",
        duration: null,
        errors: 0,
        // A declined Request, or a sign-in that did not sign in, must not read
        // as done at a glance.
        icon: entry.declined ? "stop" : entry.succeeded === false ? "alert-circle" : "check-circle",
        label: entry.title,
        tone: entry.declined || entry.succeeded === false ? "stopped" : "decided",
      };
    case "reasoning":
      return thoughtHead([entry]);
    case "tool": {
      const presentation = toolPresentation(entry);
      const tone = toolTone(entry);
      return {
        detail: presentation.hint,
        detailKind: presentation.hintKind,
        duration: entry.state === "running" ? null : significantDuration(entry),
        errors: tone === "error" ? 1 : 0,
        icon: presentation.icon,
        label: entry.state === "running" ? presentation.activeLabel : presentation.label,
        ...(presentation.surface && entry.state === "done"
          ? { surface: presentation.surface }
          : {}),
        tone,
      };
    }
  }
}

/** A subagent's head: what it was asked to do, and how far it got. */
function nodeHead(node: NodeEntry): ActivityStepHead {
  const tone: ActivityTone =
    node.status === "running"
      ? "running"
      : node.status === "completed"
        ? "done"
        : node.status === "failed"
          ? "error"
          : "stopped";
  const ran =
    node.completedAt === null ? null : Date.parse(node.completedAt) - Date.parse(node.createdAt);
  return {
    detail: node.model ?? "",
    detailKind: "prose",
    duration: ran !== null && ran >= 1_000 ? formatDuration(ran) : null,
    errors: node.status === "failed" ? 1 : 0,
    icon: "sparkles",
    label: `Subagent: ${node.title}`,
    tone,
  };
}

function toolTone(tool: ToolEntry): ActivityTone {
  switch (tool.state) {
    case "failed":
      return computerUseHeadline(tool) === null ? "error" : "stopped";
    case "stopped":
      return "stopped";
    case "done":
      // A sign-in that came back without signing in must not read as done.
      return signInResult(tool)?.signedIn === false ? "stopped" : "done";
    default:
      return tool.state;
  }
}

function errorCount(tools: readonly ToolEntry[]): number {
  return tools.filter((tool) => toolTone(tool) === "error").length;
}

function delegationHead(entry: DelegationEntry): ActivityStepHead {
  const title = entry.childThread.title;
  if (entry.delivery.status === "undeliverable") {
    return {
      detail: "This Thread can no longer receive the result.",
      detailKind: "prose",
      duration: null,
      errors: 1,
      icon: "alert-circle",
      label: `Could not deliver ${title}'s result`,
      tone: "error",
    };
  }
  if (entry.outcome === "failed") {
    return {
      detail: entry.failure?.message ?? entry.resultPreview ?? "",
      detailKind: "prose",
      duration: null,
      errors: 1,
      icon: "alert-circle",
      label: `${title} failed`,
      tone: "error",
    };
  }
  if (entry.outcome === "interrupted") {
    return {
      detail: entry.resultPreview ? firstLine(entry.resultPreview) : "",
      detailKind: "prose",
      duration: null,
      errors: 0,
      icon: "stop",
      label: `${title} stopped`,
      tone: "stopped",
    };
  }
  return {
    detail: entry.resultPreview ? firstLine(entry.resultPreview) : "Completed",
    detailKind: "prose",
    duration: null,
    errors: 0,
    icon: "check-circle",
    label: `${title} completed`,
    tone: "done",
  };
}

/** A reasoning summary's first line, without the Markdown that dresses it as a heading. */
export function reasoningHeadline(text: string): string {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find(Boolean);
  if (!line) return "";
  return line
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^(\*\*|__)(.+)\1$/u, "$2")
    .trim();
}

/**
 * The trace carries a duration only when it says something. Sub-second calls
 * are the common case and their timing is noise.
 */
function significantDuration(entry: ReasoningEntry | ToolEntry): string | null {
  const elapsed = elapsedMilliseconds(entry);
  return elapsed === null || elapsed < 1_000 ? null : formatDuration(elapsed);
}

function elapsedMilliseconds(entry: ReasoningEntry | ToolEntry): number | null {
  if (!entry.completedAt) return null;
  const started = Date.parse(entry.createdAt);
  const completed = Date.parse(entry.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  return completed - started;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return "<1s";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const minutesLeft = minutes % 60;
    return minutesLeft ? `${hours}h ${minutesLeft}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const hoursLeft = hours % 24;
  return hoursLeft ? `${days}d ${hoursLeft}h` : `${days}d`;
}

/* ---- Tools ---- */

export type StepKind =
  | "browser"
  | "command"
  | "computer"
  | "delegate"
  | "edit"
  | "integration-call"
  | "integration-lookup"
  | "integration-request"
  | "list"
  | "plan"
  | "read"
  | "search"
  | "task"
  | "tool"
  | "web-page"
  | "web-search";

export interface ToolPresentation {
  /** How the step reads while the call is still open. */
  activeLabel: string;
  /**
   * The command the step ran, as a person would type it. A command too long
   * for its record keeps its start and end around a note of what was omitted.
   */
  command: string | null;
  /** True when the label is the engine's own description of the step. */
  describes: boolean;
  hint: string;
  /** Whether the hint is verbatim (a path, a command) or words about the step. */
  hintKind: "code" | "prose";
  icon: ActivityIcon;
  kind: StepKind;
  label: string;
  /** Files the step changed or read. */
  paths: readonly string[];
  surface?: ActivitySurface;
}

/**
 * Provider-neutral display mapping over the identities each driver reports.
 * Each engine names the same handful of tools its own way; they all read the
 * same here. A tool no table knows still reads as a named step.
 */
export function toolPresentation(tool: ToolEntry): ToolPresentation {
  const identity = tool.tool;
  const args = effectiveArguments(tool);
  if (
    identity?.name === "computer" &&
    (identity.namespace === "opensteer.integrations" ||
      identity.namespace === "mcp:opensteer_integrations")
  )
    return step({
      activeLabel: "Running computer code",
      label: "Ran computer code",
      hint: "",
      icon: "laptop",
      kind: "tool",
    });
  const place = computerPlace(tool);
  if (tool.integration && place && isComputerUseCall(tool))
    return computerPresentation(tool, tool.integration, place);
  const kind = identity ? toolKinds.get(`${identity.namespace}/${identity.name}`) : undefined;

  if (identity?.namespace === "opensteer") {
    const present = opensteerSteps.get(identity.name);
    if (present) return present(tool, args);
  }

  if (identity?.namespace === "opensteer.integrations") {
    const presentation = integrationPresentation(tool, identity.name, args);
    if (presentation) return presentation;
  }

  switch (kind) {
    case "command":
      return commandPresentation(args);
    case "read": {
      const paths = pathsFrom(args);
      return step({
        activeLabel: "Reading a file",
        hint: paths.join(", ") || (stringField(args, "query") ?? ""),
        icon: "file",
        kind: "read",
        label: "Read a file",
        paths,
      });
    }
    case "search":
      return step({
        activeLabel: "Searching the code",
        hint: stringField(args, "pattern", "query", "regex") ?? pathsFrom(args).join(", "),
        icon: "search",
        kind: "search",
        label: "Searched the code",
      });
    case "list":
      return step({
        activeLabel: "Listing files",
        hint: stringField(args, "pattern", "globPattern", "glob") ?? pathsFrom(args).join(", "),
        icon: "folder",
        kind: "list",
        label: "Listed files",
      });
    case "edit": {
      const paths = pathsFrom(args);
      return step({
        activeLabel: "Editing files",
        hint: paths.join(", "),
        icon: "pencil",
        kind: "edit",
        label: paths.length === 1 ? `Edited ${baseName(paths[0] ?? "")}` : "Edited files",
        paths,
      });
    }
    case "web-search":
      return webSearchPresentation(args);
    case "web-page":
      return step({
        activeLabel: "Reading a page",
        hint: stringField(args, "url") ?? "",
        icon: "globe",
        kind: "web-page",
        label: "Read a page",
      });
    case "plan":
      return step({
        activeLabel: "Updating the plan",
        hint: planSummary(args),
        icon: "list",
        kind: "plan",
        label: "Updated the plan",
      });
    case "delegate": {
      const description = stringField(args, "description");
      return step({
        activeLabel: "Running a subagent",
        hint: description ?? stringField(args, "prompt") ?? "",
        icon: "share",
        kind: "delegate",
        label: "Ran a subagent",
      });
    }
  }

  const label = humanizeToolName(identity?.name ?? "");
  return step({
    activeLabel: label,
    // A gateway tool's arguments carry opaque references, never words.
    hint: identity?.namespace === "opensteer.integrations" ? "" : summarizeUnknown(args),
    icon:
      identity?.namespace === "opensteer.integrations" ||
      identity?.namespace.startsWith("mcp:") ||
      identity?.namespace === "opensteer"
        ? "puzzle"
        : "sparkles",
    kind: "tool",
    label,
  });
}

function step(
  presentation: Partial<ToolPresentation> &
    Pick<ToolPresentation, "activeLabel" | "hint" | "icon" | "kind" | "label">,
): ToolPresentation {
  return { command: null, describes: false, hintKind: "code", paths: [], ...presentation };
}

type OpensteerStep = (tool: ToolEntry, args: unknown) => ToolPresentation;
type StepWords = readonly [active: string, done: string];

/** A step that reads the same whatever it was given. */
function said([activeLabel, label]: StepWords, icon: ActivityIcon): OpensteerStep {
  return () => step({ activeLabel, hint: "", icon, kind: "tool", label });
}

/**
 * A step that says which of its tool's actions it took, and the name it gave
 * when there is one. An action only a newer Runner offers reads as `otherwise`.
 */
function saidByAction<Action extends string>(
  words: Readonly<Record<Action, StepWords>>,
  otherwise: StepWords,
  icon: ActivityIcon,
  named: string | null = null,
): OpensteerStep {
  const byAction = new Map<string, StepWords>(Object.entries<StepWords>(words));
  return (_tool, args) => {
    const [activeLabel, label] = byAction.get(stringField(args, "action") ?? "") ?? otherwise;
    const hint = named === null ? "" : (stringField(args, named) ?? "");
    return step({ activeLabel, hint, hintKind: "prose", icon, kind: "tool", label });
  };
}

const tabActions: Record<BrowserTabWriteInput["action"], StepWords> = {
  close: ["Closing tabs", "Closed tabs"],
  group: ["Grouping tabs", "Grouped tabs"],
  move: ["Moving tabs", "Moved tabs"],
  restore: ["Restoring tabs", "Restored tabs"],
  ungroup: ["Ungrouping tabs", "Ungrouped tabs"],
  update_group: ["Updating a tab group", "Updated a tab group"],
};

const taskActions: Record<ThreadWriteInput["action"], StepWords> = {
  done: ["Marking a task done", "Marked a task done"],
  rename: ["Renaming a task", "Renamed a task"],
  reopen: ["Reopening a task", "Reopened a task"],
  set_icon: ["Changing a task’s icon", "Changed a task’s icon"],
};

const automationActions: Record<TriggerWriteInput["action"], StepWords> = {
  cancel: ["Cancelling an automation run", "Cancelled an automation run"],
  create: ["Creating an automation", "Created an automation"],
  run: ["Running an automation", "Ran an automation"],
  set_next_fire: ["Rescheduling an automation", "Rescheduled an automation"],
  set_status: ["Changing an automation", "Changed an automation"],
  update: ["Changing an automation", "Changed an automation"],
};

/**
 * Opensteer's own tools, by what each step did and never by the tool's name.
 * It holds every tool the agent catalog offers and the names older Runners
 * still report; `tests/opensteer-tool-steps.test.ts` keeps it that way.
 */
const opensteerSteps = new Map<string, OpensteerStep>([
  ["assignment_cancel", said(["Stopping a task", "Stopped a task"], "stop")],
  [
    "browser_access_request",
    said(["Asking for browser access", "Asked for browser access"], "browser"),
  ],
  [
    "browser_profile_create",
    said(["Creating a browser profile", "Created a browser profile"], "browser"),
  ],
  [
    "browser_profile_list",
    said(["Looking up browser profiles", "Looked up browser profiles"], "browser"),
  ],
  [
    "browser_profile_save",
    said(["Saving the browser profile", "Saved the browser profile"], "browser"),
  ],
  ["browser_session_close", said(["Closing the browser", "Closed the browser"], "browser")],
  ["browser_session_list", said(["Looking up browsers", "Looked up browsers"], "browser")],
  [
    "browser_session_open",
    (_tool, args) =>
      step({
        activeLabel: "Opening a browser",
        hint: browserSessionHint(args),
        icon: "browser",
        kind: "browser",
        label: "Opened a browser",
        surface: "browser",
      }),
  ],
  ["browser_sign_in", signInPresentation],
  ["browser_tab_read", said(["Looking at saved tabs", "Looked at saved tabs"], "browser")],
  ["browser_tab_write", saidByAction(tabActions, ["Arranging tabs", "Arranged tabs"], "browser")],
  ["environment_list", said(["Looking up computers", "Looked up computers"], "laptop")],
  [
    "machine_full_disk_access_request",
    said(["Asking for full access to a Mac", "Asked for full access to a Mac"], "laptop"),
  ],
  ["request_list", said(["Checking its requests", "Checked its requests"], "list")],
  ["request_withdraw", said(["Withdrawing a request", "Withdrew a request"], "stop")],
  ["sign_in", signInPresentation],
  [
    "thread_delegate",
    (_tool, args) =>
      step({
        activeLabel: "Starting a task",
        hint: stringField(args, "title") ?? stringField(args, "task") ?? "",
        hintKind: "prose",
        icon: "share",
        kind: "task",
        label: "Started a task",
      }),
  ],
  ["person_notify", said(["Sending a notification", "Sent a notification"], "share")],
  ["thread_list", said(["Looking up conversations", "Looked up conversations"], "list")],
  ["thread_message", said(["Sending a message", "Sent a message"], "share")],
  ["thread_read", said(["Reading a conversation", "Read a conversation"], "list")],
  [
    "thread_write",
    saidByAction(taskActions, ["Changing a task", "Changed a task"], "pencil", "title"),
  ],
  ["trigger_read", said(["Looking up automations", "Looked up automations"], "list")],
  [
    "trigger_write",
    saidByAction(
      automationActions,
      ["Changing an automation", "Changed an automation"],
      "pencil",
      "name",
    ),
  ],
  [
    "workspace_create",
    (_tool, args) =>
      step({
        activeLabel: "Creating a workspace",
        hint: stringField(args, "name") ?? "",
        hintKind: "prose",
        icon: "folder",
        kind: "tool",
        label: "Created a workspace",
      }),
  ],
  ["workspace_list", said(["Looking up workspaces", "Looked up workspaces"], "folder")],
  ["workspace_mount", said(["Opening a workspace", "Opened a workspace"], "folder")],
]);

/** Every engine's name for each kind of step it shares with the others. */
const toolKinds = new Map<string, StepKind>(
  (
    [
      [
        "command",
        ["codex/shell", "claude/Bash", "cursor/shell", "pi/bash", "pi/powershell", "opencode/bash"],
      ],
      ["read", ["claude/Read", "cursor/read", "pi/read", "opencode/read"]],
      ["search", ["claude/Grep", "cursor/grep", "pi/grep", "opencode/grep"]],
      [
        "list",
        [
          "claude/Glob",
          "claude/LS",
          "cursor/glob",
          "cursor/ls",
          "pi/find",
          "pi/ls",
          "opencode/glob",
          "opencode/list",
        ],
      ],
      [
        "edit",
        [
          "codex/apply_patch",
          "claude/Edit",
          "claude/MultiEdit",
          "claude/Write",
          "claude/NotebookEdit",
          "cursor/edit",
          "cursor/write",
          "pi/edit",
          "pi/write",
          "opencode/edit",
          "opencode/write",
          "opencode/patch",
          "opencode/multiedit",
        ],
      ],
      [
        "web-search",
        ["codex/web_search", "claude/WebSearch", "cursor/web_search", "opencode/websearch"],
      ],
      ["web-page", ["claude/WebFetch", "opencode/webfetch"]],
      ["plan", ["codex.dynamic/update_plan", "claude/TodoWrite", "opencode/todowrite"]],
      ["delegate", ["claude/Task", "opencode/task"]],
    ] as const
  ).flatMap(([kind, names]) => names.map((name) => [name, kind] as const)),
);

function commandPresentation(args: unknown): ToolPresentation {
  const command = commandFrom(args);
  const shown = command === null ? "" : withoutWorkingDirectory(command);
  const description = stringField(args, "description");
  if (description) {
    const label = sentence(description);
    return step({
      activeLabel: label,
      command,
      describes: true,
      hint: shown,
      icon: "terminal",
      kind: "command",
      label,
    });
  }
  const action = codexCommandAction(args);
  if (action) return { ...action, command };
  return step({
    activeLabel: "Running a command",
    command,
    hint: shown,
    icon: "terminal",
    kind: "command",
    label: "Ran a command",
  });
}

/**
 * Codex parses every command it runs into what the command does. When all of
 * a command's parts are reads, or all searches, the step is that — a `cat` is
 * a read however it was spelled.
 */
function codexCommandAction(args: unknown): ToolPresentation | null {
  if (!isRecord(args) || !Array.isArray(args.commandActions)) return null;
  const actions = args.commandActions.filter(isRecord);
  if (actions.length === 0 || actions.length !== args.commandActions.length) return null;
  const type = actions[0]?.type;
  if (!actions.every((action) => action.type === type)) return null;
  const shown = actions
    .map((action) => (typeof action.command === "string" ? action.command : ""))
    .filter(Boolean)
    .join(" && ");
  switch (type) {
    case "read": {
      const paths = actions
        .map((action) => (typeof action.path === "string" ? action.path : ""))
        .filter(Boolean);
      const names = actions
        .map((action) => (typeof action.name === "string" ? action.name : ""))
        .filter(Boolean);
      return step({
        activeLabel: names.length === 1 ? `Reading ${names[0]}` : "Reading files",
        hint: paths.join(", ") || shown,
        icon: "file",
        kind: "read",
        label: names.length === 1 ? `Read ${names[0]}` : `Read ${actions.length} files`,
        paths,
      });
    }
    case "search": {
      const query = actions.length === 1 ? stringField(actions[0], "query") : null;
      return step({
        activeLabel: query ? `Searching for ${query}` : "Searching the code",
        hint: shown,
        icon: "search",
        kind: "search",
        label: query ? `Searched for ${query}` : "Searched the code",
      });
    }
    case "listFiles":
      return step({
        activeLabel: "Listing files",
        hint: shown,
        icon: "folder",
        kind: "list",
        label: "Listed files",
      });
    default:
      return null;
  }
}

function webSearchPresentation(args: unknown): ToolPresentation {
  const action = isRecord(args) && isRecord(args.action) ? args.action : null;
  if (action?.type === "openPage" || action?.type === "findInPage") {
    return step({
      activeLabel: "Reading a page",
      hint: stringField(action, "url") ?? "",
      icon: "globe",
      kind: "web-page",
      label: "Read a page",
    });
  }
  return step({
    activeLabel: "Searching the web",
    hint:
      stringField(args, "query", "search_term", "searchTerm") ?? stringField(action, "query") ?? "",
    icon: "globe",
    kind: "web-search",
    label: "Searched the web",
  });
}

/**
 * The integration gateway, read by what each call addressed. A call's
 * arguments name its target only by an opaque reference, so the words come
 * from the subject the Host resolved when it recorded the call; a call with
 * none addressed nothing the Host could name, and says only what it was.
 */
function integrationPresentation(
  tool: ToolEntry,
  name: string,
  args: unknown,
): ToolPresentation | null {
  const subject = tool.integration;
  const place = computerPlace(tool);
  switch (name) {
    case "integration_call":
      if (subject && place) return computerPresentation(tool, subject, place);
      if (subject) {
        return gatewayStep({
          activeLabel: `Using ${subject.integration}`,
          hint: `${subject.integration} · ${subject.account}`,
          kind: "integration-call",
          label: subject.operation.title,
        });
      }
      return gatewayStep({
        activeLabel: "Calling an integration",
        hint: "",
        kind: "integration-call",
        label: "Called an integration",
      });
    case "integration_describe":
      return gatewayStep({
        activeLabel: subject
          ? `Looking up ${subject.operation.title}`
          : "Looking up an integration",
        hint: place?.kind === "phone" ? place.computer : (subject?.integration ?? ""),
        // Reading how to use an app is part of using it, so it stays in that app's row.
        kind: place ? "computer" : "integration-lookup",
        label: subject ? `Looked up ${subject.operation.title}` : "Looked up an integration",
      });
    case "integration_search": {
      const onMac = stringField(args, "runnerId") !== null;
      return gatewayStep({
        activeLabel: onMac ? "Listing apps on a Mac" : "Searching integrations",
        hint: searchedFor([stringField(args, "query")]),
        kind: "integration-lookup",
        label: onMac ? "Listed apps on a Mac" : "Searched integrations",
      });
    }
    case "integration_request": {
      const target =
        stringField(args, "kind") === "computer-app" ? "app access on a Mac" : "integration access";
      return gatewayStep({
        activeLabel: `Requesting ${target}`,
        hint: stringField(args, "reason") ?? "",
        kind: "integration-request",
        label: `Requested ${target}`,
      });
    }
    case "integration_propose": {
      const target = `${sourceKinds[stringField(args, "kind") ?? ""] ?? "an"} integration`;
      return gatewayStep({
        activeLabel: `Proposing ${target}`,
        hint: stringField(args, "reason") ?? "",
        kind: "integration-request",
        label: `Proposed ${target}`,
      });
    }
    default:
      return null;
  }
}

/**
 * `sign_in` reads by what it came to, from the result the Host
 * returned: a check only when it signed in, an alert when it did not, and the
 * browser while it is still on its way. Output it cannot read never reads as
 * signed in.
 */
function signInPresentation(tool: ToolEntry, args: unknown): ToolPresentation {
  const site = stringField(args, "site");
  const domain = site === null ? null : browserSiteLabel(site);
  const result = signInResult(tool);
  return step({
    activeLabel: domain === null ? "Signing in" : `Signing in to ${domain}`,
    hint: result?.hint ?? domain ?? "",
    hintKind: "prose",
    icon:
      result?.signedIn === true
        ? "check-circle"
        : result?.signedIn === false
          ? "alert-circle"
          : "browser",
    kind: "browser",
    label:
      result?.label ?? (domain === null ? "Tried to sign in" : `Tried to sign in to ${domain}`),
  });
}

function signInResult(tool: ToolEntry): BrowserSignInStep | null {
  if (
    tool.tool?.namespace !== "opensteer" ||
    (tool.tool.name !== "browser_sign_in" && tool.tool.name !== "sign_in") ||
    tool.state !== "done" ||
    !tool.output
  ) {
    return null;
  }
  const result = readBrowserSignInResult(tool.output.text);
  return result === null
    ? null
    : browserSignInStep(result, stringField(effectiveArguments(tool), "site"));
}

/** A gateway step's hint is always words about the step, never a reference. */
function gatewayStep(
  presentation: Pick<ToolPresentation, "activeLabel" | "hint" | "kind" | "label">,
): ToolPresentation {
  return step({ ...presentation, hintKind: "prose", icon: "puzzle" });
}

/**
 * What searches looked for, as the queries they were: quoted, so a query
 * reads as something asked rather than something found.
 */
function searchedFor(queries: readonly (string | null)[]): string {
  const quoted = [...new Set(queries.filter((query): query is string => query !== null))].map(
    (query) => `"${query}"`,
  );
  if (quoted.length === 0) return "";
  const last = quoted.pop();
  return `for ${quoted.length > 0 ? `${quoted.join(", ")} and ${last}` : last}`;
}

const sourceKinds: Partial<Record<string, string>> = {
  graphql: "a GraphQL",
  mcp: "an MCP",
  openapi: "an OpenAPI",
};

/**
 * A Computer use step says what happened in the app. A finished observe or
 * act result opens with the Host's own sentence for it, even when it stopped
 * short; a failure that never reached the app has no such sentence, so it
 * says which app it could not use and keeps the reason as its detail. An
 * act's headline names only its actions, because the row it sits in names
 * the app, so a step shown outside that row names the app beside it.
 */
function computerPresentation(
  tool: ToolEntry,
  subject: IntegrationCallSubject,
  place: ComputerPlace,
): ToolPresentation {
  const looks = subject.effect === "read";
  const target = place.kind === "app" ? place.app : place.computer;
  const headline = computerUseHeadline(tool);
  const failed = tool.state === "failed" && headline === null;
  return step({
    activeLabel: looks ? `Looking at ${target}` : actingLabel(tool, place),
    describes: headline !== null,
    hint: failed ? firstLine(toolOutputText(tool)).trim() : "",
    hintKind: "prose",
    icon: "laptop",
    kind: "computer",
    label:
      headline ??
      (failed
        ? looks
          ? `Couldn't look at ${target}`
          : `Couldn't use ${target}`
        : tool.state === "stopped"
          ? looks
            ? `Stopped looking at ${target}`
            : `Stopped using ${target}`
          : looks
            ? `Looked at ${target}`
            : `Used ${target}`),
  });
}

/**
 * What a running act is doing, from the first thing its batch does: a wait
 * only paces the actions around it, so a batch is named by its first action
 * that is not one.
 */
function actingLabel(tool: ToolEntry, place: ComputerPlace): string {
  const sent = effectiveArguments(tool);
  const operation = tool.tool?.name.startsWith("computer.")
    ? tool.tool.name.slice("computer.".length)
    : null;
  const inner = isRecord(sent) && isRecord(sent.arguments) ? sent.arguments : null;
  const actions = Array.isArray(inner?.actions) ? inner.actions.filter(isRecord) : [];
  const first = actions.find((action) => action.type !== "wait");
  const verb =
    actions.length > 0 && first === undefined
      ? "Waiting"
      : operation && operation !== "act"
        ? (place.kind === "phone" ? phoneActingVerbs : actingVerbs)[operation]
        : typeof first?.type === "string"
          ? (place.kind === "phone" ? phoneActingVerbs : actingVerbs)[first.type]
          : undefined;
  if (place.kind === "phone") return verb ?? "Using";
  return verb ? `${verb} in ${place.app}` : `Using ${place.app}`;
}

const actingVerbs: Partial<Record<string, string>> = {
  click: "Clicking",
  key: "Pressing keys",
  scroll: "Scrolling",
  setValue: "Setting a value",
  type: "Typing",
};

const phoneActingVerbs: Partial<Record<string, string>> = {
  tap: "Tapping",
  longPress: "Pressing",
  swipe: "Swiping",
  drag: "Dragging",
  type: "Typing",
  clear: "Clearing a field",
  navigate: "Navigating",
  launch: "Opening an app",
  scroll: "Scrolling",
  wake: "Waking the screen",
};

/**
 * Whether a Computer use step's own words name its place: an
 * act's headline names only its actions, and a lookup names the operation.
 */
function computerStepNamesPlace(tool: ToolEntry): boolean {
  if (!isComputerUseCall(tool)) return false;
  if (computerPlace(tool)?.kind === "phone" && tool.state === "running") {
    return tool.integration?.effect === "read";
  }
  return tool.integration?.effect === "read" || computerUseHeadline(tool) === null;
}

/** An observe or act, as opposed to reading how to do one. */
function isComputerUseCall(tool: ToolEntry): boolean {
  return (
    computerPlace(tool) !== null &&
    tool.tool?.name !== "computer" &&
    tool.tool?.name !== "integration_describe" &&
    tool.tool?.name !== "integration_search"
  );
}

/** The headline a Computer use result opens with, once the call has returned one. */
function computerUseHeadline(tool: ToolEntry): string | null {
  if (computerPlace(tool) === null || tool.state === "running" || !tool.output) return null;
  return tool.tool?.name.startsWith("computer.")
    ? readComputerStepHeadline(tool.output.text) || null
    : readComputerUseResultHeadline(tool.output.text);
}

/** Claude streams arguments as partial JSON; recover them once complete. */
export function effectiveArguments(tool: ToolEntry): unknown {
  const args = tool.arguments;
  const isEmptyObject =
    args !== null &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    Object.keys(args as Record<string, unknown>).length === 0;
  if (args !== undefined && args !== null && !isEmptyObject) return args;
  if (tool.state === "running" || !tool.streamText) return args;
  try {
    return JSON.parse(tool.streamText);
  } catch {
    return args;
  }
}

function commandFrom(args: unknown): string | null {
  if (!isRecord(args)) return null;
  const command = args.command ?? args.cmd;
  if (typeof command === "string" && command.trim()) return displayCommand(command);
  if (Array.isArray(command) && command.length > 0) {
    const parts = command.map(String);
    const [program, flag, script] = parts;
    if (
      parts.length === 3 &&
      program &&
      flag &&
      script &&
      isShell(program) &&
      /^-l?c$|^-cl$/u.test(flag)
    ) {
      return script.trim();
    }
    return parts.map(shellWord).join(" ");
  }
  return null;
}

/** One argv word as a shell would need it typed. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command a person would type. Engines wrap every command in a login
 * shell (`/bin/zsh -lc "…"`); that wrapper is how it ran, not what it was.
 */
export function displayCommand(command: string): string {
  const trimmed = command.trim();
  const wrapped = /^(\S+)\s+-(?:l?c|cl)\s+([\s\S]+)$/u.exec(trimmed);
  if (!wrapped?.[1] || !wrapped[2] || !isShell(wrapped[1])) return trimmed;
  const script = wrapped[2].trim();
  const quote = script[0];
  if ((quote !== "'" && quote !== '"') || script.length < 2 || !script.endsWith(quote)) {
    return script;
  }
  const body = script.slice(1, -1);
  // Only a script that is one quoted word unwraps; `sh -c 'a' 'b'` passes more
  // than a script, and stripping its outer quotes would print a different command.
  if (quote === "'") {
    return body.replaceAll(`'\\''`, "").includes("'")
      ? script
      : body.replaceAll(`'\\''`, "'").trim();
  }
  return /(^|[^\\])"/u.test(body) ? script : body.replace(/\\([\\"$`])/gu, "$1").trim();
}

function isShell(program: string): boolean {
  return /^(?:\S*\/)?(?:ba|z|da|fi)?sh$/u.test(program);
}

/** A one-line preview drops the `cd` that only says where the command ran. */
function withoutWorkingDirectory(command: string): string {
  return command.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/u, "");
}

function pathsFrom(args: unknown): string[] {
  if (!isRecord(args)) return [];
  for (const key of ["file_path", "path", "filePath", "notebook_path", "target_file"]) {
    const value = args[key];
    if (typeof value === "string" && value) return [value];
  }
  const changes = args.changes;
  if (isRecord(changes)) return Object.keys(changes);
  if (Array.isArray(changes)) {
    return changes
      .map((change) => (isRecord(change) && typeof change.path === "string" ? change.path : null))
      .filter((path): path is string => path !== null);
  }
  return [];
}

function baseName(path: string): string {
  return (
    path
      .replace(/[/\\]+$/u, "")
      .split(/[/\\]/u)
      .at(-1) || path
  );
}

/** Plan payloads differ per harness; surface whatever step is in flight. */
function planSummary(args: unknown): string {
  if (!isRecord(args)) return "";
  const steps = args.plan ?? args.todos ?? args.steps;
  if (!Array.isArray(steps)) return stringField(args, "explanation", "plan") ?? "";
  const active = steps.find(
    (candidate) =>
      isRecord(candidate) && (candidate.status === "in_progress" || candidate.status === "pending"),
  );
  const chosen = active ?? steps.at(-1);
  if (typeof chosen === "string") return chosen;
  if (isRecord(chosen)) return stringField(chosen, "step", "content", "title", "activeForm") ?? "";
  return "";
}

function stringField(args: unknown, ...keys: string[]): string | null {
  if (!isRecord(args)) return null;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function summarizeUnknown(args: unknown): string {
  if (typeof args === "string") return args;
  if (!isRecord(args)) return "";
  const first = Object.values(args).find((value) => typeof value === "string");
  return typeof first === "string" ? first : "";
}

function sentence(text: string): string {
  const line = firstLine(text).trim().replace(/\.$/u, "");
  return line ? line.charAt(0).toLocaleUpperCase() + line.slice(1) : line;
}

/** Which identity the session opened with — the one thing the arguments say. */
function browserSessionHint(args: unknown): string {
  if (stringField(args, "sessionId")) return "Existing session";
  if (stringField(args, "profileId")) return "Saved profile";
  return "Fresh session";
}

export function humanizeToolName(name: string): string {
  const label = name
    .replaceAll(/[._-]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return label ? label.charAt(0).toLocaleUpperCase() + label.slice(1) : "Used a tool";
}

export function firstLine(text: string): string {
  return text.trimStart().split("\n", 1)[0] ?? "";
}

/* ---- A step's detail ---- */

export interface ToolBody {
  argumentsText: string;
  /**
   * Whether the input and the output each sit behind their own disclosure,
   * closed until asked for: a Computer use result is a whole accessibility
   * tree, any other gateway result is written for the model, and the step's
   * label already says what it did.
   */
  collapsed: boolean;
  command: string | null;
  output: string;
  outputLabel: string;
  /**
   * What the step did, as prose above everything else, when the step's own
   * label does not already say it; empty for most steps.
   */
  summary: string;
}

/** Everything a step's detail shows, wording included. */
export function toolBody(tool: ToolEntry): ToolBody {
  const presentation = toolPresentation(tool);
  if (presentation.kind === "computer") return computerBody(tool);
  if (presentation.kind === "task" && tool.state !== "failed") {
    return {
      argumentsText: "",
      collapsed: false,
      command: null,
      output: stringField(effectiveArguments(tool), "task") ?? "",
      outputLabel: "Task",
      summary: "",
    };
  }
  return {
    argumentsText: presentation.command === null ? toolArgumentsText(tool) : "",
    // A gateway result is written for the model: catalogs, schemas and the
    // references it passes back, none of it the step's story.
    collapsed: tool.tool?.namespace === "opensteer.integrations",
    command: presentation.command,
    output: toolOutputText(tool),
    outputLabel: outputLabel(tool),
    summary: "",
  };
}

/**
 * A Computer use step is titled by its headline, so its detail need not say
 * it again. What the app looked like afterwards is the rest of the result —
 * the observation the Host returned, header, tree and notes — and it follows
 * under its own name. A failure that never reached the app has only its error
 * sentence, which the step's title cannot hold, so that is the summary.
 */
function computerBody(tool: ToolEntry): ToolBody {
  const text = toolOutputText(tool);
  const headline = computerUseHeadline(tool);
  const base = { argumentsText: toolArgumentsText(tool), collapsed: true, command: null };
  if (tool.tool?.name.startsWith("computer."))
    return {
      ...base,
      output: text.split("\n").slice(1).join("\n"),
      outputLabel: "Output",
      summary: "",
    };
  if (headline !== null) {
    return {
      ...base,
      output: text.slice(text.indexOf("\n") + 1),
      outputLabel: "Observation",
      summary: "",
    };
  }
  if (tool.state === "failed") {
    return { ...base, output: "", outputLabel: "Error", summary: text.trim() };
  }
  return { ...base, output: text, outputLabel: outputLabel(tool), summary: "" };
}

function outputLabel(tool: ToolEntry): string {
  switch (tool.state) {
    case "running":
      return "Output so far";
    case "stopped":
      return "Output before it stopped";
    case "failed":
      return "Error";
    case "done":
      return "Output";
  }
}

/** What a step's state means, in a few words for its detail. */
export function toolStatusLabel(tool: ToolEntry): string {
  switch (tool.state) {
    case "running":
      return "Running";
    case "done":
      return signInResult(tool)?.signedIn === false ? "Didn’t sign in" : "Done";
    case "failed":
      return toolTone(tool) === "stopped" ? "Stopped before finishing" : "Returned an error";
    case "stopped":
      return "Stopped before it finished";
  }
}

export function toolArgumentsText(tool: ToolEntry): string {
  const args = shownArguments(tool);
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return clipText(args);
  try {
    return clipText(JSON.stringify(args, null, 2));
  } catch {
    return "";
  }
}

/**
 * The arguments a reader can follow. A gateway call's reference is an opaque
 * token that means nothing to a person; what was sent to the operation is its
 * own `arguments`, and a describe sent nothing else.
 */
function shownArguments(tool: ToolEntry): unknown {
  const args = effectiveArguments(tool);
  if (
    tool.tool?.namespace === "opensteer" &&
    (tool.tool.name === "browser_sign_in" || tool.tool.name === "sign_in")
  ) {
    if (isRecord(args) && "code" in args) return { ...args, code: "[hidden]" };
    if (typeof args === "string")
      return args.replace(/("code"\s*:\s*)"(?:[^"\\]|\\.)*("|$)/gu, '$1"[hidden]"');
  }
  if (tool.tool?.namespace !== "opensteer.integrations" || !isRecord(args)) return args;
  const { toolRef: _reference, ...rest } = args;
  const sent = tool.tool.name === "integration_call" && "arguments" in rest ? rest.arguments : rest;
  return isRecord(sent) && Object.keys(sent).length === 0 ? undefined : sent;
}

/** Completed output is already provider-neutral at the harness boundary. */
export function toolOutputText(tool: ToolEntry): string {
  if (tool.state === "running") return clipText(tool.streamText);
  return tool.output?.text ?? clipText(tool.streamText);
}

function clipText(value: string): string {
  const max = 20_000;
  return value.length <= max ? value : `…${value.slice(value.length - max)}`;
}

/* ---- The workspace activity feed ---- */

interface ActivityFeedPresentation {
  detail: string;
  detailKind: "code" | "prose";
  icon: ActivityIcon;
  label: string;
  marker: ActivityTone | "failed";
}

export function activityFeedPresentation(entry: ActivityFeedEntry): ActivityFeedPresentation {
  if (entry.kind === "run") {
    return {
      detail: entry.error?.message ?? "",
      detailKind: "prose",
      icon: "alert-circle",
      label: "Run failed",
      marker: "failed",
    };
  }
  const head = activityStepHead(entry);
  // The feed has no row to name the app a Computer use step happened in, and a
  // gateway step's output and input are for the model, never a detail.
  const detail =
    entry.kind !== "tool"
      ? head.detail
      : computerPlace(entry)
        ? head.detail || computerStepPlace(entry)
        : entry.tool?.namespace === "opensteer.integrations"
          ? head.detail
          : head.detail || toolOutputText(entry) || toolArgumentsText(entry);
  return {
    detail,
    detailKind: head.detailKind,
    icon: head.icon,
    label: head.label,
    marker: head.tone,
  };
}
