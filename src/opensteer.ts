import { createHash, randomUUID } from 'crypto'
import type { Browser, BrowserContext, ElementHandle, Page } from 'playwright'
import { BrowserPool } from './browser/pool.js'
import {
    resolveConfigWithEnv,
    resolveCloudSelection,
    resolveNamespace,
    type RuntimeEnv,
} from './config.js'
import { waitForVisualStability } from './navigation.js'
import type {
    ActionResult,
    AiExtractCallback,
    AiResolveCallback,
    OpensteerAgentConfig,
    OpensteerAgentExecuteOptions,
    OpensteerAgentInstance,
    OpensteerAgentResult,
    OpensteerCursorState,
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
    OpensteerCloudBrowserProfileOptions,
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
import { resolveElementPath } from './element-path/resolver.js'
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
import { stripRedundantPositionClauses } from './extraction/array-field-validation.js'
import { inflateDataPathObject } from './extraction/data-path.js'
import {
    cloudSessionContractVersion as CLOUD_SESSION_CONTRACT_VERSION,
    type CloudActionMethod,
    type CloudSessionLaunchConfig,
} from './cloud/contracts.js'
import { ActionWsClient } from './cloud/action-ws-client.js'
import { selectCloudCredential } from './cloud/credential-selection.js'
import {
    cloudNotLaunchedError,
    OpensteerCloudError,
    cloudUnsupportedMethodError,
} from './cloud/errors.js'
import { collectLocalSelectorCacheEntries } from './cloud/local-cache-sync.js'
import {
    createCloudRuntimeState,
    readCloudActionDescription,
    type CloudRuntimeState,
} from './cloud/runtime.js'
import { stableStringify } from './utils/stable-stringify.js'
import { createCuaClient, resolveAgentConfig } from './agent/provider.js'
import { OpensteerCuaAgentHandler } from './agent/handler.js'
import { normalizeExecuteOptions } from './agent/client.js'
import { OpensteerAgentBusyError } from './agent/errors.js'
import { extractErrorMessage, normalizeError } from './error-normalization.js'
import { CursorController } from './cursor/controller.js'
import type { CursorIntent, CursorPoint } from './cursor/types.js'

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
    private readonly runtimeEnv: RuntimeEnv
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
    private agentExecutionInFlight = false
    private cursorController: CursorController | null = null

    constructor(config: OpensteerConfig = {}) {
        const resolvedRuntime = resolveConfigWithEnv(config)
        const resolved = resolvedRuntime.config
        const runtimeEnv = resolvedRuntime.env
        const cloudSelection = resolveCloudSelection({
            cloud: resolved.cloud,
        }, runtimeEnv)
        const model = resolved.model

        this.config = resolved
        this.runtimeEnv = runtimeEnv
        this.aiResolve = this.createLazyResolveCallback(model, runtimeEnv)
        this.aiExtract = this.createLazyExtractCallback(model, runtimeEnv)

        const rootDir = resolved.storage?.rootDir || process.cwd()
        this.namespace = resolveNamespace(resolved, rootDir)
        this.storage = new LocalSelectorStorage(rootDir, this.namespace, {
            debug: Boolean(resolved.debug),
        })
        this.pool = new BrowserPool(resolved.browser || {})

        if (cloudSelection.cloud) {
            const cloudConfig =
                resolved.cloud && typeof resolved.cloud === 'object'
                    ? resolved.cloud
                    : undefined
            const credential = selectCloudCredential({
                apiKey: cloudConfig?.apiKey,
                accessToken: cloudConfig?.accessToken,
                authScheme: cloudConfig?.authScheme,
            })

            if (!credential) {
                throw new Error(
                    'Cloud mode requires credentials via cloud.apiKey/cloud.accessToken or OPENSTEER_API_KEY/OPENSTEER_ACCESS_TOKEN.'
                )
            }

            this.cloud = createCloudRuntimeState(
                credential.token,
                cloudConfig?.baseUrl,
                credential.authScheme
            )
        } else {
            this.cloud = null
        }
    }

    private logDebugError(context: string, error: unknown): void {
        if (!this.config.debug) return

        const normalized = normalizeError(error, 'Unknown error.')
        const codeSuffix =
            normalized.code && normalized.code.trim()
                ? ` [${normalized.code.trim()}]`
                : ''
        console.warn(
            `[opensteer] ${context}: ${normalized.message}${codeSuffix}`
        )
    }

    private createLazyResolveCallback(
        model: string,
        env: RuntimeEnv
    ): AiResolveCallback {
        let resolverPromise: Promise<AiResolveCallback> | null = null

        return async (...args: [Parameters<AiResolveCallback>[0]]) => {
            try {
                if (!resolverPromise) {
                    resolverPromise = import('./ai/resolver.js').then((m) =>
                        m.createResolveCallback(model, { env })
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

    private createLazyExtractCallback(
        model: string,
        env: RuntimeEnv
    ): AiExtractCallback {
        let extractorPromise: Promise<AiExtractCallback> | null = null

        const extract: AiExtractCallback = async (args) => {
            try {
                if (!extractorPromise) {
                    extractorPromise = import('./ai/extractor.js').then((m) =>
                        m.createExtractCallback(model, { env })
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

    private async invokeCloudActionAndResetCache<T>(
        method: CloudActionMethod,
        args: unknown
    ): Promise<T> {
        const result = await this.invokeCloudAction<T>(method, args)
        this.snapshotCache = null
        return result
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

    private async syncCloudPageRef(args?: { expectedUrl?: string }): Promise<void> {
        if (!this.cloud || !this.browser) return

        let tabs: TabInfo[]
        try {
            tabs = await this.invokeCloudAction<TabInfo[]>('tabs', {})
        } catch (error) {
            this.logDebugError('cloud page reference sync (tabs lookup) failed', error)
            return
        }
        if (!tabs.length) {
            return
        }

        const contexts = this.browser.contexts()
        if (!contexts.length) return

        const syncContext =
            this.contextRef && contexts.includes(this.contextRef)
                ? this.contextRef
                : contexts[0]
        const syncContextPages = syncContext.pages()

        const activeTab = tabs.find((tab) => tab.active) ?? null
        if (
            activeTab &&
            activeTab.index >= 0 &&
            activeTab.index < syncContextPages.length
        ) {
            this.contextRef = syncContext
            this.pageRef = syncContextPages[activeTab.index]
            return
        }

        const expectedUrl = args?.expectedUrl?.trim() || null
        const expectedUrlInSyncContext = expectedUrl
            ? syncContextPages.find((page) => page.url() === expectedUrl)
            : undefined
        if (expectedUrlInSyncContext) {
            this.contextRef = syncContext
            this.pageRef = expectedUrlInSyncContext
            return
        }

        const firstNonInternalInSyncContext = syncContextPages.find(
            (page) => !isInternalOrBlankPageUrl(page.url())
        )
        if (firstNonInternalInSyncContext) {
            this.contextRef = syncContext
            this.pageRef = firstNonInternalInSyncContext
            return
        }

        const firstAboutBlankInSyncContext = syncContextPages.find(
            (page) => page.url() === 'about:blank'
        )
        if (firstAboutBlankInSyncContext) {
            this.contextRef = syncContext
            this.pageRef = firstAboutBlankInSyncContext
            return
        }

        const pages: Array<{
            context: BrowserContext
            page: Page
            url: string
        }> = []
        for (const context of contexts) {
            for (const page of context.pages()) {
                pages.push({
                    context,
                    page,
                    url: page.url(),
                })
            }
        }
        if (!pages.length) return

        const expectedUrlMatch = expectedUrl
            ? pages.find(({ url }) => url === expectedUrl)
            : undefined
        if (expectedUrlMatch) {
            this.contextRef = expectedUrlMatch.context
            this.pageRef = expectedUrlMatch.page
            return
        }

        const firstNonInternal = pages.find(
            ({ url }) => !isInternalOrBlankPageUrl(url)
        )
        if (firstNonInternal) {
            this.contextRef = firstNonInternal.context
            this.pageRef = firstNonInternal.page
            return
        }

        const firstAboutBlank = pages.find(({ url }) => url === 'about:blank')
        if (firstAboutBlank) {
            this.contextRef = firstAboutBlank.context
            this.pageRef = firstAboutBlank.page
            return
        }

        this.contextRef = pages[0].context
        this.pageRef = pages[0].page
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

    getCloudSessionId(): string | null {
        return this.cloud?.sessionId ?? null
    }

    getCloudSessionUrl(): string | null {
        return this.cloud?.cloudSessionUrl ?? null
    }

    private announceCloudSession(args: {
        sessionId: string
        workspaceId: string
        cloudSessionUrl: string | null
    }): void {
        if (!this.shouldAnnounceCloudSession()) {
            return
        }

        const fields = [
            `sessionId=${args.sessionId}`,
            `workspaceId=${args.workspaceId}`,
        ]
        if (args.cloudSessionUrl) {
            fields.push(`url=${args.cloudSessionUrl}`)
        }

        process.stderr.write(`[opensteer] cloud session ready ${fields.join(' ')}\n`)
    }

    private shouldAnnounceCloudSession(): boolean {
        const cloudConfig =
            this.config.cloud && typeof this.config.cloud === 'object'
                ? this.config.cloud
                : null
        const announce = cloudConfig?.announce ?? 'always'
        if (announce === 'off') {
            return false
        }

        if (announce === 'tty') {
            return Boolean(process.stderr.isTTY)
        }

        return true
    }

    private buildCloudSessionLaunchConfig(
        options: LaunchOptions
    ): CloudSessionLaunchConfig | undefined {
        const cloudConfig =
            this.config.cloud && typeof this.config.cloud === 'object'
                ? this.config.cloud
                : undefined
        const browserProfile = normalizeCloudBrowserProfilePreference(
            options.cloudBrowserProfile ?? cloudConfig?.browserProfile,
            options.cloudBrowserProfile ? 'launch options' : 'Opensteer config'
        )

        if (!browserProfile) {
            return undefined
        }

        return {
            browserProfile,
        }
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
            let localRunId: string | null = null

            try {
                try {
                    await this.syncLocalSelectorCacheToCloud()
                } catch (error) {
                    this.logDebugError('cloud selector cache sync failed', error)
                }

                localRunId = this.cloud.localRunId || buildLocalRunId(this.namespace)
                this.cloud.localRunId = localRunId
                const launchConfig = this.buildCloudSessionLaunchConfig(options)
                const session = await this.cloud.sessionClient.create({
                    cloudSessionContractVersion: CLOUD_SESSION_CONTRACT_VERSION,
                    sourceType: 'local-cloud',
                    clientSessionHint: this.namespace,
                    localRunId,
                    name: this.namespace,
                    model: this.config.model,
                    launchContext:
                        (options.context as Record<string, unknown>) ||
                        undefined,
                    launchConfig,
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
                if (this.cursorController) {
                    await this.cursorController.attachPage(this.pageRef)
                }

                this.cloud.actionClient = actionClient
                this.cloud.sessionId = sessionId
                this.cloud.cloudSessionUrl = session.cloudSessionUrl

                await this.syncCloudPageRef().catch((error) => {
                    this.logDebugError(
                        'cloud page reference sync after launch failed',
                        error
                    )
                })

                this.announceCloudSession({
                    sessionId: session.sessionId,
                    workspaceId: session.cloudSession.workspaceId,
                    cloudSessionUrl: this.cloud.cloudSessionUrl,
                })
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
                this.cloud.cloudSessionUrl = null
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
        if (this.cursorController) {
            await this.cursorController.attachPage(this.pageRef)
        }
    }

    static from(page: Page, config: OpensteerConfig = {}): Opensteer {
        const resolvedRuntime = resolveConfigWithEnv(config)
        const resolvedConfig = resolvedRuntime.config
        const cloudSelection = resolveCloudSelection({
            cloud: resolvedConfig.cloud,
        }, resolvedRuntime.env)
        if (cloudSelection.cloud) {
            throw cloudUnsupportedMethodError(
                'Opensteer.from(page)',
                'Opensteer.from(page) is not supported in cloud mode.'
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
            this.cloud.localRunId = null
            this.cloud.cloudSessionUrl = null

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
            if (this.cursorController) {
                await this.cursorController.dispose().catch(() => undefined)
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
        if (this.cursorController) {
            await this.cursorController.dispose().catch(() => undefined)
        }
    }

    private async syncLocalSelectorCacheToCloud(): Promise<void> {
        if (!this.cloud) return

        const entries = collectLocalSelectorCacheEntries(this.storage, {
            debug: Boolean(this.config.debug),
        })
        if (!entries.length) return

        await this.cloud.sessionClient.importSelectorCache({
            entries,
        })
    }

    async goto(url: string, options?: GotoOptions): Promise<void> {
        if (this.cloud) {
            await this.invokeCloudActionAndResetCache('goto', { url, options })
            await this.syncCloudPageRef({ expectedUrl: url }).catch((error) => {
                this.logDebugError(
                    'cloud page reference sync after goto failed',
                    error
                )
            })
            return
        }

        const { waitUntil = 'domcontentloaded', ...rest } = options ?? {}
        await this.page.goto(url, { waitUntil, timeout: rest.timeout })
        await waitForVisualStability(this.page, rest)
        this.snapshotCache = null
    }

    async snapshot(options: SnapshotOptions = {}): Promise<string> {
        if (this.cloud) {
            return await this.invokeCloudActionAndResetCache<string>('snapshot', {
                options,
            })
        }

        const prepared = await prepareSnapshot(this.page, options)
        this.snapshotCache = prepared
        return prepared.cleanedHtml
    }

    async state(): Promise<StateResult> {
        if (this.cloud) {
            return await this.invokeCloudAction<StateResult>('state', {})
        }

        const html = await this.snapshot({ mode: 'action' })

        return {
            url: this.page.url(),
            title: await this.page.title(),
            html,
        }
    }

    async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
        if (this.cloud) {
            const b64 = await this.invokeCloudAction<string>(
                'screenshot',
                options
            )
            return Buffer.from(b64, 'base64')
        }

        return this.page.screenshot({
            type: options.type ?? 'png',
            fullPage: options.fullPage,
            quality: options.type === 'jpeg' ? (options.quality ?? 90) : undefined,
            omitBackground: options.omitBackground,
        })
    }

    async click(options: ClickOptions): Promise<ActionResult> {
        if (this.cloud) {
            return await this.invokeCloudActionAndResetCache<ActionResult>(
                'click',
                options
            )
        }

        return this.executeClickVariant('click', {
            ...options,
            button: options.button ?? 'left',
            clickCount: options.clickCount ?? 1,
        })
    }

    async dblclick(options: ClickOptions): Promise<ActionResult> {
        if (this.cloud) {
            return await this.invokeCloudActionAndResetCache<ActionResult>(
                'dblclick',
                options
            )
        }

        return this.executeClickVariant('dblclick', {
            ...options,
            button: options.button ?? 'left',
            clickCount: 2,
        })
    }

    async rightclick(options: ClickOptions): Promise<ActionResult> {
        if (this.cloud) {
            return await this.invokeCloudActionAndResetCache<ActionResult>(
                'rightclick',
                options
            )
        }

        return this.executeClickVariant('rightclick', {
            ...options,
            button: 'right',
            clickCount: options.clickCount ?? 1,
        })
    }

    async hover(options: HoverOptions): Promise<ActionResult> {
        if (this.cloud) {
            return await this.invokeCloudActionAndResetCache<ActionResult>(
                'hover',
                options
            )
        }

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
                    persistPath = await this.tryBuildPathFromResolvedHandle(
                        handle,
                        'hover',
                        resolution.counter
                    )
                }

                await this.runWithCursorPreview(
                    () =>
                        this.resolveHandleTargetPoint(handle, options.position),
                    'hover',
                    async () => {
                        await this.runWithPostActionWait(
                            'hover',
                            options.wait,
                            async () => {
                                await handle.hover({
                                    force: options.force,
                                    position: options.position,
                                })
                            }
                        )
                    }
                )
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

        const result = await this.runWithCursorPreview(
            () => this.resolvePathTargetPoint(path, options.position),
            'hover',
            async () => {
                return await this.runWithPostActionWait(
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
                                    fallbackMessage:
                                        defaultActionFailureMessage('hover'),
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
        if (this.cloud) {
            return await this.invokeCloudActionAndResetCache<ActionResult>(
                'input',
                options
            )
        }

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
                    persistPath = await this.tryBuildPathFromResolvedHandle(
                        handle,
                        'input',
                        resolution.counter
                    )
                }

                await this.runWithCursorPreview(
                    () => this.resolveHandleTargetPoint(handle),
                    'input',
                    async () => {
                        await this.runWithPostActionWait(
                            'input',
                            options.wait,
                            async () => {
                                if (options.clear !== false) {
                                    await handle.fill(options.text)
                                } else {
                                    await handle.type(options.text)
                                }
                                if (options.pressEnter) {
                                    await handle.press('Enter', { noWaitAfter: true })
                                }
                            }
                        )
                    }
                )
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

        const result = await this.runWithCursorPreview(
            () => this.resolvePathTargetPoint(path),
            'input',
            async () => {
                return await this.runWithPostActionWait(
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
                                    fallbackMessage:
                                        defaultActionFailureMessage('input'),
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
        if (this.cloud) {
            return await this.invokeCloudActionAndResetCache<ActionResult>(
                'select',
                options
            )
        }

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
                    persistPath = await this.tryBuildPathFromResolvedHandle(
                        handle,
                        'select',
                        resolution.counter
                    )
                }

                await this.runWithCursorPreview(
                    () => this.resolveHandleTargetPoint(handle),
                    'select',
                    async () => {
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

        const result = await this.runWithCursorPreview(
            () => this.resolvePathTargetPoint(path),
            'select',
            async () => {
                return await this.runWithPostActionWait(
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
                                    fallbackMessage:
                                        defaultActionFailureMessage('select'),
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
        if (this.cloud) {
            return await this.invokeCloudActionAndResetCache<ActionResult>(
                'scroll',
                options
            )
        }

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
                    persistPath = await this.tryBuildPathFromResolvedHandle(
                        handle,
                        'scroll',
                        resolution.counter
                    )
                }

                const delta = getScrollDelta(options)
                await this.runWithCursorPreview(
                    () => this.resolveHandleTargetPoint(handle),
                    'scroll',
                    async () => {
                        await this.runWithPostActionWait(
                            'scroll',
                            options.wait,
                            async () => {
                                await handle.evaluate((el, value) => {
                                    if (el instanceof HTMLElement) {
                                        el.scrollBy(value.x, value.y)
                                    }
                                }, delta)
                            }
                        )
                    }
                )
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

        const result = await this.runWithCursorPreview(
            () =>
                resolution.path
                    ? this.resolvePathTargetPoint(resolution.path)
                    : this.resolveViewportAnchorPoint(),
            'scroll',
            async () => {
                return await this.runWithPostActionWait(
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
                                    fallbackMessage:
                                        defaultActionFailureMessage('scroll'),
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
        if (this.cloud) {
            return await this.invokeCloudAction<TabInfo[]>('tabs', {})
        }

        return listTabs(this.context, this.page)
    }

    async newTab(url?: string): Promise<TabInfo> {
        if (this.cloud) {
            const result = await this.invokeCloudActionAndResetCache<TabInfo>(
                'newTab',
                {
                    url,
                }
            )
            await this.syncCloudPageRef({ expectedUrl: result.url }).catch(
                (error) => {
                    this.logDebugError(
                        'cloud page reference sync after newTab failed',
                        error
                    )
                }
            )
            return result
        }

        const { page, info } = await createTab(this.context, url)
        this.pageRef = page
        this.snapshotCache = null
        return info
    }

    async switchTab(index: number): Promise<void> {
        if (this.cloud) {
            await this.invokeCloudActionAndResetCache('switchTab', { index })
            await this.syncCloudPageRef().catch((error) => {
                this.logDebugError(
                    'cloud page reference sync after switchTab failed',
                    error
                )
            })
            return
        }

        const page = await switchTab(this.context, index)
        this.pageRef = page
        this.snapshotCache = null
    }

    async closeTab(index?: number): Promise<void> {
        if (this.cloud) {
            await this.invokeCloudActionAndResetCache('closeTab', { index })
            await this.syncCloudPageRef().catch((error) => {
                this.logDebugError(
                    'cloud page reference sync after closeTab failed',
                    error
                )
            })
            return
        }

        const newPage = await closeTab(this.context, this.page, index)
        if (newPage) {
            this.pageRef = newPage
        }
        this.snapshotCache = null
    }

    // --- Cookie Management ---

    async getCookies(url?: string): Promise<import('playwright').Cookie[]> {
        if (this.cloud) {
            return await this.invokeCloudAction<import('playwright').Cookie[]>(
                'getCookies',
                { url }
            )
        }

        return getCookies(this.context, url)
    }

    async setCookie(cookie: CookieParam): Promise<void> {
        if (this.cloud) {
            await this.invokeCloudAction('setCookie', cookie)
            return
        }

        return setCookie(this.context, cookie)
    }

    async clearCookies(): Promise<void> {
        if (this.cloud) {
            await this.invokeCloudAction('clearCookies', {})
            return
        }

        return clearCookies(this.context)
    }

    async exportCookies(filePath: string, url?: string): Promise<void> {
        if (this.cloud) {
            throw cloudUnsupportedMethodError(
                'exportCookies',
                'exportCookies() is not supported in cloud mode because it depends on local filesystem paths.'
            )
        }

        return exportCookies(this.context, filePath, url)
    }

    async importCookies(filePath: string): Promise<void> {
        if (this.cloud) {
            throw cloudUnsupportedMethodError(
                'importCookies',
                'importCookies() is not supported in cloud mode because it depends on local filesystem paths.'
            )
        }

        return importCookies(this.context, filePath)
    }

    // --- Keyboard Input ---

    async pressKey(key: string): Promise<void> {
        if (this.cloud) {
            await this.invokeCloudActionAndResetCache('pressKey', { key })
            return
        }

        await this.runWithPostActionWait('pressKey', undefined, async () => {
            await pressKey(this.page, key)
        })
        this.snapshotCache = null
    }

    async type(text: string): Promise<void> {
        if (this.cloud) {
            await this.invokeCloudActionAndResetCache('type', { text })
            return
        }

        await this.runWithPostActionWait('type', undefined, async () => {
            await typeText(this.page, text)
        })
        this.snapshotCache = null
    }

    // --- Element Info ---

    async getElementText(options: BaseActionOptions): Promise<string> {
        if (this.cloud) {
            return await this.invokeCloudAction<string>('getElementText', options)
        }

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
        if (this.cloud) {
            return await this.invokeCloudAction<string>(
                'getElementValue',
                options
            )
        }

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
        if (this.cloud) {
            return await this.invokeCloudAction<Record<string, string>>(
                'getElementAttributes',
                options
            )
        }

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
        if (this.cloud) {
            return await this.invokeCloudAction<BoundingBox | null>(
                'getElementBoundingBox',
                options
            )
        }

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
        if (this.cloud) {
            return await this.invokeCloudAction<string>('getHtml', { selector })
        }

        return getPageHtml(this.page, selector)
    }

    async getTitle(): Promise<string> {
        if (this.cloud) {
            return await this.invokeCloudAction<string>('getTitle', {})
        }

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
                    const persistPath = await this.tryBuildPathFromResolvedHandle(
                        handle,
                        method,
                        resolution.counter
                    )
                    if (persistPath) {
                        this.persistPath(
                            storageKey,
                            method,
                            options.description,
                            persistPath
                        )
                    }
                }
                return await counterFn(handle)
            } catch (err) {
                if (err instanceof Error) {
                    throw err
                }
                throw new Error(
                    `${method} failed. ${extractErrorMessage(err, 'Unknown error.')}`
                )
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
        if (this.cloud) {
            throw cloudUnsupportedMethodError(
                'uploadFile',
                'uploadFile() is not supported in cloud mode because file paths must be accessible on the cloud runtime.'
            )
        }

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
                    persistPath = await this.tryBuildPathFromResolvedHandle(
                        handle,
                        'uploadFile',
                        resolution.counter
                    )
                }
                await this.runWithCursorPreview(
                    () => this.resolveHandleTargetPoint(handle),
                    'uploadFile',
                    async () => {
                        await this.runWithPostActionWait(
                            'uploadFile',
                            options.wait,
                            async () => {
                                await handle.setInputFiles(options.paths)
                            }
                        )
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

        const result = await this.runWithCursorPreview(
            () => this.resolvePathTargetPoint(path),
            'uploadFile',
            async () => {
                return await this.runWithPostActionWait(
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
        if (this.cloud) {
            await this.invokeCloudAction('waitForText', { text, options })
            return
        }

        await this.page
            .getByText(text)
            .first()
            .waitFor({ timeout: options?.timeout ?? 30000 })
    }

    async extract<T = unknown>(options: ExtractOptions): Promise<T> {
        if (this.cloud) {
            return await this.invokeCloudAction<T>('extract', options)
        }

        if (options.schema !== undefined) {
            assertValidExtractSchemaRoot(options.schema)
        }

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
                const message = extractErrorMessage(err, 'Unknown error.')
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
            let planResult: ParsedAiExtractResult
            try {
                planResult = await this.parseAiExtractPlan(options)
            } catch (error) {
                const message = extractErrorMessage(error, 'Unknown error.')
                const contextMessage = options.schema
                    ? 'Schema extraction did not resolve deterministic field targets, so Opensteer attempted AI extraction planning.'
                    : 'Opensteer attempted AI extraction planning.'
                throw new Error(`${contextMessage} ${message}`, {
                    cause: error,
                })
            }

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
            await this.persistExtractPaths(
                storageKey,
                options.description,
                persistedFields,
                schemaHash
            )
        }

        return inflateDataPathObject(data) as T
    }

    async extractFromPlan<T = unknown>(
        options: ExtractFromPlanOptions
    ): Promise<ExtractionRunResult<T>> {
        if (this.cloud) {
            return await this.invokeCloudAction<ExtractionRunResult<T>>(
                'extractFromPlan',
                options
            )
        }

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
            persisted = await this.persistExtractPaths(
                storageKey,
                options.description,
                resolvedFields,
                schemaHash
            )
        }

        return {
            namespace: this.storage.getNamespace(),
            persisted,
            pathFile: storageKey
                ? this.storage.getSelectorFileName(storageKey)
                : null,
            data: inflateDataPathObject(data) as T,
            paths: buildPathMap(toPathFields(resolvedFields)),
        }
    }

    getNamespace(): string {
        return this.namespace
    }

    getConfig(): OpensteerConfig {
        return this.config
    }

    setCursorEnabled(enabled: boolean): void {
        this.getCursorController().setEnabled(enabled)
    }

    getCursorState(): OpensteerCursorState {
        const controller = this.cursorController
        if (!controller) {
            return {
                enabled: this.config.cursor?.enabled === true,
                active: false,
                reason:
                    this.config.cursor?.enabled === true
                        ? 'not_initialized'
                        : 'disabled',
            }
        }

        const status = controller.getStatus()
        return {
            enabled: status.enabled,
            active: status.active,
            reason: status.reason,
        }
    }

    getStorage(): LocalSelectorStorage {
        return this.storage
    }

    clearCache(): void {
        if (this.cloud) {
            this.snapshotCache = null
            if (!this.cloud.actionClient) return
            void this.invokeCloudAction('clearCache', {})
            return
        }

        this.storage.clearNamespace()
        this.snapshotCache = null
    }

    agent(config: OpensteerAgentConfig): OpensteerAgentInstance {
        const resolvedAgentConfig = resolveAgentConfig({
            agentConfig: config,
            fallbackModel: this.config.model,
            env: this.runtimeEnv,
        })

        return {
            execute: async (
                instructionOrOptions: string | OpensteerAgentExecuteOptions
            ): Promise<OpensteerAgentResult> => {
                if (this.agentExecutionInFlight) {
                    throw new OpensteerAgentBusyError()
                }

                this.agentExecutionInFlight = true
                try {
                    const options = normalizeExecuteOptions(instructionOrOptions)
                    const cursorController = this.getCursorController()
                    const previousCursorEnabled = cursorController.isEnabled()
                    if (options.highlightCursor !== undefined) {
                        cursorController.setEnabled(options.highlightCursor)
                    }
                    const handler = new OpensteerCuaAgentHandler({
                        page: this.page,
                        config: resolvedAgentConfig,
                        client: createCuaClient(resolvedAgentConfig),
                        cursorController,
                        onMutatingAction: () => {
                            this.snapshotCache = null
                        },
                    })

                    try {
                        const result = await handler.execute(options)
                        this.snapshotCache = null
                        return result
                    } finally {
                        if (options.highlightCursor !== undefined) {
                            cursorController.setEnabled(previousCursorEnabled)
                        }
                    }
                } finally {
                    this.agentExecutionInFlight = false
                }
            },
        }
    }

    private getCursorController(): CursorController {
        if (!this.cursorController) {
            this.cursorController = new CursorController({
                config: this.config.cursor,
                debug: Boolean(this.config.debug),
            })

            if (this.pageRef) {
                void this.cursorController.attachPage(this.pageRef)
            }
        }

        return this.cursorController
    }

    private async runWithCursorPreview<T>(
        pointResolver: () => Promise<CursorPoint | null>,
        intent: CursorIntent,
        execute: () => Promise<T>
    ): Promise<T> {
        if (this.isCursorPreviewEnabled()) {
            const point = await pointResolver()
            await this.previewCursorPoint(point, intent)
        }
        return await execute()
    }

    private isCursorPreviewEnabled(): boolean {
        return this.cursorController
            ? this.cursorController.isEnabled()
            : this.config.cursor?.enabled === true
    }

    private async previewCursorPoint(
        point: CursorPoint | null,
        intent: CursorIntent
    ): Promise<void> {
        const cursor = this.getCursorController()
        await cursor.attachPage(this.page)
        await cursor.preview(point, intent)
    }

    private resolveCursorPointFromBoundingBox(
        box: BoundingBox,
        position?: HoverOptions['position']
    ): CursorPoint {
        if (position) {
            return {
                x: box.x + position.x,
                y: box.y + position.y,
            }
        }

        return {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
        }
    }

    private async resolveHandleTargetPoint(
        handle: ElementHandle,
        position?: HoverOptions['position']
    ): Promise<CursorPoint | null> {
        try {
            const box = await handle.boundingBox()
            if (!box) return null
            return this.resolveCursorPointFromBoundingBox(box, position)
        } catch {
            return null
        }
    }

    private async resolvePathTargetPoint(
        path: ElementPath | null,
        position?: HoverOptions['position']
    ): Promise<CursorPoint | null> {
        if (!path) {
            return null
        }

        let resolved: Awaited<ReturnType<typeof resolveElementPath>> | null = null
        try {
            resolved = await resolveElementPath(this.page, path)
            return await this.resolveHandleTargetPoint(resolved.element, position)
        } catch {
            return null
        } finally {
            await resolved?.element.dispose().catch(() => undefined)
        }
    }

    private async resolveViewportAnchorPoint(): Promise<CursorPoint | null> {
        const viewport = this.page.viewportSize()
        if (viewport?.width && viewport?.height) {
            return {
                x: viewport.width / 2,
                y: viewport.height / 2,
            }
        }

        return null
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
                    persistPath = await this.tryBuildPathFromResolvedHandle(
                        handle,
                        'click',
                        resolution.counter
                    )
                }

                await this.runWithCursorPreview(
                    () => this.resolveHandleTargetPoint(handle),
                    method,
                    async () => {
                        await this.runWithPostActionWait(method, options.wait, async () => {
                            await handle.click({
                                button: options.button,
                                clickCount: options.clickCount,
                                modifiers: options.modifiers,
                            })
                        })
                    }
                )
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

        const result = await this.runWithCursorPreview(
            () => this.resolvePathTargetPoint(path),
            method,
            async () => {
                return await this.runWithPostActionWait(
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
                                    fallbackMessage:
                                        defaultActionFailureMessage(method),
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
                const withFrameContext = await this.withHandleIframeContext(
                    handle,
                    builtPath
                )
                return this.withIndexedIframeContext(
                    withFrameContext,
                    indexedPath
                )
            }
            return indexedPath
        } finally {
            await handle.dispose()
        }
    }

    private async resolveCounterHandle(element: number) {
        return resolveCounterElement(this.page, element)
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
            const withFrameContext = await this.withHandleIframeContext(
                handle,
                builtPath
            )
            const normalized = this.withIndexedIframeContext(
                withFrameContext,
                indexedPath
            )
            if (normalized.nodes.length) return normalized
        }
        if (indexedPath) return indexedPath

        throw new Error(
            `Unable to build element path from counter ${counter} during ${action}.`
        )
    }

    private async tryBuildPathFromResolvedHandle(
        handle: ElementHandle,
        action: string,
        counter: number
    ): Promise<ElementPath | null> {
        try {
            return await this.buildPathFromResolvedHandle(handle, action, counter)
        } catch (error) {
            this.logDebugError(
                `path persistence skipped for ${action} counter ${counter}`,
                error
            )
            return null
        }
    }

    private withIndexedIframeContext(
        builtPath: ElementPath,
        indexedPath: ElementPath | null
    ): ElementPath {
        const normalizedBuilt = this.normalizePath(builtPath)
        if (!indexedPath) return normalizedBuilt

        const iframePrefix = collectIframeContextPrefix(indexedPath)
        if (!iframePrefix.length) return normalizedBuilt

        const builtContext = cloneContextHops(normalizedBuilt.context)
        const overlap = measureContextOverlap(iframePrefix, builtContext)
        const missingPrefix = cloneContextHops(
            iframePrefix.slice(0, iframePrefix.length - overlap)
        )

        if (!missingPrefix.length) {
            return normalizedBuilt
        }

        const merged: ElementPath = {
            context: [
                ...missingPrefix,
                ...builtContext,
            ],
            nodes: cloneElementPath(normalizedBuilt).nodes,
        }

        const normalized = this.normalizePath(merged)
        if (normalized.nodes.length) return normalized

        const fallback = this.normalizePath(indexedPath)
        if (fallback.nodes.length) return fallback

        return normalizedBuilt
    }

    private async withHandleIframeContext(
        handle: ElementHandle,
        path: ElementPath
    ): Promise<ElementPath> {
        const ownFrame = await handle.ownerFrame()
        if (!ownFrame) {
            return this.normalizePath(path)
        }

        let frame = ownFrame
        let prefix: ElementPath['context'] = []
        while (frame && frame !== this.page.mainFrame()) {
            const parent = frame.parentFrame()
            if (!parent) break

            const frameElement = await frame.frameElement().catch(() => null)
            if (!frameElement) break

            try {
                const frameElementPath =
                    await buildElementPathFromHandle(frameElement)
                if (frameElementPath?.nodes.length) {
                    const segment: ElementPath['context'] = [
                        ...cloneContextHops(frameElementPath.context),
                        {
                            kind: 'iframe',
                            host: cloneElementPath(frameElementPath).nodes,
                        },
                    ]
                    prefix = [...segment, ...prefix]
                }
            } finally {
                await frameElement.dispose().catch(() => undefined)
            }

            frame = parent
        }

        if (!prefix.length) {
            return this.normalizePath(path)
        }

        return this.normalizePath({
            context: [...prefix, ...cloneContextHops(path.context)],
            nodes: cloneElementPath(path).nodes,
        })
    }

    private async readPathFromCounterIndex(
        counter: number
    ): Promise<ElementPath | null> {
        if (
            !this.snapshotCache ||
            this.snapshotCache.url !== this.page.url() ||
            !this.snapshotCache.counterIndex
        ) {
            return null
        }

        const indexed = this.snapshotCache.counterIndex.get(counter)
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

    private async persistExtractPaths(
        id: string,
        description: string | undefined,
        fields: PersistableExtractField[],
        schemaHash: string
    ): Promise<boolean> {
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
        let validatedPayload = persistedPayload
        try {
            validatedPayload = await stripRedundantPositionClauses(
                persistedPayload,
                this.page
            )
        } catch {
            // Validation is best-effort; keep the original persisted payload on failure.
        }

        const payload: SelectorFile<PersistedExtractPayload> = {
            id,
            method: 'extract',
            description: description || 'Extraction paths',
            path: validatedPayload,
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
                : inflateDataPathObject(flat)

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
                } else {
                    throw new Error(
                        `Extraction schema field "${fieldKey}" uses selector "${normalized.selector}", but no matching element path could be built from the current page snapshot.`
                    )
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
            const counterValues = await resolveCountersBatch(this.page, counterRequests)
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
                    `Unable to persist extraction schema field "${field.key}": counter ${field.counter} could not be converted into a stable element path.`
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

function formatActionFailureMessage(
    action: string,
    description: string | undefined,
    cause: string
): string {
    const label = description ? `"${description}"` : 'unnamed target'
    return `${action} action failed for ${label}: ${cause}`
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

function measureContextOverlap(
    indexedPrefix: ElementPath['context'],
    builtContext: ElementPath['context']
): number {
    const maxOverlap = Math.min(indexedPrefix.length, builtContext.length)
    for (let size = maxOverlap; size > 0; size -= 1) {
        if (matchesContextPrefix(indexedPrefix, builtContext, size, true)) {
            return size
        }
    }

    for (let size = maxOverlap; size > 0; size -= 1) {
        if (matchesContextPrefix(indexedPrefix, builtContext, size, false)) {
            return size
        }
    }

    return 0
}

function matchesContextPrefix(
    indexedPrefix: ElementPath['context'],
    builtContext: ElementPath['context'],
    size: number,
    strictHost: boolean
): boolean {
    for (let idx = 0; idx < size; idx += 1) {
        const left = indexedPrefix[indexedPrefix.length - size + idx]!
        const right = builtContext[idx]!
        if (left.kind !== right.kind) {
            return false
        }
        if (
            strictHost &&
            JSON.stringify(left.host) !== JSON.stringify(right.host)
        ) {
            return false
        }
    }
    return true
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

function assertValidExtractSchemaRoot(schema: unknown): void {
    if (!schema || typeof schema !== 'object') {
        throw new Error(
            'Invalid extraction schema: expected a JSON object at the top level.'
        )
    }

    if (Array.isArray(schema)) {
        throw new Error(
            'Invalid extraction schema: top-level arrays are not supported. Wrap array fields in an object (for example {"items":[...]}).'
        )
    }
}

function parseAiExtractResponse(response: unknown): ExtractionPlan {
    if (typeof response === 'string') {
        const trimmed = stripCodeFence(response)
        try {
            return JSON.parse(trimmed) as ExtractionPlan
        } catch {
            const preview = summarizeForError(trimmed)
            throw new Error(
                `LLM extraction returned a non-JSON response.${preview ? ` Preview: "${preview}"` : ''}`
            )
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

function summarizeForError(input: string, maxLength = 180): string {
    const compact = input.replace(/\s+/g, ' ').trim()
    if (!compact) return ''
    if (compact.length <= maxLength) return compact
    return `${compact.slice(0, maxLength)}...`
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

function isInternalOrBlankPageUrl(url: string): boolean {
    if (!url) return true
    if (url === 'about:blank') return true
    return (
        url.startsWith('chrome://') ||
        url.startsWith('devtools://') ||
        url.startsWith('edge://')
    )
}

function normalizeCloudBrowserProfilePreference(
    value: OpensteerCloudBrowserProfileOptions | undefined,
    source: 'launch options' | 'Opensteer config'
): { profileId: string; reuseIfActive?: boolean } | undefined {
    if (!value) {
        return undefined
    }

    const profileId =
        typeof value.profileId === 'string' ? value.profileId.trim() : ''
    if (!profileId) {
        throw new Error(
            `Invalid cloud browser profile in ${source}: profileId must be a non-empty string.`
        )
    }

    if (
        value.reuseIfActive !== undefined &&
        typeof value.reuseIfActive !== 'boolean'
    ) {
        throw new Error(
            `Invalid cloud browser profile in ${source}: reuseIfActive must be a boolean.`
        )
    }

    return {
        profileId,
        reuseIfActive: value.reuseIfActive,
    }
}

function buildLocalRunId(namespace: string): string {
    const normalized = namespace.trim() || 'default'
    return `${normalized}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}
