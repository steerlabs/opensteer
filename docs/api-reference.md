# API Reference

## Opensteer

```ts
import { Opensteer } from 'opensteer'

const opensteer = new Opensteer(config?: OpensteerConfig)
```

### Lifecycle

#### `launch(options?: LaunchOptions): Promise<void>`

Launch a new browser (local or cloud). In local mode, starts a Playwright
Chromium instance. In cloud mode, creates a session and connects via CDP.

```ts
await opensteer.launch({ headless: true })
```

#### `static from(page: Page, config?: OpensteerConfig): Opensteer`

Wrap an existing Playwright `Page` without launching a new browser. The caller
retains ownership of the browser lifecycle. Not supported in cloud mode.

```ts
const opensteer = Opensteer.from(page, { name: 'my-scraper' })
```

#### `close(): Promise<void>`

Close the browser and release all resources. In cloud mode, also closes the
cloud session and action WebSocket.

### Raw Playwright

- `page: Page` -- the active Playwright `Page`
- `context: BrowserContext` -- the active Playwright `BrowserContext`

These throw if accessed before `launch()` or `Opensteer.from()`.

### Cloud Session Helpers

#### `getCloudSessionId(): string | null`

Returns the active cloud session id after `launch()` in cloud mode.

#### `getCloudSessionUrl(): string | null`

Returns the cloud session URL for deep-linking after `launch()` in cloud mode.

### Cursor Preview

Cursor preview is compositor-based (CDP Overlay), does not inject DOM into the
target page, and is best-effort (graceful no-op when unsupported).

- SDK default: `cursor.enabled = false`
- CLI default: enabled for opened sessions

#### `setCursorEnabled(enabled: boolean): void`

Enable or disable cursor preview at runtime for this `Opensteer` instance.

```ts
opensteer.setCursorEnabled(true)
```

#### `getCursorState(): { enabled: boolean; active: boolean; reason?: string }`

Return current cursor preview state.

```ts
const state = opensteer.getCursorState()
```

### Agent

#### `agent(config: OpensteerAgentConfig): OpensteerAgentInstance`

Create a Computer Use Agent (CUA) instance with ergonomic defaults.

```ts
const agent = opensteer.agent({
    mode: 'cua',
    model: 'openai/computer-use-preview',
})

const result = await agent.execute({
    instruction: 'Open docs and summarize the first section',
    maxSteps: 20,
    highlightCursor: true,
})
```

- V1 supports `mode: 'cua'` only.
- Supported providers: `openai`, `anthropic`, `google`.
- `model` supports either:
  - `"provider/model"` string
  - `{ modelName: "provider/model", apiKey?, baseUrl?, organization?, thinkingBudget?, environment? }`

#### `agent.execute(instructionOrOptions): Promise<OpensteerAgentResult>`

`instructionOrOptions` can be:

- `string` instruction
- `{ instruction: string, maxSteps?: number, highlightCursor?: boolean }`

`highlightCursor` overrides the instance cursor setting for that execution:

- `true`: force cursor preview on for this run
- `false`: force cursor preview off for this run
- omitted: use instance cursor setting

Returns:

- `success`, `completed`, `message`
- executed `actions`
- token/inference `usage`
- resolved `provider` and `model`

### Navigation

#### `goto(url: string, options?: GotoOptions): Promise<void>`

Navigate to a URL and wait for visual stability. Prefer this over
`opensteer.page.goto()` for consistent post-navigation settling.

```ts
await opensteer.goto('https://example.com')
await opensteer.goto('https://example.com', { waitUntil: 'networkidle', settleMs: 1500 })
```

### Observation

#### `snapshot(options?: SnapshotOptions): Promise<string>`

Return a cleaned HTML snapshot of the current page. Elements are annotated
with `c="..."` counters that can be used in subsequent actions via the
`element` option. Counters are reassigned on each snapshot and synced to the
live DOM.

```ts
const html = await opensteer.snapshot()
const html = await opensteer.snapshot({ mode: 'extraction' })
```

#### `state(): Promise<StateResult>`

Return the current page URL, title, and an `action`-mode snapshot.

```ts
const { url, title, html } = await opensteer.state()
```

#### `screenshot(options?: ScreenshotOptions): Promise<Buffer>`

Take a screenshot of the current page.

