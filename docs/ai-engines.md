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

Work the person did not place by hand uses the shared
[resolver](../packages/core/src/model-candidates.ts). Declared preferences and authorized account
eligibility decide; cached usage exhaustion only affects ordering. The Host computes eligibility
for the viewer, and an unbound preference never reaches an `openai-compatible` endpoint.

Selection happens before admission and freezes the endpoint for accepted work. Account changes
must not silently redirect it. Naming can advance after a contained generation failure; memory and
specialists never replay accepted or uncertain work on another account.

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

What a native subagent says, thinks and calls is reported against its node through
[`SubagentNodes`](../packages/harness/src/subagent-nodes.ts), never as the Run's own. An event a
driver cannot tie to a child belongs to the Run, never to a guessed child. OpenCode may run custom,
nested and background subagents only because each child session is given its parent's permission
rules, seeded with deny-all and keeping only the child's own refusals
([`opencodeChildPermissionRules`](../packages/harness-opencode/src/configuration.ts)); that holds
while project-level OpenCode config stays disabled. A Claude Workflow member's transcript is read
only inside the Run's own session directory
([workflow-transcript.ts](../packages/harness-claude/src/workflow-transcript.ts)). Replay tests
prove attribution; only `pnpm test:engines` proves a workflow's processes stay inside the Run's
containment.

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

A new private Codex account starts Codex once on its empty home, then links the shared session store
([materializeOnce](../packages/harness-codex/src/codex-driver.ts)). Codex blocks `initialize` while it
indexes the store it finds at first start, which can block adding an account. A resume finds an
unindexed session by file search, so linking the store after initialization loses nothing. A Codex release that opens a new state database re-indexes linked
homes; that is what the `preparing` state is for.

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
Linux binds only this Run's profile, Thread state, task folder roots and launch directory. Native-user
Runners omit both layers, because their owner owns the machine and credentials
([harness-sandbox.ts](../apps/runner/src/sandbox/harness-sandbox.ts)). Boot probes must prove
isolation, and Runner death must end inspection subprocesses too.

## Opensteer tools through the Runner

The Host builds each Run's tool plan, instructions and skills
([plan construction](../apps/host/src/agents/agent-tools-plan.ts)), and every engine configures its
MCP servers from it; Runners never rebuild a tool list from their own release, and
`toolsRevision` is part of warm-engine identity. Engines never receive a Host token: the loopback
[credential proxy](../apps/runner/src/credentials/credential-proxy.ts) gives each Run a secret
usable only for its tool endpoints, never put on a command line and revoked on interrupt. Loopback
alone is no tenant isolation. Token refresh belongs to the Runner boot holding the Run; refusal ends
access, temporary unavailability does not
([Run tool authority](agent-orchestration.md#run-tool-authority)).

Codex Request tools use a second server so the model calls them directly: code-mode cells can
otherwise yield while the Request is held and let the model keep acting. `longRequestHold` requires
an explicitly configured MCP deadline above the Host hold limit (both Pi deadlines), plus real-account
qualification through the production transport: one invocation must survive the old deadline and
return an unpredictable marker in that same result. Codex must also prove direct invocation and no
other tool activity during the hold; source inspection alone does not qualify the behavior.

Claude defers Opensteer tool schemas through ToolSearch, which must stay available in every mode.
Its synthetic project root supplies loose skills without the real project settings, though CLAUDE.md
and `.claude/rules` can still load. An organization-managed Claude policy overrides Opensteer's
per-Run settings, so Opensteer's guarantees assume none. Plugin permission callbacks become Requests
in every access mode.

## Instructions and skills

Skills have unique full names (`plugin:skill`, or bare for loose folder skills); duplicates fail
the Run, and no layer shadows another. Instructions supplement the engine's system prompt and never
confer Host authority. Cross-tool routing stays in the Run guide so Claude can choose tools before
loading deferred schemas. On Codex resume, send current instructions through keyed turn context,
since startup instructions do not refresh an existing conversation
([skill-catalog.ts](../packages/harness/src/skill-catalog.ts)). ACP engines differ in resume and
cancellation, so each driver declares its own rather than inferring it from the ACP version.

## Thread names and symbols

A generated name or symbol never replaces a person's choice, even an identical one. Naming runs
contained without tools, ambient instructions, plugins or history, and never delays Run teardown
or engine reuse ([thread-naming.ts](../apps/host/src/agents/thread-naming.ts)).
