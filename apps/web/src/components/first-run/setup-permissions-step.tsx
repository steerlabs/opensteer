import { useCallback, useEffect, useState } from "react";
import type {
  DesktopComputerUsePermissionsResult,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { Icon } from "../icon.js";
import { useDesktopPasswordsStatus } from "../use-desktop-passwords-status.js";
import { SetupFooter, SetupFrame } from "./setup-frame.js";
import { SetupList, SetupRow } from "./setup-list.js";

/**
 * Step two, on a Mac running its own Opensteer: what agents may use here. Each
 * row is one thing, said in plain words, with one action that brings up
 * macOS's own question. Nothing is required; an agent that later needs
 * something it was not given asks for it then.
 */
export function SetupPermissionsStep({
  bridge,
  onBack,
  onNext,
  progress,
}: {
  readonly bridge: OpensteerDesktopBridge;
  readonly onBack?: (() => void) | undefined;
  readonly onNext: () => void;
  readonly progress: { readonly count: number; readonly index: number };
}) {
  return (
    <SetupFrame
      description="Choose what Opensteer’s agents can use on this Mac."
      footer={
        <SetupFooter
          action={
            <button className="btn btn--primary" onClick={onNext} type="button">
              Continue
            </button>
          }
          onBack={onBack}
          onSkip={onNext}
        />
      }
      progress={progress}
      stepKey="permissions"
      title="Permissions"
    >
      <SetupList label="Permissions">
        <NotificationsRow bridge={bridge} />
        <AppsRow bridge={bridge} />
        <PasswordsRow bridge={bridge} />
      </SetupList>
      <p className="setup-frame__note">
        macOS asks you to confirm each one. You can change them anytime in Settings.
      </p>
    </SetupFrame>
  );
}

/**
 * macOS gives an app no way to read whether it may notify, so this row never
 * claims "allowed". It sends one real notification — which is also when macOS
 * asks the first time — and points at the system's settings if none arrives.
 */
function NotificationsRow({ bridge }: { readonly bridge: OpensteerDesktopBridge }) {
  const [state, setState] = useState<"failed" | "idle" | "sending" | "sent" | "unsupported">(
    "idle",
  );
  const send = () => {
    setState("sending");
    void bridge.testNotification().then(
      ({ outcome }) => setState(outcome),
      () => setState("failed"),
    );
  };
  if (state === "unsupported") return null;
  const settings = (
    <button
      className="btn btn--small btn--ghost"
      onClick={() => void bridge.openNotificationSettings().catch(() => undefined)}
      type="button"
    >
      Settings
    </button>
  );
  return (
    <SetupRow
      detail={
        state === "sent"
          ? "Sent a test. Didn’t see it? Turn Opensteer on in Settings."
          : state === "failed"
            ? "macOS didn’t show it. Turn Opensteer on in Settings."
            : "Get told when an agent finishes or needs you."
      }
      icon={<Icon name="bell" />}
      title="Notifications"
      tone={state === "failed" ? "attention" : state === "sent" ? "ready" : "idle"}
      trailing={
        state === "sending" ? (
          <span aria-hidden className="spinner" />
        ) : state === "idle" ? (
          <button className="btn btn--small" onClick={send} type="button">
            Turn on
          </button>
        ) : (
          settings
        )
      }
    />
  );
}

/** Seeing and using apps: the helper's Screen Recording and Accessibility grants. */
function AppsRow({ bridge }: { readonly bridge: OpensteerDesktopBridge }) {
  const [grants, setGrants] = useState<DesktopComputerUsePermissionsResult | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [unsigned, setUnsigned] = useState(false);
  const read = useCallback(() => {
    void bridge.computerUsePermissionsGet().then(
      (next) => setGrants(next),
      () => setUnavailable(true),
    );
  }, [bridge]);
  // The grants change in System Settings, so they are read again whenever
  // this window comes back to the front.
  useEffect(() => {
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [read]);
  if (unavailable) return null;
  const allowed = grants?.accessibility === "granted" && grants.screenRecording === "granted";
  return (
    <SetupRow
      detail={
        unsigned
          ? "Needs the signed Opensteer app from opensteer.com."
          : "Let agents see and use apps like Safari, Mail and Notes."
      }
      icon={<Icon name="cursor" />}
      title="Use your apps"
      tone={allowed ? "ready" : "idle"}
      trailing={
        grants === null ? (
          <span aria-hidden className="spinner" />
        ) : allowed ? (
          <Allowed />
        ) : unsigned ? null : (
          <button
            className="btn btn--small"
            onClick={() =>
              void bridge.openComputerUsePermissionsPanel().then(
                (result) => {
                  if (!result.opened) setUnsigned(true);
                },
                () => setUnavailable(true),
              )
            }
            type="button"
          >
            Allow
          </button>
        )
      }
    />
  );
}

function PasswordsRow({ bridge }: { readonly bridge: OpensteerDesktopBridge }) {
  const { status } = useDesktopPasswordsStatus(bridge);
  if (!status || status.availability !== "available") return null;
  const vault = status.broker.vault;
  if (vault === "unsupported") return null;
  return (
    <SetupRow
      detail="Let agents sign in to websites for you."
      icon={<Icon name="key" />}
      title="Saved passwords"
      tone={vault === "ready" ? "ready" : "idle"}
      trailing={
        vault === "ready" ? (
          <Allowed label="Set up" />
        ) : (
          <button
            className="btn btn--small"
            onClick={() => void bridge.passwordsOpen().catch(() => undefined)}
            type="button"
          >
            Set up
          </button>
        )
      }
    />
  );
}

function Allowed({ label = "Allowed" }: { readonly label?: string }) {
  return (
    <span className="setup-done">
      <Icon name="check" />
      {label}
    </span>
  );
}
