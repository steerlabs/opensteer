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

Requested screen presentations use transient Host memory, never persisted routing
credentials or a person-wide broadcast. A committed human input binds to the exact
Main subscription socket that issued its endpoint, user and login; replay cannot
rebind it. Readiness and dispatch deadlines share a Host monotonic clock. Clients
conservatively bound that clock using their subscribe round trip, not wall-clock
synchronization. See [Voice](voice.md).

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

Use [hostApi](../packages/protocol/src/host-api.ts) and
[registration](../apps/host/src/server/host-api-registration.ts) for browser-facing
RPC. Domain mutations use `commands.dispatch`. Machine protocols, authentication,
bootstrap, webhooks, upgrades, downloads and static distribution are REST
exceptions, not permission to add parallel browser APIs.

Cookie mutations require origin protection. Exact-origin commands additionally
exclude routed Personal sessions and origin-less native clients; keep remote
access-reduction actions usable. `exactOriginCommands` is a subset, so types do
not catch omissions. Origin checks do not protect against a stolen non-browser token.

Viewer read/mute state belongs to the authenticated person, never shared durable
Thread/event records. Viewer updates must be addressed only to that member and
ordered with snapshot/replay. Ordinary RPC failures are operation errors, not
connection-state changes. Growing inputs need bounded bodies and validation at
both boundaries.

Keep credentials out of compression length oracles and preserve stream/progress
semantics. The exclusions in
[response-compression.ts](../apps/host/src/server/response-compression.ts) are
intentional; a gateway can compress independently.

Personal Connect forwards the whole tunnel hostname without path restrictions.
`connect-projection` publishes signed route state; it is not a traffic proxy.
Both runtime listeners and development proxies must admit display data traffic.

