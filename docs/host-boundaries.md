# Host boundaries

Read this when changing Deployment configuration, client authentication or the
Host API. Integration-provider OAuth has its own
[contract](integration-oauth.md); client routing lives in [Connections](connections.md).

The public stable Mac app omits `OPENSTEER_PERSONAL_ACCOUNT_ISSUER` from its Personal
Host. No Account authority or hosted OAuth broker is constructed. Local ownership,
private HTTPS access and pairing remain available; Host-native OAuth for added
servers retains the desktop release identity. Stored Personal Account links cannot
create Account clients without a matching configured issuer, and phone push uses
that same issuer fence. Beta keeps its Account authority.

## Deployment configuration

[Config validation](../packages/config/src/config.ts) owns the combinations of
`DeploymentShape`, exposure, Account attachment and external Runner admission.
`defaultWorkspaceBacking` is a provisioning default, not a capability fence:
any Deployment can hold local directories on enrolled machines. PortableFS
requires Host configuration.

A Personal Deployment is single-user and loopback-only; an Account-attached
Deployment must be a server. Loopback exposure requires both the canonical
hostname and bind address to be loopback. Networked Hosts must not mint their
own first-owner credential. Native OAuth is server-only.

`acceptsExternalRunners` controls the `agents` module, not SSH-only computers.
When enabled, `runtimeOrigin` must equal `canonicalOrigin`: external Runners
must reach every capability URL the Host mints. See [Computers](computers.md).

## Credentials and machine-local ownership

[HostAuthenticator](../apps/host/src/identity/auth.ts) selects one Host-issued
credential family. A malformed or unsupported `Authorization` header must fail,
never fall through to a browser cookie.

Canonical browser cookies, native OAuth `Bearer` tokens and Personal remote
sessions have different authority. Personal remote sessions have cookie and
`PersonalRemote` header deliveries, both with `surface: "personal-remote"`.
Cookie mutations require an origin check; header credentials are not ambient.
Neither a native token nor a remote session proves machine-local ownership.

Machine-local authority requires a `machineLocalSessions` marker **and**
`credentialKind === "browser-cookie"`. Only `claimLocalMachineOwner` writes the
marker by spending the supervisor's process-launch capability. A native token
can reference the browser session that authorized it, so checking the marker
alone would let local authority travel off the computer. A canonical surface,
an Origin header or the absence of a remote-session row is not proof.

[IdentityService](../packages/identity/src/identity-service.ts) checks the native
token's `authSessions` row on every call. Native OAuth revocation ends that
session, not just its refresh token; otherwise its access token could survive
sign-out. Revocation must not end other devices' sessions.

`sessions.list` names each device from its stored user agent through
[`describeSessionDevice`](../packages/identity/src/session-device.ts), which
assembles labels such as "Chrome on Mac" only from fixed names and never echoes
the header. Personal remote exchanges store the exchanging client's user agent
for the same reason. The listed `machineLocal` flag lets clients fold the
hosting computer's own sign-ins into that computer; it is presentation, never
authority.

Account Connect grants bind `clientSurface`; the exchange derives cookie or
header delivery from it. Pairing-code clients declare the delivery they can
hold. `personalRemoteSessions.delivery` pins that choice for the session's
lifetime. Remote sessions must fail canonical cookie authentication, even if
the caller renames the cookie.

The exchange's comparison of `Host` and `X-Forwarded-Proto` pins a signed route
origin and generation; it does not prove the request traversed that route.
Any process reaching the loopback listener can set those headers. Authorization
depends on the signed grant, its short lifetime and single-use `jti`, or the
single-use pairing code, plus the envelope hash and route generation. Rotation
invalidates sessions tied to the old generation.

First-party native client identities come from
[`opensteerNativeClients`](../packages/core/src/identity.ts). Host and Account
registrations converge on that registry. Add a signed build there and match its
release identity; do not create per-Deployment client allowlists.

## API boundaries

[`hostApi`](../packages/protocol/src/host-api.ts) derives the handlers, client
and mock. Add domain mutations to `commands.dispatch`; compose typed subsystem
handlers in [host-api-handlers.ts](../apps/host/src/server/host-api-handlers.ts).
The [server composition root](../apps/host/src/server.ts) documents which wiring
and machine-protocol routes belong there. New browser-facing capabilities use
RPC. Existing REST exceptions cover machine protocols, authentication/bootstrap,
account adoption, webhooks, WebSocket upgrades, attachment downloads and static
distribution; they do not authorize parallel web APIs.

