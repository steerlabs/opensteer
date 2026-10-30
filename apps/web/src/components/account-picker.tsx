import { useState } from "react";
import { Link } from "react-router";
import type { ThreadPlacementOption } from "@opensteer/client/host";
import { Icon } from "./icon.js";

/** Signing an account in, or asking again whether it is signed in outside Opensteer. */
export interface AccountFixes {
  readonly onAuthenticate?: ((placement: ThreadPlacementOption) => void) | undefined;
  readonly onRefresh?: ((placement: ThreadPlacementOption) => Promise<void>) | undefined;
}

/**
 * The one action that can make an unavailable account usable from here, or
 * null when nothing here can: a managed sign-in when the engine offers one,
 * otherwise "Check again" for a sign-in done outside Opensteer.
 */
export function AccountFix({
  onAuthenticate,
  onRefresh,
  placement,
}: AccountFixes & { readonly placement: ThreadPlacementOption }) {
  const [checking, setChecking] = useState(false);
  if (
    placement.availability !== "authentication-required" ||
    !placement.harnessAuthenticationAllowed
  )
    return null;
  if (placement.setupAvailable && onAuthenticate) {
    return (
      <button
        className="btn btn--small picker__setup"
        onClick={() => onAuthenticate(placement)}
        type="button"
      >
        Sign in
      </button>
    );
  }
  if (!onRefresh) return null;
  return (
    <button
      className="btn btn--small picker__setup"
      disabled={checking}
      onClick={() => {
        setChecking(true);
        void onRefresh(placement).finally(() => setChecking(false));
      }}
      type="button"
    >
      {checking ? "Checking…" : "Check again"}
    </button>
  );
}

export function ManageAccountsLink({ environmentId }: { readonly environmentId: string }) {
  return (
    <Link
      className="picker__manage"
      to={`/settings/ai-engines?location=${encodeURIComponent(environmentId)}`}
    >
      Manage accounts
      <Icon name="chevron-right" />
    </Link>
  );
}
