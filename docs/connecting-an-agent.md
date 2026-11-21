# Connecting an Agent to Opensteer

This guide explains how to connect an AI agent to a person's Opensteer Home over the Model Context Protocol (MCP), act inside what the person shared, and handle approval, refusal, and stop cleanly.

A Home runs on the person's own Mac, on a Linux server, or on an Opensteer Cloud Computer, holding their browser profiles, apps, phones, plugins, and tasks. A connected agent signs in over OAuth, receives a grant and safety mode, and can be watched or stopped at any time from the person's phone.

---

## 1. Connecting

A Home serves MCP over Streamable HTTP at one endpoint:

```text
<home-origin>/internal/v1/mcp
```

For a Mac Home on loopback, `<home-origin>` is `http://127.0.0.1:<port>` (or `http://localhost:<port>`). For a remote Home or an Opensteer Cloud Computer, `<home-origin>` is its `https://` origin.

### Discovery and OAuth

Send an unauthenticated `POST` to `<home-origin>/internal/v1/mcp`. The Home replies with HTTP `401` and:

```http
WWW-Authenticate: Bearer resource_metadata="<home-origin>/.well-known/oauth-protected-resource/internal/v1/mcp"
```

Metadata endpoints (served with `Cache-Control: no-store` and `Access-Control-Allow-Origin: *`):

- **Protected-resource metadata:** `GET /.well-known/oauth-protected-resource/internal/v1/mcp` (and `/.well-known/oauth-protected-resource`) — returns `resource` (`<home-origin>/internal/v1/mcp`), `authorization_servers` (`["<home-origin>/oauth/mcp"]`), `bearer_methods_supported` (`["header"]`), and `scopes_supported` (`["opensteer"]`).
- **Authorization-server metadata:** `GET /.well-known/oauth-authorization-server/oauth/mcp` (and `/.well-known/oauth-authorization-server`) — `issuer` `<home-origin>/oauth/mcp`, endpoints `/authorize`, `/token`, `/register`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, `authorization_response_iss_parameter_supported: true`.

#### Registration (`POST <home-origin>/oauth/mcp/register`)

JSON body up to 16 KiB:

- `client_name`: 1–100 characters after control characters are stripped (defaults to `"MCP client"`).
- `redirect_uris`: 1–5 callback URLs, each `https://` or loopback `http://` (`localhost`, `127.0.0.1`, `[::1]`) with no `#fragment` and no embedded credentials. Invalid or custom schemes are dropped; if none remain, registration returns `400` (`{"error":"invalid_client_metadata"}`).

Returns `201 Created` with a signed, stateless `client_id` (up to **16 KiB** — do not store it in a short fixed-width column) and `token_endpoint_auth_method: "none"`.

#### Authorization (`GET <home-origin>/oauth/mcp/authorize`)

Required query parameters: `response_type=code`, `client_id`, `redirect_uri` (exact match for `https://`; for loopback `http://`, port may differ), `code_challenge` (43-character base64url SHA-256), `code_challenge_method=S256`. Optional: `state` (up to 2,048 chars), `scope` (always granted `"opensteer"`), `resource` (must equal `<home-origin>/internal/v1/mcp` or with one trailing `/`). Consent requests expire in **10 minutes**.

The browser redirects to `/mcp-authorization`, where the person sees:

1. **Who is asking.** If your `redirect_uri` origin is in Opensteer's signed agent directory (from the Opensteer account service), it shows the verified name and origin (or verified embedder via platform with a verified `opensteer_embedder_assertion` JWS). Otherwise it shows your self-claimed `client_name`, your redirect origin (or `"an app on this computer"` for loopback), and `"Only allow this if you started it yourself."`
2. **What it can use.** **Choose what it can use** (specific browser profiles, shared Chrome tabs, apps or phone screens, plugins, and/or Tasks) or **Everything my own agents can do**. On a work Home, organization policy may forbid `everything` or Tasks.
3. **Safety mode** (capped by organization policy on a work Home) and connection **Name**.
4. **Terms.** Access lasts 30 days and can be ended any time in **Settings → Connected agents**.

