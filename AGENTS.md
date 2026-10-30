# Opensteer

Opensteer turns a person's computer into an agent workstation they steer from
their phone. A Host (`apps/host`, with its own PostgreSQL) runs on their
computer. Runners drive the coding agents they already pay for (Claude Code,
Codex, Cursor, OpenCode, Pi), plus browsers, apps and shells. Web, desktop
(Electron) and mobile (Expo) clients connect to it locally or from anywhere.
It's an early alpha.

## What we never compromise on

1. **It runs on the person's computer.** Their files, accounts, credentials and
   agent sessions stay there. Hosted pieces (the Account service and Connect in
   `apps/control-plane`) only help devices find and reach that computer; they
   never hold the person's work. We don't plan a cloud-hosted product, even
   though some code still suggests one: don't build on those paths.
2. **Fast on a phone, even on a weak connection.** People attach over cellular
   data. Watch bytes on the wire, round trips before the first screen, and
   redraws while text streams. `pnpm bench:mobile-network` measures attach on
   slow links.
3. **Every surface.** Web, desktop and mobile (iOS and Android), plus enrolled
   computers and Agent Phones. A feature that works on one surface and is
   missing on the others is unfinished.
4. **Old releases keep working.** Phones update late. A new Host serves the
   previous release's clients, and a new client handles the previous Host.
5. **Secrets stay secret.** Credentials, saved passwords, pairing codes, push
   tokens and signing material never reach logs, wire payloads they don't need
   to be in, or the repo.

## A note from Tim

I like ambitious ideas, simple systems and software that feels obvious. Don't
preserve complexity because it already exists, and don't add machinery because
it looks architecturally impressive. Understand the real constraint, then find
the smallest design that makes the correct behavior unsurprising. Measure twice,
cut once, and don't build what isn't needed yet. Fight scope creep, and honor
what the person asked for, minimally and realistically.

Most work here is done by agents, many at once on one shared Mac, often steered
from a phone. Treat everything below as strong defaults, not law: the person
you're working with can override any of it. If a rule fights the task in front
of you, say so plainly and get sign-off before breaking it.

## Words