```ts
const buffer = await opensteer.screenshot()
const jpeg = await opensteer.screenshot({ type: 'jpeg', quality: 80, fullPage: true })
```

### Descriptor-Aware Actions

All interaction methods resolve elements through the resolution chain:

1. Persisted path for `description` (if previously stored)
2. `element` counter lookup in the live DOM
3. Explicit CSS `selector`
4. Built-in LLM resolution (requires `description`)

When steps 2--4 resolve and `description` is provided, the resolved path is
persisted for deterministic replay.

Mutating actions apply a best-effort post-action wait by default. Use
`wait: false` to disable or pass `ActionWaitOptions` to tune per call.

All interaction methods throw `OpensteerActionError` on failure.

#### `click(options: ClickOptions): Promise<ActionResult>`

```ts
await opensteer.click({ element: 3 })
await opensteer.click({ description: 'login-button' })
await opensteer.click({ selector: '#submit-btn', button: 'left' })
```

#### `dblclick(options: ClickOptions): Promise<ActionResult>`

Double-click an element.

#### `rightclick(options: ClickOptions): Promise<ActionResult>`

Right-click an element.

#### `hover(options: HoverOptions): Promise<ActionResult>`

```ts
await opensteer.hover({ description: 'profile-menu' })
await opensteer.hover({ element: 5, force: true })
```

#### `input(options: InputOptions): Promise<ActionResult>`

Fill or type text into an input element. By default, clears the field first
(`clear: true`).

```ts
await opensteer.input({ description: 'email', text: 'user@example.com' })
await opensteer.input({ element: 7, text: 'hello', clear: false, pressEnter: true })
```

#### `select(options: SelectOptions): Promise<ActionResult>`

Select a dropdown option by value, label, or index.

```ts
await opensteer.select({ description: 'country', value: 'US' })
await opensteer.select({ element: 12, label: 'United States' })
await opensteer.select({ element: 12, index: 0 })
```

#### `scroll(options?: ScrollOptions): Promise<ActionResult>`

Scroll the page or a specific element. Defaults to scrolling down by 600px
on the page.

```ts
await opensteer.scroll()
await opensteer.scroll({ direction: 'down', amount: 1200 })
await opensteer.scroll({ description: 'results-list', direction: 'down' })
```

#### `uploadFile(options: FileUploadOptions): Promise<ActionResult>`

Set files on a file input element. Not supported in cloud mode.

```ts
await opensteer.uploadFile({ element: 4, paths: ['/path/to/file.pdf'] })
```

### Tabs

#### `tabs(): Promise<TabInfo[]>`

List all open tabs with index, URL, title, and active status.

#### `newTab(url?: string): Promise<TabInfo>`

Open a new tab and optionally navigate to a URL. Switches the active page.

#### `switchTab(index: number): Promise<void>`

Switch to the tab at the given index.

#### `closeTab(index?: number): Promise<void>`

Close the tab at the given index, or the current tab if omitted.

### Cookies

#### `getCookies(url?: string): Promise<Cookie[]>`

Get cookies, optionally filtered by URL.

#### `setCookie(cookie: CookieParam): Promise<void>`

Set a single cookie.

#### `clearCookies(): Promise<void>`

Clear all cookies in the browser context.

#### `exportCookies(filePath: string, url?: string): Promise<void>`

Export cookies to a JSON file. Not supported in cloud mode.

#### `importCookies(filePath: string): Promise<void>`

Import cookies from a JSON file. Not supported in cloud mode.

### Keyboard

#### `pressKey(key: string): Promise<void>`

Press a keyboard key (e.g. `'Enter'`, `'Tab'`, `'Escape'`).

#### `type(text: string): Promise<void>`

Type text character-by-character into the currently focused element.

### Element Info

#### `getElementText(options: BaseActionOptions): Promise<string>`

Get the text content of an element.

#### `getElementValue(options: BaseActionOptions): Promise<string>`

Get the input value of a form element.

#### `getElementAttributes(options: BaseActionOptions): Promise<Record<string, string>>`

Get all attributes of an element as a key-value map.

#### `getElementBoundingBox(options: BaseActionOptions): Promise<BoundingBox | null>`

Get the bounding box of an element, or `null` if not visible.

#### `getHtml(selector?: string): Promise<string>`

Get raw HTML of the page or a specific element by CSS selector.

#### `getTitle(): Promise<string>`

Get the page title.

### Wait

