# Code mode

`plugin_execute` runs JavaScript over asynchronous `tools.<slug>.<tool>()` functions. A tool call is its only way out: there are no imports, fetch, process, filesystem APIs, timers, DOM, globalThis, btoa/atob or TextEncoder/TextDecoder. Write JavaScript, not TypeScript. Use await and Promise.all for independent calls; return a small JSON value. console.log output returns in logs.

Find tools before calling them:

```js
return await tools.search({ query: "list issues", namespace: "tracker", limit: 5 });
```

Search returns exact paths, input types and namespaces with linked account labels. Follow `next` as the complete input for the following page. An input marked inputTruncated needs its full signature:

```js
return await tools.search.describe({ paths: ["tools.tracker.issues.list"] });
```

Read names and types; don't guess arguments. Generated API wrappers generally use path, query and body for those parts of a request. Each tool takes one object. Combine results within one program and return only fields the task needs. Variables do not survive between executions.

Accounts come from the person's plugin links, never a guessed display name or a `$accounts` override. Missing accounts require plugin_account_request from a Run; programs cannot open account Requests. An unavailable plugin appears in unavailableApps or missing. Follow its recovery instructions; other plugins can remain usable.

The program budget is five minutes of execution and 100 tool calls. Human interactions have a separate bounded lifetime. A pending result has an executionId and Request in Needs you. After an answer, plugin_resume continues the saved program. No agent supplies that answer. If it expired or was interrupted, inspect current state with safe reads before new work; never automatically rerun the program. Independent calls can already have completed when another call fails.
