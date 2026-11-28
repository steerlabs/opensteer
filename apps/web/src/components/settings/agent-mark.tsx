import type { ConnectedAgentIdentity } from "@opensteer/client/host";
import { ProviderLogo } from "../provider-brand.js";

/**
 * A connected agent's mark: its provider's logo when the Home proved the agent's
 * origin belongs to that provider, its initial otherwise. Never chosen by the name.
 */
export function AgentMark({
  identity,
  large = false,
}: {
  readonly identity: Pick<ConnectedAgentIdentity, "initial" | "providerId">;
  readonly large?: boolean;
}) {
  return (
    <span aria-hidden className={`card__row-glyph agent-mark${large ? " agent-mark--large" : ""}`}>
      {identity.providerId ? <ProviderLogo providerId={identity.providerId} /> : identity.initial}
    </span>
  );
}