Approval redirects to `redirect_uri` with `code`, `iss`, and `state`; denial redirects with `error=access_denied`, `iss`, and `state`. Codes expire in **60 seconds**, are single-use, and are burned on any failed exchange.

#### Token exchange (`POST <home-origin>/oauth/mcp/token`)

Send `application/x-www-form-urlencoded` or `application/json` (up to 24 KiB) with `grant_type=authorization_code`, `code`, `client_id`, `redirect_uri`, `code_verifier` (43–128 characters matching `[A-Za-z0-9._~-]`), and optional `resource`. Returns:

```json
{
  "access_token": "ost_mcp_...",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "scope": "opensteer"
}
```

Send `Authorization: Bearer <access_token>` on every request to `<home-origin>/internal/v1/mcp`. Access tokens expire after **30 days**.

- **Server instructions:** During MCP `initialize`, the Home sends short `instructions` built from what this connection was offered (granted kinds, entry points, `taskId`, `operationId`, `pending`, `unknown`, and refusals). Pass them to your model.
- **Transport limits:** Up to **8** concurrent MCP connections per connected agent (`mcp-session-id` is the MCP transport header; idle transports close after 30 minutes, and every request still checks the live bearer token). Browser `Origin` headers other than `<home-origin>` are rejected (`403`).
- **Not offered:** No refresh tokens (requesting `offline_access` returns no `refresh_token`; re-run OAuth when the 30-day token expires) and no Client ID Metadata Documents (CIMD).

### Disconnect

When the person clicks **Disconnect** in **Settings → Connected agents**, the Home revokes the connection in one transaction, deletes its token hash, closes open MCP transports and browser WebSockets, cancels pending Requests, and stops in-flight work. The next call gets HTTP `401` with `WWW-Authenticate`. On the person's screen, the connection moves from **Stopping** to **Disconnected** once devices confirm work stopped, or shows **Check its last action** if contact was lost mid-effect.

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

A grant defines what a connected agent may reach on the person's Home:

- **`everything`**: everything the person's own agents can do. Settings tools also require `full-access`.
- **`selected`**: a boolean `tasks` flag plus up to **64** resources of four kinds:
  1. **Browser profile** (`browser-profile`, read-write): full control of that profile's cookies and signed-in sites. Dedicated sign-in profiles for AI accounts cannot be selected.
  2. **Shared Chrome tabs** (`chrome-tabs`, read-write): tabs shared one at a time from Chrome via the **Opensteer tab sharing** extension ("Share this tab with Opensteer").
  3. **Mac app or phone screen** (`computer-app`, read-write): one approved Mac app (pinned to device, approval record, bundle ID, and signing team) or one Android Agent Phone or iPhone screen. If an app's signer or approval changes, it falls out of the grant.
  4. **Plugin** (`plugin`, `read` or `read-write`): an installed plugin, local MCP server, or device data account (Calendar, Contacts, Reminders, Messages, iPhone Photos, or Location).

### Tools follow the grant

Tools outside your grant are neither listed by `tools/list` nor callable. Connection listings omit `outputSchema` (results still return `structuredContent`), and `tab_open` and `tab_close` are never listed — open and close pages inside `browser_use` (`newPage`, `page.close()`) or over `browser_connect`.

