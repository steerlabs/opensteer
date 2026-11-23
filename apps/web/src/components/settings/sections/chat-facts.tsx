import { useState } from "react";
import { Link } from "react-router";
import {
  agentWords,
  chatTaskStop,
  mutationIdempotencyKey,
  type ChatFacts,
  type ChatScreenHost,
  type ChatTaskNow,
} from "@opensteer/client/host";
import { SentenceText } from "../../../ui/address-text.js";
import { presentFailure } from "../../use-action.js";
import { SettingsError, SettingsGroup, SettingsRow } from "../primitives.js";

/**
 * What only a chat has beside any connected agent's page: where it listens, who can give it
 * work and how that is changed, why it ended, replies that may have been sent, and its recent
 * tasks with Stop. Every sentence comes from `chatFacts`, read from the Home; whether a task runs
 * comes from the Home's live task updates (`chatTasksNow`).
 */
export function ChatFactsSection({
  client,
  facts,
  live,
  tasks,
}: {
  readonly client: Pick<ChatScreenHost, "dispatch">;
  readonly facts: ChatFacts;
  /** Still connected: its running tasks can be stopped from here. */
  readonly live: boolean;
  /** Its recent tasks as they are now. */
  readonly tasks: readonly ChatTaskNow[];
}) {
  // A Run whose Stop was asked reads Stopping… until the Home says the task no longer runs (its
  // device answers), never Stop again beside Running; a Stop the Home refused says why. A later
  // Run of the task is a new Run, with a Stop of its own.
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const stop = async (task: ChatTaskNow & { readonly runId: string }) => {
    setAsked((current) => new Set([...current, task.runId]));
    setError(null);
    try {
      await client.dispatch(chatTaskStop(task, mutationIdempotencyKey("chat-stop")));
    } catch (reason) {
      setError(presentFailure(reason, "stop this task", "stopped"));
      setAsked((current) => new Set([...current].filter((run) => run !== task.runId)));
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
        {tasks.length === 0 ? <SettingsRow title={agentWords("chat.tasks.empty")} /> : null}
        {tasks.map((task) => (
          <SettingsRow
            key={task.id}
            title={task.title}
            detail={agentWords(task.running ? "chat.tasks.running" : "chat.tasks.done")}
            action={
              <span className="card__row-actions">
                <Link className="btn btn--small" to={`/tasks/${task.id}`}>
                  {agentWords("chat.tasks.open")}
                </Link>
                {live && task.running && task.runId !== null ? (
                  <button
                    className="btn btn--small btn--danger"
                    disabled={asked.has(task.runId)}
                    onClick={() => void stop({ ...task, runId: task.runId! })}
                    type="button"
                  >
                    {asked.has(task.runId)
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
