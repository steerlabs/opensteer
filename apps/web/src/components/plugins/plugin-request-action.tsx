import { useState } from "react";
import type { Request, RequestResponse } from "@opensteer/core";
import {
  pluginAuthorText,
  pluginConsentLines,
  pluginInputContent,
  pluginRequestResponses,
  pluginRequestView,
  respondToPluginRequest,
  type PluginRequestView,
} from "@opensteer/client/plugins";
import { integrationRequestStillPending } from "@opensteer/client/integrations";
import { ActionLine } from "../action-line.js";
import { requestAnswer, useAction } from "../use-action.js";
import { ActionNote } from "../action-rows.js";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { PluginConnectDialog } from "./plugin-connect.js";
import { PluginFormFields } from "./plugin-form-fields.js";

/**
 * The card for `plugin.account`, `plugin.approval` and `plugin.input`, the
 * same in a task and in Needs you. Answers go through the ordinary Request
 * reply; an account is answered by linking one.
 */
export function ThreadPluginAction({
  disabled,
  request,
}: {
  readonly disabled: boolean;
  readonly request: Request;
}) {
  const view = pluginRequestView(request);
  if (!view) return <ActionNote>This Request needs a newer Opensteer to answer.</ActionNote>;
  return (
    <>
      <p className="plugin-request__who">
        <Icon name="puzzle" />
        {view.plugin.name} · {pluginAuthorText(view.plugin.author)}
      </p>
      {view.kind === "account" ? (
        <AccountAction disabled={disabled} request={request} view={view} />
      ) : view.kind === "approval" ? (
        <ApprovalAction disabled={disabled} request={request} view={view} />
      ) : (
        <InputAction disabled={disabled} request={request} view={view} />
      )}
    </>
  );
}

function useRespond(request: Request) {
  const { hostClient } = useShell();
  const [pending, setPending] = useState<string | null>(null);
  const action = useAction(
    hostClient,
    {
      ...requestAnswer,
      execute: async (response: RequestResponse) => {
        await respondToPluginRequest(hostClient, request, response);
      },
      reconcile: async () =>
        (await integrationRequestStillPending(hostClient, request.originatingThreadId, request.id))
          ? null
          : { kind: "confirmed", value: undefined },
    },
    request.id,
  );
  const respond = (key: string, response: RequestResponse) => {
    if (pending) return;
    setPending(key);
    void action.run(response).finally(() => setPending(null));
  };
  return {
    pending,
    respond,
    line: action.line ? <ActionLine line={action.line} wrap /> : null,
  };
}

function AccountAction({
  disabled,
  request,
  view,
}: {
  readonly disabled: boolean;
  readonly request: Request;
  readonly view: Extract<PluginRequestView, { kind: "account" }>;
}) {
  const { pending, respond, line } = useRespond(request);
  const [connecting, setConnecting] = useState(false);
  const [target] = useState(view.target);
  return (
    <>
      <ul className="plugin-consent__lines">
        {pluginConsentLines({
          consent: view.consent,
          author: view.plugin.author,
          pluginName: view.plugin.name,
          providerName: null,
        })
          // The Request's own detail already says what linking trusts.
          .filter((line) => line.key === "sites" || line.key === "credential")
          .map((line) => (
            <li className="plugin-consent__line" key={line.key}>
              <span>{line.text}</span>
            </li>
          ))}
      </ul>
      <div className="action-buttons">
        <button
          className="btn btn--ghost"
          disabled={disabled || pending !== null}
          onClick={() => respond("decline", pluginRequestResponses.accountDeclined)}
          type="button"
        >
          {pending ? "Declining…" : "Decline"}
        </button>
        <button
          className="btn btn--primary"
          disabled={disabled || pending !== null}
          onClick={() => setConnecting(true)}
          type="button"
        >
          Connect account
        </button>
      </div>
      {line}
      {connecting ? (
        <PluginConnectDialog
          onClose={() => setConnecting(false)}
          onLinked={() => setConnecting(false)}
          target={target}
        />
      ) : null}
    </>
  );
}

function ApprovalAction({
  disabled,
  request,
  view,
}: {
  readonly disabled: boolean;
  readonly request: Request;
  readonly view: Extract<PluginRequestView, { kind: "approval" }>;
}) {
  const { pending, respond, line } = useRespond(request);
  return (
    <>
      <p className="plugin-request__tool">
        Runs <code>{view.tool}</code> with exactly:
      </p>
      <pre className="plugin-arguments" tabIndex={0}>
        {view.argumentsText}
      </pre>
      <div className="action-buttons">
        <button
          className="btn btn--ghost"
          disabled={disabled || pending !== null}
          onClick={() => respond("decline", pluginRequestResponses.decline)}
          type="button"
        >
          {pending === "decline" ? "Declining…" : "Decline"}
        </button>
        <button
          className="btn btn--primary"
          disabled={disabled || pending !== null}
          onClick={() => respond("approve", pluginRequestResponses.approve)}
          type="button"
        >
          {pending === "approve" ? "Approving…" : "Allow once"}
        </button>
      </div>
      {line}
    </>
  );
}

function InputAction({
  disabled,
  request,
  view,
}: {
  readonly disabled: boolean;
  readonly request: Request;
  readonly view: Extract<PluginRequestView, { kind: "input" }>;
}) {
  const { pending, respond, line } = useRespond(request);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const content = pluginInputContent(view.form, answers);
  return (
    <>
      <ActionNote>Only this plugin receives your answer. The agent never sees it.</ActionNote>
      <PluginFormFields
        answers={answers}
        disabled={disabled || pending !== null}
        form={view.form}
        onChange={setAnswers}
      />
      <div className="action-buttons">
        <button
          className="btn btn--ghost"
          disabled={disabled || pending !== null}
          onClick={() => respond("decline", pluginRequestResponses.inputDeclined)}
          type="button"
        >
          {pending === "decline" ? "Declining…" : "Decline"}
        </button>
        <button
          className="btn btn--primary"
          disabled={disabled || pending !== null || "problem" in content}
          onClick={() =>
            "content" in content && respond("send", pluginRequestResponses.input(content.content))
          }
          title={"problem" in content ? content.problem : undefined}
          type="button"
        >
          {pending === "send" ? "Sending…" : "Send"}
        </button>
      </div>
      {line}
    </>
  );
}
