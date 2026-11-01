# AI engines, accounts, and sources

## Account ownership and selection

The Runner owns credentials; the Host owns account metadata and defaults. Temporary authentication or catalog failures must not transfer an account's default or silently select another account. Delegation inherits the parent's engine, source and exact model unless explicitly overridden; ambiguous account selection is a refusal. See `apps/host/src/agents/delegation-placement.ts`.

Canonical model identity groups labels; the matched live catalog supplies the native model ID sent to the endpoint, never client input. Routing suffixes remain distinct. Creation, delegation and dispatch must validate against the account that will execute, without substituting a model or a listed option value. Retired option IDs still reach the driver for interpretation of saved selections. See `apps/host/src/agents/model-selection.ts` and `packages/client/src/host/model-catalog.ts`.

A remembered selection is a decision: keep an unavailable choice visible with its reason. Later preferences never rewrite an existing Thread. Engine defaults apply when the person leaves an option at default; accounts do not invent their own model defaults.

## What a driver declares

Use `packages/core/src/harness-catalog.ts` for declarations and `packages/harness/src/types.ts` for contracts. Keep driver imports out of client-bundled core. Launch Node through `HarnessDriverRuntime.nodeExecutable`, since Desktop's `process.execPath` is Electron.

Thread access modes and SSH machine-access modes are different contracts. A mode may fall back only to a stricter one; Antigravity's Auto mode uses its approval-prompting default mode. OpenCode, Pi and Cursor cannot implement Opensteer's routine-action approval mode. OpenCode's native child-session permissions must remain routable to a person; do not enable child execution without that path.

Source fields are nonsecret metadata. Reject URL credentials and fragments: credentials there would be stored or logged in clear and do not survive base-URL joining. Managed secrets enter through `secret-input`, travel once from Host to Runner, and are stored by the driver.

### Models served by a model server

Discovery contacts only loopback on native-user Runners; a port alone cannot identify a server. Discovery must never send a stored key automatically. The person's explicit local-import action may read oMLX's API key, validate it and store an account-owned copy, without returning it to Host or client. Prefer its sub key; never read `secret_key`, since the main API key also grants admin login. A fake listener can imitate health responses, which is why importing requires the person's action. Management authority includes the computer owner and Deployment administrators.

An endpoint without a stored key is tried without one; a rejected stored key must not fall back to anonymous access. Pi requires an `apiKey` entry in `models.json` to load custom models: use an inert placeholder there and keep real keys in `auth.json`. Avoid Pi's command/environment expansion prefixes in the placeholder.

Unknown effective context limits make a model unavailable, never guessed. Generic endpoint theoretical context fields are not served limits. Ollama's loaded context wins; otherwise its Modelfile `num_ctx` is usable, not theoretical `model_info`. Manual limits assert server configuration; they do not change it, and output headroom is not a complete prompt-size guarantee. Preserve native IDs and saved compatible-account model identities. See `packages/harness/src/compatible-endpoint.ts`, `packages/harness/src/model-servers.ts` and migration `0059_compatible_endpoint_model_identity` in `packages/database/src/migrations.ts`.

Discovery and local-import require Host API epoch 23; older Runners keep existing accounts working but cannot offer these capabilities. Host-first upgrades matter.

## What a driver reports

A settled authentication-required catalog is a normal result, not a background retry loop. External CLI sign-in changes require explicit refresh; drivers must not hide refresh behind timed caches. Catalogs and options come from the executing engine or endpoint; an unlistable or oversized catalog fails rather than publishing a different source or partial inventory.

Transient provider retries remain working, not waiting for a person. Only failures another send can overcome are retryable. Capacity exhaustion uses the shared `harness_usage_limit` classification; OpenCode's HTTP 429 and Cursor's text classification remain imperfect provider signals. See the driver implementations in `packages/harness-*`.

## Engine releases and new models

Use [upgrade-engines](../.agents/skills/upgrade-engines/SKILL.md) to bump pins, qualify real accounts or add a model. Engine catalogs are authoritative: forcing an unlisted Claude model can run it with incorrect default context/output limits. Codex's server filters models by client version, Claude compiles its list, and Pi bundles a snapshot; OpenCode and user-installed Cursor can discover new models independently.

Own-sign-in Codex and Claude accounts run the person's installed CLI, so credentials and executable come from the same installation. Never substitute shipped bytes if that CLI is absent. Shared Runners use shipped engines only. Exact shipped pins and installed minimum versions have different meanings; minimums move only when driver compatibility requires it. See `packages/harness/src/registry.ts` and `packages/harness/src/runtime-artifact.ts`.

