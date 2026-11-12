import { usePersonalRemoteAccess } from "@opensteer/client/react";
import { Link } from "react-router";
import type { DesktopLocalExecutionStatus } from "@opensteer/protocol/desktop";
import { Dialog } from "../dialog.js";
import { useShell, type ShellContext } from "../app-shell.js";
import { Icon } from "../icon.js";

/**
 * How a computer joins, in the order somebody actually does it.
 *
 * A computer is always added from the computer itself, so the dialog opens
 * with the one in front of the reader when it can join, and otherwise gives
 * the steps to take on the other one. A Personal Opensteer admits no second
 * computer until other computers can reach it, so that is the first step —
 * and only while it is actually off.
 */
export function AddComputerDialog({
  homeName,
  localExecutionAction,
  localExecutionError,
  localExecutionStatus,
  offer,
  onAddThisComputer,
  onClose,
}: {
  /** The Mac a Personal Opensteer runs on. */
  readonly homeName: string;
  readonly localExecutionAction: ShellContext["localExecutionAction"];
  readonly localExecutionError: string | null;
  readonly localExecutionStatus: DesktopLocalExecutionStatus | null;
  /** What joining would give this computer, or null when it cannot join. */
  readonly offer: { readonly runAgents: boolean } | null;
  readonly onAddThisComputer: (input: {
    readonly kind: "add";
    readonly name: string;
    readonly runAgents: boolean;
  }) => Promise<void>;
  readonly onClose: () => void;
}) {
  const { deploymentAccess, desktopBridge } = useShell();
  const accountAvailable = !desktopBridge || deploymentAccess?.account.available !== false;
  const adding = localExecutionAction?.kind === "add";
  const reachable = usePersonalReachable();

  return (
    <Dialog
      footer={
        <button className="btn" onClick={onClose} type="button">
          Done
        </button>
      }
      labelledBy="add-computer-title"
      onClose={onClose}
      title="Add a computer"
    >
      {offer && localExecutionStatus ? (
        <section className="add-computer__here">
          <span className="add-computer__here-glyph">
            <Icon name="pin" />
          </span>
          <span className="add-computer__here-body">
            <strong>{localExecutionStatus.computerName}</strong>
            <span>The computer you’re on now.</span>
          </span>
          <button
            className="btn btn--primary"
            disabled={adding}
            onClick={() =>
              void onAddThisComputer({
                kind: "add",
                name: localExecutionStatus.computerName,
                runAgents: offer.runAgents,
              }).catch(() => undefined)
            }
            type="button"
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </section>
      ) : null}
      {offer && localExecutionError ? (
        <p className="notice notice--error" role="alert">
          {localExecutionError}
        </p>
      ) : null}

      <section className="add-computer__step">
        <h3>{offer ? "Another computer" : "Add it from that computer"}</h3>
        <ol className="add-computer__steps">
          {reachable === false ? (
            <li>
              Turn on remote access for {homeName}, so other computers can reach it.{" "}
              <Link to="/settings/account/remote-access">Open Remote access</Link>
            </li>
          ) : null}
          <li>
            Install Opensteer on the other computer{accountAvailable ? " and sign in" : ""}
            {accountAvailable
              ? ` with your Opensteer account. Then open ${homeName}.`
              : `. Then open ${homeName}.`}
          </li>
          <li>
            In Settings → Devices, choose <strong>Add device</strong>, then{" "}
            <strong>Computer</strong>. It shows up here right away.
          </li>
        </ol>
        <p className="section__hint">
          {accountAvailable ? "No Opensteer account? " : ""}Create a pairing code under Remote
          access on {homeName}, and enter it on the other computer when you add {homeName} there.
        </p>
      </section>
    </Dialog>
  );
}

/** The Host reports reachability equally to every signed-in owner. */
function usePersonalReachable(): boolean | null {
  const { hostClient } = useShell();
  const remote = usePersonalRemoteAccess(hostClient);
  return remote.status ? remote.status.access.mode !== "off" : null;
}
