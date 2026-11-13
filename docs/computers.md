# Devices: enrollment and access

## Enrollment

A device is one Runner identity in a personal Deployment. Enrollment caps its modules on every reconnect;
advertising fewer does not reduce the grant, and presentation shape never grants authority.
Execution policy changes preserve identity. Personal Opensteer executes tasks only on its hosting
computer, which cannot be removed; phones never offer shell. Enrollment profiles live in
[the grant policy](../apps/host/src/agents/runner-enrollment-grant.ts).

Browser and Apps are live Host policy, separate from the immutable module ceiling and per-app
approvals. Turning them off preserves capability descriptors and saved approvals. Browser gates
only agents: profile homes, person browsing and the shared browser transport stay available.
Apps gates agent computer use, phone data apps and computer-hosted MCP; a write already sent may
have an unknown outcome when access is withdrawn. Files and commands uses the existing shell policy.
Legacy policy edits preserve omitted switches inside the revision transaction.

Initial setup choices apply only at first redemption. Replaying enrollment cannot reset later access
edits. A self-setup enrollment may pin its prepared runner key; signed leave then retires that exact
attempt against redemption. Tokens minted for other computers are independent.

Remote route changes disconnect route-admitted computers without deleting enrollment. The hosting
computer and supervised services are not remote computers to sweep. Revocation is terminal and
stops reconnecting; network and lease failures preserve identity. Loopback in an endpoint means
the executing computer, never the viewer's.

## Runner and desktop

A Runner that runs no agents must not initialize execution dependencies or read execution inputs;
its browser relay starts independently. Keep the work-location identity while execution is off so enabling it
reuses that identity; the environment binding is immutable after its first advertisement. Signed
device shape is presentation, never authority or routing. Android phones offer no shell. Windows
shell endpoints remain unsupported, but this does not prevent a browser-only connection.

Apps bind their authenticated session to a device by proving possession of its runner key. Explicit
removal, signed self-leave and sign-out of a bound non-Home session share one removal operation:
tombstone the device and delete all bound sessions in the same transaction, then end live work.
Home and unbound web or legacy sessions sign out only that session. Expiry, refresh and route
rotation never remove a device. Old apps that do not bind remain independently signed in after
removal until they update. Removing bound sessions also retires their Host notification preview
keys; Account-side generic push registration is separate.

Desktop persists enrollment before starting the Runner so an exit during join cannot strand a Host
row. Turning execution off restarts the same identity, data directory and SSH host key. Removal
deletes the enrollment slot and every browser profile homed there; adding again creates a new computer.
The removed device erases its profile storage when it learns of removal. If it never returns, erasure
is unconfirmed, not claimed complete ([profile state](browser-sessions.md#profile-state)). The owner-session Host chooses the enrollment grant and
origin, never the desktop. Only the supervising desktop can establish that a computer is local; a
browser cannot claim it. Team administrators cannot enroll, remove or inspect another person's
computer through team authority.

## Machine access

Commands run as the Runner's OS user. Folder restrictions constrain **SFTP only**, through per-share
`os.Root` handles; they are not a command sandbox. Forwarding dials from the target's network, is
audited and ends with the session. Thread access mode decides harness confirmation and the target
policy decides permission: never intersect them or treat running agents on the target as SSH
permission. See the [shell wire](../packages/protocol/src/shell.ts).

Each SSH session has its own WebSocket so its bytes never block the serial control inbox. Shell policy
changes end existing SSH sessions; Browser or Apps edits and command replays do not. Sessions live under the admitting Run attempt's grant, not the
presented token: token refresh ends nothing, withdrawing the grant ends them before the Runner
reports completion, and a late end from an old attempt cannot stop replacement sessions. Relay
sockets live outside `privateStateRoot`; warm engines carry one Run's authority at a time and refuse
connections between Runs. Filesystem permissions protect the sockets, but separate directories do
not isolate hostile processes of the same user. Agent-facing SSH procedure is the shipped [computer
skill](../apps/runner/agent-skills/skills/computers/SKILL.md).

## Computer apps

A connection is pinned to one Runner, and its person-approved access caps every Run. The Host authorizes calls; Runner contract validation detects mismatches and is not
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
to the Deployment's hosting computer. Internet servers run through the Host over HTTPS, and Host
loopback is refused. A Host-local program path never implies the files exist on another computer.

The owner reviews the exact launch and target computer from any signed-in device. Launch
arguments, environment and headers appear only in that review, never shared events or agent
snapshots. Consent is pinned and rechecked at admission; an offline computer starts nothing.

An approved server's changed launch on the same computer keeps consent unless it adds secret
names, because personal agents already run as that OS user without isolation. Team servers run no
agents or plugin servers. A new, moved or declined server always asks.

An agent-made plugin records its folder in Agent home, not a Host path, so only an agent updates it,
by installing that folder again; Settings' Update and `plugin_manage` update person-installed plugins.

Program servers declare secret names, never values, in their plugin metadata. The owner supplies
values through consent; new names require review, and consent and values belong to one computer.
Lists, Requests and snapshots never contain them. Delivery exposes them only to the approved
launch, and transport output must redact them. This protects chat and agent context, not a
same-user shell or the launched program itself.

Servers run with the MCP SDK's minimal inherited environment plus the launch's, in their own process
group; ending a session, stream or Runner kills the whole tree, including descendants of launchers
such as `npx`. A malformed or stalled transport ends that session, not the integrations stream.

MCP form elicitation belongs to one in-flight Run call and only works on engines qualified to hold
it. The answer goes only to that call, never to engine context or durable events. Restart cancels
pending input because its waiter no longer exists
([integration input](../apps/host/src/integrations/integration-input.ts)).

## Devices that run no Opensteer

A TV, speaker or light is reached by an agent-made plugin whose server runs on a computer on its
network. `extensions["com.opensteer"].device` lists the plugin under Devices instead of Plugins and
names its installation; the agent writes it, so it grants and proves nothing. The plugin records the
nearest listed task whose agent last installed it, from the Run's claims, and shows it only to the personal owner. The owner removes plugins. It deletes the plugin's data, such as a pairing, on the Host and on every computer that ran
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
