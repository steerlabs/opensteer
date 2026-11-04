# Agent tool-use eval

The root command and run policy are documented in
[Testing](../../docs/testing.md#agent-tool-use-evaluations).

The runner is deliberately split by responsibility:

- `cases.ts`: strict Zod boundary for NDJSON cases and safe text fixtures.
- `grader.ts`: deterministic recursive partial argument matching, ordered call
  subsequences, counts, invalid calls and final-reply regexes. `*` forbids every
  Opensteer call; `a|b` permits a semantic expectation across a tool rename.
- `host.ts`: real Host MCP service register and validate the inventory. A
  loopback MCP facade advertises those exact returned definitions and delivers
  case results only after production validation. No product store or integration
  backend can execute a real mutation.
- `engine.ts`: shipped driver factories, live model inspection, and the Host-selected
  Run guide and bundled skills, or connection initialize instructions without Run skills. New engines need a
  factory, with no captured or reconstructed native prompt/tool inventory.
- `isolation.ts`: a disposable HOME and engine profile holding only a copy of
  the existing login; each driver's isolated-service sandbox confines native
  tools as on a macOS Runner, so cases never point at host files.
- `report.ts`: strict-majority comparison, complete-baseline validation and
  grouped sample-rate summaries.
- `run.ts`: CLI, bounded sample concurrency, adaptive repetition, incremental
  durable result/transcript output and cleanup.

Case prompts are sanitized paraphrases of mistakes documented in commit
messages and instruction/skill changes, with paired guards and ordinary-work
controls. Provenance does not claim to be an exact user transcript. Model discovery and Trigger skill delivery cases retain coverage of prior discovery gaps. Every Run gets the same tool names and bundled skill names; role/reach select its guide. The historical `profile` fixture label does not select tools or authority. `reach` can override its default; `caller: "connection"` selects the production connection inventory and initialize instructions without a Run guide/skills. Keep these cases as regression tests.

Structured turns accept either text or production HarnessInput content (including
included app and phone places), with production author/kind validation. Every turn
executes a new Run in the same native session; only the last turn is graded.
`finalText` checks trimmed presence and `maxFinalTextBytes` bounds UTF-8 bytes.
`notCallsWithArgs` forbids partial argument matches, including invalid attempts.
`callsArgMatch` checks a string at an argument path; optional `args` selects
matching calls, and `first: true` restricts it to the first selected attempt in
the graded turn. The resumed computer case
checks code shape only, not executed handle semantics. Any missing or incomplete
required sample makes a case incomplete and prevents baseline comparison.

Mocks are keyed by bare tool name and return JSON. If a test needs different
responses to successive calls, use `{"$responses": [first, second]}`; exhaustion
returns an explicit unavailable result. If it needs a response per target, use
`{"$byArgs": [{"args": partial, "result": response}]}`: the first entry whose
`args` partially match the call answers it, and no match returns an explicit
unavailable result. Product calls must reach the stubbed backend through the production MCP
service's input and access checks, and Trigger actions through their production
handler expansion, before a mock is returned. Semantic
errors remain errors, even when the flat tool schema accepts the arguments. `{"$error": "message"}` returns an MCP
tool error, including inside a response sequence, so refusal cases exercise the
same result shape as the production service. The transcript contains all native
engine events, while `calls` contains ordered Opensteer MCP attempts and their
validation outcomes. Native event arguments are also retained in `nativeCalls`.
Successful Trigger write fixtures are retained for later reads; one-shot creation echoes the
requested instant as `nextFireAt` so it agrees with the real Run clock.

A run without a baseline measures current behavior and can legitimately report
failed cases. Infrastructure or authentication failures are incomplete samples,
never behavioral failures or passes. A baseline comparison refuses incompatible
engine/model/effort/corpus identities, permits prompt/schema treatment changes,
and fails the command for strict-majority regressions beyond the given budget.

Use `--area memory --samples N` to repeat the personal memory, background-pass
and pass-control cases, or `--area memory --validate` to validate selection without inspecting or
running an engine. Cases may supply `requesterTimeZone` for the production Run context; omitted means unknown.
Managed worker cases set `assigned: false` because platform provisioning creates no Assignment.
Fixtures seed the disposable Workspace before skill discovery;
`AGENTS.md` is also delivered as Workspace instructions. File expectations run
before cleanup. `expect.files` matches a file or, with `recursive: true`, a subtree
(`path: "."` means the Workspace; an array of paths searches their union). Each `textMust` pattern must match at least one
file; each `textMustNot` must match none. `exclude` omits relative subtrees; the
harness's reserved `.eval-*` directories are always omitted. Missing paths fail
positive matches and pass prohibitions; symlinks make the sample incomplete.
Memory cases start with synthetic fixtures in Main. An `after` link transfers the
producer's actual Workspace files into a fresh session of the same engine before
applying the next stage's fixtures. These chains cover correction/cold-task
recall, forget/nightly replay, repeat-source light wakes, and
stop/continuation/erasure/re-enable. Nightly replay deliberately injects stale
note and light-state files after the transfer to test healing from the producer's
forget marker.

The cold-read pair uses hand-authored Markdown in two styles. It does not prove
that either engine can consume the other's actual output. Live Claude-to-Codex
and Codex-to-Claude handoffs remain unproven, blocked until Claude 2.1.317 runs
([PR #411](https://github.com/steerlabs/opensteer/pull/411)).

Erasure cases check file-content snapshots at each Opensteer MCP boundary and at
stage end until both successful Done calls and subsequent quiescent reads. They
preserve the seeded note, light state and personalized light skill; the summary
may change to the required off line. These snapshots cannot detect native file
changes that an agent undoes entirely between MCP calls.

The important-item case requires recording the reported source ID. Opensteer
provisions the passes, so cases start from existing passes woken with the Host's
wake text, and control cases find them through `trigger_read` `systemRole` mocks.
The Host's own tests cover the wake program.
