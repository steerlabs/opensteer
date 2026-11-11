import { useState } from "react";
import type { AgentCard } from "@opensteer/client/host";
import { useActionReview } from "@opensteer/client/react";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";

export function SubagentStop({ card, direct = false }: { card: AgentCard; direct?: boolean }) {
  const { hostClient, reportActionError } = useShell();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { review, ask, dismiss } = useActionReview(hostClient);
  const close = () => {
    setAnchor(null);
    dismiss();
  };
  if (!card.stop) return null;
  const target = card.stop;
  const request = () => ask({ kind: "stop-node", ...target });
  return (
    <>
      <button
        aria-label={direct ? `Stop ${card.title}` : `More for ${card.title}`}
        aria-haspopup={direct ? "dialog" : "menu"}
        aria-expanded={anchor !== null}
        className={direct ? "btn btn--small btn--ghost" : "agent-row__more"}
        onClick={(event) => {
          setAnchor(event.currentTarget);
          if (direct) request();
        }}
        type="button"
      >
        <Icon name={direct ? "stop" : "more"} />
        {direct ? "Stop" : null}
      </button>
      {anchor ? (
        review ? (
          <Popover
            anchor={anchor}
            className="task-stop"
            key="confirm"
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
                  void result.catch(reportActionError);
                }}
                type="button"
              >
                Stop {card.kind === "workflow" ? "workflow" : "subagent"}
              </button>
            </div>
          </Popover>
        ) : (
          <Popover
            anchor={anchor}
            className="task-menu"
            label={`${card.title} actions`}
            onClose={close}
          >
            <button
              className="picker__row picker__row--danger"
              onClick={request}
              role="menuitem"
              type="button"
            >
              <span className="picker__glyph">
                <Icon name="stop" />
              </span>
              <span className="picker__label">
                Stop {card.kind === "workflow" ? "workflow" : "subagent"}
              </span>
            </button>
          </Popover>
        )
      ) : null}
    </>
  );
}
