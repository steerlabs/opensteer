# Architecture

Opensteer is your Personal Cloud Computer for AI. A person connects a device once. Every AI agent
they use can then reach their real accounts and devices, only as far as they allow, and they can
watch and stop it from their phone.

There are two product names: **Opensteer** and **Opensteer Cloud Computer**. Everything else a
person reads is plain words.

| Noun       | What it is                                                                                                                                                                                                                                                                                                                          | In code                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Home**   | The one place a person's browser profiles, apps, plugins, tasks and rules live. It is the Host, its PostgreSQL and the hosting device where the person's own agents run. It runs on their own Mac, on a Linux server or on an Opensteer Cloud Computer.                                                                             | A `personal` Deployment (`apps/host`). A Mac Home listens on loopback; a Linux Home has a public HTTPS origin. Both are the same kind. |
| **Device** | Something an agent acts through: a Mac, a Linux server, an Android Agent Phone, an iPhone screen driven through a Mac, a Chrome the person shares tabs from. It is connected once, has its own switches, and dials the Home.                                                                                                        | `devices` and `device_drivers`, served by a Runner (`apps/runner`), the Agent Phone app or the tab sharing extension.                  |
| **Agent**  | Any AI agent. A **connected agent** is one the person already uses elsewhere (Claude, ChatGPT, Cursor, an agent someone built) that connects over the Model Context Protocol with ordinary sign-in and consent. **Your own agents** are the coding agents Opensteer runs on the person's devices (Claude Code, Codex and the rest). | An `AgentConnection` with an `AgentGrant` for a connected agent. A `Run` of a task for the person's own agents.                        |
| **You**    | The person, on phone, web or desktop. They decide what each agent gets, answer what needs them, watch the work and stop it.                                                                                                                                                                                                         | Owner sessions of the `@opensteer/client` clients (`apps/web`, `apps/desktop`, `apps/mobile`).                                         |

## The one authority rule

An effect happens only if every term that applies allows it, all at once:

> the person's ownership ∩ the connected agent's grant (when the work descends from a connection)
> ∩ the task's mode ∩ the device's switch ∩ the target's own approval.

The terms are intersected. None of them outranks another, and none widens another. An answer from
the person allows one operation inside the grant; it never widens the grant.

The rule is resolved in one module, `packages/database/src/resource-access.ts`:

- `admitExecution` says whether an execution may act at all. It resolves who the work is for from
  the binding the Home issued (`run:`, `thread:`, `trigger:`, `watch:`, `session:`), never from
  what a caller says. It checks the owner and that the execution is still live. When nothing
  resolves, the answer is a refusal, never Full access.
- The connection's standing is read in one statement by one function: its grant, grant revision,
  consent version, mode ceiling and its state (`readConnectionStanding`, with `connectionState`
  in the same `SELECT`). Every reader of where a connection stands is a view of that statement.
- The effective mode is the lowest mode in the lineage (connection, task and Run;
  `minThreadAccessMode`), read at the moment of the effect. The modes from lowest to highest are
  `approval-required` (shown as Supervised), `auto-accept-edits`, `auto` and `full-access`.
- `authorizeTarget` checks one concrete target against the grant. The device's switch
  (Browser, Apps, Files) and the person's own approval of an app are checked by the services that
  own them (`apps/host/src/administration/device-access.ts`, the app and device services) as the
  last two terms.

Why one module: every enforcement point (tool call, tab, browser, Chrome tab, app, plugin, CDP
attach, the dispatcher that starts a Run, the inbox that accepts input) asks the same question
and gets the same answer. A new path that makes its own decision is the most likely way to break
the product.

The person's own agents, with no connection in their lineage, are not changed by any of this.
Their mode is the Run's or the task's. New tasks start in Full access.

## Connected agents and their grant

### The grant

```ts
type AgentGrant =
  | { scope: "everything" } // what the person's own agents can reach
  | { scope: "selected"; tasks: boolean; resources: AgentGrantResource[] };

type AgentGrantResource =
  | { kind: "browser-profile"; profileId }
  | { kind: "chrome-tabs"; sourceId } // tabs the person shares from one Chrome
  | { kind: "computer-app"; approvalId; deviceId; app } // a Mac app (bundle id, team id) or a phone screen
  | { kind: "plugin"; target; access: "read" | "read-write" }; // installed plugin, local MCP server or device data account
```

The types and the matching rules are in `packages/core/src/agent-grants.ts`. A selected grant
holds at most 64 resources.

- **`everything`** reaches what the person's own agents can reach, through the tools offered to
  connected agents.
- **`tasks`** lets the agent ask the person's own agents to work. Those agents use the files,
  commands, credentials and network of their account on the device, under the task's mode.
  Consent says: "Opensteer can stop what happens next, but can't undo what an agent already did."
- **A browser profile** gives full control of that profile, including every site signed in there.
  There is no cookie blocklist and no per-site allowlist. Consent offers existing profiles and a
  new dedicated profile, which starts signed out and is marked Recommended.
- **A granted thing that changed is not granted.** An app with another signer or a new approval
  row, or a phone screen with another definition, no longer matches. Profiles match by exact id.
- **The grant is one validated value on the connection row** with a revision that only goes up.
  An edit names the revision it expects. Renaming a connection does not change the revision;
  changing the grant or the mode does.

A connection also has a label, the mode ceiling the person chose (default Supervised), a consent
version, an expiry 30 days after consent and a revocation time. Connections made before direct
work existed have `everything` at consent version 1; direct tools need a consent made on the
current screen (version 2). A version-1 connection is listed none of the direct tools, so what it
is shown is what it can call: the listing and the call ask the same consent rule.

### How a connected agent connects

Over OAuth 2 with PKCE (S256) and a public client (`apps/host/src/mcp/connections/`).

- **Registration** is stateless. The `client_id` the Home returns is a document the Home signed,
  listing the client's name and up to five redirect addresses (`https:`, or `http:` on loopback).
  Client ID metadata documents and refresh tokens are not built. The access token lasts as long
  as the connection (30 days); then the agent signs in again.
- **What the Home can prove** about a client: its fingerprint (a hash of the `client_id`) and the
  redirect address the person consented to. The name a client gives itself is shown as its own
  claim ("It calls itself: …"). A loopback redirect is "an app on this computer".
- **Consent** is on the Home. The person picks everything or a selection, the mode ceiling and a
  name. Every consent says "Only allow this if you started it yourself." Each consent is its own
  connection with its own grant and its own credential.

### The signed agent directory and what "verified" means

The Opensteer account service publishes one signed list of known agents (`GET
/v1/agent-directory`, `apps/control-plane/src/agent-directory/`). Each entry has a display name
and the exact HTTPS origins it is verified by. The Home fetches it from its configured account
origin over HTTPS, checks the signature against that origin's published keys, and caches it (refresh every 15 minutes; a copy is usable for 24 hours).
A Home never fetches an address an agent supplies. See [agent-directory.md](agent-directory.md).

