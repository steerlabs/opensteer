import { ThreadIdSchema } from "@opensteer/core";
import type {
  AgentCommandActivity,
  AgentOperationTarget,
  AgentOperationView,
  AgentSessionEndReason,
  Request,
  ThreadStatus,
  ThreadAccessMode,
} from "@opensteer/core";
import type { AgentConnection } from "@opensteer/protocol";
import type { PersonalTaskExternalWork } from "@opensteer/protocol/personal-sync";
import { agentWho, type AgentWho } from "./agent-identity.js";
import { workSentence, workWords } from "./agent-work-copy.js";
import { plainSentence, type SentencePart } from "./sentence-parts.js";
import { threadInDirectory } from "./host-snapshot-selectors.js";
import { unwrapRpcResult } from "./host-session-client.js";
import type { HostClient } from "./client.js";

/** The connection a session belongs to, as a task row would carry it. */
export type SessionConnection = Pick<AgentConnection, "id" | "label" | "clientName"> &
  Partial<Pick<AgentConnection, "client" | "identity" | "identityAtConsent">>;

/** A connected agent's session on one task, kept after it ends so the task stays its own. */
export interface AgentSessionSlot {
  readonly sessionId: string;
  readonly connection: SessionConnection;
  readonly status: "active" | "ended";
  readonly endReason: AgentSessionEndReason | null;
  /** Its operations, oldest first, as the task's activity shows them; absent until read. */
  readonly operations?: readonly AgentOperationView[] | undefined;
}

/** The parts of a direct operation's Request the Home now joins into one block of text. */
export interface AgentOperationRequestSlot {
  readonly operationId: string;
  readonly connection: SessionConnection;
  /** The Home's own words: what, where and who. */
  readonly summary: string;
  /** The exact script or calls. */
  readonly calls: string;
  /** The agent's own reason: its words, not checked. */
  readonly agentReason: string | null;
  readonly target: AgentOperationTarget;
  /** It reached its deadline unanswered. */
  readonly expired?: boolean;
}

/**
 * A task's session as the Home reports it on the task row, with the operations
 * `threads.activity` returned (newest first there; oldest first here).
 */
export function sessionSlotFromHome(
  work: PersonalTaskExternalWork | null | undefined,
  operations?: readonly AgentOperationView[] | undefined,
): AgentSessionSlot | null {
  if (!work) return null;
  return {
    sessionId: work.sessionId,
    connection: work.connection,
    status: work.status,
    endReason: work.endReason,
    ...(operations ? { operations: [...operations].reverse() } : {}),
  };
}

export function agentSessionSlot(
  snapshot: Parameters<typeof threadInDirectory>[1],
  threadId: string,
  operations?: readonly AgentOperationView[] | undefined,
): AgentSessionSlot | null {
  return sessionSlotFromHome(threadInDirectory(threadId, snapshot)?.externalWork, operations);
}

/** A connected agent's task's operations, newest first, as `threads.activity` lists them. */
export async function readTaskActivity(
  client: { readonly rpc: Pick<HostClient["rpc"], "threads.activity"> },
  threadId: string,
  signal?: AbortSignal,
): Promise<readonly AgentOperationView[]> {
  return unwrapRpcResult(
    await client.rpc["threads.activity"](
      { threadId: ThreadIdSchema.parse(threadId) },
      signal ? { signal } : undefined,
    ),
  ).operations;
}

/** A direct operation's Request in its parts, as the Home sends them on the Request. */
export function operationRequestSlot(
  request: Pick<RequestLike, "agentOperation">,
  connection: SessionConnection | null | undefined,
): AgentOperationRequestSlot | null {
  const operation = request.agentOperation;
  if (!operation) return null;
  return {
    operationId: operation.operationId,
    connection: connection ?? { id: operation.connectionId, label: "", clientName: "" },
    summary: operation.summary,
    calls: operation.calls,
    agentReason: operation.agentReason,
    target: operation.target,
    ...(operation.expired ? { expired: true } : {}),
  };
}

/* ------------------------------------------------------------------------- *
 * The agent, as a task or a tab names it.
 * ------------------------------------------------------------------------- */

