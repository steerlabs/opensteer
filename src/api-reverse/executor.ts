import { parseDataPath } from '../extraction/data-path.js'
import type { Opensteer } from '../opensteer.js'
import { summarizeMime, safeJsonParse } from './normalize.js'
import { normalizeDeterministicPlan } from './compiler.js'
import type { PreparedPlanRuntime } from './runtime.js'
import { applyBindingTransforms } from './transforms.js'
import type {
    ApiBindingResolver,
    ApiExecutionBinding,
    ApiExecutionStepReport,
    ApiOracleCheckResult,
    ApiPlanExecutionReport,
    ApiPlanIr,
    ApiPlanRequestTemplate,
    ApiRequestSlot,
    ApiStepTransport,
    ApiValidationFailureKind,
} from './types.js'

const REQUEST_TIMEOUT_MS = 30_000
const HTTP_EXECUTION_HEADER_BLOCKLIST = new Set([
    'accept-encoding',
    'connection',
    'content-length',
    'cookie',
    'host',
])
const BROWSER_FETCH_HEADER_BLOCKLIST = new Set([
    'accept-charset',
    'accept-encoding',
    'access-control-request-headers',
    'access-control-request-method',
    'connection',
    'content-length',
    'cookie',
    'date',
    'dnt',
    'expect',
    'host',
    'keep-alive',
    'origin',
    'referer',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'user-agent',
    'via',
])
const AUTH_REDIRECT_PATTERN =
    /(^|[/.#?&=_-])(login|sign(?:-|_)?in|auth|reauth|session(?:-|_)?expired)(?=$|[/.#?&=_-])/i
const DYNAMIC_HEADER_PATTERN = /(authorization|cookie|csrf|xsrf|token|session)/i

interface ExecutedStepState {
    status: number | null
    mime: string | null
    text: string | null
    json: unknown
    url: string | null
    headers: Record<string, string>
}

interface RequestTemplateState {
    url: URL
    headers: Record<string, string>
    cookies: Record<string, string>
    bodyFormat: 'json' | 'form' | 'text'
    bodyJson: unknown
    bodyForm: URLSearchParams | null
    bodyRaw: string | null
    rawJsonPlaceholders: Map<string, string>
}

export interface PlanExecutorOptions {
    opensteer?: Opensteer | null
}

export interface ExecutePlanOptions {
    inputs?: Record<string, unknown> | string | null
    allowDraft?: boolean
    runtime?: PreparedPlanRuntime | null
}

export class PlanExecutor {
    private opensteer: Opensteer | null

    constructor(options: PlanExecutorOptions = {}) {
        this.opensteer = options.opensteer ?? null
    }

    setOpensteer(opensteer: Opensteer | null): void {
        this.opensteer = opensteer
    }

    async execute(
        plan: ApiPlanIr,
        options: ExecutePlanOptions = {}
    ): Promise<ApiPlanExecutionReport> {
        const normalized = normalizeDeterministicPlan(plan)
        const inputs = normalizeInputMap(options.inputs)
        if (options.allowDraft !== true && normalized.lifecycle !== 'validated') {
            return {
                planRef: normalized.ref,
                operation: normalized.operation,
                version: normalized.version ?? 1,
                executedAt: Date.now(),
                inputs,
                ok: false,
                failureKind: 'unsupported_plan',
                steps: [],
                oracleChecks: [
                    {
                        kind: 'status',
                        ok: false,
                        detail: `Plan lifecycle "${normalized.lifecycle}" is not executable.`,
                    },
                ],
            }
        }

        const slotByRef = new Map(normalized.slots.map((slot) => [slot.ref, slot]))
        const executed = new Map<string, ExecutedStepState>()
        const stepReports: ApiExecutionStepReport[] = []
        let failureKind: ApiValidationFailureKind | null = null

        for (const step of normalized.steps) {
            const transport = step.transport ?? 'node_http'
            try {
                const resolvedRequest = await this.buildExecutableRequest(
                    normalized,
                    step,
                    slotByRef,
                    inputs,
                    executed,
                    options.runtime ?? null
                )
                const state = await this.executeStepTransport(
                    transport,
                    step.method,
                    resolvedRequest,
                    normalized.targetOrigin,
                    options.runtime ?? null
                )
                executed.set(step.id, state)
                stepReports.push({
                    stepId: step.id,
                    requestRef: step.requestRef,
                    transport,
                    ok: true,
                    status: state.status,
                    mime: state.mime,
                    url: state.url,
                    error: null,
                })
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : 'Plan execution failed.'
                failureKind = failureKind ?? classifyExecutionError(message)
                stepReports.push({
                    stepId: step.id,
                    requestRef: step.requestRef,
                    transport,
                    ok: false,
                    status: null,
                    mime: null,
                    url: null,
                    error: message,
                })
                break
            }
        }

        const targetStep = normalized.steps[normalized.steps.length - 1]
        const targetState = targetStep ? executed.get(targetStep.id) ?? null : null
        const oracleChecks = evaluateOracle(normalized, targetState)

        if (!failureKind && oracleChecks.some((check) => !check.ok)) {
            failureKind = classifyOracleFailure(targetState, oracleChecks)
        }

        return {
            planRef: normalized.ref,
            operation: normalized.operation,
            version: normalized.version ?? 1,
            executedAt: Date.now(),
            inputs,
            ok:
                stepReports.length === normalized.steps.length &&
                stepReports.every((step) => step.ok) &&
                oracleChecks.every((check) => check.ok),
            failureKind,
            steps: stepReports,
            oracleChecks,
        }
    }

    async probeBindingValue(
        plan: ApiPlanIr,
        bindingRef: Pick<ApiExecutionBinding, 'stepId' | 'slotRef'>,
        options: {
            inputs?: Record<string, unknown> | string | null
            runtime?: PreparedPlanRuntime | null
        } = {}
    ): Promise<unknown> {
        const normalized = normalizeDeterministicPlan(plan)
        const inputs = normalizeInputMap(options.inputs)
        const binding = normalized.bindings.find(
            (current) =>
                current.stepId === bindingRef.stepId && current.slotRef === bindingRef.slotRef
        )
        if (!binding) {
            throw new Error(
                `Binding ${bindingRef.stepId}:${bindingRef.slotRef} was not found in the plan.`
            )
        }

        const slotByRef = new Map(normalized.slots.map((slot) => [slot.ref, slot]))
        const slot = slotByRef.get(binding.slotRef)
        if (!slot) {
            throw new Error(
                `Binding ${binding.stepId}:${binding.slotRef} references an unknown slot.`
            )
        }

        const executed = new Map<string, ExecutedStepState>()
        for (const step of normalized.steps) {
            if (step.id === binding.stepId) {
                return this.resolveBindingValue(
                    binding,
                    slot,
                    inputs,
                    executed,
                    normalized.targetOrigin,
                    options.runtime ?? null
                )
            }

            const resolvedRequest = await this.buildExecutableRequest(
                normalized,
                step,
                slotByRef,
                inputs,
                executed,
                options.runtime ?? null
            )
            const state = await this.executeStepTransport(
                step.transport ?? 'node_http',
                step.method,
                resolvedRequest,
                normalized.targetOrigin,
                options.runtime ?? null
            )
            executed.set(step.id, state)
        }

        throw new Error(
            `Binding ${binding.stepId}:${binding.slotRef} could not be resolved from the plan steps.`
        )
    }

    private async buildExecutableRequest(
        plan: ApiPlanIr,
        step: ApiPlanIr['steps'][number],
        slotByRef: Map<string, ApiRequestSlot>,
        inputs: Record<string, string>,
        executed: Map<string, ExecutedStepState>,
        runtime: PreparedPlanRuntime | null
    ): Promise<{
        url: string
        headers: Record<string, string>
        body: string | null
        cookieHeader: string | null
    }> {
        if (!step.requestTemplate) {
            throw new Error(`Plan step "${step.id}" is missing an executable request template.`)
        }

        const template = buildRequestTemplate(step.requestTemplate)
        const bindings = plan.bindings.filter((binding) => binding.stepId === step.id)

        for (const binding of bindings) {
            const slot = slotByRef.get(binding.slotRef)
            if (!slot) {
                throw new Error(`Binding ${binding.stepId}:${binding.slotRef} references an unknown slot.`)
            }
            const value = await this.resolveBindingValue(
                binding,
                slot,
                inputs,
                executed,
                plan.targetOrigin,
                runtime
            )
            applyResolvedSlotValue(template, slot, value)
        }

        return {
            url: template.url.toString(),
            headers: sanitizeExecutionHeaderObject(template.headers),
            body: serializeRequestBodyTemplate(template),
            cookieHeader: serializeCookieHeaderValue(template),
        }
    }

    private async resolveBindingValue(
        binding: ApiExecutionBinding,
        slot: ApiRequestSlot,
        inputs: Record<string, string>,
        executed: Map<string, ExecutedStepState>,
        targetOrigin: string | null | undefined,
        runtime: PreparedPlanRuntime | null
    ): Promise<unknown> {
        const resolver = binding.resolver
        if (!resolver) {
            throw new Error(`Binding ${binding.stepId}:${binding.slotRef} is missing a resolver.`)
        }
        return this.resolveResolverValue(resolver, slot, inputs, executed, targetOrigin, runtime)
    }

    private async resolveResolverValue(
        resolver: ApiBindingResolver,
        slot: ApiRequestSlot,
        inputs: Record<string, string>,
        executed: Map<string, ExecutedStepState>,
        targetOrigin: string | null | undefined,
        runtime: PreparedPlanRuntime | null
    ): Promise<unknown> {
        switch (resolver.kind) {
            case 'computed': {
                const value = await this.resolveResolverValue(
                    resolver.source,
                    slot,
                    inputs,
                    executed,
                    targetOrigin,
                    runtime
                )
                return applyBindingTransforms(value, resolver.transforms)
            }
            case 'input':
                return applyBindingTransforms(
                    inputs[resolver.inputName] ?? slot.rawValue,
                    resolver.transforms
                )
            case 'constant':
                return applyBindingTransforms(resolver.value, resolver.transforms)
            case 'response_json': {
                const state = executed.get(resolver.producerStepId)
                const value = getValueAtDataPath(state?.json, resolver.responsePath)
                if (value == null) {
                    throw new Error(
                        `Derived response path "${resolver.responsePath}" was not available in ${resolver.producerStepId}.`
                    )
                }
                return applyBindingTransforms(value, resolver.transforms)
            }
            case 'response_header': {
                const state = executed.get(resolver.producerStepId)
                const value = state?.headers[resolver.headerName.toLowerCase()] ?? null
                if (value == null) {
                    throw new Error(
                        `Derived response header "${resolver.headerName}" was not available in ${resolver.producerStepId}.`
                    )
                }
                return applyBindingTransforms(value, resolver.transforms)
            }
            case 'cookie_live': {
                const opensteer = this.requireOpensteer(runtime)
                const cookies = await opensteer.context.cookies(targetOrigin ? [targetOrigin] : undefined)
                const match = cookies.find((cookie) => cookie.name === resolver.cookieName)
                if (!match) {
                    throw new Error(`Session cookie "${resolver.cookieName}" is not available.`)
                }
                return applyBindingTransforms(match.value, resolver.transforms)
            }
            case 'cookie_captured':
                return applyBindingTransforms(resolver.capturedValue, resolver.transforms)
            case 'storage_live': {
                const opensteer = this.requireOpensteer(runtime)
                const value = await opensteer.page.evaluate(
                    ({ storageType, key }) =>
                        storageType === 'local'
                            ? window.localStorage.getItem(key)
                            : window.sessionStorage.getItem(key),
                    {
                        storageType: resolver.storageType,
                        key: resolver.key,
                    }
                )
                if (value == null) {
                    throw new Error(
                        `Storage key "${resolver.key}" is not available in ${resolver.storageType}Storage.`
                    )
                }
                return applyBindingTransforms(value, resolver.transforms)
            }
            case 'dom_field': {
                const opensteer = this.requireOpensteer(runtime)
                const value = await opensteer.page.evaluate(
                    ({ fieldName, fieldId, fieldType, hidden }) => {
                        const elements = Array.from(
                            document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
                                'input, textarea, select'
                            )
                        )
                        const match = elements.find((element) => {
                            const type =
                                'type' in element && typeof element.type === 'string'
                                    ? element.type
                                    : null
                            const isHidden =
                                type === 'hidden' ||
                                element.hidden ||
                                (element as HTMLElement).offsetParent === null
                            if (hidden !== isHidden) return false
                            if (fieldName && element.getAttribute('name') !== fieldName) return false
                            if (fieldId && element.getAttribute('id') !== fieldId) return false
                            if (fieldType && type !== fieldType) return false
                            return true
                        })
                        return match && 'value' in match ? match.value : null
                    },
                    resolver
                )
                if (value == null) {
                    throw new Error(`DOM field for "${slot.slotPath}" is not available.`)
                }
                return applyBindingTransforms(value, resolver.transforms)
            }
            case 'script_json': {
                const opensteer = this.requireOpensteer(runtime)
                const value = await opensteer.page.evaluate(
                    ({ source, dataPath }) => {
                        const [prefix, selector] = source.split(':', 2)
                        if (prefix !== 'inline' || !selector) return null
                        const node = document.querySelector(selector)
                        if (!(node instanceof HTMLScriptElement)) return null
                        try {
                            const parsed = JSON.parse(node.textContent || '')
                            const tokens = dataPath
                                .split(/(?=\[)|\./)
                                .filter(Boolean)
                            let current: unknown = parsed
                            for (const token of tokens) {
                                if (token.startsWith('[')) {
                                    const index = Number.parseInt(token.slice(1, -1), 10)
                                    current = Array.isArray(current) ? current[index] : null
                                } else {
                                    current =
                                        current && typeof current === 'object'
                                            ? (current as Record<string, unknown>)[token]
                                            : null
                                }
                            }
                            return current == null ? null : String(current)
                        } catch {
                            return null
                        }
                    },
                    resolver
                )
                if (value == null) {
                    throw new Error(
                        `Script JSON value "${resolver.source}:${resolver.dataPath}" is not available.`
                    )
                }
                return applyBindingTransforms(value, resolver.transforms)
            }
            case 'unsupported':
                throw new Error(`Unsupported plan binding: ${resolver.reason}`)
        }
    }

    private async executeStepTransport(
        transport: ApiStepTransport,
        method: string,
        request: {
            url: string
            headers: Record<string, string>
            body: string | null
            cookieHeader: string | null
        },
        targetOrigin: string | null | undefined,
        runtime: PreparedPlanRuntime | null
    ): Promise<ExecutedStepState> {
        switch (transport) {
            case 'node_http':
                return executeDirectHttpStep(method, request)
            case 'browser_fetch':
            case 'browser_page': {
                const opensteer = this.requireOpensteer(runtime)
                if (transport === 'browser_page' && targetOrigin) {
                    const currentUrl = opensteer.page.url()
                    if (!currentUrl.startsWith(targetOrigin)) {
                        await opensteer.goto(targetOrigin)
                    }
                }
                await seedBrowserCookies(opensteer, request.url, request.cookieHeader)
                return executeBrowserStep(opensteer, method, request)
            }
        }
    }

    private requireOpensteer(runtime: PreparedPlanRuntime | null): Opensteer {
        const opensteer = runtime?.opensteer ?? this.opensteer
        if (!opensteer) {
            throw new Error('Required browser runtime was not prepared for this plan.')
        }
        return opensteer
    }
}

function buildRequestTemplate(requestTemplate: ApiPlanRequestTemplate): RequestTemplateState {
    const headers = Object.fromEntries(
        Object.entries(requestTemplate.headers).filter(
            ([key]) => !DYNAMIC_HEADER_PATTERN.test(key)
        )
    )
    return {
        url: new URL(requestTemplate.url),
        headers,
        cookies: {},
        bodyFormat: requestTemplate.bodyFormat,
        bodyJson: cloneStructured(requestTemplate.bodyJson ?? null),
        bodyForm: requestTemplate.bodyForm
            ? buildUrlSearchParamsFromRecord(requestTemplate.bodyForm)
            : null,
        bodyRaw: requestTemplate.bodyRaw ?? null,
        rawJsonPlaceholders: new Map(),
    }
}

function applyResolvedSlotValue(
    template: RequestTemplateState,
    slot: ApiRequestSlot,
    value: unknown,
    options?: {
        allowRawJsonPlaceholders?: boolean
    }
): void {
    const textValue = stringifyResolvedSlotValue(value)
    if (slot.source === 'path') {
        const match = slot.slotPath.match(/^path\[(\d+)\]$/)
        if (!match) return
        const index = Number.parseInt(match[1] || '0', 10)
        const segments = template.url.pathname.split('/').filter(Boolean)
        segments[index] = textValue
        template.url.pathname = `/${segments.join('/')}`
        return
    }
    if (slot.source === 'query') {
        const key = slot.slotPath.replace(/^query\./, '')
        template.url.searchParams.set(key, textValue)
        return
    }
    if (slot.source === 'header') {
        const key = slot.slotPath.replace(/^headers\./, '')
        template.headers[key] = textValue
        return
    }
    if (slot.source === 'cookie') {
        const key = readCookieNameFromSlotPath(slot.slotPath)
        if (key) {
            if (textValue) {
                template.cookies[key] = textValue
            } else {
                delete template.cookies[key]
            }
        }
        return
    }
    const bodyPath = slot.slotPath.replace(/^body\./, '')
    if (template.bodyFormat === 'json' && template.bodyJson != null && bodyPath) {
        setValueAtDataPath(
            template.bodyJson,
            bodyPath,
            coerceResolvedJsonValue(
                template,
                bodyPath,
                value,
                options?.allowRawJsonPlaceholders === true
            )
        )
        return
    }
    if (template.bodyFormat === 'form' && template.bodyForm) {
        template.bodyForm.set(bodyPath, textValue)
        return
    }
    if (template.bodyRaw) {
        template.bodyRaw = template.bodyRaw.split(slot.rawValue).join(textValue)
    }
}

function buildUrlSearchParamsFromRecord(
    value: Record<string, string | string[]>
): URLSearchParams {
    const params = new URLSearchParams()
    for (const [key, entry] of Object.entries(value)) {
        if (Array.isArray(entry)) {
            entry.forEach((item) => params.append(key, item))
            continue
        }
        params.set(key, entry)
    }
    return params
}

function stringifyResolvedSlotValue(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value)
    }
    if (value == null) return ''
    return JSON.stringify(value)
}