#### `waitForText(text: string, options?: { timeout?: number }): Promise<void>`

Wait for text to appear on the page. Default timeout is 30 seconds.

```ts
await opensteer.waitForText('Welcome back')
await opensteer.waitForText('Order confirmed', { timeout: 10000 })
```

### Extraction

#### `extract<T>(options: ExtractOptions): Promise<T>`

Extract structured data from the page.

`schema` describes the output shape, not just selector bindings. You can use
semantic field hints such as `"string"` and arrays of objects for AI
extraction, or explicit bindings such as `{ element: 3 }`,
`{ element: 5, attribute: "href" }`, `{ selector: ".price" }`, and
`{ source: "current_url" }` for deterministic extraction. Use `prompt` to
describe relationship/fallback rules.

Relative URL-like attributes extracted from accessible iframe documents are
resolved against the iframe document base URL. Main-frame extraction keeps the
existing raw relative attribute behavior.

```ts
const images = await opensteer.extract({
    description: 'article images with captions and credits',
    prompt:
        'For each image, return the image URL, alt text, caption, and credit. Prefer caption and credit from the same figure. If missing, look at sibling text, then parent/container text, then nearby alt/data-* attributes.',
    schema: {
        images: [
            {
                imageUrl: 'string',
                alt: 'string',
                caption: 'string',
                credit: 'string',
            },
        ],
    },
})

const data = await opensteer.extract({
    description: 'product-info',
    schema: {
        title: { element: 3 },
        price: { element: 5 },
        url: { source: 'current_url' },
    },
})
```

For explicit array bindings, include multiple representative items so
Opensteer can infer the repeating pattern. For semantic extraction, a single
representative object shape is enough.

#### `extractFromPlan<T>(options: ExtractFromPlanOptions): Promise<ExtractionRunResult<T>>`

Extract data from a pre-built extraction plan with explicit field mappings
and element paths.

### Utility

#### `getNamespace(): string`

Return the resolved storage namespace.

#### `getConfig(): OpensteerConfig`

Return the resolved configuration object.

#### `getStorage(): LocalSelectorStorage`

Return the local selector storage instance.

#### `clearCache(): void`

Clear all persisted selectors for this namespace and reset the snapshot
cache.

---

## Types

### OpensteerConfig

```ts
interface OpensteerConfig {
    name?: string
    browser?: OpensteerBrowserConfig
    storage?: { rootDir?: string }
    cursor?: {
        enabled?: boolean
        profile?: 'snappy'
        style?: {
            size?: number
            fillColor?: { r: number; g: number; b: number; a: number }
            outlineColor?: { r: number; g: number; b: number; a: number }
            haloColor?: { r: number; g: number; b: number; a: number }
            pulseScale?: number
        }
    }
    cloud?: boolean | {
        apiKey?: string
        accessToken?: string
        baseUrl?: string
        authScheme?: 'api-key' | 'bearer'
        announce?: 'always' | 'off' | 'tty'
        browserProfile?: {
            profileId: string
            reuseIfActive?: boolean
        }
    }
    model?: string
    debug?: boolean
}

interface OpensteerBrowserConfig {
    headless?: boolean
    executablePath?: string
    slowMo?: number
    mode?: 'chromium' | 'real'
    cdpUrl?: string
    userDataDir?: string
    profileDirectory?: string
}
```

`model` defaults to `gpt-5.1`. Override with `OPENSTEER_MODEL`.
For CUA agents, use `provider/model` strings (for example
`openai/computer-use-preview`).

`cursor.enabled` defaults to `false` for SDK instances. Override with
`OPENSTEER_CURSOR=true|false` or `setCursorEnabled(...)`.

Cloud defaults to disabled. Override with `OPENSTEER_MODE=local|cloud`.

When cloud mode is selected, credentials are required via either:

- `cloud.apiKey` / `OPENSTEER_API_KEY`
- `cloud.accessToken` / `OPENSTEER_ACCESS_TOKEN`

Cloud base URL defaults to `https://api.opensteer.com` and can be overridden
with `OPENSTEER_BASE_URL`.
Opensteer auto-loads `.env` files from `storage.rootDir` (default
`process.cwd()`) in this order: `.env.<NODE_ENV>.local`, `.env.local` (skipped
when `NODE_ENV=test`), `.env.<NODE_ENV>`, `.env`. Existing `process.env` values
always take precedence.
The resolved env map is reused for Opensteer config and built-in AI/CUA provider
key resolution, without mutating global `process.env`. Env values are captured
when an `Opensteer` instance is created.

