import type { BrowserContextOptions } from 'playwright'
import type { ElementPath } from './element-path/types.js'
export type {
    ActionFailure,
    ActionFailureBlocker,
    ActionFailureClassificationSource,
    ActionFailureCode,
    ActionFailureDetails,
} from './action-failure.js'

export type SnapshotMode =
    | 'action'
    | 'extraction'
    | 'clickable'
    | 'scrollable'
    | 'full'

export interface SnapshotOptions {
    mode?: SnapshotMode
    withCounters?: boolean
    markInteractive?: boolean
}

export interface ScreenshotOptions {
    fullPage?: boolean
    type?: 'png' | 'jpeg'
    /** Ignored for PNG. */
    quality?: number
    omitBackground?: boolean
}

export interface AiResolveArgs {
    html: string
    action: string
    description: string
    url: string | null
}

export interface AiResolveResult {
    element?: number
    selector?: string
    path?: ElementPath
}

export type AiResolveCallbackResult =
    | AiResolveResult
    | number
    | string
    | null
    | undefined

export type AiResolveCallback = (
    args: AiResolveArgs
) => Promise<AiResolveCallbackResult>

export interface AiExtractArgs<TSchema = ExtractSchema> {
    html: string
    schema: TSchema
    description?: string
    prompt?: string
    url: string | null
}

export type AiExtractResult<TData = unknown> = TData | ExtractionPlan | string

export type AiExtractCallback = <TSchema = ExtractSchema, TData = unknown>(
    args: AiExtractArgs<TSchema>
) => Promise<AiExtractResult<TData>>

export interface GotoOptions {
    timeout?: number
    waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle'
    settleMs?: number
}

export interface LaunchOptions {
    headless?: boolean
    executablePath?: string
    slowMo?: number
    context?: BrowserContextOptions
    /** Connect to a running browser. Example: "http://localhost:9222" */
    connectUrl?: string
    /** Browser channel: "chrome", "chrome-beta", or "msedge" */
    channel?: string
    /** Browser profile directory or Chromium user-data dir. Preserves cookies, extensions, and sessions. */
    profileDir?: string
    /** Cloud browser profile preference. Applies only when cloud mode is enabled. */
    cloudBrowserProfile?: OpensteerCloudBrowserProfileOptions
    /** Connection timeout in milliseconds. */
    timeout?: number
}

export interface OpensteerBrowserConfig {
    headless?: boolean
    executablePath?: string
    slowMo?: number
    /** Connect to a running browser. Example: "http://localhost:9222" */
    connectUrl?: string
    /** Browser channel: "chrome", "chrome-beta", or "msedge" */
    channel?: string
    /** Browser profile directory or Chromium user-data dir. Preserves cookies, extensions, and sessions. */
    profileDir?: string
}

export interface OpensteerStorageConfig {
    rootDir?: string
}

export interface OpensteerCursorColor {
    r: number
    g: number
    b: number
    a: number
}

export interface OpensteerCursorStyle {
    size?: number
    fillColor?: OpensteerCursorColor
    outlineColor?: OpensteerCursorColor
    haloColor?: OpensteerCursorColor
    pulseScale?: number
}

export type OpensteerCursorProfile = 'snappy'

export interface OpensteerCursorConfig {
    enabled?: boolean
    profile?: OpensteerCursorProfile
    style?: OpensteerCursorStyle
}

export type OpensteerAuthScheme = 'api-key' | 'bearer'
export type OpensteerCloudAnnouncePolicy = 'always' | 'off' | 'tty'

export interface OpensteerCloudBrowserProfileOptions {
    profileId: string
    reuseIfActive?: boolean
}

export interface OpensteerCloudOptions {
    apiKey?: string
    accessToken?: string
    baseUrl?: string
    authScheme?: OpensteerAuthScheme
    announce?: OpensteerCloudAnnouncePolicy
    browserProfile?: OpensteerCloudBrowserProfileOptions
}

export type OpensteerCloudConfig = boolean | OpensteerCloudOptions

export interface OpensteerConfig {
    name?: string
    browser?: OpensteerBrowserConfig
    storage?: OpensteerStorageConfig
    cursor?: OpensteerCursorConfig
    cloud?: OpensteerCloudConfig
    model?: string
    debug?: boolean
}

