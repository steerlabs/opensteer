# Agent tool-use evals

Behavioral evals of how real engines use Opensteer's tools, guide and bundled skills. Read
[the safety boundaries](../../docs/testing.md#agent-tool-use-evaluations) first: native tools
run for real, so cases never point at host files.

## Running

Use an existing local subscription login; add no API keys. The harness's own tests need no
credentials:

```sh
pnpm exec vitest run evals/agent-tools
pnpm eval:agent-tools --engine codex --case workspace-model-discovery-gap --samples 1
pnpm eval:agent-tools --engine claude --area memory --validate   # selection only, no engine
pnpm eval:agent-tools --engine codex --baseline /absolute/baseline/results.jsonl
```

`pnpm eval:agent-tools --help` lists every option. Choose `--out` outside the checkout;
existing results are never overwritten. A run without a baseline measures current behavior and
may legitimately report failed cases. Infrastructure and authentication failures make a sample
incomplete, never a pass or a failure, and any incomplete required sample blocks baseline
comparison. A baseline must match engine, version, model, effort and corpus; prompt, skill and
schema changes are the treatment. The command fails on strict-majority regressions beyond
`--regression-budget`.

## Writing cases

Cases are NDJSON in [cases](cases), parsed strictly by [cases.ts](cases.ts). Prompts are
sanitized paraphrases of real mistakes found in commits and instruction changes, with paired
guards and ordinary-work controls; keep them as regression tests. `profile` is a historical
fixture label and selects no tools or authority.

- Every turn runs a new Run in the same native session; only the last turn is graded.
- In call expectations, `*` matches every Opensteer tool and `a|b` accepts either name across
  a rename.
- Mocks are keyed by bare tool name. `{"$responses": [...]}` answers successive calls,
  `{"$byArgs": [{"args": partial, "result": response}]}` answers the first partial match, and
  `{"$error": "message"}` returns an MCP tool error. An exhausted or unmatched mock returns an
  explicit unavailable result. Calls reach a mock only after the production MCP service's
  input and access checks, so semantic errors stay errors even when the flat schema accepts
  the arguments.
- `expect.files` runs before cleanup. A missing path fails a positive match and passes a
  prohibition; a symlink makes the sample incomplete; `.eval-*` directories are never read.
- `after` chains a case onto an earlier one, moving the producer's actual Workspace files into
  a fresh session of the same engine before the next stage's fixtures apply.

Known limits: the memory cold-read pair uses hand-authored Markdown, so it does not prove
either engine can read the other's actual output. Erasure snapshots taken at each MCP boundary
cannot see native file changes an agent undoes between two calls.
