# Architecture

Opensteer is your personal cloud computer for AI: **connect a device once; every AI agent you use
can reach your real accounts and devices, only as far as you allow, and you can watch and stop it
from your phone.**

Agents fail at the last mile of being you. A cloud agent runs on a datacenter address with an empty
browser: sites block it, it has no logins, it stops at a second factor, a card form or a code sent
to your phone. A local agent works only while the laptop is awake and cannot be steered from a
phone. Opensteer is the layer in between that the person owns. It is neutral across agents, it
keeps the state that makes an agent useful (signed-in profiles, enrolled devices, what each agent
was granted), and it puts the trust loop on the phone: grant, watch, answer, stop.

The test the design is held to: two independent agents on one Home with different grants, both
watchable, one disconnected while the other keeps working
([`tests/second-agent.integration.test.ts`](../tests/second-agent.integration.test.ts)).

There are two public names, **Opensteer** and **Opensteer Cloud Computer**. Everything else a
person reads is plain English.

## Four nouns

| Noun | What it is | In code |
|---|---|---|
| **Home** | One authoritative place per person: the Host, its PostgreSQL and the hosting Device where the person's own engines run. It lives on their Mac, on any Linux server they run, or on an Opensteer Cloud Computer. | A `personal` Deployment (`apps/host`). Whether it listens on loopback or on a public origin is derived from its configuration, not a third kind. |
| **Device** | Something an agent can act through: a Mac, a Linux server, an Android Agent Phone, an iPhone, a tab shared from Chrome. It has a stable identity and switches for Browser, Apps and Files, and it dials the Home outbound. | `devices` and `device_drivers`, reached through a Runner (`apps/runner`) or the Agent Phone app. |
| **Agent** | Whoever does the work: the person's own engines (Claude Code, Codex and the rest) running on the Home, or an outside agent (Claude, ChatGPT, Cursor, a vertical agent) connected over MCP with OAuth. | A `Run` for the person's engines. An `AgentConnection` with an `AgentGrant` for an outside agent. |
| **You** | The person, on phone, web or desktop: one grant per agent, one inbox of things that need you, live watching with shared input, and one Stop and one Disconnect. | Owner sessions on the `@opensteer/client` clients. |

## One authority rule

An effect happens only if every ceiling that applies allows it:

