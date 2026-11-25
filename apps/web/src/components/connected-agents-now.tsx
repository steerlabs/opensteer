import { hostsDeployment } from "@opensteer/client/computers";
import {
  connectedAgentNamePart,
  formatRelativeTime,
  isolatedPlainSentence,
  type ConnectedAgentNow,
  type HostClient,
  type HostSnapshot,
  type SentencePart,
  workWords,
} from "@opensteer/client/host";
import { useConnectedAgents, useHostSelector } from "@opensteer/client/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import { OutsideName, SentenceText } from "../ui/address-text.js";
import { sessionActionLabel, useOpenSessionTask, useStopSession } from "./agent-work.js";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";
import { AgentMark } from "./settings/agent-mark.js";
import { useConnectedAgentWork } from "./use-connected-agent-sessions.js";

const selectHomeName = (snapshot: HostSnapshot) =>
  snapshot.machines.find(hostsDeployment)?.name ?? null;

type SessionStop = ReturnType<typeof useStopSession>;
type StopState = Pick<SessionStop, "running" | "outcome">;
type StopStatus = { readonly running: boolean; readonly unconfirmed: boolean };
type ReportStop = (sessionId: string, state: StopState | null) => void;
type AgentsView = ReturnType<typeof useConnectedAgentWork>["view"];

const ConnectedAgentsContext = createContext<{
  readonly view: AgentsView;
  readonly refresh: () => void;
  readonly stops: ReadonlyMap<string, StopStatus>;
  readonly stop: (entries: readonly ConnectedAgentNow[]) => void;
} | null>(null);

/** One action per session, above the sidebar and header so moving the control keeps its outcome. */
export function ConnectedAgentsProvider({
  hostClient,
  readActivity,
  children,
}: {
  readonly hostClient: HostClient;
  readonly readActivity: boolean;
  readonly children: ReactNode;
}) {
  const { view, refresh } = useConnectedAgentWork(hostClient, undefined, readActivity);
  const [actions] = useState(() => new Map<string, SessionStop["run"]>());
  const [stops, setStops] = useState<ReadonlyMap<string, StopStatus>>(() => new Map());
  const report = useCallback<ReportStop>((id, state) => {
    setStops((previous) => {
      const before = previous.get(id);
      const running = state?.running ?? false;
      const outcome = state?.outcome;
      const unconfirmed =
        outcome === undefined
          ? false
          : outcome === null
            ? (before?.unconfirmed ?? false)
            : outcome.kind !== "confirmed" ||
              outcome.value.type !== "agent.session.stop" ||
              !outcome.value.ended;
      if (running === (before?.running ?? false) && unconfirmed === (before?.unconfirmed ?? false))
        return previous;
      const next = new Map(previous);
      if (running || unconfirmed) next.set(id, { running, unconfirmed });
      else next.delete(id);
      return next;
    });
  }, []);
  const stop = useCallback(
    (entries: readonly ConnectedAgentNow[]) => {
      for (const { sessionId } of entries) void actions.get(sessionId)?.(undefined);
    },
    [actions],
  );
  const value = useMemo(() => ({ view, refresh, stops, stop }), [view, refresh, stops, stop]);
  return (
    <ConnectedAgentsContext value={value}>
      {view.agents.map((entry) => (
        <SessionStopOwner actions={actions} entry={entry} key={entry.sessionId} report={report} />
      ))}
      {children}
    </ConnectedAgentsContext>
  );
}

function SessionStopOwner({
  actions,
  entry: { threadId, sessionId },
  report,
}: {
  readonly actions: Map<string, SessionStop["run"]>;
  readonly entry: ConnectedAgentNow;
  readonly report: ReportStop;
}) {
  const { run, running, outcome } = useStopSession(threadId, sessionId);
  useEffect(() => {
    actions.set(sessionId, run);
    return () => {
      actions.delete(sessionId);
      report(sessionId, null);
    };
  }, [actions, sessionId, run, report]);
  useEffect(() => report(sessionId, { running, outcome }), [sessionId, running, outcome, report]);
  return null;
}

