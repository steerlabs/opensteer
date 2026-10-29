import { requestAgentProposedDetail, requestAgentProposedLabel } from "@opensteer/core";

/**
 * The mark beside an agent-proposed integration's name wherever it is listed
 * or chosen. An agent can give its proposal any name, so the name alone never
 * says which integration this is.
 */
export function AgentProposedChip({ className }: { readonly className?: string }) {
  return (
    <span className={className ? `chip ${className}` : "chip"} title={requestAgentProposedDetail}>
      {requestAgentProposedLabel}
    </span>
  );
}
