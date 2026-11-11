import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "../icon.js";
import { ChatOrb, WorkingRing } from "../workspace/task-mark.js";
import { AuthorAvatar } from "./team-marks.js";
import {
  agentName,
  firstName,
  plural,
  stepWord,
  type AgentRequestView,
  type StepCount,
} from "./team-models.js";
import { clockTime, duration } from "./team-time.js";

/** What only the owner can do with their own agent's ask. Others get none of these. */
export interface AgentCardActions {
  readonly onOpenTask?: ((requestId: string) => void) | undefined;
  readonly onStop?: ((requestId: string) => void) | undefined;
  readonly onCancel?: ((requestId: string) => void) | undefined;
  readonly onAnswer?: ((requestId: string) => void) | undefined;
  readonly onRetry?: ((requestId: string) => void) | undefined;
}

/**
 * The agent's reply row while it works: its byline, then one plate of two
 * fixed lines that changes in place and never grows, so a thread never
 * reflows under its reader. When the reply posts, the reply replaces this row.
 */
export function AgentCardRow({
  actions,
  request,
}: {
  readonly actions?: AgentCardActions | undefined;
  readonly request: AgentRequestView;
}) {
  return (
    <article className="tmsg tmsg--card" data-request-id={request.id}>
      <div className="tmsg__gutter">
        <AuthorAvatar author={{ kind: "agent", owner: request.owner }} size={36} />
      </div>
      <div className="tmsg__main">
        <header className="tmsg__head">
          <span className="tmsg__name">{agentName(request.owner)}</span>
        </header>
        <AgentStatusCard actions={actions} request={request} />
      </div>
    </article>
  );
}

