import { hostDeploymentPolicy } from "@opensteer/client/host";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  mutationIdempotencyKey,
  passwordsAgentSignInsDetail,
  passwordsAgentSignInsLabel,
  passwordsDevelopmentBanner,
  passwordsElsewhere,
  passwordsHowItWorks,
  passwordsHowItWorksLabel,
  passwordsNeedsReset,
  passwordsOpenAction,
  passwordsPersonFillLabel,
  passwordsPersonSaveLabel,
  passwordsSavedDetail,
  passwordsSavedLabel,
  passwordsSettingsState,
  passwordsSetUpAction,
  passwordsDeclineAllAction,
  passwordsDecliningAllAction,
  passwordsSetUpFacts,
  passwordsSetUpLead,
  passwordsWaitingDetail,
  passwordsWaitingLabel,
  type HostClient,
  type PasswordsSettingsState,
} from "@opensteer/client/host";
import type { Request } from "@opensteer/core";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { Icon, type IconName } from "../../icon.js";
import { LoadingRows } from "../../loading-rows.js";
import { useDesktopPasswordsStatus } from "../../use-desktop-passwords-status.js";
import { SettingsError, SettingsRow, type SettingsView } from "../primitives.js";
import { useHomeComputer } from "./devices.js";

type PasswordsBridge = Pick<
  OpensteerDesktopBridge,
  "onPasswordsStatusChanged" | "passwordsOpen" | "passwordsStatus"
>;

/**
 * Settings → Passwords. The passwords live in their own window on the Mac
 * that runs this Personal Opensteer, so only the desktop app on that Mac draws
 * controls; everywhere else names the Mac, as the rest of Settings does for a
 * setting that lives on another computer.
 */
export function PasswordsSection({ view }: { readonly view: SettingsView }) {
  const { desktopBridge, hostClient, snapshot } = useShell();
  const home = useHomeComputer();
  const personal = hostDeploymentPolicy(snapshot)?.nativePasswords === true;
  const onThisMac = desktopBridge !== null && personal && view.facts.onThisComputer;
  return (
    <>
      <h2 className="settings-group__title">Passwords</h2>
      {onThisMac ? (
        <PasswordsOnThisMac
          bridge={desktopBridge}
          client={hostClient}
          waiting={snapshot.waitingRequests}
        />
      ) : (
        <div className="card">
          <SettingsRow
            detail={passwordsElsewhere({ homeName: home.name ?? view.name, personal })}
            icon={personal ? home.icon : "server"}
            title={personal ? (home.name ?? view.name) : "Not available on this Opensteer"}
          />
        </div>
      )}
    </>
  );
}

type Busy = "decline" | "open" | null;

/**
 * The Mac's own status, followed while the page is open, and the sign-in
 * Requests waiting for the person in their conversations, which Don’t allow
 * all declines as each card's Don’t allow would.
 */
function PasswordsOnThisMac({
  bridge,
  client,
  waiting,
}: {
  readonly bridge: PasswordsBridge;
  readonly client: Pick<HostClient, "dispatch">;
  readonly waiting: readonly { readonly request: Request }[];
}) {
  const { read, readError, status } = useDesktopPasswordsStatus(bridge);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  // One key per Request, so a decline whose reply was lost is retried, not repeated.
  const declineKeys = useRef(new Map<string, string>());
  const signIns = useMemo(
    () =>
      waiting
        .map(({ request }) => request)
        .filter(
          (request) =>
            request.status === "pending" && request.payload.kind === "browser.password-sign-in",
        ),
    [waiting],
  );
  const waitingSignIns = signIns;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  function run(kind: Exclude<Busy, null>, action: () => Promise<void>) {
    if (busy !== null) return;
    setBusy(kind);
    setError(null);
    action()
      .catch((reason: unknown) => {
        if (live.current) setError(actionErrorMessage(reason));
      })
      .finally(() => {
        if (live.current) setBusy(null);
      });
  }
  const openPasswords = () => run("open", () => bridge.passwordsOpen());
  const declineAll = () =>
    run("decline", async () => {
      await Promise.all(
        waitingSignIns.map(async (request) => {
          if (request.payload.kind !== "browser.password-sign-in") return;
          const key =
            declineKeys.current.get(request.id) ??
            mutationIdempotencyKey(`password-sign-in:${request.id}`);
          declineKeys.current.set(request.id, key);
          return client.dispatch({
            idempotencyKey: key,
            requestId: request.id,
            type: "browser.password-sign-in.respond",
            decision: { kind: "decline" },
          });
        }),
      );
    });

  if (status === null) {
    return readError ? (
      <Unreachable message={readError} onRetry={() => void read()} />
    ) : (
      <div className="card">
        <LoadingRows label="Loading Passwords" rows={2} />
      </div>
    );
  }

  const state = passwordsSettingsState(status);
  return (
    <>
      {"development" in state && state.development ? (
        <p className="notice notice--warn" role="note">
          <Icon name="code" />
          <span>{passwordsDevelopmentBanner}</span>
        </p>
      ) : null}
      <StateBody
        busy={busy}
        onDeclineAll={declineAll}
        onOpen={openPasswords}
        onRetry={() => void read()}
        state={state}
        waiting={waitingSignIns.length}
      />
      <SettingsError message={error} />
    </>
  );
}