- **Verified** means the redirect address the person consented to has exactly the origin of a
  directory entry. The consent heading then shows that entry's name with a verified mark.
- **Anything else is unverified**: heading "An agent wants to connect", with its own name shown
  as its claim.
- Consent uses the cached copy. A Home that has never accepted a copy waits at most two seconds
  for one, then shows everything as unverified.
- If the directory later removes the origin, the connection shows "No longer verified since
  {date}" and offers Disconnect. The Home never disconnects on a remote list's
  say-so. If verification changes between the consent screen and the approval, the approval is
  refused with `consent-verification-changed` and the person looks again.

### What a connected agent is shown

The tool list is built from the grant (`packages/agent-tools/src/tools-for.ts`). A tool the grant
does not imply is neither listed nor callable.

| Grant part        | Tools it brings                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| any grant         | `opensteer_commands`, `opensteer_command`, `opensteer_state`, each cut to what the grant holds                           |
| any part below    | `discover`, `ask_person`                                                                                                 |
| a browser profile | `browser_use`, `browser_connect`, `saved_login_request`, `card_request`                                                  |
| Chrome tabs       | `browser_use`, `browser_connect`                                                                                         |
| an app or phone   | `computer_use`                                                                                                           |
| a plugin          | `plugin_call`, `plugin_resume`; `plugin_execute` with read-write                                                         |
| `tasks`           | `opensteer_task_create`, `opensteer_task_send`, `opensteer_task_read`, `opensteer_task_wait`, `opensteer_task_interrupt` |

The saved-fill tools require a managed browser profile and the Home's Passwords broker.
`discover` lists shared resources and returns IDs for use in later calls. Open a task's entry to
find child tasks and use their IDs to read or wait for results. If the person pauses a task
queue, messages sent in queue mode wait there until the person resumes it.

An `everything` connection lists all 18 tools on a Home with Passwords. Full access and Supervised
list the same tools, and the grant and access mode still govern each call. Connections have no
separate settings tools or output schemas: a change to the Home is `opensteer_command`, through
the one door below. Shared Chrome tabs and device apps are found with `discover`. Server instructions are built from the same grant, and
`apps/host/src/mcp/connection-contract.test.ts` checks the exact tools for eight grant shapes.
Listing sizes are pinned in `tests/agent-context-budget.json`.

**Outside the grant reads exactly like non-existent.** A refusal about a target the connection
may not know of is rewritten to `not_found` with a fixed message and no advice
(`apps/host/src/mcp/agent-tool-failure.ts`, `packages/agent-tools/src/results.ts`). For Requests,
a task's `status` is the task's own state and stays truthful while any Request outside the caller's
authority stays hidden (absent from lists, counts, text, and asker). Pinned by
`packages/agent-tools/src/results.test.ts` and `apps/host/src/mcp/lineage-visibility.integration.test.ts`.

### Delegation never widens authority

Everything that can run later carries the connection it came from: tasks
(`threads.origin_connection_id`, inherited by child tasks), queued inputs, Runs and their
attempts, automations, their occurrences and attempts, Watch activations, and plugin executions.

- A Run with a connection in its lineage gets the lower of the modes and only the tools,
  resources and plugins the grant holds.
- A `selected` connection sees and touches only tasks in its own lineage. Only an `everything`
  connection may send to the person's own tasks. This is checked when input is sent, dequeued and
  claimed, and when a Run starts.
- When a connection is revoked or expires, everything descended from it has no authority.

## Direct work

A connected agent can also act itself, with the same general primitives the person's own agents
have. There are no per-site or per-app tools.

### One door

Every direct call goes through one function, `AgentSessionService.run()` in
`apps/host/src/agent-sessions/agent-session-service.ts`. That covers `browser_use`,
`browser_connect`, `computer_use`, `plugin_call`,
`plugin_execute`, `plugin_resume`, `saved_login_request`, `card_request` and `ask_person`.

