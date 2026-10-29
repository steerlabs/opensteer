# Page provider and bridge

Production launchers have no authenticator and keep the absent WebAuthn policy.
An optional `PasskeyAuthenticator` enables the page provider for engine tests.
Native WebAuthn remains disabled in both modes, including uncovered frames.

`installBrowserPagePolicy` is the single serialized installer. Playwright installs
it with the context init script; Electron uses a main-frame session preload for
first documents and the debugger's new-document script for frames and later
documents. Installation is idempotent. Calls wait at most three seconds for a
callable binding, then reject with `NotAllowedError`.

Each isolated browser context gets a random 256-bit binding name. Context scope
covers Playwright popup scripts that run before page discovery and Electron popup
preload preferences inherited before a page wrapper exists. A provider captures
the binding on its first call and removes the global. The independent reply slot
is non-writable. The bridge always targets the caller's context `uniqueId`; numeric
context IDs and page-supplied origins never authorize delivery.

There is one bridge per tab on its platform CDP session. Electron supplies the
hub's existing execution-context inventory and reference-counted Runtime enable.
The bridge normally pins eligibility to a main-world context created for or
retained through an observed `Page.frameNavigated` HTTPS commit, with secure document-response TLS
pinned by frame and loader ID. The hosted late-attachment exception below requires
fresh browser security evidence; URL and history snapshots alone never grant it. Missing TLS status or certificate errors refuse the request. The page's
visible Security state supplies an additional refusal signal when the engine
exposes it; it never grants eligibility. These domains use the platform session's existing ownership. The bridge
also refuses opaque and insecure origins, foreign ancestors, and denied or
unknown Permissions Policy.

Popup first HTTPS documents support immediate registration and sign-in. Initial
blank-derived documents remain ineligible after writing or history rewriting;
writing an already eligible document preserves its eligibility.

Hosted Chromium probes visible Security events once at startup when an
authenticator is supplied. Full Chromium in new-headless mode supports the
provider. Executable overrides to Headless Shell keep the absent policy and omit
`modules.browser.passkeys`; one fixed diagnostic explains the unavailable engine
capability without failing launch. Production still supplies no authenticator.

Late-attached top-level main worlds require ordered frame, loader, history-entry
and context-unique-ID snapshots around that session's first Security enable.
Only secure TLS evidence with a certificate chain sampled in an unchanged
invalidation generation grants eligibility. Cached or unassociated events never
grant it, and duplicate enables are not retried. Navigation, context changes,
same-document changes and activation/restoration events invalidate sampling.
Electron reserves its hub subscriptions and installs the bridge before attachment,
then dispatches the initial domains without awaiting renderer replies. The hub
keeps its single Runtime inventory and serialized ownership accounting.

Electron preserves site policy for provider-supported documents and adds its deny
header to foreign subframes. The shared core validates options, resolves the RP
ID and serializes client data. Authenticator outcomes retain their own signed
client-data bytes verbatim. Binary fields have separate bounds from text fields;
a 1,024-byte challenge and native attestation data are supported. JSON parsers use
`EncodingError` for malformed base64url and `TypeError` for dictionary errors.
`toJSON()` encodes the currently exposed buffers into fresh objects. A captured
private dependent abort signal observes cancellation even if page listeners stop
propagation on the original signal.

Only one ceremony can be pending per tab. Abort, context destruction, page close,
session loss and bounded timeouts cancel its signal, including when an
authenticator ignores cancellation. Errors carry fixed messages and never include
credential material. There is no Host transport, production authenticator, user
interface or rollout switch here.

The shared HTTPS relying-party scenario runs against the software authenticator
in headless Playwright and the disposable Electron VM. The server independently
verifies registration and assertion with SimpleWebAuthn. The fixture TLS identity
is public and trusted through its pinned SPKI in Playwright and a certificate
verify proc confined to the Electron smoke launcher.
