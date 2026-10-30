# AI engines, accounts, and sources

How a Thread selects an engine, account and model, and how the Runner executes
that selection. The code and tests define current behavior.

## Five parts

| Part        | What it is                                                                                                                                   | Who owns it                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Model**   | A lab's model, named by the pair `(providerId, modelId)` — `openai / gpt-5.6-luna` — wherever it is served from.                             | `packages/core/src/model-registry.ts` folds foreign spellings onto the pair. |
| **Engine**  | The harness that executes a turn: Codex, Claude Code, OpenCode, Pi, Cursor. A `HarnessDriver` in `packages/harness`.                         | The driver package, on the Runner.                                           |
| **Source**  | Who an account talks to and is billed by: the lab itself, a compatible endpoint, a cloud identity, a hosted gateway. Declared by the engine. | `HarnessDriver.sources`, advertised in `RunnerHarnessDriver.sources`.        |
| **Account** | One sign-in of one engine on one work location, for one source. A `harness_instances` row: name, `source_id`, `state_kind`, `is_default`.    | The Host, durably.                                                           |
| **Route**   | A model plus an account that can run it. Derived on the client from the accounts' catalogs; never stored.                                    | `packages/client/src/host/model-catalog.ts`.                                 |

The person only ever chooses an account. How it is funded is reported by the
driver, never configured in the UI beyond the sign-in step.

The composer shows one execution control: the engine's mark and, in words,
the engine, the model and its reasoning level (speed only once it differs from
the default). An account pill joins it only while the engine has more than one
account, and an access pill only for a mode other than the default Full access
or one the engine cannot enforce. A narrow row gives these up whole, in order —
account pill, access pill, work location, reasoning words, engine name, the
menu's chevron — then shortens the model's name to a readable floor and finally
leaves the engine's mark alone; it never squeezes a setting into a mark beside
another or wraps to a second line. In a conversation's composer the field keeps room for its
plain placeholder whole ("Ask Opensteer…", or a recipient's first nine
characters), given up only when Attach, the control, Stop and Send could not
otherwise keep their place; a placeholder with too little room is shortened
behind one ellipsis, never clipped.

The control's menu holds everything: engines, then the browsed engine's
accounts, then one account's models, and at its foot the settings of the
choice in force (each model option, and the access mode), each opening its
choices in the menu's place. Browsing changes nothing until a model is picked.
The same model through two engines, two sources or two accounts is two routes
and is listed as two; search returns every route that matches. A local model
server is an account of the engine that talks to it, never an engine.
Changing account keeps the model when that account offers it, otherwise the
model last run there, otherwise its default.

Lab attribution never changes the id sent to an engine. Cursor's first-party
Composer, Cursor Grok and Auto entries belong to the Grok group (`xai`), its
third-party models keep their own labs, and Cursor remains the engine and
account name; unknown families stay under their source until their maker is
known. Bedrock's `-v1:0` folds away, being a spelling of one model rather than a
choice between routes, where a routing suffix is not. Lab marks ship locally, so
opening a picker makes no asset requests to those providers.

## Account ownership and selection

The Runner owns credentials; the Host persists account names, source ids,
enabled state and defaults. Each `(environmentId, driverKind)` pair with enabled
live accounts has exactly one default. A partial unique index and the environment
row lock protect that choice. Removing or disabling the default transfers it
to the oldest enabled survivor; temporary authentication, connection or catalog
failures never transfer it. An unavailable selected account stays unavailable.

New delegated work carries the delegating Thread's engine, source and exact
model unless the caller names an engine profile (`harnessInstanceId`) or a
`model`; `apps/host/src/agents/delegation-placement.ts` owns this one rule for
agents, Triggers and watches. A named choice is admitted like a person's own
choice, against the live catalog of the account that runs it, and a refusal
lists what that account offers; nothing is switched silently. Without a named
account it uses the parent's account when eligible, then the destination pair's
stored default. An unresolved choice among several accounts is an explicit
refusal naming the candidates, not an ordering-based fallback. `environment_list`
shows agents the default a new task inherits and a bounded page of available
profiles. Follow `harnessesNextCursor` to discover every profile; each includes
its environment ID. A profile's first models are shown in the broad list. To
discover all of its offered models, call `environment_list` with
`harnessInstanceId` and follow `modelsNextCursor`. A model cursor is
bound to that profile's catalog and is rejected if its models or readiness
change; start that profile's listing again. Delegation checks the current
catalog at admission. A task's line names its latest Run's model, in its tooltip and accessible
name, when it differs from the assigning Run's pinned model; Trigger and watch tasks always name it.

Canonical `(providerId, modelId)` pairs group models; the selected catalog
descriptor's `nativeModelId` preserves the endpoint's spelling. The Host copies
it from the matched descriptor, never from client input, and the driver sends
`nativeModelId ?? modelId`. Routing suffixes identify distinct models.
`packages/client/src/host/model-catalog.ts` owns choice and labels;
`thread-placement.ts` owns placement availability. Catalog refresh policy lives
in the orchestration code; `harness.catalog.refresh` explicitly warms an account.
A descriptor's optional `acceptsImages` says whether the model takes image
input, filled by each driver from its own catalog source and absent when that
source does not say; the Host treats absent as false, so an MCP image block is
delivered only when the driver renders MCP images and the selected descriptor
says `true` (see [Computer use](computer-use.md) §4).

## What a driver declares

