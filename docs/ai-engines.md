# AI engines, accounts, and sources

## Account ownership and selection

The Runner owns credentials; the Host owns account metadata and defaults. A temporary sign-in or
catalog failure never moves an account's default or silently picks another account. Delegation
inherits the parent's engine, source and exact model unless overridden; an ambiguous account is a
refusal ([delegation placement](../apps/host/src/agents/delegation-placement.ts)). The matched live
catalog supplies the native model ID, never client input, and creation, delegation and dispatch
validate against the executing account without substituting a model or option
([model selection](../apps/host/src/agents/model-selection.ts)). Retired option IDs still reach the
driver. An unavailable remembered selection stays visible with its reason, later preferences never
rewrite an existing Thread, and accounts never invent model defaults.

## Automatic model selection

Work a person didn't place by hand (naming, memory passes, specialists, empty-choice defaults) goes
through one [resolver](../packages/core/src/model-candidates.ts). It preserves declared preferences,
considers authorized configured accounts, and treats usage exhaustion as advisory ordering, because
cached readings can be wrong. An eligible original stays once, last. Eligibility and endpoint checks
always prevail, so a switched-off account stays off even for a task's own model. Selection never
replays accepted or uncertain work: naming may advance after a contained generation failure, while
memory and specialists choose before admission and freeze that choice. Admission checks the account
revision it resolved under the account's row lock, and refuses a changed endpoint rather than adopt
it: a specialist reports the error, and a memory pass resolves again at its next wake. From then on
the account's queued Run holds the endpoint, because its config can't change under one. The person's
list and excluded accounts are the only consent; an unbound entry never reaches an
`openai-compatible` account, and a manifest can't bind one. Runs record no account revision, so
naming's fallback to a task's own model skips such an account: it may no longer be the endpoint that
saw the request. Client empty-choice defaults use only accounts bootstrap reports as
`automaticEligible`, which the Host computes per viewer. This differs from T3, which reaches other
accounts only after a known exhaustion: here declared order holds, default account first within each
entry.

## What a driver declares

Declarations live in [harness-catalog.ts](../packages/core/src/harness-catalog.ts), contracts in
[types.ts](../packages/harness/src/types.ts). Keep driver imports out of client-bundled core. Launch
Node through `HarnessDriverRuntime.nodeExecutable`, because Desktop's `process.execPath` is
Electron. Thread access modes and SSH machine-access modes are separate contracts, and a mode falls
back only to a stricter one. OpenCode, Pi and Cursor cannot implement the routine-action approval
mode. OpenCode's child-session permissions must stay routable to a person before child execution is
on.

Source fields are nonsecret metadata: reject URL credentials and fragments, which would be stored or
logged in clear. Managed secrets enter through `secret-input`, travel once from Host to Runner and
are stored by the driver.

### Models served by a model server

Discovery contacts only loopback, on native-user Runners, and never sends a stored key. A fake
listener can imitate a server, so importing oMLX's key needs the person's explicit action, and the
key never returns to Host or client; prefer its sub key and never read `secret_key`, which grants
admin login. A rejected stored key never falls back to anonymous access. Pi loads custom models only
with an `apiKey` in `models.json`: use an inert placeholder there and keep real keys in `auth.json`.
An unknown context limit makes a model unavailable, never guessed; theoretical context fields are
not served limits ([model-servers.ts](../packages/harness/src/model-servers.ts)).

## What a driver reports

A settled sign-in-required catalog is a normal result, not a retry loop, and CLI sign-in changes
need explicit refresh, never a timed cache. An unlistable or oversized catalog fails rather than
publishing another source or a partial list. Transient provider retries stay working, not waiting
for a person. Capacity exhaustion uses the shared `harness_usage_limit` classification. Antigravity
reports a failed model call as reply text with a normal `end_turn`; only its stderr markers show the
failure, so its driver classifies from them and drops the echoed reply.

Report usage before terminal events, even on interruption. Costs are list-price arithmetic, not
subscription charges; never invent prices or show an unknown zero price as free. Root usage includes
native subagents. Codex reports cumulative thread totals across warm Runs and resume, so count only
growth for this Run's turns, without recharging history after compaction resets.

## Engine releases and new models