function coerceResolvedJsonValue(
    template: RequestTemplateState,
    bodyPath: string,
    value: unknown,
    allowRawJsonPlaceholders: boolean
): unknown {
    const existingValue = getValueAtDataPath(template.bodyJson, bodyPath)
    if (typeof existingValue === 'number') {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value
        }
        if (allowRawJsonPlaceholders && typeof value === 'string' && looksLikeShellPlaceholder(value)) {
            return createRawJsonPlaceholder(template, value)
        }
        const normalized = Number.parseFloat(String(value).trim())
        if (Number.isFinite(normalized)) {
            return normalized
        }
        throw new Error(`Expected numeric JSON value at ${bodyPath}, received ${JSON.stringify(value)}.`)
    }
    if (typeof existingValue === 'boolean') {
        if (typeof value === 'boolean') {
            return value
        }
        if (allowRawJsonPlaceholders && typeof value === 'string' && looksLikeShellPlaceholder(value)) {
            return createRawJsonPlaceholder(template, value)
        }
        const normalized = String(value).trim().toLowerCase()
        if (normalized === 'true') return true
        if (normalized === 'false') return false
        throw new Error(`Expected boolean JSON value at ${bodyPath}, received ${JSON.stringify(value)}.`)
    }
    return value
}

function looksLikeShellPlaceholder(value: string): boolean {
    return /^\$\{[A-Za-z0-9_]+\}$/.test(value)
}