Cloud mode is fail-fast and does not automatically fall back to local mode.
If `cloud` is provided in constructor config, it always overrides `OPENSTEER_MODE`.

### LaunchOptions

```ts
interface LaunchOptions {
    headless?: boolean
    executablePath?: string
    slowMo?: number
    context?: BrowserContextOptions
    mode?: 'chromium' | 'real'
    cdpUrl?: string
    userDataDir?: string
    profileDirectory?: string
    cloudBrowserProfile?: {
        profileId: string
        reuseIfActive?: boolean
    }
    timeout?: number
}
```

`context` applies only to sandbox Chromium launches. `cdpUrl` attaches to an
existing browser. `mode: 'real'` uses owned Chrome startup and accepts
`initialUrl`, `userDataDir`, and `profileDirectory` instead of `context`.

### GotoOptions

```ts
interface GotoOptions {
    timeout?: number
    waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle'
    settleMs?: number
}
```

### SnapshotOptions

```ts
interface SnapshotOptions {
    mode?: 'action' | 'extraction' | 'clickable' | 'scrollable' | 'full'
    withCounters?: boolean
    markInteractive?: boolean
}
```

### ScreenshotOptions

```ts
interface ScreenshotOptions {
    fullPage?: boolean
    type?: 'png' | 'jpeg'
    quality?: number
    omitBackground?: boolean
}
```

### Action Options

```ts
interface BaseActionOptions {
    description?: string
    element?: number
    selector?: string
    wait?: false | ActionWaitOptions
}

interface ActionWaitOptions {
    enabled?: boolean
    timeout?: number
    settleMs?: number
    networkQuietMs?: number
    includeNetwork?: boolean
}

interface ClickOptions extends BaseActionOptions {
    button?: 'left' | 'right' | 'middle'
    clickCount?: number
    modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
}

interface HoverOptions extends BaseActionOptions {
    force?: boolean
    position?: { x: number; y: number }
}

interface InputOptions extends BaseActionOptions {
    text: string
    clear?: boolean
    pressEnter?: boolean
}

interface SelectOptions extends BaseActionOptions {
    value?: string
    label?: string
    index?: number
}

interface ScrollOptions extends BaseActionOptions {
    direction?: 'up' | 'down' | 'left' | 'right'
    amount?: number
}

interface FileUploadOptions extends BaseActionOptions {
    paths: string[]
}
```

### Extract Options

```ts
interface ExtractOptions extends BaseActionOptions {
    schema?: ExtractSchema
    prompt?: string
    snapshot?: SnapshotOptions
}

interface ExtractFromPlanOptions {
    description?: string
    schema: ExtractSchema
    plan: ExtractionPlan
}

interface ExtractSchema {
    [key: string]: ExtractSchemaValue
}

type ExtractSchemaValue =
    | ExtractSchemaField
    | string
    | number
    | boolean
    | null
    | ExtractSchema
    | ExtractSchema[]

interface ExtractSchemaField {
    element?: number
    selector?: string
    attribute?: string
    source?: 'current_url'
}
```

### Result Types

```ts
interface ActionResult {
    method: string
    namespace: string
    persisted: boolean
    pathFile: string | null
    selectorUsed?: string | null
}

interface StateResult {
    url: string
    title: string
    html: string
}

interface ExtractionRunResult<T = unknown> {
    namespace: string
    persisted: boolean
    pathFile: string | null
    data: T
    paths: Record<string, ElementPath>
}

interface TabInfo {
    index: number
    url: string
    title: string
    active: boolean
}

interface BoundingBox {
    x: number
    y: number
    width: number
    height: number
}

interface CookieParam {
    name: string
    value: string
    url?: string
    domain?: string
    path?: string
    expires?: number
    httpOnly?: boolean
    secure?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
}
```

### Error Types

