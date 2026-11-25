import { useEffect, useRef, useState } from "react";
import { Link, Route, Routes, useParams } from "react-router";
import {
  agentSentence,
  agentText,
  agentWords,
  arrivedConnection,
  chatScreenHost,
  connectedAgentsView,
  externalAgentAddresses,
  externalAgentGuides,
  externalAgentsReach,
  guideAddress,
  type ConnectedAgentRow,
  type ConnectedAgentNow,
  type ExternalAgentGuide,
  type ExternalAgentsReach,
  type HostClient,
} from "@opensteer/client/host";
import { useConnectedAgents, usePersonalRemoteAccess } from "@opensteer/client/react";
import type { AgentConnection } from "@opensteer/protocol";
import { ReadGate } from "../../read-gate.js";
import { useShell } from "../../app-shell.js";
import { CopyBlock } from "../../copy-block.js";
import { Dialog } from "../../dialog.js";
import { Icon } from "../../icon.js";
import { ProviderLogo } from "../../provider-brand.js";
import {
  SectionHeader,
  SettingsError,
  SettingsGroup,
  SettingsRow,
  SettingsUnreadable,
  type SettingsView,
} from "../primitives.js";
import { SentenceText } from "../../../ui/address-text.js";
import { AgentMark } from "../agent-mark.js";
import { ConnectedAgentPage } from "./connected-agent-page.js";
import { useActiveConnectedAgentSessions } from "../../use-connected-agent-sessions.js";

const remoteAccessPath = "/settings/account";
const notReading = { status: null, error: null } as const;

export function ExternalAgentsSection({
  client,
  view,
}: {
  readonly client: HostClient;
  readonly view: SettingsView;
}) {
  return (
    <Routes>
      <Route index element={<ConnectedAgentsList client={client} view={view} />} />
      <Route path=":connectionId" element={<ConnectedAgentRoute client={client} />} />
    </Routes>
  );
}

function ConnectedAgentRoute({ client }: { readonly client: HostClient }) {
  const { connectionId } = useParams();
  return <ConnectedAgentPage client={client} connectionId={connectionId ?? ""} />;
}

function ConnectedAgentsList({
  client,
  view,
}: {
  readonly client: HostClient;
  readonly view: SettingsView;
}) {
  const shell = useShell();
  const agents = useConnectedAgents(client);
  const chatHost = chatScreenHost(client);
  const { view: active } = useActiveConnectedAgentSessions(chatHost);
  const work = new Map<string, ConnectedAgentNow["state"]>();
  for (const entry of active.agents) {
    if (!work.has(entry.connectionId)) work.set(entry.connectionId, entry.state);
  }
  const identity = shell.snapshot.identityConfig;
  const personal = identity?.exposure === "loopback";
  const remote = usePersonalRemoteAccess(personal ? client : null);
  const reach = externalAgentsReach({ identity, remote: personal ? remote : notReading });
  // A loopback address is only reachable from the computer the Host runs on.
  const thisComputer =
    identity && personal && !view.facts.remote
      ? externalAgentAddresses({ identity, remoteAccess: null }).thisComputer
      : null;
  const [guide, setGuide] = useState<ExternalAgentGuide | null>(null);
  const names = { profiles: shell.snapshot.browserProfiles };
  const list = connectedAgentsView(agents.connections ?? [], names, agents.revoked);
  // Setup takes its baseline from the loaded list, so it waits for the first read.
  // A list read before whose refresh failed changes nothing until it is read again (`ReadGate`):
  // no setup starts against it, and one open closes.
  const readFailed = agents.readFailed && agents.connections !== null;
  useEffect(() => {
    if (readFailed) setGuide(null);
  }, [readFailed]);
  const available = (entry: ExternalAgentGuide) =>
    agents.connections !== null &&
    !readFailed &&
    (reach.kind === "ready" || (entry.reach === "any" && thisComputer !== null));
  return (
    <>
      <SectionHeader title={agentWords("agents.settings.label")} lead={agentWords("agents.lead")} />
      {agents.connections === null && agents.error ? (
        <SettingsUnreadable label="your connected agents" onRetry={() => void agents.refresh?.()} />
      ) : null}
      <ReadGate
        failed={readFailed}
        message={agentWords("agent.readFailed")}
        onRetry={() => void agents.refresh?.()}
      >
        {list.connected.length > 0 ? (
          <AgentRows
            heading={list.disconnected.length > 0 ? agentWords("agents.section.connected") : null}
            id="connected-agents-active"
            rows={list.connected}
            work={work}
          />
        ) : null}
        {list.disconnected.length > 0 ? (
          <AgentRows
            heading={agentWords("agents.section.disconnected")}
            id="connected-agents-ended"
            rows={list.disconnected}
          />
        ) : null}
        <SettingsGroup
          heading={agentWords("agents.section.add")}
          headingId="external-agents-add"
          note={
            reach.kind === "ready" && reach.personal
              ? agentWords("agents.reachNote", { home: view.name })
              : null
          }
        >
          {reach.kind === "needs-remote" ? (
            <SettingsRow
              title={agentWords("remoteAccess.turnOnFirst.title")}
              detail={agentWords("remoteAccess.turnOnFirst.detail")}
              action={
                <Link className="btn btn--small btn--primary" to={remoteAccessPath}>
                  {agentWords("remoteAccess.turnOnFirst.action")}
                </Link>
              }
            />
          ) : null}
          {externalAgentGuides.map((entry) => (
            <SettingsRow
              key={entry.id}
              title={
                <>
                  {entry.providerId ? <ProviderLogo providerId={entry.providerId} /> : null}
                  {entry.name}
                </>
              }
              detail={entry.summary}
              action={
                <button
                  aria-label={`Add ${entry.name}`}
                  className="btn btn--small"
                  disabled={!available(entry)}
                  onClick={() => setGuide(entry)}
                  type="button"
                >
                  Add
                </button>
              }
            />
          ))}
        </SettingsGroup>
      </ReadGate>
      <SettingsError
        message={
          (agents.connections === null || readFailed ? null : agents.error) ??
          (reach.kind === "unavailable" ? reach.detail : null)
        }
      />
      {guide && available(guide) ? (
        <ExternalAgentSetup
          connections={agents.connections}
          guide={guide}
          onClose={() => setGuide(null)}
          reach={reach}
          thisComputer={guide.reach === "any" ? thisComputer : null}
        />
      ) : null}
    </>
  );
}