export interface SessionAgent {
  readonly name: string;
  readonly initial: string;
  readonly providerId: string | null;
  readonly who: AgentWho | null;
}

const unknownAgent: SessionAgent = {
  name: workWords("work.someAgent"),
  initial: "A",
  providerId: null,
  who: null,
};

export function sessionAgent(
  connection: SessionConnection | null | undefined,
  withdrawnAt?: string | null | undefined,
): SessionAgent {
  if (!connection) return unknownAgent;
  const who = agentWho({
    clientName: connection.clientName,
    redirect: connection.client?.redirectOrigin ?? null,
    identity: connection.identity,
    identityAtConsent: connection.identityAtConsent,
    withdrawnAt,
  });
  const name = who.providerId
    ? who.heading
    : connection.label.trim() || connection.clientName || unknownAgent.name;
  return {
    name,
    initial: Array.from(name)[0]?.toUpperCase() ?? "A",
    providerId: who.providerId,
    who,
  };
}

export function sessionAgentPart(agent: SessionAgent): SentencePart {
  return agent.who !== null && agent.name !== unknownAgent.name ? { name: agent.name } : agent.name;
}

export function tabNeedsYouParts(
  connection: SessionConnection | null | undefined,
  withdrawnAt?: string | null | undefined,
): readonly SentencePart[] {
  return workSentence("tab.needsYou", {
    agent: sessionAgentPart(sessionAgent(connection, withdrawnAt)),
  });
}

/* ------------------------------------------------------------------------- *
 * One operation, as the task's activity reads it.
 * ------------------------------------------------------------------------- */

export type OperationTone = "ok" | "bad" | "warn" | "muted" | "busy";
export type OperationGlyph = "globe" | "app" | "plugin" | "list";

export interface OperationRow {
  readonly id: string;
  readonly glyph: OperationGlyph;
  readonly mode?: ThreadAccessMode;
  /** What it did, in plain words: "Opened a tab in Personal on Studio Mac". */
  readonly action: string;
  /** Who allowed it: you, Auto, full access, or reading only; null before anyone did. */
  readonly allowedBy: string | null;
  readonly outcome: { readonly label: string; readonly tone: OperationTone };
  /** The plain statement an unknown outcome needs. */
  readonly detail: string | null;
  readonly at: string;
}

const glyphs: Readonly<Record<AgentOperationTarget["grant"]["kind"], OperationGlyph>> = {
  "browser-profile": "globe",
  // Tabs the person shares from Chrome are still browser tabs.
  "chrome-tabs": "globe",
  "computer-app": "app",
  plugin: "plugin",
  device: "list",
};
const knownTools = new Set([
  "tab_list",
  "tab_open",
  "tab_close",
  "browser_use",
  "browser_connect",
  "computer_use",
  "plugin_call",
]);

export function operationAction(operation: AgentOperationView): string {
  const target = operation.target.name;
  const tool = knownTools.has(operation.tool) ? operation.tool : "other";
  // Past tense only for what ran; a waiting, running, refused or uncertain one may not have.
  const ran = operation.outcome === "completed" || operation.outcome === "failed";
  return workWords(`op.${ran ? "" : "base."}${tool}` as "op.tab_open", { target });
}

export function operationRow(operation: AgentOperationView): OperationRow {
  const base = operationAction(operation);
  const device = operation.target.device;
  const action = device ? workWords("op.onDevice", { action: base, device: device.name }) : base;
  const decision = operation.decision;
  const allowedBy =
    decision === null
      ? null
      : decision.by === "refused"
        ? decision.reason === "person"
          ? workWords("op.refused.person")
          : workWords("op.refused.other", { message: decision.message })
        : workWords(`op.by.${decision.by}`);
  const outcome = operationOutcome(operation);
  return {
    id: operation.id,
    glyph: glyphs[operation.target.grant.kind],
    mode: operation.mode,
    action,
    allowedBy,
    outcome,
    detail: operation.outcome === "unknown" ? workWords("op.outcome.unknownDetail") : null,
    at: operationTime(operation),
  };
}

export function operationTime(operation: AgentOperationView): string {
  return operation.completedAt ?? operation.handedOffAt ?? operation.createdAt;
}

