import { createHash } from "node:crypto";
import {
  commandRequestAnswers,
  OpensteerError,
  raisedBeforeEffect,
  RequestJsonObjectSchema,
  requestTitleMaxLength,
  type CommandRequestOutcome,
  type CommandRequestPart,
  type Request,
  type RequestId,
  type RequestPresentation,
  type RequestResponse,
  type HostHomeKind,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { commandAttempts, runCommandEffect } from "./command-effect.js";
import {
  AgentConnectionStore,
  proposalSubject,
  standingSubject,
  stillReaches,
  storedProposal,
  type CommandRequestOrigin,
  type CommandRequestStore,
  type DatabaseSchema,
} from "@opensteer/database";
import type { HostApiCommand, HostApiCommandOutput } from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import {
  commandAgentOutput,
  commandResourceKey,
  commandRow,
  type CommandResource,
  type CommandRow,
} from "@opensteer/protocol/command-table";
import {
  commandAskedFace,
  commandEditor,
  commandGives,
  commandSentence,
  type CommandScriptPlace,
} from "@opensteer/protocol/command-words";
import {
  commandPath,
  commandReviewFields,
  commandReviewText,
  outsideName,
  outsideProse,
  type CommandReviewNote,
} from "@opensteer/protocol/command-review";
import { sql, type Kysely } from "kysely";
import type { AgentCaller } from "../mcp/agent-caller.js";
import type { CommandAsk } from "./dispatch.js";
import type { PersonActor } from "./actor.js";

/**
 * The root of a proposer's lineage: the top task of a task tree for a Run, the automation for a
 * program, the connection for any of its sessions and Runs. The one open ask, the cap and the
 * remembered decline all count per root, so a child task, another run of the same automation or
 * another session of the same connection is the same proposer. Made only by
 * `proposerLineageKey`.
 */
export type ProposerLineageKey = string & { readonly __proposerLineage: unique symbol };

/** The lineage root of an agent the Home authenticated, from the Home's own rows. */
export async function proposerLineageKey(
  database: Kysely<DatabaseSchema>,
  caller: AgentCaller,
): Promise<ProposerLineageKey> {
  const connectionId =
    caller.kind === "connection" ? caller.connectionId : caller.agentConnection?.agentConnectionId;
  if (connectionId) return `connection:${connectionId}` as ProposerLineageKey;
  if (caller.kind === "program") {
    const triggerId =
      caller.program.kind === "watch"
        ? caller.program.triggerId
        : (
            await database
              .selectFrom("triggerOccurrences")
              .select("triggerId")
              .where("id", "=", caller.program.occurrenceId)
              .executeTakeFirstOrThrow()
          ).triggerId;
    return `automation:${triggerId}` as ProposerLineageKey;
  }
  if (caller.kind !== "run")
    throw new OpensteerError({ code: "internal", message: "Unknown proposer" });
  return `task:${await rootTask(database, caller.thread.id)}` as ProposerLineageKey;
}

/** The top task of a task tree, by the parent each task was made under. */
export async function rootTask(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
): Promise<ThreadId> {
  const { rows } = await sql<{ id: ThreadId }>`with recursive up as (
      select id, parent_thread_id, 0 as depth from threads where id = ${threadId}
      union all
      select parent.id, parent.parent_thread_id, up.depth + 1
      from threads parent join up on parent.id = up.parent_thread_id where up.depth < 64
    ) select id from up order by depth desc limit 1`.execute(database);
  return rows[0]?.id ?? threadId;
}

/** Who proposed a command, as the person knows them. Built by the tool that carried it. */
export interface CommandProposer {
  readonly kind: CommandRequestPart["proposer"]["kind"];
  /** The engine, the automation or the connected agent's label. */
  readonly name: string;
  readonly taskTitle: string | null;
  readonly key: ProposerLineageKey;
  /** The connection whose lineage it works in, if any, and its grant revision when it asked. */
  readonly connectionId?: string;
  readonly grantRevision?: number;
}

/** What an agent's proposal came to: a Request the person has, or what became of it. */
export type CommandProposed =
  | {
      readonly status: "pending";
      readonly requestId: RequestId;
      /** The same ask was already open (or this call already opened it). */
      readonly existing: boolean;
    }
  | { readonly status: "declined"; readonly requestId: RequestId }
  /** The person says they did it themselves; nothing claims it happened. */
  | { readonly status: "person-says-done"; readonly requestId: RequestId }
  /** The person's own command did what was asked: the Home's record. */
  | { readonly status: "done-by-person"; readonly requestId: RequestId }
  | { readonly status: "withdrawn"; readonly requestId: RequestId }
  /** Closed without an answer: the agent could no longer ask for it, or its task ended. */
  | { readonly status: "closed"; readonly requestId: RequestId }
  /** The person approved it: what it came to. */
  | {
      readonly status: "answered";
      readonly requestId: RequestId;
      readonly outcome: CommandRequestOutcome;
    };

/** The form field an app without the command part answers; whatever it sends declines. */
export const commandDecisionFieldId = commandRequestAnswers.field;
const maxResultBytes = 64 * 1_024;
/** Where a script runs on this Home's own computer, by what this Home is (T4). */
const homeScriptPlaces: Readonly<Record<HostHomeKind, CommandScriptPlace>> = {
  mac: { where: "on your Mac", name: null, as: "you" },
  "cloud-computer": { where: "on this Cloud Computer", name: null, as: "its user" },
  server: { where: "on this server", name: null, as: "its user" },
};
/**
 * A name from outside the Home, as every approval sentence carries one: quoted, bounded, on one
 * line, with nothing in it that closes the quotes or turns the text around. The shared cleaner,
 * at the shared limit, cuts only where a character starts, and nothing cuts it again.
 */
const quotedName = (value: string | null | undefined) => (value ? `“${outsideName(value)}”` : null);
/** What the proposer is told of a refusal: the Home's words, never the handler's. */
export const commandRefusedWords = "The Home refused it, so nothing changed.";

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** The command as an agent may store it: no key, no value only the person types. */
export function proposedCommand(row: CommandRow, command: HostApiCommand): Record<string, unknown> {
  const copy = structuredClone(command) as Record<string, unknown>;
  delete copy.idempotencyKey;
  for (const path of row.secretFields ?? []) {
    const keys = path.split(".");
    let at: unknown = copy;
    for (const key of keys.slice(0, -1))
      at = typeof at === "object" && at !== null ? (at as Record<string, unknown>)[key] : undefined;
    if (typeof at === "object" && at !== null) delete (at as Record<string, unknown>)[keys.at(-1)!];
  }
  return copy;
}

/**
 * The person's Requests for commands agents propose: what the person sees is the change itself,
 * in the Home's words, never the agent's; approving runs the command as the person, on the
 * person's session, through the door; a secret is typed on the person's screen and never stored.
 */
export class CommandRequestService {
  readonly #store: CommandRequestStore;
  readonly #database: Kysely<DatabaseSchema>;
  readonly #requests: { get(id: RequestId): Promise<Request | null> };
  readonly #homeKind: HostHomeKind | undefined;
  /**
   * Approvals in flight in this process, counted from before the approval begins until its
   * receipt is written or given up: a read leaves their receipt alone. A count, so a second
   * approval of the same Request ending first never clears the first's.
   */
  readonly #inFlight = new Map<RequestId, number>();
  #enter(requestId: RequestId) {
    this.#inFlight.set(requestId, (this.#inFlight.get(requestId) ?? 0) + 1);
  }
  #leave(requestId: RequestId) {
    const left = (this.#inFlight.get(requestId) ?? 1) - 1;
    if (left > 0) this.#inFlight.set(requestId, left);
    else this.#inFlight.delete(requestId);
  }
  constructor(options: {
    readonly store: CommandRequestStore;
    readonly database: Kysely<DatabaseSchema>;
    readonly requests: { get(id: RequestId): Promise<Request | null> };
    /** What this Home's own computer is (its configuration): where its own work runs. */
    readonly homeKind?: HostHomeKind | undefined;
  }) {
    this.#store = options.store;
    this.#database = options.database;
    this.#requests = options.requests;
    this.#homeKind = options.homeKind;
  }

  /** Opens the person's Request for a command the door put to the person. */
  async propose(input: {
    readonly ownerUserId: UserId;
    readonly command: HostApiCommand;
    readonly ask: CommandAsk;
    readonly face: number | undefined;
    readonly proposer: CommandProposer;
    readonly origin: CommandRequestOrigin;
    readonly originatingThreadId: ThreadId;
    /** The agent's own key for this call: the same call is the same Request. */
    readonly callKey: string;
    readonly reason?: string | undefined;
  }): Promise<CommandProposed> {
    const row = commandRow(input.command.type) as CommandRow;
    const face = commandAskedFace(input.command.type, input.face);
    // A close of a group's members names the members the person will be shown, and closes only
    // those: one that joins later is untouched (D4).
    const command = await this.#withShownMembers(input.command, input.ownerUserId);
    const governs = (row.governs as (c: HostApiCommand) => CommandResource)(command);
    const stored = proposedCommand(row, command);
    const callId = `command:${input.proposer.key}:${input.callKey}`.slice(0, 512);
    const askKey = digest([input.proposer.key, command.type, commandResourceKey(governs)]);
    const argumentsDigest = digest(stored);
    // The same call, the same ask, a remembered no and the proposer's waiting asks answer it
    // before the Home looks anything up for it.
    const early = await this.#store.answerBeforeAsking({
      ownerUserId: input.ownerUserId,
      callId,
      part: { askKey, argumentsDigest, proposer: input.proposer },
    });
    if (early?.status === "answered" && early.outcome.status === "running") {
      await this.reconcile(early.requestId);
      const settled = await this.#store.answerBeforeAsking({
        ownerUserId: input.ownerUserId,
        callId,
        part: { askKey, argumentsDigest, proposer: input.proposer },
      });
      if (settled && settled.status !== "pending") return settled;
    }
    if (early) {
      if (early.status !== "pending") return early;
      return { status: "pending", requestId: early.request.id, existing: early.replayed };
    }
    const words = await this.#words(command, face, input.proposer, input.ownerUserId);
    const reason = input.reason?.trim().slice(0, 500) || null;
    const part: CommandRequestPart = {
      type: command.type,
      family: row.family,
      face: row.faces[face]!.class,
      summary: words.summary,
      sentence: words.sentence,
      gives: words.gives,
      command: RequestJsonObjectSchema.parse(JSON.parse(JSON.stringify(stored))),
      secretPaths: [...(row.secretFields ?? [])],
      governs: JSON.parse(JSON.stringify(governs)) as CommandRequestPart["governs"],
      askKey,
      argumentsDigest,
      proposer: { ...input.proposer },
      agentReason: reason,
      notes: words.notes,
      editor: commandEditor(command.type),
    };
    const subject = proposalSubject({
      originatingAgentSessionId:
        "agentSessionId" in input.origin ? input.origin.agentSessionId : null,
      originatingRunId: "runId" in input.origin ? input.origin.runId : null,
      originatingOccurrenceId: "occurrenceId" in input.origin ? input.origin.occurrenceId : null,
      originatingWatchActivationId:
        "watchActivationId" in input.origin ? input.origin.watchActivationId : null,
      connectionId: input.proposer.connectionId,
    });
    const opened = await this.#store.open({
      ownerUserId: input.ownerUserId,
      callId,
      origin: input.origin,
      originatingThreadId: input.originatingThreadId,
      part,
      presentation: commandPresentation(part, words.sentence, words.asker),
      // A connection's grant is read once more as the Request is written: narrowed since the door
      // admitted it, what it asked about reads like nothing there and no Request opens, so no name
      // of it is written for that connection to read (rule 5).
      ...(input.proposer.connectionId && subject
        ? {
            stillAsks: (transaction: Kysely<DatabaseSchema>) =>
              stillReaches(transaction, input.ownerUserId, subject, command),
          }
        : {}),
    });
    if (opened.status !== "pending") return opened;
    return { status: "pending", requestId: opened.request.id, existing: opened.replayed };
  }

  /**
   * A group close names the members it closes: the ones the group has as the agent asks, unless
   * the agent named them itself. The card lists them; the close acts on those alone.
   */
  async #withShownMembers(command: HostApiCommand, owner: UserId): Promise<HostApiCommand> {
    if (command.type !== "tab.group.close" || command.tabIds) return command;
    const row = await this.#database
      .selectFrom("tabLayouts")
      .select("items")
      .where("ownerId", "=", owner)
      .executeTakeFirst();
    const items = (row?.items ?? []) as readonly {
      readonly kind?: string;
      readonly group?: { readonly groupId?: string; readonly tabIds?: readonly string[] };
    }[];
    const group = items.find(
      (item) => item.kind === "group" && item.group?.groupId === command.groupId,
    );
    return group?.group?.tabIds
      ? ({ ...command, tabIds: [...group.group.tabIds] } as HostApiCommand)
      : command;
  }

  /** An agent withdraws its own ask; another's is not there for it. */
  withdraw(input: {
    readonly ownerUserId: UserId;
    readonly requestId: RequestId;
    readonly proposerKey: ProposerLineageKey;
  }): Promise<CommandProposed> {
    return this.#store.withdraw(input);
  }

  /**
   * The person declines. Whatever an app sends through `request.respond` on a command Request,
   * a choice, a form, free text, is a decline: approving is never a form answer.
   */
  async decline(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }) {
    // A command Request has fixed answers and no words: whatever is sent is the plain decline,
    // or, where the card offers it, that the person did it themselves. Nothing typed is kept, and
    // nothing typed reaches the agent (an agent's reason may ask for a secret in the box).
    const pending = await this.#requests.get(input.requestId);
    const doneMyself =
      (pending?.command?.secretPaths.length ?? 0) > 0 &&
      input.response.kind === "form" &&
      input.response.answers[commandRequestAnswers.field]?.[0] === commandRequestAnswers.doneMyself;
    return this.#store.decline({
      ...input,
      response: {
        kind: "form",
        answers: {
          [commandRequestAnswers.field]: [
            doneMyself ? commandRequestAnswers.doneMyself : commandRequestAnswers.decline,
          ],
        },
      },
    });
  }

  /**
   * The person approves the proposal: the Home runs the command it stored, exactly, for the
   * revision the person reviewed. The approval carries no command of its own, so what the card
   * showed is what runs. A command that carries a value only the person types is never approved
   * here; it is done on its own screen. In the approval's own transaction, under the Request's
   * lock, its proposer must still be able to ask for it as it asked, and the Home's words must
   * still read as the person reviewed them; the proposer is admitted once more where the
   * effect's attempt is recorded. It runs as the person through `run`, the door. The answer is
   * recorded before it runs and its outcome after; an outcome lost in between is read back from
   * the attempt, and nothing runs it again.
   */
  async approve(
    actor: PersonActor,
    input: {
      readonly requestId: RequestId;
      readonly expectedRevision: string;
      /** The approving call's own key: the same approval again answers with its outcome. */
      readonly idempotencyKey: string;
    },
    run: (person: PersonActor, command: HostApiCommand) => Promise<HostApiCommandOutput>,
    person: (proposal: NonNullable<PersonActor["proposal"]>) => PersonActor,
  ): Promise<CommandRequestOutcome> {
    let pending = await this.#requests.get(input.requestId);
    if (!pending?.command || pending.requestedBy !== actor.userId)
      throw new OpensteerError({ code: "not_found", message: "Request not found" });
    // A value only the person types is never approved here, whatever is sent.
    if (pending.command.secretPaths.length > 0)
      throw new OpensteerError({
        code: "conflict",
        reason: "command-needs-person-screen",
        message: "This needs something only you type. Do it on its own screen in Opensteer.",
      });
    // The same approval again: what the first one came to, read back from its attempt if its
    // receipt was lost, and nothing runs twice.
    if (pending.status !== "pending" && pending.command.approvalKey === input.idempotencyKey) {
      if (pending.command.outcome?.status === "running" && !this.#inFlight.has(input.requestId))
        pending = (await this.#store.reconcileRunning(input.requestId)) ?? pending;
      return pending.command!.outcome ?? { status: "running" };
    }
    const command = storedProposal(pending.command);
    if (!command)
      throw new OpensteerError({
        code: "conflict",
        reason: "command-changed",
        message:
          "This proposal no longer reads as a command this Home runs, so it cannot be approved.",
      });
    const row = commandRow(command.type) as CommandRow;
    const stored = pending as Request & { readonly command: CommandRequestPart };
    const askedFace = Math.max(
      0,
      row.faces.findIndex((shape) => shape.class === stored.command!.face),
    );
    const stillAsks = (transaction: Kysely<DatabaseSchema>) =>
      this.#proposerStillAsks(transaction, actor.userId, stored, command);
    this.#enter(input.requestId);
    try {
      const begun = await this.#store.beginApproval({
        // Whoever asked must still be able to ask for this, as it asked, in the approval's own
        // transaction: a Disconnect, a narrowing or a paused automation since closes the ask, and
        // nothing runs.
        stillAsks,
        // The Home's words as they are true now, read under the same lock: if they no longer read
        // as the person reviewed them, the card is written anew and nothing is approved.
        checkWords: async (transaction, part) => {
          const words = await this.#words(
            command,
            askedFace,
            part.proposer as CommandProposer,
            actor.userId,
            transaction,
          );
          if (
            words.sentence === (part.sentence ?? part.summary) &&
            words.gives === part.gives &&
            canonicalJson(words.notes) === canonicalJson(part.notes ?? [])
          )
            return null;
          const rewritten: CommandRequestPart = {
            ...part,
            summary: words.summary,
            sentence: words.sentence,
            gives: words.gives,
            notes: words.notes,
          };
          return {
            part: rewritten,
            presentation: commandPresentation(rewritten, words.sentence, words.asker),
          };
        },
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        resolvedBy: actor.userId,
        settlementSessionId: actor.session.id,
        approvalKey: input.idempotencyKey,
        approved: { command: RequestJsonObjectSchema.parse(stored.command.command) },
        accept: () => undefined,
      });
      // The same approval twice at once: the second reads what the first came to; nothing runs twice.
      if (begun.replayed) return begun.replayed;
      if (begun.changed)
        throw new OpensteerError({
          code: "conflict",
          reason: "request-changed",
          message: "This changed since you read it. Look at it again before approving.",
        });
      if (begun.closed) throw proposerGone();
      const connectionId = stored.command.proposer.connectionId;
      // The proposer once more, where the store makes the change in a transaction it shares (a
      // tab group's): a group that gained a tab it does not hold since is refused, nothing changes.
      const readmit = async (transaction: Kysely<DatabaseSchema>) => {
        if (!(await stillAsks(transaction))) throw raisedBeforeEffect(proposerGone());
      };
      const approver = person({
        requestId: input.requestId,
        revision: input.expectedRevision,
        proposedBy: { ...stored.command.proposer },
        readmit,
      });
      let outcome: CommandRequestOutcome;
      {
        // The one way a command acts (G4): its attempt in the proposer's Disconnect set, recorded
        // in one transaction with the proposer's last admission (`readmit`), the act, then what is
        // known of it.
        const effect = await runCommandEffect({
          row,
          attempts: commandAttempts(this.#database),
          attempt: {
            requestedBy: actor.userId,
            callerKey: `request:${input.requestId}`,
            connectionId: connectionId ?? null,
            type: command.type,
            idempotencyKey: `command-request:${input.requestId}`,
          },
          readmit,
          act: () =>
            run(approver, {
              ...command,
              idempotencyKey: `command-request:${input.requestId}`,
            } as HostApiCommand),
        }).catch((error: unknown) => {
          // Refused at the last admission: nothing was recorded or run.
          if (error instanceof OpensteerError && error.reason === "proposer-gone")
            return { status: "refused" as const, error };
          throw error;
        });
        if (effect.status === "refused") {
          await this.#store.closeRefusedApproval(input.requestId);
          throw proposerGone();
        }
        if (effect.status === "done") {
          // What a proposer reads of a person's command: everything for your own agents' Runs;
          // under a connection's grant only that it ran (rule 5).
          let result: unknown = null;
          try {
            result = JSON.parse(
              JSON.stringify(
                commandAgentOutput(command, effect.output, connectionId !== undefined) ?? null,
              ),
            );
          } catch {
            result = undefined;
          }
          outcome =
            result !== undefined && JSON.stringify(result).length <= maxResultBytes
              ? { status: "done", result: result as never }
              : { status: "done" };
        } else if (effect.status === "failed") {
          // The proposer reads the Home's words only.
          outcome = {
            status: "failed",
            code: effect.error instanceof OpensteerError ? effect.error.code : "internal",
            message: commandRefusedWords,
          };
        } else outcome = { status: "unknown" };
      }
      // The receipt: written again if writing it fails once; if it still fails, the next read of
      // the Request takes it from the attempt. The effect itself never runs again.
      try {
        await this.#store.settle(input.requestId, outcome);
      } catch {
        await this.#store.settle(input.requestId, outcome);
      }
      return outcome;
    } finally {
      this.#leave(input.requestId);
    }
  }

  /**
   * An approval left running with no approval of it in flight in this process (its receipt was
   * lost): its outcome is read from the attempt it recorded, done or unknown, and only the record
   * is written. The proposer's reads (the same call again, its requests, its activity) and the
   * person's call this first; startup does it for every one.
   */
  async reconcile(requestId: RequestId): Promise<void> {
    if (!this.#inFlight.has(requestId)) await this.#store.reconcileRunning(requestId);
  }

  /** `reconcile` for each Request shown that reads as running; nothing for any other. */
  async reconcileShown(
    requests: readonly { readonly id: string; readonly command?: unknown }[],
  ): Promise<void> {
    for (const request of requests) {
      const outcome = (request.command as { readonly outcome?: { readonly status?: unknown } })
        ?.outcome;
      if (outcome?.status === "running") await this.reconcile(request.id as RequestId);
    }
  }

  /**
   * The person's own command succeeded (the door calls this, after the handler, for a type
   * whose row declares values only the person types): every pending proposal of that owner with
   * the same type and arguments digest (which leaves out the key and those values) is settled as
   * done by the person. Any proposer; no other matching.
   */
  async settleDoneByPerson(owner: UserId, command: HostApiCommand): Promise<void> {
    const row = commandRow(command.type) as CommandRow;
    if (!row.secretFields?.length) return;
    await this.#store.settleDoneByPerson({
      ownerUserId: owner,
      type: command.type,
      argumentsDigest: digest(proposedCommand(row, command)),
    });
  }

  /**
   * The Home's own words for a proposal, as they are true now: its sentence (what it is done to,
   * named), the card's title, what it gives to whom, and the notes beside its values. Computed
   * when the agent asks, and again inside the approval's transaction.
   */
  async #words(
    command: HostApiCommand,
    face: number,
    proposer: CommandProposer,
    owner: UserId,
    database: Kysely<DatabaseSchema> = this.#database,
  ) {
    const row = commandRow(command.type) as CommandRow;
    const governs = (row.governs as (c: HostApiCommand) => CommandResource)(command);
    const names = await this.name(governs, owner, database);
    const sentence = commandSentence(command, () => names).slice(0, requestTitleMaxLength);
    const asker = askedBy(proposer);
    return {
      sentence,
      asker,
      summary: titleFirst(sentence, ` · ${asker}`),
      gives: commandGives(command, face, await this.#scriptPlace(command, owner, database)),
      notes: await this.#notes(command, proposedCommand(row, command), owner, database),
    };
  }

  /**
   * Whether the proposer of a Request could still ask for this command, as it asked: in its
   * direct session, its Run, its automation's run (never the bare connection), and an automation
   * only while it is on, a connected one too.
   */
  async #proposerStillAsks(
    database: Kysely<DatabaseSchema>,
    owner: UserId,
    request: Request,
    command: HostApiCommand,
  ): Promise<boolean> {
    if (request.originatingOccurrenceId || request.originatingWatchActivationId) {
      const trigger = await (
        request.originatingOccurrenceId
          ? database
              .selectFrom("triggerOccurrences")
              .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
              .select("triggers.status")
              .where("triggerOccurrences.id", "=", request.originatingOccurrenceId)
          : database
              .selectFrom("triggerWatchActivations")
              .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
              .select("triggers.status")
              .where("triggerWatchActivations.id", "=", request.originatingWatchActivationId!)
      ).executeTakeFirst();
      if (trigger?.status !== "active") return false;
    }
    // As the task it came from, not the Run or firing that sent it: one that ended on its own
    // leaves its ask standing (D5).
    const subject = standingSubject({
      ...request,
      connectionId: request.command?.proposer.connectionId,
    });
    return subject ? stillReaches(database, owner, subject, command) : false;
  }

  /**
   * What the Home knows beside the proposed values, in its own words: what each id it can name
   * names, and, for a connected agent's settings, what each changed value is now. A value itself
   * is never copied: the card reads every value from the proposed command.
   */
  async #notes(
    command: HostApiCommand,
    stored: Readonly<Record<string, unknown>>,
    owner: UserId,
    database: Kysely<DatabaseSchema> = this.#database,
  ): Promise<CommandReviewNote[]> {
    // Within what the part holds (its bounds, checked before anything is looked up): a path the
    // part could not carry, or a note past its count, is left out, never failing the proposal.
    const notes = new Map<string, { name?: string; current?: string }>();
    const room = (path: string) => path.length <= notePathLimit && notes.size < noteLimit;
    for (const field of commandReviewFields(stored)) {
      const key = field.path.split("/").at(-1)!;
      const kind = Object.hasOwn(idKinds, key) ? idKinds[key] : undefined;
      if (!kind || field.value === null || !room(field.path)) continue;
      const id = JSON.parse(field.value) as unknown;
      if (typeof id !== "string") continue;
      const name = await this.name({ kind, id }, owner, database);
      if (name) notes.set(field.path, { name });
    }
    if (command.type === "connection.update") {
      // As the person's own list of connections draws it: shown to the person, never admitted by.
      const now = (await new AgentConnectionStore(database).list(owner)).find(
        ({ id }) => id === command.connectionId,
      );
      if (now)
        for (const key of ["label", "accessMode", "grant"] as const) {
          const proposed = command[key];
          if (proposed === undefined || canonicalJson(proposed) === canonicalJson(now[key]))
            continue;
          const path = commandPath([key]);
          const current = commandReviewText(now[key]);
          if (current.length > noteCurrentLimit || (!notes.has(path) && !room(path))) continue;
          notes.set(path, { ...notes.get(path), current });
        }
    }
    return [...notes].map(([path, note]) => ({ path, ...note }));
  }

  /**
   * Where an automation's script would run, and as whom (T4): on the anchor task's device. The
   * Home's own computer is what this Home is; another computer is its device, by its own name,
   * quoted as every outside name is. Null for every other command.
   */
  async #scriptPlace(
    command: HostApiCommand,
    owner: UserId,
    database: Kysely<DatabaseSchema> = this.#database,
  ): Promise<CommandScriptPlace | null> {
    if (!["trigger.create", "trigger.update", "trigger.run"].includes(command.type)) return null;
    const input = command as unknown as {
      readonly triggerId?: string;
      readonly input?: { readonly anchorThreadId?: string };
    };
    const anchor =
      command.type === "trigger.create"
        ? (input.input?.anchorThreadId ?? null)
        : ((
            await database
              .selectFrom("triggers")
              .select("anchorThreadId")
              .where("id", "=", (input.triggerId ?? "") as never)
              .where("createdBy", "=", owner)
              .executeTakeFirst()
          )?.anchorThreadId ?? null);
    if (anchor === null) return null;
    const device = await database
      .selectFrom("threads")
      .innerJoin("executionEnvironments", "executionEnvironments.id", "threads.environmentId")
      .leftJoin("runners", "runners.id", "executionEnvironments.runnerId")
      .leftJoin("deviceDrivers", (join) =>
        join
          .onRef("deviceDrivers.runnerId", "=", "runners.id")
          .on("deviceDrivers.role", "=", "self")
          .on("deviceDrivers.detachedAt", "is", null),
      )
      .leftJoin("devices", "devices.id", "deviceDrivers.deviceId")
      .select(["runners.kind as runnerKind", "devices.platform", "devices.name"])
      .where("threads.id", "=", anchor as ThreadId)
      .where("threads.createdBy", "=", owner)
      .executeTakeFirst();
    if (!device) return null;
    if (device.runnerKind === "main" || device.runnerKind === null)
      return this.#homeKind
        ? homeScriptPlaces[this.#homeKind]
        : { where: "on this Home's computer", name: null, as: "its user" };
    return device.platform === "macos"
      ? { where: "on your Mac", name: quotedName(device.name), as: "you" }
      : { where: "on the computer", name: quotedName(device.name), as: "its user" };
  }

  /** The governed thing as the person's apps name it, where the Home can tell cheaply. */
  async name(
    resource: CommandResource,
    owner: UserId,
    database: Kysely<DatabaseSchema> = this.#database,
  ): Promise<string | null> {
    const id = resource.id;
    const quoted = quotedName;
    if (id === null) return null;
    switch (resource.kind) {
      case "task":
        return quoted(
          (
            await database
              .selectFrom("threads")
              .select("title")
              .where("id", "=", id as ThreadId)
              .where("createdBy", "=", owner)
              .executeTakeFirst()
          )?.title,
        );
      case "connection":
        return quoted(
          (
            await database
              .selectFrom("agentConnections")
              .select("label")
              .where("id", "=", id)
              .where("userId", "=", owner)
              .executeTakeFirst()
          )?.label,
        );
      case "device":
        return quoted(
          (
            await database
              .selectFrom("devices")
              .select("name")
              .where("id", "=", id as never)
              .executeTakeFirst()
          )?.name,
        );
      case "browser-profile":
        return quoted(
          (
            await database
              .selectFrom("browserProfiles")
              .select("name")
              .where("id", "=", id as never)
              .where("ownerId", "=", owner)
              .executeTakeFirst()
          )?.name,
        );
      case "automation":
        return quoted(
          (
            await database
              .selectFrom("triggers")
              .select("name")
              .where("id", "=", id as never)
              .where("createdBy", "=", owner)
              .executeTakeFirst()
          )?.name,
        );
      case "engine":
        // An engine account belongs to its Home's work location; the rule admitted the caller on it.
        return quoted(
          (
            await database
              .selectFrom("harnessInstances")
              .select("name")
              .where("id", "=", id as never)
              .executeTakeFirst()
          )?.name,
        );
      case "chat-account":
        return quoted(
          (
            await database
              .selectFrom("channelAccounts")
              .innerJoin(
                "integrationConnections",
                "integrationConnections.id",
                "channelAccounts.connectionId",
              )
              .select("channelAccounts.displayName")
              .where("channelAccounts.connectionId", "=", id as never)
              .where("integrationConnections.ownerUserId", "=", owner)
              .executeTakeFirst()
          )?.displayName,
        );
      default:
        return null;
    }
  }
}

