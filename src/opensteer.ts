import { createHash } from 'crypto'
import type { Browser, BrowserContext, ElementHandle, Page } from 'playwright'
import { BrowserPool } from './browser/pool.js'
import { resolveConfig, resolveNamespace } from './config.js'
import { waitForVisualStability } from './navigation.js'
import type {
    ActionResult,
    AiExtractCallback,
    AiResolveCallback,
    BaseActionOptions,
    BoundingBox,
    ClickOptions,
    CookieParam,
    ExtractFromPlanOptions,
    ExtractOptions,
    ExtractSchema,
    ExtractSchemaField,
    ExtractSchemaValue,
    ExtractionPlan,
    ExtractionRunResult,
    FileUploadOptions,
    GotoOptions,
    HoverOptions,
    InputOptions,
    LaunchOptions,
    OpensteerConfig,
    ScrollOptions,
    SelectOptions,
    ScreenshotOptions,
    SnapshotOptions,
    StateResult,
    TabInfo,
} from './types.js'
import type { ActionFailure } from './action-failure.js'
import { LocalSelectorStorage, type SelectorFile } from './storage/local.js'
import { prepareSnapshot, type PreparedSnapshot } from './html/pipeline.js'
import {
    buildElementPathFromHandle,
    buildElementPathFromSelector,
    cloneElementPath,
    sanitizeElementPath,
} from './element-path/build.js'
import type { ElementPath } from './element-path/types.js'
import { performClick } from './actions/click.js'
import { performHover } from './actions/hover.js'
import { performInput } from './actions/input.js'
import { performScroll } from './actions/scroll.js'
import { performSelect } from './actions/select.js'
import {
    extractArrayRowsWithPaths,
    extractWithPaths,
    type FieldSelector,
} from './actions/extract.js'
import { flattenExtractionDataToFieldPlan } from './extract-field-plan.js'
import { listTabs, createTab, switchTab, closeTab } from './actions/tabs.js'
import {
    getCookies,
    setCookie,
    clearCookies,
    exportCookies,
    importCookies,
} from './actions/cookies.js'
import { pressKey, typeText } from './actions/keyboard.js'
import {
    getElementText,
    getElementValue,
    getElementAttributes,
    getElementBoundingBox,
    getPageHtml,
    getPageTitle,
} from './actions/element-info.js'
import { performFileUpload } from './actions/file-upload.js'
import { OpensteerActionError } from './actions/errors.js'
import {
    classifyActionFailure,
    defaultActionFailureMessage,
    normalizeActionFailure,
} from './actions/failure-classifier.js'
import {
    resolveCounterElement,
    resolveCountersBatch,
    type CounterRequest,
} from './html/counter-runtime.js'
import {
    createPostActionWaitSession,
    type PostActionKind,
} from './action-wait.js'
import {
    buildPersistedExtractPayload,
    collectArrayItemFieldDescriptors,
    isPersistablePathField,
    isPersistedArrayNode,
    isPersistedSourceNode,
    isPersistedValueNode,
    type ArrayItemFieldDescriptor,
    type ArrayItemPathFieldDescriptor,
    type ArrayItemSourceFieldDescriptor,
    type PersistableExtractField,
    type PersistedExtractArrayNode,
    type PersistedExtractNode,
    type PersistedExtractObjectNode,
    type PersistedExtractPayload,
} from './extraction/array-consolidation.js'
import type { CloudActionMethod } from './cloud/contracts.js'
import { ActionWsClient } from './cloud/action-ws-client.js'
import { CloudCdpClient } from './cloud/cdp-client.js'
import {
    cloudNotLaunchedError,
    OpensteerCloudError,
    cloudUnsupportedMethodError,
} from './cloud/errors.js'
import { CloudSessionClient } from './cloud/session-client.js'
import { collectLocalSelectorCacheEntries } from './cloud/local-cache-sync.js'

interface PathResolutionResult {
    path: ElementPath | null
    counter: number | null
    shouldPersist: boolean
    source: 'stored' | 'element' | 'selector' | 'ai' | 'none'
}

interface PathExtractFieldTarget {
    key: string
    path: ElementPath
    attribute?: string
}

interface CounterExtractFieldTarget {
    key: string
    counter: number
    attribute?: string
}

interface CurrentUrlExtractFieldTarget {
    key: string
    source: 'current_url'
}

type ExtractFieldTarget =
    | PathExtractFieldTarget
    | CounterExtractFieldTarget
    | CurrentUrlExtractFieldTarget

interface ParsedAiExtractResult {
    fields: ExtractFieldTarget[]
    data?: unknown
}

interface MergedArrayVariantRow {
    identity: string
    order: number
    coverage: number
    value: unknown
}

interface CloudRuntimeState {
    readonly sessionClient: CloudSessionClient
    readonly cdpClient: CloudCdpClient
    actionClient: ActionWsClient | null
    sessionId: string | null
}

const DEFAULT_CLOUD_BASE_URL = 'https://cloud.oversteer.ai'
const CLOUD_INTERACTION_METHODS = new Set<CloudActionMethod>([
    'click',
    'dblclick',
    'rightclick',
    'hover',
    'input',
    'select',
    'scroll',
    'uploadFile',
])

export class Opensteer {
    private readonly config: OpensteerConfig
    private readonly aiResolve: AiResolveCallback
    private readonly aiExtract: AiExtractCallback
    private readonly namespace: string
    private readonly storage: LocalSelectorStorage
    private readonly pool: BrowserPool
    private readonly cloud: CloudRuntimeState | null

    private browser: Browser | null = null
    private pageRef: Page | null = null
    private contextRef: BrowserContext | null = null
    private ownsBrowser = false
    private snapshotCache: PreparedSnapshot | null = null

    constructor(config: OpensteerConfig = {}) {
        const resolved = resolveConfig(config)
        const model = resolved.model

        this.config = resolved
        this.aiResolve = this.createLazyResolveCallback(model)
        this.aiExtract = this.createLazyExtractCallback(model)

        const rootDir = resolved.storage?.rootDir || process.cwd()
        this.namespace = resolveNamespace(resolved, rootDir)
        this.storage = new LocalSelectorStorage(rootDir, this.namespace)
        this.pool = new BrowserPool(resolved.browser || {})

        if (resolved.cloud?.enabled) {
            const key = resolved.cloud.key?.trim()
            if (!key) {
                throw new Error(
                    'Cloud mode requires a non-empty API key via cloud.key or OPENSTEER_API_KEY.'
                )
            }

            const baseUrl = resolveCloudBaseUrl()
            this.cloud = {
                sessionClient: new CloudSessionClient(baseUrl, key),
                cdpClient: new CloudCdpClient(),
                actionClient: null,
                sessionId: null,
            }
            this.bindCloudActionMethods()
        } else {
            this.cloud = null
        }
    }

    private createLazyResolveCallback(model: string): AiResolveCallback {
        let resolverPromise: Promise<AiResolveCallback> | null = null

        return async (...args: [Parameters<AiResolveCallback>[0]]) => {
            try {
                if (!resolverPromise) {
                    resolverPromise = import('./ai/resolver.js').then((m) =>
                        m.createResolveCallback(model)
                    )
                }

                const resolver = await resolverPromise
                return resolver(...args)
            } catch (err) {
                resolverPromise = null
                throw err
            }
        }
    }

    private createLazyExtractCallback(model: string): AiExtractCallback {
        let extractorPromise: Promise<AiExtractCallback> | null = null

        const extract: AiExtractCallback = async (args) => {
            try {
                if (!extractorPromise) {
                    extractorPromise = import('./ai/extractor.js').then((m) =>
                        m.createExtractCallback(model)
                    )
                }

                const extractor = await extractorPromise
                return extractor(args)
            } catch (err) {
                extractorPromise = null
                throw err
            }
        }

        return extract
    }

