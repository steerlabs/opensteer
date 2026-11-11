import { useState } from "react";
import { noteSubagentStop, type AgentCard } from "@opensteer/client/host";
import { useActionReview } from "@opensteer/client/react";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";

/**
 * Stop for one subagent, offered while it runs and its engine can stop it on
 * its own. It asks once before stopping; the Host refuses anyone who may not.
 */
export function SubagentStop({ card, icon = false }: { card: AgentCard; icon?: boolean }) {
  const { hostClient, reportActionError } = useShell();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { review, ask, dismiss } = useActionReview(hostClient);
  const close = () => {
    setAnchor(null);
    dismiss();
  };
  if (!card.stop) return null;
  const target = card.stop;
  const noun = card.kind === "workflow" ? "workflow" : "subagent";
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="dialog"
        aria-label={`Stop ${card.title}`}
        className={icon ? "icon-btn icon-btn--small subagent-stop" : "btn btn--small subagent-stop"}
        onClick={(event) => {
          setAnchor(event.currentTarget);
          ask({ kind: "stop-node", ...target });
        }}
        title={icon ? "Stop" : undefined}
        type="button"
      >
        <Icon name="stop" />
        {icon ? null : "Stop"}
      </button>
      {anchor && review ? (
        <Popover
          anchor={anchor}
          className="task-stop"
          label={`Stop ${card.title}?`}
          onClose={close}
          role="dialog"
        >
          <p className="task-stop__question">Stop “{card.title}”?</p>
          <p className="task-stop__detail">Nothing it already did is undone.</p>
          <div className="task-stop__actions">
            <button
              className="btn btn--small btn--ghost"
              data-autofocus
              onClick={close}
              type="button"
            >
              Keep working
            </button>
            <button
              className="btn btn--small btn--danger"
              onClick={() => {
                const result = review.confirm();
                close();
                noteSubagentStop(target.nodeId);
                void result.catch(reportActionError);
              }}
              type="button"
            >
              Stop {noun}
            </button>
          </div>
        </Popover>
      ) : null}
    </>
  );
}
