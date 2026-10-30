# AGENTS.md

## Landing changes

Work in your own worktree on a small branch and open one PR per change on
[steerlabs/opensteer](https://github.com/steerlabs/opensteer) with a
conventional title (`fix:`, `feat:`, `docs:`, `refactor:`, `test:`, `chore:`).
Before pushing, run `pnpm check:changed --base origin/main` and the focused
journey that proves the behavior. **Do not run repo-wide checks**: no `pnpm check`,
`pnpm test` or full `pnpm test:integration` unless Tim asks. CI owns the full
suite. Include what changed, why, evidence and any checks you could not run in
the PR.

After pushing, use `watch_pull_request`. Fix failing checks on the branch; never
weaken a test to land. No batching or up-to-date requirement. Main runs the full
CI suite; fix forward or revert a red main immediately. Real desktop journeys run
after merge and on maintainer request. Release builders consume the green main SHA.

You may squash-merge your own PR once the required `Check` is green and Greptile,
the automated reviewer, has no unresolved P0 or P1 finding. PRs that touch
security, signing, release workflows or credentials wait for Tim Jang's approval.

## Testing

- Test what a person would notice breaking, at the cheapest layer that can catch
  it. Use real collaborators where they're cheap. Add an end-to-end journey only
  when the bug only shows end to end: one journey per user-facing flow, not per
  edge case.
- Every test earns its place: it guards something specific, it's quick and it
  isn't a duplicate. Deleting duplicate, superseded or never-useful tests is
  maintenance. Never drop the only coverage of a past real bug or a security
  property without moving it somewhere cheaper.
- Fix bugs at the root, with a regression test that fails first. Before changing
  ownership, wire contracts or cross-process architecture, get one review of the
  smallest design, then build it.
- Never weaken assertions or timeouts to get green. Skipped is not passed.
  Fix failures at the root before landing ([flaky tests](docs/testing.md#known-flaky-tests)).
- Anything that drives the real screen, keyboard, windows or Electron runs in a
  disposable VM (`pnpm test:vm`), never on the host screen. Pure-logic Swift runs
  on the host with `swift test`. The VM journeys run after merge or on demand,
  never as a pre-merge gate. Emulators and USB phones have one owner at a time.
- Stop every process you start, including after failures: servers, emulators,
  `adb` servers and capture loops. They take phones and screen capture away from
  everything else on this Mac.
- If one blocker has eaten about 15 minutes, report the evidence, your hypothesis
  and your next step instead of grinding.

Opensteer is a pnpm monorepo for a self-hostable agent workspace. Verify behavior
against code and tests; fix or remove documentation that disagrees with them.

## Commands

Use the Node and pnpm versions in [package.json](package.json). Local setup also
requires Go and a running Docker daemon; [setup-local.ts](scripts/setup-local.ts)
checks prerequisites and creates or updates `.env`.

```sh
pnpm install --frozen-lockfile
pnpm setup:local          # prepare local services
pnpm dev                 # start development
pnpm check               # typecheck, build, lint, formatting, tests
pnpm desktop:install-local # signed local Mac feedback; see docs/releases.md
pnpm test:integration    # real PostgreSQL integration tests
pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh # macOS GUI journeys in a VM
pnpm engines             # shipped engine pins against their latest releases
pnpm test:engines        # drive the shipped engines on real accounts
pnpm build:agent-phone   # build the Agent Phone APK into the web and desktop builds
pnpm test:agent-phone    # drive Agent Phone setup and use on an Android emulator
```

`pnpm test` builds native helpers first; `pnpm exec vitest run <file>` and
`vitest related` skip those builds for the inner loop. Engine bumps need
`pnpm test:engines`; see [AI engines](docs/ai-engines.md#engine-releases-and-new-models).
Report what ran and what couldn't. See [Testing](docs/testing.md) for check
selection and the VM, and [Releases](docs/releases.md#release-evidence) for
release evidence.

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

## Engineering rules

- Use TypeScript and Zod; parse untrusted data at boundaries. Avoid framework
  abstractions over them. Use named exports except where a framework requires
  a default. Production `as unknown as` casts belong only at third-party SDK
  boundaries; tests may use them for partial fakes. Do not introduce `any`.
- Put cross-cutting utilities in `packages/shared` (concern-specific subpaths) and
  engine lifecycle helpers in `packages/harness`;
  [the duplicate-helper guard](tests/no-duplicate-helpers.test.ts) catches copies.
- Web, desktop and mobile reach the Host through `@opensteer/client`. Keep
  that package free of Node APIs; inject platform capabilities through ports.
  Add browser-facing capabilities to
  [hostApi](packages/protocol/src/host-api.ts), with matching handlers, scope
  and mock behavior. Domain mutations use `commands.dispatch`.
- Keep wire changes readable by the previous release. Bump the Host API epoch
  only as [Host compatibility](docs/host-boundaries.md#compatibility) allows.
- Build Node apps through [nodeApp](scripts/tsup-node-app.ts); see its packaging contract.
- Comments explain reasons the code cannot express. Finish the change without
  adding TODOs. Keep library entry points in `package.json` exports; expose an
  app barrel only when another app embeds it.

## Task-specific references

Read the relevant reference when changing a subsystem; these are not a required
reading list for every task. Follow the linked source and nearby tests for
implementation details.

| Changing                                                               | Start here                                                                                                    |
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
| Mobile lifecycle, UI or push notifications                             | [Mobile](docs/mobile.md); [build instructions](apps/mobile/README.md)                                         |
| Managed infrastructure                                                 | [Cloud operations](apps/control-plane/src/cloud/README.md)                                                    |
| Browser sessions, page uploads or profile saving                       | [Browser sessions](docs/browser-sessions.md)                                                                  |
| Browser profile formats                                                | [Snapshot contract](packages/browser-profile/src/snapshot.ts)                                                 |
| Chrome sign-ins and the Chrome extension                               | [Chrome sign-ins](docs/browser-sources.md)                                                                    |
| Voice dictation into the composer                                      | [Dictation](docs/dictation.md)                                                                                |
| Saved-password sign-ins and Opensteer Passwords                        | [Opensteer Passwords](docs/passwords.md)                                                                      |
| Agent-facing tools and bundled skills                                  | [Tool catalog](packages/agent-tools/src/catalog.ts); [shipped skills](apps/runner/agent-skills/skills)        |

## Keeping guidance useful

Keep this file short: repository-wide commands, conventions and pointers only.
Document a current contract or non-obvious reason once, near its owner; link to
it instead of repeating it. Prefer source and tests for details they already
express. Update affected guidance in the same change as behavior, and remove
obsolete instructions. Keep plans, briefs, reports and scratch output outside the checkout.