function operationOutcome(operation: AgentOperationView): OperationRow["outcome"] {
  switch (operation.outcome) {
    case "completed":
      return { label: workWords("op.outcome.completed"), tone: "ok" };
    case "failed":
      return { label: workWords("op.outcome.failed"), tone: "bad" };
    case "refused":
      return operation.decision?.by === "refused" && operation.decision.reason === "person"
        ? { label: workWords("op.refused.person"), tone: "muted" }
        : { label: workWords("op.outcome.refused"), tone: "bad" };
    case "unknown":
      return { label: workWords("op.outcome.unknown"), tone: "warn" };
    case null:
      return operation.state === "pending"
        ? { label: workWords("op.state.pending"), tone: "warn" }
        : { label: workWords("op.state.running"), tone: "busy" };
  }
}

/**
 * One command the agent sent through the door, as a row beside its operations: the Home's own
 * sentence, which names the agent and the task it came from (C5), and what became of it.
 */
export function commandActivityRow(command: AgentCommandActivity): OperationRow {
  return {
    id: command.id,
    glyph: "list",
    action: command.sentence,
    allowedBy: null,
    outcome: commandOutcome(command),
    detail:
      command.status === "unknown" || command.outcome === "unknown"
        ? workWords("op.outcome.unknownDetail")
        : null,
    at: command.createdAt,
  };
}

function commandOutcome(command: AgentCommandActivity): OperationRow["outcome"] {
  switch (command.status) {
    case "running":
      return { label: workWords("op.state.running"), tone: "busy" };
    case "done":
      return { label: workWords("op.outcome.completed"), tone: "ok" };
    case "failed":
      return { label: workWords("op.outcome.failed"), tone: "bad" };
    case "unknown":
      return { label: workWords("op.outcome.unknown"), tone: "warn" };
    case "asked":
      return { label: workWords("cmd.asked"), tone: "warn" };
    case "approved": {
      const then =
        command.outcome === "done"
          ? null
          : command.outcome === "failed"
            ? { word: workWords("op.outcome.failed"), tone: "bad" as const }
            : command.outcome === "unknown"
              ? { word: workWords("op.outcome.unknown"), tone: "warn" as const }
              : { word: workWords("op.state.running"), tone: "busy" as const };
      return then
        ? { label: workWords("cmd.approvedThen", { outcome: then.word }), tone: then.tone }
        : { label: workWords("cmd.approved"), tone: "ok" };
    }
    case "declined":
      return { label: workWords("cmd.declined"), tone: "muted" };
    case "withdrawn":
      return { label: workWords("cmd.withdrawn"), tone: "muted" };
    case "closed":
      return { label: workWords("cmd.closed"), tone: "muted" };
  }
}

/**
 * A page of activity as one list, newest first: the operations and the commands of the same span,
 * in the order they happened, never as two blocks.
 */
export function activityRows(page: {
  readonly operations: readonly AgentOperationView[];
  readonly commands: readonly AgentCommandActivity[];
}): readonly OperationRow[] {
  const rows = [
    ...page.operations.map((operation) => ({
      row: operationRow(operation),
      at: operation.createdAt,
    })),
    ...page.commands.map((command) => ({
      row: commandActivityRow(command),
      at: command.createdAt,
    })),
  ];
  return rows.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1)).map(({ row }) => row);
}

/* ------------------------------------------------------------------------- *
 * A task a connected agent works itself.
 * ------------------------------------------------------------------------- */

export type SessionTaskState = "working" | "waiting" | "idle" | "stopped" | "ended";

export interface SessionTaskView {
  readonly agent: SessionAgent;
  readonly state: SessionTaskState;
  /** Where the composer would be: the agent's state, never a box to type in. */
  readonly statusLine: string;
  readonly statusLineParts: readonly SentencePart[];
  readonly noComposer: string;
  readonly noComposerParts: readonly SentencePart[];
  /** "Connected agent · https://grok.com", or for an app on this computer. */
  readonly header: string;
  /** Ends this session, bound to the session the person saw; null once it has ended. */
  readonly stop: {
    readonly sessionId: string;
    readonly label: string;
    readonly labelParts: readonly SentencePart[];
    readonly detail: string;
    readonly detailParts: readonly SentencePart[];
  } | null;
  readonly activity:
    | { readonly kind: "unavailable" }
    | { readonly kind: "ready"; readonly rows: readonly OperationRow[] };
}

