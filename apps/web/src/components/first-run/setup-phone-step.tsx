import { useCallback, useState } from "react";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { remoteAccessDisconnectWarning } from "@opensteer/client/host";
import { usePersonalRemoteAccess, type RemoteAccessController } from "@opensteer/client/react";
import { useWebRemoteAccess } from "../../account/remote-access-port.js";
import { useShell } from "../app-shell.js";
import { phoneConnectUrl, useNewPhoneSignIn } from "./phone-setup.js";
import {
  ActionPanel,
  AddressPanel,
  addressAction,
  ArrivedRow,
  ModeRow,
  Panel,
  PhoneActionButton,
  ScanPanel,
  TailscalePanel,
  tailscaleAction,
  useTailscaleStatus,
  type PhoneAction,
} from "./phone-panels.js";
import {
  initialPhoneMode,
  sameOrigin,
  usePrivatePhoneSetup,
  type PhoneConnectionMode,
} from "./private-phone-setup.js";
import { SetupFooter, SetupFrame } from "./setup-frame.js";
import { SetupList } from "./setup-list.js";

/**
 * Step three: the person chooses how their phone reaches this computer —
 * Opensteer Connect, their own Tailscale network, or an HTTPS address they
 * run — and scans one code. Choosing changes nothing until they press the
 * footer's one action, which is always the next thing the chosen way needs;
 * replacing a way that is already on asks first, because it disconnects the
 * devices using it.
 */
export function SetupPhoneStep({
  bridge,
  onBack,
  onFinish,
  progress,
}: {
  readonly bridge: OpensteerDesktopBridge;
  readonly onBack?: (() => void) | undefined;
  readonly onFinish: () => void;
  readonly progress: { readonly count: number; readonly index: number };
}) {
  const { deploymentAccess, hostClient, snapshot } = useShell();
  const remote = usePersonalRemoteAccess(hostClient);
  const connect = useWebRemoteAccess(remote);
  const portalOrigin = snapshot.identityConfig?.portalOrigin ?? null;
  const connectUrl = phoneConnectUrl(connect.view, portalOrigin, snapshot.deploymentId);
  const connectAvailable =
    (deploymentAccess?.account.available ?? false) &&
    portalOrigin !== null &&
    snapshot.deploymentId !== null &&
    connect.view.state !== "unreadable" &&
    connect.view.state !== "connect-unavailable";
  const signedIn = deploymentAccess?.account.status === "signed-in";
  const { refresh: refreshTailscale, status: tailscale } = useTailscaleStatus(bridge);
  const share = useCallback(
    () => bridge.tailscaleShare().finally(refreshTailscale),
    [bridge, refreshTailscale],
  );
  const [mode, setMode] = useState<PhoneConnectionMode | null>(null);
  const [editingAddress, setEditingAddress] = useState(false);
  const ready = remote.status !== null && tailscale !== null;
  const chosen: PhoneConnectionMode =
    mode ??
    initialPhoneMode({
      connectAvailable,
      status: remote.status,
      tailscaleOrigin: tailscale?.state === "ready" ? tailscale.sharedOrigin : null,
    });
  const privately = usePrivatePhoneSetup({
    hostClient,
    remote,
    share,
    showing: ready && chosen !== "connect",
  });
  const activeMode = remote.status?.access.mode ?? "off";
  const tailnetOrigin =
    privately.sharedOrigin ??
    (tailscale?.state === "ready" ? sameOrigin(tailscale.sharedOrigin ?? "") : null);
  const tailscaleActive =
    privately.activeOrigin !== null && privately.activeOrigin === tailnetOrigin;
  const addressActive = privately.activeOrigin !== null && !tailscaleActive;

  /** Replacing a way that is on disconnects whoever uses it, so it asks. */
  const confirmReplacing = (next: PhoneConnectionMode, origin?: string): boolean => {
    // A different address is a new route too: the Host ends the sessions
    // that used the old one, so it asks exactly as a different kind would.
    const replacing =
      activeMode === "connect"
        ? next !== "connect"
        : activeMode === "private"
          ? next === "connect" ||
            (next === "tailscale"
              ? !tailscaleActive
              : tailscaleActive || sameOrigin(origin ?? "") !== privately.activeOrigin)
          : false;
    return !replacing || window.confirm(remoteAccessDisconnectWarning);
  };

  const scanning =
    (chosen === "connect" && connectUrl !== null) ||
    (chosen === "tailscale" && tailscaleActive && privately.link !== null) ||
    (chosen === "address" && addressActive && privately.link !== null && !editingAddress);
  const arrived = useNewPhoneSignIn(hostClient, scanning);

  const choose = (next: PhoneConnectionMode) => {
    setMode(next);
    setEditingAddress(false);
    privately.reset();
    connect.stop();
  };
  const startTailscale = () => {
    if (confirmReplacing("tailscale")) privately.turnOnTailscale();
  };

  const finish: PhoneAction = { done: true, label: "Finish", run: onFinish };
  // A status that can't be read is said under the choices; it must never
  // leave the step with no way forward but Skip.
  const action: PhoneAction = !ready
    ? remote.error
      ? finish
      : { busy: true, label: "Checking…" }
    : arrived || scanning
      ? finish
      : chosen === "connect"
        ? connectAction(connect, signedIn, () => {
            if (confirmReplacing("connect")) connect.act("turn-on");
          })
        : chosen === "tailscale"
          ? tailscaleAction({
              active: tailscaleActive,
              bridge,
              privately,
              start: startTailscale,
              status: tailscale,
            })
          : addressAction({ active: addressActive, editing: editingAddress, privately });

  return (
    <SetupFrame
      description="Check in on your agents and answer them from anywhere."
      footer={
        <SetupFooter
          action={<PhoneActionButton action={action} />}
          onBack={onBack}
          onSkip={action.done ? undefined : onFinish}
          skipLabel="Skip for now"
        />
      }
      progress={progress}
      stepKey="phone"
      title="Connect your phone"
    >
      <span className="setup-label" id="setup-phone-choice">
        How your phone connects
      </span>
      <SetupList label="How your phone connects">
        {connectAvailable ? (
          <ModeRow
            checked={chosen === "connect"}
            detail="Works on any network. Nothing to set up."
            onChoose={() => choose("connect")}
            title="Opensteer Connect"
            trailing={<span className="setup-tag">Recommended</span>}
          />
        ) : null}
        <ModeRow
          checked={chosen === "tailscale"}
          detail="Use your own private Tailscale network."
          onChoose={() => choose("tailscale")}
          title="Tailscale"
          trailing={
            tailscale?.state === "ready" ? (
              <span className="setup-found">
                <span aria-hidden className="setup-found__dot" />
                On this computer
              </span>
            ) : null
          }
        />
        <ModeRow
          checked={chosen === "address"}
          detail="Use an HTTPS address you already run."
          onChoose={() => choose("address")}
          title="Your own address"
        />
      </SetupList>
      {!ready ? null : arrived ? (
        <SetupList label="Your phone">
          <ArrivedRow phone={arrived} />
        </SetupList>
      ) : chosen === "connect" ? (
        <ConnectPanel connect={connect} url={connectUrl} />
      ) : chosen === "tailscale" ? (
        <TailscalePanel
          active={tailscaleActive}
          link={privately.link}
          privately={privately}
          status={tailscale}
        />
      ) : (
        <AddressPanel
          active={addressActive}
          editing={editingAddress}
          link={privately.link}
          onEditing={setEditingAddress}
          onStart={(origin) => {
            if (confirmReplacing("address", origin)) privately.turnOnAddress(origin);
          }}
          origin={addressActive ? privately.activeOrigin : null}
          privately={privately}
        />
      )}
      {remote.error && !remote.status ? (
        <p className="setup-frame__note" role="alert">
          {remote.error}
        </p>
      ) : null}
    </SetupFrame>
  );
}

