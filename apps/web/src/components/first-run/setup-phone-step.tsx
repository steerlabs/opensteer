import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { AuthSessionSummary } from "@opensteer/core";
import type { DesktopTailscaleStatus, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { remoteAccessDisconnectWarning } from "@opensteer/client/host";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import {
  supportsPersonalAccountLink,
  usePersonalAccountLink,
} from "../../account/use-personal-account-link.js";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { phoneStepDetail, useNewPhoneSignIn, usePhoneSetup } from "./phone-setup.js";
import {
  initialPhoneMode,
  sameOrigin,
  useExpired,
  usePrivatePhoneSetup,
  type PhoneConnectionMode,
} from "./private-phone-setup.js";
import { QrCode } from "./qr-code.js";
import { SetupFooter, SetupFrame } from "./setup-frame.js";
import { SetupList, SetupRow } from "./setup-list.js";

const tailscaleDownloadUrl = "https://tailscale.com/download";

/**
 * Step three: the person chooses how their phone reaches this computer —
 * Opensteer Connect, their own Tailscale network, or an HTTPS address they
 * run — and scans one code. Choosing changes nothing until they press the
 * panel's button, and replacing a way that is already on asks first, because
 * it disconnects the devices using it.
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
  const { deploymentAccess, desktopBridge, hostClient, snapshot } = useShell();
  const remote = usePersonalRemoteAccess(hostClient);
  const link = usePersonalAccountLink(
    supportsPersonalAccountLink(desktopBridge) ? desktopBridge : null,
    deploymentAccess,
  );
  const connect = usePhoneSetup({
    deploymentAccess,
    deploymentId: snapshot.deploymentId,
    hostClient,
    link,
    portalOrigin: snapshot.identityConfig?.portalOrigin ?? null,
    remote,
  });
  const connectAvailable = connect.reach.kind !== "unavailable";
  const tailscale = useTailscaleStatus(bridge);
  const share = useCallback(() => bridge.tailscaleShare(), [bridge]);
  const privately = usePrivatePhoneSetup({ hostClient, remote, share });
  const [mode, setMode] = useState<PhoneConnectionMode | null>(null);
  const ready = remote.status !== null && tailscale !== null;
  const chosen: PhoneConnectionMode =
    mode ??
    initialPhoneMode({
      connectAvailable,
      status: remote.status,
      tailscaleOrigin: tailscale?.state === "ready" ? tailscale.sharedOrigin : null,
    });
  const activeMode = remote.status?.access.mode ?? "off";
  const tailscaleActive =
    privately.activeOrigin !== null &&
    tailscale?.state === "ready" &&
    privately.activeOrigin === sameOrigin(tailscale.sharedOrigin ?? "");

  /** Replacing a way that is on disconnects whoever uses it, so it asks. */
  const confirmReplacing = (next: PhoneConnectionMode): boolean => {
    const replacing =
      (activeMode === "connect" && next !== "connect") ||
      (activeMode === "private" &&
        (next === "connect" || (next === "tailscale") !== tailscaleActive));
    return !replacing || window.confirm(remoteAccessDisconnectWarning);
  };

  const scanning =
    (chosen === "connect" && connect.reach.kind === "reachable") ||
    (chosen !== "connect" && privately.link !== null && isActive(chosen));
  const arrived = useNewPhoneSignIn(hostClient, scanning);

  function isActive(choice: PhoneConnectionMode): boolean {
    if (choice === "connect") return connect.reach.kind === "reachable";
    if (choice === "tailscale") return tailscaleActive;
    return privately.activeOrigin !== null && !tailscaleActive;
  }

  const choose = (next: PhoneConnectionMode) => {
    setMode(next);
    privately.reset();
    if (connect.started) connect.cancel();
  };

  return (
    <SetupFrame
      description="Check in on your agents and answer them from anywhere."
      footer={
        <SetupFooter
          action={
            <button className="btn btn--primary" onClick={onFinish} type="button">
              Finish
            </button>
          }
          onBack={onBack}
          onSkip={onFinish}
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
      {!ready ? (
        <Panel>
          <p className="setup-panel__status" role="status">
            <span aria-hidden className="spinner" /> Checking…
          </p>
        </Panel>
      ) : arrived ? (
        <SetupList label="Your phone">
          <ArrivedRow phone={arrived} />
        </SetupList>
      ) : chosen === "connect" ? (
        <ConnectPanel
          connect={connect}
          onStart={() => {
            if (confirmReplacing("connect")) connect.start();
          }}
          account={deploymentAccess?.account.status ?? null}
        />
      ) : chosen === "tailscale" ? (
        <TailscalePanel
          active={tailscaleActive}
          bridge={bridge}
          link={privately.link}
          onStart={() => {
            if (confirmReplacing("tailscale")) privately.turnOnTailscale();
          }}
          privately={privately}
          status={tailscale}
        />
      ) : (
        <AddressPanel
          active={privately.activeOrigin !== null && !tailscaleActive}
          link={privately.link}
          onStart={(origin) => {
            if (confirmReplacing("address")) privately.turnOnAddress(origin);
          }}
          origin={tailscaleActive ? null : privately.activeOrigin}
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

function ModeRow({
  checked,
  detail,
  onChoose,
  title,
  trailing,
}: {
  readonly checked: boolean;
  readonly detail: string;
  readonly onChoose: () => void;
  readonly title: string;
  readonly trailing?: ReactNode;
}) {
  return (
    <SetupRow
      as="button"
      checked={checked}
      detail={detail}
      icon={<span aria-hidden className="setup-radio" />}
      onClick={onChoose}
      role="radio"
      title={title}
      trailing={trailing}
    />
  );
}

function Panel({ children }: { readonly children: ReactNode }) {
  return <div className="setup-panel">{children}</div>;
}

/** A code to scan, what to do with it, and how the wait is going. */
function ScanPanel({
  expired = false,
  label,
  onRenew,
  steps,
  value,
}: {
  readonly expired?: boolean;
  readonly label: string;
  readonly onRenew?: () => void;
  readonly steps: readonly string[];
  readonly value: string;
}) {
  return (
    <Panel>
      <div className="setup-scan">
        <div className={expired ? "setup-scan__code setup-scan__code--expired" : "setup-scan__code"}>
          <QrCode label={label} value={value} />
        </div>
        <div className="setup-scan__side">
          <ol className="setup-steps">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {expired ? (
            <span className="setup-scan__wait">
              This code ran out.{" "}
              <button className="btn btn--small" onClick={onRenew} type="button">
                New code
              </button>
            </span>
          ) : (
            <span className="setup-scan__wait" role="status">
              <span aria-hidden className="spinner" />
              Waiting for your phone…
            </span>
          )}
        </div>
      </div>
    </Panel>
  );
}

function ActionPanel({
  action,
  children,
  tone = "idle",
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly tone?: "attention" | "idle";
}) {
  return (
    <Panel>
      <div className={`setup-panel__row setup-panel__row--${tone}`}>
        <span className="setup-panel__text" role={tone === "attention" ? "alert" : undefined}>
          {children}
        </span>
        {action}
      </div>
    </Panel>
  );
}

function ConnectPanel({
  account,
  connect,
  onStart,
}: {
  readonly account: string | null;
  readonly connect: ReturnType<typeof usePhoneSetup>;
  readonly onStart: () => void;
}) {
  const { phase, reach } = connect;
  if (reach.kind === "reachable") {
    return (
      <ScanPanel
        label="Code that opens this computer on your phone"
        steps={[
          "Scan this code with your phone’s camera.",
          "Get the Opensteer app and sign in with the same account as this computer.",
        ]}
        value={reach.url}
      />
    );
  }
  if (phase.kind === "failed") {
    return (
      <ActionPanel
        action={
          <button className="btn btn--small" onClick={onStart} type="button">
            Try again
          </button>
        }
        tone="attention"
      >
        {phase.message}
      </ActionPanel>
    );
  }
  if (reach.kind === "blocked") {
    return <ActionPanel tone="attention">{reach.message}</ActionPanel>;
  }
  if (connect.started || reach.kind === "checking" || reach.kind === "publishing") {
    return (
      <ActionPanel action={<span aria-hidden className="spinner" />}>
        {phoneStepDetail(connect, account)}
      </ActionPanel>
    );
  }
  return (
    <ActionPanel
      action={
        <button className="btn btn--small btn--primary" onClick={onStart} type="button">
          Turn on
        </button>
      }
    >
      Sign in to your Opensteer account in your browser to turn this on.
    </ActionPanel>
  );
}

function TailscalePanel({
  active,
  bridge,
  link,
  onStart,
  privately,
  status,
}: {
  readonly active: boolean;
  readonly bridge: OpensteerDesktopBridge;
  readonly link: string | null;
  readonly onStart: () => void;
  readonly privately: ReturnType<typeof usePrivatePhoneSetup>;
  readonly status: DesktopTailscaleStatus | null;
}) {
  const expired = useExpired(active ? privately.expiresAt : null);
  if (active && link) {
    return (
      <ScanPanel
        expired={expired}
        label="Code that pairs your phone over Tailscale"
        onRenew={privately.renew}
        steps={[
          "Turn on Tailscale on your phone.",
          "In the Opensteer app, tap Scan QR Code and scan this code.",
        ]}
        value={link}
      />
    );
  }
  const { phase } = privately;
  if (phase.kind === "failed") {
    return (
      <ActionPanel
        action={
          <button className="btn btn--small" onClick={onStart} type="button">
            Try again
          </button>
        }
        tone="attention"
      >
        {phase.message}
      </ActionPanel>
    );
  }
  if (phase.kind !== "idle" || active) {
    return (
      <ActionPanel action={<span aria-hidden className="spinner" />}>
        {phase.kind === "sharing" ? "Sharing this computer on your tailnet…" : "Turning on…"}
      </ActionPanel>
    );
  }
  if (status?.state === "not-installed") {
    return (
      <ActionPanel
        action={
          <button
            className="btn btn--small"
            onClick={() =>
              void bridge.openExternalUrl({ url: tailscaleDownloadUrl }).catch(() => undefined)
            }
            type="button"
          >
            Get Tailscale
          </button>
        }
      >
        Install Tailscale on this computer and your phone, and sign in to both.
      </ActionPanel>
    );
  }
  if (status?.state === "not-running") {
    return (
      <ActionPanel>Open Tailscale on this computer and sign in. This updates on its own.</ActionPanel>
    );
  }
  return (
    <ActionPanel
      action={
        <button className="btn btn--small btn--primary" onClick={onStart} type="button">
          Turn on
        </button>
      }
    >
      Share Opensteer on your tailnet as{" "}
      <span className="setup-mono">{status?.state === "ready" ? status.dnsName : "this computer"}</span>
      . Only your own devices can reach it.
    </ActionPanel>
  );
}

function AddressPanel({
  active,
  link,
  onStart,
  origin,
  privately,
}: {
  readonly active: boolean;
  readonly link: string | null;
  readonly onStart: (origin: string) => void;
  readonly origin: string | null;
  readonly privately: ReturnType<typeof usePrivatePhoneSetup>;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const expired = useExpired(active && !editing ? privately.expiresAt : null);
  if (active && link && !editing) {
    return (
      <>
        <ScanPanel
          expired={expired}
          label="Code that pairs your phone at your address"
          onRenew={privately.renew}
          steps={["In the Opensteer app, tap Scan QR Code and scan this code."]}
          value={link}
        />
        <p className="setup-frame__note">
          Phones connect at <span className="setup-mono">{origin}</span>.{" "}
          <button className="btn btn--small btn--ghost" onClick={() => setEditing(true)} type="button">
            Change
          </button>
        </p>
      </>
    );
  }
  const { phase } = privately;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setEditing(false);
    onStart(draft.trim());
  };
  const busy = phase.kind === "turning-on";
  return (
    <Panel>
      <form className="setup-address" onSubmit={submit}>
        <input
          aria-label="Your HTTPS address"
          autoComplete="url"
          className="text-input"
          disabled={busy}
          inputMode="url"
          onChange={(event) => setDraft(event.target.value)}
          placeholder="https://mac.example.com"
          spellCheck={false}
          type="url"
          value={draft}
        />
        <button
          className="btn btn--small btn--primary"
          disabled={busy || draft.trim().length === 0}
          type="submit"
        >
          {busy ? "Turning on…" : "Turn on"}
        </button>
      </form>
      <p
        className={
          phase.kind === "failed" ? "setup-panel__hint setup-panel__hint--attention" : "setup-panel__hint"
        }
        role={phase.kind === "failed" ? "alert" : undefined}
      >
        {phase.kind === "failed"
          ? phase.message
          : "It must reach this computer’s Opensteer, for example through a reverse proxy."}
      </p>
    </Panel>
  );
}

function ArrivedRow({ phone }: { readonly phone: AuthSessionSummary }) {
  return (
    <SetupRow
      icon={<Icon name="phone" />}
      title={phone.deviceLabel}
      tone="ready"
      trailing={
        <span className="setup-done">
          <Icon name="check" />
          Signed in
        </span>
      }
    />
  );
}

/** Tailscale's state on this computer, read again whenever the window comes back. */
function useTailscaleStatus(bridge: OpensteerDesktopBridge): DesktopTailscaleStatus | null {
  const [status, setStatus] = useState<DesktopTailscaleStatus | null>(null);
  useEffect(() => {
    let live = true;
    let reading = false;
    const read = () => {
      if (reading) return;
      reading = true;
      void bridge
        .tailscaleStatus()
        .then(
          (next) => {
            if (live) setStatus(next);
          },
          () => {
            if (live) setStatus({ state: "not-installed" });
          },
        )
        .finally(() => {
          reading = false;
        });
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [bridge]);
  return status;
}