function createRawJsonPlaceholder(
    template: RequestTemplateState,
    placeholder: string
): string {
    const token = `__OPENSTEER_RAW_JSON__${Buffer.from(placeholder).toString('base64url')}__`
    template.rawJsonPlaceholders.set(token, placeholder)
    return token
}

function serializeRequestBodyTemplate(template: RequestTemplateState): string | null {
    if (template.bodyFormat === 'json' && template.bodyJson != null) {
        const serialized = JSON.stringify(template.bodyJson)
        return restoreRawJsonPlaceholders(serialized, template.rawJsonPlaceholders)
    }
    if (template.bodyFormat === 'form' && template.bodyForm) {
        return template.bodyForm.toString()
    }
    return template.bodyRaw
}

function restoreRawJsonPlaceholders(
    serialized: string,
    placeholders: Map<string, string>
): string {
    let output = serialized
    for (const [token, placeholder] of placeholders.entries()) {
        output = output.split(JSON.stringify(token)).join(placeholder)
    }
    return output
}

function serializeCookieHeaderValue(template: RequestTemplateState): string | null {
    const entries = Object.entries(template.cookies)
    if (!entries.length) return null
    return entries.map(([key, value]) => `${key}=${value}`).join('; ')
}

function setValueAtDataPath(root: unknown, pathValue: string, value: unknown): void {
    const tokens = parseDataPath(pathValue)
    if (!tokens || !tokens.length) return
    let current: unknown = root
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]
        const isLast = index === tokens.length - 1
        if (token.kind === 'prop') {
            if (!current || typeof current !== 'object' || Array.isArray(current)) return
            const objectRef = current as Record<string, unknown>
            if (isLast) {
                objectRef[token.key] = value
                return
            }
            current = objectRef[token.key]
            continue
        }
        if (!Array.isArray(current)) return
        if (isLast) {
            current[token.index] = value
            return
        }
        current = current[token.index]
    }
}

