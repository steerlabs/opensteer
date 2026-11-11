import { useEffect, useState } from "react";
import { Icon, type IconName } from "../icon.js";
import { TeamTile } from "./team-marks.js";
import type { TeamTileView } from "./team-models.js";

/** Why a team can't be used right now, or why an invite can't be. Each names its way forward. */
export type TeamProblem =
  | { readonly kind: "expired"; readonly inviter: string | null }
  | { readonly kind: "already-member"; readonly you: string }
  /** This app is older than the team's server: whoever is behind updates. */
  | { readonly kind: "update-app" }
  /** The team's server is older than this app. It updates itself. */
  | { readonly kind: "update-server" }
  | { readonly kind: "unreachable" };

export interface TeamProblemActions {
  readonly onClose?: (() => void) | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly onUpdate?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
}

function words(team: string, problem: TeamProblem) {
  switch (problem.kind) {
    case "expired":
      return {
        eyebrow: "Invite link",
        icon: null,
        title: "This invite has expired",
        body: problem.inviter
          ? `Ask ${problem.inviter}, or anyone who manages ${team}, for a new link.`
          : `Ask anyone who manages ${team} for a new link.`,
      };
    case "already-member":
      return {
        eyebrow: "Already a member",
        icon: null,
        title: `You’re already in ${team}`,
        body: `Signed in as ${problem.you}.`,
      };
    case "update-app":
      return {
        eyebrow: "Your app is behind",
        icon: "download" as const,
        title: `Update Opensteer to use ${team}`,
        body: `${team} runs a newer version than this app. Updating takes a minute; your tasks keep running.`,
      };
    case "update-server":
      return {
        eyebrow: "The server is behind",
        icon: "server" as const,
        title: `${team}’s server needs an update`,
        body: "It updates itself; try again shortly. Your own tasks aren’t affected.",
      };
    case "unreachable":
      return {
        eyebrow: "Server unreachable",
        icon: "cloud-off" as const,
        title: `Can’t reach ${team} right now`,
        body: "Showing what you’d already loaded. Messages you write wait and send when it’s back.",
      };
  }
}

/** One state on the way in, or one reason a team is out of reach, with its one way forward. */
export function TeamProblemCard({
  actions,
  problem,
  team,
}: {
  readonly actions: TeamProblemActions;
  readonly problem: TeamProblem;
  readonly team: TeamTileView;
}) {
  const said = words(team.name, problem);
  const icon: IconName | null = said.icon;
  return (
    <section className="team-problem" role={problem.kind === "unreachable" ? "status" : "alert"}>
      <p className="eyebrow">{said.eyebrow}</p>
      <span className="team-problem__mark">
        {icon ? <Icon name={icon} /> : <TeamTile size={20} tile={team} />}
      </span>
      <h2 className="team-problem__title">{said.title}</h2>
      <p className="team-problem__body">{said.body}</p>
      <div className="team-problem__actions">
        {problem.kind === "already-member" && actions.onOpen ? (
          <button className="btn btn--small btn--primary" onClick={actions.onOpen} type="button">
            Open {team.name}
          </button>
        ) : null}
        {problem.kind === "update-app" && actions.onUpdate ? (
          <button className="btn btn--small btn--primary" onClick={actions.onUpdate} type="button">
            Update Opensteer
          </button>
        ) : null}
        {(problem.kind === "update-server" || problem.kind === "unreachable") && actions.onRetry ? (
          <button className="btn btn--small" onClick={actions.onRetry} type="button">
            Try again
          </button>
        ) : null}
        {problem.kind === "expired" && actions.onClose ? (
          <button className="btn btn--small" onClick={actions.onClose} type="button">
            Close
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** A team the app can't use until someone updates: in place of the channel, centred. */
export function TeamBlockedScreen(props: Parameters<typeof TeamProblemCard>[0]) {
  return (
    <div className="team-blocked">
      <TeamProblemCard {...props} />
    </div>
  );
}

export type ConnectionNotice =
  | { readonly kind: "reconnecting" }
  | { readonly kind: "unreachable" }
  /** The person's own computer, where their agent works, is offline. */
  | { readonly kind: "computer-offline"; readonly computerName: string }
  | { readonly kind: "update-app" }
  | { readonly kind: "update-server" };

/** Shown only once a problem has lasted this long, so a blip draws nothing. */
const bannerDelayMs = 2000;

/**
 * One line, never a modal. The person's own Opensteer and each team connect
 * separately, so each has its own line and neither blocks the other.
 */
export function ConnectionBanner({
  immediate = false,
  notice,
  onRetry,
  onUpdate,
  team,
}: {
  /** Skip the delay (a state the reader opened into, not one that just began). */
  readonly immediate?: boolean;
  readonly notice: ConnectionNotice | null;
  readonly onRetry?: (() => void) | undefined;
  readonly onUpdate?: (() => void) | undefined;
  readonly team: string;
}) {
  const [shown, setShown] = useState(immediate);
  useEffect(() => {
    if (!notice || immediate) return;
    setShown(false);
    const timer = window.setTimeout(() => setShown(true), bannerDelayMs);
    return () => window.clearTimeout(timer);
  }, [immediate, notice?.kind]);
  if (!notice || !shown) return null;
  const line = (icon: IconName | "spinner", text: string, tone = "", action?: React.ReactNode) => (
    <div className={`connection-line${tone ? ` connection-line--${tone}` : ""}`} role="status">
      {icon === "spinner" ? (
        <span aria-hidden className="spinner spinner--tiny" />
      ) : (
        <Icon name={icon} />
      )}
      <span className="connection-line__text">{text}</span>
      {action}
    </div>
  );
  switch (notice.kind) {
    case "reconnecting":
      return line("spinner", `Reconnecting to ${team}…`);
    case "unreachable":
      return line(
        "cloud-off",
        `Can’t reach ${team}. Showing what’s loaded; your messages will send when it’s back.`,
        "",
        onRetry ? (
          <button className="btn btn--small" onClick={onRetry} type="button">
            Try again
          </button>
        ) : null,
      );
    case "computer-offline":
      return line(
        "laptop",
        `Your ${notice.computerName} is offline. Tasks wait; asks to your agent start when it’s back.`,
        "amber",
      );
    case "update-app":
      return line(
        "download",
        `Update Opensteer to keep using ${team}.`,
        "amber",
        onUpdate ? (
          <button className="btn btn--small btn--primary" onClick={onUpdate} type="button">
            Update
          </button>
        ) : null,
      );
    case "update-server":
      return line(
        "server",
        `${team}’s server needs an update. It updates itself; try again shortly.`,
      );
  }
}