[`harnessCatalog`](../packages/core/src/harness-catalog.ts) is the engine list;
the Runner's typed factory map and packagers derive from it. Keep driver imports
out of `packages/core`, which clients bundle. Launch engine Node programs with
`HarnessDriverRuntime.nodeExecutable`: `process.execPath` is Electron when
Desktop embeds the Runner. Declared `accessModes` govern Thread execution and
differ from the catalog's `machineAccess.accessModes`, which govern SSH relay
access. The Host must refuse an unsupported mode rather than substitute one.
Clients never substitute one either: a draft whose engine cannot enforce its mode
blocks sending until the person picks another, and moving a Thread to such an
engine asks for a mode it enforces, applied before the engine changes.

A `HarnessSourceDescriptor` per source, static and driver-owned:

- `sourceId` — the provider id the account talks to: a lab's id for a
  first-party source, otherwise what it is (`openai-compatible`, `bedrock`).
- `kind` — `first-party`, `compatible-endpoint`, `cloud-identity`, or `gateway`.
  Settings uses it for copy and for naming a new account.
- `fields` — what a person must type to add an account. Never a secret.
- `quota` — `windows` when the source can report plan windows, `none` when a
  usage bar would be a lie (keys, local runtimes).
- `stateKinds` — whether an account may share the CLI's own sign-in (`ambient`)
  or must hold its own (`isolated`).

Codex and Claude Code translate all four `ThreadAccessMode` values explicitly.
OpenCode, Pi and Cursor declare three and leave out `auto`, because `auto` means
"approve routine actions, ask before anything else" and none of the three makes
a routine/non-routine judgement a driver could route through: OpenCode's rules
are per tool and per glob with nothing in between, and Cursor's own classifier
mode decides alone, with no channel that could ask a person. OpenCode's `task`
tool is denied in every mode: a subagent asks for permission and answers on its
own child session, which no person can be shown yet, so its Run would wait
forever.

The first declared source is what a work location's seeded account gets. A `url`
field is an http or https address and nothing more: one carrying a username,
password, or fragment is refused, because none of the three survives the join a
driver performs onto that base, and a credential inside one would be stored and
logged in clear. Nothing else about a source reaches the Host. A secret has one
path in — the `secret-input` setup method carries the value once, Host to
Runner, and the Runner writes it where the driver says.

### Models served by a model server

Model servers — Ollama, LM Studio, oMLX, or any server with an OpenAI model
list — have their own card in AI services, above the engines. Their accounts
are listed there, under the server they talk to, rather than under OpenCode or
Pi; the engines' own add dialogs do not offer the Model server source.

The Runner finds them. `harness.modelServers.discover` asks the work location's
computer (Runner capability `model-server-discovery-v1`, native-user Runners
only) which servers it has, reading where each app keeps its own settings and
contacting only `127.0.0.1`
([`model-servers.ts`](../packages/harness/src/model-servers.ts)):

| Server    | Where it listens                                                                                           | What names it                          |
| --------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| oMLX      | `settings.json` under `OMLX_BASE_PATH`, the app's `base-path` pointer, or `~/.omlx`; port 8000 without one | `GET /health` with an `engine_pool`    |
| Ollama    | 11434, when `~/.ollama` exists                                                                             | `GET /api/version` with a `version`    |
| LM Studio | `.internal/http-server-config.json` in its home (pointer, legacy or `~/.lmstudio`); port 1234 without one  | `GET /lmstudio-greeting`, or 401 there |

