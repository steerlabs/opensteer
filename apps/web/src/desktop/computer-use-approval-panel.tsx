import {
  computerUseApprovalTitle,
  computerUseElevatedNote,
  computerUsePolicyConfirmation,
} from "@opensteer/client/integrations";
import type {
  DesktopComputerUseApprovalPresentation,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/icon.js";

export type ComputerUseApprovalPanelBridge = Pick<
  OpensteerDesktopBridge,
  "computerUseApprovalGet" | "computerUseApprovalRespond"
>;

type AppPresentation = Extract<DesktopComputerUseApprovalPresentation, { kind: "app" }>;
type PolicyPresentation = Extract<DesktopComputerUseApprovalPresentation, { kind: "policy" }>;
type ServerPresentation = Extract<DesktopComputerUseApprovalPresentation, { kind: "server" }>;

/**
 * The one question computer use asks a person, in one of two forms: may
 * agents use this app on this Mac, or may they use any app here without
 * asking each time.
 *
 * An app is shown as the helper resolved it — its real icon and name, and its
 * path when a name could mean two things — so what is approved is what will
 * be driven, never what a request called it. When a task asked, the panel
 * names the task, its Workspace and the reason it gave. The elevated note is
 * the helper's judgement of the app, not the Deployment's. Escape declines,
 * and nothing is remembered beyond this answer: the Host records the
 * approval; the panel only carries it.
 *
 * The window never takes the keyboard on its own, and the key that lands first
 * once the person clicks into it is always the one that says no: a question
 * that appears while somebody is typing elsewhere must not be answered by
 * their next Return or Space.
 */
export function ComputerUseApprovalPanel({
  bridge,
  token,
}: {
  readonly bridge: ComputerUseApprovalPanelBridge;
  readonly token: string;
}) {
  const [presentation, setPresentation] = useState<DesktopComputerUseApprovalPresentation | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [answering, setAnswering] = useState<boolean | null>(null);
  const focusRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.documentElement.dataset.panel = "computer-use";
    return () => {
      delete document.documentElement.dataset.panel;
    };
  }, []);

  useEffect(() => {
    let active = true;
    bridge
      .computerUseApprovalGet({ token })
      .then((value) => {
        if (active) setPresentation(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "This request is gone.");
      });
    return () => {
      active = false;
    };
  }, [bridge, token]);

  useEffect(() => {
    if (presentation) focusRef.current?.focus({ preventScroll: true });
  }, [presentation]);

  function respond(allow: boolean) {
    if (answering !== null) return;
    setAnswering(allow);
    void bridge.computerUseApprovalRespond({ allow, token }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "The answer was not recorded.");
      setAnswering(null);
    });
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") respond(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // respond reads state through refs of this render; re-binding per render is fine.
  });

  if (error) {
    // The window has no frame, so the way out is a button. Closing it is a
    // refusal in desktop main, as for any approval window closed unanswered.
    return (
      <div className="cu-panel cu-panel--approval" role="alertdialog" aria-labelledby="cu-error">
        <p className="cu-panel__headline" id="cu-error">
          <Icon name="alert-circle" />
          {error}
        </p>
        <div className="cu-panel__actions">
          <button className="btn cu-panel__dismiss" onClick={() => window.close()} type="button">
            Close
          </button>
        </div>
      </div>
    );
  }
  if (!presentation) {
    return <div className="cu-panel cu-panel--approval" aria-busy="true" />;
  }

  switch (presentation.kind) {
    case "policy":
      return (
        <PolicyApproval
          answering={answering}
          focusRef={focusRef}
          onRespond={respond}
          presentation={presentation}
        />
      );
    case "server":
      return (
        <ServerApproval
          answering={answering}
          focusRef={focusRef}
          onRespond={respond}
          presentation={presentation}
        />
      );
    case "app":
      return (
        <AppApproval
          answering={answering}
          focusRef={focusRef}
          onRespond={respond}
          presentation={presentation}
        />
      );
  }
}

interface ApprovalProps<Presentation> {
  readonly answering: boolean | null;
  readonly focusRef: React.RefObject<HTMLButtonElement | null>;
  readonly onRespond: (allow: boolean) => void;
  readonly presentation: Presentation;
}

function AppApproval({
  answering,
  focusRef,
  onRespond,
  presentation,
}: ApprovalProps<AppPresentation>) {
  const { app, reason, threadTitle, workspaceName } = presentation;
  const initial = app.displayName.trim().charAt(0).toUpperCase();
  return (
    <div className="cu-panel cu-panel--approval" role="dialog" aria-labelledby="cu-approve-title">
      <div
        className="cu-approve__content"
        role="region"
        aria-label="App approval details"
        tabIndex={0}
      >
        <div className="cu-approve__app">
          {app.iconPng ? (
            <img
              alt=""
              className="cu-approve__icon"
              decoding="async"
              draggable={false}
              src={`data:image/png;base64,${app.iconPng}`}
            />
          ) : (
            <span aria-hidden className="cu-approve__icon cu-approve__icon--monogram">
              {initial}
            </span>
          )}
          <div className="cu-panel__titles">
            <h1 className="cu-panel__headline" id="cu-approve-title">
              {computerUseApprovalTitle({ appName: app.displayName, threadTitle })}
            </h1>
            <p className="cu-panel__sub">
              {workspaceName ? (
                <>
                  In <strong>{workspaceName}</strong>, through{" "}
                </>
              ) : (
                "Through "
              )}
              <strong>{presentation.deploymentName}</strong>.
              {app.path ? <span className="cu-approve__path"> {app.path}</span> : null}
            </p>
          </div>
        </div>

        {reason ? <p className="cu-approve__reason">Reason: {reason}</p> : null}

        <div className="cu-approve__access">
          <span className="cu-approve__access-label">{presentation.accessLabel}</span>
          <span className="cu-approve__access-why">{presentation.accessSummary}</span>
        </div>

        {app.risk === "elevated" ? (
          <p className="cu-approve__elevated">
            <Icon name="alert-circle" />
            <span>{computerUseElevatedNote}</span>
          </p>
        ) : null}
      </div>

      <div className="cu-panel__actions cu-approve__actions">
        <button
          className="btn cu-panel__dismiss"
          disabled={answering !== null}
          onClick={() => onRespond(false)}
          ref={focusRef}
          type="button"
        >
          Don't allow
        </button>
        <button
          className="btn btn--primary cu-panel__dismiss"
          disabled={answering !== null}
          onClick={() => onRespond(true)}
          type="button"
        >
          {answering === true ? "Allowing…" : "Allow"}
        </button>
      </div>
    </div>
  );
}

