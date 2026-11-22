import { useCallback, useState } from "react";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { remoteAccessDisconnectWarning } from "@opensteer/client/host";
import type { RemoteAccessController, usePersonalRemoteAccess } from "@opensteer/client/react";
import { useShell } from "../app-shell.js";
import { phoneConnectUrl, useNewPhoneSignIn } from "./phone-setup.js";
import {
  ActionPanel,
  ArrivedRow,
  Panel,
  PhoneActionButton,
  ScanPanel,
  type PhoneAction,
} from "./phone-panels.js";
import { PrivateNetworkSetup } from "./private-network.js";
import { SetupFooter, SetupFrame } from "./setup-frame.js";
import { SetupList } from "./setup-list.js";

/**
 * Step three: the phone, through the person's Opensteer account. Remote access on shows one
 * code to scan; off, one action turns it on (signing in and adding this Mac to the account
 * first when needed). There is no choice of transport here: a private network lives under
 * Remote access › Advanced, and a Home without an account opens it from one link, "Use a
 * private network instead". A Home already on a private network shows that.
 */
export function SetupPhoneStep({
  bridge,
  connect,
  onBack,
  onFinish,
  progress,
  remote,
}: {
  readonly bridge: OpensteerDesktopBridge;
  readonly connect: RemoteAccessController;
  readonly onBack?: (() => void) | undefined;
  readonly onFinish: () => void;
  readonly progress: { readonly count: number; readonly index: number };
  readonly remote: ReturnType<typeof usePersonalRemoteAccess>;
}) {
  const { deploymentAccess, hostClient, snapshot } = useShell();
  const portalOrigin = snapshot.identityConfig?.portalOrigin ?? null;
  const connectUrl = phoneConnectUrl(connect.view, portalOrigin, snapshot.deploymentId);
  const connectAvailable =
    (deploymentAccess?.account.available ?? false) &&
    portalOrigin !== null &&
    snapshot.deploymentId !== null &&
    connect.view.state !== "unreadable" &&
    connect.view.state !== "connect-unavailable";
  const signedIn = deploymentAccess?.account.status === "signed-in";
  const name = snapshot.identityConfig?.deployment.name ?? "this Mac";
  // A Home that no Opensteer account holds yet: the private network is one link away.
  const withoutAccount = remote.status !== null && remote.status.access.accountLink === null;
  const privateOn = remote.status?.access.mode === "private";
  const [privateChosen, setPrivateChosen] = useState(false);
  const [privateConnected, setPrivateConnected] = useState(false);
  const showPrivate = !connectAvailable || privateOn || privateChosen;
  const scanning = !showPrivate && connectUrl !== null;
  const arrived = useNewPhoneSignIn(hostClient, scanning);
  const onPrivateConnected = useCallback(
    (connected: boolean) => setPrivateConnected(connected),
    [],
  );

  const finish: PhoneAction = { done: true, label: "Finish", run: onFinish };
  const action: PhoneAction | null = showPrivate
    ? privateConnected
      ? finish
      : null
    : remote.status === null
      ? remote.error
        ? finish
        : { busy: true, label: "Checking…" }
      : arrived || scanning
        ? finish
        : connectAction(connect, signedIn, () => {
            if (
              remote.status?.access.mode !== "private" ||
              window.confirm(remoteAccessDisconnectWarning)
            )
              connect.act("turn-on");
          });

  return (
    <SetupFrame
      description="Check in on your agents and answer them from anywhere."
      footer={
        <SetupFooter
          action={action ? <PhoneActionButton action={action} /> : null}
          onBack={onBack}
          onSkip={action?.done ? undefined : onFinish}
          skipLabel="Skip for now"
        />
      }
      progress={progress}
      stepKey="phone"
      title="Connect your phone"
    >
      {showPrivate ? (
        <>
          <PrivateNetworkSetup bridge={bridge} onConnected={onPrivateConnected} />
          {connectAvailable && !privateOn ? (
            <p className="setup-frame__note">
              <button className="link-btn" onClick={() => setPrivateChosen(false)} type="button">
                Use your Opensteer account instead
              </button>
            </p>
          ) : null}
        </>
      ) : (
        <>
          {remote.status === null ? null : arrived ? (
            <SetupList label="Your phone">
              <ArrivedRow phone={arrived} />
            </SetupList>
          ) : (
            <ConnectPanel connect={connect} name={name} url={connectUrl} />
          )}
          {withoutAccount && !scanning && !arrived ? (
            <p className="setup-frame__note">
              <button
                className="link-btn"
                onClick={() => {
                  connect.stop();
                  setPrivateChosen(true);
                }}
                type="button"
              >
                Use a private network instead
              </button>
            </p>
          ) : null}
          {remote.error && !remote.status ? (
            <p className="setup-frame__note" role="alert">
              {remote.error}
            </p>
          ) : null}
        </>
      )}
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
    return { busy: true, label: view.state === "turning-on" ? "Turning on…" : view.title };
  // A private network in use is replaced only because the person chose
  // Connect and confirmed it; this action is that choice.
  if (view.state === "off" || view.state === "off-signed-out" || view.state === "on-private")
    return {
      label: signedIn ? "Turn on Remote access" : "Sign in and turn on Remote access",
      run: turnOn,
    };
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
  name,
  url,
}: {
  readonly connect: RemoteAccessController;
  readonly name: string;
  readonly url: string | null;
}) {
  const { view } = connect;
  if (url) {
    return (
      <>
        <p className="setup-frame__note" role="status">
          Remote access is on. Your phone and connected agents can reach {name} from anywhere. You
          can turn it off in Settings › Account.
        </p>
        <ScanPanel
          label="Code that opens this computer on your phone"
          steps={[
            "Scan this code with your phone’s camera.",
            "Get the Opensteer app and sign in with the same account as this computer.",
          ]}
          value={url}
        />
      </>
    );
  }
  if (view.tone === "busy" && view.state !== "loading") {
    const cancel = view.secondary.find((candidate) => candidate.id === "cancel");
    return (
      <Panel>
        {view.steps ? (
          <>
            <ol aria-label="Turning on Remote access" className="setup-checks">
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
      <p className="setup-frame__note">
        Your phone reaches {name} through your Opensteer account. You’ll sign in in your browser.
      </p>
    );
  if (view.state === "off" || view.state === "on-private")
    return (
      <p className="setup-frame__note">Your phone reaches {name} through your Opensteer account.</p>
    );
  return null;
}
