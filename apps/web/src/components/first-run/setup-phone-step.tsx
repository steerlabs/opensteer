import { useToast } from "../toast.js";
import { copyText } from "@opensteer/shared/clipboard";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AuthSessionSummary } from "@opensteer/core";
import type { DesktopTailscaleStatus, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { remoteAccessDisconnectWarning } from "@opensteer/client/host";
import { usePersonalRemoteAccess, type RemoteAccessController } from "@opensteer/client/react";
import { useWebRemoteAccess } from "../../account/remote-access-port.js";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { phoneConnectUrl, useNewPhoneSignIn } from "./phone-setup.js";
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

/** The footer's one action: what the chosen way needs next, or Finish once a phone can connect. */
interface PhoneAction {
  readonly label: string;
  /** Working on it: shown, but not pressable. */
  readonly busy?: boolean;
  /** Ends setup, so Skip has nothing left to skip. */
  readonly done?: boolean;
  /** The form this action submits, for a way that needs typing first. */
  readonly form?: string;
  readonly run?: () => void;
}

function PhoneActionButton({ action }: { readonly action: PhoneAction }) {
  const pressable = !action.busy && (action.run !== undefined || action.form !== undefined);
  return (
    <button
      aria-busy={action.busy || undefined}
      className="btn btn--primary setup-action"
      disabled={!pressable}
      form={action.form}
      onClick={action.run}
      type={action.form ? "submit" : "button"}
    >
      {action.busy ? <span aria-hidden className="spinner" /> : null}
      {action.label}
    </button>
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

function tailscaleAction(input: {
  readonly active: boolean;
  readonly bridge: OpensteerDesktopBridge;
  readonly privately: ReturnType<typeof usePrivatePhoneSetup>;
  readonly start: () => void;
  readonly status: DesktopTailscaleStatus | null;
}): PhoneAction {
  const { active, bridge, privately, start, status } = input;
  if (active && privately.pairingError) return { label: "Try again", run: privately.renew };
  if (privately.phase.kind === "failed") return { label: "Try again", run: start };
  if (privately.phase.kind !== "idle" || active) return { busy: true, label: "Turning on…" };
  if (status?.state === "not-installed")
    return {
      label: "Get Tailscale",
      run: () => void bridge.openExternalUrl({ url: tailscaleDownloadUrl }).catch(() => undefined),
    };
  if (status?.state === "not-running") return { busy: true, label: "Waiting for Tailscale" };
  return { label: "Turn on", run: start };
}

function addressAction(input: {
  readonly active: boolean;
  readonly editing: boolean;
  readonly privately: ReturnType<typeof usePrivatePhoneSetup>;
}): PhoneAction {
  const { active, editing, privately } = input;
  if (active && !editing && privately.pairingError)
    return { label: "Try again", run: privately.renew };
  if (privately.phase.kind === "turning-on") return { busy: true, label: "Turning on…" };
  return { form: addressFormId, label: "Turn on" };
}

const addressFormId = "setup-phone-address";

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
  manual = null,
  onRenew,
  steps,
  value,
}: {
  readonly expired?: boolean;
  readonly label: string;
  readonly onRenew?: () => void;
  readonly steps: readonly string[];
  readonly value: string;
  /** What the code carries, for a phone that cannot scan it. */
  readonly manual?: { readonly address: string; readonly code: string } | null;
}) {
  return (
    <Panel>
      <div className="setup-scan">
        <div
          className={expired ? "setup-scan__code setup-scan__code--expired" : "setup-scan__code"}
        >
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
      {manual && !expired ? (
        <details className="setup-manual">
          <summary>Can’t scan? Enter it on your phone</summary>
          <dl className="setup-manual__fields">
            <ManualField label="Address" value={manual.address} />
            <ManualField label="Pairing code" value={manual.code} />
          </dl>
        </details>
      ) : null}
    </Panel>
  );
}

function ManualField({ label, value }: { readonly label: string; readonly value: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="setup-manual__field">
      <dt>{label}</dt>
      <dd>
        <span className="setup-mono">{value}</span>
        <button
          aria-label={`Copy ${label.toLowerCase()}`}
          className="btn btn--small btn--ghost"
          onClick={() =>
            void copyText(value).then((success) =>
              success
                ? setCopied(true)
                : toast.error("Copy was blocked. Select the text to copy it."),
            )
          }
          type="button"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </dd>
    </div>
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
          <ol aria-label="Turning on Connect" className="setup-checks">
            {view.steps.map((step) => (
              <li
                className={`setup-checks__item setup-checks__item--${step.state}`}
                key={step.label}
              >
                <span aria-hidden className="setup-checks__mark" />
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
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

function TailscalePanel({
  active,
  link,
  privately,
  status,
}: {
  readonly active: boolean;
  readonly link: string | null;
  readonly privately: ReturnType<typeof usePrivatePhoneSetup>;
  readonly status: DesktopTailscaleStatus | null;
}) {
  const expired = useExpired(active ? privately.expiresAt : null);
  if (active && link) {
    return (
      <ScanPanel
        expired={expired}
        label="Code that pairs your phone over Tailscale"
        manual={manualEntry(privately)}
        onRenew={privately.renew}
        steps={[
          "Turn on Tailscale on your phone.",
          "In the Opensteer app, tap Scan QR Code and scan this code.",
        ]}
        value={link}
      />
    );
  }
  if (active && privately.pairingError) return <PairingFailed message={privately.pairingError} />;
  const { phase } = privately;
  if (phase.kind === "failed") return <ActionPanel tone="attention">{phase.message}</ActionPanel>;
  if (phase.kind !== "idle" || active) {
    return (
      <ActionPanel>
        {phase.kind === "sharing" ? "Sharing this computer on your tailnet…" : "Turning on…"}
      </ActionPanel>
    );
  }
  if (status?.state === "not-installed") {
    return (
      <ActionPanel>
        Install Tailscale on this computer and your phone, and sign in to both.
      </ActionPanel>
    );
  }
  if (status?.state === "not-running") {
    return (
      <ActionPanel>
        Open Tailscale on this computer and sign in. This updates on its own.
      </ActionPanel>
    );
  }
  return (
    <ActionPanel>
      Shares Opensteer on your tailnet as{" "}
      <span className="setup-mono">
        {status?.state === "ready" ? status.dnsName : "this computer"}
      </span>
      . Only your own devices can reach it.
    </ActionPanel>
  );
}

function AddressPanel({
  active,
  editing,
  link,
  onEditing,
  onStart,
  origin,
  privately,
}: {
  readonly active: boolean;
  readonly editing: boolean;
  readonly link: string | null;
  readonly onEditing: (editing: boolean) => void;
  readonly onStart: (origin: string) => void;
  readonly origin: string | null;
  readonly privately: ReturnType<typeof usePrivatePhoneSetup>;
}) {
  const [draft, setDraft] = useState("");
  // The address asked for: the editor stays open, with its progress and any
  // failure, until the Host answers there, rather than falling back to the
  // old address's code while the change is still undecided.
  const [submitted, setSubmitted] = useState<string | null>(null);
  useEffect(() => {
    if (submitted !== null && origin !== null && sameOrigin(submitted) === origin) {
      setSubmitted(null);
      onEditing(false);
    }
  }, [onEditing, origin, submitted]);
  const expired = useExpired(active && !editing ? privately.expiresAt : null);
  if (active && link && !editing) {
    return (
      <>
        <ScanPanel
          expired={expired}
          label="Code that pairs your phone at your address"
          manual={manualEntry(privately)}
          onRenew={privately.renew}
          steps={["In the Opensteer app, tap Scan QR Code and scan this code."]}
          value={link}
        />
        <p className="setup-frame__note">
          Phones connect at <span className="setup-mono">{origin}</span>.{" "}
          <button
            className="btn btn--small btn--ghost"
            onClick={() => onEditing(true)}
            type="button"
          >
            Change
          </button>
        </p>
      </>
    );
  }
  if (active && !editing && privately.pairingError) {
    return <PairingFailed message={privately.pairingError} />;
  }
  const { phase } = privately;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = draft.trim();
    if (!wanted) return;
    setSubmitted(wanted);
    onStart(wanted);
  };
  const busy = phase.kind === "turning-on";
  return (
    <Panel>
      <form className="setup-address" id={addressFormId} onSubmit={submit}>
        <input
          aria-label="Your HTTPS address"
          autoComplete="url"
          autoFocus
          className="text-input"
          disabled={busy}
          inputMode="url"
          onChange={(event) => setDraft(event.target.value)}
          placeholder="https://mac.example.com"
          required
          spellCheck={false}
          type="url"
          value={draft}
        />
        {active && editing && !busy ? (
          <button
            className="btn btn--small btn--ghost"
            onClick={() => {
              onEditing(false);
              setSubmitted(null);
            }}
            type="button"
          >
            Cancel
          </button>
        ) : null}
      </form>
      <p
        className={
          phase.kind === "failed"
            ? "setup-panel__hint setup-panel__hint--attention"
            : "setup-panel__hint"
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

function manualEntry(
  privately: ReturnType<typeof usePrivatePhoneSetup>,
): { readonly address: string; readonly code: string } | null {
  return privately.activeOrigin && privately.code
    ? { address: privately.activeOrigin, code: privately.code }
    : null;
}

function PairingFailed({ message }: { readonly message: string }) {
  return (
    <ActionPanel tone="attention">A code for your phone couldn’t be made: {message}</ActionPanel>
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
function useTailscaleStatus(bridge: OpensteerDesktopBridge): {
  readonly refresh: () => void;
  readonly status: DesktopTailscaleStatus | null;
} {
  const [status, setStatus] = useState<DesktopTailscaleStatus | null>(null);
  const live = useRef(true);
  // One read at a time; a request made during a read runs once it ends.
  const reading = useRef<"idle" | "again" | "reading">("idle");
  const refresh = useCallback(() => {
    if (reading.current !== "idle") {
      reading.current = "again";
      return;
    }
    reading.current = "reading";
    void bridge
      .tailscaleStatus()
      .then(
        (next) => {
          if (live.current) setStatus(next);
        },
        () => {
          if (live.current) setStatus({ state: "not-installed" });
        },
      )
      .finally(() => {
        const again = reading.current === "again";
        reading.current = "idle";
        if (again && live.current) refresh();
      });
  }, [bridge]);
  useEffect(() => {
    live.current = true;
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live.current = false;
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  return { refresh, status };
}
