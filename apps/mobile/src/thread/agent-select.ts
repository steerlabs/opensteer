import { conversationSubagents, type AgentRoster, type HostSnapshot } from "@opensteer/client/host";

/** What the subagent model reads of the Host; nothing else moves a card. */
function readerInputs(snapshot: HostSnapshot): readonly unknown[] {
  return [
    snapshot.assignments,
    snapshot.connection,
    snapshot.environments,
    snapshot.homeThreadId,
    snapshot.network,
    snapshot.requests,
    snapshot.threads,
    snapshot.transcripts,
    snapshot.waitingRequests,
  ];
}

/**
 * A selector that rebuilds only when what the subagent model reads has
 * changed, so a snapshot published for anything else costs a comparison.
 */
export function heldSelector<T>(
  build: (snapshot: HostSnapshot) => T,
): (snapshot: HostSnapshot) => T {
  let held: { readonly inputs: readonly unknown[]; readonly value: T } | null = null;
  return (snapshot) => {
    const inputs = readerInputs(snapshot);
    if (held !== null && inputs.every((input, index) => input === held?.inputs[index]))
      return held.value;
    const value = build(snapshot);
    held = { inputs, value };
    return value;
  };
}

/** Structural equality for the model's plain data, so an unchanged card never redraws. */
export function samePlain(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) =>
    samePlain((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

/**
 * The pill's counts alone, so nothing else a helper does redraws the dock. It
 * counts what the Agents page it opens lists.
 */
export function agentsPillSelector(
  threadId: string,
): (snapshot: HostSnapshot) => AgentRoster["pill"] {
  return heldSelector(
    (snapshot) => conversationSubagents(snapshot, threadId, { tasks: false }).pill,
  );
}

/**
 * The roster as Around shows it: its tasks already have their own tiles and
 * marks there, so the Agents page and the header's agents part count the
 * engines' subagents and workflows alone.
 */
export function aroundAgentsSelector(threadId: string): (snapshot: HostSnapshot) => AgentRoster {
  return heldSelector((snapshot) => conversationSubagents(snapshot, threadId, { tasks: false }));
}
