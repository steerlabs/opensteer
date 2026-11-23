import { useState } from "react";
import { Link } from "react-router";
import { agentWords, type ChatFacts, type ChatScreenHost } from "@opensteer/client/host";
import { SentenceText } from "../../../ui/address-text.js";
import { presentFailure } from "../../use-action.js";
import { SettingsError, SettingsGroup, SettingsRow } from "../primitives.js";

/**
 * What only a chat has beside any connected agent's page: where it listens, who can give it
 * work and how that is changed, why it ended, replies that may have been sent, and its recent
 * tasks with Stop. Every sentence comes from `chatFacts`, read from the Home.
 */
export function ChatFactsSection({
  client,
  facts,
  live,
}: {
  readonly client: Pick<ChatScreenHost, "stopRun">;
  readonly facts: ChatFacts;
  /** Still connected: its running tasks can be stopped from here. */
  readonly live: boolean;
}) {
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stop = async (threadId: string) => {
    setStopping(threadId);
    setError(null);
    try {
      await client.stopRun(threadId);
    } catch (reason) {
      setError(presentFailure(reason, "stop this task", "stopped"));
    } finally {
      setStopping(null);
    }
  };
  return (
    <>
      {facts.ended ? (
        <p className="notice" role="status">
          {facts.ended}
        </p>
      ) : null}
      {facts.unknownReplies ? (
        <p className="notice notice--warn" role="note">
          {facts.unknownReplies}
        </p>
      ) : null}
      <SettingsGroup heading={agentWords("chat.where.title")} headingId="chat-where">
        <SettingsRow title={<SentenceText parts={facts.whereParts} />} />
      </SettingsGroup>
      <SettingsGroup heading={agentWords("chat.speakers.title")} headingId="chat-speakers">
        <SettingsRow
          title={<SentenceText parts={facts.speakers.titleParts} />}
          detail={<SentenceText parts={facts.speakers.detailParts} />}
        />
        <SettingsRow title={facts.fixed} />
      </SettingsGroup>
      <SettingsGroup heading={agentWords("chat.tasks.title")} headingId="chat-tasks">
        {facts.tasks.length === 0 ? <SettingsRow title={agentWords("chat.tasks.empty")} /> : null}
        {facts.tasks.map((task) => (
          <SettingsRow
            key={task.id}
            title={task.title}
            detail={agentWords(task.running ? "chat.tasks.running" : "chat.tasks.done")}
            action={
              <span className="card__row-actions">
                <Link className="btn btn--small" to={`/tasks/${task.id}`}>
                  {agentWords("chat.tasks.open")}
                </Link>
                {live && task.running ? (
                  <button
                    className="btn btn--small btn--danger"
                    disabled={stopping !== null}
                    onClick={() => void stop(task.id)}
                    type="button"
                  >
                    {stopping === task.id
                      ? agentWords("chat.tasks.stopping")
                      : agentWords("chat.tasks.stop")}
                  </button>
                ) : null}
              </span>
            }
          />
        ))}
      </SettingsGroup>
      <SettingsError message={error} />
    </>
  );
}