    private bindCloudActionMethods(): void {
        const instance = this as unknown as {
            goto: Opensteer['goto']
            snapshot: Opensteer['snapshot']
            state: Opensteer['state']
            click: Opensteer['click']
            dblclick: Opensteer['dblclick']
            rightclick: Opensteer['rightclick']
            hover: Opensteer['hover']
            input: Opensteer['input']
            select: Opensteer['select']
            scroll: Opensteer['scroll']
            tabs: Opensteer['tabs']
            newTab: Opensteer['newTab']
            switchTab: Opensteer['switchTab']
            closeTab: Opensteer['closeTab']
            getCookies: Opensteer['getCookies']
            setCookie: Opensteer['setCookie']
            clearCookies: Opensteer['clearCookies']
            exportCookies: Opensteer['exportCookies']
            importCookies: Opensteer['importCookies']
            pressKey: Opensteer['pressKey']
            type: Opensteer['type']
            getElementText: Opensteer['getElementText']
            getElementValue: Opensteer['getElementValue']
            getElementAttributes: Opensteer['getElementAttributes']
            getElementBoundingBox: Opensteer['getElementBoundingBox']
            getHtml: Opensteer['getHtml']
            getTitle: Opensteer['getTitle']
            screenshot: Opensteer['screenshot']
            uploadFile: Opensteer['uploadFile']
            waitForText: Opensteer['waitForText']
            extract: Opensteer['extract']
            extractFromPlan: Opensteer['extractFromPlan']
            clearCache: Opensteer['clearCache']
        }

        instance.goto = async (url, options) => {
            await this.invokeCloudAction('goto', { url, options })
            this.snapshotCache = null
        }

        instance.snapshot = async (options = {}) => {
            const html = await this.invokeCloudAction<string>('snapshot', {
                options,
            })
            this.snapshotCache = null
            return html
        }

        instance.state = async () => {
            return await this.invokeCloudAction<StateResult>('state', {})
        }

        instance.click = async (options) => {
            this.snapshotCache = null
            return await this.invokeCloudAction<ActionResult>('click', options)
        }

        instance.dblclick = async (options) => {
            this.snapshotCache = null
            return await this.invokeCloudAction<ActionResult>(
                'dblclick',
                options
            )
        }

        instance.rightclick = async (options) => {
            this.snapshotCache = null
            return await this.invokeCloudAction<ActionResult>(
                'rightclick',
                options
            )
        }

        instance.hover = async (options) => {
            this.snapshotCache = null
            return await this.invokeCloudAction<ActionResult>('hover', options)
        }

        instance.input = async (options) => {
            this.snapshotCache = null
            return await this.invokeCloudAction<ActionResult>('input', options)
        }

        instance.select = async (options) => {
            this.snapshotCache = null
            return await this.invokeCloudAction<ActionResult>('select', options)
        }

        instance.scroll = async (options = {}) => {
            this.snapshotCache = null
            return await this.invokeCloudAction<ActionResult>('scroll', options)
        }

        instance.tabs = async () => {
            return await this.invokeCloudAction<TabInfo[]>('tabs', {})
        }

        instance.newTab = async (url) => {
            this.snapshotCache = null
            return await this.invokeCloudAction<TabInfo>('newTab', { url })
        }

        instance.switchTab = async (index) => {
            await this.invokeCloudAction('switchTab', { index })
            this.snapshotCache = null
        }

        instance.closeTab = async (index) => {
            await this.invokeCloudAction('closeTab', { index })
            this.snapshotCache = null
        }

        instance.getCookies = async (url) => {
            return await this.invokeCloudAction<import('playwright').Cookie[]>(
                'getCookies',
                { url }
            )
        }

        instance.setCookie = async (cookie) => {
            await this.invokeCloudAction('setCookie', cookie)
        }

        instance.clearCookies = async () => {
            await this.invokeCloudAction('clearCookies', {})
        }

        instance.exportCookies = async () => {
            throw cloudUnsupportedMethodError(
                'exportCookies',
                'exportCookies() is not supported in cloud mode v1 because it depends on local filesystem paths.'
            )
        }

        instance.importCookies = async () => {
            throw cloudUnsupportedMethodError(
                'importCookies',
                'importCookies() is not supported in cloud mode v1 because it depends on local filesystem paths.'
            )
        }

        instance.pressKey = async (key) => {
            await this.invokeCloudAction('pressKey', { key })
            this.snapshotCache = null
        }

        instance.type = async (text) => {
            await this.invokeCloudAction('type', { text })
            this.snapshotCache = null
        }

        instance.getElementText = async (options) => {
            return await this.invokeCloudAction<string>(
                'getElementText',
                options
            )
        }

        instance.getElementValue = async (options) => {
            return await this.invokeCloudAction<string>(
                'getElementValue',
                options
            )
        }

        instance.getElementAttributes = async (options) => {
            return await this.invokeCloudAction<Record<string, string>>(
                'getElementAttributes',
                options
            )
        }

        instance.getElementBoundingBox = async (options) => {
            return await this.invokeCloudAction<BoundingBox | null>(
                'getElementBoundingBox',
                options
            )
        }

        instance.getHtml = async (selector) => {
            return await this.invokeCloudAction<string>('getHtml', { selector })
        }

        instance.getTitle = async () => {
            return await this.invokeCloudAction<string>('getTitle', {})
        }

        instance.screenshot = async (options = {}) => {
            const b64 = await this.invokeCloudAction<string>('screenshot', options)
            return Buffer.from(b64, 'base64')
        }

        instance.uploadFile = async () => {
            throw cloudUnsupportedMethodError(
                'uploadFile',
                'uploadFile() is not supported in cloud mode v1 because file paths must be accessible on the remote server.'
            )
        }

        instance.waitForText = async (text, options) => {
            await this.invokeCloudAction('waitForText', { text, options })
        }

        instance.extract = (async (options: ExtractOptions) => {
            return await this.invokeCloudAction<unknown>('extract', options)
        }) as Opensteer['extract']

        instance.extractFromPlan = (async (options: ExtractFromPlanOptions) => {
            return await this.invokeCloudAction<ExtractionRunResult>(
                'extractFromPlan',
                options as never
            )
        }) as Opensteer['extractFromPlan']

        instance.clearCache = () => {
            this.snapshotCache = null

            if (!this.cloud?.actionClient) return
            void this.invokeCloudAction('clearCache', {})
        }
    }

    private async invokeCloudAction<T>(
        method: CloudActionMethod,
        args: unknown
    ): Promise<T> {
        const actionClient = this.cloud?.actionClient
        const sessionId = this.cloud?.sessionId
        if (!actionClient || !sessionId) {
            throw cloudNotLaunchedError()
        }

        const payload =
            args && typeof args === 'object'
                ? (args as Record<string, unknown>)
                : {}
        try {
            return await actionClient.request<T>(method, payload)
        } catch (err) {
            if (
                err instanceof OpensteerCloudError &&
                err.code === 'CLOUD_ACTION_FAILED' &&
                CLOUD_INTERACTION_METHODS.has(method)
            ) {
                const detailsRecord =
                    err.details && typeof err.details === 'object'
                        ? (err.details as Record<string, unknown>)
                        : null
                const cloudFailure = normalizeActionFailure(
                    detailsRecord?.actionFailure
                )
                const failure =
                    cloudFailure ||
                    classifyActionFailure({
                        action: method,
                        error: err,
                        fallbackMessage: defaultActionFailureMessage(method),
                    })
                const description = readCloudActionDescription(payload)
                throw this.buildActionError(
                    method,
                    description,
                    failure,
                    null,
                    err
                )
            }
            throw err
        }
    }

    private buildActionError(
        action: string,
        description: string | undefined,
        failure: ActionFailure,
        selectorUsed?: string | null,
        cause?: unknown
    ): OpensteerActionError {
        return new OpensteerActionError({
            action,
            failure,
            selectorUsed: selectorUsed || null,
            message: formatActionFailureMessage(
                action,
                description,
                failure.message
            ),
            cause,
        })
    }

    get page(): Page {
        if (!this.pageRef) {
            throw new Error(
                'Browser page is not initialized. Call launch() or Opensteer.from(page).'
            )
        }

        return this.pageRef
    }

    get context(): BrowserContext {
        if (!this.contextRef) {
            throw new Error(
                'Browser context is not initialized. Call launch() or Opensteer.from(page).'
            )
        }

        return this.contextRef
    }

    async launch(options: LaunchOptions = {}): Promise<void> {
        if (this.pageRef && !this.ownsBrowser) {
            throw new Error(
                'This Opensteer instance is attached to an external page via Opensteer.from().'
            )
        }

        if (this.pageRef && this.ownsBrowser) {
            return
        }

        if (this.cloud) {
            let actionClient: ActionWsClient | null = null
            let browser: Browser | null = null
            let sessionId: string | null = null

            try {
                try {
                    await this.syncLocalSelectorCacheToCloud()
                } catch (error) {
                    if (this.config.debug) {
                        const message =
                            error instanceof Error
                                ? error.message
                                : String(error)
                        console.warn(
                            `[opensteer] cloud selector cache sync failed: ${message}`
                        )
                    }
                }

                const session = await this.cloud.sessionClient.create({
                    name: this.namespace,
                    model: this.config.model,
                    launchContext:
                        (options.context as Record<string, unknown>) ||
                        undefined,
                })

                sessionId = session.sessionId
                actionClient = await ActionWsClient.connect({
                    url: session.actionWsUrl,
                    token: session.actionToken,
                    sessionId: session.sessionId,
                })

                const cdpConnection = await this.cloud.cdpClient.connect({
                    wsUrl: session.cdpWsUrl,
                    token: session.cdpToken,
                })

                browser = cdpConnection.browser
                this.browser = cdpConnection.browser
                this.contextRef = cdpConnection.context
                this.pageRef = cdpConnection.page
                this.ownsBrowser = true
                this.snapshotCache = null

                this.cloud.actionClient = actionClient
                this.cloud.sessionId = sessionId
                return
            } catch (error) {
                if (actionClient) {
                    await actionClient.close().catch(() => undefined)
                }
                if (browser) {
                    await browser.close().catch(() => undefined)
                }
                if (sessionId) {
                    await this.cloud.sessionClient
                        .close(sessionId)
                        .catch(() => undefined)
                }
                throw error
            }
        }

        const session = await this.pool.launch({
            ...options,
            connectUrl: options.connectUrl ?? this.config.browser?.connectUrl,
            channel: options.channel ?? this.config.browser?.channel,
            profileDir:
                options.profileDir ?? this.config.browser?.profileDir,
        })

        this.browser = session.browser
        this.contextRef = session.context
        this.pageRef = session.page
        this.ownsBrowser = true
        this.snapshotCache = null
    }

    static from(page: Page, config: OpensteerConfig = {}): Opensteer {
        if (config.cloud?.enabled) {
            throw cloudUnsupportedMethodError(
                'Opensteer.from(page)',
                'Opensteer.from(page) is not supported in cloud mode v1.'
            )
        }

        const instance = new Opensteer(config)
        instance.pageRef = page
        instance.contextRef = page.context()
        instance.browser = null
        instance.ownsBrowser = false
        instance.snapshotCache = null
        return instance
    }

    async close(): Promise<void> {
        this.snapshotCache = null

        if (this.cloud) {
            const actionClient = this.cloud.actionClient
            const sessionId = this.cloud.sessionId
            const browser = this.browser

            this.cloud.actionClient = null
            this.cloud.sessionId = null

            this.browser = null
            this.pageRef = null
            this.contextRef = null
            this.ownsBrowser = false

            if (actionClient) {
                await actionClient.close().catch(() => undefined)
            }
            if (browser) {
                await browser.close().catch(() => undefined)
            }
            if (sessionId) {
                await this.cloud.sessionClient
                    .close(sessionId)
                    .catch(() => undefined)
            }
            return
        }

        if (this.ownsBrowser) {
            await this.pool.close()
        }

        this.browser = null
        this.pageRef = null
        this.contextRef = null
        this.ownsBrowser = false
    }

