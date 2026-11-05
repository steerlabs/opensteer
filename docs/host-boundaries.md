# Host boundaries

Deployment configuration, Host authentication, the Host API and compatibility. Integration OAuth is
in [Integration OAuth](integration-oauth.md); client routing is in [Connections](connections.md).

Both desktop update channels use the Account `https://accounts.opensteer.com` and portal
`https://app.opensteer.com`. Account authentication and forms trust only the Account origin; portal
routing, OAuth callback registration and portal forms use the separately configured portal origin.
Their authentication cookies are host-only, and no shared hint cookie crosses subdomains.
Development must configure local origins explicitly.

## Deployment configuration

[Config validation](../packages/config/src/config.ts) owns which combinations of shape, exposure,
Account attachment and external Runner admission are valid, with the reason for each. Loopback
exposure needs both a loopback hostname and bind address. Native OAuth is server-only, since on a
Personal Host it would bypass the loopback tenancy check. `acceptsExternalRunners` (the `agents`
module, not SSH-only computers) requires `runtimeOrigin` to equal `canonicalOrigin`.

## Credentials and session authority

[HostAuthenticator](../apps/host/src/identity/auth.ts) answers a request from exactly one
Host-issued credential family. Duplicate Authorization fields are rejected from the raw headers
before Node can collapse them. A malformed or unknown Authorization header fails; it never falls
through to a browser cookie.

Authority comes from the authenticated user and the existing ownership, membership and role checks,
never from the device or route. Every Personal owner session can administer remote access and see
the linked Account identity. Server administration needs an administrator. People can remove only
their own sessions, including the current one.

Cookie mutations need one exact Origin: the configured origin for a canonical cookie, or the stored
issuance origin of a Personal remote cookie whose signed route generation is current. Missing,
opaque, repeated or mismatched Origins fail. Native OAuth Bearer and Personal remote header
credentials are not ambient and need no Origin. CORS is not authorization, route headers never prove
who is calling, and Origin checks cannot protect a stolen non-browser credential.

`claimLocalMachineOwner` spends the supervisor's process-launch capability to create an ordinary
owner session with no extra powers. The same capability authenticates the desktop's private executor
and tunnel-credential delivery; those credentials never reach an owner session or an administration
status payload.

[IdentityService](../packages/identity/src/identity-service.ts) checks the native token's session
row on every call. Revocation commits before success; realtime teardown follows the response.
Revoking native OAuth ends its session, not just its refresh token, and leaves other devices signed
in. Session lists use fixed device names, never echoed user agents.

Account Connect grants bind `clientSurface`, from which the exchange derives cookie or header
delivery; pairing-code clients declare what they can hold. Delivery is pinned for the session's
lifetime, and a remote session fails canonical cookie authentication even if the cookie is renamed.
The exchange compares `Host` and `X-Forwarded-Proto` to pin a signed route origin and generation,
but any process reaching the loopback listener can set those headers. Authorization rests on the
signed short-lived grant and its single-use `jti`, or the single-use pairing code, plus the envelope
hash and route generation. Rotating the route ends sessions tied to the old one.

First-party native clients come from [`opensteerNativeClients`](../packages/core/src/identity.ts),
shared by Host and Account registration. Add a signed build there, never a per-Deployment allowlist.

### Connected agents (MCP OAuth)

External agents use the MCP OAuth issuer at `/oauth/mcp` for the single resource `/internal/v1/mcp`
([source](../apps/host/src/mcp/connections)), with PKCE S256, stateless signed client registration
and explicit resource binding. It works on Personal loopback without an Account and is separate from
server-only Host-native OAuth. Discovery is pinned to the configured Host origin or its current
signed Personal route, kept exactly through consent and code exchange. Only a signed-in owner
approves; a Personal browser without a session hands a request ID to the signed-in desktop app, and
the link grants nothing. Consent picks an access ceiling and either everything the person can reach
or one Workspace they own, lost when ownership ends.

MCP credentials are opaque, stored hashed in their own record, and never become Host sessions or
authenticate Runners, Runs or programs. A connection works only on the route origin it was approved
for, and Runs and programs only on the runtime origin. Every call rechecks expiry and revocation;
MCP transport sessions hold no authority. Revocation stops future calls, including in an open
session and waits that wake later, but does not cancel admitted tasks or undo their effects.
Revoking a login leaves connections alone; people remove them in Settings → Account → Connected
agents. Connections expire after 30 days with no refresh grant.

