import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import {
  computerUseAccessLabel,
  phoneUseStatusLine,
  phoneUseView,
  stopComputerUseSession,
  type PhoneUseView,
} from "@opensteer/client/integrations";
import type {
  IntegrationAccess,
  IntegrationConnectionSummary,
  IntegrationDefinitionSummaryView,
} from "@opensteer/integration-core";
import type { MachineSummary } from "@opensteer/protocol";
import { useState } from "react";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon } from "../icon.js";

/**
 * What a phone does for agents, on its own page: whether it can be used now,
 * what agents may do on it, which task holds it, and the few things its owner
 * can do from here. The owner sets access here; Pause remains on the phone.
 */
export function PhoneSection({
  connections,
  definitions,
  hostClient,
  hostConnected,
  machine,
  onChanged,
  onPlugIn,
}: {
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definitions: readonly IntegrationDefinitionSummaryView[];
  readonly hostClient: HostClient;
  readonly hostConnected: boolean;
  readonly machine: MachineSummary;
  readonly onChanged: () => Promise<void>;
  /** Opens setup over USB for this phone or updates its app. */
  readonly onPlugIn: () => void;
}) {
  const [busy, setBusy] = useState<"access" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = phoneUseView({ connections, definitions, hostConnected, machine });
  if (!view) return null;
  const currentView = view;
  const owned = machine.ownership !== "other";

  async function act(kind: "access" | "stop", action: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (reason) {
      setError(actionErrorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function setAccess(access: IntegrationAccess | null) {
    await act("access", async () => {
      if (access === null) {
        if (currentView.connectionId === null) return;
        const result = await hostClient.dispatch({
          connectionId: currentView.connectionId,
          idempotencyKey: mutationIdempotencyKey(`agent-phone-access:${machine.id}`),
          type: "integration.disconnect",
        });
        if (result.type !== "integration.disconnect")
          throw new Error("Phone access did not change.");
        return;
      }
      const result = await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`agent-phone-access:${machine.id}`),
        input: {
          access,
          app: null,
          definitionId: "android-phone",
          kind: "app",
          runnerId: machine.id,
        },
        type: "integration.computer.setup.set",
      });
      if (result.type !== "integration.computer.setup.set")
        throw new Error("Phone access did not change.");
    });
  }

  return (
    <section aria-labelledby="phone-use-title" className="computers-section">
      <div className="section-heading">
        <div>
          <h2 id="phone-use-title">Agents on this phone</h2>
        </div>
      </div>
      <div className="card">
        <div className="card__row">
          <span className="card__row-glyph">
            <Icon name="phone" />
          </span>
          <span className="card__row-body">
            <span className="card__row-title">{accessTitle(view)}</span>
            <span className="card__row-detail card__row-detail--wrap">
              {phoneUseStatusLine(view, machine.name)}
            </span>
          </span>
        </div>
        {owned ? (
          <div className="card__row">
            <span className="card__row-body">
              <span className="card__row-title">Access</span>
            </span>
            <span className="card__row-actions">
              {([null, "read", "read-write"] as const).map((access) => (
                <button
                  aria-pressed={view.access === access}
                  className="btn btn--small"
                  disabled={busy !== null || !hostConnected || view.access === access}
                  key={access ?? "off"}
                  onClick={() => void setAccess(access)}
                  type="button"
                >
                  {access === null ? "Off" : computerUseAccessLabel[access]}
                </button>
              ))}
            </span>
          </div>
        ) : null}
        {view.session ? (
          <div className="card__row">
            <span className="card__row-glyph">
              <Icon name="bolt" />
            </span>
            <span className="card__row-body">
              <span className="card__row-title">
                {view.session.threadTitle ?? "A task"} is using {machine.name}
              </span>
              <span className="card__row-detail">
                {view.session.actionCount === 1
                  ? "1 action so far"
                  : `${view.session.actionCount} actions so far`}
              </span>
            </span>
            {owned ? (
              <span className="card__row-actions">
                <button
                  aria-label={`Stop the task using ${machine.name}`}
                  className="btn btn--danger btn--small"
                  disabled={busy !== null}
                  onClick={() => {
                    const session = view.session;
                    if (!session) return;
                    void act("stop", () => stopComputerUseSession(hostClient, session.sessionId));
                  }}
                  type="button"
                >
                  {busy === "stop" ? "Stopping…" : "Stop"}
                </button>
              </span>
            ) : null}
          </div>
        ) : null}
        {owned ? (
          <div className="card__row">
            <span className="card__row-glyph">
              <Icon name="plus" />
            </span>
            <span className="card__row-body">
              <span className="card__row-title">
                {view.state.kind === "permission-required"
                  ? "Finish setting it up"
                  : "Update over USB"}
              </span>
              <span className="card__row-detail card__row-detail--wrap">
                {view.state.kind === "permission-required"
                  ? `Plug ${machine.name} into this computer to finish setup.`
                  : `Plug ${machine.name} into this computer to install the Agent Phone app that comes with this Opensteer. It keeps its access and its place here.`}
              </span>
            </span>
            <span className="card__row-actions">
              <button className="btn btn--small" onClick={onPlugIn} type="button">
                Plug in
              </button>
            </span>
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function accessTitle(view: PhoneUseView): string {
  if (view.access === null) return "Access off";
  return computerUseAccessLabel[view.access];
}
