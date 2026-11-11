import type { Can, RuntimeState } from "@opensteer/protocol";
import type {
  SnapshotAudience,
  TaskStartedBy,
  TaskStopped,
  ThreadRequestOutcome,
  ThreadRequestWaits,
} from "@opensteer/core";
import { HostClientRequestError } from "./client.js";

/**
 * The words a shared task says about who started it, who it waits on and how
 * its questions ended. Every fact comes from the Host's Thread or Request view;
 * an absent fact says nothing rather than a guess.
 */

export function audienceLabel(audience: SnapshotAudience, project: string): string {
  return `${project} · ${audience.people === 1 ? "1 person" : `${audience.people} people`}`;
}

export function taskStarterLine(startedBy: TaskStartedBy, viewerId: string | null): string {
  switch (startedBy.kind) {
    case "person":
      return startedBy.userId === viewerId ? "Started by you" : `Started by ${startedBy.name}`;
    case "trigger":
      return `Scheduled · ${startedBy.name}`;
    case "watch":
      return `Watching · ${startedBy.name}`;
  }
}

export function taskStoppedText(
  stopped: TaskStopped,
  place: { readonly project: string; readonly team: string },
): { readonly short: string; readonly long: string } {
  const kept = `Its files and results so far stay in ${place.project}.`;
  if (stopped.reason === "no-eligible-manager")
    return {
      short: `Stopped · ${place.project} has no manager`,
      long: `Stopped because ${place.project} has no manager to answer its questions. Ask an admin of ${place.team} to appoint one.`,
    };
  if (stopped.starterName)
    return {
      short: `Stopped · ${stopped.starterName} is no longer in ${place.team}`,
      long: `Stopped because ${stopped.starterName} left ${place.team}. ${kept}`,
    };
  return {
    short: `Stopped · its starter can no longer use ${place.project}`,
    long: `Stopped because the person who started it can no longer use ${place.project}. ${kept}`,
  };
}

/**
 * One line per wait the Host listed, and one for any it left out of its
 * window. A wait the reader holds the Request for is their card instead.
 */
export function requestWaitLines(
  waits: ThreadRequestWaits,
  project: string,
  held: ReadonlySet<string> = new Set(),
): string[] {
  const shown = waits.items.filter(({ requestId }) => !held.has(requestId));
  const lines = shown.map(({ class: kind, waitingOn }) => {
    const verb = kind === "approval" ? "approve" : "answer";
    return waitingOn.kind === "person"
      ? `Waiting for ${waitingOn.name} to ${verb}.`
      : `Waiting for a manager of ${project} to ${verb}.`;
  });
  const more = waits.total - waits.items.length;
  return more > 0 ? [...lines, `${more} more waiting.`] : lines;
}

export function requestOutcomeLine(
  outcome: ThreadRequestOutcome,
  place: { readonly project: string; readonly team: string },
): string {
  if (outcome.status !== "cancelled")
    return `${{ fulfilled: "Answered", declined: "Declined", withdrawn: "Withdrawn" }[outcome.status]} by ${outcome.resolvedByName}`;
  const name = outcome.cancelledFor?.name;
  switch (outcome.reason) {
    case "no-eligible-manager":
      return `Cancelled: ${place.project} has no manager to answer it. The task stopped.`;
    case "membership-revoked":
      return name
        ? `Cancelled: ${name} is no longer in ${place.team}. The task stopped.`
        : "Cancelled: the person it waited on is no longer here. The task stopped.";
    case "authority-revoked":
      return name
        ? `Cancelled: ${name} can no longer use ${place.project}. The task stopped.`
        : `Cancelled: the person it waited on can no longer use ${place.project}. The task stopped.`;
    default:
      return "Cancelled";
  }
}

/**
 * The one line above an answerable card that says why this person is the one
 * asked. Only the Host's `answer` and `waitingOn` decide it.
 */
export function requestAnswerNote(
  request: {
    readonly answer?: Can | undefined;
    readonly waitingOn?: { kind: "person"; name: string } | { kind: "managers" } | null | undefined;
    readonly source?: { kind: "trigger" | "watch"; name: string } | undefined;
  },
  project: string,
): string | null {
  if (request.answer?.allowed !== true || !request.waitingOn) return null;
  if (request.waitingOn.kind === "person") return "Only you can answer: you started this task.";
  const anyManager = `Any manager of ${project} can answer.`;
  return request.source ? `${request.source.name} is asking. ${anyManager}` : anyManager;
}

/** An answer the Host refused because another answer settled the Request first. */
export function requestAnswerRefusalText(error: unknown): string | null {
  return error instanceof HostClientRequestError && error.reason === "request-already-settled"
    ? "Someone else answered first. Your answer wasn’t sent."
    : null;
}

/**
 * Why a shared Project's composer can't send, from its runtime and the
 * reader's own level. Null when it runs or nothing is known.
 */
export function composerRuntimeNotice(
  runtime: RuntimeState | undefined,
  /** `canChange` is the Host's `can` to manage the Project; unknown means no. */
  place: { readonly project: string; readonly team: string; readonly canChange: boolean },
): { readonly why: string; readonly fix: string; readonly settings: boolean } | null {
  if (!runtime || runtime.state === "ready") return null;
  const { project, team, canChange: manages } = place;
  switch (runtime.reason) {
    case "computer-offline":
      return {
        why: `${team}’s computer is offline, so tasks wait until it’s back.`,
        fix: `An admin of ${team} can fix this.`,
        settings: false,
      };
    case "runner-update-required":
      return {
        why: `${team}’s computer needs an update before it can run tasks.`,
        fix: `An admin of ${team} can fix this.`,
        settings: false,
      };
    case "not-configured":
      return manages
        ? {
            why: `${project} can’t run tasks yet.`,
            fix: "Choose an engine and model.",
            settings: true,
          }
        : {
            why: `${project} can’t run tasks yet: it hasn’t been set up.`,
            fix: `A manager of ${project} can fix this.`,
            settings: false,
          };
    case "engine-unavailable":
    case "model-unavailable":
      return manages
        ? {
            why: `The ${runtime.reason === "engine-unavailable" ? "engine" : "model"} ${project} was set up with isn’t available any more.`,
            fix: `Choose another ${runtime.reason === "engine-unavailable" ? "engine" : "model"}.`,
            settings: true,
          }
        : {
            why: `The ${runtime.reason === "engine-unavailable" ? "engine" : "model"} ${project} was set up with isn’t available any more.`,
            fix: `A manager of ${project} can choose another.`,
            settings: false,
          };
  }
}

/**
 * The outcomes a task shows as lines of their own: those whose question the
 * transcript doesn't already show where it was asked, which a reader who
 * couldn't read the question never has.
 */
export function unplacedOutcomes(
  outcomes: readonly ThreadRequestOutcome[],
  transcript: readonly { readonly kind: string; readonly requestId?: string }[],
): ThreadRequestOutcome[] {
  const placed = new Set(
    transcript.flatMap((entry) =>
      entry.kind === "request" && entry.requestId ? [entry.requestId] : [],
    ),
  );
  return outcomes.filter(({ requestId }) => !placed.has(requestId));
}

/** An empty shared task or Project chat, in the words a team place uses. */
export function teamEmptyThreadLine(project: string, team: string): string {
  return `Describe the outcome you want. ${project} does its work on ${team}’s computer, and everyone on the project can see it.`;
}
