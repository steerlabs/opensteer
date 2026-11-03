import { useState } from "react";
import type {
  DeploymentAccessSnapshot,
  DesktopAccountAuthStatus,
} from "@opensteer/protocol/desktop";
import { accountPortalHref } from "../../../portal/account-portal.js";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { deploymentMutationsBlockedReason } from "../../deployment-operation.js";
import { Icon } from "../../icon.js";
import { SignOutDialog } from "../../places/place-account.js";
import { SectionHeader, SettingsError, SettingsRow } from "../primitives.js";

/**
 * The Opensteer Account: the one thing in the product anybody signs in to.
 * "Sign out" always means leaving that Account, here and in the place menu;
 * a device leaves a place with "Disconnect this device", and someone else's
 * session ends with "Revoke". One verb, one meaning.
 */
export function AccountSection() {
  const { deploymentAccess, desktopBridge, snapshot } = useShell();
  const portalHref = accountPortalHref({
    desktop: desktopBridge !== null,
    identityConfig: snapshot.identityConfig,
  });
  return (
    <>
      <SectionHeader title="Account" />
      {desktopBridge ? (
        <AccountSessionCard account={deploymentAccess?.account ?? null} />
      ) : (
        <BrowserAccountCard portalHref={portalHref} />
      )}
    </>
  );
}

/**
 * The Account row on Desktop. Signing out ends this app's Account session and
 * leaves every Deployment running exactly where it was — which is why the
 * sentence says so next to the button rather than after it.
 */
function AccountSessionCard({
  account,
}: {
  readonly account: DeploymentAccessSnapshot["account"] | null;
}) {
  const { deploymentAccess, desktopBridge } = useShell();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const blockedReason = deploymentMutationsBlockedReason(deploymentAccess);
  const action =
    account?.status === "signed-in" ? "sign-out" : account?.available ? "sign-in" : null;

  function act() {
    if (!desktopBridge || !action || pending) return;
    // Signing out hides things, so it says what it hides before it does.
    if (action === "sign-out") {
      setSigningOut(true);
      return;
    }
    setPending(true);
    setError(null);
    void desktopBridge
      .signIn()
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(false));
  }

  const state = account?.status ?? "unknown";
  const copy =
    account?.available === false && account.status === "signed-out"
      ? { chip: "", detail: "Opensteer Account sign-in isn’t available yet.", label: "Unavailable" }
      : accountStateCopy[state];
  return (
    <>
      <div className="card">
        <SettingsRow
          action={
            action ? (
              <button
                className={
                  action === "sign-out"
                    ? "btn btn--ghost btn--small"
                    : "btn btn--primary btn--small"
                }
                disabled={pending || blockedReason !== null}
                onClick={act}
                type="button"
              >
                {pending
                  ? action === "sign-out"
                    ? "Signing out…"
                    : "Signing in…"
                  : action === "sign-out"
                    ? "Sign out"
                    : "Sign in"}
              </button>
            ) : undefined
          }
          detail={
            <>
              {copy.detail}
              {blockedReason && action ? (
                <span className="card__row-reason">{blockedReason}</span>
              ) : null}
            </>
          }
          icon="user"
          title={
            <>
              {account?.email ?? "Opensteer Account"}
              <span className={copy.chip ? `chip ${copy.chip}` : "chip"}>{copy.label}</span>
            </>
          }
        />
      </div>
      <SettingsError message={error} />
      {signingOut && desktopBridge ? (
        <SignOutDialog
          onClose={() => setSigningOut(false)}
          onConfirm={() => desktopBridge.signOut()}
        />
      ) : null}
    </>
  );
}

/**
 * A browser session holds Host credentials. Account management opens the
 * Host-advertised Account portal, which owns its own sign-in.
 */
function BrowserAccountCard({ portalHref }: { readonly portalHref: string | null }) {
  if (!portalHref) {
    return (
      <div className="card">
        <SettingsRow icon="user" title="Opensteer Account" detail="Account sign-in unavailable" />
      </div>
    );
  }
  return (
    <div className="card">
      <SettingsRow
        action={
          <a className="btn btn--small" href={portalHref} rel="noreferrer">
            Sign in
            <Icon name="external-link" />
          </a>
        }
        detail="Open your Opensteer from any device"
        icon="user"
        title="Opensteer Account"
      />
    </div>
  );
}

interface AccountStateCopy {
  readonly chip: string;
  readonly detail: string;
  readonly label: string;
}

/** One wording per credential state, all five visible together. */
const accountStateCopy: Readonly<Record<DesktopAccountAuthStatus | "unknown", AccountStateCopy>> = {
  authorizing: {
    chip: "chip--warn",
    detail: "Finish signing in in your browser. This window continues by itself.",
    label: "Signing in…",
  },
  error: {
    chip: "chip--warn",
    detail:
      "You were signed out on this computer. Sign in again to see your other computers and servers. They keep running.",
    label: "Sign in again",
  },
  "signed-in": {
    chip: "chip--ok",
    detail: "Opensteer Account",
    label: "Signed in",
  },
  "signed-out": {
    chip: "",
    detail: "Open your Opensteer from any device",
    label: "Signed out",
  },
  unknown: { chip: "", detail: "Checking your account…", label: "Checking…" },
};