- **you**: the agent reading this. **Tim**: the founder, who approves the
  changes listed under [Pull requests](#pull-requests). **person**: someone
  using Opensteer.
- **Host**: the server in `apps/host`. **Deployment**: one Host and everything
  it owns. A **Personal** Deployment is single-user and loopback-only, running
  on the person's own computer; an Account-attached Deployment is a server.
- **Runner**: the process that runs agents, browsers, integrations, messaging
  and shells on a machine. **Computer**: one Runner identity enrolled in a
  Deployment, with a fixed grant of modules it may offer.
- **Workspace**: a shared space of Threads and tabs with its own membership.
  Each person has a Main Workspace.
- **Thread**: a durable conversation and its native agent history. Its role is
  `conversation` or `work`; the UI calls a work Thread a **task**. **Chat** is
  the Main Workspace's home Thread, still named `home` / `homeThreadId` in code
  and on the wire. **Run**: one turn of an agent on a Thread.
- **Request**: something a Run needs from a person, such as an approval, an
  answer or a sign-in. The UI shows it as "Needs you".
- **Engine**: an agent CLI a Runner drives, through `packages/harness*`.
- **Agent Phone**: an Android phone that the `apps/agent-phone` app turns into
  a computer agents can use.
- **Beta** and **stable**: the desktop release channels. The stable app has no
  Account issuer, so Account sign-in and Connect exist only on Beta.

## Ways to hurt yourself

1. **Touching the live install.** `~/Library/Application Support/Opensteer Beta`
   and `~/Library/Application Support/Opensteer` hold Tim's real installed apps,
   with their databases and credentials. Never point dev, tests or scripts at
   them, and never migrate, repair or delete anything there.
2. **Killing by pattern.** Many agents and dev stacks share this Mac. Never
   `pkill -f`, `killall` or kill a PID found by matching a name or path. Stop
   only processes you started, by the PID you captured.
3. **Driving the real screen.** Anything that drives the screen, keyboard,
   windows or Electron runs in a disposable VM (`pnpm test:vm`), never on the
   host. Emulators and USB phones have one owner at a time.
4. **Handling key material.** Signing certificates, notarization keys and
   release credentials are Tim's. Agents never read, export or rotate them.
5. **Leaving things running.** Stop every server, database, emulator, `adb`
   server and capture loop you start, including after a failure. They take
   phones, ports and screen capture away from everyone else.

## Hit every surface

The most common defect is a change that works on the path you tested and is
missing everywhere else. Before calling a change done, walk this list and say
which entries applied:

- **Clients.** Web, desktop and mobile reach the Host through
  `@opensteer/client` (`packages/client`). It has no Node APIs; platform
  capabilities come in through ports.
- **Host API.** A browser-facing capability goes in
  [hostApi](packages/protocol/src/host-api.ts), with matching handlers, scope
  and mock behavior. Domain mutations use `commands.dispatch`.
- **Previous release.** Old clients against the new Host, and the new client
  against the old Host. Bump the Host API epoch only as
  [Host compatibility](docs/host-boundaries.md#compatibility) allows.
- **Agents.** If a person can do it, decide whether agents should reach it
  through the [tool catalog](packages/agent-tools/src/catalog.ts).
  Model-facing text has behavioral evals in `evals/agent-tools`.
- **Deployments and channels.** Personal and server Deployments; stable without
  an Account, and Beta with one.
- **Connections.** Same computer, private network, Connect, and a weak cellular
  link. Several devices on one Deployment at once.
- **Reverse states.** If you added a way in, add the way out and a way to see
  it. A one-way door is a bug.
- **Guidance.** Does the change make a doc, skill or this file wrong? Apply
  [Documentation](#documentation).

## Developing

Use the Node and pnpm versions in [package.json](package.json). Local setup also
needs Go and a running Docker daemon.

```sh
pnpm install --frozen-lockfile
pnpm setup:local          # check prerequisites, start local services, write .env
pnpm dev                  # start the development stack
pnpm exec vitest run <files>            # inner loop; skips native helper builds
pnpm test:integration -- <file>         # one real-PostgreSQL integration file
pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh  # macOS GUI journeys in a VM
pnpm engines              # shipped engine pins against their latest releases
pnpm test:engines         # drive the shipped engines on real accounts (costs money)
pnpm build:agent-phone    # build the Agent Phone APK into the web and desktop builds
pnpm test:agent-phone     # Agent Phone setup and use on an Android emulator
pnpm desktop:install-local  # signed local Mac build for feedback
```

Step-by-step procedures (running journeys, testing on devices, releases,
debugging infrastructure) live as skills in `.agents/skills/`, also reachable
as `.claude/skills/`.

## Verifying

- Before pushing, run `pnpm check:changed --base origin/main` and the focused
  test or journey that proves the behavior. **Do not run repo-wide checks:** no
  `pnpm check`, `pnpm test` or full `pnpm test:integration` unless Tim asks.
  CI owns the full suite.
- Test what a person would notice breaking, at the cheapest layer that catches
  it, with real collaborators where they're cheap. Add an end-to-end journey
  only when the bug only shows end to end: one per user-facing flow, not per
  edge case.
- Every test guards something specific, runs quickly and isn't a duplicate.
  Extend an existing case before adding one. Deleting duplicate or useless tests
  is maintenance, but never drop the only coverage of a past real bug or a
  security property without moving it somewhere cheaper.
- Fix bugs at the root, with a regression test that fails first. Before changing
  ownership, wire contracts or cross-process architecture, get one review of the
  smallest design, then build it.
- Never weaken an assertion or lengthen a timeout to get green. Skipped is not
  passed. Fix a flaky test at the root, or quarantine it in `tests/quarantine.json`
  with a reason ([flaky tests](docs/testing.md#known-flaky-tests)).
- Wait on the thing itself: await the event or promise, use `vi.waitFor` with a
  condition, or use fake timers. No sleeps, polling loops or `retry`. Every wait
  on something the test set up gets a deadline well inside the test timeout and
  a message saying what never happened. An unbounded wait burns the whole
  timeout, and in integration files a timeout fails every later test in the file.
- Pure-logic Swift runs on the host with `swift test`. VM journeys run after
  merge or on request, never as a pre-merge gate. Engine bumps need
  `pnpm test:engines` ([AI engines](docs/ai-engines.md#engine-releases-and-new-models)).
- If one blocker has eaten about 15 minutes, report the evidence, your
  hypothesis and your next step instead of grinding.

## Pull requests

- Work in your own worktree. **One request is one PR** on
  [steerlabs/opensteer](https://github.com/steerlabs/opensteer), with a
  conventional title (`fix:`, `feat:`, `docs:`, `refactor:`, `test:`, `chore:`).
  It includes whatever it takes to land: a bug the change exposes, a flaky test
  blocking its CI, a tooling problem in the way. Say so in the body. Split only
  when Tim asks or part of it needs his approval.
- When you split a request across agents, each works on its own branch in its
  own worktree and opens no PR. You merge their branches into one PR branch and
  open one PR.
- Push when the change is ready for review, not after every edit. Every PR and
  every push runs CI on one shared queue of 60 jobs, so a dozen small PRs or
  pushes block everyone's checks for hours.
- The body says what changed and why, the evidence, and any checks you couldn't
  run.
- After pushing, call `watch_pull_request` and end your turn; you're woken on
  checks, comments and conflicts. Don't poll. Verify each bot finding against
  the source: fix real ones, and dismiss false positives with a written reason.
- Fix failing checks on the branch, never by weakening a test. There's no
  batching and no up-to-date requirement. Main runs the full CI suite; fix
  forward or revert a red main immediately.
- You may squash-merge your own PR once the required `Check` is green and
  Greptile has no unresolved P0 or P1 finding. **PRs that touch security,
  signing, release workflows or credentials wait for Tim's approval.**

## Documentation

Most code changes need no documentation change: agents can read the code.

- `docs/` holds what an agent would get wrong, or couldn't cheaply find, by
  reading the code and tests: decisions and their reasons, constraints that
  span components, processes or releases, security and privacy properties,
  traps, and facts that live outside the repo. Before adding a paragraph, ask
  what someone would get wrong without it. If the code answers it, leave it out.
- Don't narrate control flow, list fields, methods, flags or constants, keep
  file catalogs, or append history (PR summaries, evidence logs, dates, commit
  hashes). Link to the source instead of describing or copying it.
- A reason that only matters to one spot is a short comment there. Comments
  explain what the code can't show; never restate it, narrate steps or record
  history. Finish changes without TODOs.
- When a documented decision changes, rewrite or delete the old text. Don't
  append a second account.
- Procedures for running, testing, debugging or releasing are skills in
  `.agents/skills/<name>/SKILL.md`, not docs.
- Guidance that disagrees with the code is a bug: fix it or remove it in the
  same change.
- Keep plans, research, reports and scratch output outside the checkout.

## How it works

Clients call the Host over typed RPC (`packages/protocol`) and follow a
Workspace channel of durable events, resuming from their last position after a
reconnect. The Host owns all state in PostgreSQL (`packages/database`):
authentication, Workspaces, Threads, Requests and the Thread Inbox, which
queues, steers or records messages between Threads. It assigns Runs to Runners.
A Runner connects to its Host, advertises the modules its grant allows, and runs
engines through harnesses, plus browser sessions (`apps/browser-runtime`) and
messaging channels (`apps/channel-runtime`). The desktop app bundles a Personal
Host with PostgreSQL, Node and cloudflared, a Runner, and signed native helpers
for macOS app control and Passwords.

## Where code lives

| Area                                           | Entry points                                                    |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Deployment server and hosted Account service   | `apps/host`, `apps/control-plane`                               |
| Web, Electron and Expo clients                 | `apps/web`, `apps/desktop`, `apps/mobile`                       |
| Agent execution and auxiliary services         | `apps/runner`, `apps/browser-runtime`, `apps/channel-runtime`   |
| Android app that makes a phone a computer      | `apps/agent-phone` (Kotlin), `packages/agent-phone-setup`       |
| Domain types, wire contracts and persistence   | `packages/core`, `packages/protocol`, `packages/database`       |
| Shared client, scheduling and engine contracts | `packages/client`, `packages/orchestration`, `packages/harness` |
| Agent tool-use behavioral evals                | `evals/agent-tools`                                             |
| Repository tooling and cross-package guards    | `scripts`, `tests`                                              |

Read the matching doc before changing one of these areas. Each holds only the
decisions and constraints the code can't show.

| Changing                                                               | Read                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Deployment config, Host authentication, RPC or compatibility           | [Host boundaries](docs/host-boundaries.md)                                                                    |
| Client routing, discovery, credentials or attachment lifecycle         | [Connections](docs/connections.md)                                                                            |
| Agent input delivery, steering, delegation or continuation             | [Agent orchestration](docs/agent-orchestration.md)                                                            |
| Engines, accounts, model selection, sandboxing or instruction delivery | [AI engines](docs/ai-engines.md)                                                                              |
| Computer enrollment, SSH access or computer apps                       | [Computers](docs/computers.md)                                                                                |
| macOS GUI control and helper permissions                               | [Computer use](docs/computer-use.md); [renderer contract](apps/desktop/src/computer-use/RENDERER-CONTRACT.md) |
| Agent phones: USB setup, the Android app, phone sessions and approvals | [Agent Phone](docs/agent-phone.md)                                                                            |
| This iPhone's Calendar, Contacts and Reminders for agents              | [iPhone apps](docs/iphone-apps.md); [mobile lifecycle](docs/mobile.md#this-iphones-apps)                      |
| Workspace storage authority or mount recovery                          | [Workspace lifecycle](docs/workspace-mount-lifecycle.md)                                                      |
| Integration OAuth and access requests                                  | [Integration OAuth](docs/integration-oauth.md)                                                                |
| Messaging providers and channel authority                              | [Messaging](docs/messaging.md)                                                                                |
| Mobile lifecycle, UI or push notifications                             | [Mobile](docs/mobile.md)                                                                                      |
| Managed infrastructure                                                 | [Cloud operations](apps/control-plane/src/cloud/README.md)                                                    |
| Browser sessions, page uploads or profile saving                       | [Browser sessions](docs/browser-sessions.md)                                                                  |
| Browser profile formats                                                | [Snapshot contract](packages/browser-profile/src/snapshot.ts)                                                 |
| Chrome sign-ins and the Chrome extension                               | [Chrome sign-ins](docs/browser-sources.md)                                                                    |
| Voice dictation into the composer                                      | [Dictation](docs/dictation.md)                                                                                |
| Voice mode: talking to Chat hands-free                                 | [Voice](docs/voice.md)                                                                                        |
| Saved-password sign-ins and Opensteer Passwords                        | [Opensteer Passwords](docs/passwords.md)                                                                      |
| Desktop builds, signing and releases                                   | [Releases](docs/releases.md)                                                                                  |
| Tests, CI selection, integration databases and the VM                  | [Testing](docs/testing.md)                                                                                    |

## Taste

- TypeScript and Zod. Parse untrusted data at boundaries, and avoid framework
  abstractions over them. Named exports, except where a framework requires a
  default. No `any`. Production `as unknown as` casts belong only at
  third-party SDK boundaries; tests may use them for partial fakes.
- Cross-cutting utilities go in `packages/shared`, under concern-specific
  subpaths; engine lifecycle helpers go in `packages/harness`.
  [The duplicate-helper guard](tests/no-duplicate-helpers.test.ts) catches
  copies.
- Build Node apps through [nodeApp](scripts/tsup-node-app.ts); see its packaging
  contract. Keep library entry points in `package.json` exports, and expose an
  app barrel only when another app embeds it.
- Keep this file short. Document a contract or non-obvious reason once, next to
  its owner, and link to it instead of repeating it.
