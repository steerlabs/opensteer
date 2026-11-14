import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useParams } from "react-router";
import { parseTeamPageLink, teamPageAppLink, type TeamPageLink } from "@opensteer/core";
import { createHttpHostApiClient } from "@opensteer/client/host";
import {
  bootstrapMembershipRefused,
  teamApiVersion,
  teamApiVersionHeader,
  type TeamBootstrapSchema,
} from "@opensteer/protocol";
import type { z } from "zod";
import { startHostOidcSignIn } from "../account/host-oidc.js";
import { NativeOAuthConsent, useNativeOAuthQuery } from "../account/native-oauth-consent.js";
import { consumeOAuthErrorQuery } from "../account/auth-error-query.js";
import { Icon } from "../components/icon.js";
import { ErrorNotice, OnboardingCard } from "../components/onboarding-card.js";
import { ToastProvider } from "../components/toast.js";
import { useWorkspaceNavigation } from "../components/workspace/navigation.js";
import { WorkspaceProvider } from "../components/workspace/workspace-context.js";
import { TeamsProvider, createTeamWebAttachment, type TeamAttachment } from "./team-attachments.js";
import { channelPath, teamPath } from "./team-paths.js";
import { TeamPaneGate } from "./team-pane-gate.js";
import { TeamRoutes } from "./team-routes.js";
import { TeamDialogsProvider } from "./hosted-teams.js";
import { TeamSettingsRoute } from "./team-settings-route.js";
import { TeamSideFor, LeaveTeamDialog } from "./team-sidebar-sections.js";

type TeamBootstrap = z.infer<typeof TeamBootstrapSchema>;
type Entry =
  | { readonly kind: "loading" }
  | { readonly kind: "signed-out"; readonly setUp: boolean }
  | { readonly kind: "ready"; readonly bootstrap: TeamBootstrap }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "not-member" };

const versionHeaders = { [teamApiVersionHeader]: String(teamApiVersion) };

/** The channel or message a shared link on this origin names, if the address is one. */
function sharedLink(): TeamPageLink | null {
  const link = parseTeamPageLink(window.location.href);
  return link && link.target.kind !== "invite" ? link : null;
}

async function readEntry(): Promise<Entry> {
  let signedOut = false;
  const rpc = createHttpHostApiClient({
    baseUrl: new URL(window.location.origin),
    fetch: globalThis.fetch.bind(globalThis),
    kind: "team",
    onAuthenticationRequired: () => {
      signedOut = true;
    },
  });
  const result = await rpc["team.bootstrap.get"]({});
  if (result.ok) return { kind: "ready", bootstrap: result.data };
  if (bootstrapMembershipRefused(result.error)) return { kind: "not-member" };
  if (!signedOut) return { kind: "failed", message: result.error.message };
  const state = await fetch("/v1/team/setup/state", { headers: versionHeaders });
  const setUp = state.ok && ((await state.json()) as { complete?: unknown }).complete === true;
  return { kind: "signed-out", setUp };
}

/**
 * The web bundle on a team's own origin: that team only. Setup and invite
 * links are the team Host's own pages; this app signs a member in and shows
 * the team.
 */
