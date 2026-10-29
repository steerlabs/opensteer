import { useState } from "react";
import type { Request } from "@opensteer/core";
import {
  fullAccessButtonLabel,
  fullAccessDeclineLabel,
  fullAccessOnThisMac,
  fullAccessRequestBody,
  mutationIdempotencyKey,
} from "@opensteer/client/host";
import { ActionNote } from "./action-rows.js";
import { useShell } from "./app-shell.js";
import { hostsDeployment } from "@opensteer/client/computers";
import { MacOsPermissionReviewDialog } from "./macos-permission-review-dialog.js";

/**
 * An agent's ask for macOS Full Disk Access on one lent Mac.
 *
 * The card cannot grant anything, and never pretends to: the Request is
 * fulfilled by that Mac reporting the grant, so the only thing anybody can
 * decide here is to decline. The review action is shown only where System
 * Settings can be opened — this app, running on that very computer.
 *
 * Nothing is polled. The Host resolves the Request when the Mac reports the
 * grant, which takes it out of the pending Requests and this card with it.
 */
export function ThreadFullDiskAccessAction({
  request,
  disabled = false,
}: {
  readonly request: Request;
  readonly disabled?: boolean;
}) {
  const {
    desktopBridge,
    desktopDeployment,
    hostClient,
    localExecutionStatus,
    reportActionError,
    snapshot,
  } = useShell();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  if (request.payload.kind !== "machine.full-disk-access") {
    return <ActionNote alert>This macOS Full Disk Access request is invalid.</ActionNote>;
  }
  const { machineId, machineName } = request.payload;
  const machine = snapshot.machines.find((candidate) => candidate.id === machineId);
  const onThatMac = fullAccessOnThisMac({
    hostsDeployment:
      machine !== undefined && hostsDeployment(machine, snapshot.deploymentShape?.kind ?? null),
    hostsDeploymentOnThisComputer: desktopDeployment?.onThisComputer === true,
    inDesktopApp: desktopBridge !== null,
    lentByThisDesktop: localExecutionStatus?.runner.runnerId === machineId,
  });

  async function decline() {
    if (pending || disabled) return;
    setPending(true);
    setError(null);
    try {
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${request.id}`),
        requestId: request.id,
        response: { kind: "external", value: { decision: "declined" } },
        type: "request.respond",
      });
    } catch (reason) {
      setError(errorMessage(reason));
      reportActionError(reason);
      setPending(false);
    }
  }

  return (
    <>
      <ActionNote>{fullAccessRequestBody(machineName)}</ActionNote>
      {error ? <ActionNote alert>{error}</ActionNote> : null}
      <div className="action-buttons">
        <button
          className="btn"
          disabled={pending || disabled}
          onClick={() => void decline()}
          type="button"
        >
          {fullAccessDeclineLabel}
        </button>
        {onThatMac ? (
          <button
            className="btn btn--primary"
            disabled={pending || disabled}
            onClick={() => {
              if (!pending && !disabled) setReviewing(true);
            }}
            type="button"
          >
            {fullAccessButtonLabel}
          </button>
        ) : null}
      </div>
      {reviewing && desktopBridge ? (
        <MacOsPermissionReviewDialog
          bridge={desktopBridge}
          onClose={() => setReviewing(false)}
          onError={(reason) => {
            setError(errorMessage(reason));
            reportActionError(reason);
          }}
        />
      ) : null}
    </>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : "The macOS Full Disk Access request could not be answered.";
}
