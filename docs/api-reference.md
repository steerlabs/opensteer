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

## OpensteerConfig

```ts
interface OpensteerConfig {
    name?: string
    browser?: {
        headless?: boolean
        executablePath?: string
        slowMo?: number
    }
    storage?: {
        rootDir?: string
    }
    cloud?: {
        enabled: boolean
        key?: string
    }
    model?: string
    debug?: boolean
}
```

`model` defaults to `gpt-5.1`. You can also set `OPENSTEER_MODEL`.
When `cloud.enabled` is `true`, `cloud.key` falls back to `OPENSTEER_API_KEY`
if omitted. If `cloud.key` is provided, it overrides the env fallback.

## AI helpers

For advanced integration, Opensteer still exports:

- `createResolveCallback(model)`
- `createExtractCallback(model)`
- `getModelProvider(model)`