    private async syncLocalSelectorCacheToCloud(): Promise<void> {
        if (!this.cloud) return

        const entries = collectLocalSelectorCacheEntries(this.storage)
        if (!entries.length) return

        await this.cloud.sessionClient.importSelectorCache({
            entries,
        })
    }

    async goto(url: string, options?: GotoOptions): Promise<void> {
        const { waitUntil = 'domcontentloaded', ...rest } = options ?? {}
        await this.page.goto(url, { waitUntil, timeout: rest.timeout })
        await waitForVisualStability(this.page, rest)
        this.snapshotCache = null
    }

    async snapshot(options: SnapshotOptions = {}): Promise<string> {
        const prepared = await prepareSnapshot(this.page, options)
        this.snapshotCache = prepared
        return prepared.cleanedHtml
    }

    async state(): Promise<StateResult> {
        const html = await this.snapshot({ mode: 'action' })

        return {
            url: this.page.url(),
            title: await this.page.title(),
            html,
        }
    }

    async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
        return this.page.screenshot({
            type: options.type ?? 'png',
            fullPage: options.fullPage,
            quality: options.type === 'jpeg' ? (options.quality ?? 90) : undefined,
            omitBackground: options.omitBackground,
        })
    }

    async click(options: ClickOptions): Promise<ActionResult> {
        return this.executeClickVariant('click', {
            ...options,
            button: options.button ?? 'left',
            clickCount: options.clickCount ?? 1,
        })
    }

    async dblclick(options: ClickOptions): Promise<ActionResult> {
        return this.executeClickVariant('dblclick', {
            ...options,
            button: options.button ?? 'left',
            clickCount: 2,
        })
    }

    async rightclick(options: ClickOptions): Promise<ActionResult> {
        return this.executeClickVariant('rightclick', {
            ...options,
            button: 'right',
            clickCount: options.clickCount ?? 1,
        })
    }

    async hover(options: HoverOptions): Promise<ActionResult> {
        const storageKey = this.resolveStorageKey(options.description)
        const resolution = await this.resolvePath('hover', options)

        if (resolution.counter != null) {
            const handle = await this.resolveCounterHandleForAction(
                'hover',
                options.description,
                resolution.counter
            )
            let persistPath: ElementPath | null = null
            try {
                if (storageKey && resolution.shouldPersist) {
                    persistPath = await this.buildPathFromResolvedHandle(
                        handle,
                        'hover',
                        resolution.counter
                    )
                }

                await this.runWithPostActionWait('hover', options.wait, async () => {
                    await handle.hover({
                        force: options.force,
                        position: options.position,
                    })
                })
            } catch (err) {
                const failure = classifyActionFailure({
                    action: 'hover',
                    error: err,
                    fallbackMessage: defaultActionFailureMessage('hover'),
                })
                throw this.buildActionError(
                    'hover',
                    options.description,
                    failure,
                    `[c="${resolution.counter}"]`,
                    err
                )
            } finally {
                await handle.dispose()
            }

            this.snapshotCache = null

            const persisted =
                resolution.shouldPersist &&
                !!storageKey &&
                !!persistPath &&
                this.persistPath(
                    storageKey,
                    'hover',
                    options.description,
                    persistPath
                )

            return this.buildActionResult(
                storageKey,
                'hover',
                Boolean(persisted),
                `[c="${resolution.counter}"]`
            )
        }

        if (!resolution.path) {
            throw new Error('Unable to resolve element path for hover action.')
        }
        const path = resolution.path

        const result = await this.runWithPostActionWait(
            'hover',
            options.wait,
            async () => {
                const actionResult = await performHover(this.page, path, options)

                if (!actionResult.ok) {
                    const failure =
                        actionResult.failure ||
                        classifyActionFailure({
                            action: 'hover',
                            error:
                                actionResult.error ||
                                defaultActionFailureMessage('hover'),
                            fallbackMessage: defaultActionFailureMessage('hover'),
                        })
                    throw this.buildActionError(
                        'hover',
                        options.description,
                        failure,
                        actionResult.usedSelector || null
                    )
                }

                return actionResult
            }
        )
        this.snapshotCache = null

        const persisted =
            resolution.shouldPersist &&
            !!storageKey &&
            !!result.path &&
            this.persistPath(
                storageKey,
                'hover',
                options.description,
                result.path
            )

        return this.buildActionResult(
            storageKey,
            'hover',
            Boolean(persisted),
            result.usedSelector
        )
    }

    async input(options: InputOptions): Promise<ActionResult> {
        const storageKey = this.resolveStorageKey(options.description)
        const resolution = await this.resolvePath('input', options)

        if (resolution.counter != null) {
            const handle = await this.resolveCounterHandleForAction(
                'input',
                options.description,
                resolution.counter
            )
            let persistPath: ElementPath | null = null
            try {
                if (storageKey && resolution.shouldPersist) {
                    persistPath = await this.buildPathFromResolvedHandle(
                        handle,
                        'input',
                        resolution.counter
                    )
                }

                await this.runWithPostActionWait('input', options.wait, async () => {
                    if (options.clear !== false) {
                        await handle.fill(options.text)
                    } else {
                        await handle.type(options.text)
                    }
                    if (options.pressEnter) {
                        await handle.press('Enter')
                    }
                })
            } catch (err) {
                const failure = classifyActionFailure({
                    action: 'input',
                    error: err,
                    fallbackMessage: defaultActionFailureMessage('input'),
                })
                throw this.buildActionError(
                    'input',
                    options.description,
                    failure,
                    `[c="${resolution.counter}"]`,
                    err
                )
            } finally {
                await handle.dispose()
            }

            this.snapshotCache = null

            const persisted =
                resolution.shouldPersist &&
                !!storageKey &&
                !!persistPath &&
                this.persistPath(
                    storageKey,
                    'input',
                    options.description,
                    persistPath
                )

            return this.buildActionResult(
                storageKey,
                'input',
                Boolean(persisted),
                `[c="${resolution.counter}"]`
            )
        }

        if (!resolution.path) {
            throw new Error('Unable to resolve element path for input action.')
        }
        const path = resolution.path

        const result = await this.runWithPostActionWait(
            'input',
            options.wait,
            async () => {
                const actionResult = await performInput(this.page, path, options)

                if (!actionResult.ok) {
                    const failure =
                        actionResult.failure ||
                        classifyActionFailure({
                            action: 'input',
                            error:
                                actionResult.error ||
                                defaultActionFailureMessage('input'),
                            fallbackMessage: defaultActionFailureMessage('input'),
                        })
                    throw this.buildActionError(
                        'input',
                        options.description,
                        failure,
                        actionResult.usedSelector || null
                    )
                }

                return actionResult
            }
        )
        this.snapshotCache = null

        const persisted =
            resolution.shouldPersist &&
            !!storageKey &&
            !!result.path &&
            this.persistPath(
                storageKey,
                'input',
                options.description,
                result.path
            )

        return this.buildActionResult(
            storageKey,
            'input',
            Boolean(persisted),
            result.usedSelector
        )
    }

    async select(options: SelectOptions): Promise<ActionResult> {
        const storageKey = this.resolveStorageKey(options.description)
        const resolution = await this.resolvePath('select', options)

        if (resolution.counter != null) {
            const handle = await this.resolveCounterHandleForAction(
                'select',
                options.description,
                resolution.counter
            )
            let persistPath: ElementPath | null = null
            try {
                if (storageKey && resolution.shouldPersist) {
                    persistPath = await this.buildPathFromResolvedHandle(
                        handle,
                        'select',
                        resolution.counter
                    )
                }

                await this.runWithPostActionWait(
                    'select',
                    options.wait,
                    async () => {
                        if (options.value != null) {
                            await handle.selectOption(options.value)
                        } else if (options.label != null) {
                            await handle.selectOption({ label: options.label })
                        } else if (options.index != null) {
                            await handle.selectOption({ index: options.index })
                        } else {
                            throw new Error(
                                'Select requires value, label, or index.'
                            )
                        }
                    }
                )
            } catch (err) {
                const failure = classifyActionFailure({
                    action: 'select',
                    error: err,
                    fallbackMessage: defaultActionFailureMessage('select'),
                })
                throw this.buildActionError(
                    'select',
                    options.description,
                    failure,
                    `[c="${resolution.counter}"]`,
                    err
                )
            } finally {
                await handle.dispose()
            }

            this.snapshotCache = null

            const persisted =
                resolution.shouldPersist &&
                !!storageKey &&
                !!persistPath &&
                this.persistPath(
                    storageKey,
                    'select',
                    options.description,
                    persistPath
                )

            return this.buildActionResult(
                storageKey,
                'select',
                Boolean(persisted),
                `[c="${resolution.counter}"]`
            )
        }

        if (!resolution.path) {
            throw new Error('Unable to resolve element path for select action.')
        }
        const path = resolution.path

        const result = await this.runWithPostActionWait(
            'select',
            options.wait,
            async () => {
                const actionResult = await performSelect(this.page, path, options)

                if (!actionResult.ok) {
                    const failure =
                        actionResult.failure ||
                        classifyActionFailure({
                            action: 'select',
                            error:
                                actionResult.error ||
                                defaultActionFailureMessage('select'),
                            fallbackMessage: defaultActionFailureMessage('select'),
                        })
                    throw this.buildActionError(
                        'select',
                        options.description,
                        failure,
                        actionResult.usedSelector || null
                    )
                }

                return actionResult
            }
        )
        this.snapshotCache = null

        const persisted =
            resolution.shouldPersist &&
            !!storageKey &&
            !!result.path &&
            this.persistPath(
                storageKey,
                'select',
                options.description,
                result.path
            )

        return this.buildActionResult(
            storageKey,
            'select',
            Boolean(persisted),
            result.usedSelector
        )
    }

    async scroll(options: ScrollOptions = {}): Promise<ActionResult> {
        const storageKey = this.resolveStorageKey(options.description)
        const resolution = await this.resolvePath('scroll', options, true)

        if (resolution.counter != null) {
            const handle = await this.resolveCounterHandleForAction(
                'scroll',
                options.description,
                resolution.counter
            )
            let persistPath: ElementPath | null = null
            try {
                if (storageKey && resolution.shouldPersist) {
                    persistPath = await this.buildPathFromResolvedHandle(
                        handle,
                        'scroll',
                        resolution.counter
                    )
                }

                const delta = getScrollDelta(options)
                await this.runWithPostActionWait('scroll', options.wait, async () => {
                    await handle.evaluate((el, value) => {
                        if (el instanceof HTMLElement) {
                            el.scrollBy(value.x, value.y)
                        }
                    }, delta)
                })
            } catch (err) {
                const failure = classifyActionFailure({
                    action: 'scroll',
                    error: err,
                    fallbackMessage: defaultActionFailureMessage('scroll'),
                })
                throw this.buildActionError(
                    'scroll',
                    options.description,
                    failure,
                    `[c="${resolution.counter}"]`,
                    err
                )
            } finally {
                await handle.dispose()
            }

            this.snapshotCache = null

            const persisted =
                resolution.shouldPersist &&
                !!storageKey &&
                !!persistPath &&
                this.persistPath(
                    storageKey,
                    'scroll',
                    options.description,
                    persistPath
                )

            return this.buildActionResult(
                storageKey,
                'scroll',
                Boolean(persisted),
                `[c="${resolution.counter}"]`
            )
        }

        const result = await this.runWithPostActionWait(
            'scroll',
            options.wait,
            async () => {
                const actionResult = await performScroll(
                    this.page,
                    resolution.path,
                    options
                )

                if (!actionResult.ok) {
                    const failure =
                        actionResult.failure ||
                        classifyActionFailure({
                            action: 'scroll',
                            error:
                                actionResult.error ||
                                defaultActionFailureMessage('scroll'),
                            fallbackMessage: defaultActionFailureMessage('scroll'),
                        })
                    throw this.buildActionError(
                        'scroll',
                        options.description,
                        failure,
                        actionResult.usedSelector || null
                    )
                }

                return actionResult
            }
        )
        this.snapshotCache = null

        const persisted =
            resolution.shouldPersist &&
            !!storageKey &&
            !!result.path &&
            this.persistPath(
                storageKey,
                'scroll',
                options.description,
                result.path
            )

        return this.buildActionResult(
            storageKey,
            'scroll',
            Boolean(persisted),
            result.usedSelector
        )
    }

    // --- Tab Management ---

    async tabs(): Promise<TabInfo[]> {
        return listTabs(this.context, this.page)
    }

    async newTab(url?: string): Promise<TabInfo> {
        const { page, info } = await createTab(this.context, url)
        this.pageRef = page
        this.snapshotCache = null
        return info
    }

    async switchTab(index: number): Promise<void> {
        const page = await switchTab(this.context, index)
        this.pageRef = page
        this.snapshotCache = null
    }

    async closeTab(index?: number): Promise<void> {
        const newPage = await closeTab(this.context, this.page, index)
        if (newPage) {
            this.pageRef = newPage
        }
        this.snapshotCache = null
    }

    // --- Cookie Management ---

    async getCookies(url?: string): Promise<import('playwright').Cookie[]> {
        return getCookies(this.context, url)
    }

    async setCookie(cookie: CookieParam): Promise<void> {
        return setCookie(this.context, cookie)
    }

    async clearCookies(): Promise<void> {
        return clearCookies(this.context)
    }

    async exportCookies(filePath: string, url?: string): Promise<void> {
        return exportCookies(this.context, filePath, url)
    }

    async importCookies(filePath: string): Promise<void> {
        return importCookies(this.context, filePath)
    }

    // --- Keyboard Input ---

    async pressKey(key: string): Promise<void> {
        await this.runWithPostActionWait('pressKey', undefined, async () => {
            await pressKey(this.page, key)
        })
        this.snapshotCache = null
    }

    async type(text: string): Promise<void> {
        await this.runWithPostActionWait('type', undefined, async () => {
            await typeText(this.page, text)
        })
        this.snapshotCache = null
    }

    // --- Element Info ---

    async getElementText(options: BaseActionOptions): Promise<string> {
        return this.executeElementInfoAction(
            'getElementText',
            options,
            async (handle) => {
                const text = await handle.textContent()
                return text ?? ''
            },
            (path) => getElementText(this.page, path)
        )
    }

    async getElementValue(options: BaseActionOptions): Promise<string> {
        return this.executeElementInfoAction(
            'getElementValue',
            options,
            async (handle) => {
                return await handle.inputValue()
            },
            (path) => getElementValue(this.page, path)
        )
    }

    async getElementAttributes(
        options: BaseActionOptions
    ): Promise<Record<string, string>> {
        return this.executeElementInfoAction(
            'getElementAttributes',
            options,
            async (handle) => {
                return await handle.evaluate((el: Element) => {
                    const attrs: Record<string, string> = {}
                    for (const attr of el.attributes) {
                        attrs[attr.name] = attr.value
                    }
                    return attrs
                })
            },
            (path) => getElementAttributes(this.page, path)
        )
    }

    async getElementBoundingBox(
        options: BaseActionOptions
    ): Promise<BoundingBox | null> {
        return this.executeElementInfoAction(
            'getElementBoundingBox',
            options,
            async (handle) => {
                return await handle.boundingBox()
            },
            (path) => getElementBoundingBox(this.page, path)
        )
    }

    async getHtml(selector?: string): Promise<string> {
        return getPageHtml(this.page, selector)
    }

    async getTitle(): Promise<string> {
        return getPageTitle(this.page)
    }

    private async executeElementInfoAction<T>(
        method: string,
        options: BaseActionOptions,
        counterFn: (handle: ElementHandle) => Promise<T>,
        pathFn: (path: ElementPath) => Promise<T>
    ): Promise<T> {
        const storageKey = this.resolveStorageKey(options.description)
        const resolution = await this.resolvePath(method, options)

        if (resolution.counter != null) {
            const handle = await this.resolveCounterHandle(resolution.counter)
            try {
                if (storageKey && resolution.shouldPersist) {
                    const persistPath = await this.buildPathFromResolvedHandle(
                        handle,
                        method,
                        resolution.counter
                    )
                    this.persistPath(
                        storageKey,
                        method,
                        options.description,
                        persistPath
                    )
                }
                return await counterFn(handle)
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : `${method} failed.`
                throw new Error(message)
            } finally {
                await handle.dispose()
            }
        }

        if (!resolution.path) {
            throw new Error(`Unable to resolve element path for ${method}.`)
        }

        return pathFn(resolution.path)
    }

    // --- File Upload ---

    async uploadFile(options: FileUploadOptions): Promise<ActionResult> {
        const storageKey = this.resolveStorageKey(options.description)
        const resolution = await this.resolvePath('uploadFile', options)

        if (resolution.counter != null) {
            const handle = await this.resolveCounterHandleForAction(
                'uploadFile',
                options.description,
                resolution.counter
            )
            let persistPath: ElementPath | null = null
            try {
                if (storageKey && resolution.shouldPersist) {
                    persistPath = await this.buildPathFromResolvedHandle(
                        handle,
                        'uploadFile',
                        resolution.counter
                    )
                }
                await this.runWithPostActionWait(
                    'uploadFile',
                    options.wait,
                    async () => {
                        await handle.setInputFiles(options.paths)
                    }
                )
            } catch (err) {
                const failure = classifyActionFailure({
                    action: 'uploadFile',
                    error: err,
                    fallbackMessage: defaultActionFailureMessage('uploadFile'),
                })
                throw this.buildActionError(
                    'uploadFile',
                    options.description,
                    failure,
                    `[c="${resolution.counter}"]`,
                    err
                )
            } finally {
                await handle.dispose()
            }

            this.snapshotCache = null

            const persisted =
                resolution.shouldPersist &&
                !!storageKey &&
                !!persistPath &&
                this.persistPath(
                    storageKey,
                    'uploadFile',
                    options.description,
                    persistPath
                )

            return this.buildActionResult(
                storageKey,
                'uploadFile',
                Boolean(persisted),
                `[c="${resolution.counter}"]`
            )
        }

        if (!resolution.path) {
            throw new Error('Unable to resolve element path for file upload.')
        }
        const path = resolution.path

        const result = await this.runWithPostActionWait(
            'uploadFile',
            options.wait,
            async () => {
                const actionResult = await performFileUpload(
                    this.page,
                    path,
                    options.paths
                )

                if (!actionResult.ok) {
                    const failure =
                        actionResult.failure ||
                        classifyActionFailure({
                            action: 'uploadFile',
                            error:
                                actionResult.error ||
                                defaultActionFailureMessage('uploadFile'),
                            fallbackMessage:
                                defaultActionFailureMessage('uploadFile'),
                        })
                    throw this.buildActionError(
                        'uploadFile',
                        options.description,
                        failure,
                        actionResult.usedSelector || null
                    )
                }

                return actionResult
            }
        )
        this.snapshotCache = null

        const persisted =
            resolution.shouldPersist &&
            !!storageKey &&
            !!result.path &&
            this.persistPath(
                storageKey,
                'uploadFile',
                options.description,
                result.path
            )

        return this.buildActionResult(
            storageKey,
            'uploadFile',
            Boolean(persisted),
            result.usedSelector
        )
    }

    // --- Wait for Text ---

    async waitForText(
        text: string,
        options?: { timeout?: number }
    ): Promise<void> {
        await this.page
            .getByText(text)
            .first()
            .waitFor({ timeout: options?.timeout ?? 30000 })
    }

    async extract<T = unknown>(options: ExtractOptions): Promise<T> {
        const storageKey = this.resolveStorageKey(options.description)
        const schemaHash = options.schema
            ? computeSchemaHash(options.schema)
            : null

        const stored = storageKey ? this.storage.readSelector(storageKey) : null
        if (
            stored &&
            stored.method === 'extract' &&
            !options.element &&
            !options.selector &&
            (!schemaHash ||
                !stored.schemaHash ||
                stored.schemaHash === schemaHash)
        ) {
            let payload: PersistedExtractPayload
            try {
                payload = normalizePersistedExtractPayload(stored.path)
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : 'Unknown error'
                const selectorFile = storageKey
                    ? this.storage.getSelectorPath(storageKey)
                    : 'unknown selector file'
                throw new Error(
                    `Cached extraction selector is invalid for the current schema at "${selectorFile}". Delete the cached selector and rerun extraction. ${message}`
                )
            }
            const data = await this.extractPersistedPayload(payload)
            return data as T
        }

        const fields: ExtractFieldTarget[] = []

        if (!fields.length && options.schema) {
            const schemaFields = await this.buildFieldTargetsFromSchema(
                options.schema
            )
            fields.push(...schemaFields)
        }

        if (!fields.length) {
            const planResult = await this.parseAiExtractPlan(options)
            if (planResult.fields.length) {
                fields.push(...planResult.fields)
            } else if (planResult.data !== undefined) {
                return planResult.data as T
            }
        }

        if (!fields.length) {
            throw new Error(
                'Extraction did not resolve any field targets. Provide schema hints or a clearer description.'
            )
        }

        const data = await this.extractFields(fields)

        if (
            storageKey &&
            schemaHash &&
            (!stored || stored.schemaHash !== schemaHash)
        ) {
            const persistedFields =
                await this.resolveFieldTargetsToPersistableFields(fields)
            this.persistExtractPaths(
                storageKey,
                options.description,
                persistedFields,
                schemaHash
            )
        }

        return inflateExtractResult(data) as T
    }

    async extractFromPlan<T = unknown>(
        options: ExtractFromPlanOptions
    ): Promise<ExtractionRunResult<T>> {
        const storageKey = this.resolveStorageKey(options.description)
        const schemaHash = computeSchemaHash(options.schema)

        let fields = await this.buildFieldTargetsFromPlan(options.plan)

        if (!fields.length && options.plan.paths) {
            fields = Object.entries(options.plan.paths).map(([key, path]) => ({
                key,
                path: this.normalizePath(path),
            }))
        }

        if (!fields.length) {
            throw new Error(
                'extractFromPlan did not resolve any field targets.'
            )
        }

        const data = await this.extractFields(fields)
        const resolvedFields =
            await this.resolveFieldTargetsToPersistableFields(fields)

        let persisted = false
        if (storageKey) {
            this.persistExtractPaths(
                storageKey,
                options.description,
                resolvedFields,
                schemaHash
            )
            persisted = true
        }

        return {
            namespace: this.storage.getNamespace(),
            persisted,
            pathFile: storageKey
                ? this.storage.getSelectorFileName(storageKey)
                : null,
            data: inflateExtractResult(data) as T,
            paths: buildPathMap(toPathFields(resolvedFields)),
        }
    }

    getNamespace(): string {
        return this.namespace
    }

    getConfig(): OpensteerConfig {
        return this.config
    }

    getStorage(): LocalSelectorStorage {
        return this.storage
    }

    clearCache(): void {
        this.storage.clearNamespace()
        this.snapshotCache = null
    }

    private async runWithPostActionWait<T>(
        action: PostActionKind,
        waitOverride: BaseActionOptions['wait'],
        execute: () => Promise<T>
    ): Promise<T> {
        const waitSession = createPostActionWaitSession(
            this.page,
            action,
            waitOverride
        )

        try {
            const result = await execute()
            await waitSession.wait()
            return result
        } finally {
            waitSession.dispose()
        }
    }

    private async executeClickVariant(
        method: 'click' | 'dblclick' | 'rightclick',
        options: ClickOptions
    ): Promise<ActionResult> {
        const storageKey = this.resolveStorageKey(options.description)
        const resolution = await this.resolvePath('click', options)

        if (resolution.counter != null) {
            const handle = await this.resolveCounterHandleForAction(
                method,
                options.description,
                resolution.counter
            )
            let persistPath: ElementPath | null = null
            try {
                if (storageKey && resolution.shouldPersist) {
                    persistPath = await this.buildPathFromResolvedHandle(
                        handle,
                        'click',
                        resolution.counter
                    )
                }

                await this.runWithPostActionWait(method, options.wait, async () => {
                    await handle.click({
                        button: options.button,
                        clickCount: options.clickCount,
                        modifiers: options.modifiers,
                    })
                })
            } catch (err) {
                const failure = classifyActionFailure({
                    action: method,
                    error: err,
                    fallbackMessage: defaultActionFailureMessage(method),
                })
                throw this.buildActionError(
                    method,
                    options.description,
                    failure,
                    `[c="${resolution.counter}"]`,
                    err
                )
            } finally {
                await handle.dispose()
            }

            this.snapshotCache = null

            const persisted =
                resolution.shouldPersist &&
                !!storageKey &&
                !!persistPath &&
                this.persistPath(
                    storageKey,
                    'click',
                    options.description,
                    persistPath
                )

            return this.buildActionResult(
                storageKey,
                method,
                Boolean(persisted),
                `[c="${resolution.counter}"]`
            )
        }

        if (!resolution.path) {
            throw new Error('Unable to resolve element path for click action.')
        }
        const path = resolution.path

        const result = await this.runWithPostActionWait(
            method,
            options.wait,
            async () => {
                const actionResult = await performClick(this.page, path, options)
                if (!actionResult.ok) {
                    const failure =
                        actionResult.failure ||
                        classifyActionFailure({
                            action: method,
                            error:
                                actionResult.error ||
                                defaultActionFailureMessage(method),
                            fallbackMessage: defaultActionFailureMessage(method),
                        })
                    throw this.buildActionError(
                        method,
                        options.description,
                        failure,
                        actionResult.usedSelector || null
                    )
                }
                return actionResult
            }
        )
        this.snapshotCache = null

        const persisted =
            resolution.shouldPersist &&
            !!storageKey &&
            !!result.path &&
            this.persistPath(
                storageKey,
                'click',
                options.description,
                result.path
            )

        return this.buildActionResult(
            storageKey,
            method,
            Boolean(persisted),
            result.usedSelector
        )
    }

    private async resolvePath(
        action: string,
        options: {
            description?: string
            element?: number
            selector?: string
        },
        allowMissing = false
    ): Promise<PathResolutionResult> {
        const storageKey = this.resolveStorageKey(options.description)

        if (storageKey) {
            const stored = this.storage.readSelector<ElementPath>(storageKey)
            if (stored && stored.method !== 'extract') {
                return {
                    path: this.normalizePath(stored.path),
                    counter: null,
                    shouldPersist: false,
                    source: 'stored',
                }
            }
        }

        if (options.element != null) {
            const pathFromElement = await this.tryBuildPathFromCounter(
                options.element
            )
            if (pathFromElement) {
                return {
                    path: pathFromElement,
                    counter: null,
                    shouldPersist: Boolean(storageKey),
                    source: 'element',
                }
            }

            return {
                path: null,
                counter: options.element,
                shouldPersist: Boolean(storageKey),
                source: 'element',
            }
        }

        if (options.selector) {
            const path = await this.buildPathFromSelector(options.selector)
            if (!path) {
                throw new Error(
                    `Unable to build element path from selector: ${options.selector}`
                )
            }
            return {
                path,
                counter: null,
                shouldPersist: Boolean(storageKey),
                source: 'selector',
            }
        }

        if (options.description) {
            const resolved = await this.resolvePathWithAi(
                action,
                options.description
            )
            if (resolved?.counter != null) {
                const pathFromAiCounter = await this.tryBuildPathFromCounter(
                    resolved.counter
                )
                if (pathFromAiCounter) {
                    return {
                        path: pathFromAiCounter,
                        counter: null,
                        shouldPersist: Boolean(storageKey),
                        source: 'ai',
                    }
                }

                return {
                    path: null,
                    counter: resolved.counter,
                    shouldPersist: Boolean(storageKey),
                    source: 'ai',
                }
            }
            if (resolved?.path) {
                return {
                    path: resolved.path,
                    counter: null,
                    shouldPersist: Boolean(storageKey),
                    source: 'ai',
                }
            }
        }

        if (allowMissing) {
            return {
                path: null,
                counter: null,
                shouldPersist: false,
                source: 'none',
            }
        }

        throw new Error(
            `Could not resolve path for ${action}. Provide element, selector, or description.`
        )
    }

    private async resolvePathWithAi(
        action: string,
        description: string
    ): Promise<{ path?: ElementPath; counter?: number } | null> {
        const html = await this.snapshot({ mode: 'action' })

        const response = await this.aiResolve({
            html,
            action,
            description,
            url: this.page.url(),
        })

        if (typeof response === 'number') {
            return {
                counter: response,
            }
        }

        if (typeof response === 'string') {
            const parsedCounter = Number.parseInt(response, 10)
            if (
                Number.isFinite(parsedCounter) &&
                String(parsedCounter) === response.trim()
            ) {
                return {
                    counter: parsedCounter,
                }
            }

            const path = await this.buildPathFromSelector(response)
            return path
                ? {
                      path,
                  }
                : null
        }

        if (!response || typeof response !== 'object') {
            return null
        }

        const record = response as {
            element?: number
            selector?: string
            path?: ElementPath
        }

        if (record.path) {
            return {
                path: this.normalizePath(record.path),
            }
        }

        if (record.element != null) {
            return {
                counter: record.element,
            }
        }

        if (record.selector) {
            const path = await this.buildPathFromSelector(record.selector)
            return path
                ? {
                      path,
                  }
                : null
        }

        return null
    }

    private async buildPathFromElement(
        element: number
    ): Promise<ElementPath | null> {
        const indexedPath = await this.readPathFromCounterIndex(element)
        const handle = await this.resolveCounterHandle(element)

        try {
            const builtPath = await buildElementPathFromHandle(handle)
            if (builtPath) {
                return this.withIndexedIframeContext(builtPath, indexedPath)
            }
            return indexedPath
        } finally {
            await handle.dispose()
        }
    }

    private async tryBuildPathFromCounter(
        counter: number
    ): Promise<ElementPath | null> {
        try {
            return await this.buildPathFromElement(counter)
        } catch {
            return null
        }
    }

    private async resolveCounterHandle(element: number) {
        const snapshot = await this.ensureSnapshotWithCounters()
        return resolveCounterElement(this.page, snapshot, element)
    }

    private async resolveCounterHandleForAction(
        action: string,
        description: string | undefined,
        element: number
    ): Promise<ElementHandle> {
        try {
            return await this.resolveCounterHandle(element)
        } catch (err) {
            const failure = classifyActionFailure({
                action,
                error: err,
                fallbackMessage: defaultActionFailureMessage(action),
            })
            throw this.buildActionError(
                action,
                description,
                failure,
                `[c="${element}"]`,
                err
            )
        }
    }

    private async buildPathFromResolvedHandle(
        handle: ElementHandle,
        action: string,
        counter: number
    ): Promise<ElementPath> {
        const indexedPath = await this.readPathFromCounterIndex(counter)
        const builtPath = await buildElementPathFromHandle(handle)
        if (builtPath) {
            const normalized = this.withIndexedIframeContext(
                builtPath,
                indexedPath
            )
            if (normalized.nodes.length) return normalized
        }
        if (indexedPath) return indexedPath

        throw new Error(
            `Unable to build element path from counter ${counter} during ${action}.`
        )
    }

    private withIndexedIframeContext(
        builtPath: ElementPath,
        indexedPath: ElementPath | null
    ): ElementPath {
        const normalizedBuilt = this.normalizePath(builtPath)
        if (!indexedPath) return normalizedBuilt

        const iframePrefix = collectIframeContextPrefix(indexedPath)
        if (!iframePrefix.length) return normalizedBuilt

        const merged: ElementPath = {
            context: [
                ...cloneContextHops(iframePrefix),
                ...cloneContextHops(normalizedBuilt.context),
            ],
            nodes: cloneElementPath(normalizedBuilt).nodes,
        }

        const normalized = this.normalizePath(merged)
        if (normalized.nodes.length) return normalized

        const fallback = this.normalizePath(indexedPath)
        if (fallback.nodes.length) return fallback

        return normalizedBuilt
    }

    private async readPathFromCounterIndex(
        counter: number
    ): Promise<ElementPath | null> {
        const snapshot = await this.ensureSnapshotWithCounters()
        const indexed = snapshot.counterIndex?.get(counter)
        if (!indexed) return null
        const normalized = this.normalizePath(indexed)
        if (!normalized.nodes.length) return null
        return normalized
    }

    private async buildPathFromSelector(
        selector: string
    ): Promise<ElementPath | null> {
        const path = await buildElementPathFromSelector(this.page, selector)
        if (!path) return null
        return this.normalizePath(path)
    }

    private async ensureSnapshotWithCounters(): Promise<PreparedSnapshot> {
        if (
            !this.snapshotCache ||
            !this.snapshotCache.counterBindings ||
            this.snapshotCache.url !== this.page.url()
        ) {
            await this.snapshot({
                mode: 'full',
                withCounters: true,
            })
        }

        return this.snapshotCache as PreparedSnapshot
    }

    private persistPath(
        id: string,
        method: string,
        description: string | undefined,
        path: ElementPath
    ): boolean {
        const now = Date.now()
        const safeFile = this.storage.getSelectorFileName(id)

        const existing = this.storage.readSelector(id)
        const createdAt = existing?.metadata?.createdAt || now

        const payload: SelectorFile<ElementPath> = {
            id,
            method,
            description: description || `${method} path`,
            path: this.normalizePath(path),
            metadata: {
                createdAt,
                updatedAt: now,
                sourceUrl: this.page.url(),
            },
        }

        this.storage.writeSelector(payload)

        const registry = this.storage.loadRegistry()
        registry.selectors[id] = {
            file: safeFile,
            method,
            description,
            createdAt: registry.selectors[id]?.createdAt || createdAt,
            updatedAt: now,
        }
        this.storage.saveRegistry(registry)

        return true
    }

    private persistExtractPaths(
        id: string,
        description: string | undefined,
        fields: PersistableExtractField[],
        schemaHash: string
    ): boolean {
        const now = Date.now()
        const safeFile = this.storage.getSelectorFileName(id)

        const existing = this.storage.readSelector(id)
        const createdAt = existing?.metadata?.createdAt || now

        const normalizedFields: PersistableExtractField[] = fields.map(
            (field) => {
                if (!isPersistablePathField(field)) {
                    return {
                        key: field.key,
                        source: 'current_url',
                    }
                }

                return {
                    key: field.key,
                    path: this.normalizePath(field.path),
                    attribute: field.attribute,
                }
            }
        )
        const persistedPayload = buildPersistedExtractPayload(normalizedFields)

        const payload: SelectorFile<PersistedExtractPayload> = {
            id,
            method: 'extract',
            description: description || 'Extraction paths',
            path: persistedPayload,
            schemaHash,
            metadata: {
                createdAt,
                updatedAt: now,
                sourceUrl: this.page.url(),
            },
        }

        this.storage.writeSelector(payload)

        const registry = this.storage.loadRegistry()
        registry.selectors[id] = {
            file: safeFile,
            method: 'extract',
            description,
            createdAt: registry.selectors[id]?.createdAt || createdAt,
            updatedAt: now,
        }
        this.storage.saveRegistry(registry)

        return true
    }

    private async extractPersistedPayload(
        payload: PersistedExtractPayload
    ): Promise<Record<string, unknown>> {
        return this.extractPersistedObjectNode(payload)
    }

    private async extractPersistedObjectNode(
        node: PersistedExtractObjectNode
    ): Promise<Record<string, unknown>> {
        const result: Record<string, unknown> = {}
        const pageUrl = this.page.url()

        for (const [key, child] of Object.entries(node)) {
            if (isPersistedValueNode(child)) {
                const values = await extractWithPaths(this.page, [
                    {
                        key: 'value',
                        path: this.normalizePath(child.$path),
                        attribute: child.attribute,
                    },
                ])
                result[key] = values.value ?? null
                continue
            }

            if (isPersistedSourceNode(child)) {
                result[key] = pageUrl
                continue
            }

            if (!isPersistedArrayNode(child)) {
                result[key] = await this.extractPersistedObjectNode(child)
                continue
            }

            result[key] = await this.extractPersistedArrayVariants(
                child,
                key,
                pageUrl
            )
        }

        return result
    }

    private async extractPersistedArrayVariants(
        arrayNode: PersistedExtractArrayNode,
        fieldKey: string,
        pageUrl: string
    ): Promise<unknown[]> {
        const rowsByIdentity = new Map<string, MergedArrayVariantRow>()

        for (const variant of arrayNode.$array.variants) {
            const descriptors = collectArrayItemFieldDescriptors(variant.item)
            const extracted = await this.extractPersistedArrayVariantRows(
                variant,
                descriptors,
                fieldKey,
                pageUrl
            )

            for (const row of extracted) {
                const existing = rowsByIdentity.get(row.identity)
                if (!existing || row.coverage > existing.coverage) {
                    rowsByIdentity.set(row.identity, row)
                }
            }
        }

        return [...rowsByIdentity.values()]
            .sort((left, right) => {
                if (left.order !== right.order) {
                    return left.order - right.order
                }
                return left.identity.localeCompare(right.identity)
            })
            .map((row) => row.value)
    }

    private async extractPersistedArrayVariantRows(
        variant: PersistedExtractArrayNode['$array']['variants'][number],
        descriptors: ArrayItemFieldDescriptor[],
        fieldKey: string,
        pageUrl: string
    ): Promise<MergedArrayVariantRow[]> {
        const pathFields = descriptors
            .filter((descriptor): descriptor is ArrayItemPathFieldDescriptor => {
                return descriptor.kind === 'path'
            })
            .map((descriptor) => ({
                key: descriptor.path,
                path: this.normalizePath(descriptor.selector.elementPath),
                attribute: descriptor.selector.attribute,
            }))

        const currentUrlFields = descriptors
            .filter(
                (
                    descriptor
                ): descriptor is ArrayItemSourceFieldDescriptor =>
                    descriptor.kind === 'source'
            )
            .map((descriptor) => descriptor.path)

        const extractedRows = await extractArrayRowsWithPaths(this.page, {
            itemParentPath: this.normalizePath(variant.itemParentPath),
            fields: pathFields,
        })

        const isPrimitiveArrayItem = descriptors.every((descriptor) => {
            return String(descriptor.path || '').trim() === ''
        })

        return extractedRows.map((row) => {
            const flat = row.values as Record<string, unknown>

            for (const fieldPath of currentUrlFields) {
                if (!fieldPath) {
                    flat.value = pageUrl
                    continue
                }
                flat[fieldPath] = pageUrl
            }

            const value = isPrimitiveArrayItem
                ? (flat.value ?? null)
                : inflateExtractResult(flat)

            return {
                identity: row.meta.key,
                order: row.meta.order,
                coverage: computeArrayRowCoverage(value, flat),
                value,
            }
        })
    }

    private async parseAiExtractPlan(
        options: ExtractOptions
    ): Promise<ParsedAiExtractResult> {
        const html = await this.snapshot({
            mode: 'extraction',
            withCounters: true,
            ...(options.snapshot || {}),
        })

        const response = await this.aiExtract({
            html,
            schema: options.schema,
            description: options.description,
            prompt: options.prompt,
            url: this.page.url(),
        })

        const normalized = parseAiExtractResponse(response)
        const dataFields =
            normalized.data !== undefined
                ? await this.buildFieldTargetsFromData(normalized.data)
                : []
        const dataFallback = (): ParsedAiExtractResult =>
            dataFields.length
                ? { fields: dataFields }
                : {
                      fields: [],
                      data: normalized.data,
                  }

        if (
            normalized.data !== undefined &&
            !normalized.fields &&
            !normalized.paths
        ) {
            return dataFallback()
        }

        let fields = await this.buildFieldTargetsFromPlan(normalized)

        if (!fields.length && normalized.paths) {
            fields = Object.entries(normalized.paths).map(([key, path]) => ({
                key,
                path: this.normalizePath(path),
            }))
        }

        if (!fields.length && normalized.data !== undefined) {
            return dataFallback()
        }

        return {
            fields,
        }
    }

    private async buildFieldTargetsFromSchema(
        schema: unknown
    ): Promise<ExtractFieldTarget[]> {
        if (!schema || typeof schema !== 'object') {
            return []
        }

        // Top-level arrays aren't a valid schema root
        if (Array.isArray(schema)) {
            return []
        }

        const fields: ExtractFieldTarget[] = []
        await this.collectFieldTargetsFromSchemaObject(
            schema as Record<string, unknown>,
            '',
            fields
        )
        return fields
    }

    private async collectFieldTargetsFromSchemaObject(
        obj: Record<string, unknown>,
        prefix: string,
        fields: ExtractFieldTarget[]
    ): Promise<void> {
        for (const [key, value] of Object.entries(obj)) {
            const fieldKey = prefix ? `${prefix}.${key}` : key
            await this.collectFieldTargetsFromValue(fieldKey, value, fields)
        }
    }

    private async collectFieldTargetsFromValue(
        fieldKey: string,
        value: unknown,
        fields: ExtractFieldTarget[]
    ): Promise<void> {
        if (!value || typeof value !== 'object') {
            return
        }

        // Arrays: iterate items and recurse with indexed keys
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                const item = value[i]
                const indexedKey = `${fieldKey}[${i}]`
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    await this.collectFieldTargetsFromSchemaObject(
                        item as Record<string, unknown>,
                        indexedKey,
                        fields
                    )
                } else {
                    await this.collectFieldTargetsFromValue(
                        indexedKey,
                        item,
                        fields
                    )
                }
            }
            return
        }

        // Try to interpret as a schema field (has element, selector, or source)
        const normalized = normalizeSchemaValue(value as ExtractSchemaValue)
        if (normalized) {
            if (normalized.source === 'current_url') {
                fields.push({ key: fieldKey, source: 'current_url' })
                return
            }

            if (normalized.element != null) {
                const path = await this.tryBuildPathFromCounter(
                    normalized.element
                )
                if (path) {
                    fields.push({
                        key: fieldKey,
                        path,
                        attribute: normalized.attribute,
                    })
                    return
                }

                fields.push({
                    key: fieldKey,
                    counter: normalized.element,
                    attribute: normalized.attribute,
                })
                return
            }

            if (normalized.selector) {
                const path = await this.buildPathFromSelector(
                    normalized.selector
                )
                if (path) {
                    fields.push({
                        key: fieldKey,
                        path,
                        attribute: normalized.attribute,
                    })
                }
                return
            }
        }

        // Not a schema field -- recurse into nested object
        await this.collectFieldTargetsFromSchemaObject(
            value as Record<string, unknown>,
            fieldKey,
            fields
        )
    }

    private async buildFieldTargetsFromPlan(
        plan: ExtractionPlan
    ): Promise<ExtractFieldTarget[]> {
        const fields: ExtractFieldTarget[] = []
        if (!plan.fields) return fields

        for (const [key, fieldPlan] of Object.entries(plan.fields)) {
            if (!fieldPlan) continue

            if (normalizeExtractSource(fieldPlan.source) === 'current_url') {
                fields.push({
                    key,
                    source: 'current_url',
                })
                continue
            }

            if (fieldPlan.element != null) {
                const path = await this.tryBuildPathFromCounter(fieldPlan.element)
                if (path) {
                    fields.push({
                        key,
                        path,
                        attribute: fieldPlan.attribute,
                    })
                    continue
                }

                fields.push({
                    key,
                    counter: fieldPlan.element,
                    attribute: fieldPlan.attribute,
                })
                continue
            }

            if (!fieldPlan.selector) continue
            const path = await this.buildPathFromSelector(fieldPlan.selector)
            if (!path) continue

            fields.push({
                key,
                path,
                attribute: fieldPlan.attribute,
            })
        }

        return fields
    }

    private async buildFieldTargetsFromData(
        data: unknown
    ): Promise<ExtractFieldTarget[]> {
        const fieldPlan = flattenExtractionDataToFieldPlan(data)
        if (!Object.keys(fieldPlan).length) return []
        return this.buildFieldTargetsFromPlan({ fields: fieldPlan })
    }

    private async extractFields(
        fields: ExtractFieldTarget[]
    ): Promise<Record<string, unknown>> {
        const result: Record<string, unknown> = {}
        const pathFields: FieldSelector[] = []
        const counterRequests: CounterRequest[] = []
        const currentUrlKeys: string[] = []

        for (const field of fields) {
            if ('source' in field) {
                currentUrlKeys.push(field.key)
                continue
            }

            if ('counter' in field) {
                counterRequests.push({
                    key: field.key,
                    counter: field.counter,
                    attribute: field.attribute,
                })
                continue
            }

            pathFields.push({
                key: field.key,
                path: this.normalizePath(field.path),
                attribute: field.attribute,
            })
        }

        if (currentUrlKeys.length) {
            const pageUrl = this.page.url()
            for (const key of currentUrlKeys) {
                result[key] = pageUrl
            }
        }

        if (counterRequests.length) {
            const snapshot = await this.ensureSnapshotWithCounters()
            const counterValues = await resolveCountersBatch(
                this.page,
                snapshot,
                counterRequests
            )
            Object.assign(result, counterValues)
        }

        if (pathFields.length) {
            const pathValues = await extractWithPaths(this.page, pathFields)
            Object.assign(result, pathValues)
        }

        return result
    }

    private async resolveFieldTargetsToPersistableFields(
        fields: ExtractFieldTarget[]
    ): Promise<PersistableExtractField[]> {
        const resolved: PersistableExtractField[] = []

        for (const field of fields) {
            if ('source' in field) {
                resolved.push({
                    key: field.key,
                    source: 'current_url',
                })
                continue
            }

            if ('path' in field) {
                resolved.push({
                    key: field.key,
                    path: this.normalizePath(field.path),
                    attribute: field.attribute,
                })
                continue
            }

            const path = await this.buildPathFromElement(field.counter)
            if (!path) {
                throw new Error(
                    `Unable to build element path from counter ${field.counter} for extraction field "${field.key}".`
                )
            }

            resolved.push({
                key: field.key,
                path,
                attribute: field.attribute,
            })
        }

        return resolved
    }

    private buildActionResult(
        storageKey: string | null,
        method: string,
        persisted: boolean,
        selectorUsed?: string
    ): ActionResult {
        return {
            method,
            namespace: this.storage.getNamespace(),
            persisted,
            pathFile:
                storageKey && persisted
                    ? this.storage.getSelectorFileName(storageKey)
                    : null,
            selectorUsed: selectorUsed || null,
        }
    }

    private resolveStorageKey(description?: string): string | null {
        if (!description) return null
        return createHash('sha256')
            .update(description)
            .digest('hex')
            .slice(0, 16)
    }

    private normalizePath(path: ElementPath): ElementPath {
        return sanitizeElementPath(path)
    }
}