export function TeamWebApp() {
  const nativeOAuthQuery = useNativeOAuthQuery();
  const [authorizationError] = useState(() =>
    consumeOAuthErrorQuery(window.location, (url) => window.history.replaceState(null, "", url)),
  );
  const rpc = useMemo(
    () =>
      createHttpHostApiClient({
        baseUrl: new URL(window.location.origin),
        fetch: globalThis.fetch.bind(globalThis),
        kind: "team",
        onAuthenticationRequired: () => undefined,
      }),
    [],
  );
  const [entry, setEntry] = useState<Entry>({ kind: "loading" });
  useEffect(() => {
    void readEntry()
      .then(setEntry)
      .catch(() => setEntry({ kind: "failed", message: "The team server can’t be reached." }));
  }, []);
  const [link] = useState(sharedLink);
  const [continued, setContinued] = useState(false);
  if (authorizationError)
    return (
      <OnboardingCard
        title="Authorization couldn’t finish"
        description="Close this browser and start sign-in again in the Opensteer app."
      >
        <ErrorNotice message={authorizationError.description ?? authorizationError.error} />
      </OnboardingCard>
    );
  if (entry.kind === "ready" && nativeOAuthQuery)
    return <NativeOAuthConsent oauthQuery={nativeOAuthQuery} rpc={rpc} />;
  if (entry.kind === "loading") return null;
  if (link && !continued)
    return (
      <SharedLinkLanding
        link={link}
        onContinue={() => setContinued(true)}
        signedIn={entry.kind === "ready"}
      />
    );
  if (entry.kind === "signed-out")
    return <TeamSignIn setUp={entry.setUp} oauthQuery={nativeOAuthQuery} rpc={rpc} />;
  if (entry.kind === "not-member")
    return (
      <OnboardingCard
        title="You aren’t in this team"
        description="Ask a team member for a new invite, then open it here."
      >
        <div className="onboarding__actions">
          <button className="btn" onClick={() => window.location.reload()} type="button">
            Try again
          </button>
        </div>
      </OnboardingCard>
    );
  if (entry.kind === "failed")
    return (
      <OnboardingCard title="This team can’t open">
        <ErrorNotice message={entry.message} />
        <div className="onboarding__actions">
          <button className="btn" onClick={() => window.location.reload()} type="button">
            Try again
          </button>
        </div>
      </OnboardingCard>
    );
  return <TeamWebSession bootstrap={entry.bootstrap} link={link} />;
}

function SharedLinkLanding({
  link,
  onContinue,
  signedIn,
}: {
  readonly link: TeamPageLink;
  readonly onContinue: () => void;
  readonly signedIn: boolean;
}) {
  return (
    <OnboardingCard
      description="Open it in the Opensteer app, where your own agent can help with it, or read it here."
      title={link.target.kind === "message" ? "A message from your team" : "A channel in your team"}
    >
      <div className="onboarding__actions">
        <a className="btn btn--primary" href={teamPageAppLink(link, "desktop")}>
          Open in Opensteer
        </a>
        <button className="btn" onClick={onContinue} type="button">
          {signedIn ? "Continue in this browser" : "Sign in here instead"}
        </button>
      </div>
    </OnboardingCard>
  );
}

function TeamSignIn({
  setUp,
  oauthQuery,
  rpc,
}: {
  readonly setUp: boolean;
  readonly oauthQuery: string | null;
  readonly rpc: ReturnType<typeof createHttpHostApiClient>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!setUp)
    return (
      <OnboardingCard
        description="Open the setup link the team server printed when it started. It makes you the team’s first owner."
        title="This team isn’t set up yet"
      />
    );
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await startHostOidcSignIn({
        desktopBridge: null,
        deploymentId: null,
        hostClient: { rpc },
        navigate: (url) => window.location.assign(url),
        oauthQuery,
        providerId: "opensteer-account",
      });
    } catch (failure) {
      setBusy(false);
      setError(
        `${failure instanceof Error ? failure.message : "Sign-in couldn’t start."}${oauthQuery ? " Close this browser and start sign-in again in the Opensteer app." : ""}`,
      );
    }
  };
  return (
    <OnboardingCard
      description="Your team uses Opensteer Account to sign in. Your own agent and files stay on your computer."
      title="Sign in to your team"
    >
      <ErrorNotice message={error} />
      <div className="onboarding__actions">
        <button
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void signIn()}
          type="button"
        >
          {busy ? "Opening Opensteer Account…" : "Continue with Opensteer Account"}
        </button>
      </div>
    </OnboardingCard>
  );
}