Use [upgrade-engines](../.agents/skills/upgrade-engines/SKILL.md) to bump pins, qualify real
accounts or add a model. Engine catalogs are authoritative: forcing an unlisted Claude model can run
it with wrong context and output limits. Codex's server filters models by client version, Claude
compiles its list and Pi bundles a snapshot; OpenCode and installed Cursor discover models alone.

Own-sign-in Codex, Claude and Cursor accounts run the person's installed CLI, so credentials and
executable come from one installation; never substitute shipped bytes when it is missing. Shared
Runners use shipped engines only. Installed minimums move only when driver compatibility requires it
([registry](../packages/harness/src/registry.ts)). Installed-engine updates resolve ownership from
the real executable (a Homebrew Node formula does not own an npm global) and give guidance rather
than guess; they fence affected Runs and sign-ins first, and their output is never published, since
an updater may echo its environment
([engine-installation.ts](../packages/harness/src/engine-installation.ts)).

Antigravity is neither shipped nor taken from `PATH`: its driver downloads Google's pinned archive,
verifies it and publishes an immutable SHA-256-addressed release
([pin and reason](../packages/harness-antigravity/src/release.ts)). Codex enables only approved
[features](../packages/harness-codex/src/features.ts), and a configuration forcing an unapproved one
refuses the Run. Cursor's CLI MCP configuration has no per-server tool timeout, so the harness
writes only the server URL and authorization header and cannot pin a Cursor tool-call timeout.

## Shared Runner sandbox

OpenCode and Pi have no per-command sandbox and refuse shared (`isolated-service`) Runners. Cursor,
Grok, Antigravity and Muse Code refuse too, with their sign-ins and updates: their sign-ins live in
the service account's files or keychain, so a shared Runner would spend whichever person's plan it
holds, and Cursor API keys are no substitute because model commands can read the harness
environment. Never advertise a sign-in whose OAuth callback port a Runner cannot reach.

On shared Runners, per-command isolation keeps model commands from private credential state, and
Linux binds only this Run's profile, Thread state, Workspace roots and launch directory. Native-user
Runners omit both layers, because their owner owns the machine and credentials
([harness-sandbox.ts](../apps/runner/src/sandbox/harness-sandbox.ts)). Boot probes must prove
isolation, and Runner death must end inspection subprocesses too.

## Opensteer tools through the Runner

The Host builds each Run's tool plan, instructions and skills
([plan construction](../apps/host/src/agents/agent-tools-plan.ts)), and every engine configures one
`opensteer` MCP server from it; Runners never rebuild a tool list from their own release, and
`toolsRevision` is part of warm-engine identity. Engines never receive a Host token: the loopback
[credential proxy](../apps/runner/src/credentials/credential-proxy.ts) gives each Run a secret
usable only for its tool endpoints, never put on a command line and revoked on interrupt. Loopback
alone is no tenant isolation. Token refresh belongs to the Runner boot holding the Run; refusal ends
access, temporary unavailability does not
([Run tool authority](agent-orchestration.md#run-tool-authority)).

Claude defers Opensteer tool schemas through ToolSearch, which must stay available in every mode.
Its synthetic project root supplies loose skills without the real project settings, though CLAUDE.md
and `.claude/rules` can still load. An organization-managed Claude policy overrides Opensteer's
per-Run settings, so Opensteer's guarantees assume none. Plugin permission callbacks become Requests
in every access mode.

## Instructions and skills

Skills have unique full names (`plugin:skill`, or bare for loose Workspace skills); duplicates fail
the Run, and no layer shadows another. Instructions supplement the engine's system prompt and never
confer Host authority. Cross-tool routing stays in the Run guide so Claude can choose tools before
loading deferred schemas. On Codex resume, send current instructions through keyed turn context,
since startup instructions do not refresh an existing conversation
([skill-catalog.ts](../packages/harness/src/skill-catalog.ts)). ACP engines differ in resume and
cancellation, so each driver declares its own rather than inferring it from the ACP version.

## Thread names and symbols

Names and symbols have independent provenance: a late generated candidate never replaces a person's
choice, even an identical one. Chat is identified by `homeThreadId` and cannot be renamed through
ordinary Thread commands. Naming is Host-owned background work, so a Run's teardown and engine reuse
never wait on it ([thread-naming.ts](../apps/host/src/agents/thread-naming.ts)). Generation runs
contained with no tools, ambient instructions, hooks, plugins or history, using the exact model it's
given with no discovery. A result counts only for its live attempt on that Runner connection, and
the Host finds the Thread itself.
