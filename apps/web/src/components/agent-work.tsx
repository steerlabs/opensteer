import {
  agentSessionSlot,
  readTaskActivity,
  mutationIdempotencyKey,
  operationRequestView,
  requestDecisionRevision,
  sessionTaskRow,
  sessionTaskView,
  tabAgentLine,
  threadInDirectory,
  type OperationGlyph,
  type OperationRequestView,
  type HostClient,
  type SessionTaskView,
  workWords,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { AgentOperationView, Request, RequestResponse, ThreadStatus } from "@opensteer/core";
import type { NeedsYouEntry } from "@opensteer/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionLine } from "./action-line.js";
import { useOptionalShell, useShell } from "./app-shell.js";
import { Icon, type IconName } from "./icon.js";
import { AgentMark } from "./settings/agent-mark.js";
import { requestAnswer, useAction } from "./use-action.js";

/**
 * A connected agent's task's operations as the Home lists them, read again whenever the task's
 * state changes; undefined until read, or on a Home that does not list them.
 */
function useTaskActivity(hostClient: HostClient, threadId: string, key: string | null) {
  const [operations, setOperations] = useState<readonly AgentOperationView[] | undefined>();
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    void readTaskActivity(hostClient, threadId, controller.signal).then(
      (operations) => setOperations(operations),
      () => setOperations(undefined),
    );
    return () => controller.abort();
  }, [hostClient, threadId, key]);
  return operations;
}

/** The view for a connected agent's own task, or null for any other task. */
export function useSessionTask(threadId: string): SessionTaskView | null {
  const { snapshot, hostClient } = useShell();
  const thread = threadInDirectory(threadId, snapshot);
  const operations = useTaskActivity(
    hostClient,
    threadId,
    thread?.externalWork ? `${thread.status}|${thread.externalWork.status}` : null,
  );
  if (!thread) return null;
  const slot = agentSessionSlot(snapshot, threadId, operations);
  return sessionTaskView({
    thread: { status: thread.status, agentSessionId: thread.agentSessionId ?? null },
    slot,
    withdrawnAt: slot ? snapshot.agentWork?.withdrawn?.[slot.connection.id] : null,
  });
}

/** Ends this agent's session on this task, bound to the session the person saw. */
function useStopSession(threadId: string, sessionId: string | null) {
  const { hostClient } = useShell();
  return useAction(
    hostClient,
    {
      label: "stop this agent",
      done: "stopped",
      happened: "this agent was stopped",
      execute: () =>
        hostClient.dispatch({
          type: "agent.session.stop",
          threadId,
          agentSessionId: sessionId!,
          idempotencyKey: mutationIdempotencyKey(`agent-session-stop:${sessionId}`),
        }),
    },
    `agent-session-stop:${sessionId ?? ""}`,
  );
}

/**
 * Where a task's composer would be: the agent's state and Stop. The person can't write to a
 * task another agent works itself.
 */
export function SessionTaskBar({
  threadId,
  view,
}: {
  readonly threadId: string;
  readonly view: SessionTaskView;
}) {
  const stop = useStopSession(threadId, view.stop?.sessionId ?? null);
  return (
    <div className="session-bar" role="status" aria-live="polite">
      <div className="session-bar__row">
        <AgentMark identity={view.agent} />
        <span className="session-bar__body">
          <span className="session-bar__status">{view.statusLine}</span>
          <span className="session-bar__note">{view.noComposer}</span>
        </span>
        {view.stop ? (
          <button
            className="btn btn--small session-bar__stop"
            disabled={stop.running}
            onClick={() => void stop.run(undefined)}
            title={view.stop.detail}
            type="button"
          >
            <Icon name="stop" />
            {view.stop.label}
          </button>
        ) : null}
      </div>
      {stop.line ? <ActionLine line={stop.line} wrap /> : null}
    </div>
  );
}

