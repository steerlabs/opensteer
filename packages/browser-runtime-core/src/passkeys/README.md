# Page provider and bridge

The runtime injects a `PasskeyAuthenticator` only after Host negotiation.
The [Host flag and viewer routing](../../../../docs/browser-sessions.md#passkeys)
control production use; engine tests can inject a software authenticator.
Native WebAuthn remains disabled in both modes, including uncovered frames.

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

Conditional mediation rejects with `NotSupportedError`. Silent mediation rejects
with `NotAllowedError` before reaching the bridge, because any ceremony may show
the OS passkey sheet.

Popup first HTTPS documents support immediate registration and sign-in. Initial
blank-derived documents remain ineligible after writing or history rewriting;
writing an already eligible document preserves its eligibility.

Hosted Chromium probes visible Security events once at startup when an
authenticator is supplied or the production launcher requests the probe. Full Chromium in new-headless mode supports the
provider. Executable overrides to Headless Shell keep the absent policy and omit
`modules.browser.passkeys`; one fixed diagnostic explains the unavailable engine
capability without failing launch.

Late-attached top-level main worlds require ordered frame, loader, history-entry
and context-unique-ID snapshots around that session's first Security enable.
Only secure TLS evidence with a certificate chain sampled in an unchanged
invalidation generation grants eligibility. Cached or unassociated events never
grant it, and duplicate enables are not retried. Navigation, context changes,
same-document changes and activation/restoration events invalidate sampling.
Electron reserves its hub subscriptions and installs the bridge before attachment,
then dispatches the initial domains without awaiting renderer replies. The hub
keeps its single Runtime inventory and serialized ownership accounting.

Electron preserves site policy for supported documents and denies foreign
subframes. Authenticator outcomes must retain their signed client-data bytes
verbatim. A private dependent abort signal must still observe cancellation when
page listeners stop propagation. Options, RP ID and encoding rules live in the
shared core and its tests.

Only one ceremony can be pending per tab. Abort, context destruction, page close,
session loss and bounded timeouts cancel its signal, including when an
authenticator ignores cancellation. Errors carry fixed messages and never include
credential material. The Host relay implements the same authenticator port;
desktop main holds the request and reaches the OS manager.

The relying-party test independently verifies registration/assertion. Fixture TLS
identity is public; trust exceptions must stay confined to pinned test launchers,
never production. See `../test-support/passkey-provider-scenario.ts` and
`../browser/page-policy.ts`.
