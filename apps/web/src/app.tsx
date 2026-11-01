import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import {
  HostAccessOnboarding,
  PasswordRecovery,
  SetupAdmissionFailure,
} from "./components/onboarding.js";
import { ErrorNotice, OnboardingCard } from "./components/onboarding-card.js";
import { BrandMark } from "./components/brand.js";
import { AppShell } from "./components/app-shell.js";
import { HomeRoute, NewTaskRoute, WorkspaceHomeRoute } from "./components/home-view.js";
import { LiveRedirect } from "./components/workspace/live-redirect.js";
import { SpecialistsPage } from "./components/specialists-page.js";
import { ThreadRoute } from "./components/thread-view.js";
import { InviteRoute } from "./components/invitation-onboarding.js";
import { IntegrationsPage } from "./components/integrations/integrations-page.js";
import { ChannelsPage } from "./components/channels-page.js";
import { AutomationDetailPage } from "./components/automations/automation-detail.js";
import { AutomationEditorPage } from "./components/automations/automation-editor.js";
import { AutomationsPage } from "./components/automations/automations-page.js";
import { ComputerDetailPage, ComputersPage } from "./components/computers-page.js";
import {
  SettingsShell,
  SettingsSectionRoute,
  SettingsNotFound,
} from "./components/settings/settings-shell.js";
import { SettingsRedirect } from "./components/settings/settings-redirect.js";
import { ConnectedAppsLayout } from "./components/settings/connected-apps.js";
import type {
  DeploymentAccessSnapshot,
  DesktopDeploymentSummary,
  DesktopNotificationTarget,
  DesktopSelectDeploymentInput,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import {
  sameAppGateSnapshot,
  unwrapRpcResult,
  type HostClient,
  type InitialOwnerClaimInput,
  type PasswordSignInInput,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { consumeOAuthErrorQuery } from "./account/auth-error-query.js";
import { consumeNativeOAuthQuery } from "./account/native-oauth-query.js";
import { Icon } from "./components/icon.js";
import { ToastProvider } from "./components/toast.js";
import { actionErrorMessage } from "./ui-utils.js";
import { shouldAutoStartOidc } from "./account/auto-oidc.js";
import { IntegrationAuthorizationCompletion } from "./components/integration-authorization-completion.js";

const autoOidcAttemptKey = "opensteer.oidc.auto-attempt";
const autoOidcAttemptWindowMs = 2 * 60 * 1_000;

export function App({
  deploymentAccess = null,
  desktopBridge = null,
  desktopDeployment = null,
  hostClient,
  onNotificationTargetOpened,
  notificationTarget = null,
}: {
  /** The Desktop's single guarded access snapshot, or null in a browser. */
  readonly deploymentAccess?: DeploymentAccessSnapshot | null;
  readonly desktopBridge?: OpensteerDesktopBridge | null;
  readonly desktopDeployment?: DesktopDeploymentSummary | null;
  readonly hostClient: HostClient;
  readonly onNotificationTargetOpened?: (() => void) | undefined;
  /**
   * The Desktop notification that was clicked, already known to belong to this
   * Deployment. It survives the sign-in screens below, which render instead of
   * the app until this person is authenticated.
   */
  readonly notificationTarget?: DesktopNotificationTarget | null;
}) {
  const { loadError, reload, snapshot } = useHostSnapshot(hostClient, sameAppGateSnapshot);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingPending, setOnboardingPending] = useState(false);
  const autoOidcStarted = useRef(false);
  const [autoOidcSuppressed, setAutoOidcSuppressed] = useState(hasRecentAutoOidcAttempt);
  const [nativeAuthorizationPending, setNativeAuthorizationPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Captured once, during the first render, so the code leaves the URL before
  // anything can paint it or persist it in history.
  const [setupToken] = useState(takeSetupToken);
  const [recoveryToken] = useState(takeRecoveryToken);
  const [nativeOAuthQuery] = useState(() =>
    consumeNativeOAuthQuery(window.location, (url) => window.history.replaceState(null, "", url)),
  );
  const [authorizationError, setAuthorizationError] = useState(() =>
    consumeOAuthErrorQuery(window.location, (url) => window.history.replaceState(null, "", url)),
  );
  const [setupAdmission, setSetupAdmission] = useState<
    "absent" | "admitted" | "exchanging" | "rejected"
  >(setupToken ? "exchanging" : "absent");
  const [setupExchangeAttempt, setSetupExchangeAttempt] = useState(0);
  const [setupExchangeError, setSetupExchangeError] = useState<string | null>(null);
  const invitationRoute = isInvitationPath(window.location.pathname);
  const recoveryRoute = window.location.pathname === "/recover";
  const autoOidcProvider =
    snapshot.session === "authentication-required" &&
    snapshot.identityConfig &&
    shouldAutoStartOidc(snapshot.identityConfig, {
      desktop: desktopBridge !== null,
      hasAuthorizationError: authorizationError !== null,
      hasNativeOAuthQuery: nativeOAuthQuery !== null,
      recentAttempt: autoOidcSuppressed,
      setupInProgress: setupAdmission !== "absent",
    })
      ? snapshot.identityConfig.oidcProviders[0]
      : undefined;

  useEffect(() => {
    if (!setupToken) return;
    let cancelled = false;
    setSetupAdmission("exchanging");
    setSetupExchangeError(null);
    void hostClient.rpc["auth.setup.exchange"]({ token: setupToken.trim() })
      .then(unwrapRpcResult)
      .then(() => {
        if (!cancelled) setSetupAdmission("admitted");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSetupExchangeError(actionErrorMessage(error));
        setSetupAdmission("rejected");
      });
    return () => {
      cancelled = true;
    };
  }, [hostClient, setupExchangeAttempt, setupToken]);

  useEffect(() => {
    if (snapshot.session !== "authenticated") return;
    autoOidcStarted.current = false;
    if (clearAutoOidcAttempt()) setAutoOidcSuppressed(false);
  }, [snapshot.session]);

  useEffect(() => {
    if (!autoOidcProvider || autoOidcStarted.current) return;
    autoOidcStarted.current = true;
    if (!recordAutoOidcAttempt()) {
      setAutoOidcSuppressed(true);
      return;
    }
    void startOidc(autoOidcProvider.id, true);
  }, [autoOidcProvider]);

  async function signIn(input: PasswordSignInInput) {
    setOnboardingError(null);
    setOnboardingPending(true);
    try {
      const { redirectUrl } = unwrapRpcResult(
        await hostClient.rpc["auth.password.signIn"]({
          email: input.email.trim(),
          ...(nativeOAuthQuery ? { oauthQuery: nativeOAuthQuery } : {}),
          password: input.password,
        }),
      );
      if (redirectUrl) window.location.assign(redirectUrl);
      else await hostClient.refresh();
    } catch (error) {
      setOnboardingError(actionErrorMessage(error));
    } finally {
      setOnboardingPending(false);
    }
  }

  async function claimInitialOwner(input: InitialOwnerClaimInput) {
    setOnboardingError(null);
    setOnboardingPending(true);
    try {
      unwrapRpcResult(
        await hostClient.rpc["auth.setup.claim"]({
          email: input.email.trim(),
          kind: "password",
          password: input.password,
        }),
      );
      await hostClient.refresh();
    } catch (error) {
      setOnboardingError(actionErrorMessage(error));
    } finally {
      setOnboardingPending(false);
    }
  }

  async function admitInitialOwner(token: string) {
    setSetupExchangeError(null);
    unwrapRpcResult(await hostClient.rpc["auth.setup.exchange"]({ token: token.trim() }));
    setSetupAdmission("admitted");
  }

  async function startOidc(providerId: string, automatic = false) {
    setOnboardingError(null);
    setOnboardingPending(true);
    try {
      const navigated = await startHostOidcSignIn({
        desktopBridge,
        deploymentId: desktopDeployment?.id ?? null,
        hostClient,
        navigate: (url) => window.location.assign(url),
        oauthQuery: nativeOAuthQuery,
        providerId,
      });
      if (!navigated) setOnboardingPending(false);
    } catch (error) {
      if (automatic) {
        recordAutoOidcAttempt();
        setAutoOidcSuppressed(true);
      }
      setOnboardingError(actionErrorMessage(error));
      setOnboardingPending(false);
    }
  }

  async function completeNativeAuthorization(accept: boolean) {
    if (!nativeOAuthQuery || nativeAuthorizationPending) return;
    setOnboardingError(null);
    setNativeAuthorizationPending(true);
    try {
      window.location.assign(
        unwrapRpcResult(
          await hostClient.rpc["auth.native.complete"]({ accept, oauthQuery: nativeOAuthQuery }),
        ).url,
      );
    } catch (error) {
      setOnboardingError(actionErrorMessage(error));
      setNativeAuthorizationPending(false);
    }
  }

  async function refreshHost() {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  }

  // An authorization that failed before anyone could act on it. It reports
  // itself ahead of every other screen, including the ones that wait on the
  // Host, because the reason only exists in the URL this render just consumed.
  if (authorizationError) {
    return (
      <OnboardingCard
        description="Go back to the Opensteer app on this computer and start signing in again."
        eyebrow="Authorization"
        footnote={`Error code: ${authorizationError.error}`}
        title="Sign-in couldn’t be completed"
        titleId="authorization-error-heading"
      >
        <ErrorNotice
          message={
            authorizationError.description ??
            "This deployment turned down the authorization request."
          }
        />
        <div className="onboarding__actions">
          <button
            className="btn btn--primary onboarding__primary"
            onClick={() => setAuthorizationError(null)}
            type="button"
          >
            Continue
          </button>
        </div>
      </OnboardingCard>
    );
  }

  if (recoveryRoute) {
    return (
      <PasswordRecovery
        onReset={async (token, newPassword) => {
          unwrapRpcResult(await hostClient.rpc["auth.password.recover"]({ newPassword, token }));
          window.location.replace("/");
        }}
        token={recoveryToken}
      />
    );
  }

  // Workspace invitations handle their own authentication, so they render in
  // every session state. The URL stays put through sign-in and OIDC returns.
  if (invitationRoute) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/invite/:selector" element={<InviteRoute hostClient={hostClient} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    );
  }

  if (snapshot.session === "authentication-required") {
    if (!snapshot.identityConfig) {
      return <Splash detail="Unable to load this deployment’s sign-in configuration." />;
    }
    // A setup code is still being exchanged, so hold the screen rather than
    // flashing a sign-in form that is about to become a claim form.
    if (
      setupToken &&
      setupAdmission === "exchanging" &&
      snapshot.identityConfig.setupState === "required"
    ) {
      return <Splash detail="Preparing this deployment…" quiet />;
    }
    if (
      setupToken &&
      setupAdmission === "rejected" &&
      snapshot.identityConfig.setupState === "required"
    ) {
      return (
        <SetupAdmissionFailure
          error={setupExchangeError ?? "The setup link could not be validated."}
          onRetry={() => setSetupExchangeAttempt((attempt) => attempt + 1)}
        />
      );
    }
    if (autoOidcProvider) {
      // The browser is already on its way to the provider. Nothing here is
      // actionable, so the screen stays quiet rather than flashing a form.
      return <Splash detail="Signing you in…" quiet />;
    }
    return (
      <HostAccessOnboarding
        admitted={setupAdmission === "admitted"}
        config={snapshot.identityConfig}
        error={onboardingError}
        onAdmit={admitInitialOwner}
        onClaim={claimInitialOwner}
        onOidc={startOidc}
        onSignIn={signIn}
        pending={onboardingPending}
      />
    );
  }

  if (snapshot.session === "checking") {
    return (
      <Splash detail={loadError ?? "Connecting to your deployment…"}>
        {loadError ? (
          <button className="btn" onClick={() => void refreshHost()} type="button">
            {refreshing ? "Trying again…" : "Try again"}
          </button>
        ) : null}
      </Splash>
    );
  }

  if (nativeOAuthQuery) {
    return (
      // The two registered native clients are a desktop and a phone, and this
      // page cannot tell which one opened it, so the sentence says what is true
      // of both rather than naming a computer a phone does not have.
      <OnboardingCard
        description="Allow the Opensteer app that sent you here to access this deployment as you?"
        eyebrow="Authorization"
        footnote={
          <>
            <Icon name="shield" />
            <span>
              Approving grants the app your access to this deployment. You can end it any time from
              Settings.
            </span>
          </>
        }
        title="Connect Opensteer"
        titleId="native-authorization-heading"
      >
        <ErrorNotice message={onboardingError} />
        <div className="onboarding__form">
          <button
            className="btn btn--primary"
            disabled={nativeAuthorizationPending}
            onClick={() => void completeNativeAuthorization(true)}
            type="button"
          >
            {nativeAuthorizationPending ? "Authorizing…" : "Allow"}
          </button>
          <button
            className="btn btn--ghost"
            disabled={nativeAuthorizationPending}
            onClick={() => void completeNativeAuthorization(false)}
            type="button"
          >
            Deny
          </button>
        </div>
      </OnboardingCard>
    );
  }

  // This tab is opened before an attempt exists so the browser sees the open
  // as part of the person's click. The provider return reloads the same route
  // with only the opaque durable-attempt id in its query.
  if (window.location.pathname === "/integration-authorization") {
    return (
      <IntegrationAuthorizationCompletion
        client={hostClient}
        integrationAttempt={new URLSearchParams(window.location.search).get("integrationAttempt")}
      />
    );
  }

  // Main is created by the Host on first sign-in rather than by a form, so an
  // empty list means it is still being written, not that there is nothing to
  // show. This is a brief moment on a first run and none at all afterwards.
  if (snapshot.workspaces.length === 0) {
    return (
      <Splash detail={loadError ?? "Preparing your Workspace…"}>
        {loadError ? (
          <button className="btn" onClick={() => void refreshHost()} type="button">
            {refreshing ? "Trying again…" : "Try again"}
          </button>
        ) : null}
      </Splash>
    );
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route
            element={
              <AppShell
                deploymentAccess={deploymentAccess}
                desktopBridge={desktopBridge}
                desktopDeployment={desktopDeployment}
                hostClient={hostClient}
                loadError={loadError}
                onNotificationTargetOpened={onNotificationTargetOpened}
                notificationTarget={notificationTarget}
              />
            }
          >
            <Route index element={<HomeRoute />} />
            <Route path="new" element={<NewTaskRoute />} />
            <Route path="threads/:threadId" element={<ThreadRoute />} />
            <Route path="live" element={<LiveRedirect />} />
            <Route path="specialists" element={<SpecialistsPage />} />
            <Route path="workspaces/:workspaceId" element={<WorkspaceHomeRoute />} />
            <Route
              path="channels"
              element={<SettingsRedirect from="/channels" to="/settings/apps/messaging" />}
            />
            <Route
              path="computers/*"
              element={<SettingsRedirect from="/computers" to="/settings/computers" />}
            />
            <Route
              path="triggers"
              element={<SettingsRedirect from="/triggers" to="/automations" />}
            />
            <Route path="automations" element={<AutomationsPage />} />
            <Route path="automations/new" element={<AutomationEditorPage />} />
            <Route path="automations/:triggerId" element={<AutomationDetailPage />} />
            <Route path="automations/:triggerId/edit" element={<AutomationEditorPage />} />
            <Route path="settings" element={<SettingsShell />}>
              <Route
                index
                element={<SettingsRedirect from="/settings" to="/settings/ai-engines" />}
              />
              <Route path="ai-engines" element={<SettingsSectionRoute section="ai-engines" />} />
              <Route path="account" element={<SettingsSectionRoute section="account" />} />
              <Route path="general" element={<SettingsSectionRoute section="general" />} />
              <Route
                path="connections"
                element={<SettingsRedirect from="/settings/connections" to="/settings/account" />}
              />
              <Route path="devices" element={<SettingsSectionRoute section="devices" />} />
              <Route path="chrome" element={<SettingsSectionRoute section="chrome" />} />
              <Route
                path="browser-profiles"
                element={<SettingsSectionRoute section="browser-profiles" />}
              />
              <Route path="passwords" element={<SettingsSectionRoute section="passwords" />} />
              <Route
                path="remote-access"
                element={<SettingsRedirect from="/settings/remote-access" to="/settings/devices" />}
              />
              <Route
                path="this-device"
                element={<SettingsRedirect from="/settings/this-device" to="/settings/devices" />}
              />
              <Route
                path="integrations"
                element={
                  <SettingsRedirect from="/settings/integrations" to="/settings/apps/tools" />
                }
              />
              <Route path="apps" element={<ConnectedAppsLayout />}>
                <Route
                  index
                  element={<SettingsRedirect from="/settings/apps" to="/settings/apps/tools" />}
                />
                <Route path="tools" element={<IntegrationsPage embedded />} />
                <Route path="messaging" element={<ChannelsPage embedded />} />
              </Route>
              <Route path="computers" element={<ComputersPage />} />
              <Route path="computers/:computerId" element={<ComputerDetailPage />} />
              <Route path="*" element={<SettingsNotFound />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}

/**
 * Starts a Host OIDC sign-in on whichever surface can actually finish it.
 *
 * Desktop forbids renderer navigation to a Host origin, so the redirect the
 * Host hands back would dead-end there; the native authorization flow completes
 * the same sign-in in the system browser. Browsers keep the redirect. Resolves
 * true when the caller's page is navigating away.
 */
export async function startHostOidcSignIn(input: {
  readonly deploymentId: DesktopSelectDeploymentInput["deploymentId"] | null;
  readonly desktopBridge: Pick<OpensteerDesktopBridge, "select"> | null;
  readonly hostClient: Pick<HostClient, "rpc">;
  readonly navigate: (url: string) => void;
  readonly oauthQuery: string | null;
  readonly providerId: string;
}): Promise<boolean> {
  if (input.desktopBridge) {
    if (input.deploymentId === null) {
      throw new Error("This app has no selected deployment to authorize.");
    }
    await input.desktopBridge.select({ deploymentId: input.deploymentId });
    return false;
  }
  input.navigate(
    unwrapRpcResult(
      await input.hostClient.rpc["auth.oidc.begin"]({
        ...(input.oauthQuery ? { oauthQuery: input.oauthQuery } : {}),
        providerId: input.providerId,
        returnPath: "/",
      }),
    ).redirectUrl,
  );
  return true;
}

/**
 * The boot and hand-off screen. `quiet` is for the moments that are a redirect
 * rather than a wait — an automatic OIDC start, a setup code being exchanged —
 * where the screen should stay out of the way if it is about to be replaced,
 * and still explain itself if it is not.
 */
function Splash({
  children,
  detail,
  quiet = false,
}: {
  children?: React.ReactNode;
  detail: string;
  quiet?: boolean;
}) {
  return (
    <main className={quiet ? "splash splash--quiet" : "splash"}>
      <div className="splash__inner">
        <BrandMark large />
        <p className="splash__detail">{detail}</p>
        {children}
      </div>
    </main>
  );
}

function isInvitationPath(pathname: string): boolean {
  return /^\/invite\/[A-Za-z0-9_-]{24,96}$/u.test(pathname);
}

function hasRecentAutoOidcAttempt(): boolean {
  try {
    const stored = window.sessionStorage.getItem(autoOidcAttemptKey);
    if (stored === null) return false;
    const attemptedAt = Number(stored);
    const age = Date.now() - attemptedAt;
    return Number.isFinite(attemptedAt) && age >= 0 && age < autoOidcAttemptWindowMs;
  } catch {
    return true;
  }
}

function recordAutoOidcAttempt(): boolean {
  try {
    window.sessionStorage.setItem(autoOidcAttemptKey, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

function clearAutoOidcAttempt(): boolean {
  try {
    window.sessionStorage.removeItem(autoOidcAttemptKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the first-owner code out of the opening URL and removes it from history
 * in the same turn.
 *
 * A Host reachable only from its own machine opens the browser on this URL so
 * nobody has to carry the code by hand. It rides in the fragment, which is never
 * transmitted with the request, and is replaced immediately so it does not
 * survive in the address bar, session history, or a shared screenshot.
 */
function takeSetupToken(): string | null {
  if (window.location.pathname !== "/setup") return null;
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  window.history.replaceState(null, "", "/");
  return token && token.length >= 16 ? token : null;
}

/** Password-recovery secrets receive the same fragment-only treatment as setup codes. */
function takeRecoveryToken(): string | null {
  if (window.location.pathname !== "/recover") return null;
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  window.history.replaceState(null, "", "/recover");
  return token && /^olpr_[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}
