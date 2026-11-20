# Connecting an Agent to Opensteer

This guide explains how to connect an AI agent to a person's Opensteer Home over the Model Context Protocol (MCP), work inside what the person shared, and handle approval, refusal, and stop cleanly.

A Home runs on the person's own Mac or on an Opensteer Cloud Computer and holds their browser profiles, apps, phones, plugins, and tasks. A connected agent signs in over OAuth, receives a grant and safety mode, and can be watched or stopped at any time from the person's phone.

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

Register with `POST <home-origin>/oauth/mcp/register` (JSON body, up to 16 KiB):

- `client_name`: 1–100 characters after control characters are stripped (defaults to `"MCP client"`).
- `redirect_uris`: 1–5 callback URLs. Each must be `https://` or loopback `http://` (`localhost`, `127.0.0.1`, or `[::1]`) with no `#fragment` and no embedded username or password. Custom URL schemes are dropped; if no valid URI remains, registration returns `400` with `{"error":"invalid_client_metadata"}`.

The Home returns `201 Created` with a signed, stateless `client_id` (up to 16 KiB — do not store it in a short fixed-width column) and `token_endpoint_auth_method: "none"`.

### Authorization and PKCE

Send the person's browser to `GET <home-origin>/oauth/mcp/authorize` with:

- `response_type=code`
- `client_id`: from registration
- `redirect_uri`: exact match for `https://`; for loopback `http://`, scheme, host, path, and query must match (port may differ)
- `code_challenge`: 43-character base64url SHA-256 digest of your verifier
- `code_challenge_method=S256` (`plain` is rejected)
- `state` (optional, up to 2,048 characters)
- `scope` (optional; the Home always grants `"opensteer"`)
- `resource` (optional; if sent, must equal `<home-origin>/internal/v1/mcp` or with one trailing `/`)

Consent requests expire after **10 minutes**.

### What the person sees at consent

The Home redirects the browser to `/mcp-authorization`, showing:

1. **Who is asking.** If your `redirect_uri` origin is in Opensteer's signed agent directory (fetched from the Opensteer account service), the screen shows the verified platform name and origin (or verified embedder via platform when a signed `opensteer_embedder_assertion` JWS is verified). Otherwise, it shows your self-claimed `client_name`, your redirect origin (or `"an app on this computer"` for loopback), and `"Only allow this if you started it yourself."`
2. **What it can use.** The person chooses **Choose what it can use** (specific browser profiles, shared Chrome tabs, apps or phone screens, plugins, and/or Tasks) or **Everything my own agents can do**. On a work Home, the organization's policy may forbid `everything` or Tasks.
3. **Safety mode** (capped by organization policy on a work Home) and a connection **Name**.
4. **Terms.** Access lasts 30 days, and the person can disconnect the agent at any time in **Settings → Connected agents**.

If the person allows the connection, their browser redirects to your `redirect_uri` with `code`, `iss`, and `state`. If they deny, it redirects with `error=access_denied`, `iss`, and `state`. Authorization codes expire in **60 seconds**, are single-use, and are burned on any failed exchange.

### Token exchange, transport, and server instructions

Exchange the code with `POST <home-origin>/oauth/mcp/token` (`application/x-www-form-urlencoded` or `application/json`, up to 24 KiB):

- `grant_type=authorization_code`
- `code`, `client_id`, `redirect_uri`
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

Send `Authorization: Bearer <access_token>` on every request to `<home-origin>/internal/v1/mcp`. Access tokens expire after **30 days**.

- **Server instructions:** During MCP `initialize`, the Home sends short `instructions` built from what this connection was offered. They name only the granted resource kinds and their entry points, how direct-work `taskId` and `operationId` work, and how to handle `pending`, `unknown`, and refusals. Forward them to your model.
- **Transport limits:** Up to **8** concurrent MCP connections per connected agent (`mcp-session-id` is the MCP transport header; idle transports close after 30 minutes, and every request still authenticates the live bearer token). Requests with a browser `Origin` header other than `<home-origin>` are rejected (`403`).
- **Deliberately not offered:** No refresh tokens (`grant_types_supported` is `["authorization_code"]` only; requesting `offline_access` still returns no `refresh_token`). No Client ID Metadata Documents (CIMD) — the Home never fetches a URL supplied by a connecting agent. When a token expires, run a new OAuth flow so the person re-consents.

### Disconnect

When the person clicks **Disconnect** in **Settings → Connected agents**:

- The Home revokes the connection in one transaction and deletes its stored token hash.
- Open MCP transports and browser WebSockets close, pending Requests are cancelled, and in-flight work is stopped.
- The next MCP call or request with that bearer token gets HTTP `401` and `WWW-Authenticate: Bearer resource_metadata="..."`.
- On the person's screen, the connection moves from **Stopping** to **Disconnected** once devices confirm in-flight work stopped. If contact was lost mid-effect, the person sees **Check its last action**.