A change to the Home is a second door, the same for every sender: `dispatchCommand`
(`apps/host/src/commands/dispatch.ts`), admitted by `admitCommand`. The older task tools
(`opensteer_task_create`, `_send`, `_resume`, `_queue`, `_configure`, `_update`,
`opensteer_request_answer`, and a chat's messages, which reach the same tools) build their table
command and send it through it, so the table's lineage and widening faces apply to your own agents
as to a connected agent. What stays outside it is one of three kinds: a Run's or program's own
tool under its own admission in `packages/database/src/resource-access.ts` (delegation, tabs, apps,
plugins, Requests to the person, with the door's own answer where the two could differ, as for an
app's start); a step that can only take authority away (cancel, interrupt, Stop, withdraw); or an
identity step under its own proof (sign-in, the Cloud Computer claim, the consent screen, a
Runner's or a device's signed frames).

Each call is one reviewed **operation** of an **agent session**:

- A session is anchored one-to-one to a listed task whose worker is the connected agent
  (`agent_sessions`). The existing Tasks, Tabs, Watch, Needs you and Stop surfaces show that work.
  The task never starts a Run of the person's own agents and accepts no typed input. A Home needs
  no engine for it.
- A session starts with the first direct call and ends on Stop, Disconnect, expiry, narrowing or
  15 minutes idle (never while an operation is handed off or a Request is open). Direct tools take
  an optional `taskId`: left out, the call continues the connection's current session or starts
  one. Every result carries it.
- An operation (`agent_operations`) is written before review or dispatch. It records the caller,
  an operation key and id, a digest of the arguments, the concrete target and its generation, the
  grant revision, the effective mode, who decided (`structural-read`, `full-access`, `person`,
  `refused`; a past `reviewer` decision stays readable as recorded), the hand-off time and the
  outcome: `completed`, `failed`, `refused` or `unknown`.

### The guarantees

1. **One door.** Direct work enters only through `run()`. A handler that acts without it is a bug.
2. **The witness.** An operation is admitted under a grant revision, an effective mode and a
   target generation. At hand-off, a changed revision, mode, target generation or target grant
   sends it back for a fresh decision. While it runs, the tool re-checks the revision and mode
   before each command it sends to a device. For
   `browser_connect`, every CDP command, every frame from the browser and a timer once a second
   re-check the same facts; any change closes the socket.
3. **Held when the mode says so.** A read runs in any mode. An effect runs at once in Full
   access. In Supervised, Auto-accept edits and Auto the person is asked. The person sees a page
   title or an app's own name as a labelled plain line ("The app calls itself: …").
4. **The answer applies only to what the person saw.** The Request shows the exact script or
   calls; a script longer than a Request's plain text can show in full (18,956 characters, which
   leaves room for the Home's own first lines, so that an older app shows all of it too) is
   refused before it is admitted. The decision ("Allow once" or "Don't allow") is written with a compare-and-set on the
   reviewed revision, mode, target, target generation and Request.
5. **A repeat never happens twice.** The stored operation is looked up by caller and operation key
   or `operationId`, and its argument digest is compared, before target discovery and before a
   session is made. A finished repeat returns the stored receipt. A one-use `browser_connect`
   endpoint is never issued twice. This holds across idle and a Home restart.
6. **Unknown is never guessed.** An effect whose reply was lost, or that Stop, Disconnect or a
   narrowed grant cut off after hand-off, is recorded `unknown`, never failed or completed, and is
   never retried by the Home. A Home that restarts settles handed-off operations as `unknown`. The
   person sees **Uncertain**.
7. **`pending` is continued, not polled.** A call waits up to 25 seconds for the person, then
   returns `{ status: "pending", taskId, operationId, requestId, next }`. The agent continues by
   calling the same tool with the same arguments and that `operationId`. An open Request ends on
   its own age (24 hours) and refuses its operation in the same transaction. A real change to the
   grant or mode closes the Requests it made unanswerable.
8. **What a refusal carries.** `{ error: { code, message, next }, taskId, operationId, status }`.
   The codes a connected agent acts on: `declined_by_person` (do not retry that action),
   `stopped_by_person` (stop that task and ask before starting again), `access_changed` (the grant,
   mode or connection changed during the work), `not_found`,
   `computer_stopped`, `computer_asleep`, `computer_offline`, and `access_denied` for any other
   refusal.

A connected agent's operations appear in its task's **activity** (`threads.activity`,
`connections.activity`). They are not transcript items: `packages/protocol/src/transcript.ts` has
no operation variant, by design.

For the agent builder's view of this contract, see [connecting-an-agent.md](connecting-an-agent.md).

## How your own agents start

A task in the person's own lineage starts its engine with the engine's own configuration, as if the
person had started it in Agent home themselves: their user, project and local settings, the
folder's `CLAUDE.md` or `AGENTS.md`, the engine's own tools (web search included), and their own
MCP servers, hooks and skills. Opensteer adds its MCP server, its instructions and its skills, and
overrides only what it needs, each with its reason beside it in the driver. A server of theirs named
`opensteer` is replaced by Opensteer's in Claude Code, and a Run of Claude Code that has not loaded
Opensteer's fails. Codex merges the two, Opensteer's fields winning, so their `enabled_tools` cannot
hide Opensteer's tools; when theirs runs a command, the Run fails with one sentence asking them to
rename it.

The person wrote those settings for their own use. A task outside the person's own lineage
starts the engine with none of them, with or without personal context: applying them would give a
connected agent or a chat more than the person approved. The lineage walk that decides personal
context decides this too (`runContextLineage`, `packages/database/src/run-personal-context.ts`): a
task is not the person's own when its Run has a connection, a task on the walk was started by a
connection, any message in it or the tasks it descends from was written by a connection, or the walk
meets a chat. A memory pass is one of the person's own automations, driven by Opensteer's own fixed
script for them, so it stays in the person's own lineage. Lineage narrows and never widens back:
the person writing into such a task again, a task linked under it, and an automation of theirs that
fires from it are not their own either. When `personLineage` narrows, the provider session rotates
too (`provider_sessions.person_lineage`), so a non-own Run never resumes a native conversation made
under the person's configuration. The Runner is told `personLineage`, and `engineConfiguration`
(`packages/harness/src/engine-configuration.ts`) is the one place that chooses.

Such a task keeps the task's mode, runs nothing of theirs (hooks, notify commands, command
prefixes, credential commands, MCP servers) and reads none of their instructions or memory; what
the engine needs to sign in stays. An engine runs such a task only where an engine-lane test plants
one of each kind in a temporary home and project and shows all three on the real engine. Otherwise
`assertEngineMayRun`, in the same file, refuses it before any process starts, with code `forbidden`
and two audiences (`EngineUnavailableForTaskError`): the starting party (a connected agent, a chat
reply, a delegation result, or a follow-up Run) reads only the neutral sentence `"This engine is not
available for this task."` for every engine and every refusal reason, while the person on their own
screens (task view, task list preview, and notifications) reads `ownerMessage` with the exact
reason and what they can change. The Home offers every engine to every task and does not refuse by
engine itself, so the Runner refuses. Background text (task
naming and Auto-mode review) always starts without the person's configuration on every engine,
using the Opensteer-owned home on Codex (refusing as unavailable when no file login is present or
the active provider runs a credential program) and the others'-tasks folder on Pi (refusing as
unavailable when `models.json` or `auth.json` contains a `"!"` shell command).

- **Claude Code** runs both. Its own task gets the person's settings, instructions, auto-memory,
  plugins, tools and MCP servers. Another's task loads no settings source, no auto-memory, no user
  plugins, only Opensteer's MCP server, and no web tools (`WebSearch`, `WebFetch`), and gates shell
  commands through Opensteer's hook (`packages/harness-claude/src/own-configuration.engine.test.ts`).
- **Pi** runs both when its `models.json` and `auth.json` contain no `"!"`-prefixed shell command
  values (or on an isolated profile). Another's task starts with an agent folder of Opensteer's
  that links only the person's `auth.json` and `models.json` (when present) and with an empty
  system prompt, so their settings, command prefix, `SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md`,
  prompts and the project's `.pi` stay out, Pi keeps its own prompt, and the driver's extension
  enforces Supervised mode. If either file contains a `"!"` value (which Pi executes as a shell
  command to fetch a credential) or cannot be parsed, `assertEngineMayRun` refuses others' tasks
  with code `forbidden` and background text returns `unavailable` before spawning Pi
  (`packages/harness-pi/src/own-configuration.engine.test.ts`).
- **Codex** runs both when the person's sign-in is in a file (`auth.json`, Codex's default) or on
  an isolated profile. Its own task runs from the person's Codex home with their rules, `notify`,
  instructions and MCP servers. Another's task runs from an Opensteer-owned `CODEX_HOME` that holds
  only a symbolic link to the person's `auth.json` (never a copy; Codex 0.162.0 writes `auth.json`
  through the link on both login and OAuth token refresh) and the reach-the-model settings from
  their `config.toml`, with `cli_auth_credentials_store = "file"` and `project_doc_max_bytes = 0`
  (`packages/harness-codex/src/own-configuration.engine.test.ts`). When the person stores their
  Codex sign-in in the OS keyring (keyed by `CODEX_HOME` path), has no `auth.json`, or their active
  provider runs a credential command or uses AWS/Bedrock credentials (`auth`, `aws.*`,
  `amazon-bedrock`, `amazon-bedrock-runtime`), `assertEngineMayRun` refuses others' tasks with code
  `forbidden` and background text returns `unavailable`.
- **Cursor**, **Grok**, **Muse Code**, **OpenCode** and **Antigravity** run only the person's own
  tasks: none has a real-engine boundary test proving all three guarantees on others' tasks, so
  `assertEngineMayRun` refuses them with code `forbidden` before any process starts.