## API boundaries

Browser-facing RPC goes in [hostApi](../packages/protocol/src/host-api.ts) and its
[registration](../apps/host/src/server/host-api-registration.ts); domain mutations use
`commands.dispatch`. Machine protocols, authentication, bootstrap, webhooks, upgrades, downloads and
static files are REST exceptions, not permission for parallel browser APIs. Origin protection
happens once, in authentication; destructive commands add no second origin check.
The [maintenance contract](../packages/protocol/src/maintenance.ts) is a deliberate REST exception:
it must work when a client and Host disagree on `hostApiVersion`.

Viewer read and mute state belongs to the person, never to shared Thread or event records; its
updates go only to that member, ordered with snapshot and replay. Ordinary RPC failures are
operation errors, not connection-state changes. Growing inputs need bounded bodies and validation at
both ends. The exclusions in [response compression](../apps/host/src/server/response-compression.ts)
keep credentials out of compression length oracles and preserve streaming.

Personal Connect forwards the whole tunnel hostname without path restrictions. `connect-projection`
publishes signed route state; it is not a traffic proxy. Runtime listeners and development proxies
must both admit display data traffic. Display data tickets are single-use and bind the live
integrations fence, producer incarnation and exact Mac window; a failed upgrade never makes a
consumed ticket reusable ([DisplayStreamHub](../apps/host/src/computer-use/display-stream-hub.ts)).

## Compatibility

[`hostApiVersion`](../packages/deployment-authority/src/authority.ts) is the client protocol epoch;
its comments record each change. Bump it only when an older counterpart would misstate a meaning or
act unsafely, because a mismatch stops every app on the other epoch. Clients check the raw discovery
epoch before parsing identity, so an old Host gets an upgrade message, not a parse error; RPC and
`client.subscribe` refuse a missing or mismatched epoch before dispatch. The epoch and optional
capabilities live outside the signed Host identity.

Within an epoch, compatibility targets the previous public release.
[The previous-release journey](../apps/host/src/agents/previous-release-compat.integration.test.ts)
runs that frozen client; move its baseline when a release goes public.

- Readers tolerate added response fields and skip unknown union members and enum values instead of
  refusing a whole list or frame. The [tolerance guard](../tests/host-response-tolerance.test.ts)
  does not cover every path. A missing optional fact means unknown.
- Descriptor readers drop unknown optional fields, modules, alternatives and versions. Unknown
  inventory never erases bindings or the agents module.
- Executable definitions, commands, requests, authenticated inputs and proof envelopes stay strict.
  A new feature or command field needs a capability advertisement, because older Hosts reject
  unknown strict input. Remove a field by making it optional in readers first.
- Ignore unknown capabilities, never let one gate mandatory behavior, and never rely on an optional
  feature a peer did not advertise.

Runner proof format 2 is its own security boundary, separate from the epoch. The Host authenticates
the complete raw descriptor JSON before one domain parse, so defaults, trimming and filtering cannot
change what was signed. Mixed or missing proof formats get an update refusal; there is no v1
verifier. Agent Phones older than format 2 need one update over USB, because their old proof cannot
authenticate to the network update channel.

### Active compatibility gates

Upgrade Hosts before Runners that need new execution or storage semantics; Personal ships both
together. Enrollment is not execution admission: a Runner missing a mandatory execution gate stays
visible but cannot execute, and an outdated module gets an update refusal while the computer's other
modules stay available. A refused durable event ends only its still-bound Run.

Ship the Account's notification preview reader on every replica before phone builds that register
preview keys. An older Account rejects previews and the Host resends a generic alert, so the wrong
order costs previews, not alerts. Privacy rules are in [Mobile](mobile.md).

## Owner-view authority

Owner views are ephemeral and independent of Run sessions. Only effective machine owners can open,
list, renew or watch connected, unblocked, approved apps and phones; approval is checked at
admission and at delivery, and opening a display socket never extends a lease. An ended view never
renews or silently reopens, and ending it leaves task grants, holds and observations alone. Native
owner authority ends on Host restart and is never restored. Lease and retention rules are in
[Computer use](computer-use.md). Computer app approvals use authenticated owner sessions on every
device, and only the Host admits local MCP launches against current owner consent.
