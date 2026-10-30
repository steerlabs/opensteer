---
name: run-agent-evals
description: Run agent tool-use behavioral evaluations or compare a treatment with a compatible baseline.
---

Read `docs/testing.md#agent-tool-use-evaluations` for native-tool boundaries.
Use an existing local subscription login; do not add API keys or host-file targets.
Start with credential-free harness coverage:

```sh
pnpm exec vitest run evals/agent-tools
```

Run the requested engine and select a case for a focused check:

```sh
pnpm eval:agent-tools --engine codex --case workspace-model-discovery-gap --samples 1
pnpm eval:agent-tools --engine claude
pnpm eval:agent-tools --engine codex --baseline /absolute/baseline/results.jsonl
```

Use `--out /absolute/directory` outside the checkout when choosing an output.
Existing results are never overwritten. Inspect `run.json`, `results.jsonl` and
`summary.md`; distinguish incomplete execution, baseline regressions and ordinary
behavioral failure data. Use only model/effort values the live engine catalog
supports. Read `evals/agent-tools/run.ts` for selection and scoring details.
