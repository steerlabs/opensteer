import { useEffect, useState } from "react";
import type { DeploymentAccessSnapshot, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { actionErrorMessage } from "../ui-utils.js";
import { Icon } from "./icon.js";

interface DeploymentOperationPresentation {
  readonly canCancel: boolean;
  readonly canRepairLink: boolean;
  readonly canRetry: boolean;
  readonly detail: string;
  readonly failed: boolean;
  readonly phaseLabel: string;
  readonly title: string;
}

export function deploymentOperationPresentation(
  snapshot: DeploymentAccessSnapshot | null,
): DeploymentOperationPresentation | null {
  if (!snapshot) return null;
  const selected = snapshot.deployments.find(({ id }) => id === snapshot.selectedDeploymentId);
  if (selected?.failure) {
    return {
      canCancel: selected.availableActions.includes("cancel"),
      canRepairLink: snapshot.personalAccountLink.status === "needs-repair",
      // `retryable` says whether the Desktop will try again on its own; whether
      // a person may ask is the action the row advertises, and nothing else.
      canRetry: selected.availableActions.includes("retry"),
      detail: selected.failure.detail,
      failed: true,
      phaseLabel: "Needs attention",
      title: `Opening ${selected.name}`,
    };
  }
  if (selected?.status === "connecting") {
    return {
      canCancel: selected.availableActions.includes("cancel"),
      canRepairLink: false,
      canRetry: false,
      detail: `Connecting to ${selected.name}…`,
      failed: false,
      phaseLabel: "Preparing",
      title: `Opening ${selected.name}`,
    };
  }
  return null;
}

export function deploymentMutationsBlockedReason(
  snapshot: DeploymentAccessSnapshot | null,
): string | null {
  if (!snapshot) return null;
  const selected = snapshot.deployments.find(({ id }) => id === snapshot.selectedDeploymentId);
  if (selected?.status === "connecting") return `Opening ${selected.name}. Wait for it to finish.`;
  if (selected?.failure)
    return `Opening ${selected.name} needs attention. Retry or cancel it first.`;
  if (snapshot.account.status === "authorizing")
    return "Finish signing in before making another change.";
  return null;
}

type OperationBridge = Pick<OpensteerDesktopBridge, "cancel" | "linkPersonal" | "retry">;

export function DeploymentOperationBanner({
  bridge,
  snapshot,
}: {
  readonly bridge: OperationBridge | null;
  readonly snapshot: DeploymentAccessSnapshot | null;
}) {
  const presentation = deploymentOperationPresentation(snapshot);
  const [pending, setPending] = useState<"cancel" | "repair" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signature = presentation ? `${presentation.title}:${presentation.phaseLabel}` : null;
  useEffect(() => {
    setPending(null);
    setError(null);
  }, [signature]);
  if (!presentation || !bridge) return null;

  const act = (kind: "cancel" | "repair" | "retry", run: () => Promise<void>) => {
    if (pending) return;
    setPending(kind);
    setError(null);
    void run().catch((reason: unknown) => {
      setError(actionErrorMessage(reason));
      setPending(null);
    });
  };

  return (
    <div
      aria-atomic="true"
      aria-live={presentation.failed ? "assertive" : "polite"}
      className={`notice shell-operation${presentation.failed ? " notice--error" : ""}`}
      role={presentation.failed ? "alert" : "status"}
    >
      <Icon name={presentation.failed ? "alert-circle" : "reload"} />
      <div className="shell-operation__body">
        <p className="shell-operation__title">
          {presentation.title}
          <span className={`chip ${presentation.failed ? "chip--bad" : "chip--warn"}`}>
            {presentation.phaseLabel}
          </span>
        </p>
        <p className="shell-operation__detail">{presentation.detail}</p>
        {error ? <p className="shell-operation__detail">{error}</p> : null}
      </div>
      <div className="shell-operation__actions">
        {presentation.canRetry ? (
          <button
            className="btn btn--small btn--primary"
            disabled={pending !== null}
            onClick={() => act("retry", () => bridge.retry())}
            type="button"
          >
            {pending === "retry" ? "Trying again…" : "Try again"}
          </button>
        ) : null}
        {presentation.canRepairLink ? (
          <button
            className="btn btn--small"
            disabled={pending !== null}
            onClick={() => act("repair", () => bridge.linkPersonal())}
            type="button"
          >
            {pending === "repair" ? "Repairing…" : "Repair account link"}
          </button>
        ) : null}
        {presentation.canCancel ? (
          <button
            className="btn btn--small"
            disabled={pending !== null}
            onClick={() => act("cancel", () => bridge.cancel())}
            type="button"
          >
            {pending === "cancel" ? "Cancelling…" : "Cancel"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
