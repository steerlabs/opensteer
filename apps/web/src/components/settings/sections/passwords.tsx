import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  passwordsSavedDetail,
  passwordsSavedLabel,
  passwordsSettingsDescription,
  passwordsSettingsState,
  passwordsSetUpAction,
  passwordsDeclineAllAction,
  passwordsDecliningAllAction,
  passwordsSetUpFacts,
  passwordsSetUpLead,
  passwordsSetUpNote,
  passwordsWaitingDetail,
  passwordsWaitingLabel,
  type HostClient,
  type PasswordsSettingsState,
} from "@opensteer/client/host";
import type { Request } from "@opensteer/core";
import type { DesktopPasswordsStatus, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { Icon, type IconName } from "../../icon.js";
import { LoadingRows } from "../../loading-rows.js";
import { SectionHeader, SettingsError, SettingsRow, type SettingsView } from "../primitives.js";
import { useHomeComputer } from "./devices.js";

type PasswordsBridge = Pick<
  OpensteerDesktopBridge,
  | "onPasswordsStatusChanged"
  | "passwordsOpen"
  | "passwordsStatus"
  | "passwordsSignInGet"
  | "onPasswordsSignInChanged"
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
  const personal = snapshot.deploymentShape?.kind === "personal";
  const onThisMac = desktopBridge !== null && personal && view.facts.onThisComputer;
  return (
    <>
      <SectionHeader lead={`${passwordsSettingsDescription}.`} title="Passwords" />
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
  const [status, setStatus] = useState<DesktopPasswordsStatus | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  // A change pushed by the Passwords window is newer than any read still in flight.
  const pushed = useRef(false);
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
  const [needsPerson, setNeedsPerson] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let active = true;
    const changed = new Set<string>();
    const update = (operationId: string, waiting: boolean) => {
      if (!active) return;
      setNeedsPerson((prior) => {
        const next = new Set(prior);
        if (waiting) next.add(operationId);
        else next.delete(operationId);
        return next;
      });
    };
    const subscriptions: (() => void)[] = [];
    for (const request of signIns) {
      if (request.payload.kind !== "browser.password-sign-in") continue;
      const { operationId } = request.payload;
      subscriptions.push(
        bridge.onPasswordsSignInChanged({ operationId }, (state) => {
          changed.add(operationId);
          update(operationId, state.stage === "approval");
        }),
      );
      void bridge
        .passwordsSignInGet({ operationId })
        .then((state) => {
          if (!changed.has(operationId)) update(operationId, state.stage === "approval");
        })
        .catch(() => update(operationId, false));
    }
    return () => {
      active = false;
      for (const stop of subscriptions) stop();
    };
  }, [bridge, signIns]);
  const waitingSignIns = signIns.filter(
    (request) =>
      request.payload.kind === "browser.password-sign-in" &&
      needsPerson.has(request.payload.operationId),
  );

  const read = useCallback(async () => {
    pushed.current = false;
    try {
      const next = await bridge.passwordsStatus();
      if (!live.current || pushed.current) return;
      setStatus(next);
      setReadError(null);
    } catch (reason) {
      if (live.current) setReadError(actionErrorMessage(reason));
    }
  }, [bridge]);

  useEffect(() => {
    live.current = true;
    const stop = bridge.onPasswordsStatusChanged((next) => {
      pushed.current = true;
      setStatus(next);
      setReadError(null);
    });
    void read();
    return () => {
      live.current = false;
      stop();
    };
  }, [bridge, read]);

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
          const state = await bridge.passwordsSignInGet({
            operationId: request.payload.operationId,
          });
          if (state.stage !== "approval") return;
          const key =
            declineKeys.current.get(request.id) ??
            mutationIdempotencyKey(`password-sign-in:${request.id}`);
          declineKeys.current.set(request.id, key);
          return client.dispatch({
            idempotencyKey: key,
            requestId: request.id,
            type: "browser.password-sign-in.decline",
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
            <Facts facts={passwordsSetUpFacts} icons={["download", "browser", "shield"]} />
            <p className="notice" role="note">
              <Icon name="desktop" />
              <span>{passwordsSetUpNote}</span>
            </p>
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
