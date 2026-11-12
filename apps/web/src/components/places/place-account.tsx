import { discardAllStagedFiles } from "../attachments/use-staged-attachments.js";
import { composerDrafts } from "../composer-drafts.js";
import { useEffect, useId, useRef, useState } from "react";
import type { DeploymentAccessSnapshot, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { Dialog } from "../dialog.js";
import { ErrorNotice } from "../onboarding-card.js";

type AccountState = DeploymentAccessSnapshot["account"];

/**
 * What stands in for the places an Account lists while that Account is not
 * signed in: one card that says what signing in brings, instead of a list of
 * places this app can no longer vouch for.
 */
export function PlaceSignInCard({
  account,
  onCancel,
  onSignIn,
  pending = false,
}: {
  readonly account: AccountState;
  readonly onCancel: () => void;
  readonly onSignIn: () => void;
  readonly pending?: boolean;
}) {
  if (!account.available || account.status === "signed-in") return null;
  if (account.status === "authorizing") {
    return (
      <div aria-live="polite" className="place-card" role="status">
        <p className="place-card__title">Finish signing in in your browser</p>
        <p className="place-card__body">This window continues by itself.</p>
        <button className="btn btn--small btn--ghost" onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    );
  }
  const again = account.status === "error";
  return (
    <div className={`place-card${again ? " place-card--attention" : ""}`}>
      <p className="place-card__title">
        {again ? "Sign in again" : "Sign in to see your other computers"}
      </p>
      <p className="place-card__body">
        {again
          ? "You were signed out on this computer. Sign in again to see your other computers and servers. They keep running."
          : "Open your other computers and servers from here."}
      </p>
      <button
        className="btn btn--small btn--primary"
        disabled={pending}
        onClick={onSignIn}
        type="button"
      >
        {again ? "Sign in again" : "Sign in"}
      </button>
    </div>
  );
}

/** The signed-in Account, at the foot of a list of places, with its one exit. */
export function PlaceAccountFooter({
  account,
  onSignOut,
}: {
  readonly account: AccountState;
  readonly onSignOut: () => void;
}) {
  if (account.status !== "signed-in") return null;
  return (
    <div className="pop-foot">
      <span aria-hidden className="account-avatar">
        {accountInitial(account.email ?? null)}
      </span>
      <span className="pop-foot__email">{account.email ?? "Signed in"}</span>
      <button className="link-btn" onClick={onSignOut} type="button">
        Sign out
      </button>
    </div>
  );
}

/**
 * The Opensteers this Mac leaves when the Account signs out: every Account
 * listing it is a device of. Read from each one's membership as the dialog
 * opens, because the catalog alone can't say which this Mac joined.
 */
export function useAccountLeaves(
  bridge: Pick<OpensteerDesktopBridge, "getLocalExecutionStatus"> | null,
  snapshot: DeploymentAccessSnapshot | null,
): readonly string[] | null {
  const [names, setNames] = useState<readonly string[] | null>(null);
  const listed = useRef(snapshot?.deployments ?? []);
  listed.current = (snapshot?.deployments ?? []).filter(
    (deployment) =>
      deployment.source === "account" &&
      deployment.kind === "personal" &&
      !deployment.onThisComputer,
  );
  const key = listed.current.map(({ id }) => id).join(",");
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void Promise.all(
      listed.current.map((deployment) =>
        bridge
          .getLocalExecutionStatus({ deploymentId: deployment.id })
          .then((status) =>
            status.membership?.state === "active" ||
            status.membership?.state === "waiting" ||
            (!status.membership && status.runner.enrolled)
              ? deployment.name
              : null,
          )
          .catch(() => null),
      ),
    ).then((found) => {
      if (live) setNames(found.filter((name): name is string => name !== null));
    });
    return () => {
      live = false;
    };
  }, [bridge, key]);
  return names;
}

/** "Home", "Home and Studio", "Home, Studio and Lab". */
export function namesInWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

/**
 * Signing out of the Account leaves every Opensteer this Mac joined through
 * it, so it names each one, and what is deleted, before it does it.
 */
export function SignOutDialog({
  bridge = null,
  onClose,
  onConfirm,
  snapshot = null,
}: {
  readonly bridge?: Pick<OpensteerDesktopBridge, "getLocalExecutionStatus"> | null;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
  readonly snapshot?: DeploymentAccessSnapshot | null;
}) {
  const titleId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leaves = useAccountLeaves(bridge, snapshot);
  const email = snapshot?.account.email ?? null;
  const hosts = snapshot?.personalSetup?.deploymentId != null;
  return (
    <Dialog
      footer={
        <>
          <button className="btn btn--ghost" disabled={pending} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className={leaves && leaves.length > 0 ? "btn btn--danger" : "btn btn--primary"}
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError(null);
              void onConfirm()
                .then(() => {
                  discardAllStagedFiles();
                  composerDrafts.clearAll();
                  onClose();
                })
                .catch((reason: unknown) => {
                  setPending(false);
                  setError(
                    reason instanceof Error && reason.message
                      ? reason.message
                      : "Signing out didn’t finish. Try again.",
                  );
                });
            }}
            type="button"
          >
            {pending ? "Signing out…" : "Sign out"}
          </button>
        </>
      }
      labelledBy={titleId}
      onClose={onClose}
      title={
        <span id={titleId}>{email ? `Sign out of ${email}?` : "Sign out on this computer?"}</span>
      }
    >
      {leaves && leaves.length > 0 ? (
        <p>
          This Mac is removed from {namesInWords(leaves)}. Browser profiles kept on this Mac for{" "}
          {leaves.length === 1 ? "it" : "them"} are deleted.
          {hosts ? " The Opensteer this Mac runs keeps running." : ""}
        </p>
      ) : (
        <p>
          Your other Opensteers will be hidden here until you sign in again. They keep running, and
          nothing is deleted.
        </p>
      )}
      <ErrorNotice message={error} />
    </Dialog>
  );
}

function accountInitial(email: string | null): string {
  const first = [...(email ?? "").trim()][0];
  return first ? first.toLocaleUpperCase() : "·";
}
