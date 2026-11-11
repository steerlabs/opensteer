import { hostDeploymentPolicy, isTeamPlace } from "@opensteer/client/host";
import {
  lazy,
  Suspense,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useOutletContext } from "react-router";
import {
  deploymentStatusLabel,
  type DeploymentStatusInfo,
} from "@opensteer/protocol/deployment-status";
import {
  deploymentConnectionStatusInfo,
  selectedDeploymentFrom,
} from "../../desktop/desktop-deployment-selection.js";
import { useMediaQuery } from "../../ui-utils.js";
import { ShellContext, useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { PageTopbar } from "../page-header.js";
import {
  settingsDeploymentName,
  settingsItem,
  settingsPlace,
  settingsRail,
  type SettingsRailItem,
  type SettingsSectionId,
} from "./copy.js";
import { computerGlyph, hostsDeployment } from "@opensteer/client/computers";
import { computerIcon } from "../computers/device-art.js";
import { SectionHeader, type SettingsView } from "./primitives.js";
import { ChannelsPage } from "../channels-page.js";
import { AgentDevicesSection } from "./sections/agent-devices.js";
import { SignedInDevicesSection } from "./sections/devices.js";
import { RemoteAccessSection } from "./sections/remote-access.js";
import { AccountSection } from "./sections/account.js";
import { AiEnginesSection } from "./sections/ai-engines.js";
import { AutomaticModelsSection } from "./sections/automatic-models.js";
import { BrowserProfilesSection } from "./sections/browser-profiles.js";
import { ChromeSection } from "./sections/chrome.js";
import { GeneralSection } from "./sections/general.js";
import { PasswordsSection } from "./sections/passwords.js";
import { PluginsSection } from "./sections/plugins.js";
import { TeamSettingsNavigation } from "../team/team-settings.js";

// Loaded with its page so connections cost nothing on attach.
const ExternalAgentsSection = lazy(() =>
  import("./sections/external-agents.js").then((module) => ({
    default: module.ExternalAgentsSection,
  })),
);

interface SettingsContext extends ShellContext {
  settingsView: SettingsView;
}

/** Settings owns its navigation and forwards the same Host session to every nested page. */
export function SettingsShell() {
  const shell = useShell();
  const location = useLocation();
  const mobile = useMediaQuery("(max-width: 900px)");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openNavigation = useCallback(() => setNavigationOpen(true), []);
  const deployment = selectedDeploymentFrom(shell.deploymentAccess, shell.desktopDeployment);
  const identity = shell.snapshot.identityConfig;
  const connection = shell.deploymentAccess?.deployments.find(({ id }) => id === deployment?.id);
  const kind = deployment?.kind ?? identity?.deployment.kind;
  const view = useMemo<SettingsView | null>(
    () =>
      kind
        ? {
            administrator: shell.snapshot.user?.instanceRole === "administrator",
            deployment,
            kind,
            deploymentPolicy: hostDeploymentPolicy(shell.snapshot),
            machineOwner: identity?.machineOwner === true,
            name: settingsDeploymentName({ deployment, identityConfig: identity }),
            facts: {
              desktop: shell.desktopBridge !== null,
              onThisComputer: deployment?.onThisComputer ?? false,
              remote:
                deployment?.access === "connect" ||
                deployment?.access === "private" ||
                (shell.desktopBridge === null &&
                  shell.snapshot.sessionSurface === "personal-remote"),
            },
            statusInfo: settingsStatus({
              connection: shell.snapshot.connection,
              desktopStatus: connection ? deploymentConnectionStatusInfo(connection) : null,
            }),
          }
        : null,
    [
      connection,
      deployment,
      identity,
      kind,
      hostDeploymentPolicy(shell.snapshot),
      shell.desktopBridge,
      shell.snapshot.connection,
      shell.snapshot.sessionSurface,
      shell.snapshot.user?.instanceRole,
    ],
  );
  const context = useMemo(
    () =>
      view
        ? ({
            ...shell,
            openMobileNavigation: openNavigation,
            settingsView: view,
          } satisfies SettingsContext)
        : null,
    [shell, openNavigation, view],
  );

  useEffect(() => setNavigationOpen(false), [location.pathname]);
  useEffect(() => {
    if (!mobile || !navigationOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [mobile, navigationOpen]);

  const home = shell.snapshot.machines.find((machine) =>
    hostsDeployment(machine, hostDeploymentPolicy(shell.snapshot) ?? null),
  );
  if (!view || !context)
    return (
      <p className="settings-footnote" role="status">
        Loading settings…
      </p>
    );
  const rail = settingsRail(view.kind);
  const team = isTeamPlace(shell.snapshot);
  const place = settingsPlace({
    facts: view.facts,
    homeIcon: home ? computerIcon(computerGlyph(home)) : null,
    kind: view.kind,
    publicOrigin: identity?.publicOrigin,
  });

  function trapNavigation(event: React.KeyboardEvent<HTMLElement>) {
    if (!mobile || !navigationOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setNavigationOpen(false);
      return;
    }
    if (event.key !== "Tab") return;
    const links = navigationRef.current?.querySelectorAll<HTMLElement>(
      "a[href],button:not([disabled])",
    );
    const first = links?.[0];
    const last = links?.[links.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <div className="settings-layout">
      {mobile && navigationOpen ? (
        <button
          className="settings-navigation__scrim"
          aria-label="Close settings navigation"
          onClick={() => setNavigationOpen(false)}
          type="button"
        />
      ) : null}
      <aside
        className={`settings-navigation${mobile && navigationOpen ? " settings-navigation--open" : ""}`}
        id="settings-navigation"
        ref={navigationRef}
        onKeyDown={trapNavigation}
        aria-label="Settings navigation"
      >
        <div className="settings-navigation__header">
          <button className="settings-navigation__back" onClick={shell.leaveSettings} type="button">
            <Icon name="arrow-left" />
            Back to conversations
          </button>
          <button
            className="settings-navigation__close icon-btn"
            ref={closeRef}
            onClick={() => setNavigationOpen(false)}
            aria-label="Close settings navigation"
            type="button"
          >
            <Icon name="close" />
          </button>
        </div>
        <h2 className="settings-navigation__title">Settings</h2>
        <nav className="settings-navigation__links" aria-label="Settings sections">
          {(["general", "account", "devices", "messaging", "external-agents"] as const)
            .filter((id) => !team || !absentOnTeamPlace.has(id))
            .map((id) => (
              <SettingsNavigationLink key={id} item={settingsItem(id, view.kind)} />
            ))}
          <div
            aria-labelledby="settings-navigation-agents"
            className="settings-navigation__group"
            role="group"
          >
            <span className="settings-navigation__caption" id="settings-navigation-agents">
              {team ? "For the team's projects" : "For your agents"}
            </span>
            {rail.agents
              .filter((item) => !team || !absentOnTeamPlace.has(item.id))
              .map((item) => (
                <SettingsNavigationLink item={item} key={item.id} />
              ))}
          </div>
          <TeamSettingsNavigation />
        </nav>
        {team ? (
          <p className="settings-navigation__elsewhere">
            Your own Chat, memory, sign-ins, apps and computers are in your own Opensteer.
          </p>
        ) : null}
        <div className="settings-navigation__account">
          <NavLink
            to="/settings/general"
            className={({ isActive }) =>
              `settings-navigation__link settings-navigation__connection${isActive ? " is-active" : ""}`
            }
            aria-label={`About ${view.name}`}
            title={view.name}
          >
            <span className="settings-navigation__place">
              <Icon name={place.icon} />
            </span>
            <span className="settings-navigation__connection-text">
              <span className="settings-navigation__connection-name">{view.name}</span>
              <span className="settings-navigation__connection-detail">{place.detail}</span>
            </span>
            <Icon name="chevron-right" />
          </NavLink>
          {view.statusInfo.status !== "ready" ? (
            <p className="settings-navigation__status" role="status">
              {view.statusInfo.reason ?? deploymentStatusLabel(view.statusInfo.status)}
            </p>
          ) : null}
        </div>
      </aside>
      <div
        className="settings-layout__main"
        inert={mobile && navigationOpen}
        aria-hidden={mobile && navigationOpen}
      >
        <ShellContext value={context}>
          <Outlet context={context} />
        </ShellContext>
      </div>
    </div>
  );
}

function SettingsNavigationLink({ item }: { readonly item: SettingsRailItem }) {
  return (
    <NavLink
      to={`/settings/${item.id}`}
      className={({ isActive }) => `settings-navigation__link${isActive ? " is-active" : ""}`}
    >
      <Icon name={item.icon} />
      <span>
        <span className="settings-navigation__label">{item.label}</span>
      </span>
    </NavLink>
  );
}

/**
 * Settings a team place doesn't have: no messaging, personal plugins, sign-ins
 * or computers. They are not drawn, and an address to one returns to Settings.
 */
const absentOnTeamPlace: ReadonlySet<string> = new Set([
  "devices",
  "messaging",
  "plugins",
  "sign-ins",
  "chrome",
  "browser-profiles",
  "passwords",
  "apps",
  "computers",
]);

export function SettingsSectionRoute({
  section,
}: {
  readonly section: Exclude<SettingsSectionId, "apps" | "computers">;
}) {
  const location = useLocation();
  const {
    settingsView: view,
    openMobileNavigation,
    hostClient,
    snapshot,
  } = useOutletContext<SettingsContext>();
  if (isTeamPlace(snapshot) && absentOnTeamPlace.has(section))
    return <Navigate replace to="/settings/general" />;
  let content;
  switch (section) {
    case "ai":
    case "ai-engines":
      content = (
        <>
          <AiEnginesSection />
          <AutomaticModelsSection />
        </>
      );
      break;
    case "account":
      content = location.pathname.includes("/remote-access") ? (
        <>
          <Link to="/settings/account">Account</Link>
          <RemoteAccessSection view={view} />
        </>
      ) : location.pathname.includes("/sessions/") ? (
        <>
          <Link to="/settings/account">Account</Link>
          <SignedInDevicesSection
            view={view}
            sessionId={decodeURIComponent(location.pathname.split("/sessions/")[1] ?? "")}
          />
        </>
      ) : (
        <>
          <AccountSection />
          {view.deploymentPolicy?.personalRemoteAccess === true && view.administrator ? (
            <RemoteAccessSection view={view} compact />
          ) : null}
          <SignedInDevicesSection view={view} />
        </>
      );
      break;
    case "external-agents":
      content = (
        <Suspense fallback={<p role="status">Loading external agents…</p>}>
          <ExternalAgentsSection client={hostClient} view={view} />
        </Suspense>
      );
      break;
    case "chrome":
      content = <ChromeSection />;
      break;
    case "browser-profiles":
      content = <BrowserProfilesSection />;
      break;
    case "passwords":
      content = <PasswordsSection view={view} />;
      break;
    case "plugins":
      content = <PluginsSection view={view} />;
      break;
    case "messaging":
      content = <ChannelsPage embedded />;
      break;
    case "sign-ins":
      content = (
        <>
          <ChromeSection />
          <BrowserProfilesSection />
          <PasswordsSection view={view} />
        </>
      );
      break;
    case "general":
      content = <GeneralSection view={view} />;
      break;
    case "devices":
      content = <AgentDevicesSection />;
      break;
  }
  return (
    <div className="page settings">
      <PageTopbar
        title={settingsItem(section, view.kind).label}
        onOpenNavigation={openMobileNavigation}
      />
      <div className="settings-content">
        <div className="settings-content__inner">{content}</div>
      </div>
    </div>
  );
}

export function SettingsNotFound() {
  const { openMobileNavigation } = useShell();
  return (
    <div className="page settings">
      <PageTopbar title="Settings" onOpenNavigation={openMobileNavigation} />
      <div className="settings-content">
        <div className="settings-content__inner">
          <SectionHeader
            title="Setting not found"
            lead="Choose a section from Settings to continue."
          />
          <Link className="btn" to="/settings/ai">
            AI
          </Link>
        </div>
      </div>
    </div>
  );
}

export function settingsStatus(input: {
  readonly connection: "connected" | "connecting" | "offline";
  readonly desktopStatus?: DeploymentStatusInfo | null;
}): DeploymentStatusInfo {
  if (input.desktopStatus) return input.desktopStatus;
  if (input.connection === "connected") return { reason: null, status: "ready" };
  if (input.connection === "connecting") return { reason: null, status: "starting" };
  return { reason: "This connection could not be reached.", status: "offline" };
}

/** A Settings page a team place doesn't have returns to Settings instead of rendering. */
export function PersonalOnlySettings({ children }: { readonly children: ReactNode }) {
  const { snapshot } = useShell();
  return isTeamPlace(snapshot) ? <Navigate replace to="/settings/general" /> : children;
}