The internal computer display WebSocket route `/internal/v1/computer-use/display` accepts
`Authorization: Bearer <dataTicket>`, independently of browser sessions and the Runner's
integrations socket. The one-use ticket has audience `opensteer-display-data`, type
`opensteer.display.data-ticket`, a 60-second lifetime and the complete live integrations
auxiliary fence plus `display: "main"` and `streamId`. Admission consumes its nonce and checks
that fence and producer incarnation; reconnecting or replacing the integrations stream invalidates old
tickets. Data-socket failure affects only the display stream. The owner-facing socket is
`/v1/computer-use/sessions/:sessionId/display`, authenticated like browser sockets and
owner-authorized for the exact source, with periodic and login-expiry reauthorization.
The owner route `/v1/computer-use/views/:viewId/:generation/display` enters the same Hub
with the independent owner lease as authority. The current phone integrations protocol supplies one
current contract, with no version capability flags or JPEG fallback. Authenticated runtime
`displayAvailable` reports H.264 streaming support. Mac windows require the signed
`macWindowVideoVersion: 1` descriptor, integrations protocol 5 and owner-view version 3.
Mac data tickets additionally name the helper-minted exact-window binding.
[Live display](agent-phone.md#live-display) defines the shared contracts;
the Host enforces admission, independent viewer credit and control relay. The viewer and
data routes own separate WebSocket receivers (256 KiB JSON and the media-envelope maximum),
so fragmented payloads are limited before reassembly. A consumed ticket whose upgrade fails
ends Mac startup terminally and closes phone viewers with 1013 to retry; its nonce remains unusable. Phone-reported
`failed/data-socket-failed` also closes with 1013, just as Host-detected data loss does. Neither
path relays a failed state, preserving the viewer’s last state during retry backoff; other
failed/stopped reasons remain terminal.

Personal Connect forwards the entire tunnel hostname to the loopback Host: the Account
configures path-unrestricted ingress, and the desktop connector adds no local path rules.
`connect-projection` publishes the signed route state; it is not a traffic proxy. The
self-hosted gateway explicitly allows the display data route on both runtime listeners,
while its public `/v1/*` rule covers the viewer socket. The development Web proxy also
allows the display data route and carries the viewer socket through its `/v1` prefix.

Host API epoch 22 carries viewer read state in Workspace snapshots, Thread
pages and direct history results, and viewer mute preferences in authenticated
bootstrap and Workspace catalog pages. These per-person fields stay out of
durable shared Thread and event records. Realtime viewer updates and reconnect
refreshes are addressed only to the authenticated member, ordered with the
Workspace snapshot and replay. The old bulk unread and mute RPCs are removed.

The Host compresses the JSON reads a client makes to show Chat, tasks and tabs,
listed in [`response-compression.ts`](../apps/host/src/server/response-compression.ts):
Brotli (quality 4) or gzip/deflate (level 6) above 1 KiB, by `Accept-Encoding`,
with `Vary: Accept-Encoding`. Those reads are most of a phone's bytes on a weak
link. Every other route stays uncompressed, as do streams, binary bodies,
upgrades, ranges and responses with an explicit Content-Length or cookies: that
keeps streaming and progress semantics, and keeps credentials out of a
compression length oracle. A gateway in front may still compress what the Host
leaves alone, as the container gateway does.

RPC methods declare their HTTP transport statically. Inputs that can grow with
arrays, search text or opaque file keys use bounded JSON request bodies, with
the same validation at client and Host boundaries. Ordinary RPC failures are
operation errors; bootstrap, authentication, platform network and subscription
lifecycle own connection state.

[RPC registration](../apps/host/src/server/host-api-registration.ts) owns scopes
and `exactOriginCommands`. The latter is a subset, so its type check cannot
detect a missing command. Review changes deliberately: `mutation` provides
cookie-origin protection, while exact-origin rules require the canonical
origin and exclude routed Personal sessions and origin-less native clients.
Keep actions needed to undo access remotely, such as disconnecting a computer
or account and reducing app access, usable from those clients. An Origin check
is not protection against a non-browser caller holding a stolen token.

## Compatibility

Display input requires end-to-end `sharedInput: 1` negotiation. Viewer sockets opt in with
`sharedInput=1`; the Host projects it only while the producer supports it and the viewer is
authorized. Mac owner input negotiates version 2, reads legacy 1 tolerantly and emits 2 only
to peers that offered it. Missing negotiation keeps viewing available without input.
Previous-release viewers’ `display.control` acquire requests receive the legacy refusal;
release and controlId-bearing input are ignored without closing the socket. Current writers
never emit `owner-in-control`; its error vocabulary remains readable for compatibility.

Compatibility starts with the first public release: "the previous release" a wire
change must stay readable by is a public release.
[previous-release-compat.integration.test.ts](../apps/host/src/agents/previous-release-compat.integration.test.ts)
builds that release's client from its commit, `previousPublicRelease` (the public
launch commit, 0.1.219), and drives discovery, subscription, reads, shared Done and
ordinary mutations against the current Host. Move the baseline to each public
release as it ships. CI checkouts are shallow, so the integration job fetches that
commit first. Pre-launch builds, including the 0.1.181 and 0.1.207 epoch-48
clients, are not a compatibility target; pre-launch versions named below record
why a gate or field exists.

