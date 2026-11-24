import { createHash } from "node:crypto";
import {
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
  type CommandAutomationContext,
  type CommandScriptPlace,
} from "@opensteer/protocol/command-words";
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
export const commandDecisionFieldId = "decision";
const maxResultBytes = 64 * 1_024;
/** A name inside the Home's sentence is cut, so the sentence itself always fits whole. */
const maxNameLength = 80;
/** Where a script runs on this Home's own computer, by what this Home is (T4). */
const homeScriptPlaces: Readonly<Record<HostHomeKind, CommandScriptPlace>> = {
  mac: { where: "on your Mac", name: null, as: "you" },
  "cloud-computer": { where: "on this Cloud Computer", name: null, as: "its user" },
  server: { where: "on this server", name: null, as: "its user" },
};
/** A name from outside the Home, as every approval sentence carries one: quoted and bounded. */
const quotedName = (value: string | null | undefined) =>
  value
    ? `“${value.length > maxNameLength ? `${value.slice(0, maxNameLength - 1)}…` : value}”`
    : null;
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
    readonly proposerCallerKey?: string | undefined;
    readonly origin: CommandRequestOrigin;
    readonly originatingThreadId: ThreadId;
    /** The agent's own key for this call: the same call is the same Request. */
    readonly callKey: string;
    readonly reason?: string | undefined;
  }): Promise<CommandProposed> {
    const row = commandRow(input.command.type) as CommandRow;
    if (input.command.type === "trigger.secrets.set") {
      const hasNames = Array.isArray(input.command.names) && input.command.names.length > 0;
      const hasRemove = Array.isArray(input.command.remove) && input.command.remove.length > 0;
      if (!hasNames && !hasRemove) {
        throw new OpensteerError({
          code: "bad_request",
          message:
            "Provide `names` for the secrets you want the person to enter, or `remove` to remove existing secrets.",
        });
      }
    }
    const face = commandAskedFace(input.command.type, input.face);
    const governs = (row.governs as (c: HostApiCommand) => CommandResource)(input.command);
    const stored = proposedCommand(row, input.command);
    const names = await this.name(governs, input.ownerUserId);
    const named = commandSentence(input.command, () => names).slice(0, requestTitleMaxLength);
    const asker = askedBy(input.proposer);
    const summary = titleFirst(named, ` · ${asker}`);
    const gives = commandGives(
      input.command,
      face,
      await this.#scriptPlace(input.command, input.ownerUserId),
      await this.#automationContext(input),
    );
    const reason = input.reason?.trim().slice(0, 500) || null;
    const faceClass = row.faces[face]!.class;
    // A remove-only `trigger.secrets.set` (`destroy`) carries no secret values; all other
    // faces of a command with `secretFields` carry secret paths and are never approved on the card.
    const secretPaths =
      input.command.type === "trigger.secrets.set" && faceClass === "destroy"
        ? []
        : [...(row.secretFields ?? [])];
    const part: CommandRequestPart = {
      type: input.command.type,
      family: row.family,
      face: faceClass,
      summary,
      sentence: named,
      gives,
      command: RequestJsonObjectSchema.parse(JSON.parse(JSON.stringify(stored))),
      secretPaths,
      governs: JSON.parse(JSON.stringify(governs)) as CommandRequestPart["governs"],
      askKey: digest([input.proposer.key, input.command.type, commandResourceKey(governs)]),
      argumentsDigest: digest(stored),
      proposer: { ...input.proposer },
      agentReason: reason,
      editor: commandEditor(input.command.type),
    };
    const opened = await this.#store.open({
      ownerUserId: input.ownerUserId,
      callId: `command:${input.proposer.key}:${input.callKey}`.slice(0, 512),
      origin: input.origin,
      originatingThreadId: input.originatingThreadId,
      part,
      presentation: commandPresentation(part, named, asker),
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
  decline(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }) {
    return this.#store.decline(input);
  }

  /**
   * The person approves the command, as proposed or as they changed it on its screen. It must be
   * the same type and change the same thing; it runs as the person through `run`, the door. The
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
    // A command that carries a secret is never approved on the card (B3): the person enters it
    // directly on that command's own screen.
    if (pending.command.secretPaths.length > 0) {
      throw new OpensteerError({
        code: "bad_request",
        message:
          "This change carries a secret and must be done on its own screen, not approved on this card.",
      });
    }
    // The same approval again: what the first one came to, and nothing runs twice.
    if (pending.status !== "pending" && pending.command.approvalKey === input.idempotencyKey)
      return pending.command.outcome ?? { status: "running" };
    const parsed = hostApi["commands.dispatch"].payload.safeParse({
      ...input.command,
      type: pending.command.type,
      idempotencyKey: `command-request:${input.requestId}`,
    });
    if (!parsed.success)
      throw new OpensteerError({
        code: "bad_request",
        message: "That command is not valid as changed. Check its fields and approve again.",
      });
    const command = parsed.data;
    if (input.command.type !== undefined && input.command.type !== pending.command.type)
      throw changesWhatWasAsked();
    const row = commandRow(command.type) as CommandRow;
    const governs = (row.governs as (c: HostApiCommand) => CommandResource)(command);
    // A connection's ask is answerable only while it could still ask for this: a Disconnect or a
    // narrowing since closes it, and nothing runs.
    const connectionId = pending.command.proposer.connectionId;
    const approved = RequestJsonObjectSchema.parse(
      JSON.parse(JSON.stringify(proposedCommand(row, command))),
    );
    const begun = await this.#store.beginApproval({
      ...(connectionId
        ? {
            // As the connection the door admitted it under (`connection:<id>`), in the approval's
            // own transaction.
            stillAsks: (transaction) =>
              this.#stillAsks(
                transaction,
                actor.userId,
                connectionId,
                pending.originatingAgentSessionId ?? null,
                command,
              ),
          }
        : {}),
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      resolvedBy: actor.userId,
      settlementSessionId: actor.session.id,
      approvalKey: input.idempotencyKey,
      approved: {
        command: approved,
        changed: digest(approved) !== pending.command.argumentsDigest,
      },
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

  /**
   * Facts the Home reads about an automation for approval risk words (O2): whether the proposing
   * agent can change the script that reads the secret, or how many secrets a script edit receives.
   */
  async #automationContext(input: {
    readonly ownerUserId: UserId;
    readonly command: HostApiCommand;
    readonly proposer: CommandProposer;
    readonly proposerCallerKey?: string | undefined;
    readonly origin: CommandRequestOrigin;
  }): Promise<CommandAutomationContext | null> {
    if (input.command.type === "trigger.update") {
      if (input.command.input.script === undefined) return null;
      const row = await this.#database
        .selectFrom("triggers")
        .select(["secretNames", "encryptedSecrets"])
        .where("id", "=", input.command.triggerId)
        .where("createdBy", "=", input.ownerUserId)
        .executeTakeFirst();
      if (!row) return null;
      const names = Array.isArray(row.secretNames) ? row.secretNames : [];
      return { secretCount: names.length };
    }
    if (input.command.type === "trigger.secrets.set") {
      const subject = input.proposerCallerKey
        ? commandSubject(input.proposerCallerKey)
        : "agentSessionId" in input.origin && input.origin.agentSessionId
          ? ({ kind: "binding", bindingId: `session:${input.origin.agentSessionId}` } as const)
          : "runId" in input.origin && input.origin.runId
            ? ({ kind: "binding", bindingId: `run:${input.origin.runId}` } as const)
            : input.proposer.connectionId
              ? ({ kind: "connection", agentConnectionId: input.proposer.connectionId } as const)
              : null;
      if (!subject) return null;
      try {
        const admission = await admitCommand(this.#database, {
          ownerUserId: input.ownerUserId,
          subject,
          command: {
            type: "trigger.update",
            idempotencyKey: "risk-check",
            triggerId: input.command.triggerId,
            input: {
              expectedRevisionId: "trv_00000000-0000-4000-8000-000000000001",
              script: { interpreter: null, text: "" },
            },
          } as unknown as HostApiCommand,
        });
        return { proposerCanChangeScript: admission.answer === "now" };
      } catch {
        return { proposerCanChangeScript: false };
      }
    }
    return null;
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

/** Who asked, marked as the agent's own: its name and its task's title are its words. */
function askedBy(proposer: CommandProposer): string {
  return proposer.taskTitle
    ? `Asked by the agent “${proposer.name}”, in its task “${proposer.taskTitle}”`
    : `Asked by the agent “${proposer.name}”`;
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
    lines.push(`The agent's own reason (its words, not checked): ${part.agentReason}`);
  return {
    kind: "form",
    title: part.summary,
    detail: lines.join("\n\n"),
    detailFormat: "plain",
    fields: [
      {
        id: commandDecisionFieldId,
        prompt: "Decline it here, or approve it on its own screen.",
        choices: [{ label: "Decline", value: "decline" }],
        custom: true,
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
