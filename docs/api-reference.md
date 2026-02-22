# API Reference

## Opensteer

```ts
new Opensteer(config?: OpensteerConfig)
```

### Lifecycle

- `launch(options?: LaunchOptions): Promise<void>`
- `static from(page: Page, config?: OpensteerConfig): Opensteer`
- `close(): Promise<void>`

### Raw Playwright

- `page: Page`
- `context: BrowserContext`

### Snapshot and state

- `snapshot(options?: SnapshotOptions): Promise<string>`
- `state(): Promise<{ url: string; title: string; html: string }>`

### Descriptor-aware actions

- `click(options: ClickOptions): Promise<ActionResult>`
- `dblclick(options: ClickOptions): Promise<ActionResult>`
- `rightclick(options: ClickOptions): Promise<ActionResult>`
- `hover(options: HoverOptions): Promise<ActionResult>`
- `input(options: InputOptions): Promise<ActionResult>`
- `select(options: SelectOptions): Promise<ActionResult>`
- `scroll(options?: ScrollOptions): Promise<ActionResult>`
- `uploadFile(options: FileUploadOptions): Promise<ActionResult>`

Mutating actions apply a best-effort post-action wait by default so delayed UI
updates are visible before the method resolves.

Use `wait: false` on action options to disable this behavior per call.

```ts
interface ActionWaitOptions {
    enabled?: boolean
    timeout?: number
    settleMs?: number
    networkQuietMs?: number
    includeNetwork?: boolean
}

interface BaseActionOptions {
    description?: string
    element?: number
    selector?: string
    wait?: false | ActionWaitOptions
}
```

`pressKey()` and `type()` also use post-action wait internally with default
profiles, but they do not take per-call wait options.

When an interaction cannot be completed, descriptor-aware interaction methods
throw `OpensteerActionError` with structured failure diagnostics:

```ts
class OpensteerActionError extends Error {
    readonly action: string
    readonly code: ActionFailureCode
    readonly failure: ActionFailure
    readonly selectorUsed: string | null
}
```

### Extraction

- `extract<T>(options: ExtractOptions): Promise<T>`
- `extractFromPlan<T>(options: ExtractFromPlanOptions): Promise<ExtractionRunResult<T>>`

## Snapshot modes

- `action` (default)
- `extraction`
- `clickable`
- `scrollable`
- `full`

## ActionResult

```ts
interface ActionResult {
    method: string
    namespace: string
    persisted: boolean
    pathFile: string | null
    selectorUsed?: string | null
}
```

## ActionFailure

```ts
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

type ActionFailureClassificationSource =
    | 'typed_error'
    | 'playwright_call_log'
    | 'dom_probe'
    | 'message_heuristic'
    | 'unknown'

interface ActionFailureBlocker {
    tag: string
    id: string | null
    classes: string[]
    role: string | null
    text: string | null
}

interface ActionFailureDetails {
    blocker?: ActionFailureBlocker
    observation?: string
}

interface ActionFailure {
    code: ActionFailureCode
    message: string
    retryable: boolean
    classificationSource: ActionFailureClassificationSource
    details?: ActionFailureDetails
}
```

## OpensteerConfig

```ts
interface OpensteerConfig {
    name?: string
    browser?: {
        headless?: boolean
        executablePath?: string
        slowMo?: number
        /** Connect to a running browser. Example: "http://localhost:9222" */
        connectUrl?: string
        /** Browser channel: "chrome", "chrome-beta", or "msedge" */
        channel?: string
        /** Browser profile directory. Preserves cookies, extensions, and sessions. */
        profileDir?: string
    }
    storage?: {
        rootDir?: string
    }
    mode?: 'local' | 'remote'
    remote?: {
        apiKey?: string
        baseUrl?: string
    }
    model?: string
    debug?: boolean
}
```

`model` defaults to `gpt-5.1`. You can also set `OPENSTEER_MODEL`.
Mode defaults to local. You can set `OPENSTEER_MODE=local|remote`.
If `OPENSTEER_MODE=remote`, remote API key is required via `remote.apiKey` or
`OPENSTEER_REMOTE_API_KEY`.
If `mode` is provided in constructor config, it always overrides
`OPENSTEER_MODE`.
When remote mode is selected and `remote.apiKey` is omitted, it falls back to
`OPENSTEER_REMOTE_API_KEY`. If `remote.apiKey` is explicitly provided, it overrides the
env fallback.
Remote base URL defaults to `https://remote.opensteer.com` and can be overridden
with `OPENSTEER_REMOTE_BASE_URL`.
Remote mode is fail-fast and does not automatically fall back to local mode.

In remote mode, these methods are unsupported and throw
`REMOTE_UNSUPPORTED_METHOD`:

- `Opensteer.from(page)`
- `uploadFile()`
- `exportCookies()`
- `importCookies()`

## AI helpers

For advanced integration, Opensteer still exports:

- `createResolveCallback(model)`
- `createExtractCallback(model)`
- `getModelProvider(model)`
