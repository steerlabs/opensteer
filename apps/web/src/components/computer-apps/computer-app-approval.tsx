import { Dialog } from "../dialog.js";
import { useComputerAppApproval as useOwnerComputerAppApproval } from "@opensteer/client/react";
import { computerAppApprovalDetails } from "@opensteer/client/integrations";
import type { HostClient } from "@opensteer/client/host";
import { useState } from "react";

/** Details live only while this owner is reviewing; no native approval bridge. */
export function useComputerAppApproval(hostClient: HostClient) {
  const { ask, review, error, busy, close, answer } = useOwnerComputerAppApproval(hostClient);
  const dialog = review ? (
    <Dialog title="Allow agent access?" onClose={close}>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          maxHeight: "60vh",
          overflowY: "auto",
        }}
      >
        {computerAppApprovalDetails(review)}
      </pre>
      {error ? <p role="alert">{error}</p> : null}
      <div className="form-actions">
        <button className="btn" disabled={busy} onClick={() => void answer("deny")} type="button">
          Don't allow
        </button>
        <button
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void answer("allow")}
          type="button"
        >
          Allow
        </button>
      </div>
    </Dialog>
  ) : null;
  return { ask, dialog };
}

export function ComputerSetupApprovals(props: {
  readonly hostClient: HostClient;
  readonly requests: readonly import("@opensteer/integration-core").ComputerAppSetupSummary[];
  readonly onChanged: () => Promise<void>;
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
            {request.server?.name ??
              request.app?.displayName ??
              (request.kind === "policy" ? "Automatic app approval" : request.definitionId)}
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