function connectAction(
  connect: RemoteAccessController,
  signedIn: boolean,
  turnOn: () => void,
): PhoneAction {
  const { view } = connect;
  if (view.state === "on-connect") return { done: true, label: "Finish" };
  if (view.state === "loading") return { busy: true, label: "Checking…" };
  if (view.tone === "busy")
    return { busy: true, label: view.state === "turning-on" ? "Connecting…" : view.title };
  // A private network in use is replaced only because the person chose
  // Connect and confirmed it; this action is that choice.
  if (view.state === "off" || view.state === "off-signed-out" || view.state === "on-private")
    return { label: signedIn ? "Turn on Connect" : "Sign in and connect", run: turnOn };
  const primary = view.primary;
  if (!primary) return { busy: true, label: view.title };
  return {
    label: primary.label,
    run: () => {
      if (!primary.confirm || window.confirm(primary.confirm)) connect.act(primary.id);
    },
  };
}

function ConnectPanel({
  connect,
  url,
}: {
  readonly connect: RemoteAccessController;
  readonly url: string | null;
}) {
  const { view } = connect;
  if (url) {
    return (
      <ScanPanel
        label="Code that opens this computer on your phone"
        steps={[
          "Scan this code with your phone’s camera.",
          "Get the Opensteer app and sign in with the same account as this computer.",
        ]}
        value={url}
      />
    );
  }
  if (view.tone === "busy" && view.state !== "loading") {
    const cancel = view.secondary.find((candidate) => candidate.id === "cancel");
    return (
      <Panel>
        {view.steps ? (
          <>
            <ol aria-label="Turning on Connect" className="setup-checks">
              {view.steps.map((step) => (
                <li
                  aria-current={step.state === "active" ? "step" : undefined}
                  className={`setup-checks__item setup-checks__item--${step.state}`}
                  key={step.label}
                >
                  <span aria-hidden className="setup-checks__mark" />
                  <span>{step.label}</span>
                </li>
              ))}
            </ol>
            <p className="visually-hidden" role="status">
              {view.sentence}
            </p>
          </>
        ) : (
          <p className="setup-panel__status" role="status">
            <span aria-hidden className="spinner" /> {view.sentence}
          </p>
        )}
        {cancel ? (
          <button
            className="btn btn--small btn--ghost setup-panel__cancel"
            onClick={() => connect.act(cancel.id)}
            type="button"
          >
            {cancel.label}
          </button>
        ) : null}
      </Panel>
    );
  }
  if (view.tone === "attention") return <ActionPanel tone="attention">{view.sentence}</ActionPanel>;
  if (view.state === "off-signed-out")
    return (
      <p className="setup-frame__note">You’ll sign in to your Opensteer account in your browser.</p>
    );
  return null;
}