Antigravity is neither shipped in a distribution nor resolved from the person's `PATH`. Its driver downloads Google's pinned archive into the Runner-owned runtime cache, verifies the complete archive and member manifest, then atomically publishes an immutable SHA-256-addressed release shared by that Runner's accounts. Version 1.4.1 remains pinned because 1.4.2–1.4.4 write a system skill into every Workspace.

Codex enables only approved features from `packages/harness-codex/src/features.ts`. New defaults must stay off until reviewed; effective configuration that forces an unapproved feature on refuses the Run.

## Shared Runner sandbox

OpenCode and Pi have no per-command sandbox and must refuse shared (`isolated-service`) Runners during both inspection and session creation. Cursor also refuses: its ambient keychain sign-in would spend whichever person's plan the service happens to hold. Cursor API keys cannot safely replace this because model shell commands can read the harness environment. Several upstream OAuth methods also require callback ports unreachable from a Runner; do not advertise a half-working sign-in.

On shared Runners, per-command isolation denies model commands access to private credential state. Linux additionally hides shared roots and binds only this Run's profile, Thread state, Workspace roots and machine-access launch directory. The outer sandbox does not replace protection from the model's commands. macOS Seatbelt cannot nest; native-user Runners omit both isolation layers because their owner owns the machine and credentials. See `apps/runner/src/sandbox/harness-sandbox.ts`.

Boot probes must prove isolation and required writes. Launches must match planned HOME/TMPDIR, use the launch wrapper even for machine-access probes, and keep Thread files in supplied state directories. Desktop's process supervisor must own inspection subprocesses too, even though no Run execution scope owns them; Runner death must end their process groups. See `packages/harness/src/process-supervisor.ts`.

## Opensteer tools through the Runner

Engines never receive a Host token. The loopback proxy gives each Run a secret usable only for its tool endpoints, forwards the current Host token, rejects arbitrary forwarding and redirects, and bounds requests. Never put its secret on a command line. Interrupt revokes it and closes streams immediately; Host grant revocation remains authoritative. Loopback alone provides no tenant isolation. See `apps/runner/src/credentials/credential-proxy.ts`.

Token refresh belongs only to the Runner boot holding the Run. Refusal ends access; temporary unavailability does not revoke it. Existing MCP sessions authorize each request with its current token; open shell/browser connections remain bound to the grant, not the original token's lifetime. Warm-engine relays serve one Run at a time and suspend between Runs. See [Run tool authority](agent-orchestration.md#run-tool-authority) and [Warm engines](agent-orchestration.md#warm-engines).

Claude defers Opensteer tool schemas through ToolSearch, which must remain available in every mode; disable ambient settings. Pi receives the Host's JSON Schema unchanged, including constraints and coercion semantics; Host validation remains authoritative.

## Instructions and skills

Workspace skills shadow integration skills; `opensteer-` belongs to bundled skills. Platform, role and capability instructions supplement the engine's system prompt and never confer Host authority. Keep cross-tool routing in the Run guide so Claude can choose tools before discovering their deferred schemas. MCP initialization must not repeat that guide.

Deliver skill discovery metadata rather than every body. Pi disables ambient discovery in favor of the resolved plan. On Codex resume, send current Workspace and Opensteer instructions through keyed turn context: changed startup instructions do not refresh an existing conversation. An absent Workspace file must clear prior instructions. See `apps/runner/agent-skills/skills`, `packages/harness/src/skill-catalog.ts` and each driver's protocol tests. Transport success alone does not prove model behavior.

## Thread names and symbols

Naming uses the selected account in a separate, contained process with no tools, ambient instructions, hooks, plugins or persistent chat history. Deny unexpected interaction requests. Its process must exit before containment teardown or engine reuse. Preserve the person's title/symbol independently; only provisional fields may change. Symbol negotiation must leave old title-only reports readable. See `packages/harness/src/thread-title.ts` and the drivers' title implementations.

OpenCode can retry refused naming calls indefinitely while reporting errors only in logs; stop at the first logged stream error. Claude's explicit session title prevents recursive automatic naming. Pi prompt overrides must suppress ambient SYSTEM/APPEND_SYSTEM files, and Cursor needs empty working/configuration homes plus tool-denying hooks.

## Usage

Report usage before terminal events, even on interruption. Engine costs are list-price arithmetic, not subscription charges; do not invent prices or present unknown zero prices as free. Root usage already includes native subagents. Codex reports cumulative thread totals across warm Runs and on resume: count only growth for turns this Run owns, handling compaction resets without charging the resumed history again. See the driver usage tests and `RunUsageSchema` in `packages/core/src/models.ts`.
