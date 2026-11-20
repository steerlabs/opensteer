import type {
  AgentOperationTarget,
  AgentOperationView,
  AgentSessionEndReason,
  Request,
  ThreadStatus,
} from "@opensteer/core";
import type { AgentConnection } from "@opensteer/protocol";
import { agentWho, type AgentWho } from "./agent-identity.js";
import { workWords } from "./agent-work-copy.js";

/* ------------------------------------------------------------------------- *
 * What the Home does not report yet. Each slot is optional, keyed by what it
 * belongs to, and filled only by the preview today; a real Home leaves it
 * empty and every screen says only what it can prove.
 * ------------------------------------------------------------------------- */

/** The connection a session belongs to, as a task row would carry it. */
export type SessionConnection = Pick<AgentConnection, "id" | "label" | "clientName"> &
  Partial<Pick<AgentConnection, "client" | "identity" | "identityAtConsent">>;

/** A connected agent's session on one task, kept after it ends so the task stays its own. */
export interface AgentSessionSlot {
  readonly sessionId: string;
  readonly connection: SessionConnection;
  readonly status: "active" | "ended";
  readonly endReason: AgentSessionEndReason | null;
  /** Its operations, oldest first, as the task's activity shows them. */
  readonly operations: readonly AgentOperationView[];
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

export interface AgentWorkSlots {
  /** By task id. */
  readonly sessions?: Readonly<Record<string, AgentSessionSlot>>;
  /** By Request id. */
  readonly requests?: Readonly<Record<string, AgentOperationRequestSlot>>;
  /** Tabs the person shares with an agent from their own Chrome. */
  readonly sharedTabs?: readonly string[];
  /** By connection id: when the Home withdrew a verified identity. */
  readonly withdrawn?: Readonly<Record<string, string>>;
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
  const name = connection.label.trim() || connection.clientName;
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
  "computer-app": "app",
  plugin: "plugin",
  device: "list",
};
const knownTools = new Set([
  "tab_list",
  "tab_open",
  "tab_close",
  "browser_use",
  "computer_use",
  "plugin_call",
]);

export function operationRow(operation: AgentOperationView): OperationRow {
  const target = operation.target.name;
  const base = knownTools.has(operation.tool)
    ? workWords(`op.${operation.tool}` as "op.tab_open", { target })
    : workWords("op.other", { tool: operation.tool, target });
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
    activity: slot
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
  const latest = input.slot?.operations.at(-1);
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
  readonly tabId: string;
  readonly occupant: { readonly threadId: string; readonly title: string } | null;
  readonly slot: AgentSessionSlot | null | undefined;
  readonly sharedTabs?: readonly string[] | undefined;
  readonly withdrawnAt?: string | null | undefined;
}): { readonly line: string; readonly stop: { readonly sessionId: string } | null } | null {
  const { occupant, slot } = input;
  if (!occupant || !slot) return null;
  const agent = sessionAgent(slot.connection, input.withdrawnAt).name;
  const task = occupant.title.trim();
  const shared = input.sharedTabs?.includes(input.tabId) === true;
  if (slot.status === "ended")
    return slot.endReason === "stopped" ? { line: workWords("tab.stopped"), stop: null } : null;
  const line = shared
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
  const [field, ...rest] = request.presentation.fields;
  if (!field || rest.length > 0) return null;
  const values = new Set(field.choices?.map(({ value }) => value) ?? []);
  return values.size === 2 &&
    values.has(operationAnswerValues.allow) &&
    values.has(operationAnswerValues.deny)
    ? field.id
    : null;
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
  readonly slot: AgentOperationRequestSlot | null | undefined;
  /** The task's session slot, to name the agent when the Request's own slot doesn't. */
  readonly session?: AgentSessionSlot | null | undefined;
  readonly withdrawnAt?: string | null | undefined;
}): OperationRequestView | null {
  const { request, slot } = input;
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
