import { copyText } from "@opensteer/shared/clipboard";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AuthSessionSummary } from "@opensteer/core";
import type { DesktopTailscaleStatus, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { useToast } from "../toast.js";
import { Icon } from "../icon.js";
import { sameOrigin, useExpired, type usePrivatePhoneSetup } from "./private-phone-setup.js";
import { QrCode } from "./qr-code.js";
import { SetupRow } from "./setup-list.js";

/**
 * The pieces a phone's way in is drawn with: a code to scan, a private network's panels and
 * the one action each needs next. The first run's phone step and the Private network under
 * Remote access › Advanced draw them the same way.
 */

export const tailscaleDownloadUrl = "https://tailscale.com/download";

/** The footer's one action: what the chosen way needs next, or Finish once a phone can connect. */
export interface PhoneAction {
  readonly label: string;
  /** Working on it: shown, but not pressable. */
  readonly busy?: boolean;
  /** Ends setup, so Skip has nothing left to skip. */
  readonly done?: boolean;
  /** The form this action submits, for a way that needs typing first. */
  readonly form?: string;
  readonly run?: () => void;
}

export function PhoneActionButton({ action }: { readonly action: PhoneAction }) {
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

export function tailscaleAction(input: {
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

export function addressAction(input: {
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

export const addressFormId = "setup-phone-address";

export function ModeRow({
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

export function Panel({ children }: { readonly children: ReactNode }) {
  return <div className="setup-panel">{children}</div>;
}

/** A code to scan, what to do with it, and how the wait is going. */
export function ScanPanel({
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

export function ManualField({ label, value }: { readonly label: string; readonly value: string }) {
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

export function ActionPanel({
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

export function TailscalePanel({
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
          "In the Opensteer app, choose Scan a code, under Other ways in, and scan this code.",
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

export function AddressPanel({
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
          steps={[
            "In the Opensteer app, choose Scan a code, under Other ways in, and scan this code.",
          ]}
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

export function manualEntry(
  privately: ReturnType<typeof usePrivatePhoneSetup>,
): { readonly address: string; readonly code: string } | null {
  return privately.activeOrigin && privately.code
    ? { address: privately.activeOrigin, code: privately.code }
    : null;
}

export function PairingFailed({ message }: { readonly message: string }) {
  return (
    <ActionPanel tone="attention">A code for your phone couldn’t be made: {message}</ActionPanel>
  );
}

export function ArrivedRow({ phone }: { readonly phone: AuthSessionSummary }) {
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
export function useTailscaleStatus(bridge: OpensteerDesktopBridge): {
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
