import type { CommandRequestPart, Request } from "@opensteer/core";
import {
  commandFieldLabel,
  commandReviewRows,
  type CommandReviewRow,
} from "@opensteer/protocol/command-review";
import { requestDecision, type RequestView } from "./client.js";

/**
 * A Home command an agent proposed, as the person reviews it on any client: the Home's sentence,
 * who asked, the agent's own words kept apart, and the change itself, every argument whole.
 * Web and the phone both show this, so neither can show a proposal differently.
 */

export type CommandRequestState =
  "pending" | "running" | "done" | "refused" | "unknown" | "declined" | "closed";

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
  /** Every argument of the command, in order; a heading has no value. */
  readonly rows: readonly CommandReviewRow[];
  /** Values only the person types before approving: one input each. */
  readonly secrets: readonly { readonly path: string; readonly label: string }[];
  readonly state: CommandRequestState;
  /** What the two buttons do while it waits; what became of it after. */
  readonly line: string;
  readonly approve: { readonly label: string } | null;
  readonly decline: { readonly label: string } | null;
}

export const commandRequestWords = {
  approve: "Approve",
  decline: "Decline",
  pending: "Approve runs it as you, exactly as shown. Decline tells the agent no.",
  running: "Approved. It is running now.",
  done: "Approved and done.",
  refused: "Approved, but the Home refused it, so nothing changed.",
  unknown:
    "Approved, but the Home cannot tell whether it happened. It will not run it again; check before you ask for it again.",
  declined: "Declined. The agent was told no.",
  closed: "This ask closed before it was answered, so nothing changed.",
  now: "Now",
  secret: "Only you type this",
} as const;

function askedBy(proposer: CommandRequestPart["proposer"]): string {
  const who =
    proposer.kind === "connection"
      ? `the connected agent “${proposer.name}”`
      : proposer.kind === "program"
        ? `the automation “${proposer.name}”`
        : `the agent “${proposer.name}”`;
  return proposer.taskTitle
    ? `Asked by ${who}, in its task “${proposer.taskTitle}”`
    : `Asked by ${who}`;
}

function agentWordsLabel(proposer: CommandRequestPart["proposer"]): string {
  const who =
    proposer.kind === "connection"
      ? "The connected agent"
      : proposer.kind === "program"
        ? "The automation"
        : "The agent";
  return `${who} says (its own words, not checked by the Home)`;
}

function stateOf(request: Pick<Request, "status" | "command">): CommandRequestState {
  if (request.status === "pending") return "pending";
  if (request.status === "declined") return "declined";
  if (request.status !== "fulfilled") return "closed";
  const outcome = request.command?.outcome;
  if (!outcome || outcome.status === "running") return "running";
  if (outcome.status === "done") return "done";
  if (outcome.status === "failed") return "refused";
  return "unknown";
}

/** The card for a command Request, or null for any other Request. */
export function commandRequestView(
  request: Pick<Request, "id" | "status" | "command">,
): CommandRequestView | null {
  const part = request.command;
  if (!part) return null;
  const state = stateOf(request);
  const outcome = part.outcome;
  return {
    requestId: request.id,
    sentence: part.sentence ?? part.summary,
    askedBy: askedBy(part.proposer),
    gives: part.gives,
    agentWords: part.agentReason
      ? { label: agentWordsLabel(part.proposer), text: part.agentReason }
      : null,
    rows: commandReviewRows(part.command, part.notes ?? []),
    secrets: part.secretPaths.map((path) => ({
      path,
      label: path.split(".").map(commandFieldLabel).join(" › "),
    })),
    state,
    line:
      state === "refused" && outcome?.status === "failed"
        ? `${commandRequestWords.refused} ${outcome.message}`.trim()
        : commandRequestWords[state],
    approve: state === "pending" ? { label: commandRequestWords.approve } : null,
    decline: state === "pending" ? { label: commandRequestWords.decline } : null,
  };
}

/**
 * The person's approval: the command exactly as proposed, with what only they type set at its
 * paths, for the Request revision they reviewed. The Home refuses it if the Request changed.
 */
export function commandApproval(
  request: Pick<RequestView, "id" | "reviewedRevision" | "command">,
  idempotencyKey: string,
  typed: Readonly<Record<string, string>> = {},
) {
  const part = request.command;
  if (!part) throw new Error("Not a command Request.");
  const command = structuredClone(part.command) as Record<string, unknown>;
  for (const path of part.secretPaths) {
    const value = typed[path];
    if (value === undefined) continue;
    const keys = path.split(".");
    let at = command;
    for (const key of keys.slice(0, -1)) {
      const next = at[key];
      at[key] = next !== null && typeof next === "object" ? next : {};
      at = at[key] as Record<string, unknown>;
    }
    at[keys.at(-1)!] = value;
  }
  return {
    type: "request.command.approve" as const,
    ...requestDecision(request),
    idempotencyKey,
    command,
  };
}

/** The person's decline: any answer to a command Request declines it, as it always has. */
export function commandDecline(
  request: Pick<RequestView, "id" | "reviewedRevision">,
  idempotencyKey: string,
) {
  return {
    type: "request.respond" as const,
    ...requestDecision(request),
    idempotencyKey,
    response: { kind: "form" as const, answers: { decision: ["decline"] } },
  };
}