```ts
class OpensteerActionError extends Error {
    readonly action: string
    readonly code: ActionFailureCode
    readonly failure: ActionFailure
    readonly selectorUsed: string | null
}

type ActionFailureCode =
    | 'TARGET_NOT_FOUND'
    | 'TARGET_UNAVAILABLE'
    | 'TARGET_STALE'
    | 'TARGET_AMBIGUOUS'
    | 'BLOCKED_BY_INTERCEPTOR'
    | 'NOT_VISIBLE'
    | 'NOT_ENABLED'
    | 'NOT_EDITABLE'
    | 'INVALID_TARGET'
    | 'INVALID_OPTIONS'
    | 'ACTION_TIMEOUT'
    | 'UNKNOWN'

interface ActionFailure {
    code: ActionFailureCode
    message: string
    retryable: boolean
    classificationSource: ActionFailureClassificationSource
    details?: ActionFailureDetails
}

type ActionFailureClassificationSource =
    | 'typed_error'
    | 'playwright_call_log'
    | 'dom_probe'
    | 'message_heuristic'
    | 'unknown'

interface ActionFailureDetails {
    blocker?: ActionFailureBlocker
    observation?: string
}

interface ActionFailureBlocker {
    tag: string
    id: string | null
    classes: string[]
    role: string | null
    text: string | null
}
```

### Snapshot Modes

| Mode | Description |
|------|-------------|
| `action` | Balanced context for action planning (default) |
| `extraction` | Richer content for data extraction |
| `clickable` | Clickable elements only |
| `scrollable` | Scrollable containers only |
| `full` | Broad HTML with scripts/styles/noise removed |

### Cloud Mode Limitations

These methods throw `CLOUD_UNSUPPORTED_METHOD` in cloud mode:

- `Opensteer.from(page)`
- `uploadFile()`
- `exportCookies()`
- `importCookies()`

### AI Helpers

Exported for advanced integration:

- `createResolveCallback(model: string, options?: { temperature?: number; maxTokens?: number | null; env?: Record<string, string | undefined> })` -- create a standalone resolve callback
- `createExtractCallback(model: string, options?: { temperature?: number; maxTokens?: number | null; env?: Record<string, string | undefined> })` -- create a standalone extract callback
- `getModelProvider(model: string, options?: { env?: Record<string, string | undefined> })` -- resolve an AI SDK model provider

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENSTEER_MODE` | `local` (default) or `cloud` |
| `OPENSTEER_MODEL` | Default model for LLM resolve/extract (default: `gpt-5.1`) |
| `OPENSTEER_API_KEY` | API key for cloud mode |
| `OPENSTEER_ACCESS_TOKEN` | Bearer token for cloud mode |
| `OPENSTEER_BASE_URL` | Cloud control-plane base URL (default: `https://api.opensteer.com`) |
| `OPENSTEER_AUTH_SCHEME` | Cloud auth scheme: `api-key` (default) or `bearer` |
| `OPENSTEER_REMOTE_ANNOUNCE` | Cloud launch announcement policy: `always`, `off`, `tty` (default: `always`) |
| `OPENSTEER_CLOUD_PROFILE_ID` | Default cloud browser profile id to launch with |
| `OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE` | Optional `true`/`false` profile session reuse preference |
| `OPENSTEER_HEADLESS` | `true` or `false` |
| `OPENSTEER_BROWSER_PATH` | Custom browser executable path |
| `OPENSTEER_SLOW_MO` | Slow-motion delay in milliseconds |
| `OPENSTEER_BROWSER` | Local browser mode: `chromium` or `real` |
| `OPENSTEER_CDP_URL` | Connect to a running browser (e.g. `http://localhost:9222`) |
| `OPENSTEER_USER_DATA_DIR` | Browser user-data root for real-browser mode |
| `OPENSTEER_PROFILE_DIRECTORY` | Browser profile directory name for real-browser mode |
| `OPENSTEER_DEBUG` | Enable debug logging |
| `OPENSTEER_DISABLE_DOTENV_AUTOLOAD` | Disable automatic `.env` loading (`true`/`1`) |

### Supported AI Models

The model string prefix determines which AI SDK provider is used:

| Prefix | Provider | Package |
|--------|----------|---------|
| `gpt-`, `o1-`, `o3-`, `o4-` | OpenAI | `@ai-sdk/openai` |
| `claude-` | Anthropic | `@ai-sdk/anthropic` |
| `gemini-` | Google | `@ai-sdk/google` |
| `grok-` | xAI | `@ai-sdk/xai` |
| `groq/` | Groq | `@ai-sdk/groq` |

All provider packages are included as dependencies. The required API key env
var depends on the provider (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`).