function resolveCloudBaseUrl(): string {
    const value = process.env.OPENSTEER_CLOUD_BASE_URL?.trim()
    if (!value) return DEFAULT_CLOUD_BASE_URL
    return value.replace(/\/+$/, '')
}

function formatActionFailureMessage(
    action: string,
    description: string | undefined,
    cause: string
): string {
    const label = description ? `"${description}"` : 'unnamed target'
    return `${action} action failed for ${label}: ${cause}`
}

function readCloudActionDescription(
    payload: Record<string, unknown>
): string | undefined {
    const description = payload.description
    if (typeof description !== 'string') return undefined
    const normalized = description.trim()
    return normalized.length ? normalized : undefined
}

function cloneContextHops(
    context: ElementPath['context'] | undefined
): ElementPath['context'] {
    return JSON.parse(JSON.stringify(context || [])) as ElementPath['context']
}

function collectIframeContextPrefix(path: ElementPath): ElementPath['context'] {
    const context = path.context || []
    let lastIframeIndex = -1

    for (let index = 0; index < context.length; index += 1) {
        if (context[index]?.kind === 'iframe') {
            lastIframeIndex = index
        }
    }

    if (lastIframeIndex < 0) return []
    return cloneContextHops(context.slice(0, lastIframeIndex + 1))
}

