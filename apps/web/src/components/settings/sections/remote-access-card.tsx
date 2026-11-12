import { useId, useState } from "react";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import { remoteAccessDisconnectWarning } from "@opensteer/client/host";
import { useShell } from "../../app-shell.js";
import type {
  RemoteAccessAction as CoreAction,
  RemoteAccessStep as CoreStep,
  RemoteAccessView,
} from "@opensteer/client/host";
import { useWebRemoteAccess } from "../../../account/remote-access-port.js";

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
  readonly secondary: readonly RemoteAccessAction[];
  readonly pairing: { readonly code: string; readonly expiresAt: string } | null;
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
  readonly removeLink: (() => void) | null;
  readonly busy: boolean;
}

export function RemoteAccessCard() {
  return <RemoteAccessCardView model={useRemoteAccessCardModel()} />;
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
            {model.pairing ? (
              <span className="card__row-detail">
                Enter <code>{model.pairing.code}</code> on the other device. It works once, until{" "}
                {new Date(model.pairing.expiresAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
                .
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
          {model.primary || model.secondary.length > 0 ? (
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
              {model.secondary.map((secondary) => (
                <button
                  className="btn"
                  disabled={secondary.disabled}
                  key={secondary.label}
                  onClick={secondary.run}
                  type="button"
                >
                  {secondary.label}
                </button>
              ))}
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
function useRemoteAccessCardModel(): RemoteAccessCardModel {
  const shell = useShell();
  const remote = usePersonalRemoteAccess(shell.hostClient);
  const controller = useWebRemoteAccess(remote);
  const { view } = controller;
  const status = remote.status;
  const access = status?.access ?? null;
  const operation = status?.operation ?? null;
  const busy =
    remote.working ||
    view.tone === "busy" ||
    operation?.state === "pending" ||
    operation?.state === "running";
  const action = (offered: CoreAction | null): RemoteAccessAction | null =>
    offered
      ? {
          label: offered.label,
          run: () => {
            if (offered.confirm && !window.confirm(offered.confirm)) return;
            controller.act(offered.id);
          },
        }
      : null;
  const offered = (id: CoreAction["id"]) =>
    [view.primary, ...view.secondary].find((candidate) => candidate?.id === id) ?? null;
  // Rare, technical actions live under Advanced; the card keeps the one obvious choice.
  const inAdvanced = new Set<CoreAction["id"]>(["reset-key", "remove-link"]);
  const showAdvanced =
    status !== null &&
    (view.state === "connect-unavailable" ||
      view.state === "on-connect" ||
      view.state === "on-private" ||
      view.state === "off");
  return {
    tone: toneOf[view.tone],
    title: view.title,
    sentence: view.sentence,
    address: view.address,
    steps: view.steps?.map((step) => ({ label: step.label, state: stepStateOf[step.state] })) ?? null,
    primary: action(view.primary && !inAdvanced.has(view.primary.id) ? view.primary : null),
    secondary: view.secondary
      .filter((candidate) => !inAdvanced.has(candidate.id))
      .map((candidate) => action(candidate)!),
    pairing: controller.pairing,
    advanced:
      showAdvanced && access
        ? {
            method:
              access.mode === "off" ? (status.accountIssuer ? "connect" : null) : access.mode,
            privateOrigin:
              access.mode === "private" ? (access.route?.document.route.origin ?? "") : "",
            // A private network address is typed, not chosen, so it goes to the Host as-is.
            usePrivateNetwork: (origin) => {
              const warning = access.mode === "off" ? null : remoteAccessDisconnectWarning;
              if (warning && !window.confirm(warning)) return;
              void remote.request?.({ action: "configure", mode: "private", privateOrigin: origin });
            },
            useAccount:
              status.accountIssuer && access.mode !== "connect" ? () => controller.act("turn-on") : null,
            resetKey: action(offered("reset-key"))?.run ?? null,
            removeLink: action(offered("remove-link"))?.run ?? null,
            busy,
          }
        : null,
  };
}

const toneOf: Record<RemoteAccessView["tone"], RemoteAccessCardModel["tone"]> = {
  attention: "error",
  busy: "busy",
  neutral: "off",
  on: "ok",
};

type RemoteAccessStepState = CoreStep["state"];

const stepStateOf: Record<RemoteAccessStepState, RemoteAccessStep["state"]> = {
  active: "now",
  done: "done",
  todo: "todo",
};
