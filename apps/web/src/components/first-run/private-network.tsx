import { useCallback, useEffect, useState } from "react";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { remoteAccessDisconnectWarning } from "@opensteer/client/host";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import { useShell } from "../app-shell.js";
import { useNewPhoneSignIn } from "./phone-setup.js";
import {
  AddressPanel,
  addressAction,
  ArrivedRow,
  ModeRow,
  PhoneActionButton,
  TailscalePanel,
  tailscaleAction,
  useTailscaleStatus,
  type PhoneAction,
} from "./phone-panels.js";
import { initialPhoneMode, sameOrigin, usePrivatePhoneSetup } from "./private-phone-setup.js";
import { SetupList } from "./setup-list.js";

type PrivateMode = "address" | "tailscale";

/**
 * A private network: this Mac's own Opensteer reached over the person's Tailscale network or
 * at an HTTPS address they run, with a one-time code for each phone. It is the way in without
 * an Opensteer account, kept under Remote access › Advanced, and the first run opens it only
 * when the person asks for it. Choosing changes nothing until its one action is pressed;
 * replacing a way that is already on asks first, because it signs out the devices using it.
 */
export function PrivateNetworkSetup({
  bridge,
  onConnected,
}: {
  readonly bridge: OpensteerDesktopBridge;
  /** Whether a phone can connect now: a code is on screen, or one signed in. */
  readonly onConnected?: (connected: boolean) => void;
}) {
  const { hostClient } = useShell();
  const remote = usePersonalRemoteAccess(hostClient);
  const { refresh: refreshTailscale, status: tailscale } = useTailscaleStatus(bridge);
  const share = useCallback(
    () => bridge.tailscaleShare().finally(refreshTailscale),
    [bridge, refreshTailscale],
  );
  const [mode, setMode] = useState<PrivateMode | null>(null);
  const [editingAddress, setEditingAddress] = useState(false);
  const ready = remote.status !== null && tailscale !== null;
  const initial = initialPhoneMode({
    connectAvailable: false,
    status: remote.status,
    tailscaleOrigin: tailscale?.state === "ready" ? tailscale.sharedOrigin : null,
  });
  const chosen: PrivateMode = mode ?? (initial === "address" ? "address" : "tailscale");
  const privately = usePrivatePhoneSetup({ hostClient, remote, share, showing: ready });
  const activeMode = remote.status?.access.mode ?? "off";
  const tailnetOrigin =
    privately.sharedOrigin ??
    (tailscale?.state === "ready" ? sameOrigin(tailscale.sharedOrigin ?? "") : null);
  const tailscaleActive =
    privately.activeOrigin !== null && privately.activeOrigin === tailnetOrigin;
  const addressActive = privately.activeOrigin !== null && !tailscaleActive;

  /** Replacing a way that is on disconnects whoever uses it, so it asks. */
  const confirmReplacing = (next: PrivateMode, origin?: string): boolean => {
    // A different address is a new route too: the Host ends the sessions
    // that used the old one, so it asks exactly as a different kind would.
    const replacing =
      activeMode === "connect" ||
      (activeMode === "private" &&
        (next === "tailscale"
          ? !tailscaleActive
          : tailscaleActive || sameOrigin(origin ?? "") !== privately.activeOrigin));
    return !replacing || window.confirm(remoteAccessDisconnectWarning);
  };

  const scanning =
    (chosen === "tailscale" && tailscaleActive && privately.link !== null) ||
    (chosen === "address" && addressActive && privately.link !== null && !editingAddress);
  const arrived = useNewPhoneSignIn(hostClient, scanning);
  const connected = scanning || arrived !== null;
  useEffect(() => onConnected?.(connected), [connected, onConnected]);

  const choose = (next: PrivateMode) => {
    setMode(next);
    setEditingAddress(false);
    privately.reset();
  };
  const startTailscale = () => {
    if (confirmReplacing("tailscale")) privately.turnOnTailscale();
  };

  // A status that can't be read is said below; it leaves nothing to press here.
  const action: PhoneAction | null = !ready
    ? remote.error
      ? null
      : { busy: true, label: "Checking…" }
    : connected
      ? null
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
    <div className="private-network">
      <SetupList label="Private network">
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
      {action ? (
        <div className="private-network__action">
          <PhoneActionButton action={action} />
        </div>
      ) : null}
      {remote.error && !remote.status ? (
        <p className="setup-frame__note" role="alert">
          {remote.error}
        </p>
      ) : null}
    </div>
  );
}
