---
name: opensteer
description: "Browser automation, scraping, structured extraction, and browser-backed API reverse engineering with the Opensteer CLI and SDK. Use when a task needs to open pages, interact with elements, capture network traffic, write request plans, or turn a browser workflow into reusable code."
---

# Opensteer

Use this skill when a task needs a real browser workflow, structured extraction, or browser-backed replay.

Choose the reference that matches the job:

- CLI exploration: [references/cli-reference.md](references/cli-reference.md)
- SDK automation: [references/sdk-reference.md](references/sdk-reference.md)
- Request capture and replay: [references/request-workflow.md](references/request-workflow.md)

## Default Workflow

1. Start with the CLI when you need to explore a site, inspect state, or prove the workflow on a real page.
2. Re-snapshot after each meaningful page or DOM change before reusing counters.
3. Add `--description` when you want selector persistence and later replay.
4. Move to the SDK when the workflow should become reusable code in the repository.
5. Move to request capture and request plans when the real target is a browser-backed API.

## CLI Exploration

```bash
opensteer open https://example.com --name my-workflow
opensteer snapshot action --name my-workflow
opensteer click 3 --name my-workflow --description "primary button"
opensteer snapshot extraction --name my-workflow
opensteer extract --name my-workflow \
  --description "page summary" \
  --schema '{"title":{"selector":"title"},"url":{"source":"current_url"}}'
opensteer close --name my-workflow
```

Rules:

- Use `opensteer open` once to create the session, then use `goto`, actions, snapshots, and extraction against the same `--name`.
- Treat counter targets as snapshot-local. Always take a fresh `snapshot action` before reusing counters after the page changes.
- Use `snapshot extraction` plus `extract` for structured data. Do not treat snapshot HTML as the final data source.
- Use `--description` whenever the action or extraction should be replayable later.

## SDK Automation

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  name: "my-workflow",
  rootDir: process.cwd(),
  browser: { headless: true },
});

try {
  await opensteer.open("https://example.com");
  await opensteer.snapshot("action");

  const data = await opensteer.extract({
    description: "page summary",
    schema: {
      title: { selector: "title" },
      url: { source: "current_url" },
    },
  });

  console.log(data);
} finally {
  await opensteer.close();
}
```

Rules:

- Wrap owned sessions in `try/finally` and call `close()`.
- Use `Opensteer.attach(...)` plus `disconnect()` when you are attaching to an existing CLI-owned session.
- Prefer Opensteer methods over raw Playwright calls so actions, extraction, and replay semantics stay inside the product surface.
- Use `networkTag` on actions when you intend to inspect or promote the network traffic they trigger.

## Request Capture And Replay

Use Opensteer's reverse-engineering flow when the deliverable is a custom API or a replayable request plan:

1. Perform the browser action that triggers the request.
2. Inspect traffic with `queryNetwork()` or `opensteer network query`.
3. Retry the request with `rawRequest()` or `opensteer request raw`.
4. Promote the captured request with `inferRequestPlan()` or `opensteer plan infer`.
5. Replay it with `request()` or `opensteer request execute`.

Read [references/request-workflow.md](references/request-workflow.md) before implementing request-plan work.
