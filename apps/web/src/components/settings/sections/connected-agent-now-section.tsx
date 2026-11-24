import {
  agentWords,
  deriveSurface,
  sessionSlotFromHome,
  sessionTaskView,
  type ConnectedAgentNow,
  type HostClient,
  type HostSnapshot,
  type ThreadSummary,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { AgentOperationView } from "@opensteer/core";
import { OutsideName } from "../../../ui/address-text.js";
import { ActionLine } from "../../action-line.js";
import { SessionActivity, useOpenSessionTask, useStopSession } from "../../agent-work.js";
import { Icon } from "../../icon.js";
import { RequestStack } from "../../input-surface.js";
import { useReadFailed } from "../../read-gate.js";
import type { useConnectedAgentWork } from "../../use-connected-agent-sessions.js";
import { SettingsGroup } from "../primitives.js";

export function ConnectedAgentNowSection({
  client,
  work,
}: {
  readonly client: HostClient;
  readonly work: Pick<ReturnType<typeof useConnectedAgentWork>, "activity" | "tasks" | "view">;
}) {
  const { activity, tasks, view } = work;
  if (!view.agents.length) return null;
  return (
    <SettingsGroup heading="Now" headingId="connected-agent-now">
      {view.agents.map((entry) => {
        const thread = tasks.find(({ id }) => id === entry.threadId);
        return thread ? (
          <ActiveSession
            client={client}
            entry={entry}
            key={entry.sessionId}
            operations={activity?.get(entry.threadId)}
            thread={thread}
          />
        ) : null;
      })}
    </SettingsGroup>
  );
}

const selectUser = (snapshot: HostSnapshot) => snapshot.user;

function ActiveSession({
  client,
  entry,
  operations,
  thread,
}: {
  readonly client: HostClient;
  readonly entry: ConnectedAgentNow;
  readonly operations: readonly AgentOperationView[] | undefined;
  readonly thread: ThreadSummary;
}) {
  const user = useHostSelector(client, selectUser);
  const disabled = useReadFailed();
  const stop = useStopSession(entry.threadId, entry.sessionId);
  const open = useOpenSessionTask();
  const view = sessionTaskView({
    thread,
    slot: sessionSlotFromHome(
      thread.externalWork,
      operations?.filter(({ sessionId }) => sessionId === entry.sessionId),
    ),
  });
  const surface = entry.waiting ? deriveSurface([entry.waiting.request], user) : null;
  return (
    <div className="connected-agent__session">
      <div className="connected-agent__session-head">
        <div className="connected-agent__session-place">
          {entry.places.map(({ name, device }, index) => (
            <div key={index}>
              <OutsideName value={name} />
              {device ? (
                <>
                  {" "}
                  · <OutsideName value={device.name} />
                </>
              ) : null}
            </div>
          ))}
        </div>
        <div className="connected-agent__session-actions">
          <button
            aria-label={`Watch ${entry.agent.name}`}
            className="btn btn--small"
            onClick={() => open(entry.threadId)}
            type="button"
          >
            <Icon name="eye" />
            {agentWords("agent.watch")}
          </button>
          <button
            aria-label={`Stop ${entry.agent.name}`}
            className="btn btn--small"
            disabled={disabled || stop.running}
            onClick={() => void stop.run(undefined)}
            type="button"
          >
            Stop
          </button>
        </div>
      </div>
      {stop.line ? <ActionLine line={stop.line} wrap /> : null}
      {entry.state === "needs-you" ? (
        <span className="chip chip--warn">{agentWords("agent.status.needsYou")}</span>
      ) : null}
      {surface ? (
        <RequestStack
          disabled={disabled}
          items={[{ source: null, surface }]}
          onOpen={() => {}}
          openId={surface.request.id}
          threadId={entry.threadId}
        />
      ) : null}
      {view ? <SessionActivity showIdentity={false} showMode view={view} /> : null}
    </div>
  );
}
