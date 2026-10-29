import type {
  IntegrationAccess,
  IntegrationConnectionSummary,
  IntegrationDefinitionSummaryView,
} from "@opensteer/integration-core";
import type { MachineSummary } from "@opensteer/protocol";
import { computerGlyph } from "@opensteer/client/computers";
import {
  computerAppPlatformTargetLabel,
  computerAppRunsOnPhone,
  computerAppStateDotClass,
  computerAppStateLabel,
  computerAppTargets,
} from "@opensteer/client/integrations";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Icon } from "../icon.js";
import { OptionRow } from "../option-row.js";
import { SegmentedControl } from "../segmented-control.js";
import { computerAppRoute } from "../computers-page.js";
import { computerIcon } from "../computers/device-art.js";
import { ComputerAppPermissionNotice } from "./computer-app-permission-notice.js";

/**
 * Choosing which computer should receive an app setup request.
 *
 * The same control answers a Request from a Thread and the Connect step in
 * Settings, because it is the same decision: one computer, one requested access level.
 * Only computers that are online and offering the app are listed — an app
 * cannot be promised on a machine that is not there to keep the promise — and
 * a computer that already has it says so rather than offering it twice.
 */
export function ComputerAppPicker({
  busy,
  connections,
  definition,
  machines,
  onTurnOn,
}: {
  readonly busy: boolean;
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definition: IntegrationDefinitionSummaryView;
  readonly machines: readonly MachineSummary[];
  readonly onTurnOn: (input: {
    readonly access: IntegrationAccess;
    readonly runnerId: string;
  }) => void;
}) {
  const targets = useMemo(
    () => computerAppTargets({ connections, definition, machines }),
    [connections, definition, machines],
  );
  const available = targets.filter(({ connection }) => connection === null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  // The safe level is the default, always: nothing here ever preselects the
  // access that lets an agent act on somebody's behalf.
  const [access, setAccess] = useState<IntegrationAccess>("read");
  const presentation = definition.computerApp;
  const chosen =
    chosenId === null
      ? (available[0] ?? null)
      : (available.find(({ machine }) => machine.id === chosenId) ?? null);

  if (targets.length === 0) {
    return (
      <div className="card">
        {computerAppRunsOnPhone(presentation) ? (
          <p className="card__empty">
            No phone is offering {definition.name} yet. Plug an Android phone into a computer and
            choose Add a phone under <Link to="/settings/computers">Computers</Link>.
          </p>
        ) : (
          <p className="card__empty">
            No computer is offering {definition.name} yet. Open Opensteer on{" "}
            {computerAppPlatformTargetLabel(presentation?.platforms ?? [])} and add it under{" "}
            <Link to="/settings/computers">Computers</Link>.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="computer-apps__picker">
      <div className="card">
        {targets.map(({ connection, machine, state }) => {
          const leading = (
            <span className="card__row-glyph">
              <Icon name={computerIcon(computerGlyph(machine))} />
            </span>
          );
          const detail = (
            <span className="computer-apps__status">
              <span aria-hidden className={`status-dot ${computerAppStateDotClass(state)}`} />
              <span>{computerAppStateLabel(state, machine.device?.platform)}</span>
            </span>
          );
          return connection ? (
            // Already on is a fact, not an achievement: a green badge here
            // would sit beside the very line that says setup is unfinished and
            // read as a contradiction. The row points at the one editor that
            // can settle it instead.
            <OptionRow
              as="static"
              detail={detail}
              key={machine.id}
              leading={leading}
              note={`${definition.name} is already on for ${machine.name}.`}
              title={machine.name}
              trailing={
                <Link
                  className="btn btn--small"
                  to={computerAppRoute({ definitionId: definition.id, runnerId: machine.id })}
                >
                  Open settings
                </Link>
              }
            />
          ) : (
            <OptionRow
              as="radio"
              checked={chosen?.machine.id === machine.id}
              detail={detail}
              disabled={busy}
              key={machine.id}
              leading={leading}
              name={`computer-app-target-${definition.id}`}
              onSelect={() => setChosenId(machine.id)}
              title={machine.name}
              value={machine.id}
            />
          );
        })}
      </div>
      {available.length === 0 ? (
        // Every computer that offers this app already has it. Saying so is the
        // whole of what is left to say here: the next move is on each one's
        // own page, not on this picker.
        <p className="computer-apps__summary">
          {definition.name} is on for every computer that offers it. Manage each under{" "}
          <Link to="/settings/computers">Computers</Link>.
        </p>
      ) : null}
      {chosen && presentation ? (
        <>
          {presentation.accessLevels.length === 2 ? (
            <SegmentedControl
              ariaLabel={`Access for ${definition.name}`}
              disabled={busy}
              onChange={setAccess}
              options={[
                { label: presentation.accessLabels.read, value: "read" },
                { label: presentation.accessLabels.readWrite, value: "read-write" },
              ]}
              value={access}
            />
          ) : null}
          <p className="computer-apps__summary">
            {access === "read-write"
              ? presentation.accessSummaries.readWrite
              : presentation.accessSummaries.read}
          </p>
          <ComputerAppPermissionNotice
            appName={definition.name}
            machine={chosen.machine}
            managePath={computerAppRoute({
              definitionId: definition.id,
              runnerId: chosen.machine.id,
            })}
            state={chosen.state}
          />
          <div className="form-actions">
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() => onTurnOn({ access, runnerId: chosen.machine.id })}
              type="button"
            >
              {busy ? "Sending request…" : `Request setup on ${chosen.machine.name}`}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