function normalizeSchemaValue(
    value: ExtractSchemaValue
): ExtractSchemaField | null {
    if (!value) return null

    if (typeof value !== 'object' || Array.isArray(value)) {
        return null
    }

    const field = value as ExtractSchemaField
    return {
        element: field.element,
        selector: field.selector,
        attribute: field.attribute,
        source: normalizeExtractSource(field.source),
    }
}

function normalizeExtractSource(
    source: unknown
): ExtractSchemaField['source'] | undefined {
    if (typeof source !== 'string') return undefined
    const normalized = source.trim().toLowerCase()
    if (normalized === 'current_url') return 'current_url'
    return undefined
}

function computeSchemaHash(schema: unknown): string {
    const stable = stableStringify(schema)
    return createHash('sha256').update(stable).digest('hex')
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`
    }

    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).sort(
            ([a], [b]) => a.localeCompare(b)
        )
        const serializedEntries = entries
            .map(
                ([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`
            )
            .join(',')
        return `{${serializedEntries}}`
    }

    return JSON.stringify(value)
}

function buildPathMap(fields: FieldSelector[]): Record<string, ElementPath> {
    const out: Record<string, ElementPath> = {}

    for (const field of fields) {
        out[field.key] = cloneElementPath(field.path)
    }

    return out
}

