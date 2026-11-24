import { commandRequestAnswers, type CommandRequestPart, type Request } from "@opensteer/core";
import {
  commandFieldLabel,
  commandReviewRows,
  outsideName,
  visibleText,
  type CommandReviewRow,
} from "@opensteer/protocol/command-review";
import { requestDecision, type RequestView } from "./client.js";

/**
 * A Home command an agent proposed, as the person reviews it on any client: the Home's sentence,
 * who asked, the agent's own words kept apart, and the change itself, every argument whole, each
 * string from outside the Home cleaned so what is shown is what is there. Web and the phone both
 * show this, so neither can show a proposal differently.
 */

export type CommandRequestState =
  "pending" | "running" | "done" | "refused" | "unknown" | "declined" | "done-myself" | "closed";

/**
 * How long Approve stays inert after a card, or a new revision of one, appears: longer than a
 * double click and a tap timed to land as a card swaps in, short enough not to be felt.
 */
export const commandApproveArmMs = 1_000;

export interface CommandRequestView {
  readonly requestId: string;
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
  readonly rows: readonly CommandReviewRow[];
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
  running: "Approved. It is running now.",
  done: "Approved and done.",
  refused: "Approved, but the Home refused it, so nothing changed.",
  unknown:
    "Approved, but the Home cannot tell whether it happened. It will not run it again; check it before it is done again.",
  declined: "Declined. The agent was told no.",
  "done-myself": "You did it yourself. The agent was told, and its proposal did not run.",
  closed: "This ask closed before it was answered, so nothing changed.",
  now: "Now",
  more: "More below. Scroll to the end to approve.",
} as const;

/** The screens that perform a command, by the Home's name for each. */
const screenLabels: Readonly<Record<string, string>> = {
  "account-link": "Account",
  "add-device": "Devices",
  "ai-engines": "AI engines",
  automation: "Automations",
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
  if (request.status === "pending") return "pending";
  if (request.status === "declined")
    return request.response?.kind === "form" &&
      Object.values(request.response.answers).flat().includes(commandRequestAnswers.doneMyself)
      ? "done-myself"
      : "declined";
  if (request.status !== "fulfilled") return "closed";
  const outcome = request.command?.outcome;
  if (!outcome || outcome.status === "running") return "running";
  if (outcome.status === "done") return "done";
  if (outcome.status === "failed") return "refused";
  return "unknown";
}

/** The card for a command Request, or null for any other Request. */
export function commandRequestView(
  request: Pick<Request, "id" | "status" | "command"> & {
    readonly response?: Request["response"] | undefined;
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
    sentence: visibleText(part.sentence ?? part.summary, "one"),
    askedBy: askedBy(part.proposer),
    gives: part.gives === null ? null : visibleText(part.gives, "one"),
    agentWords: part.agentReason
      ? {
          label: `${capital(who(part.proposer))} says (its own words, not checked by the Home)`,
          text: visibleText(part.agentReason),
        }
      : null,
    rowsHeading: `Proposed by ${who(part.proposer)} “${outsideName(part.proposer.name)}”, exactly as it would run`,
    rows: commandReviewRows(part.command, part.notes ?? []).map((row) => ({
      ...row,
      value: row.value === null ? null : visibleText(row.value),
      name: row.name === null ? null : visibleText(row.name, "one"),
      current: row.current === null ? null : visibleText(row.current),
    })),
    personOnly,
    state,
    line: pending && personOnly ? commandRequestWords.personOnly : commandRequestWords[state],
    approve: pending && !personOnly ? { label: commandRequestWords.approve } : null,
    doneMyself: pending && personOnly ? { label: commandRequestWords.doneMyself } : null,
    decline: pending ? { label: commandRequestWords.decline } : null,
  };
}

/**
 * The person's approval: the command exactly as proposed, for the Request revision they reviewed.
 * The Home refuses anything else, and any command that carries a value only the person types.
 */
export function commandApproval(
  request: Pick<RequestView, "id" | "reviewedRevision" | "command">,
  idempotencyKey: string,
) {
  const part = request.command;
  if (!part) throw new Error("Not a command Request.");
  return {
    type: "request.command.approve" as const,
    ...requestDecision(request),
    idempotencyKey,
    command: structuredClone(part.command) as Record<string, unknown>,
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

/** The person did it themselves on its own screen: the proposal itself never runs. */
export function commandDoneMyself(
  request: Pick<RequestView, "id" | "reviewedRevision">,
  idempotencyKey: string,
) {
  return answer(request, idempotencyKey, commandRequestAnswers.doneMyself);
}
