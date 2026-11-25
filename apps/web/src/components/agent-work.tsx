import {
  accessModeOptions,
  isolatedPlainSentence,
  sessionSlotFromHome,
  agentSessionSlot,
  mutationIdempotencyKey,
  operationRequestView,
  requestDecision,
  requestsWaitingOn,
  sessionAgent,
  sessionAgentPart,
  sessionTaskView,
  tabAgentLine,
  tabNeedsYouParts,
  threadInDirectory,
  type OperationGlyph,
  type OperationRequestView,
  type RequestView,
  type HostClient,
  type SessionTaskView,
  workSentence,
  workWords,
} from "@opensteer/client/host";
import { useHostSelector, useTaskActivity } from "@opensteer/client/react";
import { requestTitleText, type Request, type RequestResponse } from "@opensteer/core";
import type { NeedsYouEntry } from "@opensteer/protocol";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { ActionLine } from "./action-line.js";
import { useOptionalShell, useShell } from "./app-shell.js";
import { Icon, type IconName } from "./icon.js";
import { SentenceText } from "../ui/address-text.js";
import { AgentMark } from "./settings/agent-mark.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";
import { requestAnswer, useAction } from "./use-action.js";

/** The view for a connected agent's own task, or null for any other task. */
export function useSessionTask(hostClient: HostClient, threadId: string): SessionTaskView | null {
  const thread = useHostSelector(
    hostClient,
    useCallback((current) => threadInDirectory(threadId, current), [threadId]),
  );
  const operations = useTaskActivity(
    hostClient,
    threadId,
    thread?.externalWork
      ? `${thread.updatedAt}|${thread.status}|${thread.externalWork.status}`
      : null,
  );
  if (!thread) return null;
  const slot = sessionSlotFromHome(thread.externalWork, operations);
  return sessionTaskView({
    thread: { status: thread.status, agentSessionId: thread.agentSessionId ?? null },
    slot,
  });
}

/** Ends this agent's session on this task, bound to the session the person saw. */
export function stopSessionAction(hostClient: HostClient, threadId: string, sessionId: string) {
  return {
    label: "stop this agent",
    done: "stopped",
    happened: "this agent was stopped",
    execute: () =>
      hostClient.dispatch({
        type: "agent.session.stop",
        threadId,
        agentSessionId: sessionId,
        idempotencyKey: mutationIdempotencyKey(`agent-session-stop:${sessionId}`),
      }),
  };
}

export function useStopSession(threadId: string, sessionId: string | null) {
  const { hostClient } = useShell();
  return useAction(
    hostClient,
    stopSessionAction(hostClient, threadId, sessionId!),
    `agent-session-stop:${sessionId ?? ""}`,
  );
}

