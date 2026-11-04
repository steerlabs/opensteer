# Run and compare evals

The [evals README](../../../../evals/agent-tools/README.md) holds the commands, baseline rules and
case format; `pnpm eval:agent-tools --help` lists options. Start with the credential-free harness
tests, then the requested engine with a focused case or area:

```sh
pnpm exec vitest run evals/agent-tools
pnpm eval:agent-tools --engine codex --case workspace-model-discovery-gap --samples 1
pnpm eval:agent-tools --engine claude --area memory --samples 3
pnpm eval:agent-tools --engine codex --baseline /absolute/baseline/results.jsonl
```

`--area memory` repeats the personal memory, background-pass and pass-control cases. Choose `--out`
outside the checkout. Inspect `run.json`, `results.jsonl` and `summary.md`, separating incomplete
execution, baseline regressions and ordinary behavioral failures.
[run.ts](../../../../evals/agent-tools/run.ts) owns selection and scoring;
[cases.ts](../../../../evals/agent-tools/cases.ts) defines case fields.
