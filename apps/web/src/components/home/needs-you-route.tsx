import { useMemo } from "react";
import { useShell } from "../app-shell.js";
import { AreaHeader } from "../workspace/conversation-header.js";
import { useWorkspace } from "../workspace/workspace-context.js";
import { useTaskSourceLookup } from "../../team/task-sources.js";
import { NeedsYouPage } from "./needs-you.js";
import { needsYouItems, useNeedsYouAnswer } from "./needs-you-model.js";

/** Every Request waiting on the person, newest first. */
export function NeedsYouRoute() {
  const { hostClient, reportActionError, snapshot } = useShell();
  const { nav } = useWorkspace();
  const sourceOf = useTaskSourceLookup();
  const items = useMemo(() => needsYouItems(snapshot, sourceOf), [snapshot, sourceOf]);
  const answer = useNeedsYouAnswer(hostClient, reportActionError);
  return (
    <div className="thread">
      <NeedsYouPage
        actions={{
          onAnswer: answer.answer,
          onOpenTask: (taskId) => nav.openConversation(nav.threadPath(taskId)),
        }}
        header={<AreaHeader hostClient={hostClient} title="Needs you" />}
        items={items}
        pending={answer.pending}
      />
      {snapshot.needsYou?.window.hasMore ? (
        <button
          className="sidebar__more"
          onClick={() => void hostClient.loadEarlierNeedsYou().catch(reportActionError)}
          type="button"
        >
          Show more
        </button>
      ) : null}
    </div>
  );
}
