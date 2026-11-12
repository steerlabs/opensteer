import { useState } from "react";
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
  readonly detail?: string | null;
  readonly destructive?: boolean;
}

/** What the shared view keeps under Advanced. */
export interface RemoteAccessAdvanced {
  readonly actions: readonly RemoteAccessAction[];
  /** Typing a private network address; null when the view doesn't offer it. */
  readonly privateNetwork: {
    readonly origin: string;
    readonly save: (origin: string) => void;
  } | null;
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
  const [origin, setOrigin] = useState(advanced.privateNetwork?.origin ?? "");
  return (
    <details className="settings-advanced">
      <summary>Advanced</summary>
      <div className="card">
        {advanced.privateNetwork ? (
          <form
            className="card__row settings-remote__private"
            onSubmit={(event) => {
              event.preventDefault();
              advanced.privateNetwork?.save(origin.trim());
            }}
          >
            <input
              aria-label="Private network address"
              className="text-input"
              onChange={(event) => setOrigin(event.target.value)}
              placeholder="https://my-mac.tailnet.ts.net"
              required
              type="url"
              value={origin}
            />
            <button className="btn" type="submit">
              Use this address
            </button>
          </form>
        ) : null}
        {advanced.actions.map((action) => (
          <div className="card__row" key={action.label}>
            <span className="card__row-body">
              <span className="card__row-detail">{action.detail}</span>
            </span>
            <button
              className={action.destructive ? "settings-link settings-link--danger" : "btn"}
              disabled={action.disabled}
              onClick={action.run}
              type="button"
            >
              {action.label}
            </button>
          </div>
        ))}
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
  const action = (offered: CoreAction): RemoteAccessAction => ({
    label: offered.label,
    detail: offered.detail,
    destructive: offered.id === "remove-link",
    run: () => {
      if (offered.confirm && !window.confirm(offered.confirm)) return;
      controller.act(offered.id);
    },
  });
  return {
    tone: toneOf[view.tone],
    title: view.title,
    sentence: view.sentence,
    address: view.address,
    steps:
      view.steps?.map((step) => ({ label: step.label, state: stepStateOf[step.state] })) ?? null,
    primary: view.primary ? action(view.primary) : null,
    secondary: view.secondary.map(action),
    pairing: controller.pairing,
    advanced:
      view.advanced.length > 0 || view.privateNetwork
        ? {
            actions: view.advanced.map(action),
            privateNetwork: view.privateNetwork
              ? {
                  origin: view.state === "on-private" ? (view.address ?? "") : "",
                  // A private network address is typed, not chosen, so it goes to the Host as-is.
                  save: (origin) => {
                    if (view.on && !window.confirm(remoteAccessDisconnectWarning)) return;
                    controller.setPrivateNetwork(origin);
                  },
                }
              : null,
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