export interface ActionWaitOptions {
    enabled?: boolean
    timeout?: number
    settleMs?: number
    networkQuietMs?: number
    includeNetwork?: boolean
}

export interface BaseActionOptions {
    description?: string
    element?: number
    selector?: string
    wait?: false | ActionWaitOptions
}

export interface ClickOptions extends BaseActionOptions {
    button?: 'left' | 'right' | 'middle'
    clickCount?: number
    modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
}

export interface HoverOptions extends BaseActionOptions {
    force?: boolean
    position?: {
        x: number
        y: number
    }
}

export interface InputOptions extends BaseActionOptions {
    text: string
    clear?: boolean
    pressEnter?: boolean
}

export interface SelectOptions extends BaseActionOptions {
    value?: string
    label?: string
    index?: number
}

export interface ScrollOptions extends BaseActionOptions {
    direction?: 'up' | 'down' | 'left' | 'right'
    amount?: number
}

export interface ExtractSchemaField {
    element?: number
    selector?: string
    attribute?: string
    source?: 'current_url'
}

export type ExtractSchemaValue =
    | ExtractSchemaField
    | string
    | number
    | boolean
    | null
    | ExtractSchema
    | ExtractSchema[]

export interface ExtractSchema {
    [key: string]: ExtractSchemaValue
}

export interface ExtractOptions<
    TSchema = ExtractSchema,
> extends BaseActionOptions {
    schema?: TSchema
    prompt?: string
    snapshot?: SnapshotOptions
}

export interface ExtractionFieldPlan {
    element?: number
    selector?: string
    attribute?: string
    source?: 'current_url'
}

export interface ExtractionPlan {
    fields?: Record<string, ExtractionFieldPlan>
    paths?: Record<string, ElementPath>
    data?: unknown
}

export interface ExtractFromPlanOptions<TSchema = ExtractSchema> {
    description?: string
    schema: TSchema
    plan: ExtractionPlan
}

export interface ActionResult {
    method: string
    namespace: string
    persisted: boolean
    pathFile: string | null
    selectorUsed?: string | null
}

export interface OpensteerCursorState {
    enabled: boolean
    active: boolean
    reason?: string
}

export interface ExtractionRunResult<T = unknown> {
    namespace: string
    persisted: boolean
    pathFile: string | null
    data: T
    paths: Record<string, ElementPath>
}

export interface StateResult {
    url: string
    title: string
    html: string
}

export interface TabInfo {
    index: number
    url: string
    title: string
    active: boolean
}

export interface CookieParam {
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

export interface FileUploadOptions extends BaseActionOptions {
    paths: string[]
}

export interface BoundingBox {
    x: number
    y: number
    width: number
    height: number
}

export type OpensteerAgentMode = 'cua'

export type OpensteerAgentProvider = 'openai' | 'anthropic' | 'google'

export interface OpensteerAgentModelConfig {
    modelName: string
    apiKey?: string
    baseUrl?: string
    organization?: string
    thinkingBudget?: number
    environment?: string
}

export interface OpensteerAgentConfig {
    mode: OpensteerAgentMode
    model?: string | OpensteerAgentModelConfig
    systemPrompt?: string
    waitBetweenActionsMs?: number
}

export interface OpensteerAgentExecuteOptions {
    instruction: string
    maxSteps?: number
    highlightCursor?: boolean
}

export interface OpensteerAgentUsage {
    inputTokens: number
    outputTokens: number
    reasoningTokens?: number
    inferenceTimeMs: number
}

export interface OpensteerAgentAction {
    type: string
    reasoning?: string
    button?: string
    clickCount?: number
    x?: number
    y?: number
    text?: string
    keys?: string[]
    scrollX?: number
    scrollY?: number
    timeMs?: number
    url?: string
    path?: Array<{ x: number; y: number }>
    [key: string]: unknown
}

export interface OpensteerAgentResult {
    success: boolean
    completed: boolean
    message: string
    actions: OpensteerAgentAction[]
    usage?: OpensteerAgentUsage
    provider: OpensteerAgentProvider
    model: string
}

export interface OpensteerAgentInstance {
    execute(
        instructionOrOptions: string | OpensteerAgentExecuteOptions
    ): Promise<OpensteerAgentResult>
}