function getValueAtDataPath(root: unknown, pathValue: string): unknown {
    const tokens = parseDataPath(pathValue)
    if (!tokens || !tokens.length) return root
    let current: unknown = root
    for (const token of tokens) {
        if (token.kind === 'prop') {
            if (!current || typeof current !== 'object' || Array.isArray(current)) return null
            current = (current as Record<string, unknown>)[token.key]
            continue
        }
        if (!Array.isArray(current)) return null
        current = current[token.index]
    }
    return current
}

function sanitizeExecutionHeaderObject(headers: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).filter(
            ([key]) =>
                !key.startsWith(':') &&
                !HTTP_EXECUTION_HEADER_BLOCKLIST.has(key.toLowerCase())
        )
    )
}

function sanitizeBrowserFetchHeaderObject(headers: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).filter(([key]) => isBrowserFetchHeaderAllowed(key))
    )
}

function isBrowserFetchHeaderAllowed(name: string): boolean {
    const normalized = name.toLowerCase()
    if (BROWSER_FETCH_HEADER_BLOCKLIST.has(normalized)) {
        return false
    }
    if (normalized.startsWith('proxy-') || normalized.startsWith('sec-')) {
        return false
    }
    return true
}

async function executeDirectHttpStep(
    method: string,
    resolved: {
        url: string
        headers: Record<string, string>
        body: string | null
        cookieHeader: string | null
    }
): Promise<ExecutedStepState> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
        const headers = resolved.cookieHeader
            ? {
                  ...resolved.headers,
                  cookie: resolved.cookieHeader,
              }
            : resolved.headers
        const response = await fetch(resolved.url, {
            method,
            headers,
            body:
                method === 'GET' || method === 'HEAD'
                    ? undefined
                    : resolved.body || undefined,
            redirect: 'follow',
            signal: controller.signal,
        })
        return readFetchResponse(response)
    } finally {
        clearTimeout(timeout)
    }
}

