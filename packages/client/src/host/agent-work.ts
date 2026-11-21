import { ThreadIdSchema } from "@opensteer/core";
import type {
  AgentOperationTarget,
  AgentOperationView,
  AgentSessionEndReason,
  Request,
  ThreadStatus,
} from "@opensteer/core";
import type { AgentConnection } from "@opensteer/protocol";
import type { PersonalTaskExternalWork } from "@opensteer/protocol/personal-sync";
import { agentWho, type AgentWho } from "./agent-identity.js";
import { workWords } from "./agent-work-copy.js";
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
  client: Pick<HostClient, "rpc">,
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

/* ------------------------------------------------------------------------- *
 * One operation, as the task's activity reads it.
 * ------------------------------------------------------------------------- */

export type OperationTone = "ok" | "bad" | "warn" | "muted" | "busy";
export type OperationGlyph = "globe" | "app" | "plugin" | "list";

export interface OperationRow {
  readonly id: string;
  readonly glyph: OperationGlyph;
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

export function operationRow(operation: AgentOperationView): OperationRow {
  const target = operation.target.name;
  const tool = knownTools.has(operation.tool) ? operation.tool : "other";
  // Past tense only for what ran; a waiting, running, refused or uncertain one may not have.
  const ran = operation.outcome === "completed" || operation.outcome === "failed";
  const base = workWords(`op.${ran ? "" : "base."}${tool}` as "op.tab_open", { target });
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
    action,
    allowedBy,
    outcome,
    detail: operation.outcome === "unknown" ? workWords("op.outcome.unknownDetail") : null,
    at: operation.completedAt ?? operation.handedOffAt ?? operation.createdAt,
  };
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

/* ------------------------------------------------------------------------- *
 * A task a connected agent works itself.
 * ------------------------------------------------------------------------- */

export type SessionTaskState = "working" | "waiting" | "idle" | "stopped" | "ended";

export interface SessionTaskView {
  readonly agent: SessionAgent;
  readonly state: SessionTaskState;
  /** Where the composer would be: the agent's state, never a box to type in. */
  readonly statusLine: string;
  readonly noComposer: string;
  /** "Connected agent · https://grok.com", or for an app on this computer. */
  readonly header: string;
  /** Ends this session, bound to the session the person saw; null once it has ended. */
  readonly stop: {
    readonly sessionId: string;
    readonly label: string;
    readonly detail: string;
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
  const name = agent.name;
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
  const statusLine =
    state === "working"
      ? workWords("work.working", { agent: name })
      : state === "waiting"
        ? workWords("work.waiting", { agent: name })
        : state === "idle"
          ? workWords("work.idle", { agent: name })
          : state === "stopped"
            ? workWords("work.stopped")
            : workWords(`work.ended.${slot?.endReason ?? "idle"}` as "work.ended.idle", {
                agent: name,
              });
  const who = agent.who;
  return {
    agent,
    state,
    statusLine,
    noComposer: workWords("work.noComposer", { agent: name }),
    header:
      who === null || who.local
        ? workWords("work.headerLocal")
        : workWords("work.header", { origin: who.detail }),
    stop:
      state === "stopped" || state === "ended"
        ? null
        : {
            sessionId,
            label: workWords("work.stop", { agent: name }),
            detail: workWords("work.stopDetail", { agent: name }),
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
}): { readonly agent: SessionAgent; readonly line: string; readonly working: boolean } | null {
  const view = sessionTaskView(input);
  if (!view) return null;
  const latest = input.slot?.operations?.at(-1);
  return {
    agent: view.agent,
    line: latest
      ? workWords("work.subtitle", { agent: view.agent.name, what: latest.target.name })
      : view.statusLine,
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
}): { readonly line: string; readonly stop: { readonly sessionId: string } | null } | null {
  const { occupant, slot } = input;
  if (!occupant || !slot) return null;
  const agent = sessionAgent(slot.connection, input.withdrawnAt).name;
  const task = occupant.title.trim();
  if (slot.status === "ended")
    return slot.endReason === "stopped" ? { line: workWords("tab.stopped"), stop: null } : null;
  const line = input.sharedFromChrome
    ? task
      ? workWords("tab.shared", { agent, task })
      : workWords("tab.sharedNoTask", { agent })
    : task
      ? workWords("tab.using", { agent, task })
      : workWords("tab.usingNoTask", { agent });
  return { line, stop: { sessionId: slot.sessionId } };
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
export function operationDecisionField(request: RequestLike): string | null {
  if (!request.originatingAgentSessionId || request.presentation.kind !== "form") return null;
  // The Home names its decision field; older Homes are recognised by their two answers.
  const named = request.agentOperation?.decisionFieldId;
  if (named) return request.presentation.fields.some(({ id }) => id === named) ? named : null;
  const [field, ...rest] = request.presentation.fields;
  if (!field || rest.length > 0) return null;
  const values = new Set(field.choices?.map(({ value }) => value) ?? []);
  return values.size === 2 &&
    values.has(operationAnswerValues.allow) &&
    values.has(operationAnswerValues.deny)
    ? field.id
    : null;
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
  /** "{agent}: {question}", for the Needs you list. */
  readonly listTitle: string;
  /** The Home's summary of what, where and who; its whole text when the parts aren't sent. */
  readonly summary: string;
  /** Where it would act: "Shopping · Studio Mac"; null when the Home sent no parts. */
  readonly context: string | null;
  /** The agent's own reason, labelled as its words; separate from everything else. */
  readonly agentWords: { readonly label: string; readonly text: string } | null;
  /** The exact script or calls, behind one tap. */
  readonly calls: { readonly show: string; readonly hide: string; readonly text: string } | null;
  readonly state: OperationRequestState;
  /** Shown once it is no longer pending. */
  readonly settled: string | null;
  readonly answers: {
    readonly fieldId: string;
    readonly allow: { readonly label: string; readonly value: string };
    readonly deny: { readonly label: string; readonly value: string };
  } | null;
  readonly after: string;
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
  return {
    agent,
    question,
    listTitle: workWords("ask.title", { agent: agent.name, question }),
    summary: slot?.summary ?? request.presentation.detail ?? "",
    context: slot
      ? slot.target.device && slot.target.device.name !== slot.target.name
        ? workWords("ask.context", { target: slot.target.name, device: slot.target.device.name })
        : slot.target.name
      : null,
    agentWords: slot?.agentReason
      ? { label: workWords("ask.says", { agent: agent.name }), text: slot.agentReason }
      : null,
    calls: slot
      ? { show: workWords("ask.calls"), hide: workWords("ask.hideCalls"), text: slot.calls }
      : null,
    state,
    settled:
      state === "allowed"
        ? workWords("ask.allowed")
        : state === "denied"
          ? workWords("ask.denied")
          : state === "expired"
            ? workWords("ask.expired", { agent: agent.name })
            : state === "withdrawn"
              ? withdrawnLine(agent.name, input.session?.endReason ?? null, slot?.target.name)
              : null,
    answers:
      state === "pending"
        ? {
            fieldId,
            allow: { label: workWords("ask.allow"), value: operationAnswerValues.allow },
            deny: { label: workWords("ask.deny"), value: operationAnswerValues.deny },
          }
        : null,
    after: workWords("ask.after", { agent: agent.name }),
  };
}

function withdrawnLine(
  agent: string,
  reason: AgentSessionEndReason | null,
  target: string | undefined,
): string {
  if (reason === "stopped") return workWords("ask.withdrawn.stopped", { agent });
  if (reason === "revoked") return workWords("ask.withdrawn.revoked", { agent });
  if (reason === "narrowed" && target)
    return workWords("ask.withdrawn.narrowed", { agent, target });
  return workWords("ask.withdrawn");
}
