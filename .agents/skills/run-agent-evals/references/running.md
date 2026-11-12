# Run and compare evals

The [evals README](../../../../evals/agent-tools/README.md) holds the commands, baseline rules and
case format; `pnpm eval:agent-tools --help` lists options. Start with the credential-free harness
tests, then the requested engine with a focused case or area:

```sh
pnpm exec vitest run evals/agent-tools
pnpm eval:agent-tools --engine codex --case delegated-model-discovery-gap --samples 1
pnpm eval:agent-tools --engine claude --area memory --samples 3
pnpm eval:agent-tools --engine codex --baseline /absolute/baseline/results.jsonl
```

`--area memory` repeats the personal memory, background-pass and pass-control cases. Choose `--out`
outside the checkout. Inspect `run.json`, `results.jsonl` and `summary.md`, separating incomplete
execution, baseline regressions and ordinary behavioral failures.
[run.ts](../../../../evals/agent-tools/run.ts) owns selection and scoring;
[cases.ts](../../../../evals/agent-tools/cases.ts) defines case fields.

Team cases use the team-bound profile and a current Run request; private follow-ups must have no
team authority. Re-run shared-guide consumers after guide changes, including memory and Messaging
audience cases. Compare only baselines using the same fresh task and team tool contracts;
a baseline from different authority or tool contracts is not comparable.