| Grant (`tasks: false` unless noted)                 | Tools listed                                                                                                                                                                                                                        |
| :-------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Browser profile(s)** (hosting device w/Passwords) | **7 tools** (~4.5 KB): `ask_person`, `browser_connect`, `browser_profile_list`, `browser_use`, `card_request`, `saved_login_request`, `tab_list`.                                                                                   |
| **Shared Chrome tabs only**                         | **4 tools**: `ask_person`, `browser_connect`, `browser_use`, `tab_list` (`browser_use` and `browser_connect` omit `profileId` and require `tabId`).                                                                                 |
| **Mac app or phone screen**                         | `ask_person`, `computer_apps`, `computer_list`, `computer_use` (`computer_use` omits `app` on phone-only grants and requires `app` on Mac-only grants).                                                                             |
| **Plugin (`read`)**                                 | `ask_person`, `local_server_list`, `plugin_call`, `plugin_describe`, `plugin_resources`, `plugin_resume`, `plugin_search`, `plugin_skills`.                                                                                         |
| **Plugin (`read-write`)**                           | Same as above, plus `plugin_execute`.                                                                                                                                                                                               |
| **`tasks: true`**                                   | `ask_person`, `opensteer_ai_account_list`, `opensteer_task_*`, `opensteer_request_list`, `opensteer_request_read`, `opensteer_subagent_read`, `opensteer_delegation_status`, `opensteer_delegation_wait`, `opensteer_automation_*`. |
| **`everything` + `full-access`**                    | **52 tools** (~25 KB): all of the above, plus Home settings tools.                                                                                                                                                                  |

- **Passwords tools (`saved_login_request`, `card_request`):** Listed only when the hosting device supports Opensteer Passwords (a personal Mac Home). Omitted on Opensteer Cloud Computers and self-hosted Linux Homes.
- **No access-widening tools:** Connected agents never receive `computer_access_request`, `app_access_request`, `browser_profile_request`, `chrome_cookies_request`, or `plugin_account_request`. Ask the person to adjust your grant in **Settings → Connected agents**.
- **Live changes:** Editing your grant or safety mode closes your MCP transport; reconnecting returns the updated tool list and instructions. Renaming the connection alone does not change its grant version or cancel open Requests.

### Work Homes and organization policy

On a **work Home**, organization policy caps the safety mode (`externalMaxMode`) and may forbid `everything`, `tasks`, or enrolling extra devices. A forbidden choice — or an offboarding/ended work Home — fails with `code: "organization_not_allowed"`.

### Unshared resources look nonexistent

Naming a browser profile, tab, task, app, device, plugin, or `operationId` outside a `selected` grant returns `code: "not_found"`, identical to a nonexistent ID. Listings silently omit unshared items; `browser_profile_list` and `tab_list` omit the device's name and ID unless that device is also granted; `computer_list` hides an iPhone's connected Mac unless that Mac is also granted.

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

// Ungranted and nonexistent targets return the exact same not_found error
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

Every connected agent has a mode ceiling chosen at consent (editable later):

| Mode                | Tasks run by the person's own agents                                | Connected agent's direct tool calls                                                                                                                                                                                                   |
| :------------------ | :------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `approval-required` | Asks the person before actions with side effects.                   | Reads run directly. Every write asks the person first.                                                                                                                                                                                |
| `auto-accept-edits` | Edits files in its tasks without asking; asks before anything else. | Same as `approval-required`: reads run directly; every write asks the person first.                                                                                                                                                   |
| `auto`              | Automatic review; asks the person when unsure.                      | Reads run directly. Writes ask the person unless the Home has a review model configured (`OPENSTEER_AGENT_REVIEW_MODEL`), which has 15 seconds to allow low-risk calls and asks on credential-like inputs, errors, timeout, or doubt. |
| `full-access`       | Never asks for routine actions.                                     | Reads and writes inside the grant run without asking.                                                                                                                                                                                 |

In `auto` mode with a review model, ordinary URL query strings (such as `?page=2`) are reviewed normally, while credential keywords, private keys, credential-named query/fragment parameters (`token`, `key`, `secret`, `password`, `auth`, `sig`, `session`, `code`, `otp`), or high-entropy opaque parameter values (24+ characters) always fall back to asking the person.

Three rules always hold:

1. **Lowest ceiling wins.** Effective mode is the lowest of connection mode, task mode, and (on a work Home) organization policy. Lowering a task's mode ends in-flight direct work and browser connections admitted under a higher mode.
2. **Person-only tools always ask.** Even in `full-access`, `ask_person`, `saved_login_request`, and `card_request` always ask the person in **Needs you**.
3. **Settings tools** require both `everything` and `full-access`.

### Reads vs writes

