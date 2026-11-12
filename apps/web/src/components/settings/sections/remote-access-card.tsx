import { useId, useState } from "react";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import { remoteAccessDisconnectWarning } from "@opensteer/client/host";
import type { PersonalRemoteAdministrationIntent } from "@opensteer/protocol";
import { useShell } from "../../app-shell.js";
import { linkAccountFromWeb } from "../link-personal-account.js";
import type { SettingsView } from "../primitives.js";

/**
 * "Use from anywhere": one status, one sentence, one action. Everything the
 * card shows comes from `RemoteAccessCardModel`; `useRemoteAccessCardModel`
 * is the only place that reads remote-access state.
 */
export interface RemoteAccessCardModel {
  readonly tone: "off" | "ok" | "busy" | "error";
  readonly title: string;
  readonly sentence: string | null;
  readonly address: string | null;
  readonly steps: readonly RemoteAccessStep[] | null;
  readonly primary: RemoteAccessAction | null;
  readonly secondary: RemoteAccessAction | null;
  readonly advanced: RemoteAccessAdvanced | null;
}

export interface RemoteAccessStep {
  readonly label: string;
  readonly state: "done" | "now" | "failed" | "todo";
}

export interface RemoteAccessAction {
  readonly label: string;
  readonly run: () => void;
  readonly disabled?: boolean;
}

export interface RemoteAccessAdvanced {
  /** Null when this build has no Opensteer Account to connect through. */
  readonly method: "connect" | "private" | null;
  readonly privateOrigin: string;
  readonly usePrivateNetwork: ((origin: string) => void) | null;
  readonly useAccount: (() => void) | null;
  readonly resetKey: (() => void) | null;
  readonly addDevice: (() => void) | null;
  readonly pairing: { readonly code: string; readonly expiresAt: string } | null;
  readonly removeLink: (() => void) | null;
  readonly busy: boolean;
}

export function RemoteAccessCard({ view }: { readonly view: SettingsView }) {
  return <RemoteAccessCardView model={useRemoteAccessCardModel(view)} />;
}

