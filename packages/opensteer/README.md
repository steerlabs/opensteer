# Opensteer Package

`opensteer` is the product surface for the rewrite. It exposes:

- a semantic SDK with session continuity inside one process
- a thin JSON-first CLI
- a local per-session service so CLI commands can share one live browser session
- browser-native observation and instrumentation primitives
- deterministic replay through request plans, recipes, and saved evidence
- HTML-first snapshots, DOM action replay, computer-use actions, descriptor persistence, traces,
  and artifacts

The package is organized around three lanes:

- `Interact`: open pages, navigate, evaluate, inspect DOM state, manage pages, use computer actions
- `Observe / Instrument`: capture network, capture scripts, add init scripts, route requests, replace scripts
- `Replay / Execute`: `direct-http`, `context-http`, `page-eval-http`, request plans, and recipes

## Install

```bash
pnpm add opensteer
pnpm exec playwright install chromium

# Optional ABP backend for `--engine abp`
pnpm add @opensteer/engine-abp
```

## SDK

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  name: "docs-example",
  rootDir: process.cwd(),
  browser: { headless: true },
});

try {
  await opensteer.open({
    url: "https://example.com",
    browser: {
      headless: true,
    },
  });
  const snapshot = await opensteer.snapshot("action");
  const firstButton = snapshot.counters.find((counter) => counter.tagName === "BUTTON");
  if (firstButton) {
    await opensteer.click({
      element: firstButton.element,
      description: "primary button",
    });
  }

  const extracted = await opensteer.extract({
    description: "page summary",
    schema: {
      url: { source: "current_url" },
      title: { selector: "title" },
    },
  });

  console.log(snapshot.html);
  console.log(extracted);
} finally {
  await opensteer.close();
}
```

Browser-backed replay:

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  name: "browser-backed-replay",
  rootDir: process.cwd(),
  browser: { headless: true },
});

try {
  await opensteer.open("https://example.com/app");
  const token = await opensteer.evaluate<string>({
    script: "() => window.exampleToken",
  });

  const response = await opensteer.rawRequest({
    transport: "context-http",
    url: "https://example.com/api/items",
    method: "POST",
    body: {
      json: { token },
    },
  });

  console.log(response.data);
} finally {
  await opensteer.close();
}
```

Attach to an existing CLI-opened local session:

```ts
import { Opensteer } from "opensteer";

const opensteer = Opensteer.attach({
  name: "docs-example",
  rootDir: process.cwd(),
});

try {
  const state = await opensteer.open();
  console.log(state.url);
} finally {
  await opensteer.disconnect();
}
```

Launch a cloud session with a specific browser profile:

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  cloud: {
    apiKey: process.env.OPENSTEER_API_KEY!,
    browserProfile: {
      profileId: "bp_123",
      reuseIfActive: true,
    },
  },
});
```

Upload a local Chrome profile into an existing cloud profile:

```ts
import { OpensteerCloudClient } from "opensteer";

const client = new OpensteerCloudClient({
  apiKey: process.env.OPENSTEER_API_KEY!,
  baseUrl: process.env.OPENSTEER_BASE_URL ?? "https://api.opensteer.dev",
});

await client.uploadLocalBrowserProfile({
  profileId: "bp_123",
  fromUserDataDir: "~/Library/Application Support/Google/Chrome",
  profileDirectory: "Default",
});
```

## CLI

```bash
opensteer open https://example.com --name docs-example --headless true
opensteer open https://example.com --name docs-example --browser cdp --cdp 9222
opensteer open https://example.com --name docs-example --browser profile \
  --user-data-dir "~/Library/Application Support/Google/Chrome" \
  --profile-directory Default
opensteer local-profile list
opensteer local-profile inspect --user-data-dir "~/Library/Application Support/Opensteer Chrome"
opensteer local-profile unlock --user-data-dir "~/Library/Application Support/Opensteer Chrome"
opensteer profile upload --profile-id bp_123 --from-user-data-dir "~/Library/Application Support/Google/Chrome"
opensteer open https://example.com --name docs-example --engine abp
opensteer snapshot action --name docs-example
opensteer click 3 --name docs-example --description "primary button"
opensteer extract --name docs-example --description "page summary" \
  --schema '{"url":{"source":"current_url"},"title":{"selector":"title"}}'
