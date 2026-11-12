import { useState } from "react";
import type {
  DeploymentAccessSnapshot,
  DesktopAccountAuthStatus,
} from "@opensteer/protocol/desktop";
import { accountPortalHref } from "../../../portal/account-portal.js";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { deploymentMutationsBlockedReason } from "../../deployment-operation.js";
import { SignOutDialog } from "../../places/place-account.js";
import {
  SectionHeader,
  SettingsError,
  SettingsGroup,
  SettingsRow,
  type SettingsView,
} from "../primitives.js";
import { SignedInDevicesSection } from "./devices.js";
import { RemoteAccessCard } from "./remote-access-card.js";

/**
 * The Opensteer Account: the one thing in the product anybody signs in to,
 * then whether this Opensteer can be used from anywhere, then every device
 * signed in to it.
 */
export function AccountSection({ view }: { readonly view: SettingsView }) {
  const { deploymentAccess, desktopBridge, snapshot } = useShell();
  const portalOrigin = snapshot.identityConfig?.portalOrigin ?? null;
  const signedIn = deploymentAccess?.account.status === "signed-in";
  return (
    <>
      <SectionHeader title="Account" />
      <SettingsGroup heading={null} headingId="settings-account">
        {desktopBridge ? (
          <AccountSessionRow account={deploymentAccess?.account ?? null} />
        ) : (
          <BrowserAccountRow
            portalHref={accountPortalHref({
              desktop: false,
              identityConfig: snapshot.identityConfig,
            })}
          />
        )}
      </SettingsGroup>
      <RemoteAccessCard view={view} />
      <SignedInDevicesSection view={view} />
      {desktopBridge && signedIn && portalOrigin ? (
        <p className="settings-footer-link">
          <a
            className="settings-link settings-link--danger"
            href={`${portalOrigin}/account/delete`}
            rel="noreferrer"
            target="_blank"
          >
            Delete Account…
          </a>
        </p>
      ) : null}
    </>
  );
}

/**
 * The Account row on Desktop. Signing out ends this app's Account session and
 * leaves every Deployment running exactly where it was.
 */
function AccountSessionRow({
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

  const copy =
    account?.available === false && account.status === "signed-out"
      ? { title: "Not signed in", detail: "Opensteer Account sign-in isn’t available yet." }
      : accountStateCopy[account?.status ?? "unknown"];
  return (
    <>
      <SettingsRow
        action={
          action ? (
            <button
              className="btn"
              disabled={pending || blockedReason !== null}
              onClick={act}
              title={blockedReason ?? undefined}
              type="button"
            >
              {action === "sign-out" ? "Sign out" : pending ? "Signing in…" : "Sign in"}
            </button>
          ) : undefined
        }
        detail={copy.detail}
        title={account?.status === "signed-in" ? (account.email ?? copy.title) : copy.title}
      />
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
function BrowserAccountRow({ portalHref }: { readonly portalHref: string | null }) {
  return (
    <SettingsRow
      action={
        portalHref ? (
          <a className="btn" href={portalHref} rel="noreferrer">
            Sign in
          </a>
        ) : undefined
      }
      detail={portalHref ? "Open your Opensteer from any device" : "Account sign-in unavailable"}
      title="Opensteer Account"
    />
  );
}

/** One wording per credential state. */
const accountStateCopy: Readonly<
  Record<DesktopAccountAuthStatus | "unknown", { readonly title: string; readonly detail: string }>
> = {
  authorizing: {
    title: "Signing in…",
    detail: "Finish signing in in your browser. This continues by itself.",
  },
  error: {
    title: "Signed out",
    detail: "Sign in again to see your other computers. They keep running.",
  },
  "signed-in": { title: "Opensteer Account", detail: "Opensteer Account" },
  "signed-out": {
    title: "Not signed in",
    detail: "Sign in to open this computer from your phone and see your other computers.",
  },
  unknown: { title: "Checking…", detail: "Checking your Account…" },
};