Every task's engine gets the person's proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`,
`NO_PROXY` and their lowercase spellings) and certificate variables (`NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, `SSL_CERT_DIR`) from their login shell. The Home's launch environment excludes
these login-shell variables. A task's commands run as the person and can read the engine's
environment, including passwords in proxy addresses. Opensteer removes proxy usernames and
passwords from its own records when it writes errors and diagnostics from every engine,
recorded Run failures, Runner log lines, Runner command rejections and inspection details, and
the desktop supervisor's child logs and status details
(`redactNetworkCredentials`, `packages/shared/src/safeMessage.ts`).

In the person's own task the mode is the task's and the rules are the person's. The engine is
started in the task's mode (Claude Code's permission mode on its command line, Codex's approval
policy and sandbox on every turn), and a default mode in the person's settings does not replace it.
What the person allowed in their engine is allowed, as in their terminal started in that mode: an
allow rule, a hook, a command rule or an MCP tool's approval of theirs applies, and so do a
project folder's own engine settings, as they would in a terminal opened there. Opensteer adds no
prompt of its own on top. Opensteer's own tools are decided by the Home from the task's mode, not
by the engine. A task started by a connected agent or a chat shows the connection mode descriptions
in its mode picker; a person-started task later written into by another keeps the own-task sentence
for now (safe side: the engine asks more than the sentence says).

## Stop and Disconnect

### Stop on a task or a tab

Stop interrupts that Run, or ends that agent session with everything it has in flight. A
connected agent's next call naming the task is refused with `stopped_by_person`; its next call
without a `taskId` is refused once with the same notice, then may start a new session.

A confirmed Stop proves that the engine and every process of it that this device can attribute to
the task have ended. If the device cannot complete a clean process scan, Stop stays unconfirmed
and holds the task. A program an agent asked the system to start outside its own process tree —
such as an app opened through the system, a launch agent, a container, or work on a remote
machine — is not ended by Stop and is not part of that proof.

### Disconnect

Disconnect revokes the connection in one transaction (`AgentConnectionStore.revoke`). It locks the
connection row, and every admission that hands work off holds the same row, so nothing new is
admitted once it commits. Then one worker converges over one set
of attempts (`packages/database/src/connection-disconnect.ts`, driven by
`OpensteerStore.driveConnectionCleanups`). The set holds everything in the connection's lineage:
Runs and their handed-off generations, automation occurrences and their attempts, Watch
activations, queued inputs, Requests, the phone alerts for its Requests and its Runs' replies
and failures, steering commands,
active automations (paused), agent sessions and operations, plugin executions, standard CDP
connections, shared Chrome tabs, and the shells its Runs opened on other computers.
Display streams are opened only by a person's own session (`computer-use-display-routes.ts` ->
`DisplayStreamHub.attachViewer`), so they are not in any connection's Disconnect set.

**Nothing leaves the Home before it is in the set.** A Run is recorded before its frame is built;
a CDP attempt before the attach ticket goes to the browser runtime; a plugin execution before the
call reaches the plugin engine; a shell before its open frame goes to the target computer, bound
to that computer's exact shell stream; a phone alert in the statement that checks, after
every other wait, that the connection is live and (for a Request) the Request still pending. Each is
recorded while holding the connection row the revoke locks, so a revoke that committed first
refuses it and nothing is sent. The one-use `browser_connect` address an agent receives is not a
handoff: it does nothing until redeemed, and redemption checks authority again and writes the
attempt first. The worker stops each attempt through its own stop command and accepts only an answer for
that exact attempt, generation, Runner and Runner boot.

What the person sees follows evidence:

- **Stopping…** from the moment the transaction commits until every attempt has an end.
- **Disconnected** (state `stopped`) only when every attempt never left the Home or reported its
  end. An attempt whose Runner lost contact, or restarted on another boot, is recorded as contact
  lost; it counts as ended, and the connection shows **Check its last action**.
- With no answer and no contact loss, the connection stays Stopping. There is no timeout, and it
  cannot be removed until it settles.

A shell ends on its target's close receipt on the stream it was opened on (a receipt on any other
stream proves nothing), or with contact lost when that stream, the target's Runner boot or this
Home's process is gone. A phone alert ends when the Opensteer account acknowledges it, when it is
known never to have reached the account, or as unknown when the acknowledgement was lost; it is
never sent again after that. Sending the same alert again after a lost acknowledgement, before
then, completes the same attempt rather than making a second one: the account keeps one
publication per notification id and answers a repeat from it, and the repeat passes the same
check first. An alert already on the phone cannot be taken back: it stays until the person
dismisses it, and opening it shows the question no longer waiting.

Expiry, a narrowed grant and a lowered mode go through the same worker. The person's other work is untouched. Disconnect does not close tabs.

### Stop everything on this Mac

A boot mode of the Mac's Runners, not a flag the Home has to honour.

1. The desktop app saves the choice to a local file first (`apps/desktop/src/app/local-stop.ts`).
   A file it cannot read means stopped.
2. It restarts the Home's own Runner and each device Runner with the saved time. A Runner booted
   that way refuses agent work: agent shells, agent browser attaches and CDP, computer use,
   messaging. The person's own tabs, frames and owner views still work.
3. It shows a confirmed Stop time only after each old Runner exited, the desktop proved its
   processes are gone (`apps/runner/src/runtime/execution-containment.ts`), and each new Runner
   reported that earlier boots are contained. Otherwise it says "Couldn't confirm everything
   stopped". That confirmation proves the Runners, their engines, and every process of them that
   this Mac can attribute to their work have ended; a program an agent asked the system to start
   outside its own process tree is not ended by Stop and is not part of the proof.

It needs no Home to be reachable. The Home learns of it from the Runner's signed hello and also
refuses to start work on a stopped Runner. An owner view open during the restart ends with
`device-restarting`; the web and phone viewers reopen it by themselves ("Reconnecting…", within
15 seconds). Quit and background updates use the same shutdown proof.
`apps/host/src/agents/runner-reattach.integration.test.ts` exercises this with a real Runner, an
engine whose child ignores SIGTERM, a live shell and an owner view.

## What a connected agent can drive

### The browser

Two ways onto the same granted profile, both direct operations:

- **`browser_use`** runs one script (up to 18,956 characters) in a QuickJS sandbox in the Host,
  with the same page API the person's own agents use (`apps/runner/browser-harness/page.mjs`).
  `help()` prints the API. `newPage` and `page.close()` work only in the profile the operation was
  approved for.
- **`browser_connect`** returns a standard CDP endpoint on the Home (`/v1/browser/connect/<ticket>`,
  `wss:` on an HTTPS Home) for stock Playwright `connectOverCDP()` or Puppeteer. The ticket is
  random, stored only as a digest, used once and valid for a minute. It is bound to the session,
  profile, runtime, grant revision, mode and task. The OAuth token is never in the address. One
  approval covers one interval of up to 10 minutes. The Request says what that is: the agent
  controls its own pages and can reach every cookie and signed-in site in the profile.

