import {
  commandAgentStatus,
  commandRequestAnswers,
  type CommandRequestPart,
  type Request,
} from "@opensteer/core";
import {
  commandFieldLabel,
  commandReviewRows,
  outsideName,
  outsideProse,
  type CommandReviewRow,
} from "@opensteer/protocol/command-review";
import { accessModeOptions } from "./access-modes.js";
import { requestDecision, type RequestView } from "./client.js";

/**
 * A Home command an agent proposed, as the person reviews it on any client: the Home's sentence,
 * who asked, the agent's own words kept apart, and the change itself, every argument whole as
 * typed data, each string from outside the Home escaped so what is shown is what is there. Web and
 * the phone both show this, so neither can show a proposal differently.
 */

export type CommandRequestState =
  | "pending"
  | "running"
  | "done"
  | "refused"
  | "unknown"
  | "declined"
  | "person-says-done"
  | "done-by-person"
  | "closed";

/**
 * How long Approve stays inert after a card, or a new revision of one, appears: longer than a
 * double click and a tap timed to land as a card swaps in, short enough not to be felt.
 */
export const commandApproveArmMs = 1_000;

/** A row as the card shows it: with the product's words for a mode or a reach beside its value. */
export interface CommandRequestRow extends CommandReviewRow {
  readonly meaning: string | null;
}

export interface CommandRequestView {
  readonly requestId: string;
  /** The Request as the person reviews it: its id and revision. A new revision is a new card. */
  readonly identity: string;
  /** The change in the Home's words: the card's heading. */
  readonly sentence: string;
  /** Who asked, as the Home names it. */
  readonly askedBy: string;
  /** What it gives to whom, in the Home's words, when it widens something. */
  readonly gives: string | null;
  /** The agent's own reason, labelled as its words and never as the Home's. */
  readonly agentWords: { readonly label: string; readonly text: string } | null;
  /** Over the rows: they are the agent's proposal, shown exactly. */
  readonly rowsHeading: string;
  /** Every argument of the command, in order; a heading has no value. */
  readonly rows: readonly CommandRequestRow[];
  /**
   * A command that carries a value only the person types is never approved here: they do it on
   * its own screen, then say so. What it needs, and that screen where one exists.
   */
  readonly personOnly: {
    readonly needs: string;
    readonly screen: { readonly id: string; readonly label: string } | null;
  } | null;
  readonly state: CommandRequestState;
  /** What the buttons do while it waits; what became of it after. */
  readonly line: string;
  readonly approve: { readonly label: string } | null;
  readonly doneMyself: { readonly label: string } | null;
  readonly decline: { readonly label: string } | null;
}

export const commandRequestWords = {
  approve: "Approve",
  decline: "Decline",
  doneMyself: "I did it myself",
  pending: "Approve runs it as you, exactly as shown. Decline tells the agent no.",
  personOnly:
    "It needs something only you type, so it is not approved here. Do it yourself on its own screen, then say so here, or decline.",
  noScreen:
    "It needs something only you type, and no screen in Opensteer takes it here, so it can only be declined.",
  running: "Approved. It is running now.",
  done: "Approved and done.",
  refused: "Approved, but the Home refused it, so nothing changed.",
  unknown:
    "Approved, but the Home cannot tell whether it happened. It will not run it again; check it before it is done again.",
  declined: "Declined. The agent was told no.",
  "person-says-done":
    "You said you did it yourself. The agent was told what you said; nothing here shows that it happened.",
  "done-by-person":
    "You did it yourself in Opensteer. The agent was told, and its proposal did not run.",
  closed: "This ask closed before it was answered, so nothing changed.",
  now: "Now",
  needs: "Needs",
  more: "More below. Scroll to the end to approve.",
  arming: "Approve is ready in a moment, so a click meant for something else cannot approve this.",
} as const;

/** The screens that perform a command, by the Home's name for each. */
const screenLabels: Readonly<Record<string, string>> = {
  "account-link": "Account",
  "add-device": "Devices",
  "ai-engines": "AI engines",
  automation: "Automations",
  "automation-secrets": "the automation's Secrets",
  "browser-profiles": "Browser profiles",
  chrome: "Chrome",
  "connected-agent": "Connected agents",
  "device-access": "Devices",
  "device-apps": "Devices",
  "general-settings": "General settings",
  messaging: "Messaging",
  plugin: "Plugins",
  "remote-access": "Remote access",
  tabs: "Tabs",
  "task-settings": "Task settings",
};

/** The product's words for the values a person reads as settings: a mode, a reach. */
function meaningOf(path: string, value: string | null): string | null {
  if (value === null) return null;
  const key = path.split("/").at(-1);
  if (key === "accessMode" || key === "mode") {
    const option = accessModeOptions.find(({ mode }) => JSON.stringify(mode) === value);
    return option ? option.label : null;
  }
  if (key === "scope")
    return value === '"everything"'
      ? "Everything"
      : value === '"selected"'
        ? "Only what is chosen"
        : null;
  return null;
}

