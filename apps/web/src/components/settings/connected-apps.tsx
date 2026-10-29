import { NavLink, Outlet } from "react-router";
import { useShell } from "../app-shell.js";
import { PageTopbar } from "../page-header.js";

/**
 * One home for external connections, with separate surfaces for the two kinds
 * of authority they grant. Apps agents can use authorize capabilities a
 * Workspace may use; chat connections admit people and route conversations.
 *
 * The routes are unchanged — `tools` and `messaging` are what every existing
 * link, callback and bookmark names — and only the words a person reads say
 * what each surface is for.
 */
export function ConnectedAppsLayout() {
  const shell = useShell();

  return (
    <div className="page connected-apps">
      <PageTopbar onOpenNavigation={shell.openMobileNavigation} title="Connected apps" />
      <div className="connected-apps__inner">
        <header className="connected-apps__header">
          <h1 className="connected-apps__title">Connected apps</h1>
          <p className="connected-apps__description">
            Connect the apps your agents work in, and the places people message them. Each keeps its
            own permissions and access.
          </p>
        </header>
        <nav aria-label="Connected apps" className="connected-apps-tabs">
          <NavLink
            className={({ isActive }) =>
              isActive ? "connected-apps-tabs__item is-active" : "connected-apps-tabs__item"
            }
            to="tools"
          >
            Apps agents can use
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              isActive ? "connected-apps-tabs__item is-active" : "connected-apps-tabs__item"
            }
            to="messaging"
          >
            Messaging
          </NavLink>
        </nav>
        <div className="connected-apps__content">
          <Outlet context={shell} />
        </div>
      </div>
    </div>
  );
}
