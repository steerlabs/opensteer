# Computers: membership, roles, and the page

This is the spec for computer membership, roles, SSH access and app approvals,
including how a person reads and changes them.

## 1. Model

A **computer** is one Runner identity enrolled in one Deployment. Its **grant** is the set of
modules it may ever advertise, fixed when it is added: `allowedModules ⊆ {agents, browser,
integrations, messaging, shell}`. The Host refuses a Runner that advertises a module outside its grant, at
enrollment and on every reconnect. A Runner may advertise **fewer** modules than its grant.

An OpenAI-compatible model endpoint belongs to an agent account on a work
location, not to the computer's grant. The Runner on that work location makes
the HTTP request. A base URL such as `http://127.0.0.1:7941/v1` therefore
reaches the Runner computer's loopback interface; a Runner on another computer
needs an address reachable from that computer. See [AI engines](ai-engines.md)
for model discovery, credentials, and limits.

Two facts describe every computer, in the words the page uses:

- **Runs agents** — the Runner is advertising `agents` right now. Threads can be placed there.
- **Reachable by agents** — its access policy's `reach` is not `nobody`. Runs elsewhere may open
  SSH sessions to it under that policy ([Machine access](#machine-access)).

A third thing a computer can offer needs no switch of its own: **Apps** — the owner lets agents use
one app on it (Messages on a Mac) through the integration gateway, with no command access and no
agent running there. [Computer apps](#computer-apps) defines the contract; here it is only the `integrations` module,
which ordinary computer enrollments carry beside `shell` because whether an app is usable is
the owner's connection, not the grant. Those enrollments carry `messaging` for the same reason: a Mac whose
Messages is on at read and write can hold an iMessage channel pinned to it
([Messaging](messaging.md#7a-transports-that-run-on-one-computer)).

An **agent phone** is a computer that offers one thing only: its whole screen, which agents see
and operate through the integration gateway ([Agent Phone](agent-phone.md)). Its grant is exactly
`integrations`, and it never runs agents, is never reachable over SSH, and has neither switch.

Both are switches on the computer's detail page. Neither changes the grant. "Runs agents" changes
which modules the Runner advertises; "Reachable by agents" writes the access policy. Adding and
removing a computer are the only operations that touch identity.

### Roles by Deployment kind

| Computer                                 | Grant                    | Runs agents switch | Reachable switch      |
| ---------------------------------------- | ------------------------ | ------------------ | --------------------- |
| Personal main Mac (hosts the Deployment) | `agents, browser, shell` | no (always runs)   | no (nobody else runs) |
| Any other computer, Personal Deployment  | exactly `shell`          | no                 | yes                   |
| Desktop-added Mac, server Deployment     | `agents, browser, shell` | yes, from that Mac | yes                   |
| Headless machine (connection code)       | `agents, shell`          | no (always runs)   | yes                   |
| Android phone (`Add a phone`)            | exactly `integrations`   | no                 | no                    |
| Deployment services (browser, messaging) | as provisioned           | no                 | no                    |

The store keeps exactly the grant an enrollment is created with. A phone is minted by
`runner.enrollment.createPhone` with exactly `integrations`; every other enrollment the Host
creates, Main and services included, applies its named computer preset
([`computerRunnerGrant`](../apps/host/src/agents/runner-enrollment-grant.ts)): the requested
modules plus `integrations`, `messaging` and `shell`. The table lists what is requested.

Deployment services are minted by whoever supervises the Deployment: the platform for an
Account-attached server Deployment, the compose stack for a self-hosted one, and the desktop app
for a Personal one, which runs the messaging service beside its Host so Slack works on a laptop
(`docs/messaging.md`). A Personal Deployment has no browser service; its Main Mac lends the
browser itself.

Invariants, enforced in the store:

1. **Personal, non-Main grant is exactly `["integrations", "messaging", "shell"]`, an agent phone's exactly `["integrations"]`, or the messaging service's.** Checked when an
   enrollment is created and again when a persisted Runner authenticates, so a credential that no
   longer fits is refused with the sentence
   `Only reachable computers can join a Personal Deployment.` The reachable and phone grants satisfy the user-owned admission rule. The Main
   Runner's bootstrap grant is the Deployment itself. The messaging service is the Deployment's own
   supervised process rather than a computer anybody lent it (`docs/messaging.md` §7): a
   Deployment-owned `managed` Runner granted `messaging` plus the `integrations` and `shell` the
   computer preset adds, which it never advertises. `agents` and `browser` are refused on any Runner but Main, which is
   what keeps a Personal Deployment from executing on machines it does not own.
2. **Personal Runners that arrive over the route are admitted only while remote access is on.**
   With remote access `off`, redeeming an enrollment and authenticating a lent computer are refused
   with `Turn on remote access on this computer to connect other computers.` Ordinary enrollment issuance
   needs no route: a code may be written down before the computer arrives. Phone issuance
   additionally needs a live route so the Host can supply a usable pairing target. Changing the
   remote-access mode (any generation bump) disconnects every connection admitted under a route
   generation, which ends its shell sessions with `machine-disconnected`. Enrollments and
   identities survive; the Runners reconnect when a route exists again. What reaches the Host on
   its own machine — Main, and the messaging service beside it — is admitted under no generation
   and so is neither gated by remote access nor swept by a change to it.
3. **External execution stays a server fact.** `acceptsExternalRunners` (config) and the
   `runtimeOrigin = canonicalOrigin` rule are unchanged; they guard the `agents` module's absolute
   capability URLs. The Runner-side rule "a Personal Runner requires a loopback Host URL" applies
   to the **Main** Runner only; a reachable Runner connects to the signed access route.

Ownership is unchanged: a computer added by a person is user-owned by them; the Personal owner is
the effective owner of the Main Runner; Deployment services have no owner.

## 2. Runner

`OPENSTEER_RUNNER_MODULES` (comma list, subset of `agents,browser,integrations,messaging,shell`)
states what this process runs. Default is all but `messaging`: `agents` always, `browser` when the
bridge environment is present, `shell` when the host key and helper are ready, `integrations` when
this platform has at least one app provider ([Computer apps](#computer-apps)). `messaging` comes
with `integrations` on a Mac, because its one transport, iMessage, reaches Messages through the
helper behind the same bridge; the desktop app turns it on where it offers computer use.

Without `agents` the Runner is **reach-only**: it needs identity, the Host connection, and at least
one of the shell module (with the native filesystem helper) and the integrations module. It does not need a work location, workspace backings,
harnesses, agent skills, PortableFS, or a browser bridge, and it does not start any of them. Its
descriptor advertises exactly the modules running. `browser` without `agents` is refused at config
parse (`browser relay belongs to a computer that runs agents`), so a Runner either runs agents
(with or without a browser relay) or is reach-only.

Without `agents`, none of the execution inputs are required or read: per-machine workspace
backings and roots, run concurrency, agent skills, harness executables, PortableFS, OpenSSL, the
browser bridge. `OPENSTEER_DEPLOYMENT_KIND` and `OPENSTEER_DEFAULT_WORKSPACE_BACKING` stay required
in production for every shape. `agents,shell` (a build with no browser) is a legal shape; only
`browser` without `agents` is refused.

The module list is authoritative: a module absent from it is never advertised, and a configured
browser bridge is simply not opened when `browser` is absent. A reach-only Runner still creates and
keeps a work location in its identity, because turning "Runs agents" on later restarts the same
identity and the agents shape cannot invent one; it advertises no environments until then.

Every Runner also describes the computer it runs on in its signed hello: `device` is its platform
and shape — laptop, desktop, compact (Mac mini, Mac Studio) or server — read once at start from
the Mac's model name or Linux's SMBIOS chassis (`apps/runner/src/device.ts`). A container or a
Deployment-provisioned Runner is a server; a shape the Runner cannot tell is `null`, never a
guess. The field is optional on the wire, so an older Runner still connects and is drawn as a
plain computer; it is signed only when present, so an older Runner's proof is unchanged. Nothing
routes on it.

An agent phone's Runner is the Agent Phone app, not this process: it reports
`device: {form: "phone", platform: "android"}` and advertises only `integrations`
([Agent Phone](agent-phone.md#4-the-runner)). The device identifies the phone presentation; its lack of a shell module keeps it out of
the SSH inventory.

`OPENSTEER_RUNNER_KIND=main` keeps the loopback Host URL requirement on Personal; `local` and
`managed` do not.

### iPhone app sharing

An iPhone shares Calendar, Contacts and Reminders through the first-party Opensteer app while
it is open in the foreground. It reports `device: {form:"phone", platform:"ios"}` and exactly
one module, `integrations` on `ios`, with protocol 1 and `computerAppApprovals:true`. It offers
no computer use, display, shell, Messages, local MCP server, password sign-in or login-text path.

A Host advertising `iphone-apps-v1` accepts `runner.enrollment.createPhone` with
`profile:"iphone"`. Omitting the profile keeps the Android path and protocol 4. Both grants
are exactly `["integrations"]`, but their signed issuance purposes differ: the same idempotency
key cannot cross profiles. The Host supplies the pairing target and requires the live remote
route on a Personal Deployment. The immutable `device_profile` follows the enrollment into the
Runner row. Before redemption consumes the token, and on every authentication, the Host checks
that the signed descriptor fits that stored profile; device presentation never grants authority.
A profile mismatch closes with 4003 and `runner-device-profile-mismatch`; an incompatible iPhone
protocol uses `iphone-app-outdated`. Revocation retains close 4010.

Creating, widening or unblocking access requires a signed answer from the iPhone holding the
data. The owner registers a separate approval key; it must differ from the Runner key and prove
possession over that Runner's current integrations stream within the ten-second challenge.
Approvals reuse the Mac's v4 transcript and thirty-second signature lifetime. Lowering access
or turning an app off works from any owner client. Automatic approval remains Mac-only.

Pending enrollments identify the iPhone before its first connection. An enrolled iPhone has
no `computerUse` report; its app statuses expose only definitions supporting `ios` to its owner.
While the app is closed or backgrounded, agents receive the sentence explaining that Opensteer
must be open on that iPhone. The Host queues no raw command, retransmits no lost write and never
moves that write to a Mac. A lost write answer remains unconfirmed.

## 3. Host

- `MachineSummary.allowedModules` exposes the grant. `modules` continues to expose what is advertised
  and how ready it is.
- `MachineSummary.device` is the Runner's last signed `device`, stored on `runners.device` so a
  computer that is away is still drawn as itself. `ownerName` is the owner's display name on a
  computer somebody else owns (only administrators are sent those), and null on every other row.
- The Door presentation carries `cloud`, true when Opensteer Cloud provisioned the Deployment.
  It changes only what people are told about where it runs; every rule treats it as a server.
- `host.machines.changed` is a realtime message with no payload beyond the base. It is sent to
  every connected client when a Runner connects or disconnects, an enrollment is created, a machine
  is renamed or revoked, or an access policy is written. Clients bump `machineRevision` and reread
  the machines list; the two `host.machine.access.session.*` messages keep their manager-only
  delivery.
- Remote-access `configure` (the existing transaction) additionally, after commit, asks the Runner
  registry to disconnect every connection it admitted under a route generation — the lent computers,
  and nothing this Deployment runs on its own machine. Admission checks read the
  `personalRemoteAccess` row inside the redemption and authentication transactions.
- Admission is fenced by the remote-access generation: a Runner admitted under generation _G_ is
  checked against the current generation before registration and again once it is in the
  registry, so a configure that lands anywhere between admission and registration either fails
  the second read or finds the connection in its sweep. Nothing waits on a lock; a refused
  computer is closed with 1001 and the remote-access sentence, and comes back by itself.
- A revoked identity is refused with WebSocket close code 4010 (`Runner identity was revoked`), at
  revocation of a live connection and at any later authentication attempt, with no `host.error`
  frame before it: the close is the whole message. Only that code is terminal for a Runner: it
  stops reconnecting, and the desktop clears the slot. Every other refusal (lease expiry, remote
  access off, a transient failure) keeps the reconnect loop. A Runner that receives a `host.error`
  during the handshake waits for the close that follows and classifies by its code.
- `runners.max_concurrent_runs` is recorded only by a computer allowed to run agents and is no
  longer required by one: a computer granted `agents` may connect reach-only and write none
  (migration `0024_advertised_agents_capacity`). Nothing reads the column.
- A Runner's execution-environment binding is set once and never changes, but what it advertises
  may be that environment or nothing: a computer that stops running agents reconnects advertising
  no environments and keeps its binding; a computer enrolled reach-only that later runs agents binds
  on that first advertisement, provided its grant includes `agents`. A different environment is
  refused, as today.

## 4. Desktop

The local Runner slot for a Deployment holds `{ enrolled, runAgents }` durably. While enrolled, the
Runner runs whenever the app runs, with `OPENSTEER_RUNNER_MODULES=integrations,shell` when
`runAgents` is off and `agents,browser,integrations,shell` when it is on, dropping to
`agents,integrations,shell` when that slot has no browser. Changing `runAgents` restarts the Runner
with the other module set; the identity, data directory, and SSH host key are untouched.

The target resolver accepts a Personal Deployment that is **not** on this computer (its route is the
signed access route from the connection resolver) and refuses one that is: the hosting Mac is the
Main Runner. `mayRunAgents` is true only for server Deployments.

`DesktopLocalExecutionStatus` (schema 4) gains `computerName` (the OS computer name — `scutil --get
ComputerName` on macOS, the hostname elsewhere), `mayRunAgents`, and `runAgents`.
`startLocalRunner` takes `runAgents`; calling it for a running slot with a different value restarts
the Runner. `stopLocalRunner` is the removal path: it stops the Runner and deletes the slot's data
directory — identity and SSH host key — so re-adding the same Mac is a new computer. A stored
`runAgents: true` whose target no longer allows agents starts reach-only rather than failing. The
earlier `{ enabled }` preference is migrated to `{ enrolled, runAgents: true }` so computers already
lent keep running.

Enrollment is minted by the web app, as the person's session, with the grant for the Deployment
kind (`["agents","browser","shell"]` on server, `["shell"]` on Personal; the Host's computer
preset adds the rest). The desktop never chooses
a grant and never supplies an origin.

On macOS the add is followed by the macOS permission review, unless the desktop's probe
already reports the grant. The review explains that Full Disk Access covers protected files
beyond any one integration, without enabling app or command access. Only its explicit
`Open System Settings` action opens the desktop setup panel. See
[macOS Full Disk Access](#macos-full-disk-access). The add itself never waits on it.

## 5. The page

The list lives at `/settings/computers`; a computer's page at `/settings/computers/:id`
(`apps/web/src/components/computers-page.tsx`). Every client reads computers through one model,
`@opensteer/client/computers`, so a phone and a desktop cannot describe the same computer two ways.

The list answers three questions in order:

1. **Where this Opensteer runs** — the card at the top, drawn as the object it is: the Mac a
   Personal Opensteer runs on, Opensteer Cloud, or the server's address. It is never a row. On a
   Personal Opensteer it links to that Mac's page; its footer names the apps agents can use there
   and the built-in browser and messaging services.
2. **The computer in front of you**, when a desktop could join and has not: "You're on {name}",
   with one button that adds it by name.
3. **Every other computer**, one row each: its shape, its name, what it does for agents, and
   whether it is there. A Personal Opensteer lists them as "Other computers agents can use"; a
   server groups them into Shared, Your and Teammates' computers. Offline rows fade rather than
   gaining a label. A server's administrator finds the services folded away at the end.

Settings keeps Computers apart from where people open Opensteer. The rail lists AI services,
Connected apps, Computers and Chrome under "What agents can use"; the device page sits in the
footer beside this Opensteer and Your account, named `Remote access` on a Personal Opensteer and
`Signed-in devices` on a server. Each page ends with one line pointing at the other.

A computer's page opens with its shape, name, status and one sentence saying what it is to this
Opensteer, then Agents work here (servers only), Apps agents can use, Files and commands, Mac
permissions and Remove, each shown only where it applies.

**Add a phone** sits beside adding a computer and runs setup over USB
([Agent Phone](agent-phone.md#2-setup-over-usb)). A phone is a row like any computer, drawn as a
phone, and agents can use `its screen` once its owner allows access. Its page has none of Agents work
here, Files and commands or Mac permissions: it shows whether the phone is online or paused, the
access controls defined in [Access and Stop](agent-phone.md#7-access-and-stop), the task holding
it with Stop, and Update over USB. Remove revokes the computer.

### Words

| Concept                    | Use                                              | Do not use                                  |
| -------------------------- | ------------------------------------------------ | ------------------------------------------- |
| The computer you are on    | the pin `You're here`                            | `This Mac`, `This computer` as a label      |
| Where the Deployment runs  | `Your Opensteer runs here`, `Opensteer Cloud`    | `Hosts this deployment`, "deployment"       |
| Execution                  | `Agents work here`                               | `Runs agents`, "Let agents use this…"       |
| Lending apps, files, reach | `Agents can use it`; `Nothing shared yet`        | "Added computer", "Machine access"          |
| Reach                      | `Reachable by agents`                            | "Access from other computers"               |
| Membership                 | `Add {computer name}`, `Remove {computer name}`  | enrollment, lend, "Add this Mac"            |
| A phone for agents         | `Add a phone`, `Android phone`, `its screen`     | device, handset, "Pair a phone"             |
| The macOS grant            | `macOS Full Disk Access` under `Mac permissions` | Full access                                 |
| Services                   | `Built in` on the top card; `Built-in services`  | rows among computers, "Runners…provisioned" |
| Where you open Opensteer   | `Remote access` (Personal), `Signed-in devices`  | `Your devices`, "Use on other devices"      |
| One device's sign-in       | `Remove` another; `Disconnect` this device       | "Revoke", "Sign out"                        |

## 6. Edge cases

- Hosting Mac asleep or remote access down → reachable Runners disconnect; sessions end
  `machine-disconnected`; rows show `Offline · seen …`; agents see the offline sentence.
- Reachable Mac asleep → offline from the other side; its switches remain editable and take
  effect on reconnect (policy) or on next start (runAgents).
- Same Mac in two Deployments → two slots, two identities, two host keys, two names; each
  Deployment's page shows it once with `You're here`.
- Two computers with one OS name → the SSH alias generator suffixes (`mac-mini-2`); the detail
  shows the alias agents use.
- Remote access turned off → the lent computers are disconnected in the same operation; they are
  refused until it is on again; nothing is revoked. The Main Runner and the messaging service beside
  it are untouched. Settings copy: "Turning remote access off signs out every device, drops the
  published address, and disconnects every reachable computer until it is on again."
- Bearer caller mints a Personal enrollment with `agents` → refused (`forbidden`).
- Personal Main Runner → the top card, not a row; its page has no Agents work here block, no
  Reachable block and no Remove, and says why it cannot be removed.
- A browser never claims to be any computer: only a desktop that supervises the Runner (or hosts
  the Personal Deployment) places the `You're here` pin.
- Windows → the `shell` module is deferred there, so a reach-only Runner cannot start. A Windows
  desktop gets `Add this computer` only on server Deployments, and adding starts it running agents
  (`runAgents: true`); on a Personal Deployment there is no offer. The Reachable block hides itself
  wherever the Host reports no `access`.
- The desktop persists membership before launching the Runner, so an app exit mid-join cannot
  strand a computer that the Host lists; a Runner that never finished enrolling fails fast with a
  sentence, and Remove clears it.

## Machine access

Agents reach enrolled computers with ordinary SSH tools. The `shell` module
uses the same Runner identity and lease fencing as other auxiliary modules;
the [wire contract](../packages/protocol/src/shell.ts) and shipped
[computer skill](../apps/runner/agent-skills/skills/opensteer-computers/SKILL.md)
define its protocol and agent-facing use. Every Run receives its own computer's
name, including when no other computers are reachable. The SSH inventory names
only other computers; seeing or operating an app on a Mac uses Computer use. An
agent phone advertises no `shell`, so it never appears there; agents use it
through Computer use too.

The Host authenticates the calling Run and pairs a dedicated WebSocket per
session. Keep SSH bytes off the serial control inbox so a stalled session
cannot block others. The target's `opensteer-native-fs` helper enforces an access
policy snapshot; policy changes end existing sessions, and the next session
gets the new policy. Commands run as the Runner's OS user. Folder restrictions
apply only to SFTP, through per-share `os.Root` handles. With the policy's
`forwarding` on, `ssh -L` opens `direct-tcpip` channels that the target dials
from its own network; each forward is audited and ends with its session.

A session lasts as long as the grant that admitted it
([Run tool authority](agent-orchestration.md#run-tool-authority)), not the
token it presented, so a token refresh ends nothing. Stop, a restart that
replaces the attempt, a cancelled Assignment and a background deadline revoke
the grant; once that write commits, the Host ends every session the grant
admitted, before the Runner reports how the Run ended. The Run's end ends the
rest. Both record `run-ended`, as activation does for a grant already revoked.
A restart's replacement attempt holds a grant of its own, so late word about
the attempt it replaced never ends its sessions.

Thread access mode decides whether the harness asks before running SSH; the
target's policy decides what SSH permits. Do not intersect these two settings.
Running agents on the target is governed separately by its `agents` grant.

The calling engine's relay socket and SSH shims live in a launch directory under
`os.tmpdir()`, outside `privateStateRoot`. The directory lives as long as the
engine started with it, which a warm engine extends across Runs; its relay
carries one Run's authority at a time and refuses connections while no Run
holds it ([Warm engines](agent-orchestration.md#warm-engines)). A Unix socket
makes access depend on filesystem permissions, but per-engine directories do
not isolate mutually hostile processes on a `native-user` Runner. Eligibility follows the catalog's
`(platform, driverKind, accessMode)` matrix, tested in
[`machine-access-setup.test.ts`](../apps/runner/src/shell/machine-access-setup.test.ts).
Keep the private-state denial intact and explain unavailable access to agents.

The current contract excludes PTYs, interactive terminals, remote (`ssh -R`),
agent and X11 forwarding, per-user allowlists, Windows endpoints and direct
peer-to-peer transport.

## Computer apps

An app is a catalog definition with `adapter: "computer"`, an installation and
a `connectionKind: "computer"` connection pinned to one Runner. Agents discover
and call its tool rows through the integration gateway. The connection's
`read` or `read-write` access determines those rows and caps every Workspace
grant, including Main-inherited grants. Deployment-owned machines have no
effective owner and offer no personal apps.

On a Mac, an app whose macOS grant must not reach every process an agent can start —
Messages, Contacts, Calendar and Reminders — is served by the Computer Use helper, which holds that grant; the
Runner only carries calls to it, so it needs the desktop app
([Apps the helper serves](computer-use.md#apps-the-helper-serves)).

[`ComputerAppHub`](../apps/host/src/computer-apps/computer-app-hub.ts) routes calls
over the leased `integrations` stream. The Host catalog describes operations;
the Runner verifies the operation contract against its implementation. That
check detects mismatched requests, not owner approval: the Host owns
authorization. A sleeping computer is unavailable without losing its connection.
If a write's answer is lost, report an unknown outcome and never retry it.

On a Mac, new or broader access requires the owner's approval on that Mac,
except a new GUI app on a Mac whose App approvals policy is automatic
([Computer use](computer-use.md) §1); broader access is never automatic.
`computer_app_setup_requests` pins owner, Runner, Deployment, app digest,
exact access, and for GUI apps the app identity and the requesting task. Desktop main confirms that scope and signs with its dedicated Keychain-protected
approval key; the Host consumes the intent and applies access atomically. The key is
registered using owner authorization plus a fresh proof from the target Mac over its
Runner stream ([approval authority](computer-use.md#4-host)).
A renderer's locality claim is not proof. Reducing access or turning an app off
remains owner-authorized from anywhere and invalidates pending approvals.
Setup requests never start agent turns. Administrators may disconnect another
member's computer but cannot inspect or change that member's private app settings.

An agent phone's owner decides access from any client; [Agent Phone](agent-phone.md#7-access-and-stop)
owns its connection commands and pending Requests.

[`packages/client/src/integrations`](../packages/client/src/integrations) shares
availability and access planning across clients. Readiness comes from the
target computer per operation, not the viewing client's OS; passive inspection
must not prompt for macOS permission. A computer's page offers each setup step
only where it can be finished. On that Mac — a lent one, or the one hosting a
Personal Deployment, which has no lent slot — the desktop app approves access and
then opens the macOS grant the app still needs; the page decides "this Mac" once,
for approvals, the approval key and grants alike. Elsewhere, an app that is off can
be requested from that Mac, while one whose access is approved but whose macOS grant
is missing names the grant and says to complete setup on that Mac: approving the
same access again cannot switch a macOS grant on. [Computer use](computer-use.md) extends
this contract for GUI apps. Deployment-wide sharing of personal apps and
everyday Chrome profiles are outside this contract; inbound messaging is a
channel ([Messaging](messaging.md#7a-transports-that-run-on-one-computer)).

## MCP servers on a computer

An Agent Plugin's MCP server that starts a program, or listens on a loopback,
runs on one computer, never inside the Host: only that computer can reach it,
and a program the Host started would run with the Host's own authority. It is
an installation's server like any other — Deployment-wide, granted to
Workspaces, discovered once — whose transport is `{type: "runner", runnerId,
launch}`. Servers on the internet are still reached by the Host, over HTTPS
only; a loopback URL is refused there.

The Runner advertises `modules.integrations.protocolVersion: 2`, signed together
with its desktop approval capability. The Host sends the expanded signed
approval requests and MCP frames only to this version. Older or incompatible
Runners stay connected for their other work; the computer page and new approval
requests explain that Opensteer needs updating. There is no translation of signed
requests into an older format.

- **Where.** The administrator names the computer when installing the plugin,
  or it is the Deployment's Main computer. A Personal Deployment's servers
  therefore run on its Main Mac, where the plugin's files already are; on
  another computer a program named by a Host path does not start, and says so.
- **Approved there, exactly.** Installing asks that computer's owner, on it,
  with the setup requests every Mac approval uses (`kind: "server"`): the panel
  shows the program, its arguments, its folder and its environment — or the URL
  — verbatim, and the desktop signs that request. The approval pins the launch
  by digest (`localMcpLaunchDigest`; `approved_launch_digest` on the server).
  Declining disables the server. Installing the plugin again ends its servers'
  open sessions: a launch unchanged keeps its approval and is listed again at
  once; a changed one is asked about again and runs only once allowed.
- **The computer decides what it runs.** The Runner learns an approval only
  from the person's own answer: desktop main, handing it over the local bridge
  on its way to the Host, names the server and launch digest of the request it
  showed and signed. Nothing the Host sends — a list, an outcome — allows
  anything; it can ask but not allow. The Runner keeps the approved digests in
  `<data dir>/integrations/mcp-approvals.json` and starts only a launch whose
  digest is approved there, so a Host naming any other command is refused
  (`unapproved`). A Runner that lost its record refuses too, and the Host asks
  the Mac again.
- **One session per server.** The Host is the MCP client, over
  `ComputerMcpTransport`; the JSON-RPC messages of a session ride the Mac's
  `integrations` stream unread (`host.integrations.mcp.*`,
  `runner.integrations.mcp.*`), at most sixteen sessions at a time. The
  program runs in the Runner's process tree with the person's login environment
  and the manifest's environment, in a process group of its own, and ends —
  with everything it started, as a launcher like `npx` starts the server —
  when its session does: the Host closing it, the stream ending, or the Runner
  stopping. A message larger than the stream carries ends that session, not
  the stream, as does a server that stops taking what it is sent once 16 MiB
  of it waits. Invalid JSON, a transport error, or more than 16 MiB of output
  without a complete frame also ends the session and its entire process group.
- **Outcomes.** While the computer is offline its tools read unavailable. A
  tool call whose answer was lost — the program stopped, the stream dropped,
  the deadline passed — is unconfirmed for a write and a retry for a read, as
  for every computer app. Tools are listed once the computer approved the
  server, and again when an approved server that could not start meets its
  computer again.

## macOS Full Disk Access

macOS attributes protected file access to the app launching the Runner's process
tree: Desktop when it supervises the Runner, otherwise the headless Runner's
launching app. The grant covers that tree but grants neither integration nor
machine-access authority. It is separate from an engine's **Full access** mode
and from the Computer Use helper's own grants, including the Full Disk Access
Messages reads with ([Computer use](computer-use.md#apps-the-helper-serves)).

The native filesystem helper probes the grant, the Runner advertises it on
`shell`, and the Host projects `MachineSummary.fullDiskAccess` and resolves
pending permission Requests. The app can open settings but cannot grant itself
access. Shared presentation lives in
[`macos-permissions.ts`](../packages/client/src/host/macos-permissions.ts).

Mac owner views can negotiate ephemeral control separately from their capture
lease. Only the effective owner with a current read-write app approval can take
over; helper arbitration spans views and Hosts and releases on give-back, loss or
local Stop. See [Mac owner input](computer-use.md#negotiated-mac-owner-input) for
negotiation, background-focus constraints and native qualification.
