import { useRef, useState } from "react";
import { Link } from "react-router";
import type { HostClient } from "@opensteer/client/host";
import {
  connectionAccessLabel,
  connectionReachLabel,
  externalAgentAddresses,
  externalAgentGuides,
  type ExternalAgentAddresses,
  type ExternalAgentGuide,
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
  formatWhen,
  type SettingsView,
} from "../primitives.js";

const remoteAccessPath = "/settings/account/remote-access";

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
  const access = remote.status?.access ?? null;
  const addresses =
    identity && (!personal || access)
      ? externalAgentAddresses({
          identity,
          remoteAccess: access && {
            mode: access.mode,
            origin: access.route?.document.route.origin ?? null,
          },
        })
      : null;
  // A loopback address is only reachable from the computer the Host runs on.
  const thisComputer = personal && !view.facts.remote ? (addresses?.thisComputer ?? null) : null;
  const [guide, setGuide] = useState<ExternalAgentGuide | null>(null);
  const workspaces = shell.snapshot.workspaces;
  const connections = agents.connections ?? [];
  return (
    <>
      <SectionHeader
        title="External agents"
        lead="Let ChatGPT, Claude and other agents use Opensteer to get things done. You approve each one."
      />
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
          personal && addresses?.remote
            ? "Agents reach Opensteer through Remote access while this computer is on and awake."
            : null
        }
      >
        {personal && addresses && !addresses.remote ? (
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
                disabled={
                  !addresses || (!addresses.remote && !(entry.id === "other" && thisComputer))
                }
                onClick={() => setGuide(entry)}
                type="button"
              >
                Add
              </button>
            }
          />
        ))}
      </SettingsGroup>
      <SettingsError message={agents.error ?? remote.error} />
      {guide && addresses ? (
        <ExternalAgentSetup
          addresses={addresses}
          connections={agents.connections}
          guide={guide}
          onClose={() => setGuide(null)}
          thisComputer={thisComputer}
        />
      ) : null}
    </>
  );
}

function connectionDetail(
  connection: AgentConnection,
  workspaces: readonly { id: string; name: string }[],
): string {
  const used = connection.lastUsedAt
    ? `Used ${formatWhen(connection.lastUsedAt)}.`
    : "Not used yet.";
  return `${connectionAccessLabel(connection.accessMode)}, in ${connectionReachLabel(connection, workspaces)}. ${used} Expires ${formatWhen(connection.expiresAt)}.`;
}

/**
 * The address to add, the one step inside the agent, and the approval after
 * it. The only live state is the end: a connection approved while this is
 * open, which `host.connections-changed` already delivers to every device.
 */
function ExternalAgentSetup({
  addresses,
  connections,
  guide,
  onClose,
  thisComputer,
}: {
  readonly addresses: ExternalAgentAddresses;
  readonly connections: readonly AgentConnection[] | null;
  readonly guide: ExternalAgentGuide;
  readonly onClose: () => void;
  readonly thisComputer: string | null;
}) {
  const known = useRef<ReadonlySet<string> | null>(null);
  if (known.current === null && connections)
    known.current = new Set(connections.map(({ id }) => id));
  const connected = known.current
    ? connections?.find(({ id }) => !known.current!.has(id))
    : undefined;
  const cloud = guide.id !== "other";
  const remote = addresses.remote;
  const unreachable = cloud && remote?.reach === "private-network";
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
      {unreachable ? (
        <p className="notice">
          <span>
            {guide.name} runs in the cloud and can't reach a private network address. Switch Remote
            access to Opensteer Connect. <Link to={remoteAccessPath}>Open Remote access</Link>
          </span>
        </p>
      ) : (
        <ol className="add-computer__steps external-agent-setup__steps">
          <li>
            Copy this address.
            {remote ? (
              <AddressBlock label={thisComputer ? "From anywhere" : "Address"} value={remote.url} />
            ) : null}
            {!cloud && thisComputer ? (
              <AddressBlock label="From an app on this computer" value={thisComputer} />
            ) : null}
          </li>
          <li>{guide.step}</li>
          <li>Approve the request in Opensteer when {guide.name} asks.</li>
        </ol>
      )}
      <p className="external-agent-setup__status" role="status">
        {connected ? (
          <>
            <Icon name="check-circle" /> {connected.label} is connected.
          </>
        ) : unreachable ? null : (
          `Waiting for ${guide.name} to connect.`
        )}
      </p>
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