/** Watch a session in its existing task view, or focus its Request when reviewing it there. */
export function useOpenSessionTask() {
  const workspace = useOptionalWorkspace();
  const navigate = useNavigate();
  return (
    threadId: string,
    waiting?: {
      readonly request: Pick<Request, "id" | "originatingThreadId">;
      readonly presentation?: { readonly threadId: string } | null | undefined;
    } | null,
  ) => {
    const id = waiting?.presentation?.threadId ?? waiting?.request.originatingThreadId ?? threadId;
    if (workspace) {
      workspace.nav.openConversation(
        workspace.nav.threadPath(id),
        waiting ? { focusRequest: waiting.request.id } : undefined,
      );
    } else {
      void navigate(`/tasks/${encodeURIComponent(id)}`);
    }
  };
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
          <span className="session-bar__status">
            <SentenceText parts={view.statusLineParts} />
          </span>
          <span className="session-bar__note">
            <SentenceText parts={view.noComposerParts} />
          </span>
        </span>
        {view.stop ? (
          <button
            className="btn btn--small session-bar__stop"
            disabled={stop.running}
            onClick={() => void stop.run(undefined)}
            title={isolatedPlainSentence(view.stop.detailParts)}
            type="button"
          >
            <Icon name="stop" />
            <SentenceText parts={view.stop.labelParts} />
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
export function SessionActivity({
  view,
  showIdentity = true,
  showMode = false,
}: {
  readonly view: SessionTaskView;
  readonly showIdentity?: boolean;
  readonly showMode?: boolean;
}) {
  return (
    <section aria-label={view.header} className="session-activity">
      {showIdentity ? (
        <p className="session-activity__header">
          <AgentMark identity={view.agent} />
          <span>{view.header}</span>
        </p>
      ) : null}
      {view.activity.kind === "unavailable" ? (
        <p className="session-activity__empty">{workWordsUnavailable}</p>
      ) : view.activity.rows.length === 0 ? (
        <p className="session-activity__empty">{workWordsEmpty}</p>
      ) : (
        <ol className="session-activity__list">
          {view.activity.rows.map((row) => {
            const mode = showMode
              ? accessModeOptions.find((option) => option.mode === row.mode)?.label
              : null;
            return (
              <li className="session-op" key={row.id}>
                <Icon className="session-op__glyph" name={glyphIcons[row.glyph]} />
                <span className="session-op__body">
                  <span className="session-op__action">{row.action}</span>
                  {mode ? <span className="session-op__by">{mode}</span> : null}
                  {row.allowedBy && row.allowedBy !== mode ? (
                    <span className="session-op__by">{row.allowedBy}</span>
                  ) : null}
                  {row.detail ? <span className="session-op__detail">{row.detail}</span> : null}
                </span>
                <span
                  className={`chip session-op__outcome session-op__outcome--${row.outcome.tone}`}
                >
                  {row.outcome.label}
                </span>
                <time className="session-op__time" dateTime={row.at}>
                  {timeFormat.format(new Date(row.at))}
                </time>
              </li>
            );
          })}
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
    | "agentOperation"
    | "originatingThreadId"
  >,
): OperationRequestView | null {
  const { hostClient } = useShell();
  const work = useHostSelector(
    hostClient,
    useCallback(
      (current) => threadInDirectory(request.originatingThreadId, current)?.externalWork,
      [request.originatingThreadId],
    ),
  );
  return operationRequestView({
    request,
    session: sessionSlotFromHome(work),
  });
}

/**
 * A direct operation waiting on the person: the Home's question and where it acts, the agent's
 * own words apart and labelled, the exact calls behind one tap, and two answers.
 */
export function OperationRequestPanel({
  disabled,
  request,
  view,
}: {
  readonly disabled: boolean;
  readonly request: RequestView;
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
          ...requestDecision(request),
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
      aria-label={isolatedPlainSentence(view.listTitleParts)}
      className="action-panel operation-request"
      data-request-id={request.id}
      disabled={disabled}
    >
      <div className="operation-request__by">
        <AgentMark identity={view.agent} />
        <strong>{view.agent.name}</strong>
      </div>
      <p className="action-panel__title">{view.question}</p>
      {(view.context ?? view.summary) ? (
        <p className="operation-request__summary">{view.context ?? view.summary}</p>
      ) : null}
      {view.agentWords ? (
        <blockquote className="operation-request__says">
          <span className="operation-request__says-label">
            <SentenceText parts={view.agentWords.labelParts} />
          </span>
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
          <p className="operation-request__after">
            <SentenceText parts={view.afterParts} />
          </p>
        </>
      ) : (
        <p className="operation-request__settled" role="status">
          {view.settledParts ? <SentenceText parts={view.settledParts} /> : null}
        </p>
      )}
      {answer.line ? <ActionLine line={answer.line} wrap /> : null}
    </fieldset>
  );
}

/**
 * On a tab a connected agent's own task uses: who, for which task, and Stop. While the task
 * waits on the person, Answer back to the Request in the task stands beside that Stop.
 */
export function TabAgentStatus({
  tabId,
  occupant,
}: {
  readonly tabId: string;
  readonly occupant: { readonly threadId: string; readonly title: string } | null;
}) {
  const { snapshot } = useShell();
  const workspace = useOptionalWorkspace();
  const slot = occupant ? agentSessionSlot(snapshot, occupant.threadId) : null;
  const line = tabAgentLine({
    occupant,
    slot,
    sharedFromChrome: snapshot.tabs.get(tabId)?.sharedByPerson !== undefined,
  });
  const stop = useStopSession(occupant?.threadId ?? "", line?.stop?.sessionId ?? null);
  if (!line) return null;
  const waiting =
    occupant && line.stop ? requestsWaitingOn(snapshot.waitingRequests, occupant.threadId) : [];
  const asked = waiting[0]?.request ?? null;
  const needsYou = isolatedPlainSentence(tabNeedsYouParts(slot?.connection));
  return (
    <div className={`tab-agent-status${asked ? " tab-agent-status--needs-you" : ""}`} role="status">
      <span>
        <SentenceText parts={line.lineParts} />
      </span>
      {asked && occupant && workspace ? (
        <button
          aria-label={`${needsYou}. ${workWords("tab.answer")}`}
          className="btn btn--small btn--primary"
          onClick={() =>
            workspace.nav.openConversation(workspace.nav.threadPath(occupant.threadId), {
              focusRequest: asked.id,
            })
          }
          title={needsYou}
          type="button"
        >
          {workWords("tab.answer")}
        </button>
      ) : null}
      {/* A question waiting takes nothing from the row: Stop stays beside Answer. */}
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

/** Name both a direct approval and a question the connected agent asked. */
export function useNeedsYouAgentRequest(entry: NeedsYouEntry) {
  const snapshot = useOptionalShell()?.snapshot;
  if (!snapshot || entry.kind !== "request") return null;
  const { request } = entry;
  const session = agentSessionSlot(snapshot, request.originatingThreadId);
  const operation = operationRequestView({ request, session });
  if (!operation && (!session || session.sessionId !== request.originatingAgentSessionId))
    return null;
  const agent = operation?.agent ?? sessionAgent(session?.connection);
  const presentation = request.presentation;
  const prompt =
    request.kind === "person.question" &&
    presentation.kind === "form" &&
    presentation.fields.length === 1
      ? presentation.fields[0]?.prompt.trim()
      : null;
  const question = operation?.question ?? (prompt || requestTitleText(presentation));
  return {
    agent,
    listTitleParts: agent.who?.verified
      ? workSentence("ask.listTitle", { agent: agent.name }, { question })
      : workSentence("ask.title", { agent: sessionAgentPart(agent) }, { question }),
  };
}
