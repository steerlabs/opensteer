import {
  commandApproval,
  commandDecline,
  commandRequestView,
  commandRequestWords,
  mutationIdempotencyKey,
  type CommandRequestView,
  type RequestView,
} from "@opensteer/client/host";
import type { CommandRequestOutcome } from "@opensteer/core";
import { useState } from "react";
import { ActionLine } from "./action-line.js";
import { useShell } from "./app-shell.js";
import { requestAnswer, useAction } from "./use-action.js";

const approveAction = {
  label: "approve it",
  done: "approved",
  happened: "your approval was sent",
} as const;

/**
 * What an agent proposed, all of it: the Home's sentence, who asked, the agent's words kept as
 * its own, every argument of the command whole with what the Home knows beside it, then Approve
 * or Decline. After Approve it says what the command came to.
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
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<CommandRequestOutcome | null>(null);
  const approve = useAction(
    hostClient,
    {
      ...approveAction,
      execute: async () => {
        const result = (await hostClient.dispatch(
          commandApproval(request, mutationIdempotencyKey(`command-approve:${request.id}`), typed),
        )) as { readonly outcome?: CommandRequestOutcome };
        if (result.outcome) setOutcome(result.outcome);
        return result;
      },
    },
    `command-approve:${request.id}`,
  );
  const decline = useAction(
    hostClient,
    {
      ...requestAnswer,
      execute: () =>
        hostClient.dispatch(
          commandDecline(request, mutationIdempotencyKey(`request:${request.id}`)),
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
  const busy = disabled || approve.running || decline.running;
  const missing = shown.secrets.some(({ path }) => !typed[path]);
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
      <dl className="command-request__rows" aria-label="The change, as proposed">
        {shown.rows.map((row) => (
          <div
            className="command-request__row"
            data-depth={row.depth}
            data-path={row.path}
            key={row.path}
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
      {shown.agentWords ? (
        <blockquote className="operation-request__says">
          <span className="operation-request__says-label">{shown.agentWords.label}</span>
          <span className="operation-request__says-text">{shown.agentWords.text}</span>
        </blockquote>
      ) : null}
      {shown.approve
        ? shown.secrets.map((secret) => (
            <label className="command-request__secret" key={secret.path}>
              <span>
                {secret.label} · {commandRequestWords.secret}
              </span>
              <input
                autoComplete="off"
                onChange={(event) => setTyped({ ...typed, [secret.path]: event.target.value })}
                type="password"
                value={typed[secret.path] ?? ""}
              />
            </label>
          ))
        : null}
      <p className="operation-request__after" role={shown.approve ? undefined : "status"}>
        {shown.line}
      </p>
      {shown.approve && shown.decline ? (
        <div className="operation-request__answers">
          <button className="btn" disabled={busy} onClick={() => void decline.run()} type="button">
            {shown.decline.label}
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || missing}
            onClick={() => void approve.run()}
            type="button"
          >
            {shown.approve.label}
          </button>
        </div>
      ) : null}
      {approve.line ? <ActionLine line={approve.line} wrap /> : null}
      {decline.line ? <ActionLine line={decline.line} wrap /> : null}
    </fieldset>
  );
}