/**
 * The task view for a connected agent's own task, or null for any other task. A task is
 * the agent's while the Home names its session (`agentSessionId`), or while the preview's
 * slot keeps it after the session ended.
 */
export function sessionTaskView(input: {
  readonly thread: {
    readonly status: ThreadStatus;
    readonly agentSessionId?: string | null | undefined;
  };
  readonly slot: AgentSessionSlot | null | undefined;
  readonly withdrawnAt?: string | null | undefined;
}): SessionTaskView | null {
  const { thread, slot } = input;
  const sessionId = slot?.sessionId ?? thread.agentSessionId ?? null;
  if (sessionId === null) return null;
  const agent = sessionAgent(slot?.connection, input.withdrawnAt);
  const agentName = sessionAgentPart(agent);
  const ended = slot?.status === "ended";
  const state: SessionTaskState = ended
    ? slot.endReason === "stopped"
      ? "stopped"
      : "ended"
    : thread.status === "waiting"
      ? "waiting"
      : thread.status === "running"
        ? "working"
        : "idle";
  const statusLineParts: readonly SentencePart[] =
    state === "working"
      ? workSentence("work.working", { agent: agentName })
      : state === "waiting"
        ? workSentence("work.waiting", { agent: agentName })
        : state === "idle"
          ? workSentence("work.idle", { agent: agentName })
          : state === "stopped"
            ? [workWords("work.stopped")]
            : workSentence(`work.ended.${slot?.endReason ?? "idle"}` as "work.ended.idle", {
                agent: agentName,
              });
  const noComposerParts = workSentence("work.noComposer", { agent: agentName });
  const stopLabelParts = workSentence("work.stop", { agent: agentName });
  const stopDetailParts = workSentence("work.stopDetail", { agent: agentName });
  const who = agent.who;
  return {
    agent,
    state,
    statusLine: plainSentence(statusLineParts),
    statusLineParts,
    noComposer: plainSentence(noComposerParts),
    noComposerParts,
    header:
      who === null || who.local
        ? workWords("work.headerLocal")
        : workWords("work.header", { origin: who.detail }),
    stop:
      state === "stopped" || state === "ended"
        ? null
        : {
            sessionId,
            label: plainSentence(stopLabelParts),
            labelParts: stopLabelParts,
            detail: plainSentence(stopDetailParts),
            detailParts: stopDetailParts,
          },
    activity: slot?.operations
      ? { kind: "ready", rows: slot.operations.map(operationRow) }
      : { kind: "unavailable" },
  };
}

/** A session task's row in Tasks: the agent's mark, and what it is using now. */
export function sessionTaskRow(input: {
  readonly thread: {
    readonly status: ThreadStatus;
    readonly agentSessionId?: string | null | undefined;
  };
  readonly slot: AgentSessionSlot | null | undefined;
}): {
  readonly agent: SessionAgent;
  readonly line: string;
  readonly lineParts: readonly SentencePart[];
  readonly working: boolean;
} | null {
  const view = sessionTaskView(input);
  if (!view) return null;
  const latest = input.slot?.operations?.at(-1);
  const lineParts = latest
    ? workSentence(
        "work.subtitle",
        { agent: sessionAgentPart(view.agent) },
        { what: latest.target.name },
      )
    : view.statusLineParts;
  return {
    agent: view.agent,
    line: plainSentence(lineParts),
    lineParts,
    working: view.state === "working",
  };
}

/* ------------------------------------------------------------------------- *
 * A tab an agent is using.
 * ------------------------------------------------------------------------- */

/**
 * Who is using a tab and for which task, when that is a connected agent's own task. A tab
 * the person shares from their own Chrome says both of them.
 */