The connection is confined (`packages/browser-core/src/portable-session-cdp-router.ts`):

- **It sees only the agent's own pages:** the tab it was issued, pages it creates, and their
  popups. The person's tabs and another agent's tabs in the same profile are not listed and cannot
  be attached to, by target id, by auto-attach or through an opener.
- **Every page it creates is an open tab of its task**, so the person can watch it. A page the
  Home cannot record is closed. Closing an agent's tab really closes the page.
- Browser-wide commands are refused. `context.newCDPSession(page)` works as an alias of the
  confined root.
- A runtime that does not report lineage support refuses a connected agent's `browser_connect`
  (update Opensteer on that device; `browser_use` still works).
- It closes on Stop, Disconnect, expiry, a lowered mode or any grant change.

Through the browser, in `browser_use`, `browser_connect` or a Run in its lineage, a connected agent
sends only the CDP methods a standard client may, reads a shared Chrome tab's own cookies only, and
cannot read the clipboard or change a browser permission. A page any agent works in can replace what
is on the clipboard, through `document.execCommand('copy')` under the agent's gesture (and, for your
own agents, the copy chord): Blink allows that write on user activation alone, and Electron offers no
per-tab control over it, so it cannot be limited to the tab the person is using without a change in
Electron or Chromium. On a Mac that is the Mac's clipboard; on a Linux Home or a Cloud Computer it is
that browser's own clipboard (where `navigator.clipboard.writeText` writes it too), and no
person's clipboard is there. No agent can read the clipboard through a page: `navigator.clipboard`
reads and writes are refused to every page of the Mac's browser, reads are refused to every page of
a Linux Home's, and no agent can grant a clipboard permission.

See [browser-sessions.md](browser-sessions.md).

Pages are separated by lineage; signed-in state is not. The isolation boundary for cookies and
sign-ins is the browser profile. A connected agent works only in profiles granted to it, never in
Guest. Two agents granted the same profile share its signed-in state.

On a Linux Home or a Cloud Computer, tabs nobody is using sleep, and wake with their state while
the browser keeps running, which makes it unlikely that a Home with many tabs on a small machine
runs out of memory (not impossible: when every tab is in use, a new tab still opens, and a storm of
pages that a page opens can outrun sleeping, so background tabs can then be lost to the system). A sleeping tab is discarded in Chromium (freeing its renderer while keeping its tab
state, driven by container working set or host memory pressure with 70%/60% hysteresis, also
checked before each new page opens) and named, only while it sleeps, through a minimal internal
helper extension that is never visible to tab lists, session CDP or connected agents; it is removed
with confirmation and bounded retries when the tab closes or its session ends. When the browser
itself restarts (a Home update, a crash, a cold start), each tab reopens at its address: what was
typed and not sent, its scroll position and its back history are not kept across that restart;
sign-ins are kept, since they live in the profile, except that a sign-in made in the last half
minute before the browser is killed may not be (Chromium writes its cookies to disk on its own
timer). The launcher deletes the last session's
records in the profile directory it owns before launch, and refuses a launch that finds a page. On a
Cloud Computer the browser pool keeps the exact state through idle time, so a restart is the rare
case there.

**Chrome tabs the person shares.** The companion extension, listed as "Opensteer tab sharing",
shares tabs from the person's own Chrome (a `chrome-tabs` grant). The agent finds them with
`discover` and works in them through `browser_use` or `browser_connect`. Stop, Disconnect and a
narrowed grant detach them; ending the share makes the tab not found. The extension replays its
detach receipts until the Home acknowledges them.

### Apps and phones

`computer_use` runs a script against one granted Mac app or phone screen; the target named in the
call is already bound (`await target`). `readOnly: true` observes without a Request and never
launches a closed app. The approval witness is the approval's revision and the exact driver
(Runner, role, generation), re-checked before running. An iPhone screen is driven through a Mac;
an Android Agent Phone is its own device. A Mac's sleep notice ends a connected agent's
computer-use scripts with `device-asleep`.

### Plugins

A connected agent's discovery calls serve published declarations only, never the plugin's live
code. Anything that runs plugin code with the linked account (`plugin_call`, `plugin_execute`,
`plugin_resume`) is one operation through the pipeline, with the plugin version as the target
generation. A read-only grant allows only read-only tools.

### Asking the person, saved logins and cards

- **`ask_person`** asks one question with one answer picked from the choices offered; there is no
  free text. It always asks the person, whatever the mode. The person enters passwords and codes
  in the page, never in the answer.
- **`saved_login_request`** and **`card_request`** name a live tab in a granted profile on the
  site. The person picks and approves; the agent receives a reference (`loginRef`, `cardRef`),
  bound to its session, browser, profile, tab and site. The fill is
  `page.cdp("Opensteer.fillLogin", { loginRef, field })` (or `Opensteer.fillCard`) inside a
  `browser_use` script.

What is promised, from [passwords.md](passwords.md): tool results never carry a saved value, and an
agent cannot open the vault. Opensteer fills the value into the page and does not return it. After
the fill, the page and an agent working in that page can read what is on it. A card needs fresh
approval for one merchant site each time, with one 30-minute deadline for approval and fill. The
approval protects which login or card is released, to which site, each time.

Where fills work: only in the browser of the person's own Mac that hosts the Home. The standard
CDP endpoint refuses both fill commands. A Home whose hosting device has no Passwords broker (an
Opensteer Cloud Computer, a self-hosted Linux Home) does not list the two tools.

## Chats: Slack and iMessage

A chat is a connected agent reached through one of the person's messaging accounts: its direct
messages, or one named channel. It is an `agent_connections` row with a grant like any other
(`bridge_account_id`, `bridge_conversation_id`, `bridge_senders`), listed, edited and disconnected
in the same places (`packages/database/src/agent-connection-store.ts`, `createBridge`). Its caller
is the chat identity of whoever wrote the message: the Home resolves it for each message
(`apps/host/src/channels/bridge-caller.ts`) and every task tool asks again whether that sender may
speak, at the moment it acts (`admitBridgeSender`, `packages/database/src/bridge-admission.ts`).

Who may speak is chosen when the chat is added and never changes on that row: **me** (the one
identity linked to the person on that account, by a code the person sends from their own account;
linking another replaces it, and nothing is said in the chat), or **anyone** who can write in that
one channel, whose tasks run without the person's personal context (`lineageHasPersonalContext`).

What a chat may hold follows from who may speak, in one rule: `chatGrantShape` and
`chatGrantRefusal` (`packages/core/src/agent-grants.ts`). A chat always holds tasks; an anyone chat
holds no more than tasks and plugins, never everything. The Home refuses any other grant
(`assertBridgeGrant`) and sends the shape with each chat (`bridge.grantShape`, optional), so the
grant editors offer only what it allows and check it before they create anything.

### Three states, one function

