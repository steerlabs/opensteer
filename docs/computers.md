# Computers: membership, roles, and the page

## 1. Model

A computer is one Runner identity in one Deployment. Its enrollment grant caps modules
on every reconnect; advertising fewer does not reduce that grant. Enabling execution or
changing reach policy must not replace identity. Ordinary grants use
[computerRunnerGrant](../apps/host/src/agents/runner-enrollment-grant.ts); phones use an
exact integrations-only grant. Do not confuse requested modules with the expanded grant.

Personal Deployments execute only on Main. Other user-owned computers are reach-only
(integrations, messaging, shell) or phones (integrations only). The supervised messaging
service is Deployment-owned, not a lent computer. Deployment services have no effective
personal-app owner. See [admission](../packages/database/src) and [Messaging](messaging.md).

Personal remote access gates route-admitted computers at redemption and authentication.
Generation changes disconnect those connections and their sessions, but preserve identities
and enrollments. Fence admission against generation changes both before and after registry
insertion. Main and the colocated messaging service use no route generation and are not
swept. Ordinary enrollment codes may precede a live route; phone issuance needs one.

External execution remains a server configuration fact: absolute capability URLs must be
reachable by the Runner. Only Personal Main requires a loopback Host URL. Model endpoint
loopback likewise means the Runner's computer, not the viewer or Host.

## 2. Runner

A reach-only Runner must not initialize execution dependencies or read execution inputs.
A browser relay requires agents. Preserve the work-location identity when execution is off
so enabling it can reuse identity; advertise no environment until then. Environment binding
is immutable after the first advertisement. See [main.ts](../apps/runner/src/main.ts),
[host-connection.ts](../apps/runner/src/host/host-connection.ts) and
[config.ts](../packages/config/src/config.ts).

Signed device shape is presentation, never authority or routing. It is optional for older
Runners; absent device must not change their proof. Android phones offer no shell and never
enter SSH inventory. Windows shell endpoints remain unsupported; do not offer reach-only
Personal enrollment there.

### iPhone app sharing

[iPhone apps](iphone-apps.md) owns native sharing. Its immutable enrollment profile is
checked before consuming the token and on every authentication; a phone-shaped descriptor
cannot choose Android authority. Approval must come from the data-holding iPhone with a
separate proven key; automatic approval is Mac-only. Backgrounding makes apps unavailable:
never queue raw commands, replay a lost write or move it to a Mac.

## 3. Host

Revocation is bare close 4010 with no preceding host.error. It stops reconnecting and clears
identity; ordinary route/lease failure preserves membership and retries. Keep this terminal
signal distinct from transient admission refusals. [Host boundaries](host-boundaries.md)
owns compatibility and authentication.

## 4. Desktop