export function tabAgentLine(input: {
  readonly sharedFromChrome?: boolean;
  readonly occupant: { readonly threadId: string; readonly title: string } | null;
  readonly slot: AgentSessionSlot | null | undefined;
  readonly withdrawnAt?: string | null | undefined;
}): {
  readonly line: string;
  readonly lineParts: readonly SentencePart[];
  readonly stop: { readonly sessionId: string } | null;
} | null {
  const { occupant, slot } = input;
  if (!occupant || !slot) return null;
  const agentName = sessionAgentPart(sessionAgent(slot.connection, input.withdrawnAt));
  const task = occupant.title.trim();
  if (slot.status === "ended") {
    if (slot.endReason !== "stopped") return null;
    const stopped = workWords("tab.stopped");
    return { line: stopped, lineParts: [stopped], stop: null };
  }
  const lineParts = input.sharedFromChrome
    ? task
      ? workSentence("tab.shared", { agent: agentName, task: { name: task } })
      : workSentence("tab.sharedNoTask", { agent: agentName })
    : task
      ? workSentence("tab.using", { agent: agentName, task: { name: task } })
      : workSentence("tab.usingNoTask", { agent: agentName });
  return { line: plainSentence(lineParts), lineParts, stop: { sessionId: slot.sessionId } };
}

/* ------------------------------------------------------------------------- *
 * The Request a direct operation opens.
 * ------------------------------------------------------------------------- */

/** The Home's two answers for a direct operation, by the values it offers. */
export const operationAnswerValues = { allow: "allow", deny: "deny" } as const;

/** What this reads of a Request: a whole Request or a pending view of one both fit. */
type RequestLike = {
  readonly id: string;
  readonly status: Request["status"];
  readonly originatingAgentSessionId?: string | null | undefined;
  readonly agentOperation?: Request["agentOperation"] | undefined;
  readonly presentation:
    | {
        readonly kind: "form";
        readonly title: string;
        readonly detail?: string | undefined;
        readonly fields: readonly {
          readonly id: string;
          readonly choices?: readonly { readonly value: string }[] | undefined;
        }[];
      }
    | { readonly kind: "choice" | "external"; readonly title: string };
  readonly response?:
    | { readonly kind: "form"; readonly answers: Readonly<Record<string, readonly string[]>> }
    | { readonly kind: "choice" | "external" }
    | null
    | undefined;
};

/** The field a direct operation's Request asks on, or null for any other Request. */
/**
 * The field a direct operation's approval is answered on, or null for any other Request. Only
 * the Home says a Request is an approval, by naming that field in its operation parts: a
 * question whose answers happen to read allow and deny is still a question. Every Home that
 * opens these Requests names the field; no released Home opens them at all.
 */
export function operationDecisionField(request: RequestLike): string | null {
  if (!request.originatingAgentSessionId || request.presentation.kind !== "form") return null;
  const named = request.agentOperation?.decisionFieldId;
  if (!named) return null;
  return request.presentation.fields.some(({ id }) => id === named) ? named : null;
}

/**
 * What a connected agent asked the person itself (`ask_person`), apart from a direct
 * operation's Allow once or Don't allow: the open ones, oldest first. They are answered with
 * the choices the Request itself carries, on every client, like any other question.
 */
export function sessionQuestions<
  R extends RequestLike & { readonly createdAt: string; readonly kind: string },
>(requests: readonly R[]): readonly R[] {
  return (
    requests
      .filter(
        (request) =>
          request.status === "pending" &&
          Boolean(request.originatingAgentSessionId) &&
          request.kind === "person.question" &&
          request.presentation.kind === "form" &&
          operationDecisionField(request) === null,
      )
      // Filtered first, so sorting in place sorts a copy: Hermes has no `toSorted`.
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
  );
}

export type OperationRequestState = "pending" | "allowed" | "denied" | "expired" | "withdrawn";