`connectionState` (`packages/database/src/connection-liveness.ts`) answers live, waiting or ended
in the statement that reads the row. A chat has ended when it is revoked, its grant holds no tasks,
its account or channel is gone or belongs to someone else, or its Mac lost Messages or was
removed; it is waiting while its account is paused or needs attention, or its
channel is paused (`chatAccountState`). The person reads them as active, paused and ended.

| Layer                                                                        | live                                 | waiting (paused)                                                                                        | ended                                        |
| ---------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| A message arriving (`claimIngress`, `ingressWaiting`)                        | decided                              | left pending, not claimed                                                                               | decided and ignored                          |
| Deciding it, resolving its caller, the task tools                            | runs                                 | given back to pending, attempt refunded (`chatWaitingError`)                                            | ignored, nothing said                        |
| A code to link "me"                                                          | linked                               | given back, redeemed when back                                                                          | ignored                                      |
| Queued messages (`ensureQueuedRun`, `claimFollowUps`)                        | run, if their sender may still speak | kept in order                                                                                           | cancelled                                    |
| A Run (listing, claim, first check, hand-off)                                | sent                                 | held: pending and queued, not listed, no error, no timer                                                | failed                                       |
| An automation of the chat (its own lineage, `triggers.origin_connection_id`) | runs                                 | does not fire (nothing created, nothing moved); fires once, late, when back; a tick from before is held | ended with the chat                          |
| Replies and notices (`claimDelivery`, `startDeliveryAttempt`)                | sent                                 | kept, sent in order when back                                                                           | cancelled; one that may have left is unknown |
| A standard CDP attempt                                                       | opens                                | refused                                                                                                 | refused                                      |
| The list and the page                                                        | active                               | paused, with why and what becomes of messages                                                           | stopping, then stopped, with why             |

One wake brings everything back (`ChannelService #wakeHeld`: `wakeChatQueues`, then the ingress
drain): the person's resume, a successful check of the account, and the runtime reporting the
account healthy again each call it, and its commit wakes the dispatcher and the schedule loop.
"Held" is only ever read from the chat's state before anything reaches a Runner; once the send has
passed, an end the Home cannot confirm stays unknown.

### What a pause does to a message sent meanwhile

It depends on the transport, and the provider's manifest says which (`pausedMessages`,
`packages/channel-core/src/catalog.ts`); the screens say it in those words. iMessage keeps it: the
Mac's cursor in Messages history reads on from where it stopped, and a message more than an hour
old is answered that it came too late. Slack does not deliver it: Socket Mode holds nothing for a
closed connection, and nothing reads history on reconnect.

### What a memory pass reads

A memory pass reads tasks as the person's own conversations, and a chat others can speak in is not
that. So a memory worker's own task tree (a task whose lineage root is the task a memory automation
is anchored to: the pass and the workers it delegates to) sees, of tasks and of what derives from
them, only what has personal context; the rest reads exactly like what does not exist
(`readerSees`, `packages/database/src/task-reader.ts`, used by every agent-side read of a task, a
delegation, a Request or an automation). This keeps other people's words from being taken as the
person's. It is not a wall: a pass still reads the person's mail and messages, which other people
write, a task it creates for the person is an ordinary task of theirs, and its tab list may name a
task it cannot read.

### What Disconnect ends

