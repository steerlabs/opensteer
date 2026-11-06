import { Dialog } from "../dialog.js";
import { useComputerAppApproval as useOwnerComputerAppApproval } from "@opensteer/client/react";
import {
  computerAppApprovalDetails,
  computerAppApprovalSecretFields,
  localMcpSecretsToSend,
  type ComputerAppApprovalReview,
} from "@opensteer/client/integrations";
import type { HostClient } from "@opensteer/client/host";
import { useState } from "react";
import { LocalMcpSecretFields } from "./local-mcp-secret-fields.js";

/** Details live only while this owner is reviewing; no native approval bridge. */
export function useComputerAppApproval(hostClient: HostClient) {
  const { ask, review, error, busy, close, answer } = useOwnerComputerAppApproval(hostClient);
  const dialog = review ? (
    <ApprovalDialog
      // A new review starts with empty fields.
      key={review.request.id}
      answer={answer}
      busy={busy}
      close={close}
      error={error}
      review={review}
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
}) {
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
    <Dialog title="Allow agent access?" onClose={props.close}>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          maxHeight: "60vh",
          overflowY: "auto",
        }}
      >
        {computerAppApprovalDetails(props.review)}
      </pre>
      <LocalMcpSecretFields
        disabled={props.busy}
        fields={fields}
        onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
        values={values}
      />
      {error ? <p role="alert">{error}</p> : null}
      <div className="form-actions">
        <button
          className="btn"
          disabled={props.busy}
          onClick={() => void props.answer("deny")}
          type="button"
        >
          Don't allow
        </button>
        <button className="btn btn--primary" disabled={props.busy} onClick={allow} type="button">
          Allow
        </button>
      </div>
    </Dialog>
  );
}

export function ComputerSetupApprovals(props: {
  readonly hostClient: HostClient;
  readonly requests: readonly import("@opensteer/integration-core").ComputerAppSetupSummary[];
  readonly onChanged: () => Promise<void>;
  /** A line under each approval's name, where the name alone would not say what it asks. */
  readonly detail?: (
    request: import("@opensteer/integration-core").ComputerAppSetupSummary,
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