export function AgentStatusCard({
  actions = {},
  request,
}: {
  readonly actions?: AgentCardActions | undefined;
  readonly request: AgentRequestView;
}) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const { owner, state } = request;
  const mine = owner.you === true;
  const who = agentName(owner);
  const ownerFirst = firstName(owner);
  const id = request.id;
  const button = (label: string, run: ((id: string) => void) | undefined, primary = false) =>
    mine && run ? (
      <button
        className={primary ? "btn btn--small btn--primary" : "btn btn--small"}
        onClick={(event) => {
          event.stopPropagation();
          run(id);
        }}
        type="button"
      >
        {label}
      </button>
    ) : null;

  let tone: "quiet" | "live" | "attention" | "failed" = "quiet";
  let mark: ReactNode;
  let title: ReactNode;
  let line: ReactNode;
  let controls: ReactNode = null;

  switch (state.kind) {
    case "waiting-computer":
      mark = <Icon name="clock" />;
      title = mine
        ? `Will start when your ${state.computerName} is back`
        : `Will start when ${ownerFirst}’s computer is back`;
      line = mine
        ? "Open Opensteer on it, or wake it. Nothing is lost meanwhile."
        : [
            `Asked ${clockTime(request.askedAt)}`,
            state.lastSeenAt ? `last seen ${clockTime(state.lastSeenAt)}` : null,
          ]
            .filter(Boolean)
            .join(" · ");
      controls = button("Cancel", actions.onCancel);
      break;
    case "queued":
      mark = <ChatOrb size={20} />;
      title = (
        <>
          Queued
          <span className="agent-card__meta">
            {state.ahead > 0 ? `starts after ${plural(state.ahead, "other")}` : "starts next"}
          </span>
        </>
      );
      line = `${who} is answering elsewhere`;
      controls = button("Cancel", actions.onCancel);
      break;
    case "working": {
      const count = state.steps.reduce((sum, step) => sum + step.count, 0);
      tone = "live";
      mark = (
        <span className="agent-card__orb">
          <ChatOrb size={20} />
          <WorkingRing />
        </span>
      );
      title = (
        <>
          Working
          <span className="agent-card__meta">
            {count > 0 ? `${plural(count, "step")} · ` : ""}
            <Elapsed since={state.startedAt} />
          </span>
        </>
      );
      line = (
        <span className="agent-card__live">
          {state.current ? stepWord(state.current, "now") : "Starting"}
        </span>
      );
      controls = mine ? (
        <>
          {button("Open task", actions.onOpenTask)}
          {actions.onStop ? (
            <button
              aria-label={`Stop ${who.toLowerCase()}`}
              className="icon-btn icon-btn--small agent-card__stop"
              onClick={(event) => {
                event.stopPropagation();
                actions.onStop?.(id);
              }}
              title="Stop"
              type="button"
            >
              <Icon name="stop" />
            </button>
          ) : null}
        </>
      ) : null;
      break;
    }
    case "needs-owner":
      tone = "attention";
      mark = <span className="agent-card__bang">!</span>;
      title = mine ? "Needs you" : `Waiting for ${ownerFirst}`;
      line = mine ? (
        <span className="agent-card__ask">{state.ask ?? "Your agent asked you something"}</span>
      ) : (
        `${who} asked ${ownerFirst} something${state.steps > 0 ? ` · ${plural(state.steps, "step")} so far` : ""}`
      );
      controls = button("Answer", actions.onAnswer, true);
      break;
    case "failed":
      tone = mine ? "failed" : "quiet";
      mark = <Icon name="close" />;
      title = mine ? "Couldn’t finish" : `${who} couldn’t finish`;
      line = mine ? (
        <span className="agent-card__cause">{state.cause ?? "Open the task to see why."}</span>
      ) : (
        "Nothing was posted"
      );
      controls = (
        <>
          {button("Open task", actions.onOpenTask)}
          {button("Try again", actions.onRetry)}
        </>
      );
      break;
    case "stopped":
      mark = <Icon name="stop" />;
      title = `Stopped by ${state.by}`;
      line = `After ${plural(state.steps, "step")} · ${clockTime(state.at)}`;
      controls = button("Open task", actions.onOpenTask);
      break;
    case "cannot-post":
      mark = <Icon name="lock" />;
      title = `${who} can’t post here any more`;
      line = "This thread’s access changed while it worked. Nothing was posted.";
      controls = button("Open task", actions.onOpenTask);
      break;
  }

  const steps = state.kind === "working" ? state.steps : null;
  const dashed =
    state.kind === "waiting-computer" || state.kind === "stopped" || state.kind === "cannot-post";
  return (
    <div className="agent-card-wrap">
      <div
        aria-expanded={steps ? stepsOpen : undefined}
        className={[
          "agent-card",
          `agent-card--${tone}`,
          dashed ? "agent-card--dashed" : "",
          steps ? "agent-card--opens" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-state={state.kind}
        onClick={steps ? () => setStepsOpen((open) => !open) : undefined}
        onKeyDown={
          steps
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setStepsOpen((open) => !open);
                }
              }
            : undefined
        }
        role={steps ? "button" : undefined}
        tabIndex={steps ? 0 : undefined}
      >
        <span aria-hidden className="agent-card__mark">
          {mark}
        </span>
        <span aria-live="polite" className="agent-card__text">
          <span className="agent-card__title">{title}</span>
          <span className="agent-card__line">{line}</span>
        </span>
        {controls ? <span className="agent-card__controls">{controls}</span> : null}
      </div>
      {steps && stepsOpen ? <StepList steps={steps} /> : null}
    </div>
  );
}

function StepList({ steps }: { readonly steps: readonly StepCount[] }) {
  if (steps.length === 0) return <p className="agent-steps agent-steps--empty">No steps yet</p>;
  return (
    <ul aria-label="Steps so far" className="agent-steps">
      {steps.map((step) => (
        <li key={step.kind}>
          {stepWord(step.kind, "past")}
          {step.count > 1 ? <span className="agent-steps__count"> ×{step.count}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Ticks on its own each second, so the card around it redraws only on a state or step change. */
function Elapsed({ since }: { readonly since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <>{duration(now - Date.parse(since))}</>;
}

/** The quiet line under an agent's reply: how long it worked, and Open task for its owner. */
export function AgentWorkFooter({
  durationMs,
  onOpenTask,
  steps,
}: {
  readonly durationMs: number;
  readonly onOpenTask?: (() => void) | undefined;
  readonly steps: number;
}) {
  return (
    <p className="agent-work">
      <Icon name="clock" />
      <span>
        Worked {duration(durationMs)} · {plural(steps, "step")}
      </span>
      {onOpenTask ? (
        <button className="agent-work__open" onClick={onOpenTask} type="button">
          Open task
        </button>
      ) : null}
    </p>
  );
}
