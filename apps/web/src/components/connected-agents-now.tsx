import { hostsDeployment } from "@opensteer/client/computers";
import {
  connectedAgentsNow,
  isolatedPlainSentence,
  type ConnectedAgentNow,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { useId, useState } from "react";
import { Link } from "react-router";
import { OutsideName, SentenceText } from "../ui/address-text.js";
import { stopSessionAction, useOpenSessionTask } from "./agent-work.js";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";
import { AgentMark } from "./settings/agent-mark.js";
import { runAction } from "./use-action.js";
import { useConnectedAgentWork } from "./use-connected-agent-sessions.js";

const selectHomeName = (snapshot: HostSnapshot) =>
  snapshot.machines.find(hostsDeployment)?.name ?? null;

export function ConnectedAgentsNow({
  compact = false,
  hostClient,
  onNavigate,
}: {
  readonly compact?: boolean;
  readonly hostClient: HostClient;
  readonly onNavigate?: () => void;
}) {
  const { view, refresh } = useConnectedAgentWork(hostClient);
  if (!view.headline) return null;
  return (
    <ActiveAgents
      agents={view.agents}
      compact={compact}
      headlineParts={view.headlineParts}
      hostClient={hostClient}
      onNavigate={onNavigate}
      onOpen={refresh}
    />
  );
}

function ActiveAgents({
  agents,
  compact,
  headlineParts,
  hostClient,
  onNavigate,
  onOpen,
}: {
  readonly agents: readonly ConnectedAgentNow[];
  readonly compact: boolean;
  readonly headlineParts: ReturnType<typeof connectedAgentsNow>["headlineParts"];
  readonly hostClient: HostClient;
  readonly onNavigate: (() => void) | undefined;
  readonly onOpen: () => void;
}) {
  const openSessionTask = useOpenSessionTask();
  const panelId = useId();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [stopping, setStopping] = useState(false);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const homeName = useHostSelector(hostClient, selectHomeName);
  const devices = new Set(
    agents.flatMap(({ places }) => places.flatMap(({ device }) => (device ? [device.name] : []))),
  );
  const deviceName = devices.size > 1 ? null : ([...devices][0] ?? homeName);
  const remaining = agents.filter(({ sessionId }) => failed.has(sessionId));
  const close = () => setAnchor(null);
  const leave = () => {
    close();
    onNavigate?.();
  };
  const stop = async (entries: readonly ConnectedAgentNow[]) => {
    if (stopping) return;
    setStopping(true);
    const results = await Promise.all(
      entries.map(({ threadId, sessionId }) =>
        runAction(hostClient, stopSessionAction(hostClient, threadId, sessionId)),
      ),
    );
    setFailed(
      new Set(
        entries
          .filter((_, index) => {
            const result = results[index]!;
            return (
              result.kind !== "confirmed" ||
              (result.value.type === "agent.session.stop" && !result.value.ended)
            );
          })
          .map(({ sessionId }) => sessionId),
      ),
    );
    setStopping(false);
  };
  const first = agents[0]!;
  const oneWorking = !compact && agents.length === 1 && first.state === "working";
  const connections = new Map(agents.map(({ connectionId, agent }) => [connectionId, agent]));
  const marks =
    !compact && first.state === "needs-you"
      ? new Map(
          agents
            .filter(({ state }) => state === "needs-you")
            .map(({ connectionId, agent }) => [connectionId, agent]),
        )
      : connections;
  const headline = isolatedPlainSentence(headlineParts);
  return (
    <div className={compact ? "agents-now agents-now--compact" : "agents-now side-task is-open"}>
      <button
        aria-controls={anchor ? panelId : undefined}
        aria-expanded={anchor !== null}
        aria-haspopup="dialog"
        aria-label={headline}
        className="side-task__main agents-now__trigger"
        data-needs-you={first.state === "needs-you" || undefined}
        data-single-agent={connections.size === 1 || undefined}
        onClick={(event) => {
          if (anchor) close();
          else {
            setAnchor(event.currentTarget);
            // A new action can arrive while the directory still says "working."
            onOpen();
          }
        }}
        title={headline}
        type="button"
      >
        <span aria-hidden className="agents-now__marks">
          {[...marks].slice(0, 3).map(([connectionId, agent]) => (
            <AgentMark identity={agent} key={connectionId} />
          ))}
          {marks.size > 3 ? <span>+{marks.size - 3}</span> : null}
        </span>
        {compact ? (
          <span aria-hidden>{connections.size}</span>
        ) : (
          <>
            {oneWorking ? <span aria-hidden className="status-dot status-dot--running" /> : null}
            <span aria-hidden className="agents-now__headline">
              <SentenceText parts={headlineParts} />
            </span>
            {oneWorking ? null : <Icon name="chevron-down" />}
          </>
        )}
      </button>
      {oneWorking ? (
        <button
          aria-label={`Stop ${first.agent.name}`}
          className="btn btn--small agents-now__quick-stop"
          aria-disabled={stopping || undefined}
          onClick={() => void stop([first])}
          type="button"
        >
          Stop
        </button>
      ) : null}
      {!anchor && remaining.length ? (
        <span className="agents-now__inline-error" role="status">
          Couldn’t confirm Stop for {remaining.map(({ agent }) => agent.name).join(", ")}.
        </span>
      ) : null}
      {anchor ? (
        <Popover
          anchor={anchor}
          below
          className="agents-now-panel"
          id={panelId}
          label="On your computer now"
          onClose={close}
          role="dialog"
        >
          <div className="agents-now-panel__header">
            <h2>On your computer now</h2>
            {deviceName ? <OutsideName value={deviceName} /> : null}
          </div>
          <ul className="agents-now-panel__list">
            {agents.map((entry) => {
              const { agent, waiting } = entry;
              const action = entry.state === "needs-you" ? "Review" : "Watch";
              return (
                <li
                  className="agents-now-panel__row"
                  data-needs-you={entry.state === "needs-you" || undefined}
                  key={entry.sessionId}
                >
                  <AgentMark identity={agent} />
                  <div className="agents-now-panel__detail">
                    <div className="agents-now-panel__where">
                      <strong>
                        <OutsideName value={agent.name} />
                      </strong>
                      {entry.places.map(({ device, name }, index) => (
                        <span key={index}>
                          <OutsideName value={name} />
                          {device && device.name !== deviceName ? (
                            <>
                              {" "}
                              · <OutsideName value={device.name} />
                            </>
                          ) : null}
                        </span>
                      ))}
                    </div>
                    {entry.action ? <div dir="auto">{entry.action}</div> : null}
                  </div>
                  <div className="agents-now-panel__actions">
                    <button
                      aria-label={`${action} ${agent.name}`}
                      className={`btn btn--small${waiting ? " btn--primary" : ""}`}
                      onClick={() => {
                        leave();
                        openSessionTask(entry.threadId, waiting);
                      }}
                      type="button"
                    >
                      {action}
                    </button>
                    <button
                      aria-label={`Stop ${agent.name}`}
                      className="btn btn--small"
                      aria-disabled={stopping || undefined}
                      onClick={() => void stop([entry])}
                      type="button"
                    >
                      Stop
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {remaining.length ? (
            <p className="agents-now-panel__error" role="status">
              Couldn’t confirm Stop for {remaining.map(({ agent }) => agent.name).join(", ")}.
            </p>
          ) : null}
          <div className="agents-now-panel__footer">
            <button
              className="btn btn--small agents-now-panel__stop-all"
              aria-disabled={stopping || undefined}
              onClick={() => void stop(agents)}
              type="button"
            >
              Stop all
            </button>
            <Link onClick={leave} to="/settings/external-agents">
              All connected agents <Icon name="chevron-right" />
            </Link>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
