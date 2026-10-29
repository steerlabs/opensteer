import type { Request } from "@opensteer/core";
import { fullAccessOnThisMac, mutationIdempotencyKey } from "@opensteer/client/host";
import { computerAppAccessApproval, computerUseAccessLabel } from "@opensteer/client/integrations";
import { useState } from "react";
import { hostsDeployment } from "@opensteer/client/computers";
import { ActionNote } from "./action-rows.js";
import { useShell } from "./app-shell.js";

/**
 * An agent asked to use an app on a Mac, or the whole screen of an Android
 * phone.
 *
 * A Mac asks locally in its desktop app. A phone's owner can allow access
 * here; Decline works for either and takes the pending setup request with it.
 */
export function ThreadComputerAppAccessAction({
  disabled = false,
  request,
}: {
  readonly disabled?: boolean;
  readonly request: Request;
}) {
  const { desktopBridge, desktopDeployment, hostClient, localExecutionStatus, snapshot } =
    useShell();
  const [busy, setBusy] = useState<"allow" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (request.payload.kind !== "computer.app.access") {
    return <ActionNote alert>This app access request is invalid.</ActionNote>;
  }
  const { access, definitionId, runnerId } = request.payload;
  const machine = snapshot.machines.find((candidate) => candidate.id === runnerId);
  const { approveOn } = computerAppAccessApproval({
    definitionId,
    machines: snapshot.machines,
    onThatMac:
      machine !== undefined &&
      fullAccessOnThisMac({
        hostsDeployment: hostsDeployment(machine, snapshot.deploymentShape?.kind ?? null),
        hostsDeploymentOnThisComputer: desktopDeployment?.onThisComputer === true,
        inDesktopApp: desktopBridge !== null,
        lentByThisDesktop: localExecutionStatus?.runner.runnerId === runnerId,
      }),
    runnerId,
  });

  async function decline() {
    if (busy || disabled) return;
    setBusy("decline");
    setError(null);
    try {
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${request.id}`),
        requestId: request.id,
        response: { kind: "external", value: { decision: "declined" } },
        type: "request.respond",
      });
    } catch (reason) {
      // Said on the card where it was declined, not again in the app-wide banner.
      setError(reason instanceof Error ? reason.message : "The request could not be declined.");
      setBusy(null);
    }
  }

  async function allow() {
    if (busy || disabled || definitionId !== "android-phone") return;
    setBusy("allow");
    setError(null);
    try {
      const result = await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`phone-request:${request.id}`),
        input: { access, app: null, definitionId, kind: "app", runnerId },
        type: "integration.computer.setup.set",
      });
      if (result.type !== "integration.computer.setup.set") {
        throw new Error("Phone access was not set.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request could not be allowed.");
      setBusy(null);
    }
  }

  return (
    <>
      <ActionNote>{`${computerUseAccessLabel[access]} · ${approveOn}`}</ActionNote>
      {error ? <ActionNote alert>{error}</ActionNote> : null}
      <div className="action-buttons">
        {definitionId === "android-phone" ? (
          <button
            className="btn btn--primary"
            disabled={busy !== null || disabled}
            onClick={() => void allow()}
            type="button"
          >
            {busy === "allow" ? "Allowing…" : "Allow"}
          </button>
        ) : null}
        <button
          className="btn"
          disabled={busy !== null || disabled}
          onClick={() => void decline()}
          type="button"
        >
          {busy === "decline" ? "Declining…" : "Decline"}
        </button>
      </div>
    </>
  );
}