function TeamWebSession({
  bootstrap,
  link,
}: {
  readonly bootstrap: TeamBootstrap;
  readonly link: TeamPageLink | null;
}) {
  const attachment = useMemo(() => createTeamWebAttachment(bootstrap), [bootstrap]);
  // The session lives as long as the page: React's double effects must not end it.
  useEffect(() => {
    const dispose = () => attachment.client?.dispose();
    window.addEventListener("pagehide", dispose, { once: true });
    return () => window.removeEventListener("pagehide", dispose);
  }, [attachment]);
  const surface = useMemo(() => ({ kind: "team-web" as const, attachment }), [attachment]);
  const first = bootstrap.sidebar.channels[0]?.channel.id ?? null;
  const landing =
    link && link.target.kind !== "invite"
      ? channelPath(bootstrap.teamId, link.target.channelId, {
          messageId: link.target.kind === "message" ? link.target.messageId : null,
        })
      : first
        ? channelPath(bootstrap.teamId, first)
        : teamPath(bootstrap.teamId, "browse");
  return (
    <ToastProvider>
      <TeamsProvider surface={surface}>
        <BrowserRouter>
          <TeamDialogsProvider>
            <TeamWebShell landing={landing} team={attachment} userId={bootstrap.member.userId} />
          </TeamDialogsProvider>
        </BrowserRouter>
      </TeamsProvider>
    </ToastProvider>
  );
}

function TeamWebShell({
  landing,
  team,
  userId,
}: {
  readonly landing: string;
  readonly team: TeamAttachment;
  readonly userId: string;
}) {
  const nav = useWorkspaceNavigation({ deploymentId: team.teamId, userId });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const ended = useSyncExternalStore(
    team.client!.subscribe,
    () => team.client!.getSnapshot().ended,
  );
  if (ended) return <TeamPaneGate teamId={team.teamId}>{null}</TeamPaneGate>;
  const close = () => setDrawerOpen(false);
  return (
    <WorkspaceProvider attention={0} nav={nav} openDrawer={() => setDrawerOpen(true)}>
      <div className="app-shell" style={{ "--sidebar-width": "280px" } as CSSProperties}>
        {drawerOpen ? (
          <button
            aria-label="Close navigation"
            className="sidebar-scrim"
            onClick={close}
            type="button"
          />
        ) : null}
        <nav
          aria-label="Team navigation"
          className={drawerOpen ? "sidebar sidebar--open" : "sidebar"}
          id="app-sidebar"
        >
          <div className="sidebar__header">
            <h1 className="sidebar__title">{team.name}</h1>
            <Link
              aria-label="Team settings"
              className="icon-btn"
              onClick={close}
              title="Team settings"
              to={`/settings/teams/${encodeURIComponent(team.teamId)}/profile`}
            >
              <Icon name="settings" />
            </Link>
            <button
              className="icon-btn"
              aria-label={`Leave ${team.name}`}
              onClick={() => setLeaving(true)}
              type="button"
            >
              <Icon name="log-out" />
            </button>
          </div>
          {leaving ? (
            <LeaveTeamDialog
              team={team}
              onClose={() => setLeaving(false)}
              onLeft={() => setLeaving(false)}
            />
          ) : null}
          <section aria-label="Team" className="side-section side-section--tasks">
            <TeamSideFor onNavigate={close} teamId={team.teamId} />
          </section>
        </nav>
        <main className="app-shell__main">
          <Routes>
            <Route index element={<Navigate replace to={landing} />} />
            <Route path="teams/:teamId/*" element={<TeamRoutes />} />
            <Route path="settings/teams/:teamId/:page" element={<TeamSettingsPage />} />
            <Route path="*" element={<Navigate replace to={landing} />} />
          </Routes>
        </main>
      </div>
    </WorkspaceProvider>
  );
}

function TeamSettingsPage() {
  const { page } = useParams();
  return (
    <div className="thread team-page" key={page}>
      <div className="team-page__body">
        <TeamSettingsRoute />
      </div>
    </div>
  );
}
