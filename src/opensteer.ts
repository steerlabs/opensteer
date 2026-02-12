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
    SnapshotOptions,
    StateResult,
    TabInfo,
} from './types.js'
import { LocalSelectorStorage, type SelectorFile } from './storage/local.js'
import { prepareSnapshot, type PreparedSnapshot } from './html/pipeline.js'
import {
    buildElementPathFromHandle,
    buildElementPathFromSelector,
    cloneElementPath,
    sanitizeElementPath,
} from './element-path/build.js'
import type {
    ElementPath,
    MatchClause,
    PathNode,
} from './element-path/types.js'
import { performClick } from './actions/click.js'
import { performHover } from './actions/hover.js'
import { performInput } from './actions/input.js'
import { performScroll } from './actions/scroll.js'
import { performSelect } from './actions/select.js'
import {
    countArrayItemsWithPath,
    extractArrayWithPaths,
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
import {
    resolveCounterElement,
    resolveCountersBatch,
    type CounterRequest,
} from './html/counter-runtime.js'

interface PersistedExtractField {
    elementPath: ElementPath
    attribute?: string
}

interface PersistedExtractSourceNode {
    $source: 'current_url'
}

interface PersistedExtractArrayNode {
    $array: {
        itemParentPath: ElementPath
        item: PersistedExtractNode
    }
}

interface PersistedExtractValueNode {
    $path: ElementPath
    attribute?: string
}

interface PersistedExtractObjectNode {
    [key: string]: PersistedExtractNode
}

type PersistedExtractNode =
    | PersistedExtractValueNode
    | PersistedExtractSourceNode
    | PersistedExtractArrayNode
    | PersistedExtractObjectNode

type PersistedExtractPayload = PersistedExtractObjectNode

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

interface PersistablePathField {
    key: string
    path: ElementPath
    attribute?: string
}

interface PersistableSourceField {
    key: string
    source: 'current_url'
}

type PersistableExtractField = PersistablePathField | PersistableSourceField

interface ParsedAiExtractResult {
    fields: ExtractFieldTarget[]
    data?: unknown
}

export class Opensteer {
    private readonly config: OpensteerConfig
    private readonly aiResolve: AiResolveCallback
    private readonly aiExtract: AiExtractCallback
    private readonly namespace: string
    private readonly storage: LocalSelectorStorage
    private readonly pool: BrowserPool

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

        const session = await this.pool.launch(options)

        this.browser = session.browser
        this.contextRef = session.context
        this.pageRef = session.page
        this.ownsBrowser = true
        this.snapshotCache = null
    }

    static from(page: Page, config: OpensteerConfig = {}): Opensteer {
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

        if (this.ownsBrowser) {
            await this.pool.close()
        }

        this.browser = null
        this.pageRef = null
        this.contextRef = null
        this.ownsBrowser = false
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
            const handle = await this.resolveCounterHandle(resolution.counter)
            let persistPath: ElementPath | null = null
            try {
                if (storageKey && resolution.shouldPersist) {
                    persistPath = await this.buildPathFromResolvedHandle(
                        handle,
                        'hover',
                        resolution.counter
                    )
                }

                await handle.hover({
                    force: options.force,
                    position: options.position,
                })
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : 'Hover failed.'
                throw new Error(message)
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

        const result = await performHover(this.page, resolution.path, options)

        if (!result.ok) {
            throw new Error(
                formatActionFailureMessage(
                    'hover',
                    options.description,
                    result.error || 'Hover failed.'
                )
            )
        }
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
            const handle = await this.resolveCounterHandle(resolution.counter)
            let persistPath: ElementPath | null = null
            try {
                if (storageKey && resolution.shouldPersist) {
                    persistPath = await this.buildPathFromResolvedHandle(
                        handle,
                        'input',
                        resolution.counter
                    )
                }

                if (options.clear !== false) {
                    await handle.fill(options.text)
                } else {
                    await handle.type(options.text)
                }
                if (options.pressEnter) {
                    await handle.press('Enter')
                }
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : 'Input failed.'
                throw new Error(message)
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

        const result = await performInput(this.page, resolution.path, options)

        if (!result.ok) {
            throw new Error(
                formatActionFailureMessage(
                    'input',
                    options.description,
                    result.error || 'Input failed.'
                )
            )
        }
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
            const handle = await this.resolveCounterHandle(resolution.counter)
            let persistPath: ElementPath | null = null
            try {
                if (storageKey && resolution.shouldPersist) {
                    persistPath = await this.buildPathFromResolvedHandle(
                        handle,
                        'select',
                        resolution.counter
                    )
                }

                if (options.value != null) {
                    await handle.selectOption(options.value)
                } else if (options.label != null) {
                    await handle.selectOption({ label: options.label })
                } else if (options.index != null) {
                    await handle.selectOption({ index: options.index })
                } else {
                    throw new Error('Select requires value, label, or index.')
                }
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : 'Select failed.'
                throw new Error(message)
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

        const result = await performSelect(this.page, resolution.path, options)

        if (!result.ok) {
            throw new Error(
                formatActionFailureMessage(
                    'select',
                    options.description,
                    result.error || 'Select failed.'
                )
            )
        }
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
            const handle = await this.resolveCounterHandle(resolution.counter)
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
                await handle.evaluate((el, value) => {
                    if (el instanceof HTMLElement) {
                        el.scrollBy(value.x, value.y)
                    }
                }, delta)
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : 'Scroll failed.'
                throw new Error(message)
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

        const result = await performScroll(this.page, resolution.path, options)

        if (!result.ok) {
            throw new Error(
                formatActionFailureMessage(
                    'scroll',
                    options.description,
                    result.error || 'Scroll failed.'
                )
            )
        }
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
        await pressKey(this.page, key)
        this.snapshotCache = null
    }

    async type(text: string): Promise<void> {
        await typeText(this.page, text)
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
            const handle = await this.resolveCounterHandle(resolution.counter)
            let persistPath: ElementPath | null = null
            try {
                if (storageKey && resolution.shouldPersist) {
                    persistPath = await this.buildPathFromResolvedHandle(
                        handle,
                        'uploadFile',
                        resolution.counter
                    )
                }
                await handle.setInputFiles(options.paths)
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : 'File upload failed.'
                throw new Error(message)
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

        const result = await performFileUpload(
            this.page,
            resolution.path,
            options.paths
        )

        if (!result.ok) {
            throw new Error(
                formatActionFailureMessage(
                    'uploadFile',
                    options.description,
                    result.error || 'File upload failed.'
                )
            )
        }
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

    private async executeClickVariant(
        method: 'click' | 'dblclick' | 'rightclick',
        options: ClickOptions
    ): Promise<ActionResult> {
        const storageKey = this.resolveStorageKey(options.description)
        const resolution = await this.resolvePath('click', options)

        if (resolution.counter != null) {
            const handle = await this.resolveCounterHandle(resolution.counter)
            let persistPath: ElementPath | null = null
            try {
                if (storageKey && resolution.shouldPersist) {
                    persistPath = await this.buildPathFromResolvedHandle(
                        handle,
                        'click',
                        resolution.counter
                    )
                }

                await handle.click({
                    button: options.button,
                    clickCount: options.clickCount,
                    modifiers: options.modifiers,
                })
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : 'Click failed.'
                throw new Error(message)
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

        const result = await performClick(this.page, resolution.path, options)

        if (!result.ok) {
            throw new Error(
                formatActionFailureMessage(
                    method,
                    options.description,
                    result.error || 'Click failed.'
                )
            )
        }
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
        if (indexedPath) return indexedPath

        const handle = await this.resolveCounterHandle(element)
        try {
            const path = await buildElementPathFromHandle(handle)
            if (!path) return null
            return this.normalizePath(path)
        } finally {
            await handle.dispose()
        }
    }

    private async resolveCounterHandle(element: number) {
        const snapshot = await this.ensureSnapshotWithCounters()
        return resolveCounterElement(this.page, snapshot, element)
    }

    private async buildPathFromResolvedHandle(
        handle: ElementHandle,
        action: string,
        counter: number
    ): Promise<ElementPath> {
        const indexedPath = await this.readPathFromCounterIndex(counter)
        if (indexedPath) return indexedPath

        const path = await buildElementPathFromHandle(handle)
        if (!path) {
            throw new Error(
                `Unable to build element path from counter ${counter} during ${action}.`
            )
        }
        const normalized = this.normalizePath(path)
        if (!normalized.nodes.length) {
            throw new Error(
                `Unable to build element path from counter ${counter} during ${action}.`
            )
        }
        return normalized
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

            const arrayNode = child.$array
            if (isPersistedValueNode(arrayNode.item)) {
                const rows = await extractArrayWithPaths(this.page, {
                    itemParentPath: this.normalizePath(
                        arrayNode.itemParentPath
                    ),
                    fields: [
                        {
                            key: '',
                            path: this.normalizePath(arrayNode.item.$path),
                            attribute: arrayNode.item.attribute,
                        },
                    ],
                })
                result[key] = rows.map((row) => row.value ?? null)
                continue
            }

            if (isPersistedSourceNode(arrayNode.item)) {
                const count = await countArrayItemsWithPath(
                    this.page,
                    this.normalizePath(arrayNode.itemParentPath)
                )
                result[key] = Array.from({ length: count }, () => pageUrl)
                continue
            }

            if (isPersistedArrayNode(arrayNode.item)) {
                throw new Error(
                    `Nested array extraction is not supported for cached array field "${key}".`
                )
            }

            const descriptors = collectArrayItemFieldDescriptors(arrayNode.item)
            const itemFields = descriptors
                .filter(
                    (descriptor): descriptor is ArrayItemPathFieldDescriptor =>
                        descriptor.kind === 'path'
                )
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

            const rows =
                itemFields.length > 0
                    ? await extractArrayWithPaths(this.page, {
                          itemParentPath: this.normalizePath(
                              arrayNode.itemParentPath
                          ),
                          fields: itemFields,
                      })
                    : Array.from(
                          {
                              length: await countArrayItemsWithPath(
                                  this.page,
                                  this.normalizePath(arrayNode.itemParentPath)
                              ),
                          },
                          () => ({})
                      )
            result[key] = rows.map((row) => {
                const flat = row as Record<string, unknown>
                for (const fieldPath of currentUrlFields) {
                    if (!fieldPath) {
                        flat.value = pageUrl
                        continue
                    }
                    flat[fieldPath] = pageUrl
                }
                return inflateExtractResult(flat)
            })
        }

        return result
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

function formatActionFailureMessage(
    action: string,
    description: string | undefined,
    cause: string
): string {
    const label = description ? `"${description}"` : 'unnamed target'
    return `${action} action failed for ${label}: ${cause}`
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

function isPersistablePathField(
    field: PersistableExtractField
): field is PersistablePathField {
    return 'path' in field
}

function toPathFields(fields: PersistableExtractField[]): FieldSelector[] {
    return fields.filter(isPersistablePathField).map((field) => ({
        key: field.key,
        path: field.path,
        attribute: field.attribute,
    }))
}

interface IndexedArrayField {
    source: PersistableExtractField
    arrayPath: string
    index: number
    fieldPath: string
}

interface ConsolidatedArrayField {
    path: string
    node: PersistedExtractNode
}

interface ConsolidatedArrayDescriptor {
    path: string
    itemParentPath: ElementPath
    fields: ConsolidatedArrayField[]
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

interface ArrayItemPathFieldDescriptor {
    kind: 'path'
    path: string
    selector: PersistedExtractField
}

interface ArrayItemSourceFieldDescriptor {
    kind: 'source'
    path: string
    source: 'current_url'
}

type ArrayItemFieldDescriptor =
    | ArrayItemPathFieldDescriptor
    | ArrayItemSourceFieldDescriptor

function isPersistedValueNode(
    node: unknown
): node is PersistedExtractValueNode {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false
    const record = node as Record<string, unknown>
    return !!record.$path
}

function isPersistedSourceNode(
    node: unknown
): node is PersistedExtractSourceNode {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false
    const record = node as Record<string, unknown>
    return record.$source === 'current_url'
}

function isPersistedArrayNode(
    node: unknown
): node is PersistedExtractArrayNode {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false
    const record = node as Record<string, unknown>
    return !!record.$array
}

function isPersistedObjectNode(
    node: unknown
): node is PersistedExtractObjectNode {
    return (
        !!node &&
        typeof node === 'object' &&
        !Array.isArray(node) &&
        !isPersistedValueNode(node) &&
        !isPersistedSourceNode(node) &&
        !isPersistedArrayNode(node)
    )
}

function collectArrayItemFieldDescriptors(
    node: PersistedExtractNode,
    prefix = ''
): ArrayItemFieldDescriptor[] {
    if (isPersistedValueNode(node)) {
        return [
            {
                kind: 'path',
                path: prefix,
                selector: {
                    elementPath: cloneElementPath(node.$path),
                    attribute: node.attribute,
                },
            },
        ]
    }

    if (isPersistedSourceNode(node)) {
        return [
            {
                kind: 'source',
                path: prefix,
                source: 'current_url',
            },
        ]
    }

    if (isPersistedArrayNode(node)) {
        throw new Error(
            'Nested array extraction descriptors are not supported in cached array item selectors.'
        )
    }

    const out: ArrayItemFieldDescriptor[] = []
    for (const [key, child] of Object.entries(node)) {
        const nextPath = joinDataPath(prefix, key)
        out.push(...collectArrayItemFieldDescriptors(child, nextPath))
    }
    return out
}

function joinDataPath(base: string, key: string): string {
    const normalizedBase = String(base || '').trim()
    const normalizedKey = String(key || '').trim()
    if (!normalizedBase) return normalizedKey
    if (!normalizedKey) return normalizedBase
    return `${normalizedBase}.${normalizedKey}`
}

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

function encodeDataPath(tokens: DataPathToken[]): string {
    let out = ''
    for (const token of tokens) {
        if (token.kind === 'prop') {
            out = out ? `${out}.${token.key}` : token.key
            continue
        }
        out += `[${token.index}]`
    }
    return out
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
        return createSourceNode(source)
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
            !arrayRecord.itemParentPath ||
            typeof arrayRecord.itemParentPath !== 'object'
        ) {
            throw new Error(
                `Invalid persisted extraction array node at "${label}": itemParentPath is required.`
            )
        }
        if (
            !arrayRecord.item ||
            typeof arrayRecord.item !== 'object' ||
            Array.isArray(arrayRecord.item)
        ) {
            throw new Error(
                `Invalid persisted extraction array node at "${label}": item is required.`
            )
        }

        return {
            $array: {
                itemParentPath: sanitizeElementPath(
                    arrayRecord.itemParentPath as ElementPath
                ),
                item: normalizePersistedExtractNode(
                    arrayRecord.item,
                    `${label}[]`
                ),
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

function buildPersistedExtractPayload(
    fields: PersistableExtractField[]
): PersistedExtractPayload {
    const normalizedFields: PersistableExtractField[] = fields.map((field) => {
        const key = String(field.key || '').trim()
        if (isPersistablePathField(field)) {
            return {
                key,
                path: sanitizeElementPath(field.path),
                attribute: field.attribute,
            }
        }
        return {
            key,
            source: 'current_url',
        }
    })

    const grouped = new Map<string, IndexedArrayField[]>()
    for (const field of normalizedFields) {
        const parsed = parseIndexedArrayFieldKey(field.key)
        if (!parsed) continue

        const list = grouped.get(parsed.arrayPath) || []
        list.push({
            source: field,
            arrayPath: parsed.arrayPath,
            index: parsed.index,
            fieldPath: parsed.fieldPath,
        })
        grouped.set(parsed.arrayPath, list)
    }

    const consumedFieldKeys = new Set<string>()
    const arrays: ConsolidatedArrayDescriptor[] = []
    for (const [arrayPath, entries] of grouped) {
        const descriptor = buildPersistedArrayDescriptor(arrayPath, entries)
        if (!descriptor) continue
        arrays.push(descriptor)
        for (const entry of entries) {
            consumedFieldKeys.add(entry.source.key)
        }
    }

    const root: PersistedExtractObjectNode = {}

    for (const field of normalizedFields) {
        if (!field.key || consumedFieldKeys.has(field.key)) continue
        insertNodeAtPath(root, field.key, createNodeFromPersistableField(field))
    }

    for (const descriptor of arrays.sort((a, b) =>
        a.path.localeCompare(b.path)
    )) {
        const item = buildArrayItemNode(descriptor.fields)
        insertNodeAtPath(root, descriptor.path, {
            $array: {
                itemParentPath: cloneElementPath(descriptor.itemParentPath),
                item,
            },
        })
    }

    return root
}

function createValueNode(
    selector: PersistedExtractField
): PersistedExtractValueNode {
    return {
        $path: cloneElementPath(selector.elementPath),
        attribute: selector.attribute,
    }
}

function createSourceNode(source: 'current_url'): PersistedExtractSourceNode {
    return {
        $source: source,
    }
}

function createNodeFromPersistableField(
    field: PersistableExtractField
): PersistedExtractNode {
    if (!isPersistablePathField(field)) {
        return createSourceNode('current_url')
    }
    return createValueNode({
        elementPath: field.path,
        attribute: field.attribute,
    })
}

function buildArrayItemNode(
    fields: ConsolidatedArrayField[]
): PersistedExtractNode {
    if (!fields.length) {
        throw new Error(
            'Unable to build persisted array item descriptor: no fields were consolidated.'
        )
    }

    if (fields.length === 1 && String(fields[0]?.path || '').trim() === '') {
        return clonePersistedExtractNode(fields[0]!.node)
    }

    const node: PersistedExtractObjectNode = {}

    for (const field of fields) {
        const path = String(field.path || '').trim()
        if (!path) {
            throw new Error(
                'Unable to build persisted array item descriptor: mixed primitive and object field paths.'
            )
        }
        insertNodeAtPath(node, path, clonePersistedExtractNode(field.node))
    }

    return node
}

function insertNodeAtPath(
    root: PersistedExtractObjectNode,
    path: string,
    node: PersistedExtractNode
): void {
    const tokens = parseDataPath(path)
    if (!tokens || !tokens.length) {
        throw new Error(
            `Invalid persisted extraction path "${path}": expected a non-empty object path.`
        )
    }

    if (tokens.some((token) => token.kind === 'index')) {
        throw new Error(
            `Invalid persisted extraction path "${path}": nested array indices are not supported in cached descriptors.`
        )
    }

    let current: PersistedExtractObjectNode = root
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        if (token.kind !== 'prop') {
            throw new Error(
                `Invalid persisted extraction path "${path}": expected object segment.`
            )
        }

        const isLast = i === tokens.length - 1
        if (isLast) {
            const existing = current[token.key]
            if (existing) {
                throw new Error(
                    `Conflicting persisted extraction path "${path}" detected while building descriptor tree.`
                )
            }
            current[token.key] = node
            return
        }

        const next = current[token.key]
        if (!next) {
            const created: PersistedExtractObjectNode = {}
            current[token.key] = created
            current = created
            continue
        }

        if (!isPersistedObjectNode(next)) {
            throw new Error(
                `Conflicting persisted extraction path "${path}" detected at "${token.key}".`
            )
        }

        current = next
    }
}

function parseIndexedArrayFieldKey(
    key: string
): { arrayPath: string; index: number; fieldPath: string } | null {
    const tokens = parseDataPath(key)
    if (!tokens || !tokens.length) return null

    const firstArrayIndex = tokens.findIndex((token) => token.kind === 'index')
    if (firstArrayIndex <= 0) return null

    const indexToken = tokens[firstArrayIndex]
    if (!indexToken || indexToken.kind !== 'index') return null

    const arrayPathTokens = tokens.slice(0, firstArrayIndex)
    const arrayPath = encodeDataPath(arrayPathTokens)
    if (!arrayPath) return null

    return {
        arrayPath,
        index: indexToken.index,
        fieldPath: encodeDataPath(tokens.slice(firstArrayIndex + 1)),
    }
}

function buildPersistedArrayDescriptor(
    arrayPath: string,
    entries: IndexedArrayField[]
): ConsolidatedArrayDescriptor | null {
    const fieldsByIndex = new Map<number, IndexedArrayField[]>()
    for (const entry of entries) {
        const list = fieldsByIndex.get(entry.index) || []
        list.push(entry)
        fieldsByIndex.set(entry.index, list)
    }

    if (!fieldsByIndex.size) return null

    const itemRootsByIndex = new Map<number, ElementPath>()
    for (const [index, indexEntries] of fieldsByIndex) {
        const root = buildItemRootForArrayIndex(indexEntries)
        if (!root) continue
        itemRootsByIndex.set(index, root)
    }
    if (!itemRootsByIndex.size) return null

    const mergedItemPath = mergeElementPathsByMajority([
        ...itemRootsByIndex.values(),
    ])
    if (!mergedItemPath) return null

    const keyStats = new Map<
        string,
        { indices: Set<number>; entries: IndexedArrayField[] }
    >()
    for (const entry of entries) {
        if (!itemRootsByIndex.has(entry.index)) continue
        const stat = keyStats.get(entry.fieldPath) || {
            indices: new Set<number>(),
            entries: [],
        }
        stat.indices.add(entry.index)
        stat.entries.push(entry)
        keyStats.set(entry.fieldPath, stat)
    }

    const threshold = majorityThreshold(itemRootsByIndex.size)
    const mergedFields: ConsolidatedArrayField[] = []
    for (const [fieldPath, stat] of keyStats) {
        if (stat.indices.size < threshold) continue

        const relativePaths: ElementPath[] = []
        const attributes: Array<string | undefined> = []
        const sources: Array<PersistableSourceField['source']> = []
        for (const entry of stat.entries) {
            if (isPersistablePathField(entry.source)) {
                const root = itemRootsByIndex.get(entry.index)
                if (!root) continue

                const relativePath = toRelativeElementPath(
                    entry.source.path,
                    root
                )
                if (!relativePath) continue

                relativePaths.push(relativePath)
                attributes.push(entry.source.attribute)
                continue
            }

            if (entry.source.source === 'current_url') {
                sources.push('current_url')
            }
        }

        if (relativePaths.length >= threshold) {
            const mergedFieldPath = mergeElementPathsByMajority(relativePaths)
            if (!mergedFieldPath) continue

            mergedFields.push({
                path: fieldPath,
                node: createValueNode({
                    elementPath: mergedFieldPath,
                    attribute: pickModeString(
                        attributes,
                        majorityThreshold(relativePaths.length)
                    ),
                }),
            })
            continue
        }

        const dominantSource = pickModeString(sources, threshold)
        if (dominantSource === 'current_url') {
            mergedFields.push({
                path: fieldPath,
                node: createSourceNode('current_url'),
            })
        }
    }

    if (!mergedFields.length) return null
    mergedFields.sort((a, b) => a.path.localeCompare(b.path))

    return {
        path: arrayPath,
        itemParentPath: mergedItemPath,
        fields: mergedFields,
    }
}

function buildItemRootForArrayIndex(
    entries: IndexedArrayField[]
): ElementPath | null {
    if (!entries.length) return null
    const paths = entries
        .map((entry) =>
            isPersistablePathField(entry.source)
                ? sanitizeElementPath(entry.source.path)
                : null
        )
        .filter((path): path is ElementPath => !!path)
    if (!paths.length) return null
    const prefixLength = getCommonPathPrefixLength(paths)
    if (prefixLength <= 0) return null

    const base = paths[0]
    if (!base) return null

    return sanitizeElementPath({
        context: clonePathContext(base.context),
        nodes: clonePathNodes(base.nodes.slice(0, prefixLength)),
    })
}

function getCommonPathPrefixLength(paths: ElementPath[]): number {
    if (!paths.length) return 0
    const nodeChains = paths.map((path) => path.nodes)
    const minLength = Math.min(...nodeChains.map((nodes) => nodes.length))
    if (!Number.isFinite(minLength) || minLength <= 0) return 0

    for (let i = 0; i < minLength; i++) {
        const first = nodeChains[0]?.[i]
        if (!first) return i
        for (let j = 1; j < nodeChains.length; j++) {
            const candidate = nodeChains[j]?.[i]
            if (!candidate || !arePathNodesEquivalent(first, candidate)) {
                return i
            }
        }
    }

    return minLength
}

function arePathNodesEquivalent(a: PathNode, b: PathNode): boolean {
    if (
        String(a.tag || '*').toLowerCase() !==
        String(b.tag || '*').toLowerCase()
    ) {
        return false
    }

    if (
        Number(a.position?.nthChild || 0) !== Number(b.position?.nthChild || 0)
    ) {
        return false
    }
    if (
        Number(a.position?.nthOfType || 0) !==
        Number(b.position?.nthOfType || 0)
    ) {
        return false
    }

    const aId = String(a.attrs?.id || '')
    const bId = String(b.attrs?.id || '')
    if ((aId || bId) && aId !== bId) return false

    const aClass = String(a.attrs?.class || '')
    const bClass = String(b.attrs?.class || '')
    if ((aClass || bClass) && aClass !== bClass) return false

    return true
}

function toRelativeElementPath(
    absolute: ElementPath,
    root: ElementPath
): ElementPath | null {
    const normalizedAbsolute = sanitizeElementPath(absolute)
    const normalizedRoot = sanitizeElementPath(root)

    if (
        stableStringify(normalizedAbsolute.context) !==
        stableStringify(normalizedRoot.context)
    ) {
        return null
    }

    const absoluteNodes = normalizedAbsolute.nodes
    const rootNodes = normalizedRoot.nodes
    if (rootNodes.length > absoluteNodes.length) return null

    for (let i = 0; i < rootNodes.length; i++) {
        const absNode = absoluteNodes[i]
        const rootNode = rootNodes[i]
        if (!absNode || !rootNode) return null
        if (!arePathNodesEquivalent(absNode, rootNode)) {
            return null
        }
    }

    return {
        context: [],
        nodes: clonePathNodes(absoluteNodes.slice(rootNodes.length)),
    }
}

function mergeElementPathsByMajority(paths: ElementPath[]): ElementPath | null {
    if (!paths.length) return null
    const normalized = paths.map((path) => sanitizeElementPath(path))
    const contextKey = pickModeString(
        normalized.map((path) => stableStringify(path.context)),
        1
    )
    if (!contextKey) return null

    const sameContext = normalized.filter(
        (path) => stableStringify(path.context) === contextKey
    )
    if (!sameContext.length) return null

    const targetLength =
        pickModeNumber(
            sameContext.map((path) => path.nodes.length),
            1
        ) ??
        sameContext[0]?.nodes.length ??
        0
    const aligned = sameContext.filter(
        (path) => path.nodes.length === targetLength
    )
    if (!aligned.length) return null

    const threshold = majorityThreshold(aligned.length)
    const nodes: PathNode[] = []
    for (let i = 0; i < targetLength; i++) {
        const nodesAtIndex = aligned
            .map((path) => path.nodes[i])
            .filter((node): node is PathNode => !!node)
        if (!nodesAtIndex.length) return null
        nodes.push(mergePathNodeByMajority(nodesAtIndex, threshold))
    }

    return sanitizeElementPath({
        context: clonePathContext(sameContext[0]?.context || []),
        nodes,
    })
}

function mergePathNodeByMajority(
    nodes: PathNode[],
    threshold: number
): PathNode {
    const tag =
        pickModeString(
            nodes.map((node) => String(node.tag || '*').toLowerCase()),
            threshold
        ) || '*'
    const attrs = mergeAttributesByMajority(
        nodes.map((node) => node.attrs || {}),
        threshold
    )
    const mergedPosition = mergePositionByMajority(
        nodes.map((node) => node.position),
        threshold
    )
    const match = mergeMatchByMajority(
        nodes.map((node) => node.match || []),
        attrs,
        mergedPosition.position,
        threshold,
        {
            hasNthChild: mergedPosition.hasNthChild,
            hasNthOfType: mergedPosition.hasNthOfType,
        }
    )

    return {
        tag,
        attrs,
        position: mergedPosition.position,
        match,
    }
}

function mergeAttributesByMajority(
    attrsList: Array<Record<string, string>>,
    threshold: number
): Record<string, string> {
    const keys = new Set<string>()
    for (const attrs of attrsList) {
        for (const key of Object.keys(attrs || {})) keys.add(key)
    }

    const out: Record<string, string> = {}
    for (const key of keys) {
        const value = pickModeString(
            attrsList.map((attrs) =>
                attrs && typeof attrs[key] === 'string' ? attrs[key] : undefined
            ),
            threshold
        )
        if (!value) continue
        out[key] = value
    }
    return out
}

function mergePositionByMajority(
    positions: Array<PathNode['position'] | undefined>,
    threshold: number
): {
    position: PathNode['position']
    hasNthChild: boolean
    hasNthOfType: boolean
} {
    const nthChild = pickModeNumber(
        positions.map((position) => position?.nthChild),
        threshold
    )
    const nthOfType = pickModeNumber(
        positions.map((position) => position?.nthOfType),
        threshold
    )

    return {
        position: {
            nthChild: nthChild ?? 1,
            nthOfType: nthOfType ?? 1,
        },
        hasNthChild: nthChild != null,
        hasNthOfType: nthOfType != null,
    }
}

function mergeMatchByMajority(
    matchLists: MatchClause[][],
    attrs: Record<string, string>,
    position: PathNode['position'],
    threshold: number,
    positionFlags: { hasNthChild: boolean; hasNthOfType: boolean } = {
        hasNthChild: true,
        hasNthOfType: true,
    }
): MatchClause[] {
    const counts = new Map<string, number>()
    for (const list of matchLists) {
        const unique = new Set<string>()
        for (const clause of list || []) {
            if (!clause || typeof clause !== 'object') continue
            unique.add(JSON.stringify(clause))
        }
        for (const key of unique) {
            counts.set(key, (counts.get(key) || 0) + 1)
        }
    }

    const merged: MatchClause[] = []
    for (const [encoded, count] of counts) {
        if (count < threshold) continue
        let clause: MatchClause | null = null
        try {
            clause = JSON.parse(encoded) as MatchClause
        } catch {
            clause = null
        }
        if (!clause) continue

        if (clause.kind === 'attr') {
            const key = String(clause.key || '').trim()
            if (!key) continue
            if (clause.value === undefined && attrs[key] === undefined) continue
            merged.push({
                kind: 'attr',
                key,
                op:
                    clause.op === 'startsWith' || clause.op === 'contains'
                        ? clause.op
                        : 'exact',
                value: clause.value,
            })
            continue
        }

        if (clause.axis === 'nthOfType') {
            if (!positionFlags.hasNthOfType) continue
            merged.push({ kind: 'position', axis: 'nthOfType' })
            continue
        }

        if (!positionFlags.hasNthChild) continue
        merged.push({ kind: 'position', axis: 'nthChild' })
    }

    if (!merged.length) {
        if (attrs.id) {
            merged.push({ kind: 'attr', key: 'id', op: 'exact' })
        }
        if (attrs.class) {
            merged.push({
                kind: 'attr',
                key: 'class',
                op: 'exact',
                value: attrs.class,
            })
        }
    }

    merged.sort(compareMatchClauses)
    return dedupeMatchClauses(merged)
}

function compareMatchClauses(a: MatchClause, b: MatchClause): number {
    if (a.kind !== b.kind) {
        return a.kind === 'attr' ? -1 : 1
    }

    if (a.kind === 'position' && b.kind === 'position') {
        if (a.axis === b.axis) return 0
        return a.axis === 'nthOfType' ? -1 : 1
    }

    if (a.kind === 'attr' && b.kind === 'attr') {
        const rank = (key: string): number => {
            if (key === 'id') return 0
            if (key === 'class') return 1
            return 2
        }
        const ra = rank(a.key)
        const rb = rank(b.key)
        if (ra !== rb) return ra - rb
        return a.key.localeCompare(b.key)
    }

    return 0
}

function dedupeMatchClauses(clauses: MatchClause[]): MatchClause[] {
    const seen = new Set<string>()
    const out: MatchClause[] = []
    for (const clause of clauses) {
        const key = JSON.stringify(clause)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(clause)
    }
    return out
}

function majorityThreshold(count: number): number {
    return Math.floor(count / 2) + 1
}

function pickModeString(
    values: Array<string | undefined>,
    minCount: number
): string | undefined {
    const counts = new Map<string, number>()
    let best: string | undefined = undefined
    let bestCount = 0
    for (const value of values) {
        if (value == null || value === '') continue
        const count = (counts.get(value) || 0) + 1
        counts.set(value, count)
        if (count > bestCount) {
            best = value
            bestCount = count
        }
    }
    if (best == null || bestCount < minCount) return undefined
    return best
}

function pickModeNumber(
    values: Array<number | undefined>,
    minCount: number
): number | undefined {
    const counts = new Map<number, number>()
    let best: number | undefined = undefined
    let bestCount = 0
    for (const value of values) {
        if (!Number.isFinite(value) || value == null) continue
        const normalized = Math.trunc(value)
        if (normalized <= 0) continue
        const count = (counts.get(normalized) || 0) + 1
        counts.set(normalized, count)
        if (count > bestCount) {
            best = normalized
            bestCount = count
        }
    }
    if (best == null || bestCount < minCount) return undefined
    return best
}

function clonePathContext(
    context: ElementPath['context']
): ElementPath['context'] {
    return JSON.parse(JSON.stringify(context || [])) as ElementPath['context']
}

function clonePathNodes(nodes: PathNode[]): PathNode[] {
    return JSON.parse(JSON.stringify(nodes || [])) as PathNode[]
}

function clonePersistedExtractNode(
    node: PersistedExtractNode
): PersistedExtractNode {
    return JSON.parse(JSON.stringify(node)) as PersistedExtractNode
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
