import { lazy, Suspense } from "react";
import { subscribeIntegrationAuthorizationReturns } from "./integrations/integration-authorization.js";
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
import { HomeRoute } from "./components/home/home-route.js";
import { VoiceRoute } from "./components/voice-route.js";
import { LiveRedirect } from "./components/workspace/live-redirect.js";
import { ThreadRoute } from "./components/thread-view.js";
import { TeamsProvider, type TeamAttachment } from "./team/team-attachments.js";
import { mockAccountEmail, mockAccountSubject, type MockTeamWorld } from "@opensteer/client/team";
import { TeamRoutes } from "./team/team-routes.js";
import { JoinTeamRoute, TeamsRoute } from "./team/join-route.js";
import { TeamDialogsProvider } from "./team/hosted-teams.js";
import { AutomationDetailPage } from "./components/automations/automation-detail.js";
import { AutomationEditorPage } from "./components/automations/automation-editor.js";
import { AutomationsPage } from "./components/automations/automations-page.js";
import {
  SettingsShell,
  SettingsSectionRoute,
  SettingsNotFound,
  SettingsTeamRoute,
} from "./components/settings/settings-shell.js";
import { SettingsRedirect } from "./components/settings/settings-redirect.js";
import { settingsRedirects } from "@opensteer/client/settings";
import type {
  DeploymentAccessSnapshot,
  DesktopDeploymentSummary,
  DesktopNotificationTarget,
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
import { NativeOAuthConsent, useNativeOAuthQuery } from "./account/native-oauth-consent.js";
import { startHostOidcSignIn } from "./account/host-oidc.js";
export { startHostOidcSignIn } from "./account/host-oidc.js";
import { SetupOpening } from "./components/first-run/setup-opening.js";
import { setupPath } from "./components/workspace/navigation.js";
import { SetupPage } from "./components/first-run/setup-page.js";
import { ToastProvider } from "./components/toast.js";
import { DesktopUpdateFeedback } from "./components/desktop-update-button.js";
import { actionErrorMessage } from "./ui-utils.js";
import { shouldAutoStartOidc } from "./account/auto-oidc.js";
import { IntegrationAuthorizationCompletion } from "./components/integration-authorization-completion.js";
import { DevicePage } from "./components/devices/device-page.js";

const McpAuthorization = lazy(() =>
  import("./components/mcp-authorization.js").then((module) => ({
    default: module.McpAuthorization,
  })),
);

const McpAuthorizationLaunch = lazy(() =>
  import("./components/mcp-authorization.js").then((module) => ({
    default: module.McpAuthorizationLaunch,
  })),
);

const autoOidcAttemptKey = "opensteer.oidc.auto-attempt";
const autoOidcAttemptWindowMs = 2 * 60 * 1_000;

export function App({
  mcpAuthorizationRequestId = null,
  onMcpAuthorizationClosed,
  deploymentAccess = null,
  desktopBridge = null,
  desktopDeployment = null,
  hostClient,
  onNotificationTargetOpened,
  notificationTarget = null,
  onSetupOpened,
  openSetup = false,
  preview = null,
}: {
  readonly mcpAuthorizationRequestId?: string | null;
  readonly onMcpAuthorizationClosed?: (() => void) | undefined;
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
  /** Told once setup has taken over the window, so it is not opened again. */
  readonly onSetupOpened?: (() => void) | undefined;
  /** This computer was set up in this window, so setup continues as the app opens. */
  readonly openSetup?: boolean;
  /** The mock build's team sessions and hosted-teams world; never set against a real Host. */
  readonly preview?: {
    readonly teams: readonly TeamAttachment[];
    readonly world: MockTeamWorld;
  } | null;
}) {
  const { loadError, reload, snapshot } = useHostSnapshot(hostClient, sameAppGateSnapshot);
  useEffect(
    () =>
      desktopBridge
        ? subscribeIntegrationAuthorizationReturns(desktopBridge, hostClient)
        : undefined,
    [desktopBridge, hostClient],
  );
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingPending, setOnboardingPending] = useState(false);
  const autoOidcStarted = useRef(false);
  const [autoOidcSuppressed, setAutoOidcSuppressed] = useState(hasRecentAutoOidcAttempt);
  const [refreshing, setRefreshing] = useState(false);
  // Captured once, during the first render, so the code leaves the URL before
  // anything can paint it or persist it in history.
  const [setupToken] = useState(takeSetupToken);
  // Setup carries on into the app it just set up. The address is chosen before
  // the router first reads it, so Home never mounts underneath setup and a
  // notification the window was opened for still wins.
  useState(() => {
    if (openSetup && window.location.pathname === "/" && notificationTarget === null) {
      window.history.replaceState(window.history.state, "", setupPath + window.location.search);
    }
  });
  // Setup stays on screen through the session and settings waits below, and
  // hands back only once the app it continues into can draw.
  const [continuingSetup, setContinuingSetup] = useState(openSetup);
  const shellReady = snapshot.session === "authenticated" && snapshot.personalSettings !== null;
  useEffect(() => {
    if (!continuingSetup || !shellReady) return;
    setContinuingSetup(false);
    onSetupOpened?.();
  }, [continuingSetup, onSetupOpened, shellReady]);
  const [recoveryToken] = useState(takeRecoveryToken);
  const nativeOAuthQuery = useNativeOAuthQuery();
  const [authorizationError, setAuthorizationError] = useState(() =>
    consumeOAuthErrorQuery(window.location, (url) => window.history.replaceState(null, "", url)),
  );
  const [setupAdmission, setSetupAdmission] = useState<
    "absent" | "admitted" | "exchanging" | "rejected"
  >(setupToken ? "exchanging" : "absent");
  const [setupExchangeAttempt, setSetupExchangeAttempt] = useState(0);
  const [setupExchangeError, setSetupExchangeError] = useState<string | null>(null);
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
      setOnboardingError(
        nativeOAuthQuery
          ? `${actionErrorMessage(error)} You can close this browser and start sign-in again in the Opensteer app.`
          : actionErrorMessage(error),
      );
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

  if (
    snapshot.session === "authentication-required" &&
    snapshot.identityConfig?.machineOwner &&
    window.location.pathname === "/mcp-authorization"
  ) {
    return (
      <Suspense fallback={<p>Opening agent connection…</p>}>
        <McpAuthorizationLaunch
          requestId={new URLSearchParams(window.location.search).get("request")}
          deploymentId={new URLSearchParams(window.location.search).get("deploymentId")}
        />
      </Suspense>
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
    if (continuingSetup && !loadError) {
      return <SetupOpening />;
    }
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

  if (nativeOAuthQuery)
    return <NativeOAuthConsent oauthQuery={nativeOAuthQuery} rpc={hostClient.rpc} />;

  // This tab is opened before an attempt exists so the browser sees the open
  // as part of the person's click. The provider return reloads the same route
  // with only the opaque durable-attempt id in its query.
  if (mcpAuthorizationRequestId || window.location.pathname === "/mcp-authorization")
    return (
      <Suspense fallback={<p role="status">Loading connection request…</p>}>
        <McpAuthorization
          client={hostClient}
          requestId={
            mcpAuthorizationRequestId ?? new URLSearchParams(window.location.search).get("request")
          }
          desktopBridge={desktopBridge}
          onClose={onMcpAuthorizationClosed}
        />
      </Suspense>
    );

  if (window.location.pathname === "/integration-authorization") {
    return (
      <IntegrationAuthorizationCompletion
        client={hostClient}
        integrationAttempt={new URLSearchParams(window.location.search).get("integrationAttempt")}
      />
    );
  }

  // The Host writes this person's settings (the agent's home folder) on first
  // sign-in, so their absence is a moment on a first run, never an empty app.
  if (snapshot.personalSettings === null) {
    if (continuingSetup && !loadError) {
      return <SetupOpening />;
    }
    return (
      <Splash detail={loadError ?? "Preparing your agent’s home…"}>
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
      <DesktopUpdateFeedback />
      <TeamsProvider
        account={
          preview
            ? { subject: mockAccountSubject, email: mockAccountEmail }
            : deploymentAccess?.account.status === "signed-in" && deploymentAccess.account.subject
              ? {
                  subject: deploymentAccess.account.subject,
                  email: deploymentAccess.account.email ?? null,
                }
              : null
        }
        accountTeams={
          preview
            ? preview.world.memberships()
            : (deploymentAccess?.deployments ?? [])
                .filter(
                  (deployment) => deployment.kind === "team" && deployment.accountAccess !== null,
                )
                .map((deployment) => ({
                  teamDeploymentId: deployment.id,
                  origin: deployment.canonicalOrigin,
                  name: deployment.name,
                }))
        }
        surface={
          preview
            ? { kind: "preview", hostClient, teams: preview.teams, world: preview.world }
            : desktopBridge
              ? { kind: "desktop", hostClient, bridge: desktopBridge }
              : { kind: "personal-web", hostClient }
        }
      >
        <BrowserRouter>
          <TeamDialogsProvider>
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
                <Route path="tasks/:threadId" element={<ThreadRoute />} />
                <Route path="voice" element={<VoiceRoute />} />
                <Route path="teams" element={<TeamsRoute />} />
                <Route path="teams/:teamId/*" element={<TeamRoutes />} />
                <Route path="join" element={<JoinTeamRoute />} />
                <Route path="live" element={<LiveRedirect />} />
                <Route path="get-started" element={<SetupPage />} />
                <Route
                  path="channels"
                  element={<SettingsRedirect from="/channels" to="/settings/messaging" />}
                />
                <Route
                  path="computers/*"
                  element={<SettingsRedirect from="/computers" to="/settings/devices" />}
                />
                <Route
                  path="triggers"
                  element={<SettingsRedirect from="/triggers" to="/automations" />}
                />
                <Route path="automations" element={<AutomationsPage />} />
                <Route path="automations/:triggerId" element={<AutomationDetailPage />} />
                <Route path="automations/:triggerId/edit" element={<AutomationEditorPage />} />
                <Route path="settings" element={<SettingsShell />}>
                  <Route
                    index
                    element={<SettingsRedirect from="/settings" to="/settings/general" />}
                  />
                  {(
                    [
                      "general",
                      "account",
                      "messaging",
                      "external-agents",
                      "ai",
                      "plugins",
                      "sign-ins",
                    ] as const
                  ).map((section) => (
                    <Route
                      key={section}
                      path={`${section}/*`}
                      element={<SettingsSectionRoute section={section} />}
                    />
                  ))}
                  <Route path="teams/:teamId/:page" element={<SettingsTeamRoute />} />
                  <Route path="devices" element={<SettingsSectionRoute section="devices" />} />
                  <Route path="devices/:deviceId" element={<DevicePage />} />
                  <Route
                    path="sign-ins/chrome/*"
                    element={<SettingsSectionRoute section="chrome" />}
                  />
                  <Route
                    path="sign-ins/browsers/*"
                    element={<SettingsSectionRoute section="browser-profiles" />}
                  />
                  <Route
                    path="sign-ins/passwords/*"
                    element={<SettingsSectionRoute section="passwords" />}
                  />
                  {settingsRedirects
                    .filter(([from]) => from.startsWith("/settings/"))
                    .map(([from, to]) => (
                      <Route
                        key={from}
                        path={`${from.slice(10)}/*`}
                        element={<SettingsRedirect from={from} to={to} />}
                      />
                    ))}
                  <Route path="*" element={<SettingsNotFound />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </TeamDialogsProvider>
        </BrowserRouter>
      </TeamsProvider>
    </ToastProvider>
  );
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
