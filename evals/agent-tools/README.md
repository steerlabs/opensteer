# Agent tool-use evals

Behavioral evals of how real engines use Opensteer's tools, guide and bundled skills. Native tools
run for real, so cases never point at host files.

## Running

Use an existing local subscription login; add no API keys. The harness's own tests need no
credentials:

```sh
pnpm exec vitest run evals/agent-tools
pnpm eval:agent-tools --engine codex --case delegated-model-discovery-gap --samples 1
pnpm eval:agent-tools --engine claude --area memory --validate   # selection only, no engine
pnpm eval:agent-tools --engine codex --baseline /absolute/baseline/results.jsonl
```

Each sample records `timing`, and `summary.md` reports rounds, waits and tool time per case. A
wait holds model, engine and transport time together; these events cannot separate provider time.

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
  a rename. `withoutKeys` on a required call rules out arguments such as `taskId` when a worker
  must read its own history. `callsArgMatch` matches a string or the JSON of an argument object.
- Mocks are keyed by bare tool name. `{"$responses": [...]}` answers successive calls,
  `{"$byArgs": [{"args": partial, "result": response}]}` answers the first partial match, and
  `{"$error": "message"}` returns an MCP tool error (`$code` and `$next` fill its `{code, message,
next}`), recorded as that call's result. An exhausted or unmatched mock returns an explicit
  unavailable result. Calls reach a mock only after the production MCP service's input and access
  checks, so semantic errors stay errors even when the flat schema accepts the arguments.
- `timeAnchor` shifts a case's ISO instants onto the actual Run clock, preserving their intervals,
  for scenarios such as a meeting happening now. Date-only facts are unchanged.
- `tasks` supplies timestamped published messages as `{task, items, self?}` using the production
  task-detail and item shapes. `self: true` identifies this Run's task, including prior handoffs.
  Unmocked task list/read calls filter `changedSince`, report `newMessages`/`firstNewAt`, page newest
  first and preserve `teamSource`; explicit mocks still win.
- `accessMode` and `capabilities` shape the Run as the Host plans it: a missing capability
  removes its tools, guide section and skill, and `pages: false` makes Browser Harness refuse
  with the limited-access error.
- `browser` supplies the person's tabs of every kind (`page`, `window`, `phone`, `app`), groups,
  profiles, `windows`, `phones` and `apps` that `tab_open` can bind, `offlineComputers`,
  `accessRequiredComputers` and `personActiveTab`. Unmocked `tab_*` tools and `show_to_person`
  answer from that state, and every case receives a fake `OPENSTEER_BROWSER_HARNESS` sharing it:
  scripts run in a bounded VM with `openPage(tabId)` handles, `--tab`, and
  `opensteer.callTool`, which reaches the fake Host like an MCP call. Tab state survives scripts
  and turns; variables do not. Only the last turn's calls are graded.
  `expect.harness: [{call: "openPage", args: {tabId: "receipt"}}]` matches partial normalized
  arguments, including failed attempts. `notHarness` accepts helper names or partial call
  objects, including failed attempts. `order`, `minCalls`, and `maxCalls` accept
  `harness:<helper>` alongside tool names; ordinary tool wildcards keep their meaning.
- `appServers` starts a real loopback server per name, answering `"METHOD /path"` with its JSON
  (`$status` and `$body` set a non-200 reply). Mocks say `{{appServer:<name>}}` for its URL and
  `{{agentHome}}` for the Agent home path; each request is graded as `harness:http`.
- `expect.files` runs before cleanup. A missing path fails a positive match and passes a
  prohibition; a symlink makes the sample incomplete; `.eval-*` directories are never read.
- `after` chains a case onto an earlier one, moving the producer's actual Agent home files into
  a fresh session of the same engine before the next stage's fixtures apply.

Known limits: the memory cold-read pair uses hand-authored Markdown, so it does not prove
either engine can read the other's actual output. Erasure snapshots taken at each MCP boundary
cannot see native file changes an agent undoes between two calls.