/**
 * Turning automatic approval on covers every app on this Mac, including ones
 * not installed yet, so the panel says the whole consequence and the key that
 * lands first is Cancel: Return here should never be the answer to a question
 * this broad.
 */
function PolicyApproval({
  answering,
  focusRef,
  onRespond,
  presentation,
}: ApprovalProps<PolicyPresentation>) {
  return (
    <div className="cu-panel cu-panel--approval" role="dialog" aria-labelledby="cu-approve-title">
      <div
        className="cu-approve__content"
        role="region"
        aria-label="Automatic app approval details"
        tabIndex={0}
      >
        <div className="cu-panel__head">
          <img
            alt=""
            className="cu-panel__icon"
            decoding="async"
            draggable={false}
            src="/opensteer.png"
          />
          <div className="cu-panel__titles">
            <h1 className="cu-panel__headline" id="cu-approve-title">
              {computerUsePolicyConfirmation.title}
            </h1>
            <p className="cu-panel__sub">
              Through <strong>{presentation.deploymentName}</strong>.
            </p>
          </div>
        </div>

        <p className="cu-approve__consequence">{computerUsePolicyConfirmation.body}</p>
      </div>

      <div className="cu-panel__actions cu-approve__actions">
        <button
          className="btn cu-panel__dismiss"
          disabled={answering !== null}
          onClick={() => onRespond(false)}
          ref={focusRef}
          type="button"
        >
          {computerUsePolicyConfirmation.cancel}
        </button>
        <button
          className="btn btn--primary cu-panel__dismiss"
          disabled={answering !== null}
          onClick={() => onRespond(true)}
          type="button"
        >
          {answering === true ? "Allowing…" : computerUsePolicyConfirmation.allow}
        </button>
      </div>
    </div>
  );
}

/**
 * An MCP server to run on this Mac, shown exactly as it will run: the
 * program, its arguments, the folder it starts in and the environment it is
 * given — or the address on this Mac it is reached at. It runs as the person,
 * with what their account can reach, so the consequence is said plainly and
 * the key that lands first says no.
 */
function ServerApproval({
  answering,
  focusRef,
  onRespond,
  presentation,
}: ApprovalProps<ServerPresentation>) {
  const { launch } = presentation;
  return (
    <div className="cu-panel cu-panel--approval" role="dialog" aria-labelledby="cu-approve-title">
      <div
        className="cu-approve__content"
        role="region"
        aria-label="MCP server approval details"
        tabIndex={0}
      >
        <div className="cu-panel__head">
          <img
            alt=""
            className="cu-panel__icon"
            decoding="async"
            draggable={false}
            src="/opensteer.png"
          />
          <div className="cu-panel__titles">
            <h1 className="cu-panel__headline" id="cu-approve-title">
              Run {presentation.serverName} from {presentation.installationTitle} on this Mac?
            </h1>
            <p className="cu-panel__sub">
              For agents in <strong>{presentation.deploymentName}</strong>.
            </p>
          </div>
        </div>

        {launch.type === "stdio" ? (
          <dl className="cu-approve__launch">
            <dt>Runs</dt>
            <dd>
              <code>{[launch.command, ...launch.args].join(" ")}</code>
            </dd>
            <dt>In</dt>
            <dd>
              <code>{launch.cwd}</code>
            </dd>
            {Object.keys(launch.env).length > 0 ? (
              <>
                <dt>With</dt>
                <dd>
                  {Object.entries(launch.env).map(([name, value]) => (
                    <code key={name}>
                      {name}={value}
                    </code>
                  ))}
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <dl className="cu-approve__launch">
            <dt>Connects to</dt>
            <dd>
              <code>{launch.url}</code>
            </dd>
          </dl>
        )}

        <p className="cu-approve__consequence">
          It runs as you, with what your account on this Mac can reach. Agents you allow can use its
          tools while this Mac is on.
        </p>
      </div>

      <div className="cu-panel__actions cu-approve__actions">
        <button
          className="btn cu-panel__dismiss"
          disabled={answering !== null}
          onClick={() => onRespond(false)}
          ref={focusRef}
          type="button"
        >
          Don't allow
        </button>
        <button
          className="btn btn--primary cu-panel__dismiss"
          disabled={answering !== null}
          onClick={() => onRespond(true)}
          type="button"
        >
          {answering === true ? "Allowing…" : "Allow"}
        </button>
      </div>
    </div>
  );
}
