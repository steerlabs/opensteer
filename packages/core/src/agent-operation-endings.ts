import { z } from "zod";

/**
 * Why a connected agent's operation ended without a confirmed outcome, where the Home knows it.
 * The record carries the cause; the agent's result and the person's activity both read it, each
 * in its own words, and "lost contact" is said only when contact was lost. A refusal's cause is
 * its decision (`AgentOperationDecision`), not one of these.
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
