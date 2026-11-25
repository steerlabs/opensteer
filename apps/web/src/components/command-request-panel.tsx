import {
  commandApproval,
  commandApproveArmMs,
  commandDecline,
  commandDoneMyself,
  commandRequestView,
  commandRequestWords,
  HostClientRequestError,
  mutationIdempotencyKey,
  type CommandRequestView,
  type RequestView,
} from "@opensteer/client/host";
import type { CommandRequestOutcome } from "@opensteer/core";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ActionLine } from "./action-line.js";
import { useShell } from "./app-shell.js";
import { Refusal, requestAnswer, useAction } from "./use-action.js";

const approveAction = {
  label: "approve it",
  done: "approved",
  happened: "your approval was sent",
} as const;

/** The Home's refusals of an approval that say why, in its own words. */
const saidReasons = new Set([
  "request-changed",
  "command-changed",
  "proposer-gone",
  "command-needs-person-screen",
]);

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
 * Approve or Decline. The sentence and the buttons stay in view while everything else scrolls
 * inside the card. Approve waits until the arguments were seen to their end and for a moment
 * after this revision of the card appears, so a click meant for something else never approves
 * it; a new revision starts at its top, unarmed. After Approve it says what the command came to.
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
  const identity = view.identity;
  const notesId = useId();
  // Every local fact of the card is this revision's own: a new one reads none of the last.
  const [result, setResult] = useState<{
    readonly identity: string;
    readonly outcome: CommandRequestOutcome;
  } | null>(null);
  const [armedFor, setArmedFor] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setArmedFor(identity), commandApproveArmMs);
    return () => clearTimeout(timer);
  }, [identity]);
  const armed = armedFor === identity;
  const scroller = useRef<HTMLDivElement>(null);
  const [seenFor, setSeenFor] = useState<string | null>(null);
  const check = useCallback(() => {
    const list = scroller.current;
    if (list && list.scrollTop + list.clientHeight >= list.scrollHeight - 2) setSeenFor(identity);
  }, [identity]);
  useLayoutEffect(() => {
    // A new revision starts at its top; one short enough to show whole is seen at once.
    if (scroller.current) scroller.current.scrollTop = 0;
    check();
  }, [identity, check]);
  const seenEnd = seenFor === identity;
  const approve = useAction(
    hostClient,
    {
      ...approveAction,
      execute: async () => {
        try {
          const answered = (await hostClient.dispatch(commandApproval(request))) as {
            readonly outcome?: CommandRequestOutcome;
          };
          if (answered.outcome) setResult({ identity, outcome: answered.outcome });
          return answered;
        } catch (error) {
          // The Home's own reason, as it said it: changed since it was read, or no longer asked.
          if (error instanceof HostClientRequestError && saidReasons.has(error.reason ?? ""))
            throw new Refusal(error.message);
          throw error;
        }
      },
    },
    `command-approve:${identity}`,
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
  const shown =
    result?.identity === identity
      ? commandRequestView({
          ...request,
          status: "fulfilled",
          command: { ...request.command!, outcome: result.outcome },
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
      <div
        className="command-request__scroll"
        onScroll={check}
        ref={scroller}
        role="region"
        aria-label={shown.rowsHeading}
        tabIndex={0}
      >
        {shown.gives ? <p className="command-request__gives">{shown.gives}</p> : null}
        {shown.personOnly ? (
          <p className="command-request__gives">
            {commandRequestWords.needs}: {shown.personOnly.needs}
          </p>
        ) : null}
        {shown.agentWords ? (
          <blockquote className="operation-request__says">
            <span className="operation-request__says-label">{shown.agentWords.label}</span>
            <span className="operation-request__says-text">{shown.agentWords.text}</span>
          </blockquote>
        ) : null}
        <p className="command-request__heading">{shown.rowsHeading}</p>
        <dl className="command-request__rows">
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
                  {row.meaning ? (
                    <span className="command-request__name">{row.meaning}</span>
                  ) : null}
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
      </div>
      {shown.approve && !seenEnd ? (
        <p className="command-request__more" id={`${notesId}-more`}>
          {commandRequestWords.more}
        </p>
      ) : null}
      {shown.approve && !armed ? (
        <p className="command-request__more" id={`${notesId}-arming`}>
          {commandRequestWords.arming}
        </p>
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
            <button className="btn" onClick={() => void navigate(screenPath)} type="button">
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
              aria-describedby={
                [!seenEnd ? `${notesId}-more` : null, !armed ? `${notesId}-arming` : null]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
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