Display data tickets are single-use and bind the complete live integrations fence,
producer incarnation and exact Mac window binding. Replacing the integrations
stream invalidates them; failed upgrades never make consumed nonces reusable.
Owner sockets require exact-source ownership and periodic/login-expiry
reauthorization; an owner view uses its independent lease. Bound receivers must
limit fragmented payloads before reassembly. Data failure affects only its stream.
Phone data loss and consumed-ticket upgrade failures close viewers with retryable
1013 while preserving their last state; Mac startup failure is terminal. See
[the display contract](agent-phone.md#live-display) and
[DisplayStreamHub](../apps/host/src/computer-use).

## Compatibility

Compatibility targets the previous **public** release, not pre-launch builds.
[The previous-release journey](../apps/host/src/agents/previous-release-compat.integration.test.ts)
uses the frozen public client; move its baseline on public release and fetch that
commit in shallow CI checkouts.

[`hostApiVersion`](../packages/deployment-authority/src/authority.ts) owns the epoch.
Bump only when an older counterpart would misstate meaning or act unsafely: a
mismatch strands machines one release behind. Preserve both directions: discovery
checks the raw epoch before identity parsing, RPC refuses missing/mismatched
`x-opensteer-api-version` before dispatch, and subscription negotiates before admission.
Epoch/capabilities belong outside signed Host identity; ignore unknown optional
capabilities and never use them to gate mandatory behavior.

- Added response fields are tolerated, including opaque values parsed later and
  other sockets. The [tolerance guard](../tests/host-response-tolerance.test.ts)
  does not cover every such path. Missing optional facts mean unknown; only a
  known non-human author enables quiet turns.
- Readers skip/fall back on unknown union members and enum values rather than
  refusing a whole list/frame. Presentation tolerance also covers stored consent
  manifests; executable definitions and authenticated inputs remain strict.
- Descriptor readers strip/filter unknown optional fields, modules, alternatives
  and versions. Required sets retain an understood choice; omit a source whose
  required configuration cannot be understood. Unsupported inventory must never
  erase bindings or the agents module.
- Authenticate the complete raw proof-format-2 descriptor JSON with canonical
  JSON **before** one domain parse. Defaults, trimming and filtering cannot alter
  the authenticated value. Commands, requests and proof envelopes remain strict.
- New features/command fields require capability advertisements; older Hosts
  reject unknown strict inputs. Make removed fields optional in readers first,
  then stop sending them with a later necessary bump.
- Passkeys add no epoch bump. The runtime advertises `modules.browser.passkeys: 1`;
  the enabled Host sends `passkeys: 1` in its auxiliary welcome and signed attach
  ticket, and viewers opt in only when the Host advertises `browser-passkeys-v1`.
  Older Hosts, runtimes and viewers keep the absent policy. See
  [Passkeys](browser-sessions.md#passkeys).

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

### Active compatibility gates

Upgrade Hosts before Runners needing new execution/storage semantics; Personal
ships both together. Enrollment is not execution admission. Native continuation,
execution leases and requester-time-zone support are mandatory execution gates;
unsupported Runners stay visible but cannot execute. Refused durable events end
only their still-bound Run, not unrelated Runs or the connection. Upgrade the
Account before Hosts introducing notification contracts it must accept.

Thread titles use the existing state-change event with optional title; a new kind
would break previous closed unions. Even tolerant readers acknowledging skipped
sequences do not permit writers to abandon the previous release. Title/icon
requests require their independent Host/Runner capabilities. Unknown colors read
as absent; agent Workspace views omit marks to preserve baseline strict readers.
Icon requests stay inside the title gate and are never sent to title-only Runners.
Reports retain the Run binding fence; empty reports do nothing.

`browser-profile-create-v1` selects the current catalog. Older Runners retain
legacy profile tools under their original permissions; never expose those aliases
to current full-access engines. `environment-list-v1` independently selects split
Environment/Workspace discovery and skill-based Trigger descriptions/schemas.
Select each gate once per MCP session from stored advertisements, preserving the
inventory through reconnect/restart. Engines use release-local inventories and
are stopped/reaped on Runner upgrade; no persisted Run catalog pin is needed.
Upgrade the Host first so new Runners have their required tools.

Saved Trigger/Watch program versions are separate from tool inventory: v1/v2
retain old discovery; v3 uses split discovery with v2 delivery and independently
requires `trigger-program-v3`. Check the anchor Runner's stored advertisement
(including offline state) at admission and again at dispatch/reconciliation.
No advertisement means unsupported. Fail occurrences or back off Watch with an
update/use-v2 error; never relabel source or change v1/v2 execution.

`shared-task-done-v1` gates shared Done controls/commands. Reject old
`thread.done.set` before mutation **or idempotency lookup** with the update reason:
Done stops the task for everyone. Preserve read-state placement projections for
older readers; actual read positions never change because a task became Done.
Use the existing `thread-archived` cancellation reason. `thread_write` requires
Runner `task-done-v1`; older strict summaries omit `doneAt`, even after parsing.

Passwords consent includes websites and apps and the risk that a tricked agent
reveals saved fields. Request lists/snapshots skip unreadable kinds.

Mac window operations need matching helper, integrations and owner-view contracts;
ship packaged Host, client, Runner and browser producer together. Android
integrations versions are separate from Runner proof versions. Phone pairing
trusts the USB-provided target and TLS, then compares Deployment/Host-instance
IDs; it does not verify discovery authority signatures.

Browser targeted streaming and native inputs require producer/Runner negotiation,
including native-bearing history at dispatch, delivery and steering. Older callers
receive address-free text. A two-way epoch cutover requires coordinated Expo/Host
updates; publishing an Expo update early does not make early installations
compatible with older Hosts. See
[browser compatibility](browser-sessions.md#shared-viewing-and-previews).

`browser-target-control-v1` and Runtime `modules.browser.targetControl` negotiate
picture-free following. Unsupported producers must refuse it, never request
pictures instead.

Display input requires end-to-end `sharedInput: 1` negotiation. Viewer sockets opt in with
`sharedInput=1`; the Host projects it only while the producer supports it and the viewer is
authorized. Mac owner input negotiates version 2, reads legacy 1 tolerantly and emits 2 only
to peers that offered it. Missing negotiation keeps viewing available without input.
Previous-release viewers’ `display.control` acquire requests receive the legacy refusal;
release and controlId-bearing input are ignored without closing the socket. Current writers
never emit `owner-in-control`; its error vocabulary remains readable for compatibility.

Native owner authority travels as a bounded `leaseDurationMs`, measured from receipt using
each producer's monotonic clock. The Host alone publishes its absolute `expiresAt` to
clients. Capture does not renew authority. A negotiated helper capability survives an
idle socket disconnect; an owner open reconnects and validates the next handshake.

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

## Owner-view authority

Owner generations are ephemeral and independent of Run sessions. Only effective
machine owners can open/list/renew/view connected, unblocked approved apps/phones.
Check approval at admission and delivery; opening a display socket never extends
a lease. Window inventory is owner-only and requires negotiated picker support.
Close, expiry, disconnect, revocation and shutdown end the exact generation without
ending task grants/holds/observations. Terminal generations never renew or silently
reopen. Native owner authority ends on Host restart and is never restored.
Browser bindings and opener provenance persist independently.

Owner and task subscriptions authorize independently even when exact window/phone
bindings share a producer. Native capture requires matching signed/live helper and
owner-view versions and carries its auxiliary fence, exact view/generation and
relative lease without a fabricated Run. Each stream binds one exact root/process;
owner views bind a window while task views follow their current window. Respect OS
sharing controls and the [window-group contract](computer-use.md#2-the-helper).

Warm retention requires existing exact-source authority, sends/encodes no media and
ends immediately on privacy/authority loss. It is non-sliding and consumes native
capacity until cleanup settles. Starts/stops serialize globally; configuration
updates serialize per running slot. A single pending target may await cleanup,
with authority/binding rechecked under the original startup deadline; two visible
roots still refuse a third. Evicting a warm stream does not end a valid owner lease.
Target/connection changes clear decoder pixels; static frame age alone does not.

### Workspace tab restoration

Tab restoration and groups are additive capabilities, not new authority. Authorize
lineage reads using session ownership and fresh active Workspace membership; keep
URLs Host-private. Lineage revisions fence stale responses. Only positively
negotiated Runtimes receive restoration fields. The Host-wide capability must not
hide live-only sessions from other producers. Icons may outlive a session but
require authorization against its latest session and must never start a browser.
Group invalidation is owner-addressed. See
[tab lifetime](browser-sessions.md#open-workspace-tabs).

### iPhone apps capability and release order

`iphone-apps-v1` gates the optional iPhone enrollment profile; older Hosts must
never receive it. Android profile-less issuance stays unchanged. The tolerant
response-reader precursor must **release before** the feature merges/deploys.
It must understand iOS presentation, tolerate future platforms and preserve legacy
definition defaults (including omitted `apiKey`) before authoritative iOS responses
ship. Qualify the precursor against preceding frozen parsers, then the feature
against precursor parsers using raw bootstrap, machines, integrations, platform,
setup and machine-change output, including Mac, iPhone, installed Calendar and
pending setup manifests. Otherwise late-parsed consent definitions can still break.
