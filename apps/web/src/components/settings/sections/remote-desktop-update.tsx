import { useMemo, useState } from "react";
import { useRemoteDesktopUpdate } from "@opensteer/client/react";
import {
  OriginDesktopUpdates,
  type DesktopUpdateAction,
  type DesktopUpdateResult,
  type DesktopUpdates,
} from "@opensteer/client/settings";
import { desktopBridge } from "../../../desktop/desktop-bridge.js";
import { BridgeDesktopUpdates } from "../../../desktop/deployment-updates.js";
import { usePageVisible } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { Dialog } from "../../dialog.js";
import { Icon } from "../../icon.js";
import { SettingsGroup, SettingsRow, type SettingsView } from "../primitives.js";
import { useHomeComputer } from "../../devices/use-home-computer.js";

type RequestAction = Extract<DesktopUpdateAction, { readonly kind: "request" }>;

function ResultNotice({ result }: { readonly result: DesktopUpdateResult | null }) {
  if (result === null) return null;
  return (
    <p
      className={result.tone === "attention" ? "notice notice--warn" : "notice"}
      role="status"
      aria-live="polite"
    >
      <Icon name={result.tone === "attention" ? "alert-circle" : "check"} />
      <span>{result.text}</span>
    </p>
  );
}

export function RemoteDesktopUpdateSection({ view }: { readonly view: SettingsView }) {
  const { hostClient } = useShell();
  const home = useHomeComputer();
  const visible = usePageVisible();
  const deployment = view.deployment;
  const updates = useMemo<DesktopUpdates | null>(() => {
    if (deployment?.onThisComputer) return null;
    if (hostClient.desktopUpdates) return hostClient.desktopUpdates;
    const bridge = desktopBridge();
    if (bridge === null) return new OriginDesktopUpdates(window.location.origin);
    return deployment && bridge.deploymentUpdates
      ? new BridgeDesktopUpdates(bridge.deploymentUpdates, deployment.id)
      : null;
  }, [deployment?.id, deployment?.onThisComputer, hostClient]);
  const { run, view: model } = useRemoteDesktopUpdate(
    updates,
    home.name ?? view.name,
    visible && updates !== null,
    async () => {
      const bridge = desktopBridge();
      if (bridge) {
        if ((await bridge.getDeploymentAccessSnapshot()).account.status !== "signed-in")
          await bridge.signIn();
      } else window.location.reload();
    },
  );
  const [confirming, setConfirming] = useState<RequestAction | null>(null);
  if (updates === null || model.hidden) return null;
  const button = (action: DesktopUpdateAction) => (
    <button
      className="btn"
      type="button"
      onClick={() => (action.kind === "request" ? setConfirming(action) : run(action))}
    >
      {action.label}
    </button>
  );
  return (
    <>
      <SettingsGroup heading={model.title} headingId="settings-remote-update">
        <SettingsRow
          action={model.action ? button(model.action) : null}
          detail={model.statusLine ? <span role="status">{model.statusLine}</span> : null}
          title={model.headline}
        />
        {model.versionLine ? (
          <SettingsRow
            action={model.channelAction ? button(model.channelAction) : null}
            detail={model.channel}
            title={model.versionLine}
          />
        ) : null}
      </SettingsGroup>
      <ResultNotice result={model.result} />
      {confirming ? (
        <Dialog
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirming(null)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  setConfirming(null);
                  run(confirming);
                }}
                type="button"
              >
                {confirming.confirm.confirmLabel}
              </button>
            </>
          }
          labelledBy="remote-update-confirm"
          onClose={() => setConfirming(null)}
          title={confirming.confirm.title}
        >
          <p>{confirming.confirm.body}</p>
        </Dialog>
      ) : null}
    </>
  );
}