export function RemoteAccessCardView({ model }: { readonly model: RemoteAccessCardModel }) {
  const [copied, setCopied] = useState(false);
  return (
    <section aria-labelledby="settings-remote-access" className="settings-group">
      <h2 className="settings-group__title" id="settings-remote-access">
        Use from anywhere
      </h2>
      <div className="card">
        <div className="card__row settings-remote">
          <span className="card__row-body">
            <span className="card__row-title">
              <span aria-hidden className={`status-dot settings-remote__dot--${model.tone}`} />
              {model.title}
            </span>
            {model.sentence ? (
              <span
                className={`card__row-detail${model.tone === "error" ? " card__row-detail--error" : ""}`}
                role={model.tone === "error" ? "alert" : undefined}
              >
                {model.sentence}
              </span>
            ) : null}
            {model.address ? (
              <span className="card__row-detail settings-remote__address">
                <code>{model.address}</code>
                <button
                  className="settings-link"
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(model.address!)
                      .then(() => setCopied(true))
                      .catch(() => undefined)
                  }
                  type="button"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </span>
            ) : null}
            {model.steps ? (
              <ol className="settings-steps" aria-label="Progress">
                {model.steps.map((step) => (
                  <li className={`settings-steps__step is-${step.state}`} key={step.label}>
                    <span aria-hidden className="settings-steps__mark">
                      {step.state === "done" ? "✓" : step.state === "failed" ? "✕" : ""}
                    </span>
                    {step.label}
                  </li>
                ))}
              </ol>
            ) : null}
          </span>
          {model.primary || model.secondary ? (
            <span className="card__row-actions settings-remote__actions">
              {model.primary ? (
                <button
                  className="btn btn--primary"
                  disabled={model.primary.disabled}
                  onClick={model.primary.run}
                  type="button"
                >
                  {model.primary.label}
                </button>
              ) : null}
              {model.secondary ? (
                <button
                  className="btn"
                  disabled={model.secondary.disabled}
                  onClick={model.secondary.run}
                  type="button"
                >
                  {model.secondary.label}
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
      {model.advanced ? <Advanced advanced={model.advanced} /> : null}
    </section>
  );
}

function Advanced({ advanced }: { readonly advanced: RemoteAccessAdvanced }) {
  const id = useId();
  const [choosingPrivate, setChoosingPrivate] = useState(false);
  const [origin, setOrigin] = useState(advanced.privateOrigin);
  const accountOffered = advanced.useAccount !== null || advanced.method === "connect";
  const method = choosingPrivate || !accountOffered ? "private" : advanced.method;
  return (
    <details className="settings-advanced">
      <summary>Advanced</summary>
      <div className="card">
        {accountOffered ? (
          <div className="card__row card__row--choice">
            <span className="card__row-body">
              <label className="card__row-title" htmlFor={`${id}-method`}>
                How other devices connect
              </label>
              <span className="card__row-detail">
                {method === "private"
                  ? "Your own private network"
                  : "Through your Opensteer Account"}
              </span>
            </span>
            <span className="card__row-actions">
              <select
                className="settings-select"
                disabled={advanced.busy}
                id={`${id}-method`}
                onChange={(event) => {
                  if (event.currentTarget.value === "private") setChoosingPrivate(true);
                  else {
                    setChoosingPrivate(false);
                    advanced.useAccount?.();
                  }
                }}
                value={method ?? "private"}
              >
                <option value="connect">Opensteer Account</option>
                <option value="private">Private network…</option>
              </select>
            </span>
          </div>
        ) : null}
        {method === "private" && advanced.usePrivateNetwork ? (
          <form
            className="card__row settings-remote__private"
            onSubmit={(event) => {
              event.preventDefault();
              setChoosingPrivate(false);
              advanced.usePrivateNetwork?.(origin.trim());
            }}
          >
            <input
              aria-label="Private HTTPS address"
              className="text-input"
              onChange={(event) => setOrigin(event.target.value)}
              placeholder="https://my-mac.tailnet.ts.net"
              required
              type="url"
              value={origin}
            />
            <button className="btn" disabled={advanced.busy} type="submit">
              Save
            </button>
          </form>
        ) : null}
        {advanced.addDevice ? (
          <div className="card__row">
            <span className="card__row-body">
              <span className="card__row-title">Add a device</span>
              <span className="card__row-detail">
                {advanced.pairing ? (
                  <>
                    <code>{advanced.pairing.code}</code> · works once, until{" "}
                    {new Date(advanced.pairing.expiresAt).toLocaleTimeString()}
                  </>
                ) : (
                  "Makes a one-time code that works for ten minutes."
                )}
              </span>
            </span>
            <button
              className="btn"
              disabled={advanced.busy}
              onClick={advanced.addDevice}
              type="button"
            >
              Make code
            </button>
          </div>
        ) : null}
        {advanced.resetKey ? (
          <div className="card__row">
            <span className="card__row-body">
              <span className="card__row-title">Reset connection key</span>
              <span className="card__row-detail">
                Only if you think it leaked. Your devices reconnect on their own.
              </span>
            </span>
            <button
              className="btn"
              disabled={advanced.busy}
              onClick={advanced.resetKey}
              type="button"
            >
              Reset
            </button>
          </div>
        ) : null}
        {advanced.removeLink ? (
          <div className="card__row">
            <span className="card__row-body">
              <span className="card__row-title">Remove from your Account</span>
              <span className="card__row-detail">
                Your devices stop reaching this computer from anywhere.
              </span>
            </span>
            <button
              className="settings-link settings-link--danger"
              disabled={advanced.busy}
              onClick={advanced.removeLink}
              type="button"
            >
              Remove
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** Today's remote-access state, read from the Host, in the card's words. */
function useRemoteAccessCardModel(view: SettingsView): RemoteAccessCardModel {
  const shell = useShell();
  const remote = usePersonalRemoteAccess(shell.hostClient);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const status = remote.status;
  const error = linkError ?? remote.error;
  if (!status)
    return {
      ...empty,
      tone: error ? "error" : "off",
      title: error ? "Couldn’t check" : "Checking…",
      sentence: error,
    };
  const access = status.access;
  const operation = status.operation;
  const outstanding = operation?.state === "pending" || operation?.state === "running";
  const busy = remote.working || linking || outstanding;
  const connectAvailable = status.accountIssuer !== null;
  const linked = access.accountLink?.state === "active";
  const request = (intent: PersonalRemoteAdministrationIntent) => {
    const disconnects =
      intent.action === "unlink" ||
      intent.action === "rotate" ||
      (intent.action === "configure" && access.mode !== "off");
    if (disconnects && !window.confirm(remoteAccessDisconnectWarning)) return;
    setLinkError(null);
    void remote.request?.(intent);
  };
  const turnOn = () => {
    if (linked) {
      request({ action: "configure", mode: "connect", privateOrigin: null });
      return;
    }
    setLinking(true);
    setLinkError(null);
    void linkAccountFromWeb(shell, status, view.name)
      .then(() => remote.request?.({ action: "configure", mode: "connect", privateOrigin: null }))
      .catch((reason: unknown) =>
        setLinkError(reason instanceof Error ? reason.message : "Something went wrong. Try again."),
      )
      .finally(() => setLinking(false));
  };
  const turnOff = () => request({ action: "configure", mode: "off", privateOrigin: null });
  const advanced: RemoteAccessAdvanced = {
    method: access.mode === "off" ? (connectAvailable ? "connect" : null) : access.mode,
    privateOrigin: access.mode === "private" ? (access.route?.document.route.origin ?? "") : "",
    usePrivateNetwork: (origin) =>
      request({ action: "configure", mode: "private", privateOrigin: origin }),
    useAccount: connectAvailable && access.mode !== "connect" ? turnOn : null,
    resetKey: access.mode === "connect" ? () => request({ action: "rotate" }) : null,
    addDevice: access.mode === "private" ? () => void remote.pair?.() : null,
    pairing: remote.pairing,
    removeLink: access.accountLink ? () => request({ action: "unlink" }) : null,
    busy,
  };
  const failed = operation?.state === "failed" && !remote.working && !linking;
  const tryAgain = { label: "Try again", run: () => request({ action: "recover" }) };
  const intent = operation?.intent;
  const turningOff = intent?.action === "configure" && intent.mode === "off";

  if (access.mode === "off") {
    if (linking || (outstanding && !turningOff))
      return {
        ...empty,
        tone: "busy",
        title: "Turning on…",
        sentence:
          outstanding && !status.executorConnected
            ? `Waiting for Opensteer on ${view.name} to open.`
            : null,
        steps: [
          { label: "Add this computer to your Account", state: linked ? "done" : "now" },
          { label: "Open a secure connection", state: linked ? "now" : "todo" },
          { label: "Share its address with your devices", state: "todo" },
        ],
        secondary: { label: "Cancel", run: turnOff, disabled: !outstanding },
      };
    if (failed && !turningOff)
      return {
        ...empty,
        tone: "error",
        title: "Couldn’t turn on",
        sentence: operation.detail ?? "Something went wrong. Try again.",
        primary: tryAgain,
        secondary: { label: "Cancel", run: turnOff },
        advanced,
      };
    return {
      ...empty,
      tone: error ? "error" : "off",
      title: "Off",
      sentence:
        error ??
        (connectAvailable
          ? `Only ${view.name} can use Opensteer. Turn on to open it from your phone, on any network.`
          : "Add a private network address under Advanced to open it from your other devices."),
      primary: connectAvailable ? { label: "Turn on", run: turnOn, disabled: busy } : null,
      advanced: connectAvailable ? null : advanced,
    };
  }
  const address = access.route?.document.route.origin ?? null;
  if (outstanding && turningOff) return { ...empty, tone: "busy", title: "Turning off…", address };
  return {
    ...empty,
    tone: failed || error ? "error" : "ok",
    title: "On",
    sentence: failed
      ? (operation.detail ?? "Something went wrong. Try again.")
      : (error ??
        (access.mode === "connect"
          ? `Your phone and signed-in computers can open ${view.name} from anywhere.`
          : `Devices you add can open ${view.name} through your private network.`)),
    address,
    primary: failed ? tryAgain : null,
    secondary: { label: "Turn off", run: turnOff, disabled: busy },
    advanced,
  };
}

const empty: RemoteAccessCardModel = {
  tone: "off",
  title: "",
  sentence: null,
  address: null,
  steps: null,
  primary: null,
  secondary: null,
  advanced: null,
};