function who(proposer: CommandRequestPart["proposer"]): string {
  return proposer.kind === "connection" ? "the connected agent" : "the agent";
}

function askedBy(proposer: CommandRequestPart["proposer"]): string {
  // As the Home names it on the card's own title.
  const name = `${who(proposer)} “${outsideName(proposer.name)}”`;
  return proposer.taskTitle
    ? `Asked by ${name}, in its task “${outsideName(proposer.taskTitle)}”`
    : `Asked by ${name}`;
}

function capital(text: string): string {
  return `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

function stateOf(
  request: Pick<Request, "status" | "command"> & {
    readonly response?: Request["response"] | undefined;
  },
): CommandRequestState {
  switch (commandAgentStatus(request)) {
    case "pending":
      return "pending";
    case "approved-done":
      return "done";
    case "approved-failed":
      return "refused";
    case "approved-unknown":
      return "unknown";
    case "approved-running":
      return "running";
    case "declined":
      return "declined";
    case "person-says-done":
      return "person-says-done";
    case "done-by-person":
      return "done-by-person";
    default:
      return "closed";
  }
}

/** The card for a command Request, or null for any other Request. */
export function commandRequestView(
  request: Pick<Request, "id" | "status" | "command"> & {
    readonly response?: Request["response"] | undefined;
    readonly reviewedRevision?: string | undefined;
  },
): CommandRequestView | null {
  const part = request.command;
  if (!part) return null;
  const state = stateOf(request);
  const pending = state === "pending";
  const personOnly =
    part.secretPaths.length > 0
      ? {
          needs: part.secretPaths
            .map((path) => path.split(".").map(commandFieldLabel).join(" › "))
            .join(", "),
          screen: part.editor
            ? {
                id: part.editor.screen,
                label: screenLabels[part.editor.screen] ?? commandFieldLabel(part.editor.screen),
              }
            : null,
        }
      : null;
  return {
    requestId: request.id,
    identity: `${request.id}:${request.reviewedRevision ?? ""}`,
    sentence: outsideProse(part.sentence ?? part.summary).replace(/\n/gu, " "),
    askedBy: askedBy(part.proposer),
    gives: part.gives === null ? null : outsideProse(part.gives).replace(/\n/gu, " "),
    agentWords: part.agentReason
      ? {
          label: `${capital(who(part.proposer))} says (its own words, not checked by the Home)`,
          text: outsideProse(part.agentReason),
        }
      : null,
    rowsHeading: `Proposed by ${who(part.proposer)} “${outsideName(part.proposer.name)}”, exactly as it would run`,
    rows: commandReviewRows(part.command, part.notes ?? []).map((row) => ({
      ...row,
      meaning: meaningOf(row.path, row.value),
    })),
    personOnly,
    state,
    line:
      pending && personOnly
        ? personOnly.screen
          ? commandRequestWords.personOnly
          : commandRequestWords.noScreen
        : commandRequestWords[state],
    approve: pending && !personOnly ? { label: commandRequestWords.approve } : null,
    doneMyself: pending && personOnly?.screen ? { label: commandRequestWords.doneMyself } : null,
    decline: pending ? { label: commandRequestWords.decline } : null,
  };
}

/**
 * The approval's own key, one per Request and reviewed revision: an approval sent again after a
 * lost answer, even from a card shown again, is the same approval and reads back its outcome.
 */
export function commandApprovalKey(request: Pick<RequestView, "id" | "reviewedRevision">): string {
  return `command-approve:${request.id}:${request.reviewedRevision ?? ""}`;
}

/**
 * The person's approval: the Request and the revision they reviewed. The Home runs the proposal
 * it stored, exactly; it refuses any that carries a value only the person types.
 */
export function commandApproval(request: Pick<RequestView, "id" | "reviewedRevision" | "command">) {
  if (!request.command) throw new Error("Not a command Request.");
  return {
    type: "request.command.approve" as const,
    ...requestDecision(request),
    idempotencyKey: commandApprovalKey(request),
  };
}

function answer(
  request: Pick<RequestView, "id" | "reviewedRevision">,
  idempotencyKey: string,
  value: string,
) {
  return {
    type: "request.respond" as const,
    ...requestDecision(request),
    idempotencyKey,
    response: { kind: "form" as const, answers: { [commandRequestAnswers.field]: [value] } },
  };
}

/** The person's decline: any answer to a command Request declines it, as it always has. */
export function commandDecline(
  request: Pick<RequestView, "id" | "reviewedRevision">,
  idempotencyKey: string,
) {
  return answer(request, idempotencyKey, commandRequestAnswers.decline);
}

/** The person says they did it themselves on its own screen: the proposal itself never runs. */
export function commandDoneMyself(
  request: Pick<RequestView, "id" | "reviewedRevision">,
  idempotencyKey: string,
) {
  return answer(request, idempotencyKey, commandRequestAnswers.doneMyself);
}
