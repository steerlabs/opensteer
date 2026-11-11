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

/**
 * Why a task stopped. The Host can't know that anyone left: the same access
 * change stops work when a role or level changes while the person stays. So
 * the starter is named from `startedBy`, and only as whose access changed.
 */
export function taskStoppedText(
  stopped: TaskStopped,
  place: { readonly project: string; readonly team: string },
  starter?: { readonly startedBy?: TaskStartedBy | undefined; readonly viewerId: string | null },
): { readonly short: string; readonly long: string } {
  if (stopped.reason === "no-eligible-manager")
    return {
      short: "Stopped · no manager is left to answer",
      long: `Stopped because no manager of ${place.project} is left to answer its questions. Ask an admin of ${place.team} to appoint one.`,
    };
  const person = starter?.startedBy?.kind === "person" ? starter.startedBy : null;
  const whose =
    person === null
      ? "its starter’s"
      : person.userId === starter?.viewerId
        ? "your"
        : `${person.name}’s`;
  return {
    short: `Stopped · ${whose} access changed`,
    long: `Stopped because ${whose} access changed.`,
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

/**
 * How a past question ended, for where its own title isn't shown. A
 * cancellation's name is whose question it was, never that they left.
 */
export function requestOutcomeLine(
  outcome: ThreadRequestOutcome & { readonly class?: "question" | "approval" | undefined },
): string {
  const kind = outcome.class === "approval" ? "approval" : "question";
  if (outcome.status !== "cancelled") {
    const how = { fulfilled: "Answered", declined: "Declined", withdrawn: "Withdrawn" }[
      outcome.status
    ];
    return outcome.class
      ? `${kind === "approval" ? "An approval" : "A question"} · ${how} by ${outcome.resolvedByName}`
      : `${how} by ${outcome.resolvedByName}`;
  }
  return requestCancelledLine(outcome.reason, outcome.cancelledFor?.name ?? null, kind);
}

/** A cancelled question, from its reason and, when the Host names one, whose question it was. */
export function requestCancelledLine(
  reason: string,
  forName: string | null,
  kind: "question" | "approval" = "question",
): string {
  if (reason === "no-eligible-manager") return "Cancelled: no manager is left to answer it.";
  if (forName && (reason === "membership-revoked" || reason === "authority-revoked"))
    return `This was ${forName}’s ${kind}. It was cancelled when ${forName}’s access changed.`;
  return "Cancelled";
}

/**
 * The one line on a card that says whose question it is: why this reader is
 * asked, or who answers instead. Only the Host's `answer` and `waitingOn` decide it.
 */
export function requestAnswerNote(
  request: {
    readonly answer?: Can | undefined;
    readonly waitingOn?: { kind: "person"; name: string } | { kind: "managers" } | null | undefined;
    readonly source?: { kind: "trigger" | "watch"; name: string } | undefined;
  },
  project: string,
): string | null {
  if (request.answer === undefined || !request.waitingOn) return null;
  const anyManager = `Any manager of ${project} can answer.`;
  if (!request.answer.allowed)
    return request.waitingOn.kind === "person"
      ? `Only ${request.waitingOn.name} can answer.`
      : anyManager;
  if (request.waitingOn.kind === "person") return "Only you can answer: you started this task.";
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