- **Reads (run without asking):** `tab_list`, `browser_profile_list`, `computer_list`, `computer_apps`, `computer_use` with `readOnly: true`, `plugin_search`, `plugin_describe`, `plugin_skills`, `plugin_resources`, `local_server_list`, and `plugin_call` when every called plugin tool is read-only.
- **Writes (checked against access mode):** `browser_use`, `browser_connect`, `computer_use` (unless `readOnly: true`), `plugin_call` (when any called tool is not read-only), and `plugin_execute`.

### What "Allow once" means

When a direct write asks the person, the Request in **Needs you** shows the Home's verified target, the full script or tool call (**up to 18,956 characters** across connected script/call tools, leaving room for the Home's header lines so the person can always read the entire payload), and your `reason` separately as untrusted words. Page titles and app labels are kept separate from the verified target.

- **Allow once** covers **only that single operation**, bound to its exact arguments, target (and generation/route), grant version, and mode. It never widens your grant or pre-approves the next call.
- **Don't allow** refuses with `code: "declined_by_person"` (`"The person did not allow it."`), with `taskId`, `operationId`, and `status: "refused"` beside `error`.

---

## 4. Tasks

Direct work belongs to a listed task on the person's Home where the person watches tabs, answers **Needs you**, sees activity, and clicks **Stop**.

### Direct-work `taskId`

Direct tools (`tab_list`, `browser_use`, `browser_connect`, `computer_use`, `computer_apps` on live lookups, `plugin_call`, `plugin_execute`, `plugin_resume`, `ask_person`, `saved_login_request`, `card_request`) return `taskId` and accept optional `taskId` (`plugin_resume` requires `taskId`):

- **Omit `taskId`** to continue your active direct-work task or start one titled after your connection's name.
- **Pass `taskId`** from an earlier direct result to keep working inside that task.
- A direct-work task ends on **Stop**, **Disconnect**, grant narrowing, token expiry, or **15 minutes** idle with no open Request. Open Requests expire on their own **24-hour** deadline, settling the operation atomically.
- Direct work runs even on a Home with none of the person's own agents installed.

### Two kinds of `taskId`

Both direct-work tasks and tasks run by the person's own agents (`opensteer_task_create`, requiring `tasks: true` or `everything`) use the parameter name `taskId`. For `opensteer_task_create`, omit `aiAccountId` and `model` to use the person's defaults, or inspect choices with `opensteer_ai_account_list`; wait with `opensteer_task_wait` (up to 100 seconds per call) or read with `opensteer_task_read`, always passing `taskId`.

Each tool's description states which kind of `taskId` it takes. Crossing them returns `conflict`:

- Direct-work `taskId` passed to a person-agent task tool (e.g. `opensteer_task_send`): `"That taskId is for work you do directly. Pass a taskId for work run by one of the person's agents, such as one returned by opensteer_task_create."`
- Person-agent `taskId` passed to a direct tool (e.g. `browser_use`): `"That taskId belongs to a task run by one of the person's agents. Pass a direct-work taskId returned by a direct tool, or omit taskId to start or continue direct work."`
- Any `taskId` outside your connection or grant returns `not_found` (`"Task is unavailable"`).

```ts
// 1. Direct work: omit taskId first, pass it on follow-ups
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

const waited = await client.callTool({
  name: "opensteer_task_wait",
  arguments: { taskId: homeTaskId, timeoutMs: 50_000 },
});
console.log(waited.structuredContent);
```

---

## 5. The Tools

### Browser (`tab_list`, `browser_profile_list`, `browser_use`, `browser_connect`)

Connected agents work only in granted saved browser profiles or Chrome tabs shared by the person — never in Guest tabs. With one browser profile and neither `tabId` nor `profileId`, `browser_use` and `browser_connect` target it automatically; with several, pass `profileId` or `tabId`. For a shared Chrome tab, pass its `tabId` from `tab_list` (omit `profileId`).

- **`tab_list`**: lists reachable tabs (50 per page, `nextCursor`, optional `query`, `kind`). Shared Chrome tabs include `sharedByPerson: { sourceId, computerName }`. Page titles are untrusted text.
- **`browser_profile_list`**: lists granted saved browser profiles (`profiles: [{ id, name, home: { reachable, computerId?, name? } | null }]`). Omitted on Chrome-tabs-only grants. A profile opens only on its own device.