async function executeBrowserStep(
    opensteer: Opensteer,
    method: string,
    resolved: {
        url: string
        headers: Record<string, string>
        body: string | null
        cookieHeader: string | null
    }
): Promise<ExecutedStepState> {
    const response = await opensteer.page.evaluate(
        async ({ url, method, headers, body, includeCredentials }) => {
            const requestHeaders = new Headers()
            for (const [key, value] of Object.entries(headers)) {
                try {
                    requestHeaders.set(key, value)
                } catch {
                    continue
                }
            }
            const response = await window.fetch(url, {
                method,
                headers: requestHeaders,
                body:
                    method === 'GET' || method === 'HEAD'
                        ? undefined
                        : body || undefined,
                credentials: includeCredentials ? 'include' : 'same-origin',
                redirect: 'follow',
            })
            const responseHeaders: Record<string, string> = {}
            response.headers.forEach((value, key) => {
                responseHeaders[key] = value
            })
            return {
                status: response.status,
                headers: responseHeaders,
                text: await response.text(),
                url: response.url,
            }
        },
        {
            url: resolved.url,
            method,
            headers: sanitizeBrowserFetchHeaderObject(resolved.headers),
            body: resolved.body,
            includeCredentials: resolved.cookieHeader != null,
        }
    )
    return readBrowserFetchResponse(response)
}

