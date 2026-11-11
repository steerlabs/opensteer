import type { AgentCardView, StepKind } from "./team-models.js";

/**
 * A status card's words for its reader. The channel sees step kinds and
 * counts, never targets; the owner also sees what only their own Opensteer
 * knows (the ask, the cause) and the controls only they may use.
 */
export interface StatusFace {
  readonly lead: "working" | "waiting" | "attention" | "failed" | "stopped" | "blocked";
  readonly title: string;
  /** Beside the title, quieter: "3 steps · 1m". */
  readonly meta: string | null;
  readonly line: string;
  readonly lineTone: "muted" | "amber" | "danger";
  /** Waiting on a computer that is offline: the plate is drawn dashed. */
  readonly dashed: boolean;
  /** The owner's one control on the card. */
  readonly action: {
    readonly kind: "stop" | "cancel" | "answer" | "retry";
    readonly label: string;
  } | null;
  /** Tapping the card opens the owner's task. */
  readonly opensTask: boolean;
}

export function statusFace(card: AgentCardView, now: number): StatusFace {
  const { agent, status } = card;
  const owner = firstName(agent.owner.name);
  const mine = agent.mine;
  const base = { dashed: false, meta: null, opensTask: mine } as const;
  switch (status.state) {
    case "offline":
      return {
        ...base,
        action: mine ? { kind: "cancel", label: "Cancel" } : null,
        dashed: true,
        lead: "waiting",
        line: mine
          ? `Asked ${status.askedAt} · open Opensteer there to start`
          : `Asked ${status.askedAt}${status.lastSeen === null ? "" : ` · last seen ${status.lastSeen}`}`,
        lineTone: "muted",
        title: `Will start when ${status.computer} is back`,
      };
    case "queued":
      return {
        ...base,
        action: mine ? { kind: "cancel", label: "Cancel" } : null,
        lead: "waiting",
        line: `${agent.byline} is answering elsewhere`,
        lineTone: "muted",
        title:
          status.ahead <= 0
            ? "Queued"
            : `Queued · starts after ${status.ahead} ${status.ahead === 1 ? "other" : "others"}`,
      };
    case "working":
      return {
        ...base,
        action: mine ? { kind: "stop", label: "Stop" } : null,
        lead: "working",
        line:
          status.liveStep === null
            ? "Starting"
            : liveStepWords(status.liveStep, mine ? "you" : owner),
        lineTone: "muted",
        meta: [stepCount(status.stepCount), elapsed(now - status.startedAt)]
          .filter((part) => part !== null)
          .join(" · "),
        title: "Working",
      };
    case "needs-owner":
      return mine
        ? {
            ...base,
            action: { kind: "answer", label: "Answer" },
            lead: "attention",
            line: status.ask ?? "Your agent asked you something",
            lineTone: "amber",
            title: "Needs you",
          }
        : {
            ...base,
            action: null,
            lead: "attention",
            line: `${agent.byline} asked ${owner} something`,
            lineTone: "muted",
            title: `Waiting for ${owner}`,
          };
    case "failed":
      return {
        ...base,
        action: mine ? { kind: "retry", label: "Try again" } : null,
        lead: "failed",
        line: mine ? (status.cause ?? "Open the task to see why") : "Nothing was posted",
        lineTone: mine ? "danger" : "muted",
        title: "Couldn't finish",
      };
    case "stopped":
      return {
        ...base,
        action: null,
        lead: "stopped",
        line: `${stepCount(status.stepCount) === null ? "Before any steps" : `After ${stepCount(status.stepCount)}`} · nothing was posted`,
        lineTone: "muted",
        title: `Stopped by ${status.by}`,
      };
    case "blocked":
      return {
        ...base,
        action: null,
        lead: "blocked",
        line: "Access changed · nothing was posted",
        lineTone: "muted",
        title: "Can't post here any more",
      };
  }
}

/** What the agent is doing now, in its kind's words. */
export function liveStepWords(kind: StepKind, owner: string): string {
  switch (kind) {
    case "read-thread":
      return "Reading the thread";
    case "browsed":
      return "Using the browser";
    case "read-files":
      return "Reading files";
    case "edited-files":
      return "Editing files";
    case "ran-commands":
      return "Running commands";
    case "used-integration":
      return "Using a connected app";
    case "searched-team":
      return "Searching the team";
    case "checked-knowledge":
      return "Checking knowledge";
    case "asked-owner":
      return owner === "you" ? "Asking you" : `Asking ${owner}`;
  }
}

function stepCount(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 step" : `${count} steps`;
}

/** Whole minutes: a phone redraws the card's time once a minute, not every second. */
export function elapsed(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