#### `browser_use`

Runs one sandboxed JavaScript script (**up to 18,956 UTF-16 characters**; 120-second default timeout) confined to the single granted profile or shared Chrome tab reviewed for that call. Variables on `globalThis` persist across calls in the same task and profile.

Call **`help()`** inside a script to print the full API. Core globals: `pages()`, `openPage(tabId)`, `newPage(url, { profileId })` and `page.close()` (granted browser profiles only; shared Chrome tabs can follow popups but cannot create or close tabs), `print(...values)`, `printImage(base64Data, mimeType?)`, `sleep(ms)`, `help()`. `page` follows Playwright names where supported (`goto`, `locator`, `getByRole`, `getByText`, `getByLabel`, `evaluate`, `url`, `title`, `waitForURL`, `waitForFunction`, `waitForTimeout`, `screenshot()` without a path, `ariaSnapshot()`, `keyboard`, `mouse`), plus `js(expression)`, `cdp(method, params, sessionId?)`, `currentTab()`, `pageInfo()`, `drainEvents()`, `respondDialog({ accept, promptText? })`, `waitForElement`, `waitForLoad`, and `waitForNetworkIdle`.

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
// res.content holds printed text, the PNG image block, and a trailing `Receipt: {...}` line.
// res.structuredContent holds { status, taskId, operationId, profileId, summary }.
```

#### `browser_connect`

Returns a single-use WebSocket URL (`/v1/browser/connect/<43-char-ticket>`) for stock Playwright, Puppeteer, or a raw Chrome DevTools Protocol (CDP) client:

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

- **Connect within 1 minute.** The single-use link expires 60 seconds after issue.
- **Lineage confinement (your own pages only):** Over `browser_connect`, a connected agent sees only the tab it was issued, pages it creates, and their popups. The person's tabs and another agent's tabs in the same profile are not listed and cannot be attached to (by target ID, auto-attach, or opener). Passing a saved-profile `tabId` to `browser_connect` works only for a tab opened by your task. Every page you create is recorded as an open tab of your task (or closed if the Home cannot record it), and closing an agent's tab really closes the page.
- **Cookies and sign-ins belong to the whole profile.** Pages are separated by task, but signed-in state is profile-wide — give each agent its own profile to keep accounts apart.
- **Modes:** Follow the returned `connect` line (or branch on `mode`):
  - `"whole-context"`: granted on a saved profile when your task is the sole live holder and the browser supports it; allows context-wide cookies, permissions, and workers. Connect with `chromium.connectOverCDP(endpoint)`.
  - `"session"` (the tool's mode name for page-scoped access): used for shared Chrome tabs and shared profiles; context-wide cookie/permission commands are refused. Connect with `chromium.connectOverCDP(endpoint, { noDefaults: true })`.
- **Playwright, CDP, and older devices:** Stock Playwright works, including `browser.newBrowserCDPSession()` and `context.newCDPSession(page)` as aliases of the confined root (nested browser aliases, context creation/disposal, and browser shutdown are refused). Limits: 8 MiB per frame, 128 in-flight messages, up to 4 live CDP connections per task. A device whose Opensteer is too old to report lineage support refuses `browser_connect` with `conflict` advising to update Opensteer and use `browser_use` instead.
- **No saved-login or card fills over `browser_connect`:** `Opensteer.fillLogin` and `Opensteer.fillCard` are refused over `browser_connect` (including via `context.newCDPSession(page)`). Fill them inside `browser_use`.
- **10-minute interval and renewal:** Ends after **10 minutes** (`expiresAt`), or sooner on **Stop**, **Disconnect**, grant change, lowered task mode, or when the person stops sharing the Chrome tab. To renew on the same tab, call `browser_connect` again without `operationId` (and with a new `operationKey` if you use one), passing the returned `tabId` (omitting `tabId` on a profile opens a new `about:blank` tab). Replaying a completed `browser_connect` returns the stored receipt with `next` and never issues a second endpoint.

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

// Renew on the same tab: call browser_connect again with { taskId: directTaskId, tabId }.
```