function readBrowserFetchResponse(response: {
    status: number
    headers: Record<string, string>
    text: string
    url: string
}): ExecutedStepState {
    const mime = summarizeMime(response.headers['content-type'])
    return {
        status: response.status,
        mime,
        text: response.text,
        json: mime === 'application/json' ? safeJsonParse(response.text) : null,
        url: response.url,
        headers: normalizeHeaderRecord(response.headers),
    }
}

async function readFetchResponse(response: globalThis.Response): Promise<ExecutedStepState> {
    const text = await response.text()
    const headers = normalizeHeaderRecord(Object.fromEntries(response.headers.entries()))
    const mime = summarizeMime(headers['content-type'])
    return {
        status: response.status,
        mime,
        text,
        json: mime === 'application/json' ? safeJsonParse(text) : null,
        url: response.url,
        headers,
    }
}

async function seedBrowserCookies(
    opensteer: Opensteer,
    requestUrl: string,
    cookieHeader: string | null
): Promise<void> {
    if (!cookieHeader) return
    const cookies = parseCookieHeader(cookieHeader).map(([name, value]) => ({
        name,
        value,
        url: requestUrl,
    }))
    if (!cookies.length) return
    await opensteer.context.addCookies(cookies)
}

function parseCookieHeader(value: string): Array<[string, string]> {
    const output: Array<[string, string]> = []
    for (const part of value.split(';').map((entry) => entry.trim()).filter(Boolean)) {
        const [name, ...rest] = part.split('=')
        const cookieName = name || ''
        const cookieValue = rest.join('=')
        if (!cookieName || !cookieValue) continue
        output.push([cookieName, cookieValue])
    }
    return output
}

