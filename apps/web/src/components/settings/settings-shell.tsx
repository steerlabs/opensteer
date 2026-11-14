import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, NavLink, Outlet, useLocation, useOutletContext } from "react-router";
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
  settingsPlaceDetail,
  settingsRail,
  type SettingsRailItem,
  type SettingsSectionId,
} from "./copy.js";
import { SectionHeader, type SettingsView } from "./primitives.js";
import { MessagingPage } from "../messaging-page.js";
import { DevicesSection } from "../devices/devices-page.js";
import { AccountSection } from "./sections/account.js";
import { AiEnginesSection } from "./sections/ai-engines.js";
import { IdleCompactionSection } from "./sections/idle-compaction.js";
import { AutomaticModelsSection } from "./sections/automatic-models.js";
import { BrowserProfilesSection } from "./sections/browser-profiles.js";
import { ChromeSection } from "./sections/chrome.js";
import { GeneralSection } from "./sections/general.js";
import { PasswordsSection } from "./sections/passwords.js";
import { PluginsSection } from "./sections/plugins.js";
import { TeamSettingsNavigation } from "../../team/team-settings-navigation.js";
import { TeamSettingsRoute } from "../../team/team-settings-route.js";

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
            deployment,
            kind,
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
      shell.desktopBridge,
      shell.snapshot.connection,
      shell.snapshot.sessionSurface,
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

  if (!view || !context)
    return (
      <p className="settings-footnote" role="status">
        Loading settings…
      </p>
    );
  const rail = settingsRail(view.kind);
  const placeDetail = settingsPlaceDetail({
    facts: view.facts,
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
            Back
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
        <nav className="settings-navigation__links" aria-label="Settings sections">
          {(["general", "account", "devices", "messaging", "external-agents"] as const).map(
            (id) => (
              <SettingsNavigationLink key={id} item={settingsItem(id, view.kind)} />
            ),
          )}
          <div
            aria-labelledby="settings-navigation-agents"
            className="settings-navigation__group"
            role="group"
          >
            <span className="settings-navigation__caption" id="settings-navigation-agents">
              For your agents
            </span>
            {rail.agents.map((item) => (
              <SettingsNavigationLink item={item} key={item.id} />
            ))}
          </div>
          <TeamSettingsNavigation />
        </nav>
        <div className="settings-navigation__account">
          <Link
            to="/settings/general"
            className="settings-navigation__connection"
            aria-label={`About ${view.name}`}
            title={view.name}
          >
            <span className="settings-navigation__connection-name">{view.name}</span>
            <span className="settings-navigation__connection-detail">{placeDetail}</span>
          </Link>
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
      {item.label}
    </NavLink>
  );
}

export function SettingsSectionRoute({
  section,
}: {
  readonly section: Exclude<SettingsSectionId, "apps" | "computers">;
}) {
  const { settingsView: view, hostClient } = useOutletContext<SettingsContext>();
  let content;
  switch (section) {
    case "ai":
    case "ai-engines":
      content = (
        <>
          <AiEnginesSection />
          <IdleCompactionSection />
          <AutomaticModelsSection />
        </>
      );
      break;
    case "account":
      content = <AccountSection />;
      break;
    case "external-agents":
      content = (
        <Suspense fallback={<p role="status">Loading external agents…</p>}>
          <ExternalAgentsSection client={hostClient} view={view} />
        </Suspense>
      );
      break;
    case "chrome":
      content = (
        <>
          <SectionHeader title={settingsItem(section, view.kind).label} />
          <ChromeSection />
        </>
      );
      break;
    case "browser-profiles":
      content = (
        <>
          <SectionHeader title={settingsItem(section, view.kind).label} />
          <BrowserProfilesSection />
        </>
      );
      break;
    case "passwords":
      content = (
        <>
          <SectionHeader title={settingsItem(section, view.kind).label} />
          <PasswordsSection view={view} />
        </>
      );
      break;
    case "plugins":
      content = <PluginsSection view={view} />;
      break;
    case "messaging":
      content = <MessagingPage embedded />;
      break;
    case "sign-ins":
      content = (
        <>
          <SectionHeader title="Sign-ins" />
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
      content = <DevicesSection />;
      break;
  }
  return <SettingsPage title={settingsItem(section, view.kind).label}>{content}</SettingsPage>;
}

/** A routed Settings page: the narrow-window topbar, then one scrolling column. */
export function SettingsPage({
  children,
  title,
}: {
  readonly children: ReactNode;
  readonly title: string;
}) {
  const { openMobileNavigation } = useShell();
  return (
    <div className="page settings">
      <PageTopbar title={title} onOpenNavigation={openMobileNavigation} />
      <div className="settings-content">
        <div className="settings-content__inner">{children}</div>
      </div>
    </div>
  );
}

/** A team's pages inside personal Settings. */
export function SettingsTeamRoute() {
  return (
    <SettingsPage title="Team">
      <TeamSettingsRoute />
    </SettingsPage>
  );
}

export function SettingsNotFound() {
  return (
    <SettingsPage title="Settings">
      <SectionHeader title="Setting not found" lead="Choose a section from Settings to continue." />
      <Link className="btn" to="/settings/ai">
        AI
      </Link>
    </SettingsPage>
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
