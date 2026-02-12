# API Reference

## Oversteer

```ts
new Oversteer(config?: OversteerConfig)
```

### Lifecycle

- `launch(options?: LaunchOptions): Promise<void>`
- `static from(page: Page, config?: OversteerConfig): Oversteer`
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

## OversteerConfig

```ts
interface OversteerConfig {
    name?: string
    browser?: {
        headless?: boolean
        executablePath?: string
        slowMo?: number
    }
    storage?: {
        rootDir?: string
    }
    ai?: {
        model?: string
        resolve?: AiResolveCallback
        extract?: AiExtractCallback
        temperature?: number
        maxTokens?: number | null
    }
    debug?: boolean
}
```

## AI callbacks

### `ai.resolve`

Input: `{ html, action, description, url }`

Return one of:

- `{ element: number }`
- `{ selector: string }`
- `{ path: ElementPath }`
- `number` (counter)
- `string` (counter string or selector)

### `ai.extract`

Input: `{ html, schema, description?, prompt?, url }`

Return one of:

- extracted data object/array/value
- `ExtractionPlan`
- JSON string containing either of the above