export interface OperationRequestView {
  readonly agent: SessionAgent;
  /** The Home's question, never the agent's words. */
  readonly question: string;
  /** "“{agent}”: {question}", for the Needs you list. */
  readonly listTitle: string;
  readonly listTitleParts: readonly SentencePart[];
  /** The Home's summary of what, where and who; its whole text when the parts aren't sent. */
  readonly summary: string;
  /** Where it would act: "Shopping · Studio Mac"; null when the Home sent no parts. */
  readonly context: string | null;
  /** The agent's own reason, labelled as its words; separate from everything else. */
  readonly agentWords: {
    readonly label: string;
    readonly labelParts: readonly SentencePart[];
    readonly text: string;
  } | null;
  /** The exact script or calls, behind one tap. */
  readonly calls: { readonly show: string; readonly hide: string; readonly text: string } | null;
  readonly state: OperationRequestState;
  /** Shown once it is no longer pending. */
  readonly settled: string | null;
  readonly settledParts: readonly SentencePart[] | null;
  readonly answers: {
    readonly fieldId: string;
    readonly allow: { readonly label: string; readonly value: string };
    readonly deny: { readonly label: string; readonly value: string };
  } | null;
  readonly after: string;
  readonly afterParts: readonly SentencePart[];
}

export function operationRequestView(input: {
  readonly request: RequestLike;
  /** The task’s session, to name the connected agent. */
  readonly session?: AgentSessionSlot | null | undefined;
  readonly withdrawnAt?: string | null | undefined;
}): OperationRequestView | null {
  const { request } = input;
  const slot = operationRequestSlot(request, input.session?.connection ?? null);
  const fieldId = operationDecisionField(request);
  if (fieldId === null || request.presentation.kind !== "form") return null;
  const agent = sessionAgent(slot?.connection ?? input.session?.connection, input.withdrawnAt);
  const agentName = sessionAgentPart(agent);
  const question = request.presentation.title;
  const answered =
    request.response?.kind === "form" ? request.response.answers[fieldId]?.[0] : undefined;
  const state: OperationRequestState =
    request.status === "pending"
      ? "pending"
      : request.status === "fulfilled"
        ? answered === operationAnswerValues.allow
          ? "allowed"
          : "denied"
        : request.status === "declined"
          ? "denied"
          : slot?.expired
            ? "expired"
            : "withdrawn";
  const listTitleParts = workSentence("ask.title", { agent: agentName }, { question });
  const agentWordsLabelParts = slot?.agentReason
    ? workSentence("ask.says", { agent: agentName })
    : null;
  const settledParts: readonly SentencePart[] | null =
    state === "allowed"
      ? [workWords("ask.allowed")]
      : state === "denied"
        ? [workWords("ask.denied")]
        : state === "expired"
          ? workSentence("ask.expired", { agent: agentName })
          : state === "withdrawn"
            ? withdrawnLineParts(agentName, input.session?.endReason ?? null, slot?.target.name)
            : null;
  const afterParts = workSentence("ask.after", { agent: agentName });
  return {
    agent,
    question,
    listTitle: plainSentence(listTitleParts),
    listTitleParts,
    summary: slot?.summary ?? request.presentation.detail ?? "",
    context: slot
      ? slot.target.device && slot.target.device.name !== slot.target.name
        ? workWords("ask.context", { target: slot.target.name, device: slot.target.device.name })
        : slot.target.name
      : null,
    agentWords:
      slot?.agentReason && agentWordsLabelParts
        ? {
            label: plainSentence(agentWordsLabelParts),
            labelParts: agentWordsLabelParts,
            text: slot.agentReason,
          }
        : null,
    calls: slot
      ? { show: workWords("ask.calls"), hide: workWords("ask.hideCalls"), text: slot.calls }
      : null,
    state,
    settled: settledParts ? plainSentence(settledParts) : null,
    settledParts,
    answers:
      state === "pending"
        ? {
            fieldId,
            allow: { label: workWords("ask.allow"), value: operationAnswerValues.allow },
            deny: { label: workWords("ask.deny"), value: operationAnswerValues.deny },
          }
        : null,
    after: plainSentence(afterParts),
    afterParts,
  };
}

function withdrawnLineParts(
  agent: SentencePart,
  reason: AgentSessionEndReason | null,
  target: string | undefined,
): readonly SentencePart[] {
  if (reason === "stopped") return workSentence("ask.withdrawn.stopped", { agent });
  if (reason === "revoked") return workSentence("ask.withdrawn.revoked", { agent });
  if (reason === "narrowed" && target)
    return workSentence("ask.withdrawn.narrowed", { agent }, { target });
  return [workWords("ask.withdrawn")];
}