function AgentRows({
  heading,
  id,
  rows,
  work,
}: {
  readonly heading: string | null;
  readonly id: string;
  readonly rows: readonly ConnectedAgentRow[];
  readonly work?: ReadonlyMap<string, ConnectedAgentNow["state"]>;
}) {
  return (
    <section aria-labelledby={heading ? id : undefined} className="settings-group">
      {heading ? (
        <h2 className="settings-group__title" id={id}>
          {heading}
        </h2>
      ) : null}
      <ul className="card connected-agents__list">
        {rows.map((row) => {
          const state = work?.get(row.id);
          return (
            <li key={row.id}>
              <Link className="card__row connected-agents__row" to={row.id}>
                <AgentMark identity={row.identity} />
                <span className="card__row-body">
                  <span className="card__row-title">{row.identity.label}</span>
                  <span className={`card__row-detail connected-agents__line--${row.tone}`}>
                    <SentenceText parts={row.lineParts} />
                  </span>
                </span>
                {state ? (
                  <span
                    className={`chip chip--${state === "needs-you" ? "warn" : "ok"} connected-agents__work`}
                  >
                    {state === "needs-you" ? agentWords("agent.status.needsYou") : "Working"}
                  </span>
                ) : null}
                <Icon className="connected-agents__chevron" name="chevron-right" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The address to add, the one step inside the agent, and the approval after
 * it. The only live state is the end: a connection approved while this is
 * open, which `host.connections-changed` already delivers to every device.
 */
function ExternalAgentSetup({
  connections,
  guide,
  onClose,
  reach,
  thisComputer,
}: {
  readonly connections: readonly AgentConnection[] | null;
  readonly guide: ExternalAgentGuide;
  readonly onClose: () => void;
  readonly reach: ExternalAgentsReach;
  readonly thisComputer: string | null;
}) {
  const baseline = useRef<ReadonlySet<string> | null>(null);
  if (baseline.current === null && connections)
    baseline.current = new Set(connections.map(({ id }) => id));
  const connected = arrivedConnection(connections, baseline.current);
  const address = reach.kind === "ready" ? guideAddress(guide, reach) : null;
  return (
    <Dialog
      title={`Add ${guide.name}`}
      onClose={onClose}
      footer={
        <button className={connected ? "btn btn--primary" : "btn"} onClick={onClose} type="button">
          {connected ? "Done" : "Close"}
        </button>
      }
    >
      {address?.kind === "blocked" ? (
        <p className="notice">
          <span>
            {address.detail} <Link to={remoteAccessPath}>Open Account settings</Link>
          </span>
        </p>
      ) : (
        <>
          <ol className="add-computer__steps">
            <li>
              Copy this address.
              {address ? (
                <CopyBlock
                  className="external-agent-setup__address"
                  label={
                    !thisComputer
                      ? "Address"
                      : reach.kind === "ready" && reach.reach === "private-network"
                        ? "On your private network"
                        : "From anywhere"
                  }
                  value={address.url}
                />
              ) : null}
              {thisComputer ? (
                <CopyBlock
                  className="external-agent-setup__address"
                  label="From an app on this computer"
                  value={thisComputer}
                />
              ) : null}
            </li>
            <li>{guide.step}</li>
            <li>{agentText("agents.add.step3", { name: guide.name })}</li>
          </ol>
          <p className="external-agent-setup__status" role="status">
            {connected ? (
              <>
                <Icon name="check-circle" />{" "}
                <SentenceText
                  parts={agentSentence("agents.add.connected", {
                    agent: { name: connected.label },
                  })}
                />
              </>
            ) : (
              `Waiting for ${guide.name} to connect.`
            )}
          </p>
        </>
      )}
    </Dialog>
  );
}