const glyphIcons: Readonly<Record<OperationGlyph, IconName>> = {
  globe: "globe",
  app: "app",
  plugin: "puzzle",
  list: "list",
};
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** The agent's operations as they happen, oldest first, in place of a transcript. */
export function SessionActivity({ view }: { readonly view: SessionTaskView }) {
  return (
    <section aria-label={view.header} className="session-activity">
      <p className="session-activity__header">
        <AgentMark identity={view.agent} />
        <span>{view.header}</span>
      </p>
      {view.activity.kind === "unavailable" ? (
        <p className="session-activity__empty">{workWordsUnavailable}</p>
      ) : view.activity.rows.length === 0 ? (
        <p className="session-activity__empty">{workWordsEmpty}</p>
      ) : (
        <ol className="session-activity__list">
          {view.activity.rows.map((row) => (
            <li className="session-op" key={row.id}>
              <Icon className="session-op__glyph" name={glyphIcons[row.glyph]} />
              <span className="session-op__body">
                <span className="session-op__action">{row.action}</span>
                {row.allowedBy ? <span className="session-op__by">{row.allowedBy}</span> : null}
                {row.detail ? <span className="session-op__detail">{row.detail}</span> : null}
              </span>
              <span className={`chip session-op__outcome session-op__outcome--${row.outcome.tone}`}>
                {row.outcome.label}
              </span>
              <time className="session-op__time" dateTime={row.at}>
                {timeFormat.format(new Date(row.at))}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The Request a direct operation opened, or null for any other Request. */
export function useOperationRequest(
  request: Pick<
    Request,
    | "id"
    | "status"
    | "presentation"
    | "originatingAgentSessionId"
    | "response"
    | "originatingThreadId"
  >,
): OperationRequestView | null {
  const { snapshot } = useShell();
  const slot = snapshot.agentWork?.requests?.[request.id];
  const session = agentSessionSlot(snapshot, request.originatingThreadId);
  const connection = slot?.connection ?? session?.connection;
  return operationRequestView({
    request,
    slot,
    session,
    withdrawnAt: connection ? snapshot.agentWork?.withdrawn?.[connection.id] : null,
  });
}

/**
 * A direct operation waiting on the person: the Home's question and summary, the agent's
 * own words apart and labelled, the exact calls behind one tap, and two answers.
 */
export function OperationRequestPanel({
  disabled,
  request,
  view,
}: {
  readonly disabled: boolean;
  readonly request: Request;
  readonly view: OperationRequestView;
}) {
  const { hostClient } = useShell();
  const [showCalls, setShowCalls] = useState(false);
  const answer = useAction(
    hostClient,
    {
      ...requestAnswer,
      execute: (response: RequestResponse) =>
        hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey(`request:${request.id}`),
          requestId: request.id,
          ...requestDecisionRevision(request),
          response,
          type: "request.respond",
        }),
    },
    `request:${request.id}`,
  );
  const respond = (value: string) => {
    if (!view.answers || disabled || answer.running) return;
    void answer.run({ kind: "form", answers: { [view.answers.fieldId]: [value] } });
  };
  return (
    <fieldset
      aria-label={view.listTitle}
      className="action-panel operation-request"
      data-request-id={request.id}
      disabled={disabled}
    >
      <div className="operation-request__by">
        <AgentMark identity={view.agent} />
        <strong>{view.agent.name}</strong>
      </div>
      <p className="action-panel__title">{view.question}</p>
      {view.summary ? <p className="operation-request__summary">{view.summary}</p> : null}
      {view.agentWords ? (
        <blockquote className="operation-request__says">
          <span className="operation-request__says-label">{view.agentWords.label}</span>
          <span className="operation-request__says-text">{view.agentWords.text}</span>
        </blockquote>
      ) : null}
      {view.calls ? (
        <div className="operation-request__calls">
          <button
            aria-expanded={showCalls}
            className="link-button"
            onClick={() => setShowCalls(!showCalls)}
            type="button"
          >
            {showCalls ? view.calls.hide : view.calls.show}
          </button>
          {showCalls ? <pre className="operation-request__code">{view.calls.text}</pre> : null}
        </div>
      ) : null}
      {view.answers ? (
        <>
          <div className="operation-request__answers">
            <button
              className="btn"
              disabled={answer.running}
              onClick={() => respond(view.answers!.deny.value)}
              type="button"
            >
              {view.answers.deny.label}
            </button>
            <button
              className="btn btn--primary"
              disabled={answer.running}
              onClick={() => respond(view.answers!.allow.value)}
              type="button"
            >
              {view.answers.allow.label}
            </button>
          </div>
          <p className="operation-request__after">{view.after}</p>
        </>
      ) : (
        <p className="operation-request__settled" role="status">
          {view.settled}
        </p>
      )}
      {answer.line ? <ActionLine line={answer.line} wrap /> : null}
    </fieldset>
  );
}

/** On a tab a connected agent's own task uses: who, for which task, and Stop. */
export function TabAgentStatus({
  tabId,
  occupant,
}: {
  readonly tabId: string;
  readonly occupant: { readonly threadId: string; readonly title: string } | null;
}) {
  const { snapshot } = useShell();
  const slot = occupant ? agentSessionSlot(snapshot, occupant.threadId) : null;
  const line = tabAgentLine({
    tabId,
    occupant,
    slot,
    sharedTabs: snapshot.agentWork?.sharedTabs,
    withdrawnAt: slot ? snapshot.agentWork?.withdrawn?.[slot.connection.id] : null,
  });
  const stop = useStopSession(occupant?.threadId ?? "", line?.stop?.sessionId ?? null);
  if (!line) return null;
  return (
    <div className="tab-agent-status" role="status">
      <span>{line.line}</span>
      {line.stop ? (
        <button
          className="btn btn--small"
          disabled={stop.running}
          onClick={() => void stop.run(undefined)}
          type="button"
        >
          <Icon name="stop" />
          {workWords("tab.stop")}
        </button>
      ) : null}
    </div>
  );
}

const workWordsUnavailable = workWords("work.activityUnavailable");
const workWordsEmpty = workWords("work.activityEmpty");

/** A Needs you entry for a connected agent's direct operation, or null for anything else. */
export function useNeedsYouOperation(entry: NeedsYouEntry): OperationRequestView | null {
  const snapshot = useOptionalShell()?.snapshot;
  if (!snapshot || entry.kind !== "request") return null;
  const { request } = entry;
  const slot = snapshot.agentWork?.requests?.[request.id];
  const session = agentSessionSlot(snapshot, request.originatingThreadId);
  return operationRequestView({ request, slot, session });
}

/**
 * A connected agent's own task's row in Tasks, or null for any other task. It selects only
 * this task's facts, so a row redraws only when they change.
 */
export function useSessionTaskRow(hostClient: HostClient, threadId: string) {
  const slot = useHostSelector(
    hostClient,
    useCallback((current) => agentSessionSlot(current, threadId), [threadId]),
  );
  const key = useHostSelector(
    hostClient,
    useCallback(
      (current) => {
        const thread = threadInDirectory(threadId, current);
        return thread ? `${thread.status}|${thread.agentSessionId ?? ""}` : null;
      },
      [threadId],
    ),
  );
  return useMemo(() => {
    if (key === null) return null;
    const [status, agentSessionId] = key.split("|") as [ThreadStatus, string];
    return sessionTaskRow({
      thread: { status, agentSessionId: agentSessionId || null },
      slot,
    });
  }, [key, slot]);
}