function toPathFields(fields: PersistableExtractField[]): FieldSelector[] {
    return fields.filter(isPersistablePathField).map((field) => ({
        key: field.key,
        path: field.path,
        attribute: field.attribute,
    }))
}

interface DataPathPropertyToken {
    kind: 'prop'
    key: string
}

interface DataPathIndexToken {
    kind: 'index'
    index: number
}

type DataPathToken = DataPathPropertyToken | DataPathIndexToken

function inflateExtractResult(flat: Record<string, unknown>): unknown {
    let root: unknown = {}
    let initialized = false

    for (const [path, value] of Object.entries(flat || {})) {
        const tokens = parseDataPath(path)
        if (!tokens || !tokens.length) continue

        if (!initialized) {
            root = tokens[0]?.kind === 'index' ? [] : {}
            initialized = true
        }

        if (tokens[0]?.kind === 'index' && !Array.isArray(root)) continue
        if (tokens[0]?.kind === 'prop' && Array.isArray(root)) continue

        assignPathValue(root, tokens, value)
    }

    return initialized ? root : {}
}

function assignPathValue(
    root: unknown,
    tokens: DataPathToken[],
    value: unknown
): void {
    if (!tokens.length) return
    let current: unknown = root

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        const next = tokens[i + 1]
        const isLast = i === tokens.length - 1

        if (token.kind === 'prop') {
            if (
                !current ||
                typeof current !== 'object' ||
                Array.isArray(current)
            ) {
                return
            }

            const objectRef = current as Record<string, unknown>
            if (isLast) {
                objectRef[token.key] = value
                return
            }

            if (next?.kind === 'index') {
                if (!Array.isArray(objectRef[token.key])) {
                    objectRef[token.key] = []
                }
            } else {
                const nextValue = objectRef[token.key]
                if (
                    !nextValue ||
                    typeof nextValue !== 'object' ||
                    Array.isArray(nextValue)
                ) {
                    objectRef[token.key] = {}
                }
            }

            current = objectRef[token.key]
            continue
        }

        if (!Array.isArray(current)) return
        if (isLast) {
            current[token.index] = value
            return
        }

        if (next?.kind === 'index') {
            if (!Array.isArray(current[token.index])) {
                current[token.index] = []
            }
        } else {
            const nextValue = current[token.index]
            if (
                !nextValue ||
                typeof nextValue !== 'object' ||
                Array.isArray(nextValue)
            ) {
                current[token.index] = {}
            }
        }

        current = current[token.index]
    }
}

