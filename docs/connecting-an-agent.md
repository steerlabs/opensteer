# Connecting an Agent to Opensteer

This guide explains how to connect an AI agent to a person's Opensteer Home over the Model Context Protocol (MCP) and use its browser, apps, phones, plugins, and tasks.

Opensteer is a person's Personal Cloud Computer for AI. The person connects a device once (a Mac, a phone, or a hosted Opensteer Cloud Computer). A Home holds their browser profiles, apps, plugins, and tasks. Any AI agent can connect to that Home over MCP with OAuth, act only within what the person allowed at consent, and be watched or stopped from the person's phone.

---

## 1. Connecting

A Home serves MCP over Streamable HTTP at one endpoint:

```text
<home-origin>/internal/v1/mcp
```

For a Mac Home on loopback, `<home-origin>` is `http://127.0.0.1:<port>` (or `http://localhost:<port>`). For a remote Home or an Opensteer Cloud Computer, `<home-origin>` is its `https://` origin.

### Discovery

Send an unauthenticated `POST` to `<home-origin>/internal/v1/mcp`. The Home replies with HTTP `401` and a `WWW-Authenticate` header pointing to its protected-resource metadata:

```http
WWW-Authenticate: Bearer resource_metadata="<home-origin>/.well-known/oauth-protected-resource/internal/v1/mcp"
```

The Home serves standard OAuth metadata with `Cache-Control: no-store` and `Access-Control-Allow-Origin: *`:

- Protected-resource metadata: `GET /.well-known/oauth-protected-resource/internal/v1/mcp` (and `GET /.well-known/oauth-protected-resource`)
  - `resource`: `<home-origin>/internal/v1/mcp`
  - `authorization_servers`: `["<home-origin>/oauth/mcp"]`
  - `bearer_methods_supported`: `["header"]`
  - `scopes_supported`: `["opensteer"]`
- Authorization-server metadata: `GET /.well-known/oauth-authorization-server/oauth/mcp` (and `GET /.well-known/oauth-authorization-server`)
  - `issuer`: `<home-origin>/oauth/mcp`
  - `authorization_endpoint`: `<home-origin>/oauth/mcp/authorize`
  - `token_endpoint`: `<home-origin>/oauth/mcp/token`
  - `registration_endpoint`: `<home-origin>/oauth/mcp/register`
  - `response_types_supported`: `["code"]`
  - `grant_types_supported`: `["authorization_code"]`
  - `code_challenge_methods_supported`: `["S256"]`
  - `token_endpoint_auth_methods_supported`: `["none"]`
  - `scopes_supported`: `["opensteer"]`
  - `authorization_response_iss_parameter_supported`: `true`

### Dynamic client registration

Register your client with `POST <home-origin>/oauth/mcp/register` (JSON body, up to 16 KiB):

- `client_name`: 1–100 characters after control characters are stripped (defaults to `"MCP client"`).
- `redirect_uris`: 1–5 callback URLs. Each must be `https://` or loopback `http://` (`localhost`, `127.0.0.1`, or `[::1]`) with no `#fragment` and no embedded username or password. Custom URL schemes are dropped; if no valid URI remains, registration returns `400` with `{"error":"invalid_client_metadata"}`.

The Home returns `201 Created` with a signed, stateless `client_id` (up to 16 KiB — do not store it in a short fixed-width column) and `token_endpoint_auth_method: "none"`.

### Authorization and PKCE

Send the person's browser to `GET <home-origin>/oauth/mcp/authorize` with:

- `response_type=code`
- `client_id`: from registration
- `redirect_uri`: exact match for `https://`; for loopback `http://`, scheme, host, path, and query must match (port may differ)
- `code_challenge`: 43-character base64url SHA-256 digest of your verifier
- `code_challenge_method=S256` (plain is rejected)
- `state` (optional, up to 2,048 characters)
- `scope` (optional; the Home always grants `"opensteer"`)
- `resource` (optional; if sent, must equal `<home-origin>/internal/v1/mcp` or with one trailing `/`)

Consent requests expire after **10 minutes**.

### What the person sees at consent

The Home redirects the browser to its consent screen (`/mcp-authorization`) showing:

1. **Who is asking.** If your `redirect_uri` origin is in Opensteer's signed agent directory (fetched by the Home from its Opensteer account service), the screen shows the verified platform name and origin (or verified embedder via platform when a signed `opensteer_embedder_assertion` JWS is verified). Otherwise, it shows your self-claimed `client_name`, your redirect origin (or `"an app on this computer"` for loopback), and `"Only approve if you started this yourself."`
2. **What it can use.** The person chooses **Choose what it can use** (specific browser profiles, shared Chrome tabs, apps/phones, plugins, and/or Tasks) or **Everything my own agents can do**.
3. **Safety mode** and a connection **Name**.
4. **Terms.** Access lasts 30 days, and the person can disconnect the agent at any time in **Settings → Connected agents**.

If the person allows the connection, their browser redirects to your `redirect_uri` with `code`, `iss`, and `state`. If they deny, it redirects with `error=access_denied`, `iss`, and `state`. Authorization codes expire in **60 seconds**, are single-use, and are burned on any failed exchange.

### Token exchange and lifetime

Exchange the code with `POST <home-origin>/oauth/mcp/token` (`application/x-www-form-urlencoded` or `application/json`):

- `grant_type=authorization_code`
- `code`
- `client_id`
- `redirect_uri`
- `code_verifier` (43–128 characters matching `[A-Za-z0-9._~-]`)
- `resource` (optional; must match `<home-origin>/internal/v1/mcp` or with one trailing `/`)

The Home returns:

```json
{
  "access_token": "ost_mcp_...",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "scope": "opensteer"
}
```

Use `Authorization: Bearer <access_token>` on every request to `<home-origin>/internal/v1/mcp`. Access tokens expire after **30 days**.

