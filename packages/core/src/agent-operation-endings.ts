import { z } from "zod";

/**
 * Why a connected agent's operation ended without a confirmed outcome, where the Home knows it.
 * The record carries the cause; the agent's result and the person's activity both read it, each
 * in its own words. A refusal keeps its decision and can also carry the cause that stopped it
 * before anything was sent.
 */
export const AgentOperationEndingSchema = z.enum([
  /** The person stopped the task. */
  "stopped",
  /** The person disconnected the agent. */
  "disconnected",
  /** The agent's access expired. */
  "expired",
  /** The person changed the agent's access or lowered the task's mode. */
  "narrowed",
  /** The person closed the tab the work was using. */
  "tab-closed",
  /** Nothing answered: the Home cannot say why. */
  "contact-lost",
]);
export type AgentOperationEnding = z.infer<typeof AgentOperationEndingSchema>;

const mayHaveHappened =
  "Part of it may have happened. Check the current state before doing anything else.";

/**
 * What the agent reads when its operation ended this way: the cause (`message`), then what to do
 * (`next`). One source: every path that ends work for one of these causes uses these words.
 */
export const agentOperationEndingWords: Readonly<
  Record<AgentOperationEnding, { readonly message: string; readonly next: string }>
> = {
  stopped: { message: "The person stopped this work.", next: mayHaveHappened },
  disconnected: { message: "The person disconnected this agent.", next: mayHaveHappened },
  expired: { message: "This agent's access expired.", next: mayHaveHappened },
  narrowed: { message: "The person changed this agent's access.", next: mayHaveHappened },
  "tab-closed": {
    message: "The person closed this tab while the command ran; whether it took effect is unknown.",
    next: "Open the page again if you still need it.",
  },
  "contact-lost": {
    message: "The Home lost track of whether this took effect.",
    next: "Check the current state before doing anything else; never repeat it blindly.",
  },
};

/** The agent's one sentence for work that ended this way with its outcome unknown. */
export function agentOperationEndingSentence(ending: AgentOperationEnding): string {
  const { message, next } = agentOperationEndingWords[ending];
  return `${message} ${next}`;
}

/** The ending an unknown outcome's own words name, when they are one of the sentences above. */
export function agentOperationEndingOf(words: string | undefined): AgentOperationEnding | null {
  if (!words) return null;
  for (const ending of AgentOperationEndingSchema.options)
    if (words === agentOperationEndingSentence(ending)) return ending;
  return null;
}

/**
 * What happened to a connected agent's access while a call of its session was open, as the Home
 * read it from the connection: the person disconnected it, it expired, it ended otherwise, or it
 * still stands with its grant or mode changed (narrowed, widened, raised or lowered).
 */
export type AgentAccessChange = "disconnected" | "expired" | "ended" | "changed";

/** The Home's words for a call answered after its session's access changed: no content. */
export const agentAccessChangeWords: Readonly<
  Record<AgentAccessChange, { readonly message: string; readonly next: string | null }>
> = {
  disconnected: { message: "The person disconnected this agent.", next: null },
  expired: { message: "This agent's access expired.", next: null },
  ended: { message: "This connected agent's access ended.", next: null },
  changed: {
    message: "The person changed this agent's access.",
    next: "Call again; it now answers under the changed access.",
  },
};

/**
 * The receipt's words for an operation that ended while its session's access changed, whose
 * content is withheld: what became of it, and that it must not be repeated blindly.
 */
export function agentWithheldNext(
  status: "completed" | "failed",
  change: AgentAccessChange,
): string {
  const why = change === "changed" ? "changed" : "ended";
  return status === "completed"
    ? `It completed. Its result was withheld because this agent's access ${why}. Do not repeat it.`
    : `It failed. Its details were withheld because this agent's access ${why}. Check the current state before trying again.`;
}
