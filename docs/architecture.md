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

> the person's ownership ∩ the organization's ceiling (on a work Home) ∩ the connected agent's
> grant (when the work descends from a connection) ∩ the task's mode ∩ the device's switch ∩ the
> target's own approval.

The terms are intersected. None of them outranks another, and none widens another. An answer from
the person allows one operation inside the grant; it never widens the grant.

The rule is resolved in one module, `packages/database/src/resource-access.ts`:

- `admitExecution` says whether an execution may act at all. It resolves who the work is for from
  the binding the Home issued (`run:`, `thread:`, `trigger:`, `watch:`, `session:`), never from
  what a caller says. It checks the owner and that the execution is still live. When nothing
  resolves, the answer is a refusal, never Full access.
- The connection's live state is read in one statement: grant, grant revision, consent version,
  mode ceiling and, on a work Home, the organization's policy joined into the same `SELECT`
  (`readLiveAgentConnectionRow`). The policy can therefore never be read at a different moment
  from the grant. A personal Home runs no policy query at all.
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
current screen (version 2).

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
/v1/agent-directory`, `apps/control-plane/src/agent-directory/`). Each entry has a display name,
exact HTTPS origins, optional keys, and optionally the platforms it is embedded through. The
Home fetches it from its configured account origin over HTTPS, checks the signature against that
origin's published keys, and caches it (refresh every 15 minutes; a copy is usable for 24 hours).
A Home never fetches an address an agent supplies. See [agent-directory.md](agent-directory.md).

- **Verified** means the redirect address the person consented to has exactly the origin of a
  directory entry. The consent heading then shows that entry's name with a verified mark.
- **Verified through a platform** ("Errand via AgentPay") additionally needs a short-lived
  assertion (at most 120 seconds, single use) signed by the embedding party's directory key and
  bound to this request's client, Home, redirect address, PKCE challenge and state.
- **Anything else is unverified**: heading "An agent wants to connect", with its own name shown
  as its claim. An assertion that does not verify makes the consent unverified; it never fails
  the sign-in.
- Consent uses the cached copy. A Home that has never accepted a copy waits at most two seconds
  for one, then shows everything as unverified.
- If the directory later removes an origin, a pairing or a key, the connection shows "No longer
  verified since {date}" and offers Disconnect. The Home never disconnects on a remote list's
  say-so. If verification changes between the consent screen and the approval, the approval is
  refused with `consent-verification-changed` and the person looks again.
- The embedding party gets nothing: no code, no token, no grant.

### What a connected agent is shown

The tool list is built from the grant (`packages/agent-tools/src/tools-for.ts`). A tool the grant
does not imply is neither listed nor callable.

| Grant part        | Tools it brings                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
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

An `everything` connection lists all 15 tools on a Home with Passwords. Full access and Supervised
list the same tools, and the grant and access mode still govern each call. Connections have no
settings tools or output schemas. Server instructions are built from the same grant, and
`apps/host/src/mcp/connection-contract.test.ts` checks the exact tools for eight grant shapes.
Listing sizes are pinned in `tests/agent-context-budget.json`.

**Outside the grant reads exactly like non-existent.** A refusal about a target the connection
may not know of is rewritten to `not_found` with a fixed message and no advice
(`apps/host/src/mcp/agent-tool-failure.ts`, `packages/agent-tools/src/results.ts`). Pinned by
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
`apps/host/src/agent-sessions/agent-session-service.ts`. That covers `tab_list`, `browser_use`,
`browser_connect`, `computer_use`, the live listing of `computer_apps`, `plugin_call`,
`plugin_execute`, `plugin_resume`, `saved_login_request`, `card_request` and `ask_person`.

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
  grant revision, the effective mode, who decided (`structural-read`, `full-access`, `reviewer`,
  `person`, `refused`), the hand-off time and the outcome: `completed`, `failed`, `refused` or
  `unknown`.

### The guarantees

1. **One door.** Direct work enters only through `run()`. A handler that acts without it is a bug.
2. **The witness.** An operation is admitted under a grant revision, an effective mode and a
   target generation. At hand-off, a changed revision, mode, target generation or target grant
   sends it back for a fresh decision. While it runs, the tool re-checks the revision and mode
   before each command it sends to a device. For
   `browser_connect`, every CDP command, every frame from the browser and a timer once a second
   re-check the same facts; any change closes the socket.
3. **Held when the mode says so.** A read runs in any mode. An effect runs at once in Full
   access. In Supervised and Auto-accept edits the person is asked. In Auto a reviewer on the
   Home may allow it; anything other than a clear allow within 15 seconds (no model, an error, a
   timeout, an odd answer, a prompt too long, text that looks like a credential) asks the person.
   The reviewer runs only when a review model is configured (`OPENSTEER_AGENT_REVIEW_MODEL`);
   without one, Auto asks the person. The reviewer is told that page titles, app names, the
   calls and the agent's own reason are untrusted. The person sees a page title or an app's own
   name as a labelled plain line ("The app calls itself: …").
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
   mode or connection changed during the work), `organization_not_allowed`, `not_found`,
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
and one sentence, for example: "Cursor starts with your own Cursor settings, so it runs only tasks
you started yourself that no connected agent or chat has written to." The Home offers every engine
to every task and does not refuse by engine itself, so the Runner refuses. Background text (task
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

### Disconnect

Disconnect revokes the connection in one transaction (`AgentConnectionStore.revoke`). It locks the
connection row, and every admission that hands work off holds the same row, so nothing new is
admitted once it commits. Then one worker converges over one set
of attempts (`packages/database/src/connection-disconnect.ts`, driven by
`OpensteerStore.driveConnectionCleanups`). The set holds everything in the connection's lineage:
Runs and their handed-off generations, automation occurrences and their attempts, Watch
activations, queued inputs, Requests, steering commands, active automations (paused), agent
sessions and operations, plugin executions, standard CDP connections and shared Chrome tabs.

**Nothing leaves the Home before it is in the set.** A Run is recorded before its frame is built;
a CDP attempt before the attach ticket goes to the browser runtime; a plugin execution before the
call reaches the plugin engine. The one-use `browser_connect` address an agent receives is not a
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

Expiry, a narrowed grant, a lowered mode and a narrower organization policy go through the same
worker. The person's other work is untouched. Disconnect does not close tabs.

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
   stopped".

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

**Chrome tabs the person shares.** The companion extension, listed as "Opensteer tab sharing",
shares tabs from the person's own Chrome (a `chrome-tabs` grant). The agent finds them with
`tab_list` and works in them through `browser_use` or `browser_connect`. Stop, Disconnect and a
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

## Organizations and work Homes

An organization owns work Homes on Opensteer Cloud Computers, each assigned to one person, who is
its only owner. The organization pays and governs; it is never a user of the Home.

**Four switches, no rule language** (`packages/control-plane-protocol/src/organizations.ts`):

| Switch            | Default               | Means                                                          |
| ----------------- | --------------------- | -------------------------------------------------------------- |
| `externalMaxMode` | `approval-required`   | the highest mode a connected agent may have                    |
| `allowEverything` | `false`               | may an agent be granted everything (also needs `allowTasks`)   |
| `allowTasks`      | `false`               | may an agent be granted tasks                                  |
| `devices`         | `cloud-computer-only` | or `assignee-may-enroll`: may the person add their own devices |

- **Delivery.** The account service signs the policy with its version and the assignment's state.
  The Home verifies it, keeps the highest version, applies it, and reports what it applied. It
  fetches at start, on a signed change notice and every 30 seconds.
- **Fail static.** If the account service is unreachable, the last applied policy holds and the
  Home keeps working. Cutting a Home off is done by suspending its computer.
- **Enforcement** is the organization term of the authority rule, joined into the connection read.
  A narrower policy revokes or narrows connections in one transaction and the Disconnect worker
  stops their work. Refusals read `organization_not_allowed` ("Your organization doesn't allow
  this"). The person's own agents are not capped by it.
- **Audit without content.** Each recorded event is written to an outbox in the same transaction
  as the change, with a gapless sequence and a hash chain, and pushed signed with the Home's key.
  Kinds: connection consent, grant change, disconnect, expiry; agent session start and end; each
  direct operation; Requests opened, answered, expired; Stop; device enrolled, removed, switch
  changed; owner sign-in and sign-out; policy applied. Records hold ids, enums and times only:
  no addresses, titles, scripts, results, messages, file names or labels. The account service
  accepts only the next contiguous range and shows a gap as a gap. The person sees the same list
  under "What {organization} can see".
- **What an admin can never do:** sign in to the Home, answer its Requests, watch it, or see
  pages, messages, prompts or files. Work sign-in is issued only to the assignee. Membership never
  gives access to anyone's personal Home or Mac.
- **Offboarding:** sign-in is cut, the Home is asked to send its last audit records, the computer
  is suspended, then deleted after the chosen retention. Deletion shows three facts: "Computer and
  disk destroyed", "Backups made unreadable", "Stored backup data removed". A work Home is never
  reassigned.
- **Devices.** A device that joins a work Home is told so first (the Runner's command line prints
  the notice and refuses locally when the policy allows no devices), and the Home's database
  refuses a device the policy forbids.

## Where a Home runs

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
  mount. The Runner has no capabilities and a seccomp policy. Agent shells run in bubblewrap with
  the Runner's data masked.
- **Your own agents** on a Linux Home are Codex and Claude Code (pinned in the image). The other
  engines refuse to run on that shared Runner.
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

A Linux Home on a server Opensteer runs for one person: one VM per person (Hetzner Cloud in the
current provisioner), bought through web checkout with Stripe. The account service holds a
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
single-use setup and claim, Runner enrollment, sandboxed Codex that cannot read another profile or
the Runner's credentials, CDP through the gateway with a one-use ticket, egress through the
pinned proxy failing closed, no PostgreSQL listener, firewall rules, a Host restart keeping the
claim, backup, restore, refusal without `--replace`, image-only rollback and the managed install.
On Colima it runs arm64; locally it runs the server's own architecture. It does not prove
public certificates, real IPv6, a pristine Ubuntu install or a VM reboot.

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
  database round trips and the warm tab projection at 1, with no organization query on a personal
  Home.

## Known limits

- **A filled value is readable in the page.** An agent that controls a page can read a field
  Opensteer just filled. Approval decides which login or card is released, to which site, each
  time. It does not hide the value afterwards.
- **Saved logins and cards work only in the browser of the person's own Mac that hosts the Home.**
  Not on a Cloud Computer, not on another device, not over `browser_connect`.
- **Auto asks the person unless a review model is configured** on the Home.
- **A repeat is recognised only with the same `operationKey` or `operationId`.** Without either,
  the key is the MCP call id, and a retried call is a new operation.
- **Disconnect can stay Stopping** for as long as a Runner cannot prove an end. A Runner too old to
  report stop state never proves one. Older CDP routes are closed without being tracked as
  attempts.
- **Disconnected can include an uncertain end.** "Check its last action" marks it.
- **Opensteer can stop what happens next, not undo what was done.** That includes everything the
  person's own agents did for a connected agent with `tasks`, and anything an agent copied out.
- **Two agents granted the same profile share its signed-in state.** Each sees only its own pages
  over `browser_connect`, but cookies and sign-ins belong to the profile. Give each agent its own
  profile to keep accounts apart.
- **An older runtime refuses a connected agent's `browser_connect`** until Opensteer on that
  device is updated. `browser_use` is not affected.
- **The egress proxy is a browser setting**, not a boundary against an agent that controls the
  browser.
- **A connection lasts 30 days** and then needs a new sign-in; there are no refresh tokens.
- **An `everything` connection lists up to 15 tools.** The person’s own agents can administer the Home.
- **Stop while watching** interrupts the picture until the viewer reconnects.
- **A Mac's sleep notice** reaches the device Runners it serves, not the Runner of a Home on the
  same Mac, and ends only connected agents' computer-use scripts.
- **Backups and the old VM.** "Last backup" is what the Cloud Computer reported. A replaced VM is
  deleted once the account issued the owner a sign-in to the new one, not once a session there is
  proved.
- **A work Cloud Computer cannot be replaced by an operator**; recovery is an in-place restore, or
  ending the assignment and assigning a new one. Organization invitations are not emailed.
- **The Linux Home verifier does not prove** public certificates, real IPv6, a pristine
  Ubuntu install, or a VM reboot during boot or restore. It proves AMD64 only when run on an
  AMD64 server in local mode.

## Not built, on purpose

Fleets of micro-VMs, a broker across server providers, throwaway CI sandboxes, model or Git
proxies, cookie or event blocklists on the browser protocol, per-site allowlists, per-app tools,
"take over and give back" modes, a Home shared by several people, a builder for custom roles,
policy expressions, content in the audit export, self-hosted work Homes, and card filling on
another device.
