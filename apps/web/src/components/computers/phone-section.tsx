import type { IntegrationConnectionSummary } from "@opensteer/client/integrations";
import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import {
  computerUseAccessLabel,
  phoneScreenSetupLine,
  phoneScreenStatus,
  phoneUseCardTitle,
  phoneUseStatusLine,
  phoneUseView,
  setPhoneUseAccess,
  stopComputerUseSession,
  type PhoneUseView,
} from "@opensteer/client/integrations";
import type {
  IntegrationAccess,
  IntegrationDefinitionSummaryView,
} from "@opensteer/integration-core";
import type { MachineSummary } from "@opensteer/protocol";
import { useState, type ReactNode } from "react";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon } from "../icon.js";

/**
 * What a phone does for agents, on its own page: whether it can be used now,
 * what agents may do on it, which task holds it, and the few things its owner
 * can do from here. The owner sets access here; Pause remains on the phone.
 * A phone a Mac drives says where its setup lives instead of offering USB.
 */
export function PhoneSection({
  appsSwitch,
  connections,
  definitions,
  hostClient,
  hostConnected,
  machine,
  onChanged,
  onOpenScreen,
  onPlugIn,
  setupHere = false,
  wifiRow,
}: {
  /** The device's Apps switch, for a phone whose card is its whole page. */
  readonly appsSwitch?: ReactNode;
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definitions: readonly IntegrationDefinitionSummaryView[];
  readonly hostClient: HostClient;
  readonly hostConnected: boolean;
  readonly machine: MachineSummary;
  readonly onChanged: () => Promise<void>;
  /** Opens the phone's tab; absent where this window has no tabs. */
  readonly onOpenScreen?: (() => void) | null;
  /** Opens setup over USB for an Android phone or updates its app. */
  readonly onPlugIn: () => void;
  /** This window runs on the Mac that sets the phone up. */
  readonly setupHere?: boolean;
  /** Same Wi‑Fi for an iPhone, where this window runs on the Mac that drives it. */
  readonly wifiRow?: ReactNode;
}) {
  const [busy, setBusy] = useState<"access" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = phoneUseView({ connections, definitions, hostConnected, machine });
  if (!view) return null;
  const currentView = view;
  const screen = phoneScreenStatus(machine);
  const appsOn = machine.capabilities?.apps.enabled !== false;

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
      if (access !== null) return setPhoneUseAccess(hostClient, machine, access);
      if (currentView.connectionId === null) return;
      const result = await hostClient.dispatch({
        connectionId: currentView.connectionId,
        idempotencyKey: mutationIdempotencyKey(`phone-access:${machine.id}`),
        type: "integration.disconnect",
      });
      if (result.type !== "integration.disconnect") throw new Error("Phone access did not change.");
    });
  }

  const titleId = `phone-use-title-${machine.id}`;
  const showAccess = appsOn && (screen === null || view.driver?.attached !== false);
  const statusDetail = !appsOn
    ? appsOffLine
    : (screen?.fix ?? (screen?.tone === "online" ? phoneUseStatusLine(view, machine.name) : null));
  const setupRow = setupHere
    ? {
        label: "Set up on this Mac",
        detail: "iPhone setup isn’t in this version of Opensteer yet.",
      }
    : phoneScreenSetupLine(machine);

  return (
    <section
      aria-labelledby={titleId}
      className={screen ? "settings-group device-uses" : "computers-section"}
    >
      {screen ? (
        <h2 className="settings-group__title" id={titleId}>
          {view.driver?.attached === false ? "Screen control" : phoneUseCardTitle(view)}
        </h2>
      ) : (
        <div className="section-heading">
          <div>
            <h2 id={titleId}>Agents on this phone</h2>
          </div>
        </div>
      )}
      <div className="card">
        {screen ? (
          <div className="card__row" role="status">
            <span className="card__row-glyph">
              <span
                aria-hidden
                className={`computer-status__dot computer-status__dot--${screen.tone}`}
              />
            </span>
            <span className="card__row-body">
              <span className="card__row-title">{screen.label}</span>
              {statusDetail ? (
                <span className="card__row-detail card__row-detail--wrap">{statusDetail}</span>
              ) : null}
            </span>
          </div>
        ) : (
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
        )}
        {wifiRow}
        {appsSwitch}
        {showAccess ? (
          <div className="card__row phone-section__access">
            <span className="card__row-body">
              <span className="card__row-title" id={`${titleId}-access`}>
                Access
              </span>
            </span>
            <span aria-labelledby={`${titleId}-access`} className="card__row-actions" role="group">
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
          </div>
        ) : null}
        {onOpenScreen && view.canView ? (
          <div className="card__row">
            <span className="card__row-glyph">
              <Icon name="phone" />
            </span>
            <span className="card__row-body">
              <span className="card__row-title">Screen</span>
              <span className="card__row-detail">
                {view.canInput ? "Watch it or use it yourself" : "Watch what it shows"}
              </span>
            </span>
            <span className="card__row-actions">
              <button className="btn btn--small" onClick={onOpenScreen} type="button">
                Open screen
              </button>
            </span>
          </div>
        ) : null}
        {view.setup.location === "android-usb" ? (
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
        ) : screen?.needsSetup && setupRow ? (
          <div className="card__row">
            <span className="card__row-glyph">
              <Icon name="laptop" />
            </span>
            <span className="card__row-body">
              <span className="card__row-title">{setupRow.label}</span>
              <span className="card__row-detail card__row-detail--wrap">{setupRow.detail}</span>
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

const appsOffLine = "Apps is off, so your agent can’t use it.";

function accessTitle(view: PhoneUseView): string {
  if (view.access === null) return "Access off";
  return computerUseAccessLabel[view.access];
}