/** What a part's notes may hold (`CommandRequestPartSchema`'s bounds). */
const noteLimit = 200;
const notePathLimit = 400;
const noteCurrentLimit = 16_000;

/** The ids inside a command the Home names, by the field that holds one. */
const idKinds: Readonly<Record<string, CommandResource["kind"]>> = {
  agentConnectionId: "connection",
  automationId: "automation",
  connectionId: "connection",
  deviceId: "device",
  harnessInstanceId: "engine",
  machineId: "device",
  profileId: "browser-profile",
  taskId: "task",
  threadId: "task",
  triggerId: "automation",
};

/** Who asked, marked as the agent's own: its name and its task's title are its words. */
function askedBy(proposer: CommandProposer): string {
  const who = proposer.kind === "connection" ? "the connected agent" : "the agent";
  return proposer.taskTitle
    ? `Asked by ${who} ${quotedName(proposer.name)}, in its task ${quotedName(proposer.taskTitle)}`
    : `Asked by ${who} ${quotedName(proposer.name)}`;
}

/** The Home's sentence first and whole; whatever follows is cut to fit the title. */
export function titleFirst(sentence: string, rest: string): string {
  const room = requestTitleMaxLength - sentence.length;
  if (room <= 1) return sentence.slice(0, requestTitleMaxLength);
  return rest.length <= room ? `${sentence}${rest}` : `${sentence}${rest.slice(0, room - 1)}…`;
}

