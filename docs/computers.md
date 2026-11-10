# Computers: membership, roles, and machine access

## Membership

A computer is one Runner identity in one Deployment. Its enrollment grant caps modules on every
reconnect, and advertising fewer does not reduce it; ordinary grants use
[computerRunnerGrant](../apps/host/src/agents/runner-enrollment-grant.ts), phones an exact
browser-and-integrations grant. Enabling execution or changing reach policy must not replace identity.
Personal Deployments execute only on Main; other user-owned computers offer browser, integrations,
messaging and shell, while phones offer browser and integrations. The supervised messaging service is Deployment-owned, not a lent
computer. Personal Main cannot be removed. An iPhone's enrollment profile is fixed and rechecked on
every authentication, so a phone-shaped descriptor cannot claim Android's authority ([This iPhone's
apps](mobile.md#this-iphones-apps)).

Personal remote access gates route-admitted computers. A route generation change disconnects them
but keeps identities and enrollments; fence admission against it both before and after registry
insertion. Main and the colocated messaging service are never swept. Phone enrollment needs a live
route. Only Personal Main requires a loopback Host URL, and loopback in a model endpoint means the
Runner's computer, not the viewer's or the Host's.

Revocation is a bare close 4010 with no preceding `host.error`: the Runner stops reconnecting, and
the desktop supervisor then forgets that slot's identity. Ordinary route or lease failures keep
membership and retry, so keep this terminal signal distinct from transient refusals.

## Runner and desktop

A Runner that runs no agents must not initialize execution dependencies or read execution inputs;
its browser relay starts independently. Keep the work-location identity while execution is off so enabling it
reuses that identity; the environment binding is immutable after its first advertisement. Signed
device shape is presentation, never authority or routing. Android phones offer no shell. Windows
shell endpoints remain unsupported, but this does not prevent a browser-only connection.

Desktop persists membership before starting the Runner so an exit during join cannot strand a Host
row. Turning execution off restarts the same identity, data directory and SSH host key. Removal
deletes the enrollment slot and every browser profile homed there; adding again creates a new computer.
The removed device erases its profile storage when it learns of removal. If it never returns, erasure
is unconfirmed, not claimed complete ([profile state](browser-sessions.md#profile-state)). The owner-session Host chooses the enrollment grant and
origin, never the desktop. Only the supervising desktop can establish that a computer is local; a
browser cannot claim it. Administrators may remove another member's machine but cannot inspect or
change its private app settings.

## Machine access

Commands run as the Runner's OS user. Folder restrictions constrain **SFTP only**, through per-share
`os.Root` handles; they are not a command sandbox. Forwarding dials from the target's network, is
audited and ends with the session. Thread access mode decides harness confirmation and the target
policy decides permission: never intersect them or treat running agents on the target as SSH
permission. See the [shell wire](../packages/protocol/src/shell.ts).

Each SSH session has its own WebSocket so its bytes never block the serial control inbox. Policy
changes end existing sessions. Sessions live under the admitting Run attempt's grant, not the
presented token: token refresh ends nothing, withdrawing the grant ends them before the Runner
reports completion, and a late end from an old attempt cannot stop replacement sessions. Relay
sockets live outside `privateStateRoot`; warm engines carry one Run's authority at a time and refuse
connections between Runs. Filesystem permissions protect the sockets, but separate directories do
not isolate hostile processes of the same user. Agent-facing SSH procedure is the shipped [computer
skill](../apps/runner/agent-skills/skills/computers/SKILL.md).

## Computer apps

A connection is pinned to one Runner, and its access caps every Workspace grant, including Main's
inheritance. The Host authorizes calls; Runner contract validation detects mismatches and is not
owner approval. Offline computers keep their connections. A lost write answer is an unknown outcome
and is never retried ([ComputerAppHub](../apps/host/src/computer-apps/computer-app-hub.ts)).

Only the computer's current owner approves new or broader access, unblocks apps and enables
automatic app approval, which is Mac-only, from any signed-in device. Review verifies GUI identity
and the deny list with the target helper; an unavailable helper leaves the request pending.
Automatic policy covers only new GUI apps, never widening or unblocking, and turning it down works
remotely. Revoking a session stops its approval decisions, but grants it already committed stay
until the owner reduces them. An approved app missing an OS grant needs local settings, not another
approval. Android access follows [Agent Phone](agent-phone.md#access-and-stop); protected Mac APIs
live in the [Computer Use helper](computer-use.md#apps-the-helper-serves) so their grants never
reach every agent process.

## MCP servers on a computer

Program and loopback MCP servers run on the chosen computer, never with Host authority, and default
to the Deployment's Main computer. Internet servers run through the Host over HTTPS, and Host
loopback is refused. A Host-local program path never implies the files exist on another computer.

The owner reviews the program, arguments, working directory and environment, or URL and headers,
verbatim from any signed-in device. Those details are fetched only for that review and never ride in
Request events, agent projections or client snapshots. Consent binds the launch digest, server and
target Runner and is rechecked in admission; the Runner trusts that Host decision, with no local
approval file. An offline computer starts nothing. A changed launch needs review again, except on a
Personal Deployment: there an approved server's new launch on the same computer keeps consent unless
it declares a new secret name, because a Personal Runner runs agent commands as its owner with no
isolation ([Shared Runner sandbox](ai-engines.md#shared-runner-sandbox)) and review would cover code
any agent there could already run. Shared Runners isolate agent commands but not plugin servers, so
server Deployments keep review. A new, moved or declined server always asks.

An agent-made plugin records its Workspace folder, not a Host path, so only an agent updates it, by
installing that folder again; Settings' Update and `plugin_manage` update person-installed plugins.

A program server declares the secrets its owner must supply under
`extensions["com.opensteer"].secrets` in `plugin.json`, because Agent Plugins forbids credentials in
`env`. Only names and labels enter the launch and its digest. The owner enters values when allowing
it and can change them without new consent; a new launch keeps values for names it still declares
and deletes the rest. Consent and values belong to one computer. Values are
sealed per server in their own table, never in a listing, Request event or snapshot, and the Host
adds them only to the launch it sends. Session-end output quotes the server and becomes its status,
so [the transport](../apps/host/src/integrations/computer-mcp-transport.ts) redacts the values. This
keeps secrets out of chat, manifests and agent context, not from the program or a same-user shell.

Servers run with the MCP SDK's minimal inherited environment plus the launch's, in their own process
group; ending a session, stream or Runner kills the whole tree, including descendants of launchers
such as `npx`. A malformed or stalled transport ends that session, not the integrations stream.

A server may ask the person for values during one tool call with MCP elicitation, in form mode only,
such as a code a TV shows while pairing. The Host matches it to the single in-flight call from a Run
on that client and declines otherwise, and declines on engines that can't hold a call for minutes.
The answer goes only to that call: the `integration.input` Request, its command and events keep it
redacted, it never reaches the engine, and a pending one has no waiter after a restart, so startup
cancels it ([integration-input.ts](../apps/host/src/integrations/integration-input.ts)).

## Devices that run no Opensteer

A TV, speaker or light is reached by an agent-made plugin whose server runs on a computer on its
network. `extensions["com.opensteer"].device` lists the plugin under Devices instead of Plugins and
names its installation; the agent writes it, so it grants and proves nothing. The plugin records the
nearest listed task whose agent last installed it, from the Run's claims, and shows it only to members
of that task's Workspace. Removing a plugin is for administrators or the person who installed it in a
Workspace. It deletes the plugin's data, such as a pairing, on the Host and on every computer that ran
its servers. A computer that was offline or predates `pluginDataRemoval` keeps a pending deletion until
it reconnects and confirms. Removal can't unpair the device itself or stop a same-user shell from
reaching it.

## macOS Full Disk Access

macOS attributes filesystem access to the app that launches the Runner tree: the desktop or the
headless launching app. That grant confers no machine-access or integration authority, and it is
separate from engine Full access and the Computer Use helper's own grants. Apps can open the setting
but never grant themselves. See [full-disk-access.ts](../apps/runner/src/shell/full-disk-access.ts).
Owner-view control needs effective ownership and current read-write approval; capture alone grants
no control ([Mac owner input](computer-use.md#negotiated-mac-owner-input)).