export function ConnectedAgentsNow({
  compact = false,
  hostClient,
  onNavigate,
}: {
  readonly compact?: boolean;
  readonly hostClient: HostClient;
  readonly onNavigate?: () => void;
}) {
  const work = useContext(ConnectedAgentsContext);
  if (!work?.view.headline) return null;
  return (
    <ActiveAgents
      agents={work.view.agents}
      compact={compact}
      headlineParts={work.view.headlineParts}
      hostClient={hostClient}
      onNavigate={onNavigate}
      onOpen={work.refresh}
      stop={work.stop}
      stops={work.stops}
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
  stop,
  stops,
}: {
  readonly agents: readonly ConnectedAgentNow[];
  readonly compact: boolean;
  readonly headlineParts: AgentsView["headlineParts"];
  readonly hostClient: HostClient;
  readonly onNavigate: (() => void) | undefined;
  readonly onOpen: () => void;
  readonly stop: (entries: readonly ConnectedAgentNow[]) => void;
  readonly stops: ReadonlyMap<string, StopStatus>;
}) {
  const openSessionTask = useOpenSessionTask();
  const panelId = useId();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const homeName = useHostSelector(hostClient, selectHomeName);
  const devices = new Set(
    agents.flatMap(({ places }) => places.flatMap(({ device }) => (device ? [device.name] : []))),
  );
  const deviceName = devices.size > 1 ? null : ([...devices][0] ?? homeName);
  const duplicates = duplicateRows(agents, deviceName);
  const catalog = useConnectedAgents(anchor && duplicates.size ? hostClient : null);
  const created = new Map(catalog.connections?.map(({ id, createdAt }) => [id, createdAt]));
  const now = new Date();
  const stopping = agents.some(({ sessionId }) => stops.get(sessionId)?.running);
  const remaining = agents.filter(({ sessionId }) => stops.get(sessionId)?.unconfirmed);
  const warning = remaining.length ? stopWarning(remaining) : null;
  const close = () => setAnchor(null);
  const leave = () => {
    close();
    onNavigate?.();
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
          {oneWorking ? <span className="status-dot status-dot--running" /> : null}
        </span>
        {compact ? (
          <span aria-hidden>{connections.size}</span>
        ) : (
          <>
            <span aria-hidden className="agents-now__headline">
              {connections.size === 1 ? (
                <>
                  <span className="agents-now__headline-line agents-now__headline-name">
                    <SentenceText parts={headlineParts.slice(0, 1)} quoteNames />
                  </span>
                  <span className="agents-now__headline-line agents-now__headline-detail">
                    <SentenceText parts={headlineParts.slice(1)} />
                  </span>
                </>
              ) : (
                <SentenceText parts={headlineParts} />
              )}
            </span>
            {oneWorking ? null : <Icon name="chevron-down" />}
          </>
        )}
      </button>
      {oneWorking ? (
        <button
          aria-label={sessionActionLabel("work.stop", first.agent)}
          className="btn btn--small agents-now__quick-stop"
          disabled={stopping}
          onClick={() => stop([first])}
          type="button"
        >
          {workWords("tab.stop")}
        </button>
      ) : null}
      {!anchor && warning ? (
        <span className="agents-now__inline-error" role="status">
          <SentenceText parts={warning} />
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
              const group = duplicates.get(entry.sessionId);
              const joined = group ? created.get(entry.connectionId) : undefined;
              const age = joined ? formatRelativeTime(joined, now) : "";
              const sameAge =
                group &&
                [...group].some((id) => {
                  const other = created.get(id);
                  return (
                    id !== entry.connectionId && other && formatRelativeTime(other, now) === age
                  );
                });
              const connected = age
                ? `Connected ${age === "now" ? "just now" : /^\d/u.test(age) ? `${age} ago` : age}${sameAge && joined ? ` · ${clock.format(new Date(joined))}` : ""}`
                : null;
              const actionLabel = (key: "work.stop" | "work.watch" | "work.review") =>
                [sessionActionLabel(key, agent), connected].filter(Boolean).join(" — ");
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
                        <SentenceText parts={[connectedAgentNamePart(agent)]} quoteNames />
                      </strong>
                      {entry.places.map(({ device, name }, index) => (
                        <span key={index}>
                          <OutsideName value={name} />
                          {device && device.name !== deviceName && device.name !== name ? (
                            <>
                              {" "}
                              · <OutsideName value={device.name} />
                            </>
                          ) : null}
                        </span>
                      ))}
                    </div>
                    {entry.action ? <div dir="auto">{entry.action}</div> : null}
                    {connected ? <div>{connected}</div> : null}
                  </div>
                  <div className="agents-now-panel__actions">
                    <button
                      aria-label={actionLabel(
                        entry.state === "needs-you" ? "work.review" : "work.watch",
                      )}
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
                      aria-label={actionLabel("work.stop")}
                      className="btn btn--small"
                      disabled={stopping}
                      onClick={() => stop([entry])}
                      type="button"
                    >
                      {workWords("tab.stop")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {warning ? (
            <p className="agents-now-panel__error" role="status">
              <SentenceText parts={warning} />
            </p>
          ) : null}
          <div className="agents-now-panel__footer">
            <button
              className="btn btn--small agents-now-panel__stop-all"
              disabled={stopping}
              onClick={() => stop(agents)}
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

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

function duplicateRows(agents: readonly ConnectedAgentNow[], deviceName: string | null) {
  const groups = new Map<string, ConnectedAgentNow[]>();
  for (const agent of agents) {
    const key = JSON.stringify([
      connectedAgentNamePart(agent.agent),
      agent.state,
      agent.action,
      agent.places.map(({ name, device }) => [
        name,
        device?.name !== deviceName && device?.name !== name ? device?.name : null,
      ]),
    ]);
    const group = groups.get(key);
    if (group) group.push(agent);
    else groups.set(key, [agent]);
  }
  const duplicates = new Map<string, ReadonlySet<string>>();
  for (const group of groups.values()) {
    const connections = new Set(group.map(({ connectionId }) => connectionId));
    if (connections.size > 1)
      for (const { sessionId } of group) duplicates.set(sessionId, connections);
  }
  return duplicates;
}

function stopWarning(remaining: readonly ConnectedAgentNow[]): readonly SentencePart[] {
  const agents = new Map(remaining.map(({ connectionId, agent }) => [connectionId, agent]));
  return [
    "Couldn’t confirm Stop for ",
    ...[...agents.values()].flatMap((agent, index) => [
      ...(index ? [", "] : []),
      connectedAgentNamePart(agent),
    ]),
    ".",
  ];
}
