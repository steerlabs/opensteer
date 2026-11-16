import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { useComputerAppApproval as useOwnerComputerAppApproval } from "@opensteer/client/react";
import {
  computerAppApprovalSecretFields,
  localMcpSecretsToSend,
  type ComputerAppApprovalReview,
  type ComputerAppApprovalView,
} from "@opensteer/client/integrations";
import type { HostClient } from "@opensteer/client/host";
import { useId, useState } from "react";
import { AppMark } from "./app-icons.js";
import { LocalMcpSecretFields } from "./local-mcp-secret-fields.js";

/** Details live only while this owner is reviewing; no native approval bridge. */
export function useComputerAppApproval(hostClient: HostClient) {
  const { ask, review, view, error, busy, close, answer } = useOwnerComputerAppApproval(hostClient);
  const dialog =
    review && view ? (
      <ApprovalDialog
        // A new review starts with empty fields.
        key={review.request.id}
        answer={answer}
        busy={busy}
        close={close}
        error={error}
        review={review}
        view={view}
      />
    ) : null;
  return { ask, dialog };
}

function ApprovalDialog(props: {
  readonly answer: (
    decision: "allow" | "deny",
    secrets?: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly busy: boolean;
  readonly close: () => void;
  readonly error: string | null;
  readonly review: ComputerAppApprovalReview;
  readonly view: ComputerAppApprovalView;
}) {
  const { view } = props;
  const titleId = useId();
  const fields = computerAppApprovalSecretFields(props.review);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [invalid, setInvalid] = useState<string | null>(null);
  const allow = () => {
    const entered = localMcpSecretsToSend(fields, values);
    if (!entered.ok) {
      setInvalid(entered.message);
      return;
    }
    setInvalid(null);
    void props.answer("allow", entered.secrets);
  };
  const error = invalid ?? props.error;
  return (
    <Dialog
      footer={
        <>
          {error ? (
            <p className="form-actions__error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="btn btn--ghost"
            disabled={props.busy}
            onClick={() => void props.answer("deny")}
            type="button"
          >
            Don't allow
          </button>
          <button className="btn btn--primary" disabled={props.busy} onClick={allow} type="button">
            Allow
          </button>
        </>
      }
      labelledBy={titleId}
      narrow
      onClose={props.close}
      title={
        <span className="app-approval__head">
          <ApprovalMark view={view} />
          <span className="app-approval__heading">
            <span className="app-approval__title">{view.title}</span>
            {view.context ? <span className="app-approval__context">{view.context}</span> : null}
          </span>
        </span>
      }
    >
      <ul className="app-approval__abilities">
        {view.abilities.map((ability) => (
          <li
            className={ability.allowed ? undefined : "app-approval__ability--denied"}
            key={ability.text}
          >
            <Icon name={ability.allowed ? "check" : "close"} />
            {ability.text}
          </li>
        ))}
      </ul>
      {view.warning ? (
        <p className="notice notice--warn app-approval__warning">
          <Icon name="alert-circle" />
          {view.warning}
        </p>
      ) : null}
      <LocalMcpSecretFields
        disabled={props.busy}
        fields={fields}
        onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
        values={values}
      />
      {view.details ? (
        <details className="app-approval__details">
          <summary>
            <Icon name="chevron-right" />
            {view.details.label}
          </summary>
          <pre>{view.details.text}</pre>
        </details>
      ) : null}
    </Dialog>
  );
}

function ApprovalMark({ view }: { readonly view: ComputerAppApprovalView }) {
  return (
    <span className="app-approval__mark">
      {view.app ? (
        <AppMark identity={view.app} machineId={view.runnerId} />
      ) : (
        <span className="intg-icon">
          <Icon name={view.mark === "plugin" ? "puzzle" : "app"} />
        </span>
      )}
    </span>
  );
}

export function ComputerSetupApprovals(props: {
  readonly hostClient: HostClient;
  readonly requests: readonly import("@opensteer/client/integrations").ComputerAppSetupSummary[];
  readonly onChanged: () => Promise<void>;
  /** A line under each approval's name, where the name alone would not say what it asks. */
  readonly detail?: (
    request: import("@opensteer/client/integrations").ComputerAppSetupSummary,
  ) => string;
}) {
  const approval = useComputerAppApproval(props.hostClient);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function review(id: string) {
    setBusy(id);
    setError(null);
    try {
      await approval.ask(id);
      await props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't review this approval.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      {approval.dialog}
      {props.requests.map((request) => (
        <div className="card__row" key={request.id}>
          <span className="card__row-body">
            {props.detail ? (
              <>
                <span className="card__row-title">
                  {request.server?.installationTitle ?? request.definitionId}
                </span>
                <span className="card__row-detail">{props.detail(request)}</span>
              </>
            ) : (
              (request.server?.name ??
              request.app?.displayName ??
              (request.kind === "policy" ? "Automatic app approval" : request.definitionId))
            )}
          </span>
          <button
            className="btn btn--small"
            disabled={busy !== null}
            onClick={() => void review(request.id)}
            type="button"
          >
            Review
          </button>
        </div>
      ))}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