function parseDataPath(path: string): DataPathToken[] | null {
    const input = String(path || '').trim()
    if (!input) return []
    if (input.includes('..')) return null
    if (input.startsWith('.') || input.endsWith('.')) return null

    const tokens: DataPathToken[] = []
    let cursor = 0

    while (cursor < input.length) {
        const char = input[cursor]
        if (char === '.') {
            cursor++
            continue
        }

        if (char === '[') {
            const close = input.indexOf(']', cursor + 1)
            if (close === -1) return null
            const rawIndex = input.slice(cursor + 1, close).trim()
            if (!/^\d+$/.test(rawIndex)) return null
            tokens.push({
                kind: 'index',
                index: Number.parseInt(rawIndex, 10),
            })
            cursor = close + 1
            continue
        }

        let end = cursor
        while (end < input.length && input[end] !== '.' && input[end] !== '[') {
            end++
        }
        const key = input.slice(cursor, end).trim()
        if (!key) return null
        tokens.push({ kind: 'prop', key })
        cursor = end
    }

    return tokens
}

function normalizePersistedExtractPayload(
    raw: unknown
): PersistedExtractPayload {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(
            'Invalid persisted extraction payload: expected an object payload.'
        )
    }

    const root: PersistedExtractObjectNode = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const normalizedKey = String(key || '').trim()
        if (!normalizedKey) continue
        if (normalizedKey.startsWith('$')) {
            throw new Error(
                `Invalid persisted extraction payload key "${normalizedKey}": root keys must not start with "$".`
            )
        }
        root[normalizedKey] = normalizePersistedExtractNode(
            value,
            normalizedKey
        )
    }

    return root
}