### Minimal working example (Node.js + official MCP SDK)

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

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
  clientInformation() {
    return this.#client;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.#client = info;
  }
  tokens() {
    return this.#tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.#tokens = tokens;
  }
  saveCodeVerifier(v: string) {
    this.#verifier = v;
  }
  codeVerifier() {
    return this.#verifier;
  }
  async redirectToAuthorization(authorizationUrl: URL) {
    // Open authorizationUrl in the person's browser and resolve with ?code= from your callback.
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

A grant defines what a connected agent may reach on the person's Home. There are two scopes:

- **`everything`**: everything the person's own agents can do (all browser profiles, shared Chrome tabs, approved apps and phones, plugins, and Tasks). Settings tools also require `full-access`.
- **`selected`**: a boolean `tasks` flag plus up to **64** resources, each of four kinds:
  1. **Browser profile** (`browser-profile`, read-write): full control of that profile and every site signed in there. A dedicated sign-in profile used for AI accounts cannot be included.
  2. **Shared Chrome tabs** (`chrome-tabs`, read-write): tabs the person shares one at a time from Chrome using the **Opensteer tab sharing** extension ("Share this tab with Opensteer").
  3. **Mac app or phone screen** (`computer-app`, read-write): one already-approved Mac app (pinned to its device, approval record, bundle ID, and code-signing team) or one Android Agent Phone or iPhone screen. If an app's signer or approval changes, it falls out of the grant.
  4. **Plugin** (`plugin`, `read` or `read-write`): an installed plugin, a local MCP server, or a device data account (Calendar, Contacts, Reminders, Messages, iPhone Photos, or Location).

### Tools follow the grant

A tool outside your grant is neither listed by `tools/list` nor callable. The listing carries **no `outputSchema`** (results still return `structuredContent`), and `tab_open` and `tab_close` are never listed for a connected agent — open and close pages inside `browser_use` (`newPage`, `page.close()`) or over `browser_connect`.

What `tools/list` returns depends on what is shared and where the Home runs:

| Grant (with `tasks: false` unless noted) | Tools listed                                                                                                                                                                                                                        |
| :--------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One or more browser profiles** (Mac)   | 7 tools: `ask_person`, `browser_connect`, `browser_profile_list`, `browser_use`, `card_request`, `saved_login_request`, `tab_list`.                                                                                                 |
| **Shared Chrome tabs only**              | 4 tools: `ask_person`, `browser_connect`, `browser_use`, `tab_list` (no `browser_profile_list`, no saved-fill tools; `browser_use` and `browser_connect` omit `profileId` and require `tabId`).                                     |
| **Mac app or phone screen**              | `ask_person`, `computer_apps`, `computer_list`, `computer_use` (`computer_use` omits `app` on phone-only grants and requires `app` on Mac-only grants).                                                                             |
| **Plugin (`read`)**                      | `ask_person`, `local_server_list`, `plugin_call`, `plugin_describe`, `plugin_resources`, `plugin_resume`, `plugin_search`, `plugin_skills`.                                                                                         |
| **Plugin (`read-write`)**                | Same as above, plus `plugin_execute`.                                                                                                                                                                                               |
| **`tasks: true`**                        | `ask_person`, `opensteer_ai_account_list`, `opensteer_task_*`, `opensteer_request_list`, `opensteer_request_read`, `opensteer_subagent_read`, `opensteer_delegation_status`, `opensteer_delegation_wait`, `opensteer_automation_*`. |
| **`everything` + `full-access`**         | All of the above, plus Home settings tools.                                                                                                                                                                                         |

Two rules apply across all grants:

- **Opensteer Cloud Computer Homes:** `saved_login_request` and `card_request` are not offered. Saved logins and cards live on the person's own Mac.
- **No access-widening tools:** Connected agents never receive `computer_access_request`, `app_access_request`, `browser_profile_request`, `chrome_cookies_request`, or `plugin_account_request`. Tell the person what you need so they can update your grant in **Settings → Connected agents**.

If the person changes your grant or safety mode while you are connected, the Home closes your MCP transport; reconnecting gives you the updated tool list and instructions. Renaming the connection alone does not change its grant version or cancel open Requests.

### Work Homes and organization policy

On a **work Home**, the organization's policy caps the safety mode (`externalMaxMode`) and may forbid `everything`, `tasks`, or enrolling extra devices. A forbidden choice — or a work Home that is offboarding or ended — is refused with `code: "organization_not_allowed"`.

### Unshared resources look nonexistent

When a `selected` grant names a browser profile, tab, task, app, device, plugin, or `operationId` outside its grant, **the Home returns `code: "not_found"`, identical to an ID that does not exist**. Listings silently omit unshared items, `browser_profile_list` and `tab_list` omit the device's name and ID unless that device is also granted, and `computer_list` hides an iPhone's connected Mac unless that Mac is also granted.

```ts
const { tools } = await client.listTools();
const names = new Set(tools.map((t) => t.name));

if (names.has("browser_profile_list")) {
  const res = await client.callTool({ name: "browser_profile_list", arguments: {} });
  const { profiles } = res.structuredContent as {
    profiles: Array<{ id: string; name: string; home: { reachable: boolean } | null }>;
  };
  console.log("Granted profiles:", profiles);
}

// Ungranted and nonexistent targets return the same not_found error
const probe = await client.callTool({
  name: "browser_use",
  arguments: { tabId: "tab_does_not_exist", code: "print(1)" },
});
// probe.isError === true
// probe.structuredContent === {
//   error: {
//     code: "not_found",
//     message: "This browser target is unavailable or not shared with this connected agent.",
//     next: null,
//   },
// }
```

---

## 3. Access Modes

Every connected agent has an access mode ceiling chosen at consent (and editable later):

| Mode                | Tasks run by the person's own agents                                | Connected agent's direct tool calls                                                                                                                                                                                                                   |
| :------------------ | :------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval-required` | Asks the person before actions with side effects.                   | Reads run directly. Every write asks the person first.                                                                                                                                                                                                |
| `auto-accept-edits` | Edits files in its tasks without asking; asks before anything else. | Same as `approval-required`: reads run directly; every write asks the person first.                                                                                                                                                                   |
| `auto`              | Automatic review; asks the person when unsure.                      | Reads run directly. On a write, if a review model is configured, it reviews the call within 15 seconds and allows it or asks the person. Without a review model — or on timeout, error, credential-like text, URL query/fragment, or doubt — it asks. |
| `full-access`       | Never asks for routine actions.                                     | Reads and writes inside the grant run without asking.                                                                                                                                                                                                 |

Three rules always hold:

1. **Lowest ceiling wins.** Effective mode is the lowest of the connection's mode, the task's mode, and (on a work Home) the organization's policy ceiling. Lowering a task's mode ends in-flight direct work and browser connections admitted under a higher mode.
2. **Person-only tools always ask.** Even in `full-access`, `ask_person`, `saved_login_request`, and `card_request` always ask the person in **Needs you**.
3. **Settings tools** require both `everything` and `full-access`.

### Reads vs writes

- **Reads (run without asking):** `tab_list`, `browser_profile_list`, `computer_list`, `computer_apps`, `computer_use` with `readOnly: true`, `plugin_search`, `plugin_describe`, `plugin_skills`, `plugin_resources`, `local_server_list`, and `plugin_call` when every called plugin tool is read-only.
- **Writes (checked against access mode):** `browser_use`, `browser_connect`, `computer_use` (unless `readOnly: true`), `plugin_call` (when any called tool is not read-only), and `plugin_execute`.

### What "Allow once" means

When a direct write asks the person, the Home creates a Request in **Needs you** showing the target, the full script or tool call (up to 20,000 characters), and — separately as your untrusted words — the `reason` you passed. Website titles and app labels are kept separate from the Home's verified target identity.

- **Allow once** covers **only that single operation**, bound to its exact arguments, target (and its generation/route), grant version, and mode. It never widens your grant or pre-approves the next call. If the grant version, mode, or target changes before execution starts, the Home asks again.
- **Don't allow** refuses the operation with `code: "declined_by_person"` (`"The person did not allow it."`), with `taskId`, `operationId`, and `status: "refused"` beside `error`.

### Minimal working example

```ts
const args = {
  reason: "Open the orders page so I can read the tracking number.",
  code: `
    const page = await newPage("https://shop.example/orders");
    print(await page.title());
  `,
};

// Under approval-required, the Home holds up to 25 seconds for Allow once.
const first = await client.callTool({ name: "browser_use", arguments: args });
const meta = first.structuredContent as {
  status: string;
  taskId: string;
  operationId: string;
  requestId?: string;
};

if (meta.status === "pending") {
  // Tell the person a decision is waiting in Needs you, then call the same tool again
  // with the exact same arguments and the returned operationId.
  const resumed = await client.callTool({
    name: "browser_use",
    arguments: { ...args, operationId: meta.operationId },
  });
  console.log(resumed.content);
}
```

---

## 4. Tasks

Every piece of a connected agent's own direct work belongs to a listed task on the person's Home. That task is where the person watches tabs, answers **Needs you**, sees activity, and clicks **Stop**.

### Direct-work `taskId`

Direct tools (`browser_use`, `browser_connect`, `tab_list`, `computer_use`, `computer_apps`, `plugin_call`, `plugin_execute`, `plugin_resume`, `ask_person`, `saved_login_request`, `card_request`) return `taskId` (except `computer_apps({})` cached overview) and accept optional `taskId` (`plugin_resume` requires `taskId`):

- **Omit `taskId`** to continue your connection's active direct-work task, or start a new one titled after your connection's name.
- **Pass `taskId`** from an earlier direct tool result to keep working inside that task.
- A direct-work task ends on **Stop**, **Disconnect**, grant narrowing, token expiry, or **15 minutes** idle with no open Request. Open Requests expire on their own **24-hour** deadline, settling the operation atomically.
- Direct work runs even on a Home with none of the person's own agents installed.

### Direct work vs tasks run by the person's own agents

There are two kinds of task, and both use the parameter name `taskId`:

1. **Direct-work task** (your model drives `browser_use`, `browser_connect`, `computer_use`, `plugin_call`, `ask_person`, etc.).
2. **Person-agent task** (requires `tasks: true` or `everything`): call `opensteer_task_create` with a `message` (omit `aiAccountId` and `model` to use the person's defaults, or inspect choices with `opensteer_ai_account_list`). One of the person's own agents runs on their Home within your connection's mode ceiling and grant. Nothing returns automatically — wait with `opensteer_task_wait` (up to 100 seconds per call) or read with `opensteer_task_read`, always passing `taskId`.

Each tool's description says which kind of `taskId` it takes. Mixing them fails with `code: "conflict"` and explains what to pass instead:

- Passing a direct-work `taskId` to a person-agent task tool (such as `opensteer_task_send` or `opensteer_task_read`) fails with `conflict` (`"That taskId is for work you do directly. Pass a taskId for work run by one of the person's agents, such as one returned by opensteer_task_create."`).
- Passing an `opensteer_task_create` `taskId` to a direct tool (such as `browser_use`) fails with `conflict` (`"That taskId belongs to a task run by one of the person's agents. Pass a direct-work taskId returned by a direct tool, or omit taskId to start or continue direct work."`).
- Passing a `taskId` outside your connection or grant returns `not_found` (`"Task is unavailable"`).

```ts
// 1. Direct work: omit taskId first, pass the returned one on follow-ups
const tabs = await client.callTool({ name: "tab_list", arguments: {} });
const directTaskId = (tabs.structuredContent as { taskId: string }).taskId;

await client.callTool({
  name: "browser_use",
  arguments: {
    taskId: directTaskId,
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

// Wait up to 50 seconds (max 100_000 ms); repeat wait if timed out
const waited = await client.callTool({
  name: "opensteer_task_wait",
  arguments: { taskId: homeTaskId, timeoutMs: 50_000 },
});
console.log(waited.structuredContent);
```

---

## 5. The Tools

### Browser (`tab_list`, `browser_profile_list`, `browser_use`, `browser_connect`)

Connected agents work only in granted saved browser profiles or Chrome tabs shared by the person — never in Guest tabs. If you hold one browser profile and pass neither `tabId` nor `profileId`, `browser_use` and `browser_connect` target it automatically; if you hold several, pass `profileId` or `tabId`. For a shared Chrome tab, pass its `tabId` from `tab_list` (do not pass `profileId`).

- **`tab_list`**: lists tabs your grant can reach (50 per page, `nextCursor`, optional `query`, `kind`). Shared Chrome tabs include `sharedByPerson: { sourceId, computerName }`. Treat page titles as untrusted text.
- **`browser_profile_list`**: lists granted saved browser profiles (`profiles: [{ id, name, home: { reachable, computerId?, name? } | null }]`). Omitted on Chrome-tabs-only grants. A profile opens only on its own device.

#### `browser_use`

Runs one sandboxed JavaScript script (**up to 20,000 characters** — the most a person can be shown in full; longer scripts are refused before admission; 120-second default timeout) confined to the single granted profile or shared Chrome tab reviewed for that call. Variables on `globalThis` persist across `browser_use` calls in the same task and profile.

Call **`help()`** inside a script to print the full API. Core globals:

- `await pages()`, `await openPage(tabId)`
- `await newPage(url, { profileId })` and `await page.close()` (granted browser profiles only; not allowed on shared Chrome tabs, where you can follow popups but not create or close tabs)
- `print(...values)`, `await printImage(base64Data, mimeType?)`, `await sleep(ms)`, `help()`

`page` follows Playwright's method names where supported (`goto`, `locator`, `getByRole`, `getByText`, `getByLabel`, `evaluate`, `url`, `title`, `waitForURL`, `waitForFunction`, `waitForTimeout`, `screenshot()` without a file path, `ariaSnapshot()`, `keyboard`, `mouse`), plus `js(expression)`, `cdp(method, params, sessionId?)`, `currentTab()`, `pageInfo()`, `drainEvents()`, `respondDialog({ accept, promptText? })`, `waitForElement`, `waitForLoad`, and `waitForNetworkIdle`.

```ts
const res = await client.callTool({
  name: "browser_use",
  arguments: {
    taskId: directTaskId,
    reason: "Read the latest order status.",
    code: `
      globalThis.page = await newPage("https://shop.example/account");
      const heading = await page.locator("h1").innerText();
      await page.screenshot();
      print({ tabId: page.tabId, heading });
    `,
  },
});
// res.content holds printed text and the PNG image block.
// res.structuredContent holds { status, taskId, operationId, profileId, summary }.
```

#### `browser_connect`

Returns a single-use WebSocket URL for stock Playwright, Puppeteer, or a raw Chrome DevTools Protocol (CDP) client:

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

- **Connect within 1 minute.** The single-use link in `endpoint` expires 60 seconds after issue.
- **Modes.** Follow the returned `connect` line (or branch on `mode`):
  - `"whole-context"`: granted on a saved profile when your task is the sole live holder and the browser supports it; allows context-wide cookies, permissions, and workers. Connect with `chromium.connectOverCDP(endpoint)`.
  - `"session"` (the tool's mode name for page-scoped access): used for shared Chrome tabs and shared profiles. Context-wide cookie/permission commands are refused; page-scoped commands work on owned pages and their popups. Connect with `chromium.connectOverCDP(endpoint, { noDefaults: true })`.
- **Playwright and raw CDP:** Stock Playwright works, including `browser.newBrowserCDPSession()` and `context.newCDPSession(page)`, which open a confined alias of the connection's virtual root with the same mode, lease, target list, and command restrictions. Nested browser aliases, context creation/disposal, and browser shutdown are refused. Limits: 8 MiB per JSON frame, 128 in-flight messages, up to 4 live CDP connections per task.
- **No saved-login or card fill over `browser_connect`:** `Opensteer.fillLogin` and `Opensteer.fillCard` are refused over `browser_connect` (including via `context.newCDPSession(page)`). Fill them inside `browser_use` instead.
- **10-minute interval and renewal:** Each connection lasts up to **10 minutes** (`expiresAt`) and ends early on **Stop**, **Disconnect**, a narrowed grant, a lowered task mode, or when the person stops sharing the Chrome tab. To renew on the same tab, make a new `browser_connect` call (do not pass the old `operationId` or reuse an old `operationKey`) with the returned `tabId` — omitting `tabId` on a profile opens a new `about:blank` tab. Replaying a finished `browser_connect` returns the stored receipt and never issues a second endpoint.

```ts
import { chromium } from "playwright-core";

const reply = await client.callTool({
  name: "browser_connect",
  arguments: { taskId: directTaskId, reason: "Inspect the order history table." },
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

// To renew on the same tab, call browser_connect again with { taskId: directTaskId, tabId }.
```

### Apps and phones (`computer_apps`, `computer_list`, `computer_use`)

- **`computer_apps`**: call with `{}` for cached discovery of granted Macs (with their granted apps) and phone screens, each showing `access` (`"read"` or `"read-write"`) or `blocked`. Pass `computerId` (and optional `query`, `taskId`) to list installed apps on a granted phone (returning opaque `appId` for `launch`) or apps on a Mac; live lookups run as recorded read operations so Stop or grant narrowing cancels them.
- **`computer_list`**: lists visible computers and phones with `online`, `asleep`, and `phoneDisplay` (`control`, `input`, `navigationButtons`, `actions`). On a `selected` grant, an iPhone hides its connected Mac unless that Mac is also granted.
- **`computer_use`**: runs sandboxed JavaScript (**up to 20,000 characters**) against the single Mac app or phone screen named in the arguments:
  - Pass `computerId` (required) and `app` (Mac app name or `bundleId`; omitted on phone-only grants, required on Mac-only grants).
  - Inside `code`, **`await target` is already bound** to that Mac app or phone screen, and **`help()`** prints the full API. (`tab()` is not available to connected agents.)
  - Set `readOnly: true` to observe without asking. Observation mode blocks all input/mutations and **can never start a Mac app or open a window**.
  - Work in flight ends if the device goes to sleep, is stopped, the task is stopped, the mode is lowered, the grant is narrowed, or the agent is disconnected.

```ts
const inv = await client.callTool({ name: "computer_apps", arguments: {} });
const { computers } = inv.structuredContent as {
  computers: Array<{ computerId: string; apps: Array<{ name: string; bundleId: string }> }>;
};
const mac = computers[0]!;
const notes = mac.apps[0]!;

await client.callTool({
  name: "computer_use",
  arguments: {
    taskId: directTaskId,
    computerId: mac.computerId,
    app: notes.bundleId,
    readOnly: true,
    code: `
      const win = await (await target).window();
      const snap = await win.observe({ screenshot: true });
      print(win.title, snap.elements?.length ?? 0);
    `,
  },
});
```

### Plugins (`plugin_search`, `plugin_describe`, `plugin_skills`, `plugin_resources`, `local_server_list`, `plugin_call`, `plugin_execute`, `plugin_resume`)

Installed plugins, local MCP servers, and approved device data apps (Calendar, Contacts, Reminders, Messages, iPhone Photos and Location) appear under `tools.<namespace>.<tool>`.

- **Discovery is published or cached only:** `plugin_search`, `plugin_describe`, `plugin_skills`, `plugin_resources`, and `local_server_list` serve published or cached material only and never run a plugin's live code with the person's linked account. Tools outside your access level (`read` vs `read-write`) show `blocked: { code: "access_denied", ... }`.
- **Live execution is reviewed:** `plugin_call` (one `{ path, input }` or an array for **one plugin per operation**, canonical JSON up to 20,000 characters) and `plugin_execute` (JavaScript up to 20,000 characters with required `namespace`, offered only when a `read-write` plugin is granted) run through the direct-operation pipeline. Read-only `plugin_call` runs as a read; any write or `plugin_execute` follows your access mode.
- **Plugin input pauses (`plugin_resume`):** If a plugin itself pauses to ask the person for input in **Needs you**, `plugin_call` / `plugin_execute` returns `status: "pending"` **with an `executionId`**. Wait until the person answers, then call `plugin_resume({ executionId, taskId })` (calling before they answer returns `conflict`).
- **Lost plugin engine:** If the plugin engine stops or loses contact after a write is sent, the operation yields `unknown` (`status: "unknown"` / `outcome_unknown`) — check current state before acting again.

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
    calls: { path: firstTool.path, input: { days: 3 } },
  },
});
const payload = called.structuredContent as {
  status: string;
  executionId?: string;
  taskId: string;
};

if (payload.status === "pending" && payload.executionId) {
  // Plugin asked the person for input in Needs you; resume after they answer.
  const resumed = await client.callTool({
    name: "plugin_resume",
    arguments: { taskId: payload.taskId, executionId: payload.executionId },
  });
  console.log(resumed.structuredContent);
}
```

### Asking the person (`ask_person`)

Ask the person a question only they can answer (such as confirming they finished a second factor or CAPTCHA in the shared tab, or picking between options):

- `questions` must have **exactly 1** item, single choice only (no `multiSelect`, no free-text input so secrets are never typed into chat). Pass `options` (2–6 choices), or omit `options` for `["Done", "Unable to do it"]`.
- The person sees your connection name, task title, `"Enter passwords and codes only in the page."`, and your `title` and `detail` quoted as your words.
- Returns `{ status: "completed", taskId, operationId, answer: "<chosen label>" }`.

```ts
await client.callTool({
  name: "ask_person",
  arguments: {
    taskId: directTaskId,
    title: "Finish sign-in in the open tab",
    detail: "Please complete the verification code in the browser tab, then tap Done.",
    questions: [{ question: "Did you finish the verification?" }],
  },
});
```

### Saved logins and cards (`saved_login_request`, `card_request`)

Offered only on a **Mac Home** (not on an Opensteer Cloud Computer, where saved logins and cards do not live) and only when a **browser profile** is granted (not on Chrome-tabs-only grants).

- Requires a live `tabId` in a granted saved browser profile on the person's own Mac's Opensteer browser, **already open on `site`**.
- **Always asks the person** in **Needs you**, even in `full-access`, and is never remembered across calls for a connected agent.
- **What you receive and what is protected:** Tool results return only an opaque reference (`{ status: "completed", taskId, operationId, loginStatus: "ready", loginRef: "lgn_..." }` or `cardStatus: "ready", cardRef: "crd_..."`, or `"declined"` / `"unavailable"` with `reason`). Opensteer fills the saved login or card into the page and does not return the value in tool results. However, an agent controlling that page can still read what is on the page after a fill — **never read back, print, log, copy, or store a filled value**. Approval controls which login or card is released, to which site, each time.
- **How to fill (`browser_use` only):** Filling is not available over `browser_connect`. In `browser_use` on that same tab, focus each field and call:
  - `await page.cdp("Opensteer.fillLogin", { loginRef, field })` (`"username"`, `"password"`, or `"code"`).
  - `await page.cdp("Opensteer.fillCard", { cardRef, field })` (`"number"`, `"expiry"`, `"expiry-month"`, `"expiry-year"`, `"cvc"`, `"name"`, or `"billing-postal-code"`).
  - Check `result.status === "filled"` (other statuses: `"no-field"`, `"wrong-site"`, `"stale"`, `"expired"`, `"denied"`, `"unavailable"`).
- **Lifetime:** References are bound to that task, tab generation, and site; expire after 60 minutes (logins) or 30 minutes (cards); and stop working immediately on Stop, Disconnect, or a grant change. Card approval covers filling only, not a purchase.

```ts
const login = await client.callTool({
  name: "saved_login_request",
  arguments: {
    taskId: directTaskId,
    tabId,
    site: "https://app.example",
    reason: "Sign in to download the invoice.",
  },
});
const { loginStatus, loginRef } = login.structuredContent as {
  loginStatus?: string;
  loginRef?: string;
};

if (loginStatus === "ready" && loginRef) {
  await client.callTool({
    name: "browser_use",
    arguments: {
      taskId: directTaskId,
      tabId,
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

### Tasks run by the person's own agents (`opensteer_task_*`, `opensteer_request_*`, `opensteer_automation_*`)

Available when the grant includes `tasks: true` or `everything`:

- **AI accounts & creation:** `opensteer_ai_account_list`, `opensteer_task_create` (omit `aiAccountId` and `model` to use the person's defaults).
- **Control:** `opensteer_task_send` (`delivery: "report" | "queue" | "steer"`), `opensteer_task_interrupt`, `opensteer_task_resume`, `opensteer_task_update`, `opensteer_task_configure`, `opensteer_task_queue`.
- **Read & wait:** `opensteer_task_list`, `opensteer_task_read` (`view: "messages"` or `"activity"`), `opensteer_task_wait` (max `timeoutMs: 100000`), `opensteer_subagent_read`, `opensteer_delegation_status`, `opensteer_delegation_wait`, `opensteer_request_list`, `opensteer_request_read`.
- **Automations:** `opensteer_automation_list`, `opensteer_automation_read`, `opensteer_automation_create` (requires `full-access` and explicit `taskId`), `opensteer_automation_update`, `opensteer_automation_control`.

With `selected: { tasks: true }`, listings show only tasks created by your connection. With `everything`, you also see the person's own tasks (and in `full-access`, Home settings tools).

---

## 6. Results

Every direct tool call is recorded on the Home before review or execution. Its receipt appears in `structuredContent` (and in `content[0].text` JSON for record tools; for `browser_use` and `computer_use`, `content` holds the script's printed text and images while `structuredContent` holds the receipt):

| Field         | Meaning                                                                                                                                      |
| :------------ | :------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`      | `"completed"`, `"pending"`, `"failed"`, or `"unknown"` (`plugin_call` / `plugin_execute` / `plugin_resume` may also return plugin statuses). |
| `taskId`      | Direct-work task ID (`thr_...`). Pass on follow-up direct calls.                                                                             |
| `operationId` | Durable receipt ID (`aop_...`). Pass with identical arguments to continue a `pending` call.                                                  |
| `requestId`   | Present when `status === "pending"` (`req_...`, or `null` if not yet attached).                                                              |
| `next`        | Plain-English next step when `status !== "completed"`.                                                                                       |

### Continuing a `pending` call

When an operation needs the person (approval, `ask_person`, `saved_login_request`, or `card_request`), the Home holds the call open for up to **25 seconds**. If the person has not answered yet, it returns:

```json
{
  "status": "pending",
  "taskId": "thr_...",
  "operationId": "aop_...",
  "requestId": "req_...",
  "next": "Waiting on the person in Needs you. Do not poll. After they answer, call the same tool with the same arguments and this operationId."
}
```

- **Continue with `operationId`:** Call the exact same tool again with the exact same arguments and the returned `operationId` (you do not need to invent an `operationKey`). `operationKey` remains optional for your own idempotent retries if a network drop prevents you from receiving `operationId`.
- **Repeats are safe:** Repeating a finished operation (by `operationId` or `operationKey`) returns the stored receipt — even after the task idled out or the Home restarted — and never runs the effect twice or issues a second `browser_connect` endpoint. Reusing an `operationId` or `operationKey` with different arguments or a different `taskId` fails with `conflict`.
- **Do not poll tightly:** Tell the person a decision is waiting in **Needs you**, or back off before checking again (each call waits up to 25 seconds).
- **Plugin input exception:** When `plugin_call` or `plugin_execute` returns `status: "pending"` with an `executionId`, resume with `plugin_resume({ executionId, taskId })` after the person answers, not by repeating `plugin_call`.

### Handling `unknown` (**Uncertain**)

If contact with a device or plugin engine is lost mid-effect, the Home restarts in flight, or work in flight is ended by **Stop**, **Disconnect**, a narrowed grant, or a lowered task mode, the Home records the operation as **Uncertain** (`status: "unknown"`, or a failure carrying `status: "unknown"` / `outcome_unknown`) and never retries it on its own. **Never blindly repeat an uncertain effect** — run a safe read first to check the current state.

### Handling the person's Stop

When the person clicks **Stop** on your task:

1. Any in-flight call aborts with `isError: true`, `error.code: "stopped_by_person"`, `status: "unknown"`, `taskId`, `operationId`, and `error.next` telling you part of it may have happened — check current state before acting again.
2. Any call passing the stopped `taskId` is refused with `stopped_by_person` (`"The person stopped this work. Do not continue it; ask before starting again."`).
3. The **first** call omitting `taskId` after Stop is also refused once with `stopped_by_person` so an agent cannot silently ignore Stop. Only start a new task after the person asks you to continue.

```ts
async function runDirect(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) {
    const body = res.structuredContent as {
      error: { code: string; message: string; next: string | null };
      status?: "refused" | "failed" | "unknown";
      taskId?: string;
      operationId?: string;
    };
    if (body.error.code === "stopped_by_person") {
      return { outcome: "stopped" as const, uncertain: body.status === "unknown", body };
    }
    if (body.error.code === "declined_by_person") {
      return { outcome: "declined" as const, body };
    }
    if (body.error.code === "outcome_unknown" || body.status === "unknown") {
      return { outcome: "uncertain" as const, body };
    }
    throw new Error(`${body.error.code}: ${body.error.message}`);
  }

  const body = (res.structuredContent ?? {}) as {
    status?: string;
    taskId?: string;
    operationId?: string;
    requestId?: string | null;
    next?: string;
  };
  if (body.status === "pending") {
    return {
      outcome: "pending" as const,
      operationId: body.operationId,
      taskId: body.taskId,
      next: body.next,
    };
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

Tool-level failures return `isError: true` with identical JSON in `structuredContent` and `content[0].text`. When a refusal or failure occurs after an operation was admitted, `taskId`, `operationId`, and `status` (`"refused"`, `"failed"`, or `"unknown"`) appear beside `error`:

```json
{
  "error": {
    "code": "stopped_by_person",
    "message": "The person stopped this work.",
    "next": "Part of it may have happened. Check the current state before doing anything else."
  },
  "taskId": "thr_...",
  "operationId": "aop_...",
  "status": "unknown"
}
```

- `error.code`: stable machine-readable code.
- `error.message`: plain-English explanation.
- `error.next`: next step, or `null` (never points to a tool not in your listing).
- `error.device`: optional `{ id, name }`, present only on `computer_asleep` and `computer_stopped` and only when your grant allows knowing that device.

Authentication failures (revoked, expired, or invalid bearer token) are rejected at HTTP with `401` and `WWW-Authenticate: Bearer resource_metadata="..."`.

### Refusal codes and what to do

| Code / signal                                             | Meaning                                                                                                 | What your agent should do                                                                                              |
| :-------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------- |
| `declined_by_person`                                      | The person clicked **Don't allow** on this action.                                                      | Respect it; do not retry the same action.                                                                              |
| `stopped_by_person`                                       | The person clicked **Stop** on this task. If `status === "unknown"`, work was interrupted mid-flight.   | Stop this task immediately. If `status === "unknown"`, check state before any later action. Ask before starting again. |
| `access_changed`                                          | Grant narrowed, task mode lowered, Request expired, or access ended in flight (`status === "unknown"`). | If `status === "unknown"`, check current state first. Reconnect if your transport closed to read the new grant.        |
| `organization_not_allowed`                                | Work Home organization policy forbids this action, or the work Home has ended.                          | Do not retry. Tell the person their organization's policy does not allow it.                                           |
| `not_found`                                               | Resource is outside your grant or does not exist (indistinguishable on purpose).                        | Do not probe other IDs. Tell the person if you need something shared in **Settings → Connected agents**.               |
| `computer_stopped` (**Stopped on this Mac** / **{name}**) | The person turned on Stop on that device.                                                               | Do not retry in a loop. Wait until they resume agents there, or do other work.                                         |
| `computer_asleep` / `computer_offline`                    | The device is asleep or offline.                                                                        | Wait until it wakes or reconnects; never substitute another profile or device.                                         |
| `access_denied`                                           | Another refusal (for example, a device switch is off or a target is read-only).                         | Do not retry. Tell the person what is unavailable.                                                                     |
| HTTP `401` / WebSocket `1008`                             | Disconnected or 30-day token expired.                                                                   | Discard the bearer token and stop calling the Home. Re-run OAuth only if the person asks to reconnect.                 |

Other tool error codes: `invalid_input`, `conflict`, `outcome_unknown`, `unsupported`, `port_in_use`, `resource_exhausted`, `timeout`, `plugin_unavailable`, `catalog_unavailable`, `internal_error`.

```ts
function classifyFailure(
  err: unknown,
): "reauth" | "wait" | "check-state" | "stop" | "declined" | "report" {
  if (err instanceof UnauthorizedError) return "reauth";

  const failure = err as { error?: { code?: string }; status?: string };
  if (failure.status === "unknown") return "check-state";

  switch (failure.error?.code) {
    case "stopped_by_person":
      return "stop";
    case "declined_by_person":
      return "declined";
    case "outcome_unknown":
      return "check-state";
    case "computer_asleep":
    case "computer_offline":
    case "computer_stopped":
      return "wait";
    case "access_changed":
    case "organization_not_allowed":
    case "not_found":
    case "access_denied":
    default:
      return "report";
  }
}
```

---

## 8. What Opensteer Does Not Do

- **It does not hide the browser from websites.** Opensteer runs real Chromium/Electron browsers on the person's device or Opensteer Cloud Computer (with its real Browser IP), with no anti-bot stealth patches or fingerprint spoofing.
- **It does not solve CAPTCHAs or anti-bot challenges.** Leave the page open and ask the person to complete it in the shared tab with `ask_person`.
- **It cannot keep a filled secret hidden from an agent that controls the page.** Opensteer fills saved logins and cards into the page and does not return them in tool results, but once filled, page scripts and an agent working in that page can read what is on the page. Never read a filled value back, print it, or store it. Inside a granted browser profile or shared Chrome tab, your agent also has full control of that browser's pages and cookies.
- **It cannot undo what an agent already did.** **Stop** and **Disconnect** halt future work, abort in-flight calls, and mark interrupted effects **Uncertain**, but cannot recall clicks, form submissions, emails, purchases, or commands that already ran.

```ts
// Hand a CAPTCHA to the person, then verify the page before acting again.
const asked = await client.callTool({
  name: "ask_person",
  arguments: {
    taskId: directTaskId,
    title: "Complete verification on example.com",
    detail:
      "The site is showing a human verification check in the open tab. Please complete it, then tap Done.",
    questions: [{ question: "Have you completed the verification?" }],
  },
});

const { status, answer } = asked.structuredContent as { status: string; answer?: string };
if (status === "completed" && answer === "Done") {
  await client.callTool({
    name: "browser_use",
    arguments: {
      taskId: directTaskId,
      tabId,
      code: `const p = await openPage(${JSON.stringify(tabId)}); print(await p.url(), await p.title());`,
    },
  });
}
```
