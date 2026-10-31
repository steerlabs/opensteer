# Agent tool-use eval

The root command and run policy are documented in
[Testing](../../docs/testing.md#agent-tool-use-evaluations).

The runner is deliberately split by responsibility:

- `cases.ts`: strict Zod boundary for NDJSON cases and safe text fixtures.
- `grader.ts`: deterministic recursive partial argument matching, ordered call
  subsequences, counts, invalid calls and final-reply regexes. `*` forbids every
  Opensteer call; `a|b` permits a semantic expectation across a tool rename.
- `host.ts`: real Host MCP services register and validate the inventory. A
  loopback MCP facade advertises those exact returned definitions and delivers
  case results only after production validation. No product store or integration
  backend can execute a real mutation.
- `engine.ts`: shipped driver factories, live model inspection, and the Runner's
  production platform guide and skill selection/delivery. New engines need a
  factory, with no captured or reconstructed native prompt/tool inventory.
- `isolation.ts`: a disposable HOME and engine profile holding only a copy of
  the existing login; each driver's isolated-service sandbox confines native
  tools as on a macOS Runner, so cases never point at host files.
- `report.ts`: strict-majority comparison, complete-baseline validation and
  grouped sample-rate summaries.
- `run.ts`: CLI, bounded sample concurrency, adaptive repetition, incremental
  durable result/transcript output and cleanup.

Cases combine synthetic contract guards with sanitized paraphrases of mistakes
documented in commit messages and instruction/skill changes, paired guards and
ordinary-work controls. Provenance does not claim to be an exact user transcript. Two pairs
intentionally reproduce current profile gaps: model discovery points at an
unavailable tool, and Trigger guidance points at an undelivered skill. Do not
remove those cases merely because they lower a baseline.

Mocks are keyed by bare tool name and return JSON. If a test needs different
responses to successive calls, use `{"$responses": [first, second]}`; exhaustion
returns an explicit unavailable result. Calls still use the production Zod
validator, even when a mock is present. `{"$error": "message"}` returns an MCP
tool error, including inside a response sequence, so refusal cases exercise the
same result shape as the production service. The transcript contains all native
engine events, while `calls` contains ordered Opensteer MCP attempts and their
validation outcomes. Native event arguments are also retained in `nativeCalls`.

Turns may be plain text or an object with `text`, `messageId`, and optional
`presentationContext` and `quote`, delivered as real input metadata. This lets
screen-presentation cases distinguish the current input from a prior request
without placing a synthetic header in the user's words. The delegated profile
represents an independent task Run, not a native child sharing Chat's Run.

A run without a baseline measures current behavior and can legitimately report
failed cases. Infrastructure or authentication failures are incomplete samples,
never behavioral failures or passes. A baseline comparison refuses incompatible
engine/model/effort/corpus identities, permits prompt/schema treatment changes,
and fails the command for strict-majority regressions beyond the given budget.
