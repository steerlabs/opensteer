import { useRef, useState } from "react";
import { Link } from "react-router";
import {
  arrivedConnection,
  connectionDetail,
  externalAgentAddresses,
  externalAgentGuides,
  externalAgentsLead,
  externalAgentsReach,
  guideAddress,
  type ExternalAgentGuide,
  type ExternalAgentsReach,
  type HostClient,
} from "@opensteer/client/host";
import { useConnectedAgents, usePersonalRemoteAccess } from "@opensteer/client/react";
import type { AgentConnection } from "@opensteer/protocol";
import { useShell } from "../../app-shell.js";
import { copyText } from "../../copy-mark.js";
import { Dialog } from "../../dialog.js";
import { Icon } from "../../icon.js";
import { ProviderLogo } from "../../provider-brand.js";
import {
  SectionHeader,
  SettingsError,
  SettingsGroup,
  SettingsRow,
  type SettingsView,
} from "../primitives.js";

const remoteAccessPath = "/settings/account/remote-access";
const notReading = { status: null, error: null } as const;

export function ExternalAgentsSection({
  client,
  view,
}: {
  readonly client: HostClient;
  readonly view: SettingsView;
}) {
  const shell = useShell();
  const agents = useConnectedAgents(client);
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
  const workspaces = shell.snapshot.workspaces;
  const connections = agents.connections ?? [];
  // Setup takes its baseline from the loaded list, so it waits for the first read.
  const available = (entry: ExternalAgentGuide) =>
    agents.connections !== null &&
    (reach.kind === "ready" || (entry.providerId === null && thisComputer !== null));
  return (
    <>
      <SectionHeader title="External agents" lead={externalAgentsLead} />
      {agents.connections === null && agents.error ? (
        <div className="card">
          <SettingsRow
            icon="sparkles"
            title="Your agents couldn’t be loaded"
            detail={agents.error}
            action={
              <button
                className="btn btn--small"
                onClick={() => void agents.refresh?.()}
                type="button"
              >
                Try again
              </button>
            }
          />
        </div>
      ) : null}
      {connections.length > 0 ? (
        <SettingsGroup heading="Connected" headingId="external-agents-connected">
          {connections.map((connection) => (
            <SettingsRow
              key={connection.id}
              icon="sparkles"
              title={connection.label}
              detail={connectionDetail(connection, workspaces)}
              action={
                <button
                  aria-label={`Remove ${connection.label}`}
                  className="btn btn--small"
                  disabled={agents.pending !== null}
                  onClick={() => void agents.revoke?.(connection.id)}
                  type="button"
                >
                  {agents.pending === connection.id ? "Removing…" : "Remove"}
                </button>
              }
            />
          ))}
        </SettingsGroup>
      ) : null}
      <SettingsGroup
        heading="Add an agent"
        headingId="external-agents-add"
        note={
          reach.kind === "ready" && reach.personal
            ? "Agents reach Opensteer through Remote access while this computer is on and awake."
            : null
        }
      >
        {reach.kind === "needs-remote" ? (
          <SettingsRow
            icon="globe"
            title="Turn on Remote access first"
            detail="These agents run in the cloud and reach Opensteer through it."
            action={
              view.administrator ? (
                <Link className="btn btn--small btn--primary" to={remoteAccessPath}>
                  Turn on
                </Link>
              ) : null
            }
          />
        ) : null}
        {externalAgentGuides.map((entry) => (
          <SettingsRow
            key={entry.id}
            icon={entry.providerId ? <ProviderLogo providerId={entry.providerId} /> : "plus"}
            title={entry.name}
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
      <SettingsError
        message={
          (agents.connections === null ? null : agents.error) ??
          (reach.kind === "unavailable" ? reach.detail : null)
        }
      />
      {guide && available(guide) ? (
        <ExternalAgentSetup
          connections={agents.connections}
          guide={guide}
          onClose={() => setGuide(null)}
          reach={reach}
          thisComputer={guide.providerId === null ? thisComputer : null}
        />
      ) : null}
    </>
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
            {address.detail} <Link to={remoteAccessPath}>Open Remote access</Link>
          </span>
        </p>
      ) : (
        <>
          <ol className="add-computer__steps">
            <li>
              Copy this address.
              {address ? (
                <AddressBlock
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
                <AddressBlock label="From an app on this computer" value={thisComputer} />
              ) : null}
            </li>
            <li>{guide.step}</li>
            <li>Approve the request in Opensteer when {guide.name} asks.</li>
          </ol>
          <p className="external-agent-setup__status" role="status">
            {connected ? (
              <>
                <Icon name="check-circle" /> {connected.label} is connected.
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

function AddressBlock({ label, value }: { readonly label: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="computers-copy-block external-agent-setup__address">
      <div>
        <strong>{label}</strong>
        <button
          className="btn btn--ghost btn--small"
          onClick={() =>
            void copyText(value).then(
              () => setCopied(true),
              () => setFailed(true),
            )
          }
          type="button"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <code>{value}</code>
      {failed ? (
        <small className="field__hint">Copy was blocked. Select the address to copy it.</small>
      ) : null}
    </div>
  );
}
