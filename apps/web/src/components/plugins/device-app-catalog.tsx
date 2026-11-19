import {
  computerAppPlatformRequirementLabel,
  type IntegrationConnectionSummary,
} from "@opensteer/client/integrations";
import { mutationIdempotencyKey } from "@opensteer/client/host";
import type { IntegrationDefinitionSummaryView } from "@opensteer/integration-core";
import { RunnerIdSchema } from "@opensteer/core";
import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { useShell } from "../app-shell.js";
import { ComputerAppPicker } from "../computer-apps/computer-app-picker.js";
import { deviceAppRoute } from "../devices/device-routes.js";
import { Dialog } from "../dialog.js";
import { IntegrationIcon } from "../integration-icon.js";
import { SettingsError } from "../settings/primitives.js";
import { act, failureWords } from "../use-action.js";

/**
 * Apps built into Opensteer that run on a person's own device. They are turned
 * on for one device, never installed into the plugin sandbox.
 */
export function DeviceAppRows({
  apps,
  onSetUp,
}: {
  readonly apps: readonly IntegrationDefinitionSummaryView[];
  readonly onSetUp: (definition: IntegrationDefinitionSummaryView) => void;
}) {
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">On your devices</h2>
      <div className="card plugins-catalog" role="list">
        {apps.map((definition) => (
          <div className="card__row plugins-catalog__row" key={definition.id} role="listitem">
            <IntegrationIcon id={definition.id} name={definition.name} />
            <span className="card__row-body">
              <span className="card__row-title">{definition.name}</span>
              <span className="card__row-detail plugins-catalog__description">
                {[computerAppPlatformRequirementLabel(definition), definition.description]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            <button
              aria-label={`Set up ${definition.name}`}
              className="btn btn--small"
              onClick={() => onSetUp(definition)}
              type="button"
            >
              Set up
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Choose the device and access; the device's own page then shows the request until it's approved. */
export function SetUpDeviceApp({
  connections,
  definition,
  onClose,
}: {
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definition: IntegrationDefinitionSummaryView;
  readonly onClose: () => void;
}) {
  const { hostClient, snapshot } = useShell();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  return (
    <Dialog
      labelledBy={titleId}
      narrow
      onClose={onClose}
      title={<span id={titleId}>Set up {definition.name}</span>}
    >
      <div className="plugins-install">
        <div className="settings-add-hero">
          <IntegrationIcon id={definition.id} name={definition.name} size="lg" />
          <p>{definition.description}</p>
        </div>
        <SettingsError message={error} />
        <ComputerAppPicker
          busy={pending}
          connections={connections}
          definition={definition}
          machines={snapshot.machines}
          onTurnOn={({ access, runnerId }) => {
            setPending(true);
            setError(null);
            void act(
              hostClient,
              {
                label: `request ${definition.name}`,
                done: "requested",
                happened: "the setup was requested",
              },
              async () => {
                const result = await hostClient.dispatch({
                  idempotencyKey: mutationIdempotencyKey(`computer-app-setup:${definition.id}`),
                  input: {
                    access,
                    app: null,
                    definitionId: definition.id,
                    kind: "app",
                    runnerId: RunnerIdSchema.parse(runnerId),
                  },
                  type: "integration.computer.setup.request",
                });
                if (result.type !== "integration.computer.setup.request")
                  throw new Error("The setup request did not complete.");
              },
            )
              .then(() => navigate(deviceAppRoute({ definitionId: definition.id, runnerId })))
              .catch((reason: unknown) => {
                setError(failureWords(reason));
                setPending(false);
              });
          }}
        />
      </div>
    </Dialog>
  );
}