Disconnecting a chat is the Disconnect above: its Runs, queued messages (the person's own on its
tasks included, since they take the task's lineage), automations and replies not yet sent. A reply
that may have been sent is kept as unknown and shown as "may have been sent", never sent again.
Removing a messaging account ends every chat on it.

## Automations

An automation is a script stored by the Home (`script`: text and an optional interpreter, defaulting
to the shipped Node) anchored to a task, started on a schedule, an HTTP request to its address, or
kept alive as a Watch. When it fires, the Runner runs the script directly with `OPENSTEER_EVENT` and
the `opensteer` CLI on `PATH`, acting under its anchor task's live authority
(`trigger:<occurrenceId>`, `watch:<activationId>`). Opensteer's own memory passes are two ordinary
automations.

- **Approval through the door.** Creating, changing, pausing, resuming, running now and removing are
  admitted through the one command door (`admitCommand`, `dispatchCommand`;
  `apps/host/src/mcp/handlers/triggers.ts`, `apps/host/src/triggers/trigger-routes.ts`). Creating,
  changing the script or when it runs, and running now run at once only in Full access with personal
  context on an anchor in the caller's own lineage, and otherwise open a Request showing the command
  and its script; approving a Request executes it while keeping the proposing connection's lineage
  rather than lending the person's authority. Pausing and cancelling a pending firing narrow
  authority and run now below Full access. Anything outside a caller's grant reads `not_found`, and
  a chat anyone may speak in holds no automation commands.
- **Addresses, bounds and contact loss.** A webhook address accepts any HTTP method and raw body,
  rate-limits before the database without logging requests, and is shown only to callers that may
  run the automation. One firing of an automation runs at a time (due ticks collapse; webhook
  requests queue up to 100), stored output is kept for the last 100 firings with 64 KiB tails, and
  failures never auto-pause an automation. A Home restart or lost connection never guesses a firing's
  outcome: the Runner reattaches and reports when back, and an unconfirmed firing settles as
  `unknown`, never retried.
- **Screens.** On web, desktop and mobile, the automations list and detail views show the stored
  script, recent firings and output tails, pause state with its reason and who paused it, contact
  loss, and pause/stop controls that confirm an end only with evidence.

## Where a Home runs

Every Home and every Runner trusts Node's certificate authorities plus the ones its computer
trusts (a Mac's keychains, Windows' certificate stores, a Linux container's `/etc/ssl/certs`), so
it reaches the Opensteer account through a network that inspects TLS
([opensteer-node-trust.mjs](../deploy/container/opensteer-node-trust.mjs)).
`OPENSTEER_SYSTEM_CERTIFICATES=off` where the app or the Home starts leaves Node's own list only.

### On a Mac

The Host listens on loopback. The one signed Opensteer app stays in the menu bar: closing the
window or pressing Cmd+Q hides it, and the Home, the device Runners and the native helpers keep
running. "Quit Opensteer Completely" exits. It opens at login while the Mac hosts a Home or serves
one, unless the person turns that off. Before sleeping, the Mac tells the other Homes it serves as
a device, which then show it as asleep instead of offline.

**First run.** The Opensteer account is the front door on the Mac, the phone and the account's
website: one primary action, Sign in. After sign-in the account decides what comes next: one
Home opens by itself (on the Mac and the phone, never on the website); none asks "Where should
your Opensteer live?" (this Mac, free while it is awake, or an Opensteer Cloud Computer at the
price checkout sells now, from the account's `offer`); several are a list. Starting a Home on the
Mac while signed in creates it, links it to the account and turns Remote access on in one step
(`remoteAccessOnWhenSignedInStart`, `packages/client/src/host/remote-access.ts`). "Use without an
account" starts the same Home as always and it never has to sign in; such a Home shows one card
inviting sign-in. Tailscale, an own address and pairing codes are under Remote access → Advanced
("Private network"). The phone shows no Cloud Computer price and no purchase button
(`phoneShowsCloudComputerPrice`, `apps/mobile/src/screens/cloud-computer-entry.ts`). Every client
names a Home's kind from one table (`homeKindWords`, `packages/control-plane-protocol`).

The Host never opens a device's files. The hosting device creates the Agent home folder and
serves bounded listings, previews and bytes over its authenticated channel. Devices always dial
the Home; nothing dials a device.

### The Linux Home

The same Home on a Linux server, packaged in `deploy/home` ([operator guide](../deploy/home/README.md)).

- **One HTTPS origin** behind Caddy, with automatic TLS. Seven services with separate state: the
  Host, PostgreSQL (no network listener), the gateway, the Runner, the browser, the browser's
  egress proxy and the messaging runtime, run as one Compose pod.
- **Separation.** The Host's keys and database credentials live in a volume the Runner does not
  mount. The Runner has no capabilities and a seccomp policy. Engines run as the Runner's own user
  under their own sandbox and safety modes, exactly as on a Mac.
- **Your own agents** on a Linux Home: the image ships Codex, Claude Code, OpenCode and Pi, and
  Antigravity downloads itself. Grok, Muse Code and Cursor are not in the image; they show as not
  installed.
- **Claim.** A self-hosted Home prints a single-use setup link for the first owner (24 hours by
  default). A managed Home is claimed through the person's Opensteer account. There is no local
  bootstrap.
- **Backup and restore.** Encrypted restic backups to S3-compatible storage. A restore goes into
  new volumes; the old set stays until the new one is healthy, and a claimed Home is not restored
  over without `--replace`. The check is made once: an operator must prevent claims during a manual
  cutover, because a claim that lands between the check and the swap is lost. Recovery journals are renamed out of the way before removal;
  conflicting evidence stops for an operator.
- **Update and rollback.** An update saves a database dump first. Migrations only add, so a
  rollback restarts the previous images and keeps the data. A managed Home accepts only
  digest-pinned images and refuses an update feed whose address does not resolve to public IPs.

### The Opensteer Cloud Computer

A Linux Home on a server Opensteer runs for one person: one Google Compute Engine VM per person,
bought through web checkout with Stripe. The account service holds a
desired state; a reconciler outside the Home (`apps/home-provisioner`) makes it true, journals
each provider write, and reports back. See [cloud-computer-operations.md](cloud-computer-operations.md).

- Sign-in is through the person's Opensteer account. A replacement made from a snapshot keeps the
  owner; the old VM is deleted only after the account has issued the owner a sign-in to the
  replacement.
- Public page loads leave through a pinned egress proxy and fail closed when it is missing or
  broken. This is a browser setting, not a boundary against an agent that controls the browser.
  Task shells use the VM's own address. The person sees it as the Browser IP.
- A Cloud Computer that is turned off is **Suspended**. "Last backup reported by this Cloud
  Computer" is what the computer reported.

**What the verifier proves.** `scripts/verify-home-deployment.mjs` builds the images and runs 34
checks against a real Linux Home in a local VM, or on the Linux server it runs on with
`OPENSTEER_HOME_VERIFIER_TARGET=local`: the seven services, HTTPS, no local bootstrap,
single-use setup and claim, Runner enrollment, Codex running as the Runner user in Agent home with
its account's own home, CDP through the gateway with a one-use ticket, egress through the
pinned proxy failing closed, no PostgreSQL listener, firewall rules, a Host restart keeping the
claim, backup, restore, refusal without `--replace`, image-only rollback and the managed install.
On Colima it runs arm64; locally it runs the server's own architecture. It does not prove
public certificates, real IPv6, a pristine Ubuntu install or a VM reboot.

## Problems and reports

A **problem** is a code from one table (`packages/protocol/src/problems.ts`): a severity
(someone has to act now, or worth knowing), one plain sentence with what to do, and at most a few
fields that are enums or bounded whole numbers. Its schema is strict, and
`packages/protocol/src/problems.test.ts` fails if a free-text field is ever added, so a problem
never carries an address, a title, task text, a file path, an account or device name, a token or
an error's own words. A Home derives its problems from what it already keeps
(`readStoredProblems`, `packages/database/src/home-problems.ts`) and from what its machine's
maintenance writes as fixed values (`deploy/home/machine-status.sh`); one read gives them
(`HomeProblems`, `apps/host/src/problems/home-problems.ts`). Adding a code is one entry in the
table and one place that counts it.

Who learns what depends on who runs the machine:

1. **The person, always.** Settings → General → Problems shows this Home's problems in the
   table's words. Nothing leaves for that.
2. **Opensteer, for what it runs itself**, with no question asked, because it is its own
   infrastructure. Its services log one stable event for each failure the
   [runbook](cloud-computer-operations.md#when-something-goes-wrong) names
   (`apps/control-plane/src/server/events.ts` and the provisioner's `home-provisioner.*`), with
   the same field names everywhere. Each job that must run sends a heartbeat, an HTTP GET to an
   address from configuration, at the end of each successful pass. The alerts are files in
   [deploy/monitoring](../deploy/monitoring/README.md). The event that matters most is its own:
   `account.cloud_computer.not_ready`, a person who paid and has no working Cloud Computer. Each
   Cloud Computer's Host sends a **health report** every 15 minutes, with the credentials its backup
   report uses. The account keeps only the latest one (`cloud_computer_health`, shown to the
   operator in `show <id>`). When a report names a problem that needs someone, the account logs
   `account.cloud_computer.unhealthy` with the computer's id, its version and those codes, and Cloud
   Logging keeps that line for its retention period. The person sees the exact bytes in that Home's
   Settings ("What Opensteer can see about this computer"). **What the operator of a Cloud Computer
   can see:**
   - the report: the computer's kind and release version, its disk as a range, each service healthy
     or not, its last backup and update results with their times to the minute, and its problem
     codes with their fixed details, counts and times to the minute;
   - the address the report comes from, which is the computer's own;
   - the account's own record of its setup, billing and backups.

   **What it cannot see through these:** anything the person or an agent did or holds on it,
   including pages, tasks, messages, files, accounts, sign-ins, names, logs and error text.

3. **People's own devices and self-hosted Homes: nothing is sent** unless the person turns it on.
   It is off by default, Settings shows the exact bytes before anything is sent, and while it is off
   nothing even wakes to check. Where a report goes is configuration, never the person's choice or
   an agent's:
   - **A Mac linked to the Opensteer account** (`OPENSTEER_PERSONAL_ACCOUNT_ISSUER`, which the
     desktop passes) sends Opensteer once a day only `{schema, home, version, codes}`: its kind, its
     version, and each problem code with a bucketed count (`1`, `2-9`, `10-99`, `100+`;
     `OpensteerProblemReportSchema`). No times, no services, no backup or update results, no account
     or id.
     - Opensteer also sees the internet address the report comes from, and the load balancer's request
       logs may keep it.
     - The account service logs nothing of a report. It keeps only how many reports named each code
       with each bucket on each day (`problem_report_counts`).
     - Those counts are untrusted. The endpoint is anonymous, so anyone can add to them. With one
       budget per replica (600 a minute, whatever address a request gives), a flood can crowd real
       reports out for that minute. No alert reads these counts.
   - **A self-hosted Linux Home** (`deploy/home`) names no Opensteer account. It sends nothing, and
     its switch stays off and cannot be turned on, unless `OPENSTEER_HOME_PROBLEM_REPORTS_URL` names
     the self-hoster's own collector. That collector then receives the full health report every 15
     minutes, and what it keeps is up to whoever runs it.
   - **Turning it on or off** is an ordinary command at the door (`settings.problemReports.set`,
     class `approve`). The person's own app changes it at once. An agent with standing to propose Home
     settings may propose either; that becomes a Request, and nothing changes until the person
     approves it. A connection whose grant does not reach Home settings reads it as not found.

The machine status is read only where `OPENSTEER_MACHINE_STATUS=root-maintenance` says root's
maintenance writes it (`deploy/home` sets it). There the file is in `host-data`, which no Runner
mounts, and the Host itself writes only in subfolders of that volume. Anywhere else an agent's shell
could write the file, so it is not read.

Rule 3 of AGENTS.md (nothing leaves the Home before it is in the Disconnect set) is about effects
done for a connection, and a report is not one. It is the Home's own, sent on its own timer, never
for a connection or a Run, and carries nothing a connection produced except codes and counts. An
agent reads problems through `opensteer_state` (area `problems`, for the person's own agents and
`everything` grants; outside a grant it does not exist) and may propose the setting as above. No
tool sends a report, reads one back, or changes where it goes or what it holds.

Not built yet, and where each would attach. A consent prompt at first run would set the same
setting, once, after setup. Crash reports from devices (Sentry's protocol, so a self-hoster could
point them at their own collector) would be a second switch beside it, with the desktop's
`crashReporter` started with uploads off until the person chooses. A "Report a problem" form would
send this same report and the person's own words, after showing both, from the Problems group.
Session recording and product analytics on devices are never to be built.

## What was measured

- **Two unmodified agents on one Home** (`tests/second-agent.integration.test.ts`). A real Home,
  Runner and Chromium. Both agents use the official MCP TypeScript SDK client and the Home's real
  OAuth flow. Agent A has profile A in Supervised and uses `browser_use`. Agent B has profile B in
  Full access and uses stock Playwright over `browser_connect`. Nine claims: each works signed in
  only in its own profile; each has its own task and tab; neither can list, read, open, attach to
  or learn of the other's (refusals match a non-existent item, and `Target.getTargets` shows only
  its own pages); Supervised holds the effect, Allow once finishes it and Don't allow returns
  `declined_by_person`; the Request wording names the agent; the person watches both agents' exact
  pages without interrupting either; Stop ends A's work in flight while B carries on; Disconnect
  closes A's socket, its old token gets 401, it reaches Disconnected, and B finishes; neither
  receives the other's data or any secret.
- **Your own agents do no more database work than on `main`.** Fifteen hot paths of the person's
  own agents were measured against `main`: task read, tab open and close, input to dispatch,
  Runner events, shell read, tab projection, task and Request lists, Runner attach, page commands,
  a plugin call, keystrokes and frames. None issues more statements; several issue fewer (a Run's
  tab open 312 against 344, a Run's plugin call 197 against 210). Wall times show no consistent
  slowdown. `apps/host/src/runtime/personal-hot-paths.integration.test.ts` pins the shell read at 18
  database round trips and the warm tab projection at 1.

## Known limits

- **A filled value is readable in the page.** An agent that controls a page can read a field
  Opensteer just filled. Approval decides which login or card is released, to which site, each
  time. It does not hide the value afterwards.
- **Saved logins and cards work only in the browser of the person's own Mac that hosts the Home.**
  Not on a Cloud Computer, not on another device, not over `browser_connect`.
- **Auto asks the person** before a connected agent's direct effect.
- **A repeat is recognised only with the same `operationKey` or `operationId`.** Without either,
  the key is the MCP call id, and a retried call is a new operation.
- **Disconnect can stay Stopping** for as long as a Runner cannot prove an end. A Runner too old to
  report stop state never proves one. Older CDP routes are closed without being tracked as
  attempts.
- **Disconnected can include an uncertain end.** "Check its last action" marks it.
- **Opensteer can stop what happens next, not undo what was done.** That includes everything the
  person's own agents did for a connected agent with `tasks`, and anything an agent copied out.
- **What a confirmed Stop proves.** A confirmed Stop proves that the engine and every process of
  it that this device can attribute to the task have ended (on Linux, the process supervisor also
  acts as a child subreaper; on Windows, it uses a Job Object; on macOS, detached `setsid`
  descendants can stay alive after a Runner crash until the Runner's next boot reaps earlier boots).
  If the device cannot complete a clean process scan, Stop stays unconfirmed and holds the task. A
  program an agent asked the system to start outside its own process tree — such as an app opened
  through the system, a launch agent, a container, or work on a remote machine — is not ended by
  Stop and is not part of the proof.
- **Two agents granted the same profile share its signed-in state.** Each sees only its own pages
  over `browser_connect`, but cookies and sign-ins belong to the profile. Give each agent its own
  profile to keep accounts apart.
- **An older runtime refuses a connected agent's `browser_connect`** until Opensteer on that
  device is updated. `browser_use` is not affected.
- **The egress proxy is a browser setting**, not a boundary against an agent that controls the
  browser.
- **A connection lasts 30 days** and then needs a new sign-in; there are no refresh tokens.
- **An `everything` connection lists up to 18 tools.** The person’s own agents can administer the Home.
- **Stop while watching** interrupts the picture until the viewer reconnects.
- **A Mac's sleep notice** reaches the device Runners it serves, not the Runner of a Home on the
  same Mac, and ends only connected agents' computer-use scripts.
- **Backups and the old VM.** "Last backup" is what the Cloud Computer reported. A replaced VM is
  deleted once the account issued the owner a sign-in to the new one, not once a session there is
  proved.
- **The Linux Home verifier does not prove** public certificates, real IPv6, a pristine
  Ubuntu install, or a VM reboot during boot or restore. It proves AMD64 only when run on an
  AMD64 server in local mode.

## Not built, on purpose

Fleets of micro-VMs, a broker across server providers, throwaway CI sandboxes, model or Git
proxies, cookie or event blocklists on the browser protocol, per-site allowlists, per-app tools,
"take over and give back" modes, a Home shared by several people, an organization above a person
that caps what they may grant, a builder for custom roles, and card filling on another device.
