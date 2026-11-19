## Source and deployment

Keep an app's source as a complete list of `{ path, content }` files, including
`index.ts` and `package.json`. Pin the exact `apps` version returned by the
host's framework release operation. For example:

```ts
import { defineApp, object, query, router } from "apps";

export default defineApp({}, async () => ({
  tools: router({
    hello: query({ description: "Say hello", input: object({}) }, async () => ({
      message: "Hello",
    })),
  }),
}));
```

The embedding service owns deployment and authorization. If it exposes app
management tools over MCP, discover their exact signatures with `search` and
`describe` before calling them. This engine includes no standalone CLI,
organization service, sign-in product, or registry publishing endpoint.

Creating an app saves working source; deployment builds and activates a version.
Source commits alone do not change the running version. Saving source sends the
complete file list, so omitted files are deleted. Review the returned removal
list and use the last source revision as the expected revision for an edit.
A copy has independent Git history, app data, and account selections.

Activation selects a retained build without rebuilding it. It preserves app data
and does not undo writes to external services; a version whose migrations are not
the ones the app's database has applied is refused. Only the active version runs:
an approval, queued workflow run or schedule occurrence saved on another version
ends `stale` and is started again. Check account requirements after changing
versions. Start a new codemode execution to discover changed tools.

### Carry source as data

App source and codemode programs run in different environments. App source can
import packages and use fetch. A codemode program calls exposed tools and
transforms data; it has no direct imports, fetch, filesystem, or process APIs.
Deploy declarations such as `defineApp` as source files.

When source comes from a management tool, transform its `files` and pass them
back in the same execution. For a small edit, retain every other file and check
that the expected text occurs exactly once. Do not print and retype an app to
change one operation.

For locally authored files, construct the `{ path, content }` list with JSON
serialization. Insert that serialized value as JavaScript data in the codemode
payload. Do not interpolate arbitrary source into shell commands or manually
constructed template literals. Submit file contents, since remote execution
cannot read a local path.

## Dependencies and current boundaries

Every app declares `apps` in `package.json` `dependencies`:
`{ "dependencies": { "apps": "<version>" } }`. `framework.release` returns the
version this host runs; a deploy without
it fails and names the same version. Every build links the host's own `apps`
framework, whatever version the declaration names; it is never downloaded. Apps the host generates, such as imported MCP apps, already declare it. Keep it when
editing. The host retains the compiled framework with each app version and runs the version with it for as long as the host supports its protocol. Missing
or unsupported packages fail the build without replacing the active app.
Installation disables lifecycle scripts. Do not depend on the PluginEngine SDK in
app code. Native dependencies that need scripts are unsupported.

App code never runs in the host process; it runs in its own Worker, below, and
cannot start processes or read the host's files. It receives the fields of
selected accounts. When the provider declares `hosts`, each string field not
marked `plain()` or `raw()` arrives as a handle that PluginEngine's network replaces
only on requests to those hosts; other fields arrive as their values
([accounts.md](accounts.md#limit-where-credentials-go)). Accounts connected
through an OAuth client the PluginEngine instance provides are the exception: their
credentials are always handles, even when marked `plain()` or `raw()`, and work
only in `account.headers()` on requests to the instance's hosts that the
provider also declares ([accounts.md](accounts.md#place-credentials-exactly)).
Forward `context.signal` to fetch or other
interruptible operations. Cancellation and execution limits are cooperative;
completed writes are not rolled back. App-owned storage persists across calls.
Durable background work uses workflows ([workflows.md](workflows.md)).

### Fetch from app code

App code runs on workerd, Cloudflare's Workers runtime, on every host. Its fetch
accepts the standard `RequestInit` with three exceptions, which TypeScript's
types and a local type check do not catch:

- `redirect` must be `"follow"` or `"manual"`. To reject redirects, send
  `"manual"` and treat a 3xx response as the error.
- `cache` must be `"no-store"` or `"no-cache"`, or omitted.
- `integrity` must be empty or omitted.

`ctx.fetch` rejects an unsupported value with `FetchOptionUnsupported`, which
names the option and the values it accepts. A request without a `User-Agent`
is sent with `User-Agent: PluginEngine`, because some APIs, such as GitHub's, answer
403 without one. A `User-Agent` app code sets is sent unchanged.

App code can reach public hosts with no allowlist, so a 403 or 404 from one is
that service's answer. PluginEngine refuses only requests it must not send:

- To a private, loopback or internal address named in the URL, unless the
  embedding service explicitly enables private fetch.
- Carrying a credential handle to a host its provider does not allow.

`ctx.fetch` then rejects with `NetworkRefused`, whose `refusal.reason` and
message name the host and the rule. The global `fetch` instead receives status
421 with the refusal in an `x-plugin-engine-refused` header, as URI-encoded JSON, and
in the body as JSON. A public name that resolves to a private address passes
this URL check; the embedding service must also enforce network egress policy.