opensteer computer '{"type":"screenshot"}' --name docs-example
opensteer close --name docs-example
```

CLI long flags are canonical kebab-case, for example `--root-dir`, `--network-tag`, and
`--press-enter`. Unknown flags and flags used on the wrong command fail fast instead of being
silently ignored.

Action and data commands print JSON to stdout. Help commands print human-readable usage text.
Browser state does not live in the CLI process. It lives
in the local session service recorded under `.opensteer/runtime/sessions/<name>/service.json`.
`opensteer computer` prints compact screenshot metadata and points at the persisted image through
`screenshot.path` for local shells and `screenshot.payload.uri` for the canonical file-backed
location.

Use `--engine <playwright|abp>` on `open` to choose the backend for a new session. You can also
set `OPENSTEER_ENGINE=abp` to change the default engine for `open` in the current shell. Engine
selection is fixed when the session service starts, so `OPENSTEER_ENGINE` and `--engine` only
affect `open`, not commands like `snapshot` or `click` that attach to an existing session.
When using `--engine abp`, Opensteer accepts the ABP launch options it can actually honor:
`--headless`, `--executable-path`, and equivalent `--browser-json` fields for `headless`, `args`,
and `executablePath`. Unsupported shared browser/context options fail fast instead of being
ignored.

`browser.kind="profile"` is an exclusive owned-launch mode. Opensteer will not launch against a
known default Chrome/Chromium user-data-dir and will not implicitly fall back to CDP attachment or
delete lock files during launch. Use `opensteer local-profile inspect` to diagnose profile
ownership, `opensteer local-profile unlock` only when Opensteer proves the profile is in a
`stale_lock` state, and `--browser cdp` or `--browser auto-connect` when an existing browser
already owns the profile.

## Transport Guide

- `direct-http`: use when the request is replayable without a browser
- `context-http`: use when browser cookies or browser session state are required
- `page-eval-http`: use when request execution must happen inside the live page JavaScript world

`goto()` plus `waitForNetwork()` is a separate pattern. It is how you observe the
page's own traffic; it is not a transport.

## Session Root

By default, Opensteer writes into:

```text
<cwd>/.opensteer
```

Important subtrees:

```text
.opensteer/
  artifacts/
  traces/
  registry/
  runtime/
    sessions/
```

## Public Methods

- `Opensteer.attach({ name?, rootDir? })`
- `inspectLocalBrowserProfile({ userDataDir? })`
- `unlockLocalBrowserProfile({ userDataDir })`
- `open(url | { url?, name?, browser?, context? })`
- `goto(url | { url, networkTag? })`
- `evaluate(script | { script, pageRef?, args? })`
- `evaluateJson({ script, pageRef?, args? })`
- `waitForNetwork({ ...filters, pageRef?, includeBodies?, timeoutMs? })`
- `waitForResponse({ ...filters, pageRef?, includeBodies?, timeoutMs? })`
- `listPages()`
- `newPage({ url?, openerPageRef? })`
- `activatePage({ pageRef })`
- `closePage({ pageRef })`
- `waitForPage({ openerPageRef?, urlIncludes?, timeoutMs? })`
- `snapshot("action" | "extraction")`
- `click({ element | selector | description, networkTag? })`
- `hover({ element | selector | description, networkTag? })`
- `input({ element | selector | description, text, networkTag? })`
- `scroll({ element | selector | description, direction, amount, networkTag? })`
- `extract({ description, schema? })`
- `queryNetwork({ source?, recordId?, requestId?, actionId?, tag?, url?, hostname?, path?, method?, status?, resourceType?, pageRef?, includeBodies?, limit? })`
- `saveNetwork({ tag, ...filters })`
- `clearNetwork({ tag? })`
- `captureScripts({ pageRef?, includeInline?, includeExternal?, includeDynamic?, includeWorkers?, urlFilter?, persist? })`
- `addInitScript({ script, args?, pageRef? })`
- `route({ urlPattern, resourceTypes?, times?, handler })`
- `interceptScript({ urlPattern, handler, times? })`
- `rawRequest({ transport?, pageRef?, url, method?, headers?, body?, followRedirects? })`
- `inferRequestPlan({ recordId, key, version, lifecycle? })`
- `writeRequestPlan({ key, version, payload, lifecycle?, tags?, provenance?, freshness? })`
- `getRequestPlan({ key, version? })`
- `listRequestPlans({ key? })`
- `writeRecipe({ key, version, payload, tags?, provenance? })`
- `getRecipe({ key, version? })`
- `listRecipes({ key? })`
- `runRecipe({ key, version?, input? })`
- `request(key, { path?, query?, headers?, body? })`
- `computerExecute({ action, screenshot?, networkTag? })`
- `disconnect()`
- `close()`

`element` targets use counters from the latest snapshot. `description` replays a stored descriptor.
`selector` resolves a CSS selector directly and, when not explicitly scoped, searches the current
page before falling back to child frames.

Use `disconnect()` for attached sessions when you want to release the SDK handle but keep the
underlying session alive. Use `close()` when you want to destructively end the session.

Profile inspection is independent from session ownership. `inspectLocalBrowserProfile()` returns a
structured status union (`available`, `unsupported_default_user_data_dir`, `opensteer_owned`,
`browser_owned`, `stale_lock`) that launch, CLI, and SDK all consume. Failed owned launches throw
`OpensteerLocalProfileUnavailableError` with the inspection attached for programmatic handling.

The reverse-engineering workflow is: perform a browser action, inspect traffic with
`queryNetwork()`, optionally instrument with `addInitScript()`, `route()`, or
`captureScripts()`, experiment with `rawRequest()`, promote a record with
`inferRequestPlan()`, then replay with `request()`.

`route()` and `interceptScript()` are only available on owned local SDK sessions.
They are not available on attached or cloud proxy sessions because they rely on a
live in-process route handler.
