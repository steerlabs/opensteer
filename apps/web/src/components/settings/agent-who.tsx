import { agentWhoName, agentWhoOriginLine, agentWithdrawnLine, workWords, type AgentWho } from "@opensteer/client/host";
import { Icon } from "../icon.js";

/**
 * Who a connected agent is, as far as the Home could prove: a verified name with its
 * origin, or a name it gave itself, marked as such, with where it returns to. A verified
 * identity the Home stopped vouching for shows only its name here; its notice says since when.
 */
export function AgentWhoLine({ who, claim }: { readonly who: AgentWho; readonly claim?: string | undefined }) {
  // A withdrawn verification is said once, where Disconnect is offered: here only its name.
  return (
    <p className={`agent-who${who.verified ? " agent-who--verified" : ""}`}>
      <Icon
        className="agent-who__icon"
        name={who.verified ? "check-circle" : who.local ? "laptop" : "globe"}
      />
      <span className="agent-who__text">
        <span className={claim ? "agent-who__name agent-who__claim" : "agent-who__name"}>
          {claim ?? agentWhoName(who)}
        </span>
        {who.origins.length ? who.origins.map((origin) => (
          <span className="agent-who__detail" key={origin.role}>{agentWhoOriginLine(origin)}</span>
        )) : <span className="agent-who__detail">{who.detail}</span>}
      </span>
    </p>
  );
}

/** On a connection whose verification was withdrawn: what that means, and Disconnect. */
export function AgentWithdrawnNotice({
  onDisconnect,
  who,
}: {
  readonly onDisconnect: (() => void) | null;
  readonly who: AgentWho;
}) {
  const line = agentWithdrawnLine(who);
  if (!line) return null;
  return (
    <div className="notice notice--warning agent-who__notice" role="status">
      <p className="agent-who__notice-title">{line}</p>
      <p>{workWords("who.withdrawnDetail")}</p>
      {onDisconnect ? (
        <button className="btn btn--small" onClick={onDisconnect} type="button">
          {workWords("who.disconnect")}
        </button>
      ) : null}
    </div>
  );
}