function StateBody({
  busy,
  onDeclineAll,
  onOpen,
  onRetry,
  state,
  waiting,
}: {
  readonly busy: Busy;
  readonly onDeclineAll: () => void;
  readonly onOpen: () => void;
  readonly onRetry: () => void;
  readonly state: PasswordsSettingsState;
  /** Sign-in Requests waiting for the person. */
  readonly waiting: number;
}) {
  switch (state.kind) {
    case "unsupported":
      return (
        <div className="card">
          <p className="card__empty">{state.message}</p>
        </div>
      );
    case "unavailable":
      return <Unreachable message={state.message} onRetry={onRetry} />;
    case "not-set-up":
      return (
        <div className="card">
          <div className="card__form">
            <p className="sign-in-card__lead">{passwordsSetUpLead}</p>
            <Facts facts={passwordsSetUpFacts} icons={["key", "shield", "desktop", "browser"]} />
            <div>
              <button
                className="btn btn--primary"
                disabled={busy !== null}
                onClick={onOpen}
                type="button"
              >
                {passwordsSetUpAction}
              </button>
            </div>
          </div>
        </div>
      );
    case "needs-reset":
      return (
        <div className="card">
          <div className="card__form">
            <p className="sign-in-card__lead">{passwordsNeedsReset}</p>
            <div>
              <button className="btn" disabled={busy !== null} onClick={onOpen} type="button">
                {passwordsOpenAction}
              </button>
            </div>
          </div>
        </div>
      );
    case "ready":
      return (
        <>
          <div className="card">
            <SettingsRow
              action={
                <span className={state.agentSignIns === "on" ? "chip chip--ok" : "chip"}>
                  {state.agentSignIns === "on" ? "On" : "Off"}
                </span>
              }
              detail={passwordsAgentSignInsDetail}
              icon="key"
              title={passwordsAgentSignInsLabel}
            />
            {state.personFill !== null ? (
              <SettingsRow
                action={
                  <span className={state.personFill === "on" ? "chip chip--ok" : "chip"}>
                    {state.personFill === "on" ? "On" : "Off"}
                  </span>
                }
                detail={passwordsAgentSignInsDetail}
                icon="user"
                title={passwordsPersonFillLabel}
              />
            ) : null}
            {state.personSave !== null ? (
              <SettingsRow
                action={
                  <span className={state.personSave === "on" ? "chip chip--ok" : "chip"}>
                    {state.personSave === "on" ? "On" : "Off"}
                  </span>
                }
                detail={passwordsAgentSignInsDetail}
                icon="key"
                title={passwordsPersonSaveLabel}
              />
            ) : null}
            {waiting > 0 ? (
              <SettingsRow
                action={
                  <button
                    className="btn btn--small"
                    disabled={busy !== null}
                    onClick={onDeclineAll}
                    type="button"
                  >
                    {busy === "decline" ? passwordsDecliningAllAction : passwordsDeclineAllAction}
                  </button>
                }
                detail={passwordsWaitingDetail(waiting)}
                icon="clock"
                title={passwordsWaitingLabel}
              />
            ) : null}
            <SettingsRow
              action={
                <button
                  className="btn btn--small"
                  disabled={busy !== null}
                  onClick={onOpen}
                  type="button"
                >
                  {passwordsOpenAction}
                </button>
              }
              detail={passwordsSavedDetail}
              icon="shield"
              title={passwordsSavedLabel}
            />
          </div>
          <section aria-labelledby="passwords-how-title" className="settings-group">
            <h2 className="settings-group__title" id="passwords-how-title">
              {passwordsHowItWorksLabel}
            </h2>
            <Facts facts={passwordsHowItWorks} icons={["key", "shield", "browser", "globe"]} />
          </section>
        </>
      );
  }
}

function Facts({
  facts,
  icons,
}: {
  readonly facts: readonly string[];
  readonly icons: readonly IconName[];
}) {
  return (
    <ul className="sign-in-card__facts">
      {facts.map((fact, index) => (
        <li key={fact}>
          <Icon name={icons[index] ?? "check"} />
          {fact}
        </li>
      ))}
    </ul>
  );
}

function Unreachable({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="notice notice--warn" role="status">
      <Icon name="alert-circle" />
      <div>{message}</div>
      <button className="btn btn--small" onClick={onRetry} type="button">
        Try again
      </button>
    </div>
  );
}