function normalizePersistedExtractNode(
    raw: unknown,
    label: string
): PersistedExtractNode {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(
            `Invalid persisted extraction node at "${label}": expected an object.`
        )
    }

    const record = raw as Record<string, unknown>
    if (record.$path) {
        if (typeof record.$path !== 'object') {
            throw new Error(
                `Invalid persisted extraction value node at "${label}": "$path" must be an element path object.`
            )
        }
        return {
            $path: sanitizeElementPath(record.$path as ElementPath),
            attribute:
                typeof record.attribute === 'string'
                    ? record.attribute
                    : undefined,
        }
    }

    if (record.$source != null) {
        const source = normalizeExtractSource(record.$source)
        if (!source) {
            throw new Error(
                `Invalid persisted extraction source node at "${label}": unsupported "$source" value.`
            )
        }
        return {
            $source: source,
        }
    }

    if (record.$array) {
        if (
            !record.$array ||
            typeof record.$array !== 'object' ||
            Array.isArray(record.$array)
        ) {
            throw new Error(
                `Invalid persisted extraction array node at "${label}": "$array" must be an object.`
            )
        }

        const arrayRecord = record.$array as Record<string, unknown>
        if (
            arrayRecord.itemParentPath !== undefined ||
            arrayRecord.item !== undefined
        ) {
            throw new Error(
                `Legacy persisted extraction array format detected at "${label}". Clear cached selectors in .opensteer/selectors/<namespace> and rerun extraction.`
            )
        }

        if (!Array.isArray(arrayRecord.variants) || !arrayRecord.variants.length) {
            throw new Error(
                `Invalid persisted extraction array node at "${label}": variants must be a non-empty array.`
            )
        }

        const variants = arrayRecord.variants.map((variantRaw, index) => {
            if (
                !variantRaw ||
                typeof variantRaw !== 'object' ||
                Array.isArray(variantRaw)
            ) {
                throw new Error(
                    `Invalid persisted extraction array variant at "${label}"[${index}]: expected an object.`
                )
            }

            const variant = variantRaw as Record<string, unknown>
            if (
                !variant.itemParentPath ||
                typeof variant.itemParentPath !== 'object'
            ) {
                throw new Error(
                    `Invalid persisted extraction array variant at "${label}"[${index}]: itemParentPath is required.`
                )
            }
            if (
                !variant.item ||
                typeof variant.item !== 'object' ||
                Array.isArray(variant.item)
            ) {
                throw new Error(
                    `Invalid persisted extraction array variant at "${label}"[${index}]: item is required.`
                )
            }

            return {
                itemParentPath: sanitizeElementPath(
                    variant.itemParentPath as ElementPath
                ),
                item: normalizePersistedExtractNode(
                    variant.item,
                    `${label}[${index}]`
                ),
            }
        })

        return {
            $array: {
                variants,
            },
        }
    }

    const objectNode: PersistedExtractObjectNode = {}
    for (const [key, value] of Object.entries(record)) {
        const normalizedKey = String(key || '').trim()
        if (!normalizedKey) continue
        if (normalizedKey.startsWith('$')) {
            throw new Error(
                `Invalid persisted extraction node at "${label}": unexpected reserved key "${normalizedKey}".`
            )
        }
        objectNode[normalizedKey] = normalizePersistedExtractNode(
            value,
            `${label}.${normalizedKey}`
        )
    }

    return objectNode
}

function computeArrayRowCoverage(
    value: unknown,
    flat: Record<string, unknown>
): number {
    if (isPrimitiveLike(value)) {
        return value == null ? 0 : 1
    }

    const flatCoverage = Object.values(flat).reduce<number>((sum, current) => {
        return current == null ? sum : sum + 1
    }, 0)
    if (flatCoverage > 0) return flatCoverage

    return countNonNullLeaves(value)
}

function countNonNullLeaves(value: unknown): number {
    if (value == null) return 0

    if (Array.isArray(value)) {
        return value.reduce<number>(
            (sum, current) => sum + countNonNullLeaves(current),
            0
        )
    }

    if (typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).reduce<number>(
            (sum, current) => sum + countNonNullLeaves(current),
            0
        )
    }

    return 1
}

function isPrimitiveLike(value: unknown): boolean {
    return (
        value == null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
    )
}

function parseAiExtractResponse(response: unknown): ExtractionPlan {
    if (typeof response === 'string') {
        const trimmed = stripCodeFence(response)
        try {
            return JSON.parse(trimmed) as ExtractionPlan
        } catch {
            throw new Error('LLM extraction returned a non-JSON string.')
        }
    }

    if (response && typeof response === 'object') {
        const candidate = response as ExtractionPlan
        if (
            candidate.fields ||
            candidate.paths ||
            candidate.data !== undefined
        ) {
            return candidate
        }
    }

    return {
        data: response,
    }
}

function stripCodeFence(input: string): string {
    const trimmed = input.trim()
    if (!trimmed.startsWith('```')) return trimmed

    const firstBreak = trimmed.indexOf('\n')
    if (firstBreak === -1) {
        return trimmed.replace(/```/g, '').trim()
    }

    const withoutHeader = trimmed.slice(firstBreak + 1)
    const lastFence = withoutHeader.lastIndexOf('```')
    if (lastFence === -1) return withoutHeader.trim()

    return withoutHeader.slice(0, lastFence).trim()
}

function getScrollDelta(options: ScrollOptions): { x: number; y: number } {
    const amount = typeof options.amount === 'number' ? options.amount : 600
    const absoluteAmount = Math.abs(amount)

    switch (options.direction) {
        case 'up':
            return { x: 0, y: -absoluteAmount }
        case 'left':
            return { x: -absoluteAmount, y: 0 }
        case 'right':
            return { x: absoluteAmount, y: 0 }
        case 'down':
        default:
            return { x: 0, y: absoluteAmount }
    }
}