/** What an app shows that does not read the command part: true, and enough by itself. */
export function commandPresentation(
  part: CommandRequestPart,
  sentence: string,
  asker: string,
): RequestPresentation {
  const lines = [
    `What changes: ${sentence}`,
    `${asker}.`,
    `As proposed: ${JSON.stringify(part.command)}`.slice(0, 4_000),
  ];
  if (part.gives) lines.push(part.gives);
  if (part.agentReason)
    lines.push(
      `The agent's own reason (its words, not checked): ${outsideProse(part.agentReason).replace(/\n/gu, " ")}`,
    );
  return {
    kind: "form",
    title: part.summary,
    detail: lines.join("\n\n"),
    detailFormat: "plain",
    fields: [
      {
        id: commandDecisionFieldId,
        ...(part.secretPaths.length > 0
          ? {
              prompt:
                "It needs something only you type, so it is not approved here. Do it yourself on its own screen, then say so here, or decline.",
              choices: [
                { label: "I did it myself", value: commandRequestAnswers.doneMyself },
                { label: "Decline", value: commandRequestAnswers.decline },
              ],
            }
          : {
              prompt: "Approve runs it as you, exactly as shown. Decline tells the agent no.",
              choices: [{ label: "Decline", value: commandRequestAnswers.decline }],
            }),
        // Fixed answers only: nothing typed here could reach the agent.
        custom: false,
        multiSelect: false,
        secret: false,
      },
    ],
  };
}

function proposerGone(): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    reason: "proposer-gone",
    message: "The agent that asked can no longer ask for this, so its Request closed.",
  });
}