Persist membership before starting the Runner so exit during join cannot strand a Host row.
Turning execution off restarts the same identity/data directory/SSH host key. Removal deletes
the enrollment slot; readding creates a new computer. Browser profile data lives outside
that disposable slot and survives enrollment removal. Erasure requires explicit profile
deletion; reenrollment cannot rebind a profile to the new identity. See
[profile state](browser-sessions.md#profile-state). A slot no longer permitted to execute starts reach-only.
The owner-session Host chooses the enrollment grant and origin, never the desktop.

## 5. The page

Use [the shared client model](../packages/client/src/computers) for computer presentation.
A browser cannot claim local computer identity; only the supervising desktop can establish
that locality. Administrators may remove another member's machine, but cannot inspect or
change its private app settings. Personal Main cannot be removed.

## Machine access

Commands run as the Runner OS user. Folder restrictions constrain **SFTP only**, through
per-share os.Root handles; they are not a command sandbox. Forwarding dials from the target's
network and must be audited and end with the session. Thread access mode decides harness
confirmation; the target policy decides permission. Do not intersect them or treat running
agents on the target as SSH permission. See [shell wire](../packages/protocol/src/shell.ts)
and [native helper](../apps/runner/native-fs-helper).

Each session uses a dedicated WebSocket: SSH bytes must not block the serial control inbox.
Policy changes end existing sessions; the next session gets the new snapshot. Sessions live
under the admitting Run-attempt grant, not the presented token. Token refresh ends nothing;
committed grant withdrawal ends sessions before the Runner reports completion. A late end
from an old attempt must not stop replacement sessions.

Relay sockets live outside privateStateRoot for the lifetime of their engine. Warm engines
carry one Run authority at a time and refuse connections between Runs. Filesystem permissions
protect Unix sockets, but separate directories do not isolate hostile native-user processes.
Keep private-state denial intact. Eligibility belongs to
[machine-access-setup.test.ts](../apps/runner/src/shell/machine-access-setup.test.ts).
PTYs, remote/agent/X11 forwarding, per-user allowlists, Windows endpoints and peer-to-peer
transport are outside this contract. Agent-facing SSH procedures remain in the shipped
[computer skill](../apps/runner/agent-skills/skills/opensteer-computers/SKILL.md).

## Computer apps

A connection is pinned to one Runner. Its access caps every Workspace grant, including
Main inheritance. The Host authorizes calls; Runner operation-contract validation detects
mismatches and is not owner approval. Offline computers keep connections. Lost write answers
are unknown outcomes and must never be retried. See
[ComputerAppHub](../apps/host/src/computer-apps/computer-app-hub.ts).

New/broader Mac access requires approval on the data-holding Mac. Automatic app policy
covers only new GUI apps, never widening. Pin approval to owner, Runner, Deployment, app
identity/digest and exact access. Desktop main signs with a distinct Keychain approval key
whose registration proves possession over that Runner stream. Renderer locality is not proof.
Lowering/off is owner-authorized anywhere and invalidates pending approvals. Setup requests
must not start agent turns. Android approval instead follows
[Agent Phone](agent-phone.md#7-access-and-stop).

Protected personal APIs belong in the Computer Use helper so their macOS grants do not
reach every agent child process. The Runner relays them. Readiness is per target/operation,
not the viewer OS; passive inspection must not open permission prompts. An approved app
missing an OS grant needs local settings, not another approval. See
[Computer use](computer-use.md#apps-the-helper-serves).

## MCP servers on a computer

Program/loopback MCP servers run on the chosen computer, never with Host authority.
Internet servers run through the Host over HTTPS; Host loopback is refused. On Personal,
the default is Main, where plugin files exist; a Host-local program path cannot imply those
files exist on a different computer.

Show the program, arguments, working directory and environment—or URL—verbatim before
approval. Pin approval to the exact launch digest. The local Runner learns approval only from the
person's desktop answer over its local bridge, never from Host lists/outcomes. Missing local
approval records refuse execution and require asking again. Reinstallation closes sessions;
an unchanged digest keeps approval, a changed launch asks again. Protocol-incompatible
Runners retain other modules; never translate signed requests to an older approval format.
See [local-mcp-servers.ts](../apps/runner/src/computer-apps/local-mcp-servers.ts).

Run servers with the person's login/manifest environment in their own process group. End
the entire tree when the session, stream or Runner ends, including descendants of launchers
such as npx. Malformed/oversized/stalled transport ends that session, not the integrations
stream. A lost write remains unconfirmed; read retries retain ordinary app semantics.

## macOS Full Disk Access

macOS attributes filesystem access to the app launching the Runner tree: Desktop or the
headless launching app. The grant confers neither machine-access nor integration authority.
It is separate from engine Full access and the Computer Use helper's own grants. Apps can
open settings but cannot grant themselves permission. See
[full-disk-access.ts](../apps/runner/src/shell/full-disk-access.ts) and
[permission presentation](../packages/client/src/host/macos-permissions.ts).

Owner-view control requires effective ownership plus current read-write approval; capture
alone does not grant control. [Mac owner input](computer-use.md#negotiated-mac-owner-input)
owns arbitration and release behavior.