A port proves nothing about who listens on it, so a server is named by what it
answers, asked at the root its API hangs from (a gateway's path prefix kept).
Each found server reports `ready`, `needs-key`, `not-running` (installed,
nothing answering), or `unavailable` with the reason, and how many chat models
it lists and could run now when that can be read. Nothing the Runner does on its
own sends a key: an oMLX whose settings hold one is counted from its `/health`,
and its list stays behind the key until the person connects.

Connect creates an account of Pi — it can be steered mid-run — for that base URL
and runtime, and only Pi: when Pi cannot run there, Connect says so rather than
quietly using another engine. "Add a server" asks the computer what answers at a
typed address, offers every engine that can talk to it, and lets the person name
the server type when it did not say. The card creates nothing for an address
that did not answer. The URL is resolved from the Runner computer, so
`127.0.0.1` means that computer.

Both engines treat keys the same way. With no stored key, inspection asks the
server for its models without one: a server that answers is ready with
`authKind: "none"` and nothing to sign out of, and one that answers 401 or 403
reports `authentication-required`. A stored key is always sent, and a 401 or
403 with it reports that the server rejected the key. Session start follows the
same rule.

oMLX's Mac app always sets an API key and keeps it in its own settings. When the
account's base URL is this computer's oMLX — a loopback host on the port its
settings name, answering `/health` as oMLX — the refusal offers a `local-import`
setup method first ("Use oMLX's key"): one click, nothing typed. The Runner
checks the key against the server, then stores it where a pasted key goes, so it
is the account's own from then on; a sub key is used when oMLX has one, because
the main key is also oMLX's admin login, and `secret_key` is never read. The key
never reaches the Host or a client. The `/health` check names the listener but
does not authenticate it: a process that imitates oMLX on that port while oMLX
is stopped could receive the key the person chose to send, as it could a pasted
one, which is why only the person's click sends it. Connect runs that method
itself. If oMLX's key changes, the account reports the stored key rejected and
offers the method again. As with a lent computer's own CLI sign-ins, this is
open to whoever may manage that computer's AI engines: its owner and the
Deployment's administrators.

Pi loads a custom provider's models only when `models.json` names an `apiKey`,
so the driver writes a fixed placeholder there. A keyless server ignores it; a
stored key in `auth.json` under the same provider ID replaces it; and the
placeholder has neither the leading `!` nor the `$` that Pi would resolve as a
command or environment variable. A real key therefore never goes in
`models.json`. The
[`0059_compatible_endpoint_model_identity`](../packages/database/src/migrations.ts)
migration preserves the previous model identity on existing Pi and OpenCode
compatible accounts so saved Thread selections continue to resolve. New
accounts use the canonical model identity while retaining the native ID for
requests.

Some endpoints list model IDs without usable context limits. Their models stay
visible but unavailable for a Run until a person supplies the effective context
window for each native model ID. A supplied maximum output limit must be below
that context window. Opensteer keeps the endpoint's exact model ID for requests
even when the picker groups it under a canonical model name. The endpoint's
model list and supplied limits describe different facts: a guessed limit is
never substituted for one the endpoint did not report.
For a generic OpenAI-compatible list, only `served_context_window` and
`max_model_len` count as served context; `context_length` and
`max_context_length` may describe a model's theoretical capacity and are not
used as its configured runtime ceiling. The 256-token space between output and
context limits is a basic validity check, not a complete prompt-size guarantee:
system instructions and tools also use context, and generic endpoints may not
share an exact tokenizer. Choose a context limit large enough for those inputs.
If discovery cannot establish a usable route or limit, the model remains
unavailable rather than falling back to another source.
Ollama's `/api/ps` reports the context of a loaded model, and that value wins.
For a model that is not loaded, a `num_ctx <integer>` line in the `parameters`
that `/api/show` returns is the context Ollama will load it with for
OpenAI-compatible requests, so Opensteer uses it. `model_info` context lengths
describe theoretical capacity and are ignored. Without either, set the actual
configured context for that native model ID. Opensteer does not change the
Ollama server's context setting: a manual value for an unloaded model is the
account owner's assertion, while a served context bounds it. A catalog marks
`needsContextWindow` on a model whose only blocker is an unknown context.
Inspection reads every Ollama model; an OpenCode session start calls
`/api/show` only for the selected model. Pi still reads the whole catalog,
because concurrent Pi sessions share one `models.json`.

Model server discovery and `local-import` require Host API epoch 23. Upgrade
the Host first, then update and reconnect each Runner; until then an older
Runner's card says to update it, and its existing server accounts keep working.

Desktop supplies its verified native containment executable to its supervised
Node processes through `OPENSTEER_PROCESS_SUPERVISOR_EXECUTABLE`.
[`spawnSupervised`](../packages/harness/src/process-supervisor.ts) uses that owner
for harness subprocesses, including catalog inspections: each gets a private
control pipe, and the native owner ends its process group when the Runner dies.
Grace timers are unreferenced, so a server that already exited does not keep its
Runner alive until an obsolete grace timer expires. Inspection subprocesses are
owned even though they belong to no Run's execution scope.

## What a driver reports

`authentication-required` is a normal, settled inspection result, including
when sign-in belongs to the person's CLI or cloud identity. The driver supplies
instructions in `detail`; an empty `setupMethods` means Opensteer cannot perform
that sign-in. Only advertised setup methods require `authenticate`. Pickers keep
the engine visible with its sign-in reason and offer managed sign-in only for
those methods. "Check again" explicitly refreshes an externally signed-in engine.

Background convergence never retries a valid, settled catalog that needs sign-in,
even when its capture is old. Ordinary reads retain that state on the current connection;
profile revisions, authentication actions, Runner invalidations/reconnects and
explicit refreshes discard the superseded durable answer before recapture. If
recapture fails, ordinary convergence requests a fresh answer until one commits.
A CLI install, sign-in or configuration changed outside Opensteer can be discovered
with "Check again" in web/Desktop and both Expo account pickers, or Settings' model
refresh. Expo refreshes an external sign-in; it does not perform managed sign-in.
Drivers must not hide those requests behind their own timed caches.
Ready catalogs still converge every thirty minutes; unexpected inspection
failures remain errors and can be retried by convergence.

`inspect` answers for one account: its catalog, its connections (`authKind`, an
`accountLabel` when the provider knows who the person is, a `billingLabel`,
usage windows when the source has them), and the setup methods that could sign
it in. Inventories come from the engine itself — OpenCode's provider API, Pi's
available-model RPC, Cursor's print-compatible CLI listing, the selected
endpoint's `/models` — and never from a bundled list: a source that cannot be
listed is reported `unavailable` with the reason, because a catalog for the
wrong source is worse than none. The limit is 8,192 models per account against
the Runner's 1 MiB serialized frame, and an oversized answer reports an account
error rather than publishing a partial list.

A model's options — reasoning level, Codex's speed tiers, Claude Code's fast
mode — are the ones its engine lists for it, with the engine's own default.
Claude Code lists reasoning levels but not the one it uses unasked, so its
driver adds a `default` choice, preselected, that sends no level; Codex's
`default` speed is likewise standard speed. An account stores no model
or option defaults of its own; the engine's `isDefault` is the default.
Creating a Thread, changing its execution, delegating it and dispatching each
Run all hold the selection to one rule
([`model-selection.ts`](../apps/host/src/agents/model-selection.ts)): the
canonical pair must be listed and every value for a listed option must be one
its descriptor accepts. Creation and execution changes also reject unknown
option ids. Dispatch checks the live catalog of the engine release that will
run the selection, and takes `nativeModelId` from that catalog again.

If the engine retires a Thread's model or a chosen value of a listed option,
the Run fails with a message naming the unavailable choice. The person must
choose an available model or value before continuing. An option the person
left at its default follows the engine's current default on each Run.
Dispatch and delegation carry option ids the catalog no longer lists to the
driver, which owns their meaning; Cursor uses this for older saved option
tuples. They never substitute another model or listed value.

`billingLabel` is emitted only when it says something `authKind` does not — a
plan name, a lab whose key this is, a credit arrangement. "API key" beside
`authKind: "api-key"` is not a label, so no driver sends one and no reader
suppresses one: what arrives is shown.

A usage window may carry a `scope`. Absent — and everything a driver reports
today is absent — means the account as a whole. `{kind: "model", providerId,
modelId}` is a limit the provider states for one model only, and a reader with a
model in hand counts only the windows that could constrain it; a reader listing
the account itself, such as settings, counts them all. Codex's
`account/rateLimits/read` names no model on a limit, so it reports the
account-wide primary and secondary windows and nothing else.

Every engine retries a transient provider failure itself, within its own
budget, and a Run it is retrying is still working: no driver reports that as
`waiting`, which means a person or a Request is needed. A Run that failed is
marked `retryable` only when sending again can get past it, such as capacity,
rate limits, provider faults or transport failures the engine gave up on.

A Run that failed because the account has no capacity left reports the shared
`harness_usage_limit` code rather than a provider word, which is what lets the
web offer a compatible account instead. Each engine says it its own way:

- **Codex** sends `usageLimitExceeded` as the turn's `codexErrorInfo`, the
  camelCase wire name its app-server protocol uses for an exhausted plan,
  quota or a plan without usage.
- **Claude Code** states a subscription's remaining capacity as a status, and
  `rejected` is the plan refusing further work.
- **OpenCode** has no rate-limit error type of its own: it retries, then reports
  the upstream provider's own HTTP status, and a `429` on the failing turn is
  read as the limit. The driver marks that reading unverified in a comment.
- **Pi** surfaces a failure only as free text, so the driver carries Pi's own
  non-retryable classifier — the words Pi itself treats as a spent plan, such as
  a monthly limit reached, an exhausted balance, or a billing refusal — copied
  from the release it is pinned to.
- **Cursor** exits non-zero with text, and the driver reads a usage- or
  rate-limit phrase in it as the limit. The account never hit its cap in
  testing, so the driver marks this one untested in a comment too.

## The five engines

Five drivers ship, in catalog order. Every cell is a reading of that driver's
`sources`, `accessModes` and `capabilities`. Attachment delivery follows each driver's advertised
file/image capabilities, and every engine can be interrupted and resumed. Browser pages, Mac apps
and phones are structured references projected to readable text through the common
[input projection](../packages/harness/src/input-projection.ts), including inputs, reports,
steers. Initial conversation history carries the same references as serialized JSON
records in the common initial-context path. They do not require engine-specific attachment support.
The Host requires `browser-page-input-v1` or `native-place-input-v1` from the Runner before sending
those part kinds.

| Engine          | Sources                                                                                               | Access modes     | Steer / ask a question | Runtime                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------- | ---------------- | ---------------------- | ------------------------------------------------------------------------- |
| **Codex**       | 2: `openai` (the only source anywhere reporting plan windows) and `openai-compatible`                 | all four         | yes / yes              | `tree`, run from `codex/bin/codex`; own sign-in runs the person's `codex` |
| **Claude Code** | 4: `anthropic`, plus the cloud identities `bedrock`, `vertex`, `foundry`                              | all four         | yes / yes              | `file`, `bin/claude`; own sign-in runs the person's `claude`              |
| **OpenCode**    | 15, all `isolated`; `openai-compatible` asks for a key only when the server refuses                   | three, no `auto` | restart / yes          | `file`, `bin/opencode`                                                    |
| **Pi**          | 18, one per Pi provider; `ambient` or `isolated`; `openai-compatible` isolated, keyless like OpenCode | three, no `auto` | yes / no               | `script`, a tree run with the Runner's Node                               |
| **Cursor**      | 1: `cursor`, a `gateway`, `ambient` only                                                              | three, no `auto` | restart / no           | `installed` — nothing ships it                                            |

"restart" means the engine cannot take a message mid-turn, so a steer restarts
the Run with it as a new attempt in the same conversation; see
[Restart steering](agent-orchestration.md#restart-steering). A native steer
reaches the model at its next step. Claude Code and Pi can be finishing their
answer when one arrives; each then runs the message as a turn of its own in the
same Run, and the driver keeps the Run open until the engine reports it started
on that message (a Claude result naming its client uuid, a Pi user message with
its text), so a delivered message is never left unanswered. Codex and OpenCode
keep their engine running between a Thread's Runs
([Warm engines](agent-orchestration.md#warm-engines)); the others start one for
each Run.

Only Codex reports a plan window; no other engine has a usage or identity API a
driver could read one from. Some sign-ins are refused rather than half-built:
OpenCode's OAuth flows are unreachable from a Runner, so GitHub Copilot (no key
path at all) and Amazon Bedrock (an ambient AWS identity, against an
always-isolated account) are absent there, and Pi leaves out Claude Pro/Max and
OpenRouter's OAuth because both bind a local callback port even on the
paste-the-code path. Cursor has no API-key source at all: `CURSOR_API_KEY` is
the CLI's only key path and a model-run shell command can read the harness
process environment, so the credential stays in the keychain and the account
reports `authentication-required` until `agent login` is run there. Cursor's CLI
is also the one runtime no distribution carries — the packagers, the
lent-computer archive and the container image stage only `shippedHarnessKinds` —
so `inspect` reports `unavailable` with the install location when it is absent
or older than the catalog minimum.

OpenCode, Pi and Cursor run only where the Runner's boundary is `native-user`.
`HarnessRuntimeBoundary.kind` has no third value, so Cursor's test for
`isolated-service` and OpenCode's and Pi's test for anything but `native-user`
are one gate written two ways; all three refuse on both paths, `inspect`
reporting `unavailable` and opening a session throwing. The reasons differ.
OpenCode and Pi have no command sandbox of their own — a command the model runs
goes straight to the shell with the whole harness process environment in reach,
and the Runner's outer sandbox binds the account's provider home and the
Thread's state directory into that tree, so on a shared Runner one tenant's Run
could read another account's key and use this Run's tools. Cursor's reason is
its sign-in: the credential is the person's own keychain entry, so a Runner
executing for a Deployment at large would spend whichever person's plan its own
account happens to be.

### Subagents

An engine's own subagents run inside the Run that started them, with no more
access than the Run has
([Native subagents](agent-orchestration.md#native-subagents),
[Background work](agent-orchestration.md#background-work)):

- **Claude Code:** the `Agent` tool and background tasks (`run_in_background`
  on Agent and Bash, stopped with `TaskStop`); `SendMessage` stays outside the
  boundary, so nothing resumes an agent the Run no longer holds. The driver
  keeps the input open across turns, tracks live tasks from
  `background_tasks_changed`, and waits five seconds after the last one for the
  turn it wakes. A subagent's permission check names it by agent id, which the
  driver maps through `task_started`.
- **Codex:** `multi_agent_v2`. Children run on their own threads and may outlive
  the root's turn, which keeps the Run in the background; a message then starts
  a new root turn. `turn/interrupt` stops only the thread it names, so Stop
  interrupts every live child itself.
- **OpenCode:** only the built-in `general` and `explore` agents, one level
  deep (`subagent_depth: 1`), never in the background, and under the same
  permission table as the Run. A child session's asks route to the person.
- **Pi and Cursor** start no subagents.

## Opensteer tools through the Runner

An engine never holds a Host token. For each Run the Runner starts a loopback
[credential proxy](../apps/runner/src/credentials/credential-proxy.ts) and hands
the engine its agent-tools and integration-tools URLs with a secret that works
nowhere else; the proxy sends the Run's current Host token on each call. It
forwards only `GET`, `POST` and `DELETE` on those two paths and only MCP's own
headers, refuses `CONNECT`, absolute-form targets and redirects, bounds bodies
and concurrent calls, and closes with its Run, or with its engine when that
outlives the Run ([Warm engines](agent-orchestration.md#warm-engines)). When a Stop or an Assignment
cancellation reaches the Runner as an interrupt, the proxy is revoked at once and
its open streams end; the Host refuses the revoked grant regardless. Loopback is
not tenant isolation: the process sandbox still decides who can reach the proxy,
so the shared-Runner restrictions above are unchanged. No engine gets the secret
on its command line, which any user can read: Codex and Pi take it from their
environment or the Runner itself, OpenCode and Cursor from a private file, and
Claude Code's `--mcp-config` names a private file instead of carrying the
document. Trigger and Watch programs reach Opensteer the same way, through a
proxy and browser relay of their own, and on an isolated-service Runner they run
in the same sandbox as engines
([`program-endpoints.ts`](../apps/runner/src/agent/program-endpoints.ts)).

Claude Code defers both Opensteer MCP servers behind its built-in `ToolSearch`.
The managed process sets `ENABLE_TOOL_SEARCH=true`, marks both servers
`alwaysLoad: false`, and explicitly exposes and permits `ToolSearch` in every
access mode. Ambient settings sources are disabled. Fresh and resumed sessions
use the same delivery settings; native subagents inherit Claude's tool discovery.
Deferred schemas load when searched rather than occupying every initial prompt.

Pi registers the Host's advertised JSON Schema unchanged. Pi 0.87.1 accepts raw
object schemas at extension registration and validates them through its native
JSON Schema path, including its argument coercion. The Runner does not rebuild
schemas as TypeBox unions: enums, bounds, defaults and any advertised patterns
remain exactly as the Host supplies them. Host validation remains authoritative.

The Runner asks for a Run's fresh Host tokens at half their lifetime with
`runner.grants.refresh`. The Host reissues them only to the Runner boot that
holds the Run, while its [grant](agent-orchestration.md#run-tool-authority)
stands. Otherwise it answers `refused`, which ends the Run's local access too;
`unavailable` says only that it could not decide now, and the Runner keeps its
tokens and asks again. Each MCP request is authorized by the token it carries,
so a refreshed token keeps using the session the first one opened, and an engine
kept for its Thread's next Run keeps using it under that Run's token. A
shell or browser connection already open is rechecked against the grant rather
than its token, so it outlives the token that opened it but not the Run's
authority. A kept engine's shell relay is lent to one Run at a time and
suspended between them, and a Stop ends its SSH sessions at once rather than
when the engine has stopped ([Warm engines](agent-orchestration.md#warm-engines)).

## Engine releases and new models

A new model reaches Opensteer through a new engine release. Codex, Claude Code
and Pi list only the models their release knows: Codex's list comes from OpenAI,
which filters it by the client's version; Claude Code's is compiled in; Pi's is
its bundled snapshot. An older Claude Code still runs an unlisted model id when
asked, but with default context and output limits, so Opensteer offers only what
the engine lists. OpenCode reads models.dev at runtime and Cursor is the
person's own install, so new models appear there without an Opensteer release.

Each shipped engine is pinned exactly: its npm package in the pnpm catalog,
what its binary prints for `--version` in
[`harnessCatalog`](../packages/core/src/harness-catalog.ts). Distributions
assert the pin through the Runner's own resolution (`verify-harness-runtimes`),
never a restated path or version.

`pnpm check` verifies the installed artifacts and exercises Codex native-store
preparation in isolated state without accounts. Codex comes from the pinned
`@openai/codex` dependency; a missing packaged executable fails with
`pnpm install --frozen-lockfile` as the install instruction. Artifact verification
uses each driver's default executable resolver, follows the artifact's real
path, and reads Codex's native package manifest (removing its platform suffix),
OpenCode's native package manifest, or Pi's owning package manifest. Claude's
native binary embeds its Claude Code build version; that metadata is read
directly because the SDK manifest declares a different version. Missing files,
missing or invalid metadata, and mismatched versions fail the check. A native
binary staged without a package manifest is still checked by executing it in
distribution qualification; Claude's embedded metadata also works without one.
Cursor is user-installed and has no shipped artifact or exact version pin.

`pnpm engines verify` starts all four shipped CLIs with `--version`, checks their
exact output against the catalog, and needs no accounts or sign-ins. Run it for
executable qualification; `pnpm test:engines` includes the same assertion
alongside its account-backed checks, and container builds retain their
executable probe.

An engine whose catalog entry declares `installed` (Codex and Claude Code) also
runs the person's own CLI: an account that uses the person's own sign-in runs
the `installed.command` found on the Runner's PATH, which on the Desktop app is
the person's login shell's, and every other account runs the shipped engine.
The sign-in and the program that reads it then come from one installation, and
a new model reaches that account the day the person's CLI lists it. The
[`HarnessRegistry`](../packages/harness/src/registry.ts) looks the CLI up on
every use, so one installed or updated later is found, and never substitutes
the shipped engine: a computer without the CLI offers no own-sign-in account
for that engine, the Host starts it with an Opensteer-managed one, and an
existing own-sign-in account reports where to install the CLI. Those drivers
accept any release at or above `installed.minimumVersion`, which moves only
when a driver needs something newer; every other driver accepts exactly its
pinned release, because protocol shapes and sandbox behavior change between
releases. Shared Runners have no own-sign-in accounts, so they run only shipped
engines.

Engines are updated by hand, one engine per change, so a release that needs
driver work holds back only its own engine:

1. `pnpm engines` lists pins behind their latest release.
2. `pnpm engines update <kind>` moves one pin, reinstalls, and records the new
   binary's `--version`.
3. Run affected checks and `pnpm engines verify`, then reuse
   `pnpm test:engines -- -t "shipped <label>"` (for example `-t "shipped Codex"`)
   for that engine's user-facing flow on real accounts. For an engine that
   declares `installed`, use `-t "installed <label>"`. Maintainers run
   `pnpm check` on the candidate; feature agents do not run full suites before
   SUBMIT. Runs emit `<kind>-<shipped|installed>.json` under
   `OPENSTEER_ENGINE_E2E_OUTPUT` or a printed directory; retain those artifacts
   only for manual acceptance or release checks. Driver edge cases belong in cheaper tests
   ([Testing](testing.md#how-to-test)).

The suite signs in with `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` when they are
set, and otherwise uses the engines' existing sign-ins on this machine; a
`shipped` run then puts the shipped engines first on PATH, so that sign-in runs
the bytes being qualified. Use
dedicated keys with spending limits. Each engine must pass before its update
ships; a missing sign-in or exhausted quota is a blocked qualification, not a
passing one.

A Codex Run has on exactly the features in `codexApprovedFeatures`
([`features.ts`](../packages/harness-codex/src/features.ts)). The driver reads
the executable's own feature list once, turns every other feature off, and
before each Run confirms from Codex's effective state that nothing else is on.
A release that adds a feature, or turns one on by default, therefore changes
nothing until someone approves it; a policy or dependency that keeps an
unapproved feature on refuses the Run.

After a release, a Runner that reconnects re-inspects every account, so its
catalogs describe the engines it now runs.

The local endpoint qualification is opt-in because it needs a running model
server. To qualify the pinned OpenCode and Pi engines against an oMLX server
already running on that computer — found by discovery and connected with its
own key through `local-import`, nothing pasted — run:

```sh
OPENSTEER_LOCAL_ENDPOINT_QUALIFY=1 \
  OPENSTEER_LOCAL_ENDPOINT_OMLX_SETTINGS="$HOME/.omlx/settings.json" \
  OPENSTEER_LOCAL_ENDPOINT_MODEL_ID=Underdog-Woof-4B-1.1 \
  pnpm test:engines -- -t 'local endpoint qualification'
```

For another server, set
`OPENSTEER_LOCAL_ENDPOINT_BASE_URL`, `OPENSTEER_LOCAL_ENDPOINT_API_KEY`, and
`OPENSTEER_LOCAL_ENDPOINT_CONTEXT_WINDOW`; optionally set
`OPENSTEER_LOCAL_ENDPOINT_MODEL_ID` and `OPENSTEER_LOCAL_ENDPOINT_RUNTIME`
(`generic` by default, or `ollama`, `lmstudio`, `omlx`). Choose a model you
intend to load; a catalog's first model might be too large for the computer.
It drives a real Host and Runner, asks the
model to write and read a Workspace file, and saves a JSON transcript and
artifact record under the system temporary directory (or
`OPENSTEER_LOCAL_ENDPOINT_ARTIFACT_DIR`). A transport mock alone does not
qualify a language model.
The same opt-in suite has simulated endpoint checks for both engines. One
covers a keyless server, including authentication headers, native model ID
routing, embedding exclusion, and configuring and clearing limits. Another
covers a server that refuses without a key, where the account asks for one,
and Ollama's Modelfile context. A third runs discovery against a temporary home
holding oMLX's settings and a stopped LM Studio, connects with oMLX's own key,
and rotates that key. Their scripted completions prove only protocol
wiring. Run the real-model qualification separately for each server type and
engine combination you intend to support; success against oMLX does not
qualify Ollama, LM Studio, or another endpoint.

## Shared Runner sandbox

On `isolated-service` Runners, the engine's per-command sandbox denies model
commands access to `privateStateRoot` while the harness process reads its own
credentials. Shared profiles contain credentials other tenants must not read.
macOS and Windows rely on this layer; macOS Seatbelt sandboxes cannot nest.

Linux also wraps the harness process tree in
[`harness-sandbox.ts`](../apps/runner/src/sandbox/harness-sandbox.ts). It hides
shared data, home, temporary and Workspace roots, then binds only this Run's
profile, Thread directories and Workspace roots, and the machine-access launch
directory its engine started with
([Warm engines](agent-orchestration.md#warm-engines)).
The boot probe must prove that isolation and required writes before startup;
launches must match the planned `HOME` and `TMPDIR`. Drivers apply
`wrapProcessLaunch` to the harness process, including the machine-access setup
probe, and keep Thread files in the supplied `threadStateDirectory`.

`native-user` Runners apply neither isolation layer because the person owns the
machine and credentials. Engines without a per-command sandbox must remain
unavailable on shared Runners, both during inspection and session creation.
The outer Linux sandbox cannot replace protection from the model's own commands.

## Instructions and skills

The Runner assembles each Run's Opensteer platform guide and capability role,
reads the Workspace's configured instructions file (normally `AGENTS.md`), and
resolves one skill plan. Workspace skills shadow same-name integration skills;
the `opensteer-` prefix is reserved for the bundled platform skills. The engine's
own system prompt still applies; these layers supplement it. Every driver also
sends the `[Opensteer thread context]` block from `harnessTurnPreamble` ahead of
a Run's first input: the person's time zone and local time, the Run's task and
how earlier Runs and tasks ended ([Agent orchestration](agent-orchestration.md)).
Run dispatch requires Runner capability `requester-time-zone-v1` for the time zone.

The universal guide in `packages/agent-tools/src/catalog.ts` contains the shared
behavior and product invariants. Role instructions assign responsibility and
explain capability boundaries; every role is also told how its replies render,
since clients open only web links from them
([`transcriptLinkUrl`](../packages/shared/src/transcriptLinks.ts)) and a file is
named by its path. Procedures live in
`apps/runner/agent-skills/skills`: `opensteer-workspaces` establishes a specialist,
and `opensteer-specialization`, available to every model-facing role, teaches how
to maintain instructions, knowledge, reusable skills and scripts, and task state.
A folder, a skill, or a script alone never creates product resources or grants
authority. The Host continues to enforce those boundaries.

The Run context delivers platform, role and capability instructions; neither
product nor integration MCP initialization repeats them. Claude appends the guide
to its system prompt; Codex uses developer instructions (keyed current context on
resume); Cursor includes it in the turn; OpenCode writes its instructions file;
Pi uses its instructions prompt. Keep cross-tool routing and skill choices in
that guide so Claude can choose deferred tools before ToolSearch loads their
descriptions. Put operation fields, access requirements and recovery in tool
descriptions; integration tools carry these for Trigger clients too.

Drivers deliver the resolved skills through these paths:

- Codex configures native skill roots and enables only the selected skill files.
- Claude Code stages a plugin linking to the selected skill directories.
- OpenCode stages selected skill directories for its native discovery.
- Pi and Cursor receive a compact catalog of names, descriptions, and absolute
  `SKILL.md` paths. They read relevant bodies with their file tools. Pi keeps
  ambient skill discovery disabled; the explicit catalog supplies the Run's plan.

Catalogs contain discovery metadata, not every skill body. Pi and Cursor bound
description length and retain a diagnostic with the selected file path when
third-party metadata cannot be summarized; one such file does not prevent
unrelated work from starting. Bundled metadata is validated at Runner startup.
New Workspace skills
are discovered on the next Run; an agent can read a just-written skill directly
within its current Run. On Codex resume, current Opensteer and Workspace
instructions also travel in keyed turn context because changing startup
instructions alone does not refresh the existing conversation. An absent
Workspace instructions file explicitly clears the prior Run's instructions.

Driver tests verify the actual protocol payloads and staged files for these
paths. Model behavior still needs task-level evaluation; successful transport
does not by itself prove the agent chose the right skill or completed the work.

## Thread names and symbols

The Runner asks the selected account to name a Thread from its first authored
message. One tool-free call returns the title and, when requested, a symbol
from `taskSymbolNames` (or `none`, stored as `document`). The parser validates
each field independently; an invalid title does not discard a valid symbol,
and an invalid symbol leaves a valid title usable. The Host accepts each field
only while that field remains provisional, so a person's choice survives.

Naming runs concurrently with the Run, with a 15-second budget; the Runner
waits for its process to exit before keeping an engine warm or tearing down
containment. Runners advertise both `thread-title-v1` and `thread-icon-v1`.
The Host negotiates symbols with `titleRequest.icon: true`; without it the
Runner sends only the original title-bearing report, or nothing. Negotiated
reports can carry a title, a symbol, or both, and always retain the binding
fence. Naming never adds to the transcript or the Run's usage report. A failed
or absent generation method leaves provisional fields eligible for a later
Run. Attachment-only first messages remain ineligible.

Each driver returns the complete naming reply, including both requested lines,
using the Run's executable, credentials, environment and launch wrapper. Its
separate process keeps cancellation and naming configuration away from the
engine executing the Run, including Codex's app-server timeout
and OpenCode's server-wide instruction and MCP setup.

- **Codex:** a second app-server opens an ephemeral, read-only thread with
  the first of `gpt-6-luna` and `gpt-5.6-luna` the account lists (Codex's own
  thread titles use a Luna model), else the Run's model, at its lowest supported
  reasoning effort. A Run's own model can take most of a minute to say one word,
  and a short Run's end waits for its name. Every configurable
  feature except the approved, mandatory `unified_exec` backend is off;
  `shell_tool=false` removes its tools. Effective MCP servers, skills,
  instruction files and dynamic tools are off. Unexpected interaction requests fail closed; disposable logs
  go away with the title process; the ephemeral thread creates no saved history.
- **Claude Code:** a separate SDK query uses `haiku`, retrying once with the
  Run's model if that account refuses Haiku. Managed settings disable hooks and
  bundled features; the query has no tools, MCP, skills, plugins or settings
  sources and never persists a session. An explicit session title prevents a
  nested automatic naming request, and permission requests receive a denial.
- **OpenCode:** `opencode run` uses the model OpenCode's own titles would: the
  newest of the provider's small-model families, else the Run's model. It runs
  in a disposable store holding only a copy of the account's credentials, and
  reads the account's model catalogue cache so it never starts cold. OpenCode
  retries a refused model call without end and reports it only in its log, so
  the process ends at its first logged stream error, such as a free account past
  its usage limit, and the seed stays. Its configuration
  disables tools, MCP, plugins, instructions, skills and the native title agent;
  wildcard permission denial and the CLI's noninteractive denial handle asks.
- **Pi:** print mode uses the Run's provider/model with `--no-session`,
  `--no-tools`, `--no-extensions`, `--no-skills`, `--no-context-files` and
  `--no-prompt-templates`. Explicit prompt overrides also suppress ambient
  `SYSTEM.md` and `APPEND_SYSTEM.md`. Nothing enters the Run's RPC process.
- **Cursor:** print mode uses the Run's model in an empty directory and
  disposable configuration/data homes, retaining the account's keychain or
  file credentials. The driver's catch-all hook denies every tool, including
  questions; removing the temporary home removes its chat and transcript.

## Usage

Emit usage before the Run's terminal event, including failure or interruption.
Opensteer reports engine-provided costs; it does not maintain a pricing table.
Usage is recorded for inspection through `run.attempts.list`; transcripts do not
draw it. A person needs how much of their plan is left, which the account's usage
bar shows, and an engine's `costUsd` is list price, not what a subscription is
charged.

`run.usage` carries `inputTokens` and `outputTokens` always, and
`cachedInputTokens`, `cacheWriteTokens`, `reasoningTokens` and `costUsd` when
the engine reports them, in the terms
[`RunUsageSchema`](../packages/core/src/models.ts) defines: input without cache
reads and writes, output with reasoning. It lands on the Run's current attempt
only while that attempt has no usage recorded yet, so a second statement is
dropped with a log line and the first stands; the `runs` row holds the sum over
the Run's attempts. A subagent's `node.completed` may carry its own share, which
the Run's usage already includes.

Codex states a thread's running total, and the newest response's own usage
(`last`), after each model response (`thread/tokenUsage/updated`). The driver
counts what each statement added to its thread's previous total, which it keeps
for as long as the app-server runs, so a reused engine's next Run counts only
its own growth and a restated reading adds nothing. A statement with no previous
total, or whose total went down because compaction reset it, adds its `last`. A
statement counts toward a Run only when it names a turn that Run ran: the root's
turns, including those it starts for a message, and its subagents' turns, which
are also their node's usage. Any other statement only moves its thread's
previous total. That includes the one Codex sends on resuming a thread, before
any new turn: it restates the thread's reading and names the thread's last
turn, so a cold engine's first Run counts its growth from there.

`costUsd` is the engine's own arithmetic over a price list it carries: Claude's
`total_cost_usd` from the `query()` call that ran the Run (which covers its Task
subagents), OpenCode's sum over each step of the turn, Pi's over each assistant
message. OpenCode and Pi leave a zero out rather than show it, because a
provider whose catalog carries no price reports zero and zero is not a price.
Cursor's result frame and Codex's statements carry tokens but no cost.

## What the person chose last

`user_execution_preferences` keeps one record per person (`ExecutionPreferences`
in `packages/core/src/execution-preferences.ts`): the access mode a new Thread
starts in, and a history of complete selections — work location, account, model,
option values — most recent first, one entry per distinct choice.

Three questions are answered by reading that history from the front. The first
entry is the selection a composer opens with. The first entry naming a model on
an account is the option values it comes back with there; a model never run
there carries the values in force, clamped. The first entry naming an account is
the model a switch to that account lands on when it does not offer the current
one, and the account its engine's menu opens on. The menu's Recent list is the
newest entries whose accounts are still offered, unavailable ones included with
their reason. The Host checks only that a remembered
account exists on the named work location and that the person can see it;
whether the model still runs there is decided when a Thread is started.

Writes happen in five places. Three are Thread mutations in
`packages/client/src/host/host-session-client.ts` — creation, an execution
change, an access change — each written once the Host has accepted the mutation
and each swallowing its own failure, because the mutation the person asked for
already succeeded. The other two are the composer that has no Thread yet:
`apps/web/src/components/home-view.tsx`, and the mobile `NewThreadScreen` in
`apps/mobile/src/screens/thread-settings.tsx`. The choice is a choice even if no
message is ever sent.

A Thread's own selection is never rewritten by a later preference; the picker on
an existing Thread starts from the Thread. A remembered choice is a decision,
not a hint: when its account, work location or model cannot run right now the
composer keeps naming it and says why, rather than quietly starting work
somewhere else. When building a selection, `selectionForModel` clamps option
values to the live descriptors and stores only values that differ from their
defaults. Choosing the default again clears a previous override.

What is deliberately not here: a default engine per work location (what the
person chose last covers it), a per-device preference, account failover policy,
and per-account cost attribution. Each fits on top of this model without
changing it; none is worth building before someone asks.