Browser editing adds no epoch or binary image header change. Its version and
clipboard capability negotiation are specified in [Remote editing](browser-sessions.md#remote-editing).
Watch receives no clipboard data; Host-assigned consumer identity routes clipboard results,
parts, page writes and context menus. The released `clipboard.paste` meaning remains
plain-text insertion.

Thread titles require no epoch bump: clients send `thread.create.generateTitle`
and `thread.rename` only when the Host advertises `thread-titles-v1`, and the
Host adds a Run's optional `titleRequest` only for a Runner advertising
`thread-title-v1`. Title changes ride on `thread.state-changed` with an optional
`title` field. Older clients strip the added field; a new event kind would break
their closed event union until they receive the tolerant realtime reader described
in [Client connections](connections.md#durable-stream-and-live-progress). That
reader skips unsupported events while acknowledging their validated sequence;
writers must still use the existing kind for preceding releases. See
[Thread names and symbols](agent-orchestration.md#thread-names-and-symbols).

`task-marks-v1` gates `thread.icon.set` and `workspace.color.set`. Person-facing
Thread, Workspace and assignment-worker views carry optional colour; readers
catch unknown future colours as absent. Older events may omit marks. Every new
state-change writer includes the current nullable icon. Agent-facing Workspace
views omit icon and colour so both agent and Trigger create responses still parse
with the baseline Runner's strict schema.

The Host keeps the outer `thread-title-v1` gate and adds `titleRequest.icon: true`
only for a provisional icon on a Runner advertising `thread-icon-v1`. A title-only
Runner receives no icon field, and no request when only the icon is provisional.
Without that flag a Runner reports the original title-bearing shape; with it the
report may contain title, icon or both. Empty reports do nothing; the existing
Run binding fence applies to every report.

A Runner advertising `browser-profile-create-v1` runs engines that expect the
current agent tool catalog: `browser_profile_create` for Main, and neither
`browser_profile_save` nor the `browser_sign_in` alias. Engine drivers enable
exactly their own release's catalog, and Codex also checks that inventory, so the
Host still serves those two previous-release tools, through their original
permissions, to a Run whose Runner lacks the capability. It never serves them to a
current Runner, whose Claude could otherwise call them in full access. The Host
reads the Runner's stored advertisement once per MCP session, so a previous-release
engine keeps its tools while its Runner reconnects or the Host restarts.
Upgrade the Host before its Runners: a current Runner on an older Host is missing
`browser_profile_create`. See [Browser profiles](browser-sessions.md#profiles-and-identity).

Runner capability `environment-list-v1` independently selects the split discovery
catalog: `environment_list` is available to every delegating profile, and
`workspace_list` contains only Workspace pagination. Without it, the Host serves
the previous Workspace listing schema/results and delegation/creation descriptions,
without `environment_list`. These sessions also receive the frozen pre-skill
`trigger_write` description and v1/v2 schema: previous-release Workspace and
delegated Runners do not deliver `opensteer-triggers`. Current Run sessions get
the skill-based description and v3-capable schema. This gate is independent of `browser-profile-create-v1`;
a 0.1.203 Runner lacking both retains both legacy behaviors. Each gate is selected
once per MCP session from the stored Runner advertisement, preserving inventory
through reconnect and Host restart when that advertisement is unchanged. A Runner
shutdown aborts its Runs and stops all engine sessions (`RunnerRuntime.close`);
startup also reaps processes from earlier boots before taking work. Active engines
do not survive a Runner upgrade and need no persisted Run catalog pin. Codex's
exact inventory check and Claude's allowed-tool derivation both use
their release-local `toolsForCapabilityProfile`; new Runners therefore never get
the legacy Workspace schema. Upgrade the Host before the Runner. Saved Trigger
and Watch program contracts are a separate axis: versions 1/2 keep their old
Workspace discovery surface; version 3 uses the split with version 2 delivery.
Runner capability `trigger-program-v3` independently admits version 3 programs.
The Trigger domain checks the anchor Thread's Runner's stored advertisement on
create/update, including offline advertisements; no advertisement means unsupported.
Before occurrence dispatch and Watch reconciliation the Host checks again. Unsupported
occurrences fail through the existing failed path; Watch activations record backoff and
the same actionable error: use version 2 or update that computer. Source is never
relabeled, and v1/v2 admission and execution remain unchanged.
Migration 0110 adds the discovery admission action while preserving existing
receipts and action classes; no Host API epoch changes.

Host API epoch **48** remains the client contract. Host capability
`shared-task-done-v1` gates shared Done controls, composer presentation and
`thread.shared-done.set`, whose result is `{asOfSequence, thread, type, wasDuplicate}`.
The old strict `thread.done.set` input always fails before mutation or idempotency
lookup with `bad_request`, reason `shared-task-done-required`, and an instruction
to update the device: Done now stops the task for everyone.

`ThreadReadState` still carries `placement` and `placementRevision`, which
pre-launch epoch-48 clients read before shared Done: placement is null without a
read position, otherwise `{done: doneAt !== null, sequence: readSequence}`; its
revision is `asOfSequence`. These are display-only projections, recomputed after
reads, Done and Reopen. Actual read markers never change because a task became
Done. Existing task invalidations and read-state notices refresh affected readers,
including delegated tasks. Current clients use `doneAt` and ignore placement.
Older Thread and state-event views strip additive `doneAt`. Requests cancelled by
Done use the existing `thread-archived` reason, readable by 0.1.181.

`thread_write` is advertised only to Runners with `task-done-v1`; older Runners
retain their supported tool inventory, and their strict Thread list summaries
omit `doneAt`, including after response parsing. Web, desktop and Expo remain at
epoch 48 and hide all shared Done actions without the Host capability.

Epoch 48 adds Workspace-scoped Passwords Requests without a Browser Session. Epoch-47
clients cannot read these Requests and describe consent as browser-only. New consent covers
websites and apps, including the risk that a tricked agent could reveal a saved field.
Request list and snapshot readers skip unreadable Requests, as the Added kinds rule requires.

Epoch 47 moves Agent Phone access decisions to any Opensteer client. Older clients would
misstate setup and consent: they treat a phone without an approval key as unfinished and send
people to approve on the phone, while their setup waits for a prompt that never comes. Android
integrations protocol 4 removes that approval machinery and lets agents unlock through ordinary
phone tools. Older phone apps are refused as `agent-phone-outdated` and update themselves over
the authenticated network channel introduced with epoch 45, independently of integrations
admission ([Agent Phone](agent-phone.md#4-the-runner)).

Epoch 46 adds Mac integrations 5 starts with the remaining resolution-through-first-keyframe
duration (1–30,000 ms), spent at each relay and during pending teardown admission. Phone
starts are unchanged.
Epoch 45 adds `updating` and `update-pending` machine states for Agent Phone network updates;
older clients cannot parse them. The authenticated phone-update machine route is
`/internal/v1/runners/agent-phone-update`; [Agent Phone distribution](agent-phone.md#10-distribution)
owns its release and installation contract.
Mac window viewing replaces screenshot RPCs with the shared H.264 display stream, opaque
exact-window targets, authenticated warm retention and terminal owner generations.
The current Mac helper/minimum is protocol 10 and owner-view version 3; older
desktop clients need an update. Window-addressed agent operations additionally require
`computerUseVersion: 2`; the execution Runner must advertise `computerTool: 1`.
Older Stable clients cannot use the replaced shared canonical helper until updated.
Epoch 44 removes the required browser surface/tab `type` field: all pages are tabs, and
`openerId` retains opener provenance for ordering. Epoch-43 clients
require `type` and cannot read the new surfaces or tab catalogs. Upgrade Hosts,
web/desktop clients, Expo and browser producers together.
Epoch 43 adds the authenticated `needs-update` machine status, which older clients cannot read.
Epoch 42 unifies phone viewing under one producer and separate task/owner authorities, adds the
owner display route and demand/source-ended wire, and removes human phone capture.
Rebuild Agent Phone and Expo with the matching contract. Phone apps using an older
contract are refused through the out-of-date path; no legacy display frames are sent.
Mac viewing now uses the persistent helper producer described in [Computer use](computer-use.md).

Native owner authority travels as a bounded `leaseDurationMs`, measured from receipt using
each producer's monotonic clock. The Host alone publishes its absolute `expiresAt` to
clients. Capture does not renew authority. A negotiated helper capability survives an
idle socket disconnect; an owner open reconnects and validates the next handshake.

[`hostApiVersion`](../packages/deployment-authority/src/authority.ts) documents
the current protocol epoch and why it changed. Apps, Hosts, the Account and
Runners update on their own schedules, and a mismatched epoch refuses the
connection, so every bump strands each machine one release behind. Bump it only
when an older counterpart would misstate what something means or act unsafely,
as epochs 32 and 37 do. A change these rules cover is never a bump:

- **Added fields.** Readers ignore fields they do not know. That includes a
  payload carried as `unknown` and parsed later, and frames on other sockets such
  as the browser socket: [the tolerance guard](../tests/host-response-tolerance.test.ts)
  walks only the declared Host and Account response graphs, which is how epochs 35
  and 39 slipped through.
  Run lifecycle events (`run.started`, `run.status`, `run.restarted`, `run.phase`
  and all three terminal events) durably require `startedBy`, the seed message's
  author, `startedAt`, the Run's creation time, and `personWaiting`, whether its seed or any input it took is human-authored. The Host stamps these fields for Runner and Host writes; migration 0114 backfills
  history. View readers and `RunEntry` keep these fields optional: an older Host omits them,
  which means unknown and preserves the existing conversation rendering. Only
  a known non-human author enables quiet turns. These read-only added fields need
  neither a capability advertisement nor an epoch bump.
- **Added kinds.** Readers skip, or fall back on, a union member or enum value they
  do not know, rather than refusing the whole list or frame.
  Machine presentation readers retain known platforms, clear an unknown device
  platform, and clear only the form when that alone is unknown. Computer-app
  presentation readers retain their understood platforms. These view readers
  also apply to catalog definitions inside stored consent manifests; executable
  definitions and authenticated Runner inputs keep their own strict schemas.
- **Capability advertisements.** The owning descriptor schemas strip unknown object
  fields at every level. They filter unknown capability/module names, harness/source
  alternatives and supported access/state/backing and messaging transport/connection
  choices. Required sets must retain an understood choice. A source with an unknown
  required configuration field is omitted; an independently optional field may be
  skipped. Inventory states and other required operational semantics remain validated;
  unsupported inventory never erases bindings or the agents module. Unsupported optional
  feature versions are disabled. Runner proof format 2 signs the complete wire descriptor
  JSON value, including unknown fields, with `@opensteer/shared/canonicalJson`.
  The Host verifies that raw value before this single domain parse. Requests, commands
  and proof envelopes remain strict; trimming, defaults and filtering never change
  the value that was authenticated.
- **Added features.** The Host advertises a capability, and a client hides what an
  older Host lacks and treats a field it omits as unknown. A new command or request
  field waits for that capability, because the Host's strict input refuses fields
  it does not know.
- **Removed fields.** Make readers treat the field as optional first, then stop
  sending it with the next bump another change needs.

[Saved-login compatibility](passwords.md#runtime-and-compatibility) separately
negotiates integrations `passwordSignIn: 1` for the Personal vault authority and
`loginText: 1` with a live receiver key for app typing. Auxiliary welcome opt-in
keeps the new status fields away from older Hosts. Browser fills retain browser
`modules.browser.signIn: {version: 3}` and agent Runner `modules.agents.loginFill: 1`
admission. Unsupported versions disable the optional feature; missing saved-text
support refuses the whole batch before input. Historical results remain readable
and never authorize a fill.

Runner proof format 2 is an independent security boundary, carried explicitly in
both the primary challenge and the enrollment/authentication answer. Its v2
signature domains bind the whole descriptor: the previous projected transcript
left the shell host key and several harness constraints unsigned. Mixed or missing
proof formats receive an actionable update refusal; there is no v1 verifier or
admission fallback. This cutover does **not** change `hostApiVersion`, since web,
desktop and Expo client semantics are unchanged. Main/managed Runners, standalone
browser/messaging services, cloud Hosts and Runners, and Personal's bundled
Host/Runner must install the matching v2 baseline together. A desktop lent to a
remote Host has its own Host/Runner update boundary. On that baseline, optional
new advertisements authenticate to older v2 Hosts and their unknown facts are
ignored; feature requests still require the understood capability.

Pre-v2 Agent Phones require **one update over USB**, using the existing same-signer
setup path and preserving pairing and keys. Their old proof cannot authenticate
to the new Host's network update channel. From the v2 baseline onward, an enrolled
phone can still prove its identity for an update refusal and authenticated network
self-update when its integrations module is too old. Unverifiable claims and fresh
enrollment proofs cannot mark an existing machine as needing update. Android
integrations versions are separate from the Runner proof format.

Epoch 27 requires Assignment summaries to carry a label derived from pinned Run models so
completed tasks name the right model after reload. Migration 0071 updates stored
Assignment events before the stricter event parser reads them.
Epoch 28 requires `run.completed` to name the Run's reply (`replyMessageId`), which a
conversation draws as Opensteer's message. The Host adds it when it commits the Runner's event, so
Runners are unchanged; migration 0072 names the reply in stored events by the same rule.
Epoch 30 decides notifications on every Host and sends each to its person's clients as the
`host.notification` frame, replacing the report lookup `thread.reportNotification.get`; it also
adds `viewer.timeZone.update`. Upgrade the Account before Hosts: it accepts the epoch 30 kinds and
windows while still accepting what older Hosts publish
([Mobile](mobile.md#6-notifications)). Runs carry the requester's time zone, so the Host refuses
to dispatch to a Runner without `requester-time-zone-v1`; a Personal Deployment ships both.
Epoch 31 lists each Trigger in `triggers.list` with its schedule, latest Occurrence and watch
state, which the Automations page needs to say when each runs and whether it needs its owner.
Epoch 32 changes what a person's message and Stop mean in a conversation
([Agent orchestration](agent-orchestration.md)): the message joins the reply under way, Stop no
longer pauses the conversation, and an ordinary send never answers a Request. The wire is
unchanged, so stored sends replay under their original keys; the epoch keeps an older client from
offering queue and Resume controls a conversation no longer has.
Epoch 33 lets an Android phone be a computer ([Agent Phone](agent-phone.md)): a machine's device
may be a `phone` on `android`, a computer-use session may hold a phone's whole display with no
app, a `computer.app.access` Request may name `android-phone` with `app: null`, an integration
call's subject may name a phone, `agentPhone.target.get` reads where a phone reaches the Host,
`runner.enrollment.createPhone` mints a phone and `runner.enrollment.retire` retires an
enrollment its owner minted. An epoch 32 client would refuse every machines list and Request
list holding a phone. A phone's descriptor carries `device.form: "phone"`,
`device.platform: "android"` and
`modules.integrations.platform: "android"`, which an older Host's strict descriptor schema
refuses, so upgrade the Host before adding a phone. The phone's current integrations contract is
defined in [Agent Phone](agent-phone.md#4-the-runner); Mac integrations and signed approvals
keep their own versions. Phone pairing trusts the USB-provided target and TLS, then compares Deployment and
Host-instance identifiers before redemption; it does not verify the discovery authority
signature ([pairing trust model](agent-phone.md#5-pairing)).
It also shares browsers and Mac apps between a person and agents
([Agent orchestration](agent-orchestration.md#pages-and-apps-in-a-conversation)). The browser
catalog names the conversations using each session (`threadIds`, those the reader can open,
bounded). It adds `thread.browserUsage.get`, which returns, per session, up to
`browserUsageTabsPerRun` (8) of the latest pages each requested Run used, with the title and
site each last showed, and the `browser-page` message part, which an older client cannot draw
and an older Host refuses. It removes `thread.delegatedWorkspaces.list`. Fast facts arrive as
patches an older client does not know: `host.browser-presence` (a session's page and whether an
agent is acting), sent only to the people who may see the session; `host.computer-presence` (a
Mac session's `actingAppKeys`), sent only to the Mac's owner; and `host.browser-usage-changed`,
naming conversations whose visible usage changed, including revisited pages' labels
and the bounded latest-page order. `host.browser-sessions-changed` means that the
catalog changed, including its bounded conversation list. Like browser presence,
it reaches every authorized viewer's sockets across Workspace subscriptions.
A Mac task display source names its exact session and app key; a phone's whole-display
source omits the app key. The helper resolves each source to an opaque verified window
binding, and the Host shares capture only within the same authenticated machine/fence
and binding. The signed and live producer capabilities must match before dispatch.
`viewport.set` names its
page, so neither follows whatever the agent touched last. A Runner that reads a `browser-page`
part advertises `browser-page-input-v1`. A Run whose inputs carry one is refused on an older
Runner with a message asking for the update, and a page sent while such a Runner's reply is under
way waits for the next Run instead of being handed to it. The browser socket adds
`viewport.follow`. One capability, `modules.browser.sharedControl`, covers shared pages,
view following, the attach ticket's initial size and dialog IDs. For older browser computers,
the Host omits follow and ticket sizing, translates Fit and New tab to the released shapes,
and assigns dialog IDs to check answers before stripping them for the Runtime
([Browser sessions](browser-sessions.md#shared-viewing-and-previews)).
It adds `tasks.list`, the reader's tasks across every Workspace, or one, with their last reply
and failure and an optional `active` filter for running or waiting work, and the payload-free
`host.tasks-changed` notice. Capability `shared-task-done-v1` adds shared
`Thread.doneAt` and `thread.shared-done.set`, preserving epoch-48 read projections
([Agent orchestration](agent-orchestration.md#a-persons-task-list)).
Epoch 34 lists integration tools without their input and output schemas. `integration.platform.get`
carried every operation's schemas, megabytes for one large API, while only `integration_describe`
reads them, one bounded page at a time. An epoch 33 client requires those fields and would refuse
every integrations dashboard.
Epoch 35 adds each browser tab's site icon as a small raster data URL (`favicon`). An epoch 34
client's strict tab schema refuses that field; an older Runtime simply sends none
([Browser sessions](browser-sessions.md#site-icons)).
Epoch 36 lets `integration.apiKey.connect` name the connection a key reconnects (`connectionId`).
A key the provider names no account for is otherwise a new account, so only a named reconnect can
repair a connection a Request or grant pins. An epoch 35 Host's strict command schema refuses the
field ([Integration OAuth](integration-oauth.md#reconnecting-an-api-key)).
Epoch 37 makes integration provenance and key handling explicit. A Request about an
agent-proposed integration carries `presentation.agentProposed` beside a plain title, which every
surface shows as provenance ([Integration OAuth](integration-oauth.md#integration-access-requests)),
and browser-safe integration summaries add `definition.apiKey`: the stored origins a key is sent
to and whether Connect checks it before saving it. A definition without a resolved disclosure has
`apiKey: null` ([Integration OAuth](integration-oauth.md#proposed-api-key-integrations)).
An epoch 36 client would draw a proposed title as
Opensteer's own words and could not describe key custody truthfully.
Epoch 38 adds `statusReason` to integration connection summaries: why an account needs its
owner, when the Host knows. A GitHub account whose sign-in worked but which can reach no
repository says `permissions`, so Settings offers the repository step for it and a sign-in for
every other account that needs attention ([Integration OAuth](integration-oauth.md#github-app-repository-access)).
An epoch 37 Host does not say which, so a newer client could offer a repair that fails.
Epoch 39 carries an agent's one-line `description` of the service in proposal summaries, which the
approval card shows ([Integration OAuth](integration-oauth.md#proposed-api-key-integrations)).
Every new proposal has one, and an epoch 38 client's strict summary schema refuses it, so it could
not show the proposal at all.

Epoch 40 adds the per-tab place catalog (with each tab's `loading`), the targeted
`navigation.stop`, authorized icon/context-candidate reads,
authoritative `browser.tab.open` and inventory-checked `browser.tab.close`, listed-task/Chat occupants, document-bound
automatic context refusal, and independent activity/latest-place notices. Browser
stream snapshots advertise targeted streaming version 1; the Host does not negotiate targeted streaming
through viewer URL parameters. Targeted readers refuse older producers. Expo builds
with the epoch-40 schemas must ship before Hosts upgrade. This is a coordinated two-way
cutover: epoch-39 clients refuse Host 40, and epoch-40 clients refuse Host 39. Making
the Expo update available early does not make an early installation compatible with
an unupgraded Host; coordinate client update messaging and Host upgrade. New Runtimes cannot connect
to older Hosts whose strict snapshot/surface/frame schemas reject the added fields.
Legacy session-wide viewing remains supported by current clients.
The trusted Runtime CDP envelope may carry an opaque `actorToken`; Runtime activity
returns only the resolved surface, normalized pointer, sequence and geometry revision.
The Agent Runner's `native-place-input-v1` capability gates new native inputs and
native-bearing history at dispatch, delivery and steering. A later text-only send may
therefore require a Runner update if its initial history includes native parts. Tool
reads and delegation results use address-free text for an older calling Runner.
Ship the packaged desktop's Host, client, Runner and browser producer together. See
[the browser capability contract](browser-sessions.md#shared-viewing-and-previews) and
[native reference admission](agent-orchestration.md#pages-and-apps-in-a-conversation).

Epoch and optional capabilities belong on the descriptor, outside the signed
Host identity. Unknown capabilities are ignored and cannot gate mandatory
behavior. RPC requests send `x-opensteer-api-version`; realtime negotiates on
`client.subscribe`. The Host refuses a missing or mismatched epoch before
dispatch or subscription. Clients check the raw discovery epoch before parsing
and verifying identity so old Hosts receive an upgrade message, not a parse
error. Keep both directions of negotiation intact.

The optional capability `browser-target-control-v1` is additive and changes no epoch:
the Host accepts `stream.subscribe` with `frames: false`, which follows a browser target
without pictures. The desktop app shows a local page natively only when its Host
advertises it. A Runtime that can observe a target that way advertises
`modules.browser.targetControl`; for one that does not, the Host refuses `frames: false`
with `browser-target-control-unsupported` and never requests pictures instead
([Browser sessions](browser-sessions.md#shared-viewing-and-previews)).

Runner descriptors are signed and read through the owning schemas described above.
Enrollment does not promise every execution contract is supported. The Host never relies
on an optional feature that was not advertised, such as `device`,
`modules.browser.stateImport` or `modules.integrations.computerAppApprovals`.
Changing required execution or storage semantics needs an explicit compatibility
contract; it cannot silently remove the bound agents environment. Upgrade the Host
before Runners that require semantics it cannot read; a Personal Deployment ships
both together.

Host API epoch 29 moves streaming text out of the durable event log into
`host.live` progress and adds `thread.live.get`. Run dispatch requires the Runner
capability `execution-plane-v2`, which covers the live progress frames, the
Host's `host.runs.revoked`, and the execution lease: the attach handshake, event
acknowledgements and lease renewals by which a Run outlives its connection and
a Host restart ([Agent orchestration](agent-orchestration.md#runs-across-connection-loss-and-restarts)).
It also covers each Run's `credentialRefreshAfterMs` and the
`runner.grants.refresh` / `host.grants.credentials` exchange that keeps a long
Run's capability tokens fresh ([AI engines](ai-engines.md#opensteer-tools-through-the-runner)).
An older Runner stays visible but must update before it executes.
`OPENSTEER_EXECUTION_LEASE_SECONDS` (10 to 3600, default 90) sets the lease. A durable event the Host refuses for what it says fails only that
Run, through Run finalization, and only when the refusing binding still holds the
Run; the Runner is told to stop it and keeps its connection and other Runs.

Host API epoch 21 requires `native-session-continuation-v1` for Run dispatch. An enrolled older
Runner remains visible but cannot execute until updated; the Host gives an explicit upgrade
error. The requirement applies to ordinary tasks as well as Chat because every new Run pins a
durable ProviderSession. Upgrade the Host before its Runners; Personal Deployments ship Host and
Runner together. This is an intentional
execution-contract change, with no translation into the older session layout.

Host API epoch 22 changes the required viewer-state and RPC transport contract.
Upgrade Hosts and clients together through the epoch refusal path; a stale
client must receive an upgrade message rather than silently misreading private
state or retrying an oversized GET request.

Host API epoch 23 adds model server discovery and the `local-import` setup
method (see [AI engines](ai-engines.md#models-served-by-a-model-server)). A
Runner advertises `model-server-discovery-v1` when it can answer; the Host
refuses discovery on an older Runner with an upgrade sentence, and its existing
model server accounts keep working.

Host API epoch 24 adds `contacts`, `calendars` and `reminders` to the
computer-app remedies a machines list may carry, for the apps a Mac's helper
serves ([Computers](computers.md#computer-apps)). A newer Runner reports them in
its status frame, so upgrade the Host before its Runners; a Personal Deployment
ships both together.

Host API epoch 26 adds `Thread.listed` and the `thread.listed` event, and makes
Workspace snapshots and `workspace.threads.list` return listed Threads only, so
work Chat hands off appears among a person's tasks. It also adds `requests.list`
and the payload-free `host.requests-changed` notice
([Agent orchestration](agent-orchestration.md#requests-waiting-on-a-person)). An
epoch 25 client cannot tell those tasks from the helpers they delegate, and has
no way to learn what waits on its reader outside its subscribed Workspaces.
Epoch 26 introduced Watch. Its former screenshot RPCs are removed by epoch 46;
current Watch uses the authenticated display stream ([Computer use](computer-use.md),
[Browser sessions](browser-sessions.md#shared-viewing-and-previews)).

## Owner-view authority

The Host's `ComputerViewService` keeps ephemeral owner generations independently of
Run sessions. `computer.view.open/close/renew` are authenticated mutations. Display socket
admission never extends authority. Only the effective machine owner may open/list/renew
or view a connected, unblocked approved app or phone. Owner-only `computer.app.windows`
inventories an exact approved Mac app without opening a task session or lease; Host
capability `ownerViewWindows: 1` and Mac owner-view version 3 gate the picker transport.
Approval is checked at admission
and during delivery. Close, idle expiry (Mac ten minutes, phone three), disconnect,
revocation and Host shutdown remove the exact owner generation. Task grants, holds and
observations survive. A terminal generation is never renewed or silently reopened.

Owner and task subscriptions enter DisplayStreamHub independently. Matching Mac window
bindings share one native SCStream/encoder; phone sources share their phone/display producer.
Mac ordinary hiding may retain one warm session for a non-sliding 30 seconds within the
two-session native limit; exact existing source authority is still required and no media is encoded/sent
while warm. Explicit authority/privacy loss overrides warm retention. Starting/stopping
native sessions occupy capacity until completion. Native media/control use separate bounded
attachments; no screenshot scheduler or JPEG viewing RPC remains. Native warm eviction
retires the logical stream without ending a valid owner lease. Native starts/stops remain
serialized globally; configuration updates on running slots have independent serialization.
Each native stream retains one exact root/process; serialized updates follow the
[window-group composition contract](computer-use.md#2-the-helper), including only its
qualified surfaces. Owner views bind per window; task views follow their current window.
OS sharing controls are accepted; hidden/off-Space roots capture alone.
One pending target per helper may await a retiring warm stream’s settled cleanup; it uses
no native slot, revalidates authority/binding, and expires once under the original startup
deadline. Two visible roots still refuse a third. Target/connection changes
clear decoder output and pixels across clients; static-frame age never ends a valid picture.

Mac owner leases require matching signed/live version 3; phones retain lease version 1 and
the current Android integrations protocol. Owner frames contain the auxiliary fence, exact view/generation,
target and relative lease without a fabricated Run. Browser bindings and opener provenance
are persistent; native owner authority ends on Host restart and is never restored.

### Workspace tab restoration

`bootstrap.get` advertises `browser.workspaceTabRestoreVersion: 1` and the bounded
`browser.workspaceTabs` inventory. New clients use `workspace.tabs.get` to recover
an omitted lineage (the read also resolves a current or historical session ID to its
lineage) and `commands.dispatch` (`workspace.tab.activate` /
`workspace.tab.close`) to obtain a current binding or close a durable row. Reads
reuse session ownership and active fresh-Workspace membership; URLs stay Host-private.
Lineage revisions fence stale responses. `host.browser-sessions-changed` invalidates
this inventory after committed changes; live loading/occupants stay in the existing
session catalog stream. These additions require no Host epoch change.

Durable tab summaries optionally include `iconRef`. The existing `browser.tabIcon.get`
read serves a bounded retained raster for currently bound, nonclosed tabs, including
ended sessions, after authorizing the lineage's latest session. Metadata reads omit image
bytes; icon reads do not start a browser. Runtime messages remain unchanged.

A Runtime advertises `modules.browser.workspaceTabRestoreVersion: 1`, accepting
the optional matching attach-ticket capability and `initialSurfaceId`, a stable ID
on the private tab-open lane, and the private `browser.workspace-tabs` descriptor /
explicit-close frame. A participating live session also exposes `workspaceTabRestoreVersion: 1` in its
person-facing session metadata; the Host-wide capability does not suppress the
live-only projection of other sessions. Only a positively negotiated Runtime receives these fields
or emits that frame. Existing strict surface schemas and live-session API semantics
stay unchanged. See [the session/tab lifetime contract](browser-sessions.md#open-workspace-tabs).

`bootstrap.get` also advertises `browser.tabGroupsVersion: 1` with the person's
`browser.tabGroups` layout. `workspace.tabs.group`, `workspace.tabs.ungroup`,
`workspace.tabGroup.update` and `workspace.tabs.close` run through
`commands.dispatch`. Group changes publish the existing viewer-addressed
`host.browser-sessions-changed` notice only to the owner, who rereads bootstrap.
Groups add no authority or socket message type, and require no Host API epoch bump.

### iPhone apps capability and release order

`iphone-apps-v1` adds the optional `profile:"iphone"` to `runner.enrollment.createPhone`,
without changing its response or Host API epoch 48. Clients expose the discovery fact as
`HostSnapshot.iphoneAppsAvailable`; a client connected to an older Host leaves it false and
never sends this profile. Android's profile-less issuance transcript is unchanged.

The response-reader precursor N must release before feature N+1 merges or deploys. N understands
`ios` presentation values, tolerates future platform strings and preserves legacy definition
defaults, including an omitted `apiKey`. N+1 then adds authoritative iOS descriptor schemas and
emits iOS in the existing machine and catalog views. Clients preceding N cannot read those
N+1 responses. Qualify N against the preceding release's parsers, then N+1 against N's frozen
parsers using real raw `bootstrap.get`, `machines.list`, `integrations.get`,
`integration.platform.get`, `integration.computer.setup.list` and `host.machines.changed` output.
The corpus must include a known Mac, an iPhone, an installed Calendar definition and a pending
setup request so later-parsed manifests are covered.