function normalizeHeaderRecord(headers: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
    )
}

function normalizeInputMap(raw: Record<string, unknown> | string | null | undefined): Record<string, string> {
    if (!raw) return {}
    if (typeof raw === 'string') {
        const parsed = safeJsonParse<Record<string, unknown>>(raw)
        return normalizeInputMap(parsed || {})
    }
    return Object.fromEntries(
        Object.entries(raw)
            .filter(([, value]) => value != null)
            .map(([key, value]) => [key, String(value)])
    )
}

function readCookieNameFromSlotPath(slotPath: string): string | null {
    const match = slotPath.match(/^cookies?\.([^.[\]]+)$/i)
    return match?.[1] ?? null
}

function evaluateOracle(
    plan: ApiPlanIr,
    state: ExecutedStepState | null
): ApiOracleCheckResult[] {
    const oracle = plan.successOracle
    const checks: ApiOracleCheckResult[] = []

    if (oracle.status != null) {
        checks.push({
            kind: 'status',
            ok: state?.status === oracle.status,
            detail: `Expected status ${oracle.status}, got ${String(state?.status ?? null)}.`,
        })
    }

    if (oracle.mime != null) {
        checks.push({
            kind: 'mime',
            ok: (state?.mime ?? null) === oracle.mime,
            detail: `Expected MIME ${oracle.mime}, got ${String(state?.mime ?? null)}.`,
        })
    }

    if (oracle.requireNoAuthRedirect) {
        const url = state?.url ?? ''
        checks.push({
            kind: 'redirect_absent',
            ok: !isAuthRedirectUrl(url),
            detail: url ? `Final URL ${url}.` : 'No final URL recorded.',
        })
    }

    for (const fragment of oracle.redirectContains || []) {
        const url = state?.url ?? ''
        checks.push({
            kind: 'redirect_contains',
            ok: url.includes(fragment),
            detail: `Expected final URL to include "${fragment}".`,
        })
    }

    for (const check of oracle.jsonPathChecks || []) {
        const value = getValueAtDataPath(state?.json, check.path)
        const exists = value != null
        const existsExpected = check.exists ?? true
        const equalsExpected = check.equals
        const ok =
            exists === existsExpected &&
            (equalsExpected == null || String(value) === equalsExpected)
        checks.push({
            kind: 'json_path',
            ok,
            detail: `JSON path ${check.path} resolved to ${JSON.stringify(value)}.`,
        })
    }

    for (const token of oracle.textMustContain || []) {
        checks.push({
            kind: 'text_contains',
            ok: state?.text?.includes(token) === true,
            detail: `Expected response text to contain "${token}".`,
        })
    }

    for (const token of oracle.textMustNotContain || []) {
        checks.push({
            kind: 'text_not_contains',
            ok: !state?.text?.includes(token),
            detail: `Expected response text to omit "${token}".`,
        })
    }

    if (oracle.expectsDownload || oracle.download?.expectedFilename) {
        const contentDisposition = state?.headers['content-disposition'] ?? ''
        const expectedFilename = oracle.download?.expectedFilename
        const hasDownload = /attachment/i.test(contentDisposition) || expectedFilename != null
        const filenameMatches =
            !expectedFilename || contentDisposition.includes(expectedFilename)
        checks.push({
            kind: 'download',
            ok: hasDownload && filenameMatches,
            detail: `Download header: ${contentDisposition || 'none'}.`,
        })
    }

    return checks
}

