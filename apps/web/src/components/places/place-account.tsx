import { useId, useState } from "react";
import type { DeploymentAccessSnapshot } from "@opensteer/protocol/desktop";
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
          : "Open your other computers, servers and Opensteer Cloud from here."}
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
 * Signing out is the one move here that hides things, so it says exactly what
 * it hides, and that nothing stops or is deleted, before it does it.
 */
export function SignOutDialog({
  onClose,
  onConfirm,
}: {
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
}) {
  const titleId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      footer={
        <>
          <button className="btn btn--ghost" disabled={pending} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError(null);
              void onConfirm()
                .then(onClose)
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
      title="Sign out on this computer?"
    >
      <p>
        Your other computers and servers will be hidden here until you sign in again. They keep
        running, and nothing is deleted.
      </p>
      <ErrorNotice message={error} />
    </Dialog>
  );
}

function accountInitial(email: string | null): string {
  const first = [...(email ?? "").trim()][0];
  return first ? first.toLocaleUpperCase() : "·";
}
