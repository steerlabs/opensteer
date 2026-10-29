import type {
  IntegrationConnectionSummary,
  IntegrationDashboard,
} from "@opensteer/integration-core";
import type { MachineSummary } from "@opensteer/protocol";
import {
  computerAppAccessLabel,
  computerAppConnectionLabel,
  computerAppStateDotClass,
  computerAppStateLabel,
  computerConnectionState,
} from "@opensteer/client/integrations";
import { Link } from "react-router";
import { computerAppRoute } from "../computers-page.js";
import type { DefinedIntegration } from "./helpers.js";
import { IntegrationIcon } from "./integration-icon.js";

/**
 * Apps agents can use on a computer, listed by the only identity they have:
 * the app and the computer it runs on.
 *
 * They are not accounts. There is no credential, nothing to reauthorize, and
 * no provider to name — what there is, is one computer's permission, so they
 * are listed apart from the accounts and each row goes to the one editor that
 * owns it rather than carrying a second copy of the same control.
 */
export function ComputerAppConnectionsSection({
  dashboard,
  integrations,
  machines,
}: {
  readonly dashboard: IntegrationDashboard | null;
  readonly integrations: readonly DefinedIntegration[];
  readonly machines: readonly MachineSummary[];
}) {
  const rows = (dashboard?.connections ?? []).flatMap((connection) => {
    if (connection.status === "revoked" || !connection.computer) return [];
    const definition =
      integrations.find(({ definition: candidate }) => candidate.id === connection.definitionId)
        ?.definition ?? null;
    const presentation = definition?.computerApp;
    return definition && presentation
      ? [{ connection, computer: connection.computer, definition, presentation }]
      : [];
  });
  if (rows.length === 0) return null;

  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Apps on your computers</h2>
        <span className="section__hint">
          The same app can have different access on each computer.
        </span>
      </div>
      <div className="card">
        {rows.map(({ connection, computer, definition, presentation }) => {
          const state = computerConnectionState({ connection, definition, machines });
          // A blocked app is the owner's standing decision: it reads as such,
          // never as ready or broken, and is undone on its Mac.
          const blocked = computer.blockedAt !== null;
          const machineName =
            machines.find(({ id }) => id === computer.runnerId)?.name ?? "that Mac";
          return (
            <div className="card__row" key={connection.id}>
              <IntegrationIcon icon={definition.icon} id={definition.id} name={definition.name} />
              <div className="card__row-body">
                <span className="card__row-title">
                  {computerAppConnectionLabel({ connection, definition, machines })}
                  {blocked ? (
                    <span className="chip chip--bad">Blocked</span>
                  ) : (
                    <span className="chip">
                      {computerAppAccessLabel(presentation, computer.access)}
                    </span>
                  )}
                </span>
                <span className="card__row-detail computer-apps__status">
                  {blocked ? (
                    <>
                      <span aria-hidden className="status-dot status-dot--idle" />
                      Unblock on {machineName}
                    </>
                  ) : (
                    <>
                      <span
                        aria-hidden
                        className={`status-dot ${computerAppStateDotClass(state)}`}
                      />
                      {computerAppStateLabel(state)}
                    </>
                  )}
                </span>
              </div>
              <div className="card__row-actions">
                <Link
                  className="btn btn--small"
                  to={computerAppRoute({
                    definitionId: definition.id,
                    runnerId: computer.runnerId,
                  })}
                >
                  Manage
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Connections that are somebody's account rather than a computer's permission. */
export function accountConnections(
  connections: readonly IntegrationConnectionSummary[],
): readonly IntegrationConnectionSummary[] {
  return connections.filter(({ computer, status }) => status !== "revoked" && !computer);
}