> owner (and the organization's policy, if the Home is a work Home) ∩ the agent's grant (if the
> work descends from a connection) ∩ the task's mode ∩ the Device's switch ∩ the target's own
> approval.

Ceilings are intersected, never ranked. Nothing defaults to full access: when no authority
resolves, the answer is no. The mode of a piece of work is the lowest mode anywhere in its
ancestry, read at the moment the effect happens. A person's approval allows one operation inside
the grant and never widens the grant. The Home enforces all of it; an agent never decides whether
to ask.

One module resolves authority for everything that can act (a Run, a task, an automation, a Watch,
an outside agent's session), and every enforcement site calls it: listing tools, calling a tool,
opening a tab, a browser or an app, a plugin call, attaching to a browser, opening a Request.

The person's own agents, working for the owner with no connection in their ancestry, behave
exactly as before.

## What an outside agent is granted

```ts
type AgentGrant =
  | { scope: "everything" } // what the person's own agents can do
  | { scope: "selected"; tasks: boolean; resources: AgentGrantResource[] };

type AgentGrantResource =
  | { kind: "browser-profile"; profileId } // full, honest control of that profile
  | { kind: "computer-app"; … } // one approved Mac app on one Device, or one phone screen
  | { kind: "plugin"; target; access: "read" | "read-write" };
```

A connection is what the Home can prove about the client (its registered fingerprint and the
redirect destination the person consented to; a name the client gives itself is shown as its own
claim), a label, a mode ceiling, the grant, a revision that only goes up, an expiry and a
revocation time. When Opensteer's signed directory recognises the destination, consent shows the
verified identity.

- **Tools follow resources.** `tasks` brings the task tools. A browser profile brings the browser
  tools for its tabs. An app or phone brings `computer_use`. A plugin brings the plugin tools. A
  tool the grant does not imply is neither listed nor callable.
- **`tasks` is its own grant.** It lets the agent ask the person's own engines to work on the
  Home, with the files, commands, credentials and network of the engine's account, under the mode.
  Consent says so plainly.
- **Sharing a profile shares its signed-in state.** Consent offers an existing profile or a new
  dedicated one. There is no cookie blocklist and no per-site allowlist: control of the chosen
  profile is complete and stated honestly.
- **A granted thing that changed is not granted.** An app with a different signer, a new approval
  or a removed profile simply falls out of the grant.

## Delegation never widens authority

Everything that can run later carries the connection it came from: tasks and their child tasks,
queued inputs, Runs, automations and their occurrences. A Run with a connection in its ancestry
gets the lower of the task's mode and the connection's, sees only what the grant holds, and uses
its own engine session, never one created under different authority. A `selected` connection sees
and touches only its own tasks. When a connection is revoked or expires, everything descended
from it has no authority.

## Direct work

An outside agent's own model can act directly, with the same general primitives the person's
agents have. There are no per-site or per-app tools.

Its work belongs to an **agent session**, the way native work belongs to a Run. A session is
anchored to one listed task, so the existing Tasks, Tabs, Watch, shared input, Needs you and Stop
surfaces show an outside agent's work with no second interface. It starts with the agent's first
direct call and ends on Stop, Disconnect or idleness. It works on a Home with no engine installed.

Each direct call is recorded as an **operation** before it is reviewed or sent: what, on which
target, under which grant revision and mode, who decided, and how it ended (`completed`, `failed`,
`refused` or `unknown`). That record is the activity the person sees, the audit trail, and what
makes a repeated call return the same result instead of acting twice. One function runs every
direct tool (`apps/host/src/agent-sessions/agent-session-service.ts`).

The primitives:

1. **Tasks.** Ask the person's engines to do something.
2. **The browser.** Full control of a granted profile, two ways onto the same authorised
   browser: `browser_use` runs a script with the page API the person's own agents use, and
   `browser_connect` returns a short-lived, single-use `wss://` endpoint that stock Playwright
   attaches to. The isolation boundary is the browser profile: work from one connection never
   shares a browser context with another's. A tab the person shares from their own Chrome (a
   companion extension) is reached the same way.
3. **Approved apps and phones.** `computer_use`, scoped to the granted app or phone screen.
4. **Plugins and device data.** `plugin_call`, filtered by the grant when tools are listed and
   again when one is called.
5. **The person.** Three things an agent cannot do alone: fill a saved login, fill a saved card,
   and ask a question only the person can answer (such as a code sent to their phone, which they
   enter in the shared tab). Each is a Request the person answers; the agent never sees a secret.

## Modes, review and Needs you

For a task handed to the person's engines, the engine's own mode handles review as before. For a
direct call, after the authority check: a read runs; in `full-access` an effect runs; in `auto` a
reviewer on the Home may allow it or pass it to the person, and anything other than a clear allow
(no model, an error, a timeout, an odd answer) goes to the person; in the stricter modes the
person is asked. Page content, plugin output and the agent's own words are evidence, never
instructions. A raw browser attachment is approved once, as one interval of full control.

A Request for a direct call is durable and tied to exactly one operation. Answering it settles
both in one transaction. The call waits a short while for the answer, then returns `pending`;
the same call repeated later picks up the decision. A change of grant, mode or target in between
needs a fresh decision. An effect whose reply was lost stays `unknown` and is never retried on
its own.

## Stop and Disconnect

**Stop**, on a task or a tab, interrupts that Run or ends that agent session, and the agent is
told the person stopped it.

**Disconnect**, on a connected agent, revokes the connection in one transaction and then
converges: every piece of work that was handed off under the connection is recorded with what it
was admitted under, and one worker stops each of them through its own stop command and settles
only on proof that it ended. The states are honest. **Revoked** as soon as the transaction
commits. **Stopping** while anything lacks that proof. **Stopped** when everything either never
left the Home or confirmed its end. **Last action uncertain** can remain after Stopped, when
contact was lost in the middle of an effect. Expiry and narrowing a grant go through the same
worker. The person's other work is untouched.

## Where a Home runs

- **On a Mac.** The Host listens on loopback; the one signed app stays in the menu bar so the Home
  and its Devices keep working with the window closed. **Stop on this Mac** is local and works
  with no Home reachable: while stopped, agent work on the Mac does not exist; the person's own
  tabs and views are never blocked. A Mac that is going to sleep, or was stopped, tells each Home
  it serves, so the Home can say "asleep" or "stopped" instead of "offline".
- **On a Linux server.** One HTTPS origin behind a gateway, a single-use setup link for the first
  owner, and seven services with separate state: the Host, PostgreSQL (no network listener), the
  gateway, the Runner, the browser, the browser's egress proxy and the messaging runtime. Agent
  shells are sandboxed away from the Home's keys and the Runner's credentials. Encrypted backups
  with a restore that never overwrites the only good copy. See
  [the operator guide](../deploy/home/README.md).
- **On an Opensteer Cloud Computer.** The same Linux Home on a server Opensteer runs for one
  person: web checkout, a desired state that a small reconciler outside the Home keeps true, and
  sign-in through the person's Opensteer account. See
  [operations](cloud-computer-operations.md).

The Host never opens a Device's files. The Device that owns a workspace creates it and serves
bounded listings, previews and bytes over its authenticated channel. Devices always dial the
Home; nothing dials a Device.

## Organizations

The same path: grant, Request, watch, stop. An organization owns a work Home assigned to exactly
one person, with a policy ceiling the Home applies as one more term in the authority rule, an
audit export, and clean offboarding. Membership never grants anyone access to a personal Home or
a personal Mac.

## What is deliberately not here

Fleets of micro-VMs, a broker across server providers, throwaway CI sandboxes, model or Git
proxies, cookie or event blocklists on the browser protocol, per-site allowlists, per-app
micro-tools, "take over and give back" modes, a Home shared by several people, a builder for
custom roles, and card filling on a remote Device.
