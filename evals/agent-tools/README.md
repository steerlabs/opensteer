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
`callsArgMatch` checks a string at an argument path; `first: true` restricts it to
the first attempt of that tool in the graded turn. The resumed computer case
checks code shape only, not executed handle semantics. Any missing or incomplete
required sample makes a case incomplete and prevents baseline comparison.

Mocks are keyed by bare tool name and return JSON. If a test needs different
responses to successive calls, use `{"$responses": [first, second]}`; exhaustion
returns an explicit unavailable result. Calls still use the production Zod
validator, even when a mock is present. `{"$error": "message"}` returns an MCP
tool error, including inside a response sequence, so refusal cases exercise the
same result shape as the production service. The transcript contains all native
engine events, while `calls` contains ordered Opensteer MCP attempts and their
validation outcomes. Native event arguments are also retained in `nativeCalls`.

A run without a baseline measures current behavior and can legitimately report
failed cases. Infrastructure or authentication failures are incomplete samples,
never behavioral failures or passes. A baseline comparison refuses incompatible
engine/model/effort/corpus identities, permits prompt/schema treatment changes,
and fails the command for strict-majority regressions beyond the given budget.
