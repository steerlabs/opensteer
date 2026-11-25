import {
  agentWords,
  deriveSurface,
  connectedAgentNowSection,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { SentenceText } from "../../../ui/address-text.js";
import { ActionLine } from "../../action-line.js";
import {
  SessionActivity,
  sessionActionLabel,
  useOpenSessionTask,
  useStopSession,
} from "../../agent-work.js";
import { Icon } from "../../icon.js";
import { RequestStack } from "../../input-surface.js";
import { useReadFailed } from "../../read-gate.js";
import type { useConnectedAgentWork } from "@opensteer/client/react";
import { SettingsGroup } from "../primitives.js";

export function ConnectedAgentNowSection({
  client,
  work,
}: {
  readonly client: HostClient;
  readonly work: Pick<ReturnType<typeof useConnectedAgentWork>, "activity" | "tasks" | "view">;
}) {
  const sessions = connectedAgentNowSection(work);
  if (!sessions.length) return null;
  return (
    <SettingsGroup heading="Now" headingId="connected-agent-now">
      {sessions.map((session) => (
        <ActiveSession client={client} key={session.entry.sessionId} session={session} />
      ))}
    </SettingsGroup>
  );
}

const selectUser = (snapshot: HostSnapshot) => snapshot.user;

function ActiveSession({
  client,
  session,
}: {
  readonly client: HostClient;
  readonly session: ReturnType<typeof connectedAgentNowSection>[number];
}) {
  const { entry, row, titleParts, view } = session;
  const user = useHostSelector(client, selectUser);
  const disabled = useReadFailed();
  const stop = useStopSession(entry.threadId, entry.sessionId);
  const open = useOpenSessionTask();
  const surface = row.request ? deriveSurface([row.request], user) : null;
  return (
    <div className="connected-agent__session">
      <div className="connected-agent__session-head">
        <div className="connected-agent__session-summary">
          <h3 className="connected-agent__session-title">
            <SentenceText parts={titleParts} quoteNames={false} />
          </h3>
          <div className="connected-agent__session-place">
            {row.placeLines.map((parts, index) => (
              <div key={index}>
                <SentenceText parts={parts} quoteNames={false} />
              </div>
            ))}
          </div>
        </div>
        <div className="connected-agent__session-actions">
          {row.needsYou ? (
            <span className="chip chip--warn">{row.status}</span>
          ) : (
            <button
              aria-label={sessionActionLabel("work.watch", entry.agent)}
              className="btn btn--small"
              onClick={() => open(entry.threadId)}
              type="button"
            >
              <Icon name="eye" />
              {agentWords("agent.watch")}
            </button>
          )}
          <button
            aria-label={sessionActionLabel("work.stop", entry.agent)}
            className="btn btn--small"
            disabled={disabled || stop.running}
            onClick={() => void stop.run()}
            type="button"
          >
            Stop
          </button>
        </div>
      </div>
      {stop.line ? <ActionLine line={stop.line} wrap /> : null}
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