Each connected agent may hold up to **8** concurrent MCP connections (`mcp-session-id` is the MCP protocol's transport header; an idle transport closes after 30 minutes, and the Home still authenticates every request against the live bearer token). Requests with a browser `Origin` header other than `<home-origin>` are rejected (`403`).

### What is deliberately not offered

- **No refresh tokens.** `grant_types_supported` is `["authorization_code"]` only. Requesting `offline_access` still grants `scope: "opensteer"` with no `refresh_token`. When the 30-day token expires, start a new OAuth authorization flow so the person re-consents.
- **No Client ID Metadata Documents (CIMD).** The Home never fetches a URL supplied by a connecting agent. Use dynamic client registration (`/oauth/mcp/register`). Verified identities come only from Opensteer's signed directory.

### Disconnect

When the person clicks **Disconnect** in **Settings → Connected agents**:

- The Home revokes the connection in one transaction and deletes its stored token hash.
- Open MCP transports and browser WebSockets for that agent are closed, pending Requests are cancelled, and in-flight work is stopped.
- The very next MCP call and any request presenting that bearer token are refused with HTTP `401` and `WWW-Authenticate: Bearer resource_metadata="..."`.
- On the person's screen, the connection moves from **Stopping** to **Disconnected** once devices confirm in-flight work ended. If contact was lost mid-effect, the person sees **Check its last action**.

### Minimal working example (Node.js + official MCP SDK)

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const homeOrigin = "http://127.0.0.1:4310";
const endpoint = new URL("/internal/v1/mcp", homeOrigin);
const redirectUri = "http://127.0.0.1:49317/callback";

class OpensteerOAuth implements OAuthClientProvider {
  #client?: OAuthClientInformationMixed;
  #tokens?: OAuthTokens;
  #verifier = "";
  code?: string;

  constructor(private readonly openInBrowser: (url: URL) => Promise<string>) {}

  get redirectUrl() {
    return redirectUri;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "My Research Agent",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() { return this.#client; }
  saveClientInformation(info: OAuthClientInformationMixed) { this.#client = info; }
  tokens() { return this.#tokens; }
  saveTokens(tokens: OAuthTokens) { this.#tokens = tokens; }
  saveCodeVerifier(v: string) { this.#verifier = v; }
  codeVerifier() { return this.#verifier; }
  async redirectToAuthorization(authorizationUrl: URL) {
    // Open authorizationUrl in the person's browser and wait for your callback to capture ?code=
    this.code = await this.openInBrowser(authorizationUrl);
  }
}

export async function connectToHome(openInBrowser: (url: URL) => Promise<string>) {
  const authProvider = new OpensteerOAuth(openInBrowser);
  const client = new Client({ name: "My Research Agent", version: "1.0.0" });

  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider }));
  } catch (err) {
    if (!(err instanceof UnauthorizedError) || !authProvider.code) throw err;
    const finishing = new StreamableHTTPClientTransport(endpoint, { authProvider });
    await finishing.finishAuth(authProvider.code);
    await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider }));
  }

  return client;
}
```

---

## 2. What a Grant Is

A grant defines what a connected agent is allowed to reach on the person's Home. There are two scopes:

- **`everything`**: everything the person's own agents can do (all browser profiles, shared Chrome tabs, approved apps and phones, plugins, and Tasks). Settings tools also require `full-access` mode.
- **`selected`**: a boolean `tasks` flag plus up to **64** listed resources, each of one of four kinds:
  1. **Browser profile** (`browser-profile`, read-write): full control of that profile and every site signed in there. A dedicated sign-in profile used for AI accounts cannot be included in a `selected` grant.
  2. **Chrome tabs the person shares** (`chrome-tabs`, read-write): tabs the person shares one at a time from Chrome using the **Opensteer tab sharing** extension ("Share this tab with Opensteer").
  3. **Mac app or phone screen** (`computer-app`, read-write): one already-approved Mac app (pinned to its device, approval record, bundle ID, and code-signing team) or one Android Agent Phone or iPhone screen. If an app's signer or approval changes, it automatically falls out of the grant.
  4. **Plugin** (`plugin`, `read` or `read-write`): an installed plugin, a local MCP server, or a device data account (such as Calendar, Contacts, Reminders, Messages, Photos, or Location).

### Tools follow the grant

A tool outside your grant is neither listed by `tools/list` nor callable:

- Browser profile or shared Chrome tabs → browser and tab tools (`browser_use`, `browser_connect`, `browser_profile_list`, `tab_list`, `tab_open`, `tab_close`, `saved_login_request`, `card_request`).
- Mac app or phone screen → `computer_apps`, `computer_list`, `computer_use`.
- Plugin → `plugin_search`, `plugin_describe`, `plugin_skills`, `plugin_call`, `plugin_execute`, `plugin_resume`, `local_server_list`.
- `tasks: true` → task, request-read, and automation tools (see [Section 5](#5-the-tools)).
- Any of the above → `ask_person`.
- Connected agents can never call tools that ask the person for more access (`computer_access_request`, `app_access_request`, `browser_profile_request`, `chrome_cookies_request`, `plugin_account_request`). To widen a grant, tell the person what you need so they can change it in **Settings → Connected agents**.

If the person edits your grant or access mode while you are connected, the Home closes your open MCP transport. Reconnecting gives you the updated tool list.

### What a narrow grant sees for unshared resources

When a connected agent with a `selected` grant asks for a browser profile, tab, task, app, device, or plugin outside its grant, **the Home returns the exact same error as for an ID that does not exist**.

For example, calling `browser_use` with another agent's `tabId` returns the same `not_found` (`"Tab not found."`) as calling it with a random nonexistent `tabId`. Calling `opensteer_task_read` with another task's ID returns the same `access_denied` (`"Task is unavailable"`) as a nonexistent task ID. Listings (`browser_profile_list`, `tab_list`, `computer_list`, `computer_apps`, `plugin_search`, `opensteer_task_list`) silently omit anything outside your grant, and `browser_profile_list` / `tab_list` hide the device's name and ID unless that device is also granted.

**Why:** so an agent with a narrow grant cannot probe whether other profiles, apps, plugins, devices, or tasks exist on the person's Home.

### Minimal working example

```ts
// Discover only the tools your grant allows
const { tools } = await client.listTools();
const names = new Set(tools.map((t) => t.name));

if (names.has("browser_profile_list")) {
  const res = await client.callTool({ name: "browser_profile_list", arguments: {} });
  // Contains only profiles shared with this connected agent
  const { profiles } = res.structuredContent as {
    profiles: Array<{ id: string; name: string; home: { reachable: boolean } | null }>;
  };
  console.log("Granted profiles:", profiles);
}

// Passing an ungranted or nonexistent tabId returns the same error
const probe = await client.callTool({
  name: "browser_use",
  arguments: { tabId: "tab_does_not_exist", code: "print(1)" },
});
// probe.isError === true
// probe.structuredContent === { error: { code: "not_found", message: "Tab not found.", next: null } }
```

---

## 3. Access Modes

Every connected agent has an access mode ceiling chosen by the person at consent (and editable later). Opensteer defines four modes, from strictest to broadest:

| Mode | Effect on tasks run by the person's own agents | Effect on a connected agent's direct tool calls |
| :--- | :--- | :--- |
| `approval-required` | Asks the person before actions with side effects. | Reads run directly. Every write asks the person first. |
| `auto-accept-edits` | Edits files in its tasks without asking; asks before anything else. | Same as `approval-required`: reads run directly; every write asks the person first. |
| `auto` | Automatic review; asks the person when unsure. | Reads run directly. On a write, if the Home has a review model configured, it reviews the call within 15 seconds and either allows it or asks the person. If no review model is configured, or on timeout, credential-like text, URL query strings, or any doubt, it asks the person. |
| `full-access` | Never asks for routine actions. | Reads and writes inside the grant run without asking. |

Two rules always hold regardless of mode:

1. **Intersection of ceilings.** The effective mode of any work is always the lowest mode anywhere in its chain: the connection's mode, the task's mode, and (on a work Home) the organization's policy ceiling.
2. **Person-only tools always ask.** Even in `full-access`, `ask_person`, `saved_login_request`, and `card_request` always ask the person in **Needs you**.
3. **Settings tools.** Changing Home settings (renaming/removing profiles or devices, editing defaults or messaging bridges) requires both `everything` and `full-access`.

### Which direct calls are reads vs writes

- **Reads (run without asking):** `tab_list`, `browser_profile_list`, `computer_list`, `computer_apps`, `computer_use` with `readOnly: true`, `plugin_search`, `plugin_describe`, `plugin_skills`, `local_server_list`, and `plugin_call` when every called plugin tool is declared read-only.
- **Writes (checked against access mode):** `tab_open`, `tab_close`, `browser_use`, `browser_connect`, `computer_use` (unless `readOnly: true`), `plugin_call` (when any called tool is not read-only), and `plugin_execute`.

### What "Allow once" means

When a direct write asks the person, the Home creates a durable Request in **Needs you** showing the target, the exact script or tool call, and (labelled separately as your own untrusted words) the `reason` you passed. The person chooses **Allow once** or **Don't allow**:

- **Allow once** allows **only that single operation**, bound to its exact arguments, target, grant version, and mode. It never widens your grant and never pre-approves the next call. If your grant version, mode, or target changes before execution starts, the Home asks again.
- **Don't allow** refuses the operation (`code: "access_denied"`, `"The person did not allow it."`).

### Minimal working example

```ts
const callArgs = {
  operationKey: "open-orders-page-1",
  reason: "Open the orders page so I can read the tracking number.",
  code: `
    const page = await newPage("https://shop.example/orders");
    print(await page.title());
  `,
};

// Under approval-required, the Home holds up to 25 seconds for Allow once.
// If the person has not answered yet, status is "pending".
const first = await client.callTool({ name: "browser_use", arguments: callArgs });
const meta = first.structuredContent as { status: string; taskId: string; requestId?: string };

if (meta.status === "pending") {
  // Tell the person (or wait for them to tap Allow once in Needs you), then call again
  // with the EXACT same operationKey and arguments (plus the returned taskId).
  const resumed = await client.callTool({
    name: "browser_use",
    arguments: { ...callArgs, taskId: meta.taskId },
  });
  console.log(resumed.content);
}
```

---

## 4. Tasks

Every piece of a connected agent's own direct work belongs to a listed task on the person's Home. That task is where the person watches open tabs, answers **Needs you** prompts, sees activity, and clicks **Stop**.

### `taskId` on direct tools

Direct tools (`browser_use`, `browser_connect`, `tab_list`, `tab_open`, `tab_close`, `computer_use`, `plugin_call`, `plugin_execute`, `plugin_resume`, `ask_person`, `saved_login_request`, `card_request`) all accept an optional `taskId` and return `taskId` in their result:

- **Omit `taskId`** to continue your connection's active direct-work task, or start a new one if none is active (titled after your connection's name).
- **Pass `taskId`** from an earlier direct tool result to keep working inside that same task.
- A direct-work task ends if the person clicks **Stop** or **Disconnect**, narrows your grant, the token expires, or the task sits idle for **15 minutes** with no open Request (an open Request keeps it alive for up to 24 hours).

Direct work runs even on a Home that has none of the person's own coding agents installed.

### Doing the work yourself vs starting a task for the person's own agents

There are two distinct ways to get work done on a Home:

1. **Direct work (your own model drives the tools).** Call `browser_use`, `browser_connect`, `computer_use`, `plugin_call`, and `ask_person` directly. Your agent decides every step.
2. **Tasks run by the person's own agents** (requires `tasks: true` or `everything`). Call `opensteer_task_create` with a `message` (and optional `title`, `aiAccountId`, `model`). One of the person's own agents runs on their Home with that computer's files, commands, and network, bounded by your connection's access mode ceiling and grant.
   - Nothing returns automatically to a connected agent. Wait with `opensteer_task_wait` (up to 100 seconds per call) or read progress with `opensteer_task_read`.
   - Always pass `taskId` explicitly to task management tools (`opensteer_task_read`, `opensteer_task_send`, `opensteer_task_wait`, `opensteer_task_interrupt`, `opensteer_task_resume`, `opensteer_task_update`, `opensteer_task_configure`, `opensteer_task_queue`).

Do not mix the two kinds of `taskId`:

- Passing a direct-work `taskId` to `opensteer_task_send` fails with `conflict` (`"A connected agent is doing this task itself, so it takes no messages here."`).
- Passing an `opensteer_task_create` `taskId` to a direct tool like `browser_use` fails with `access_denied` (`"Task is unavailable"`).

### Minimal working example

```ts
// 1. Direct work: omit taskId on the first call, pass it on the next
const list = await client.callTool({ name: "tab_list", arguments: {} });
const directTaskId = (list.structuredContent as { taskId: string }).taskId;

await client.callTool({
  name: "browser_use",
  arguments: {
    taskId: directTaskId,
    operationKey: "check-title-1",
    code: `const p = await newPage("https://example.com"); print(await p.title());`,
  },
});

// 2. Starting a task for one of the person's own agents (requires tasks: true)
const created = await client.callTool({
  name: "opensteer_task_create",
  arguments: {
    title: "Summarize quarterly report",
    message: "Read ~/Documents/q3.md and write a 5-bullet summary.",
    mode: "async",
  },
});
const homeTaskId = (created.structuredContent as { taskId: string }).taskId;

// Wait up to 50 seconds (max 100_000 ms); repeat wait if status is "timed_out"
const waited = await client.callTool({
  name: "opensteer_task_wait",
  arguments: { taskId: homeTaskId, timeoutMs: 50_000 },
});
console.log(waited.structuredContent);
```

---

## 5. The Tools

Tools are grouped below by what they do. Remember: `tools/list` only returns the groups your grant includes.

### Browser (`browser_profile_list`, `browser_use`, `browser_connect`)

Connected agents work only in granted saved browser profiles or Chrome tabs shared by the person — never in Guest tabs. If you hold exactly one browser profile and pass neither `tabId` nor `profileId`, `browser_use` and `browser_connect` target that profile automatically. If you hold several, pass `profileId` or `tabId`. For a shared Chrome tab, always pass its `tabId` from `tab_list` (do not pass `profileId`).

#### `browser_profile_list`

Lists granted saved browser profiles (`profiles: [{ id, name, home: { reachable, computerId?, name? } | null }]`). Each profile opens only on its home device.

#### `browser_use`

Runs one sandboxed JavaScript script (up to 65,536 characters, 120-second default timeout) confined to the single granted profile or shared Chrome tab reviewed for that call. Variables stored on `globalThis` persist across `browser_use` calls within the same task and profile.

Globals available inside `code`:

- `await pages()` — lists open tabs in the targeted profile (or the shared Chrome tab).
- `await openPage(tabId)` — binds an existing tab and returns a `page` handle.
- `await newPage(url, { profileId })` — opens and binds a new page in the targeted profile (`http://`, `https://`, or `about:blank`; not allowed on a shared Chrome tab).
- `print(...values)` — emits text lines to the tool output (or return a value).
- `await printImage(base64Data, mimeType?)` — emits an image block (`image/png`, `image/jpeg`, `image/webp`, `image/gif`).
- `await sleep(ms)` — waits.

Key `page` methods:

- Navigation & info: `goto(url, { timeout })`, `gotoUrl(url)`, `url()`, `title()`, `currentTab()`, `pageInfo()`, `waitForURL(expected, { timeout })`, `waitForLoad({ timeout })`, `waitForNetworkIdle({ timeout, idleMs })`, `waitForElement(selector, { timeout })`, `waitForFunction(fn, arg, { timeout })`, `waitForTimeout(ms)`.
- Locators & input: `locator(selector)`, `getByRole(role, opts)`, `getByText(text, opts)`, `getByLabel(text, opts)`, `mouse.click(x, y, opts)`, `clickAt(x, y, opts)`, `keyboard.press(key)`, `keyboard.type(text)`, `keyboard.insertText(text)`, `typeText(text)`, `fillInput(selector, value, opts)`, `pressKey(key, opts)`, `scroll(x, y, { deltaX, deltaY })`.
- Inspection, JS & raw CDP: `evaluate(fn, arg)`, `js(expression)`, `ariaSnapshot()`, `screenshot()` (captures the viewport as a PNG image block without resizing the person's view; omit any file path), `cdp(method, params, sessionId?)` (where `sessionId` is CDP's optional child-target ID), `drainEvents()`, `respondDialog({ accept, promptText? })`.

Minimal working example:

```ts
const res = await client.callTool({
  name: "browser_use",
  arguments: {
    taskId: directTaskId,
    operationKey: "read-account-1",
    reason: "Read the latest order status.",
    code: `
      globalThis.page = await newPage("https://shop.example/account");
      const heading = await page.locator("h1").innerText();
      await page.screenshot();
      print({ tabId: page.tabId, heading });
    `,
  },
});
// res.content[0] is the printed text; res.content[1] is the PNG image block.
// res.structuredContent carries { status, taskId, operationId, profileId }.
```

#### `browser_connect`

Returns a single-use WebSocket URL for a standard Chrome DevTools Protocol (CDP) client such as stock Playwright or Puppeteer:

```json
{
  "status": "completed",
  "taskId": "thr_...",
  "operationId": "aop_...",
  "endpoint": "wss://<home-origin>/v1/browser/connect/<43-char-ticket>",
  "mode": "whole-context",
  "connect": "chromium.connectOverCDP(endpoint)",
  "tabId": "tab_...",
  "expiresAt": "2026-11-20T14:40:00.000Z"
}
```

Rules for `browser_connect`:

- **Connect within 1 minute.** The single-use ticket in `endpoint` expires 60 seconds after issue.
- **Modes.** `mode` is either:
  - `"whole-context"`: granted on a saved browser profile when your task is the sole live holder on that profile and the browser supports it. Allows context-wide cookie and permission commands (`Storage.getCookies/setCookies/clearCookies`, `Browser.setPermission/grantPermissions/resetPermissions`) and workers. Connect with:
    ```ts
    const browser = await chromium.connectOverCDP(endpoint);
    ```
  - `"session"` (the tool's own mode name for page-scoped access): used for shared Chrome tabs and whenever another live task shares the saved profile. Context-wide cookie/permission commands are refused; page-scoped commands work on owned pages and their popups. Connect with:
    ```ts
    const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    ```
  Always follow the returned `connect` line (or branch on `mode === "session"`).
- **Puppeteer and raw CDP clients.** You can pass `endpoint` to any standard CDP WebSocket client. Do not call `Target.attachToBrowserTarget` (Playwright's `newBrowserCDPSession()` / `newCDPSession()` use it and are refused), browser shutdown, or context creation/disposal; use the virtual root directly (`Target.getTargets`, `Target.attachToTarget`, etc.). Limits: 8 MiB per JSON frame, 128 in-flight messages, up to 4 live CDP connections per task.
- **10-minute interval and renewal.** Each attachment lasts up to **10 minutes** (`expiresAt`), or ends sooner if the person clicks **Stop**, clicks **Disconnect**, or stops sharing the Chrome tab. To get another 10-minute interval, call `browser_connect` again with a **new `operationKey`** and pass the same `tabId` (omitting `tabId` on a profile opens a new `about:blank` tab each time; reusing the old `operationKey` does not issue a new endpoint). Under `approval-required`, each new 10-minute interval asks the person again.

Minimal working example (stock Playwright):

```ts
import { chromium } from "playwright-core";

const reply = await client.callTool({
  name: "browser_connect",
  arguments: {
    taskId: directTaskId,
    operationKey: "cdp-interval-1",
    reason: "Inspect the order history table.",
  },
});
const { endpoint, mode, tabId, expiresAt } = reply.structuredContent as {
  endpoint: string;
  mode: "whole-context" | "session";
  tabId: string;
  expiresAt: string;
};

const browser = await chromium.connectOverCDP(
  endpoint,
  mode === "session" ? { noDefaults: true } : {},
);
try {
  const context = browser.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://shop.example/orders");
  console.log(await page.locator("h1").innerText(), "valid until", expiresAt);
} finally {
  await browser.close();
}

// When you need another 10-minute interval on the same tab:
// call browser_connect again with { taskId: directTaskId, tabId, operationKey: "cdp-interval-2" }.
```

### Tabs (`tab_list`, `tab_open`, `tab_close`)

- `tab_list`: lists tabs your grant can reach (50 per page, with `nextCursor`, optional `query`, `kind`). Tabs the person shared from Chrome carry `sharedByPerson: { sourceId, computerName }`.
- `tab_open`: for connected agents, opens browser pages only (`target: { kind: "page", url, profileId }`). Non-page targets (`window`, `phone`, `app`) and Guest tabs are refused.
- `tab_close`: removes tabs from the person's tab list without quitting apps or stopping work. Connected agents must pass **exactly one** tab ID per call (`tabIds: [tabId]`) so each close is reviewed individually.

Minimal working example:

```ts
const opened = await client.callTool({
  name: "tab_open",
  arguments: {
    taskId: directTaskId,
    operationKey: "open-docs-1",
    target: { kind: "page", profileId, url: "https://example.com" },
  },
});
const { tab } = opened.structuredContent as { tab: { tabId: string } };

await client.callTool({
  name: "tab_close",
  arguments: { taskId: directTaskId, operationKey: "close-docs-1", tabIds: [tab.tabId] },
});
```

### Apps and phones (`computer_apps`, `computer_list`, `computer_use`)

- `computer_apps`: call with `{}` to list the Macs (with their granted apps) and phone screens (Android Agent Phones and iPhones) your grant can reach. Each target shows either `access` (`"read"` or `"read-write"`) or `blocked: { code, message, next }`. Pass `computerId` (and optional `query`) to list installed apps on a granted phone (to get the opaque `appId` for `launch`) or your granted apps on a Mac.
- `computer_list`: lists reachable computers and phones you can see, including `online`, `asleep`, and for phones `phoneDisplay` (`control`, `input`, `navigationButtons`, `actions`). On a `selected` grant, an iPhone hides the name of its connected Mac unless that Mac is also granted.
- `computer_use`: runs sandboxed JavaScript (up to **20,000 characters** for connected agents) against the single Mac app or phone screen named in the tool arguments:
  - Pass `computerId` and `app` (Mac app name or `bundleId`) for a Mac app.
  - Pass `computerId` and omit `app` for a phone screen.
  - Set `readOnly: true` to observe without triggering write approval.
  - Inside `code`: call `await app(query)` → `await myApp.window()` (`observe({ screenshot })`, `click`, `type`, `key`, `setValue`, `scroll`, `act`) or `await phone(query)` (`observe()`, `tap`, `longPress`, `swipe`, `drag`, `type`, `clear`, `navigate`, `launch(appId)`, `scroll`, `wake`, `wait`, `installedApps()`), plus `print(...)` and `sleep(ms)`. Note: `tab(tabId)` is not available to connected agents.

Minimal working example:

```ts
const inv = await client.callTool({ name: "computer_apps", arguments: {} });
const { computers } = inv.structuredContent as {
  computers: Array<{ computerId: string; apps: Array<{ name: string; bundleId: string }> }>;
};
const mac = computers[0]!;
const notes = mac.apps[0]!;

const observed = await client.callTool({
  name: "computer_use",
  arguments: {
    taskId: directTaskId,
    computerId: mac.computerId,
    app: notes.bundleId,
    readOnly: true,
    operationKey: "observe-notes-1",
    code: `
      const target = await app(${JSON.stringify(notes.bundleId)});
      const win = await target.window();
      const snap = await win.observe({ screenshot: true });
      print(win.title, snap.elements?.length ?? 0);
    `,
  },
});
```

### Plugins (`plugin_search`, `plugin_describe`, `plugin_skills`, `local_server_list`, `plugin_call`, `plugin_execute`, `plugin_resume`)

Installed plugins, local MCP servers, and approved device data apps (Calendar, Contacts, Reminders, Messages, iPhone Photos and Location) all appear through the plugin tools under `tools.<namespace>.<tool>`.

- `plugin_search`, `plugin_describe`, `plugin_skills`, `local_server_list`: discover tool paths, TypeScript signatures, skills, and local servers within your grant. Tools outside your granted access level (`read` vs `read-write`) appear with `blocked: { code: "access_denied", ... }`.
- `plugin_call`: call one `{ path, input }` or an array of independent calls belonging to **one plugin per operation** (canonical JSON up to 20,000 characters). Calls using only read-only plugin tools run as reads; calls containing any write follow your access mode.
- `plugin_execute`: run a JavaScript program (up to 20,000 characters) over `tools.<namespace>.<tool>()`. Connected agents must pass `namespace` (from `plugin_search`) naming the single plugin the program may use. Always treated as a write.
- `plugin_resume`: if a plugin itself waits to ask the person for input in **Needs you**, `plugin_call` / `plugin_execute` returns `status: "pending"` **with an `executionId`**. Wait until the person answers, then call `plugin_resume({ executionId, taskId })` (calling it before they answer returns `conflict`).

Minimal working example:

```ts
const found = await client.callTool({
  name: "plugin_search",
  arguments: { query: "calendar events" },
});
const firstTool = (found.structuredContent as { items: Array<{ path: string }> }).items[0]!;

const called = await client.callTool({
  name: "plugin_call",
  arguments: {
    taskId: directTaskId,
    operationKey: "list-events-1",
    calls: { path: firstTool.path, input: { days: 3 } },
  },
});
const payload = called.structuredContent as {
  status: string;
  executionId?: string;
  taskId: string;
  result?: unknown;
};

if (payload.status === "pending" && payload.executionId) {
  // Plugin asked the person for input in Needs you; resume after they answer:
  const resumed = await client.callTool({
    name: "plugin_resume",
    arguments: { taskId: payload.taskId, executionId: payload.executionId },
  });
  console.log(resumed.structuredContent);
}
```

### Asking the person (`ask_person`)

Ask the person a question only they can answer (for example, confirming they completed a second factor or CAPTCHA in the shared tab, or choosing between two options).

Constraints for connected agents:

- `questions` must have **exactly 1** item, and `multiSelect` must not be `true`.
- Free-text input is disabled on connected-agent questions so secrets are never typed into chat. Pass `options` (2–6 choices), or omit `options` to offer the default choices `["Done", "Unable to do it"]`.
- The person sees your connection label, task title, a warning `"Enter passwords and codes only in the page."`, and your `title` and `detail` quoted as your words.
- When answered, returns `{ status: "completed", taskId, operationId, answer: "<chosen label>" }`.

Minimal working example:

```ts
const asked = await client.callTool({
  name: "ask_person",
  arguments: {
    taskId: directTaskId,
    operationKey: "confirm-2fa-1",
    title: "Finish sign-in in the open tab",
    detail: "Please complete the verification code in the browser tab, then tap Done.",
    questions: [{ question: "Did you finish the verification?" }],
  },
});
// When answered: { status: "completed", taskId, operationId, answer: "Done" }
```

### Saved logins and cards (`saved_login_request`, `card_request`)

When a website in a granted saved browser profile needs a saved login or payment card from Opensteer Passwords, ask the person with `saved_login_request` or `card_request`.

- Both tools require a live `tabId` in a granted saved browser profile on the Home's own browser, **already open on `site`** (omitting `tabId` or using a shared Chrome tab is refused).
- Both **always ask the person** in **Needs you**, even in `full-access` mode, and never remember approval across calls for a connected agent.
- **What you receive:** you **never** receive a username, password, TOTP code, card number, expiry date, CVC, card brand, or last four digits.
  - `saved_login_request` returns `{ status: "completed", taskId, operationId, loginStatus: "ready", loginRef: "lgn_..." }` (or `loginStatus: "declined"` / `"unavailable"` with `reason`, such as `"no-saved-login"`, `"passwords-off"`, `"passwords-not-set-up"`, `"main-browser-required"`, `"not-allowed"`).
  - `card_request` returns `{ status: "completed", taskId, operationId, cardStatus: "ready", cardRef: "crd_..." }` (or `cardStatus: "declined"` / `"unavailable"` with `reason`).
- **How to fill:** in `browser_use` on that same tab, focus each form field and call:
  - `await page.cdp("Opensteer.fillLogin", { loginRef, field })` where `field` is `"username"`, `"password"`, or `"code"`.
  - `await page.cdp("Opensteer.fillCard", { cardRef, field })` where `field` is `"number"`, `"expiry"`, `"expiry-month"`, `"expiry-year"`, `"cvc"`, `"name"`, or `"billing-postal-code"`.
  - Check `result.status === "filled"` (other statuses: `"no-field"`, `"wrong-site"`, `"stale"`, `"expired"`, `"denied"`, `"unavailable"`).
- **Lifetime:** references expire after 60 minutes (logins) or 30 minutes (cards), and stop working immediately on Stop, Disconnect, or a grant change. Card approval covers filling only; the person's request must cover any purchase.

Minimal working example:

```ts
// 1. Ensure the tab is already on https://app.example/login, then ask Passwords:
const login = await client.callTool({
  name: "saved_login_request",
  arguments: {
    taskId: directTaskId,
    tabId,
    site: "https://app.example",
    reason: "Sign in to download the invoice.",
    operationKey: "login-app-example-1",
  },
});
const { loginStatus, loginRef } = login.structuredContent as {
  loginStatus?: string;
  loginRef?: string;
};

// 2. If ready, focus each field and fill via Opensteer.fillLogin (never read back the values):
if (loginStatus === "ready" && loginRef) {
  await client.callTool({
    name: "browser_use",
    arguments: {
      taskId: directTaskId,
      tabId,
      operationKey: "fill-app-example-1",
      code: `
        const page = await openPage(${JSON.stringify(tabId)});
        const ref = ${JSON.stringify(loginRef)};
        for (const [selector, field] of [
          ['input[name="username"]', "username"],
          ['input[name="password"]', "password"],
        ]) {
          await page.js(\`document.querySelector(\${JSON.stringify(selector)}).focus()\`);
          const r = await page.cdp("Opensteer.fillLogin", { loginRef: ref, field });
          if (r.status !== "filled") throw new Error("Fill failed: " + r.status);
        }
        await page.getByRole("button", { name: "Sign in" }).click();
      `,
    },
  });
}
```

### Tasks and their reads (`opensteer_task_*`, `opensteer_request_*`, `opensteer_automation_*`)

Available when the grant includes `tasks: true` or `everything`:

- **Create & run:** `opensteer_task_create`, `opensteer_task_send` (`delivery: "report" | "queue" | "steer"`), `opensteer_task_interrupt`, `opensteer_task_resume`, `opensteer_task_update` (rename or mark Done/reopen), `opensteer_task_configure`, `opensteer_task_queue`.
- **Read & wait:** `opensteer_task_list`, `opensteer_task_read` (`view: "messages"` or `"activity"`, paged with `cursor` or one truncated entry with `itemId` + `textOffset`), `opensteer_task_wait` (max `timeoutMs: 100000`), `opensteer_subagent_read`, `opensteer_request_list`, `opensteer_request_read`.
- **Automations:** `opensteer_automation_list`, `opensteer_automation_read`, `opensteer_automation_create` (requires `full-access` and explicit `taskId`), `opensteer_automation_update`, `opensteer_automation_control`.

With a `selected` grant (`tasks: true`), `opensteer_task_list` and `opensteer_task_read` show only tasks created by your connection. With `everything`, you also see the person's own tasks (and, in `full-access`, Home settings tools such as `opensteer_ai_account_list`, `opensteer_defaults_read/update`, `browser_profile_update/remove`, `computer_update/remove`, `opensteer_plugin_list/catalog`, `plugin_resources`, `opensteer_messaging_bridge_*`, and `app_list`).

Minimal working example:

```ts
const listed = await client.callTool({
  name: "opensteer_task_list",
  arguments: { limit: 10 },
});
const { tasks } = listed.structuredContent as {
  tasks: Array<{ id: string; title: string | null; status: string }>;
};

if (tasks[0]) {
  const detail = await client.callTool({
    name: "opensteer_task_read",
    arguments: { taskId: tasks[0].id, view: "messages", limit: 10 },
  });
  console.log(detail.structuredContent);
}
```

---

## 6. Results

Every direct tool call is recorded on the Home before it is reviewed or executed. Its receipt fields appear in `structuredContent` (and in `content[0].text` JSON for record tools; for `browser_use` and `computer_use`, `content` carries the script's printed text and images while `structuredContent` carries the receipt):

| Field | Values / meaning |
| :--- | :--- |
| `status` | `"completed"`, `"pending"`, `"failed"`, or `"unknown"` (`plugin_call` / `plugin_execute` / `plugin_resume` may also return plugin statuses `"cancelled"`, `"expired"`, or `"interrupted"`). |
| `taskId` | The direct-work task ID (`thr_...`). Pass this on follow-up direct calls. |
| `operationId` | Durable receipt ID (`aop_...`) for this operation. |
| `requestId` | Present when `status === "pending"` (`req_...`, or `null` if not yet attached). |
| `next` | Plain-English next step, present whenever `status !== "completed"` (and on a replayed `browser_connect`). |

### Handling `pending`

When an operation needs the person (approval, `ask_person`, `saved_login_request`, or `card_request`), the Home holds the call open for up to **25 seconds** waiting for an answer. If the person has not answered yet, the tool returns:

```json
{
  "status": "pending",
  "taskId": "thr_...",
  "operationId": "aop_...",
  "requestId": "req_...",
  "next": "Waiting on the person in Needs you. Do not poll. Call again with the same operationKey and arguments after they answer."
}
```

What to do:

1. **Always supply your own `operationKey`** on any call that might wait on the person. If you omit `operationKey`, the Home derives one from the JSON-RPC request ID, so a later call starts a duplicate Request instead of resuming the first one.
2. **Do not poll tightly.** Tell the person a decision is waiting in **Needs you** (or back off before checking again — each call holds up to 25 seconds).
3. **Resume by calling the exact same tool with the exact same `operationKey` and arguments** (and `taskId`). Reusing the same `operationKey` with different arguments fails with `conflict`.
4. **Exception for plugins:** if `plugin_call` or `plugin_execute` returns `status: "pending"` **with an `executionId`**, the plugin asked for input — resume with `plugin_resume({ executionId, taskId })`, not by repeating `plugin_call`.

### Handling `unknown` (**Uncertain**)

If contact with a device is lost mid-action or the Home restarts while an effect is in flight, the Home marks the operation **Uncertain** (`status: "unknown"`, or tool error `code: "outcome_unknown"`). The Home never retries an uncertain effect on its own.

What to do: **never blindly repeat an effect.** Run a safe read first (for example, `tab_list`, a read-only check in `browser_use`, `computer_use` with `readOnly: true`, or a read plugin call) to see whether the action already took effect.

### Handling the person's Stop

When the person clicks **Stop** on your task:

1. Any in-flight call is aborted with `isError: true`, `code: "access_denied"`, message `"The person stopped this work."` (if aborted mid-effect, the outcome may be `outcome_unknown` — check before acting again).
2. Any call that passes the stopped `taskId` is refused with `"The person stopped this work. Do not continue it; ask before starting again."`
3. The **first** call that omits `taskId` after a Stop is also refused **once** with that same message so your agent cannot silently ignore Stop. A subsequent call without `taskId` starts a fresh task — only do that after the person asks you to continue.

### Minimal working example

```ts
async function runDirect(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  operationKey: string,
) {
  const res = await client.callTool({ name, arguments: { ...args, operationKey } });
  if (res.isError) {
    const err = (res.structuredContent as { error: { code: string; message: string } }).error;
    if (err.code === "outcome_unknown") {
      return { outcome: "uncertain" as const, message: err.message };
    }
    if (err.message.startsWith("The person stopped this work.")) {
      return { outcome: "stopped" as const, message: err.message };
    }
    throw new Error(`${err.code}: ${err.message}`);
  }

  const body = (res.structuredContent ?? {}) as {
    status?: string;
    taskId?: string;
    operationId?: string;
    requestId?: string | null;
    next?: string;
  };
  if (body.status === "pending") {
    return { outcome: "pending" as const, taskId: body.taskId, requestId: body.requestId, next: body.next };
  }
  if (body.status === "unknown") {
    return { outcome: "uncertain" as const, next: body.next };
  }
  return { outcome: "completed" as const, body, content: res.content };
}
```

---

## 7. Errors and Refusals

### Wire shape

Tool-level failures return `isError: true` with identical JSON in `structuredContent` and `content[0].text`:

```json
{
  "error": {
    "code": "computer_asleep",
    "message": "This device is asleep. Wait until it wakes before using it.",
    "next": "computerId=dev_..., access=browser. Check computer_list; wait until it wakes and do not request access.",
    "device": { "id": "dev_...", "name": "Studio Mac" }
  }
}
```

- `code`: stable machine-readable code (string, up to 100 chars).
- `message`: plain-English explanation.
- `next`: actionable recovery guidance, or `null`.
- `device`: optional `{ id, name }`, present only on `computer_asleep` and `computer_stopped` and only when your grant allows knowing that device.

Authentication failures (revoked, expired, or invalid bearer token) are rejected at the HTTP layer with status `401` before reaching any tool.

### Stable codes

Normalized tool error codes emitted by the Home:

`access_denied`, `not_found`, `invalid_input`, `conflict`, `outcome_unknown`, `computer_stopped`, `computer_asleep`, `computer_offline`, `unsupported`, `port_in_use`, `resource_exhausted`, `timeout`, `plugin_unavailable`, `catalog_unavailable`, `internal_error`.

### What to do for each refusal family

| Situation | What you receive | What your agent should do |
| :--- | :--- | :--- |
| **Not shared (outside grant)**, **Don't allow**, or **device switch off** | `code: "access_denied"` or `code: "not_found"` (for a `selected` grant, unshared resources match nonexistent ones). | Do not retry or probe other IDs. If the person declined (**Don't allow**), respect it. If a resource or device switch is needed, tell the person — they control it in **Settings → Connected agents** or **Devices**. |
| **Device stopped** (**Stopped on this Mac** / **Stopped on {name}**) | `code: "computer_stopped"`, optional `device: { id, name }`. | The person turned on Stop on that device. Do not retry in a loop and do not ask for access. Wait until they resume agents there, or do other work. |
| **Device asleep or offline** | `code: "computer_asleep"` (with optional `device`) or `code: "computer_offline"`. | Wait until the device wakes or reconnects. Never substitute another profile or device — a browser profile only opens on its home device. |
| **Organization does not allow it** (work Home) | On a work Home, organization policy caps the grant and access mode at consent, so disallowed tools are unlisted or return `access_denied`. If a work Home is offboarding or ended, new direct operations fail at the database gate (currently surfacing as `internal_error`). | Do not retry. Tell the person their organization's policy or work Home status does not allow this action. |
| **Stopped by the person** | `code: "access_denied"` with `message` starting `"The person stopped this work."` (or `code: "outcome_unknown"` if interrupted mid-effect). | Stop working on that task immediately. If `outcome_unknown`, check state before any later action. Ask the person before starting new work. |
| **Disconnected or expired** | HTTP `401` on `/internal/v1/mcp` (with `WWW-Authenticate: Bearer resource_metadata=...`); open CDP WebSockets close with code `1008`. | Discard the stored bearer token and stop calling the Home. Start a new OAuth flow only if the person asks to reconnect. |

### Minimal working example

```ts
function classifyFailure(err: unknown): "reauth" | "wait" | "check-state" | "stop" | "report" {
  // HTTP 401 from StreamableHTTPClientTransport
  if (err instanceof UnauthorizedError) return "reauth";

  const toolError = err as { code?: string; message?: string };
  switch (toolError.code) {
    case "computer_asleep":
    case "computer_offline":
    case "computer_stopped":
      return "wait";
    case "outcome_unknown":
      return "check-state";
    case "access_denied":
      if (toolError.message?.startsWith("The person stopped this work.")) return "stop";
      return "report";
    case "not_found":
    case "invalid_input":
    case "unsupported":
    case "conflict":
    default:
      return "report";
  }
}
```

---

## 8. What Opensteer Does Not Do

- **It does not hide the browser from websites.** Opensteer runs real Chromium/Electron browsers on the person's device or Opensteer Cloud Computer (with its real Browser IP). It does not ship anti-bot stealth patches or fingerprint spoofing.
- **It does not solve CAPTCHAs or anti-bot challenges for your agent.** When a site presents a CAPTCHA or interactive human verification, leave the page open and ask the person to complete it in the shared tab.
- **It does not hand over passwords, TOTP codes, or card numbers from Opensteer Passwords.** `saved_login_request` and `card_request` return opaque `loginRef` / `cardRef` handles that fill fields on the Home's browser; raw secret values never enter tool results. (Note: once you hold a granted browser profile or shared Chrome tab, you do have full control of that browser's pages and cookies — Opensteer does not filter cookies or block specific sites inside a granted profile.)
- **It cannot undo what an agent already did.** **Stop** and **Disconnect** halt future work and abort in-flight calls, and mark interrupted effects **Uncertain** when contact is lost, but they cannot recall clicks, form submissions, emails, purchases, or commands that already executed.

### Minimal working example (handing a CAPTCHA to the person)

```ts
// 1. Notice a human verification challenge in the tab — do not try to bypass it.
// 2. Ask the person to solve it in the shared tab, then verify the page state.
const asked = await client.callTool({
  name: "ask_person",
  arguments: {
    taskId: directTaskId,
    operationKey: "captcha-1",
    title: "Complete verification on example.com",
    detail: "The site is showing a human verification check in the open tab. Please complete it, then tap Done.",
    questions: [{ question: "Have you completed the verification?" }],
  },
});

const { status, answer } = asked.structuredContent as { status: string; answer?: string };
if (status === "completed" && answer === "Done") {
  // Check the page before taking any next action
  await client.callTool({
    name: "browser_use",
    arguments: {
      taskId: directTaskId,
      tabId,
      operationKey: "verify-after-captcha-1",
      code: `const p = await openPage(${JSON.stringify(tabId)}); print(await p.url(), await p.title());`,
    },
  });
}
```
