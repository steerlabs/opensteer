import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useShell, type ShellContext } from "../app-shell.js";
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
import { AccountSection } from "./sections/account.js";
import { AiEnginesSection } from "./sections/ai-engines.js";
import { ChromeSection } from "./sections/chrome.js";
import { DevicesSettings } from "./sections/devices.js";
import { GeneralSection } from "./sections/general.js";
import { PasswordsSection } from "./sections/passwords.js";

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
    hostsDeployment(machine, shell.snapshot.deploymentShape?.kind ?? null),
  );
  if (!view || !context)
    return (
      <p className="settings-footnote" role="status">
        Loading settings…
      </p>
    );
  const rail = settingsRail(view.kind);
  const place = settingsPlace({
    cloud: identity?.deployment.cloud === true,
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
          <div
            aria-labelledby="settings-navigation-agents"
            className="settings-navigation__group"
            role="group"
          >
            <span className="settings-navigation__caption" id="settings-navigation-agents">
              What agents can use
            </span>
            {rail.agents.map((item) => (
              <SettingsNavigationLink item={item} key={item.id} />
            ))}
          </div>
        </nav>
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
          <SettingsNavigationLink item={rail.devices} />
          <SettingsNavigationLink item={settingsItem("account", view.kind)} />
        </div>
      </aside>
      <div
        className="settings-layout__main"
        inert={mobile && navigationOpen}
        aria-hidden={mobile && navigationOpen}
      >
        <Outlet context={context} />
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

export function SettingsSectionRoute({
  section,
}: {
  readonly section: Exclude<SettingsSectionId, "apps" | "computers">;
}) {
  const { settingsView: view, openMobileNavigation } = useOutletContext<SettingsContext>();
  let content;
  switch (section) {
    case "ai-engines":
      content = <AiEnginesSection />;
      break;
    case "account":
      content = <AccountSection />;
      break;
    case "chrome":
      content = <ChromeSection />;
      break;
    case "passwords":
      content = <PasswordsSection view={view} />;
      break;
    case "general":
      content = <GeneralSection view={view} />;
      break;
    case "devices":
      content = <DevicesSettings view={view} />;
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
          <Link className="btn" to="/settings/ai-engines">
            AI services
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