### Apps and phones (`computer_apps`, `computer_list`, `computer_use`)

- **`computer_apps`**: call `{}` for cached discovery of granted Macs (with granted apps) and phone screens (`access: "read" | "read-write"` or `blocked`). Pass `computerId` (plus optional `query`, `limit`, `cursor`, `taskId`, `operationId`) to list installed apps on a granted phone (returning opaque `appId` for `launch`) or apps on a Mac. On a Mac under a `selected` grant, this pages your granted apps from cache; on a phone or an `everything` Mac, it runs as a recorded structural read returning `taskId`, `operationId`, `status`, and `nextCursor` (for paging), supporting `operationId` receipt replay and cancellation on Stop or narrowing.
- **`computer_list`**: lists visible devices with `online`, `asleep`, and `phoneDisplay` (`control`, `input`, `navigationButtons`, `actions`). On a `selected` grant, an iPhone hides its connected Mac unless that Mac is also granted.
- **`computer_use`**: runs sandboxed JavaScript (**up to 18,956 UTF-16 characters**) against the single Mac app or phone screen named in the arguments:
  - Pass `computerId` (required) and `app` (Mac app name or `bundleId`; omitted on phone-only grants, required on Mac-only grants).
  - Inside `code`, **`await target` is already bound** to that Mac app or phone screen, and **`help()`** prints the full API. (`tab()` is unavailable.)
  - Set `readOnly: true` to observe without asking; it blocks all mutations and **never launches a closed Mac app or opens a window**.
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

