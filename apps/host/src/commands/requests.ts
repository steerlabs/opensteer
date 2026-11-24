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
  admitCommand,
  commandSubject,
  type CommandRequestOrigin,
  type CommandRequestStore,
  type DatabaseSchema,
} from "@opensteer/database";
import { hostApi, type HostApiCommand, type HostApiCommandOutput } from "@opensteer/protocol";
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
  commandReviewFields,
  commandReviewText,
  outsideName,
  visibleText,
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
/** A name inside the Home's sentence is cut, so the sentence itself always fits whole. */
const maxNameLength = 80;
/** Where a script runs on this Home's own computer, by what this Home is (T4). */
const homeScriptPlaces: Readonly<Record<HostHomeKind, CommandScriptPlace>> = {
  mac: { where: "on your Mac", name: null, as: "you" },
  "cloud-computer": { where: "on this Cloud Computer", name: null, as: "its user" },
  server: { where: "on this server", name: null, as: "its user" },
};
/**
 * A name from outside the Home, as every approval sentence carries one: quoted, bounded, on one
 * line, with nothing in it that closes the quotes or turns the text around.
 */
const quotedName = (value: string | null | undefined) => {
  if (!value) return null;
  const name = outsideName(value, 4 * maxNameLength);
  return `“${name.length > maxNameLength ? `${name.slice(0, maxNameLength - 1)}…` : name}”`;
};
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
    const governs = (row.governs as (c: HostApiCommand) => CommandResource)(input.command);
    const stored = proposedCommand(row, input.command);
    const words = await this.#words(input.command, face, input.proposer, input.ownerUserId);
    const reason = input.reason?.trim().slice(0, 500) || null;
    const part: CommandRequestPart = {
      type: input.command.type,
      family: row.family,
      face: row.faces[face]!.class,
      summary: words.summary,
      sentence: words.sentence,
      gives: words.gives,
      command: RequestJsonObjectSchema.parse(JSON.parse(JSON.stringify(stored))),
      secretPaths: [...(row.secretFields ?? [])],
      governs: JSON.parse(JSON.stringify(governs)) as CommandRequestPart["governs"],
      askKey: digest([input.proposer.key, input.command.type, commandResourceKey(governs)]),
      argumentsDigest: digest(stored),
      proposer: { ...input.proposer },
      agentReason: reason,
      notes: words.notes,
      editor: commandEditor(input.command.type),
    };
    const connectionId = input.proposer.connectionId;
    const sessionId = "agentSessionId" in input.origin ? input.origin.agentSessionId : null;
    const opened = await this.#store.open({
      ownerUserId: input.ownerUserId,
      callId: `command:${input.proposer.key}:${input.callKey}`.slice(0, 512),
      origin: input.origin,
      originatingThreadId: input.originatingThreadId,
      part,
      presentation: commandPresentation(part, words.sentence, words.asker),
      // A connection's grant is read once more as the Request is written: narrowed since the door
      // admitted it, what it asked about reads like nothing there and no Request opens, so no name
      // of it is written for that connection to read (rule 5).
      ...(connectionId
        ? {
            stillAsks: (transaction: Kysely<DatabaseSchema>) =>
              this.#stillAsks(
                transaction,
                input.ownerUserId,
                connectionId,
                sessionId,
                input.command,
              ),
          }
        : {}),
    });
    if (opened.status !== "pending") return opened;
    return { status: "pending", requestId: opened.request.id, existing: opened.replayed };
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
   * The person approves the command exactly as proposed: anything else is refused, so what the
   * card showed is what runs. A command that carries a value only the person types is never
   * approved here; it is done on its own screen. Whoever proposed it must still be able to ask for
   * it, read in the approval's own transaction. It runs as the person through `run`, the door. The
   * answer is recorded before it runs and its outcome after; an outcome lost in between is
   * `unknown`, and nothing runs it again.
   */
  async approve(
    actor: PersonActor,
    input: {
      readonly requestId: RequestId;
      readonly expectedRevision: string;
      readonly command: Readonly<Record<string, unknown>>;
      /** The approving call's own key: the same approval again answers with its outcome. */
      readonly idempotencyKey: string;
    },
    run: (person: PersonActor, command: HostApiCommand) => Promise<HostApiCommandOutput>,
    person: (proposal: NonNullable<PersonActor["proposal"]>) => PersonActor,
  ): Promise<CommandRequestOutcome> {
    const pending = await this.#requests.get(input.requestId);
    if (!pending?.command || pending.requestedBy !== actor.userId)
      throw new OpensteerError({ code: "not_found", message: "Request not found" });
    // The same approval again: what the first one came to, and nothing runs twice.
    if (pending.status !== "pending" && pending.command.approvalKey === input.idempotencyKey)
      return pending.command.outcome ?? { status: "running" };
    const parsed = hostApi["commands.dispatch"].payload.safeParse({
      ...input.command,
      type: pending.command.type,
      idempotencyKey: `command-request:${input.requestId}`,
    });
    if (pending.command.secretPaths.length > 0)
      throw new OpensteerError({
        code: "conflict",
        reason: "command-needs-person-screen",
        message: "This needs something only you type. Do it on its own screen in Opensteer.",
      });
    if (!parsed.success) throw changesWhatWasAsked();
    const command = parsed.data;
    if (input.command.type !== undefined && input.command.type !== pending.command.type)
      throw changesWhatWasAsked();
    const row = commandRow(command.type) as CommandRow;
    const governs = (row.governs as (c: HostApiCommand) => CommandResource)(command);
    const connectionId = pending.command.proposer.connectionId;
    const approved = RequestJsonObjectSchema.parse(
      JSON.parse(JSON.stringify(proposedCommand(row, command))),
    );
    // Exactly what was proposed, or nothing.
    if (digest(approved) !== pending.command.argumentsDigest) throw changesWhatWasAsked();
    // The Home's words are true now, or the person looks again: the sentence, what it gives and
    // the notes as the revision the person reviewed carries them, computed again. If any differ,
    // the Request is written again under a new revision (the card refreshes) and nothing runs.
    const askedFace = Math.max(
      0,
      row.faces.findIndex((shape) => shape.class === pending.command!.face),
    );
    const words = await this.#words(
      command,
      askedFace,
      pending.command.proposer as CommandProposer,
      actor.userId,
    );
    if (
      words.sentence !== (pending.command.sentence ?? pending.command.summary) ||
      words.gives !== pending.command.gives ||
      canonicalJson(words.notes) !== canonicalJson(pending.command.notes ?? [])
    ) {
      const part: CommandRequestPart = {
        ...pending.command,
        summary: words.summary,
        sentence: words.sentence,
        gives: words.gives,
        notes: words.notes,
      };
      await this.#store.refreshWords({
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        resolvedBy: actor.userId,
        part,
        presentation: commandPresentation(part, words.sentence, words.asker),
      });
      throw new OpensteerError({
        code: "conflict",
        reason: "request-changed",
        message: "This changed since you read it. Look at it again before approving.",
      });
    }
    const begun = await this.#store.beginApproval({
      // Whoever asked must still be able to ask for this, as it stands now, in the approval's own
      // transaction: a Disconnect, a narrowing, a lowered task mode or a paused automation since
      // closes the ask, and nothing runs. A connection's as the door admitted it
      // (`connection:<id>`, or its direct session); your own agents' and an automation's as the
      // task they work in (`thread:<id>`).
      stillAsks: (transaction) =>
        connectionId
          ? this.#stillAsks(
              transaction,
              actor.userId,
              connectionId,
              pending.originatingAgentSessionId ?? null,
              command,
            )
          : this.#ownStillAsks(transaction, actor.userId, pending, command),
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      resolvedBy: actor.userId,
      settlementSessionId: actor.session.id,
      approvalKey: input.idempotencyKey,
      approved: { command: approved, changed: false },
      accept: (part) => {
        if (part.type !== command.type) throw changesWhatWasAsked();
        if (
          commandResourceKey(governs) !==
          commandResourceKey(part.governs as unknown as CommandResource)
        )
          throw changesWhatWasAsked();
      },
    });
    // The same approval twice at once: the second reads what the first came to; nothing runs twice.
    if (begun.replayed) return begun.replayed;
    if (begun.closed)
      throw new OpensteerError({
        code: "forbidden",
        reason: "proposer-gone",
        message: "The agent that asked can no longer ask for this, so its Request closed.",
      });
    const approver = person({
      requestId: input.requestId,
      revision: input.expectedRevision,
      proposedBy: { ...pending.command.proposer },
      // Where the store makes the change in a transaction it shares (a tab group's), the
      // proposer's admission is run once more there: a group that gained a tab it does not hold
      // since is refused, and nothing changes.
      ...(connectionId
        ? {
            readmit: async (transaction: Kysely<DatabaseSchema>) => {
              if (
                !(await this.#stillAsks(
                  transaction,
                  actor.userId,
                  connectionId,
                  pending.originatingAgentSessionId ?? null,
                  command,
                ))
              )
                throw raisedBeforeEffect(
                  new OpensteerError({
                    code: "forbidden",
                    reason: "proposer-gone",
                    message: "The agent that asked can no longer ask for this, so nothing changed.",
                  }),
                );
            },
          }
        : {}),
    });
    // The one way a command acts (G4): its attempt in the proposer's Disconnect set, the act,
    // then what is known of it. Its last admission is the approval's own (#stillAsks above).
    const effect = await runCommandEffect({
      row,
      attempts: commandAttempts(this.#database),
      attempt: {
        requestedBy: actor.userId,
        callerKey: `request:${input.requestId}`,
        connectionId: connectionId ?? null,
        type: command.type,
        idempotencyKey: (command as { readonly idempotencyKey: string }).idempotencyKey,
      },
      act: () => run(approver, command),
    });
    let outcome: CommandRequestOutcome;
    if (effect.status === "done") {
      // Exactly what the door gives that agent for this command when it runs it itself; what
      // ran is done even if its result cannot be kept.
      let result: unknown = null;
      try {
        result = JSON.parse(JSON.stringify(commandAgentOutput(command, effect.output) ?? null));
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
    await this.#store.settle(input.requestId, outcome);
    return outcome;
  }

  /**
   * The Home's own words for a proposal, as they are true now: its sentence (what it is done to,
   * named), the card's title, what it gives to whom, and the notes beside its values. Computed
   * when the agent asks, and again when the person approves.
   */
  async #words(command: HostApiCommand, face: number, proposer: CommandProposer, owner: UserId) {
    const row = commandRow(command.type) as CommandRow;
    const governs = (row.governs as (c: HostApiCommand) => CommandResource)(command);
    const names = await this.name(governs, owner);
    const sentence = commandSentence(command, () => names).slice(0, requestTitleMaxLength);
    const asker = askedBy(proposer);
    return {
      sentence,
      asker,
      summary: titleFirst(sentence, ` · ${asker}`),
      gives: commandGives(command, face, await this.#scriptPlace(command, owner)),
      notes: await this.#notes(command, proposedCommand(row, command), owner),
    };
  }

  /**
   * The person did themselves what pending asks asked for: a handler calls this after the
   * person's own command succeeded, and decides that it satisfied them. Each pending Request of
   * this owner for the same command type and the same thing, of a kind the card cannot approve
   * (it carries a value only the person types), is settled as done by the person, with the
   * value-free outcome the handler gives, under its lock and revision. Its agent reads that the
   * person did it themselves, and that its proposal did not run.
   */
  async personDid(input: {
    readonly ownerUserId: UserId;
    readonly command: HostApiCommand;
    readonly outcome: CommandRequestOutcome;
  }): Promise<readonly RequestId[]> {
    const row = commandRow(input.command.type) as CommandRow;
    const governs = commandResourceKey(
      (row.governs as (c: HostApiCommand) => CommandResource)(input.command),
    );
    const settled: RequestId[] = [];
    for (const request of await this.#store.pendingOfType(input.ownerUserId, input.command.type)) {
      const part = request.command!;
      if (part.secretPaths.length === 0) continue;
      if (commandResourceKey(part.governs as unknown as CommandResource) !== governs) continue;
      await this.#store.doneByPerson({
        requestId: request.id,
        resolvedBy: input.ownerUserId,
        outcome: input.outcome,
      });
      settled.push(request.id);
    }
    return settled;
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
  ): Promise<CommandReviewNote[]> {
    const notes = new Map<string, { name?: string; current?: string }>();
    for (const field of commandReviewFields(stored)) {
      const kind = idKinds[field.path.split(".").at(-1)!];
      if (!kind || field.value === null) continue;
      const name = await this.name({ kind, id: field.value }, owner);
      if (name) notes.set(field.path, { name });
    }
    if (command.type === "connection.update") {
      // As the person's own list of connections draws it: shown to the person, never admitted by.
      const now = (await new AgentConnectionStore(this.#database).list(owner)).find(
        ({ id }) => id === command.connectionId,
      );
      if (now)
        for (const key of ["label", "accessMode", "grant"] as const) {
          const proposed = command[key];
          if (proposed === undefined || canonicalJson(proposed) === canonicalJson(now[key]))
            continue;
          notes.set(key, { ...notes.get(key), current: commandReviewText(now[key]) });
        }
    }
    return [...notes].map(([path, note]) => ({ path, ...note }));
  }

  /**
   * Whether your own agent's or an automation's ask could still be asked, as it is now: as the
   * work of the task it came from, and, for an automation, while the automation is still on.
   */
  async #ownStillAsks(
    database: Kysely<DatabaseSchema>,
    owner: UserId,
    request: Request,
    command: HostApiCommand,
  ): Promise<boolean> {
    const occurrenceId = request.originatingOccurrenceId;
    const watchActivationId = request.originatingWatchActivationId;
    if (occurrenceId || watchActivationId) {
      const trigger = await (
        occurrenceId
          ? database
              .selectFrom("triggerOccurrences")
              .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
              .select("triggers.status")
              .where("triggerOccurrences.id", "=", occurrenceId)
          : database
              .selectFrom("triggerWatchActivations")
              .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
              .select("triggers.status")
              .where("triggerWatchActivations.id", "=", watchActivationId!)
      ).executeTakeFirst();
      if (trigger?.status !== "active") return false;
    }
    try {
      const admission = await admitCommand(database, {
        ownerUserId: owner,
        subject: { kind: "binding", bindingId: `thread:${request.originatingThreadId}` },
        command,
      });
      return admission.answer !== "not_found";
    } catch (error) {
      if (error instanceof OpensteerError && ["forbidden", "not_found"].includes(error.code))
        return false;
      throw error;
    }
  }

  /** Whether the proposing connection could still ask for this command, as it is now. */
  async #stillAsks(
    database: Kysely<DatabaseSchema>,
    owner: UserId,
    connectionId: string,
    sessionId: string | null,
    command: HostApiCommand,
  ): Promise<boolean> {
    try {
      // As the door admitted it: in its direct session when it asked from one (G2d).
      const admission = await admitCommand(database, {
        ownerUserId: owner,
        subject: sessionId
          ? { kind: "binding", bindingId: `session:${sessionId}` }
          : commandSubject(`connection:${connectionId}`),
        command,
      });
      return admission.answer !== "not_found";
    } catch (error) {
      if (error instanceof OpensteerError && ["forbidden", "not_found"].includes(error.code))
        return false;
      throw error;
    }
  }

  /**
   * Where an automation's script would run, and as whom (T4): on the anchor task's device. The
   * Home's own computer is what this Home is; another computer is its device, by its own name,
   * quoted as every outside name is. Null for every other command.
   */
  async #scriptPlace(command: HostApiCommand, owner: UserId): Promise<CommandScriptPlace | null> {
    if (!["trigger.create", "trigger.update", "trigger.run"].includes(command.type)) return null;
    const input = command as unknown as {
      readonly triggerId?: string;
      readonly input?: { readonly anchorThreadId?: string };
    };
    const anchor =
      command.type === "trigger.create"
        ? (input.input?.anchorThreadId ?? null)
        : ((
            await this.#database
              .selectFrom("triggers")
              .select("anchorThreadId")
              .where("id", "=", (input.triggerId ?? "") as never)
              .where("createdBy", "=", owner)
              .executeTakeFirst()
          )?.anchorThreadId ?? null);
    if (anchor === null) return null;
    const device = await this.#database
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
  async name(resource: CommandResource, owner: UserId): Promise<string | null> {
    const id = resource.id;
    const database = this.#database;
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
      `The agent's own reason (its words, not checked): ${visibleText(part.agentReason, "one")}`,
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

function changesWhatWasAsked(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    reason: "command-changed",
    message: "That changes what was asked. Change only how, not what.",
  });
}