function classifyExecutionError(message: string): ApiValidationFailureKind {
    if (/unsupported plan binding|missing an executable request template|missing a resolver/i.test(message)) {
        return 'unsupported_plan'
    }
    if (/browser runtime was not prepared|live browser session/i.test(message)) {
        return 'runtime_unavailable'
    }
    if (/Session cookie|Storage key|DOM field|Script JSON value/i.test(message)) {
        return 'session_missing'
    }
    if (/Derived response/i.test(message)) {
        return 'schema_drift'
    }
    return 'oracle_failed'
}

function classifyOracleFailure(
    state: ExecutedStepState | null,
    checks: ApiOracleCheckResult[]
): ApiValidationFailureKind {
    if (!state) {
        return 'oracle_failed'
    }
    if (state.status === 401 || state.status === 403) {
        return 'session_expired'
    }
    if (isAuthRedirectUrl(state.url ?? '')) {
        return 'auth_redirect'
    }
    if (
        checks.some(
            (check) =>
                check.kind === 'json_path' ||
                check.kind === 'status'
        )
    ) {
        return 'schema_drift'
    }
    return 'oracle_failed'
}

function isAuthRedirectUrl(url: string): boolean {
    if (!url) {
        return false
    }
    try {
        const parsed = new URL(url)
        return AUTH_REDIRECT_PATTERN.test(`${parsed.pathname}${parsed.hash}`)
    } catch {
        return AUTH_REDIRECT_PATTERN.test(url)
    }
}

function cloneStructured<T>(value: T): T {
    if (value == null) return value
    return JSON.parse(JSON.stringify(value)) as T
}