- **Discovery is published or cached only:** `plugin_search`, `plugin_describe`, `plugin_skills`, `plugin_resources`, and `local_server_list` never run a plugin's live code with the person's linked account. Tools outside your access level (`read` vs `read-write`) show `blocked: { code: "access_denied", ... }`.
- **Live execution is reviewed:** `plugin_call` (one `{ path, input }` or an array for **one plugin per operation**, up to **18,956 UTF-16 characters** of canonical JSON) and `plugin_execute` (JavaScript up to **18,956 UTF-16 characters** with required `namespace`, listed only when a `read-write` plugin is granted) run through the direct-operation pipeline. Read-only `plugin_call` runs as a read; any write or `plugin_execute` follows your access mode.
- **Plugin input pauses (`plugin_resume`):** If a plugin pauses to ask the person for input in **Needs you**, `plugin_call` / `plugin_execute` returns `status: "pending"` **with an `executionId`**. Call `plugin_resume({ executionId, taskId })`, which waits up to **25 seconds** for the person's answer; if still waiting, it returns `status: "pending"` with both IDs — call `plugin_resume` again (not in a tight loop) until it completes.
- **Lost plugin engine:** If the plugin engine stops or loses contact after a write is sent, the operation yields `status: "unknown"` (`outcome_unknown`) — check current state before acting again.

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
  // Waits up to 25 seconds for the person's input in Needs you; repeat if still pending.
  const resumed = await client.callTool({
    name: "plugin_resume",
    arguments: { taskId: payload.taskId, executionId: payload.executionId },
  });
  console.log(resumed.structuredContent);
}
```

### Asking the person (`ask_person`)

Ask one single-choice question (no `multiSelect`, no free-text input so secrets are never typed into chat). Pass `options` (2–6 choices), or omit `options` for `["Done", "Unable to do it"]`. The person sees your connection name, task title, `"Enter passwords and codes only in the page."`, and your `title`/`detail` quoted as your words. Returns `{ status: "completed", taskId, operationId, answer }`.

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

Listed only when the hosting device supports Passwords (a personal Mac Home — not an Opensteer Cloud Computer or Linux Home) and a browser profile is granted (not on Chrome-tabs-only grants).

- Requires a live `tabId` in a granted saved browser profile on the hosting Mac's Opensteer browser, **already open on `site`**. Always asks the person in **Needs you** (even in `full-access`) and is never remembered across calls for a connected agent.
- **What is returned and what is protected:** Results return only an opaque reference (`loginStatus: "ready", loginRef: "lgn_..."` or `cardStatus: "ready", cardRef: "crd_..."`, or `"declined"` / `"unavailable"` with `reason`). **Opensteer fills it into the page and does not return it; an agent working in that page can read it.** Never read back, print, log, copy, or store a filled value. Approval controls which login or card is released, to which site, each time.
- **How to fill (`browser_use` only — not over `browser_connect`):** Focus each field and call:
  - `await page.cdp("Opensteer.fillLogin", { loginRef, field })` (`"username"`, `"password"`, `"code"`).
  - `await page.cdp("Opensteer.fillCard", { cardRef, field })` (`"number"`, `"expiry"`, `"expiry-month"`, `"expiry-year"`, `"cvc"`, `"name"`, `"billing-postal-code"`).
  - Check `result.status === "filled"` (other statuses: `"no-field"`, `"wrong-site"`, `"stale"`, `"expired"`, `"denied"`, `"unavailable"`).
- **Lifetime:** Bound to task, tab generation, and site; expires after 60 minutes (logins) or 30 minutes (cards); ends immediately on Stop, Disconnect, or grant change. Card approval covers filling only, not a purchase.

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

- **Accounts & creation:** `opensteer_ai_account_list`, `opensteer_task_create` (omit `aiAccountId` and `model` for defaults).
- **Control:** `opensteer_task_send` (`delivery: "report" | "queue" | "steer"`), `opensteer_task_interrupt`, `opensteer_task_resume`, `opensteer_task_update`, `opensteer_task_configure`, `opensteer_task_queue`.
- **Read & wait:** `opensteer_task_list`, `opensteer_task_read` (`view: "messages"` or `"activity"`), `opensteer_task_wait` (max `timeoutMs: 100000`), `opensteer_subagent_read`, `opensteer_delegation_status`, `opensteer_delegation_wait`, `opensteer_request_list`, `opensteer_request_read`.
- **Automations:** `opensteer_automation_list`, `opensteer_automation_read`, `opensteer_automation_create` (requires `full-access` and explicit `taskId`), `opensteer_automation_update`, `opensteer_automation_control`.

With `selected: { tasks: true }`, listings show only tasks created by your connection; with `everything`, you also see the person's own tasks (and in `full-access`, Home settings tools).

---

## 6. Results

Every direct call is recorded on the Home before review or execution. Receipt fields appear in `structuredContent` and in text `content`:

- Record tools (`tab_list`, `browser_connect`, `computer_apps` live inventory, `plugin_call`, `plugin_execute`, `plugin_resume`, `ask_person`, `saved_login_request`, `card_request`) return the full JSON object in `content[0].text` and `structuredContent`.
- Script tools (`browser_use`, `computer_use`) put printed text and images in `content` and append a trailing text block so text-only clients still receive the receipt:

```text
Receipt: {"status":"completed","taskId":"thr_...","operationId":"aop_..."}
```

When `next` is present (for example on `pending` or `unknown`), `Receipt:` includes `"next":"..."` too. (`requestId` and `summary` are in `structuredContent`.)

| Field         | Meaning                                                                                                                                      |
| :------------ | :------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`      | `"completed"`, `"pending"`, `"failed"`, or `"unknown"` (`plugin_call` / `plugin_execute` / `plugin_resume` may also return plugin statuses). |
| `taskId`      | Direct-work task ID (`thr_...`). Pass on follow-up direct calls.                                                                             |
| `operationId` | Durable receipt ID (`aop_...`). Pass with identical arguments to continue a `pending` call.                                                  |
| `requestId`   | Present in `structuredContent` when `status === "pending"` (`req_...`, or `null` if not yet attached).                                       |
| `next`        | Plain-English next step when `status !== "completed"` (and on replayed `browser_connect`).                                                   |

### Continuing a `pending` call

