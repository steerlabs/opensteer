import {
  commandApproval,
  commandApproveArmMs,
  commandDecline,
  commandDoneMyself,
  commandRequestView,
  commandRequestWords,
  mutationIdempotencyKey,
  type CommandRequestView,
  type RequestView,
} from "@opensteer/client/host";
import type { CommandRequestOutcome } from "@opensteer/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ActionLine } from "./action-line.js";
import { useShell } from "./app-shell.js";
import { requestAnswer, useAction } from "./use-action.js";

const approveAction = {
  label: "approve it",
  done: "approved",
  happened: "your approval was sent",
} as const;

/** Where each screen that performs a command is, in this app. */
const screenPaths: Readonly<Record<string, string>> = {
  "account-link": "/settings/account",
  "add-device": "/settings/devices",
  "ai-engines": "/settings/ai",
  automation: "/automations",
  "browser-profiles": "/settings/sign-ins/browsers",
  chrome: "/settings/sign-ins/chrome",
  "connected-agent": "/settings/external-agents",
  "device-access": "/settings/devices",
  "device-apps": "/settings/devices",
  "general-settings": "/settings/general",
  messaging: "/settings/messaging",
  plugin: "/settings/plugins",
  "remote-access": "/settings/devices",
};

/**
 * What an agent proposed, all of it: the Home's sentence, who asked, every argument of the
 * command whole with what the Home knows beside it, the agent's words kept as its own, then
 * Approve or Decline. The sentence and the buttons stay in view while the arguments scroll;
 * Approve waits until the arguments were seen to their end and for a moment after the card
 * appears, so a click meant for something else never approves it. After Approve it says what the
 * command came to.
 */
export function CommandRequestPanel({
  disabled,
  request,
  view,
}: {
  readonly disabled: boolean;
  readonly request: RequestView;
  readonly view: CommandRequestView;
}) {
  const { hostClient } = useShell();
  const navigate = useNavigate();
  const [outcome, setOutcome] = useState<CommandRequestOutcome | null>(null);
  const shownRevision = `${request.id}:${request.reviewedRevision ?? ""}`;
  // One approval of this card as shown: a retry after a lost answer is the same approval.
  const approvalKey = useMemo(
    () => mutationIdempotencyKey(`command-approve:${shownRevision}`),
    [shownRevision],
  );
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    const timer = setTimeout(() => setArmed(true), commandApproveArmMs);
    return () => clearTimeout(timer);
  }, [shownRevision]);
  const rows = useRef<HTMLDListElement>(null);
  const [seenEnd, setSeenEnd] = useState(false);
  const check = useCallback(() => {
    const list = rows.current;
    if (list && list.scrollTop + list.clientHeight >= list.scrollHeight - 2) setSeenEnd(true);
  }, []);
  useLayoutEffect(() => {
    setSeenEnd(false);
    check();
  }, [shownRevision, check]);
  const approve = useAction(
    hostClient,
    {
      ...approveAction,
      execute: async () => {
        const result = (await hostClient.dispatch(commandApproval(request, approvalKey))) as {
          readonly outcome?: CommandRequestOutcome;
        };
        if (result.outcome) setOutcome(result.outcome);
        return result;
      },
    },
    `command-approve:${request.id}`,
  );
  const answer = useAction(
    hostClient,
    {
      ...requestAnswer,
      execute: (done: boolean) =>
        hostClient.dispatch(
          (done ? commandDoneMyself : commandDecline)(
            request,
            mutationIdempotencyKey(`request:${request.id}`),
          ),
        ),
    },
    `request:${request.id}`,
  );
  // What the approval came to, as soon as the Home answers it, before the Request is read again.
  const shown = outcome
    ? commandRequestView({
        ...request,
        status: "fulfilled",
        command: { ...request.command!, outcome },
      })!
    : view;
  const busy = disabled || approve.running || answer.running;
  const ready = armed && seenEnd;
  const screen = shown.personOnly?.screen;
  const triggerId = (request.command?.command as { readonly triggerId?: unknown } | undefined)
    ?.triggerId;
  const screenPath =
    screen?.id === "automation-secrets" && typeof triggerId === "string"
      ? `/automations/${encodeURIComponent(triggerId)}#secrets`
      : screen
        ? screenPaths[screen.id]
        : undefined;
  return (
    <fieldset
      aria-label={shown.sentence}
      className="action-panel operation-request command-request"
      data-request-id={request.id}
      disabled={disabled}
    >
      <p className="action-panel__title">{shown.sentence}</p>
      <p className="operation-request__summary">{shown.askedBy}</p>
      {shown.gives ? <p className="command-request__gives">{shown.gives}</p> : null}
      <p className="command-request__heading">{shown.rowsHeading}</p>
      <dl
        aria-label={shown.rowsHeading}
        className="command-request__rows"
        onScroll={check}
        ref={rows}
        tabIndex={0}
      >
        {shown.rows.map((row, index) => (
          <div
            className="command-request__row"
            data-depth={row.depth}
            data-path={row.path}
            key={`${index}:${row.path}`}
            style={{ paddingInlineStart: `${row.depth * 12}px` }}
          >
            <dt className="command-request__label">{row.label}</dt>
            {row.value === null ? null : (
              <dd className="command-request__value">
                <span className="command-request__proposed">{row.value}</span>
                {row.name ? <span className="command-request__name">{row.name}</span> : null}
              </dd>
            )}
            {row.current === null ? null : (
              <dd className="command-request__current">
                <span className="command-request__now">{commandRequestWords.now}</span>
                <span className="command-request__proposed">{row.current}</span>
              </dd>
            )}
          </div>
        ))}
      </dl>
      {seenEnd ? null : (
        <p className="command-request__more" role="note">
          {commandRequestWords.more}
        </p>
      )}
      {shown.agentWords ? (
        <blockquote className="operation-request__says">
          <span className="operation-request__says-label">{shown.agentWords.label}</span>
          <span className="operation-request__says-text">{shown.agentWords.text}</span>
        </blockquote>
      ) : null}
      <p
        className="operation-request__after"
        role={shown.approve || shown.doneMyself ? undefined : "status"}
      >
        {shown.line}
      </p>
      {shown.decline ? (
        <div className="operation-request__answers">
          {screen && screenPath ? (
            <button className="btn" onClick={() => navigate(screenPath)} type="button">
              {`Open ${screen.label}`}
            </button>
          ) : null}
          <button
            className="btn"
            disabled={busy}
            onClick={() => void answer.run(false)}
            type="button"
          >
            {shown.decline.label}
          </button>
          {shown.doneMyself ? (
            <button
              className="btn"
              disabled={busy}
              onClick={() => void answer.run(true)}
              type="button"
            >
              {shown.doneMyself.label}
            </button>
          ) : null}
          {shown.approve ? (
            <button
              aria-disabled={!ready}
              className="btn btn--primary"
              disabled={busy || !ready}
              onClick={() => {
                if (ready) void approve.run();
              }}
              type="button"
            >
              {shown.approve.label}
            </button>
          ) : null}
        </div>
      ) : null}
      {approve.line ? <ActionLine line={approve.line} wrap /> : null}
      {answer.line ? <ActionLine line={answer.line} wrap /> : null}
    </fieldset>
  );
}