When an operation needs the person (approval, `ask_person`, `saved_login_request`, or `card_request`), the Home holds the call open for up to **25 seconds**. If still waiting, it returns:

```json
{
  "status": "pending",
  "taskId": "thr_...",
  "operationId": "aop_...",
  "requestId": "req_...",
  "next": "Call the same tool again with the same arguments and this operationId to wait up to 25 seconds for the person. If it is still pending, call again, but not in a tight loop."
}
```

- **Repeat with `operationId`:** Call the same tool with the exact same arguments and the returned `operationId` (no need to invent an `operationKey`; `operationKey` remains optional for your own retries if a call drops before you receive `operationId`). Avoid tight polling — tell the person a decision is waiting in **Needs you** or back off between 25-second waits.
- **Repeats never double-execute:** Repeating a finished operation (by `operationId` or `operationKey`) returns the stored receipt — even after idle or a Home restart — and never runs the effect twice or issues a second `browser_connect` endpoint. Changing arguments or `taskId` with the same `operationId` / `operationKey` fails with `conflict`.
- **Plugin input pauses:** When `plugin_call` or `plugin_execute` returns `status: "pending"` with an `executionId`, continue with `plugin_resume({ executionId, taskId })`, not by repeating `plugin_call`.

### Handling `unknown` (**Uncertain**) and mid-flight Stop

- **Lost reply or Home restart mid-effect:** The Home records the operation **Uncertain** and returns `status: "unknown"` (or tool error `code: "outcome_unknown"`). It never retries an uncertain effect on its own.
- **Work stopped mid-flight** by **Stop**, **Disconnect**, a narrowed grant, or a lowered task mode: The in-flight call aborts with `isError: true`, `error.code: "stopped_by_person"` or `"access_changed"`, `status: "unknown"`, `taskId`, `operationId`, and `error.next: "Part of it may have happened. Check the current state before doing anything else."`
- **After Stop:** Calls passing the stopped `taskId` fail with `stopped_by_person` (`"The person stopped this work. Do not continue it; ask before starting again."`). The first call omitting `taskId` after Stop also fails once with `stopped_by_person` so an agent cannot silently ignore Stop. Only start a new task after the person asks.

**Never retry blindly after either an interrupted refusal or `status: "unknown"`.** Run a safe read first (for example `tab_list`, a read-only check, or `computer_use` with `readOnly: true`) to see what happened.

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
  if (body.status === "pending" && body.operationId) {
    // Wait or notify the person, then re-call with { ...args, operationId: body.operationId }.
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

Tool failures return `isError: true` with identical JSON in `structuredContent` and `content[0].text`. Refusals and failures after admission include `taskId`, `operationId`, and `status` (`"refused"`, `"failed"`, or `"unknown"`) beside `error`:

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

`error.next` is actionable guidance or `null` (and never names a tool outside your listing). `error.device` (`{ id, name }`) appears only on `computer_asleep` and `computer_stopped`, and only when your grant allows knowing that device. Authentication failures (revoked, expired, or invalid bearer token) return HTTP `401` with `WWW-Authenticate` before reaching any tool.

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
| `access_denied`                                           | Any other refusal (such as a device access switch turned off or a read-only target).                    | Do not retry. Tell the person what is unavailable.                                                                     |
| HTTP `401` / WebSocket `1008`                             | Disconnected or 30-day token expired.                                                                   | Discard the bearer token and stop calling the Home. Re-run OAuth only if the person asks to reconnect.                 |

Other tool error codes a connected agent can receive: `invalid_input`, `conflict`, `outcome_unknown`, `unsupported`, `port_in_use`, `resource_exhausted`, `timeout`, `plugin_unavailable`, `catalog_unavailable`, `folder_unavailable`, `harness_error`, `harness_usage_limit`, `canonical_surface_required`, `internal_error`.

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
- **It cannot hide a filled secret from an agent controlling the page.** Opensteer fills a saved login or card into the page and does not return it; an agent working in that page can still read it. Never read back, print, or store a filled value. Inside a granted browser profile or shared Chrome tab, your agent also has full control of that browser's pages and cookies.
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
