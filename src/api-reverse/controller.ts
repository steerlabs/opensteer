import { createWriteStream, type WriteStream } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import type { CDPSession, Download, Page, Response } from 'playwright'
import type { Opensteer } from '../opensteer.js'
import { ApiValueRegistry, redactRecordStrings } from './redact.js'
import { buildApiRef, isApiRefKind } from './refs.js'
import {
    buildUrlTemplate,
    getOrigin,
    hashText,
    inferGraphqlMetadata,
    normalizeRequestSignature,
    normalizePrimitive,
    safeJsonParse,
    summarizeMime,
} from './normalize.js'
import type {
    ApiActionSpan,
    ApiCandidateReason,
    ApiCandidateRow,
    ApiCodegenLanguage,
    ApiDownloadRecord,
    ApiExportFormat,
    ApiPageSnapshotSummary,
    ApiPlanFallbackMode,
    ApiPlanInput,
    ApiPlanIr,
    ApiPlanStep,
    ApiPlanValidationMode,
    ApiRequestBodyRecord,
    ApiRequestMatchType,
    ApiRequestRecord,
    ApiResponseBodyRecord,
    ApiRuntimeStatus,
    ApiStorageSnapshot,
    ApiValidationReport,
    ApiValueTraceCandidate,
} from './types.js'

const MAX_CAPTURED_BODY_BYTES = 256_000
const CANDIDATE_LIMIT = 20
const REQUEST_TIMEOUT_MS = 30_000
const MUTATING_COMMANDS = new Set([
    'navigate',
    'back',
    'forward',
    'reload',
    'click',
    'dblclick',
    'rightclick',
    'hover',
    'input',
    'select',
    'scroll',
    'press',
    'type',
    'tab-new',
    'tab-switch',
    'tab-close',
])
const HTTP_EXECUTION_HEADER_BLOCKLIST = new Set([
    'accept-encoding',
    'connection',
    'content-length',
    'host',
])

interface ApiReverseControllerOptions {
    scopeDir: string
    logicalSession: string
}

interface InternalRequestRecord extends ApiRequestRecord {
    requestBody: ApiRequestBodyRecord | null
    responseBody: ApiResponseBodyRecord | null
}

interface InternalRunState {
    ref: string
    id: string
    dir: string
    startedAt: number
    active: boolean
    session: CDPSession
    captureStream: WriteStream
    requestsById: Map<string, InternalRequestRecord>
    requestOrder: string[]
    spans: ApiActionSpan[]
    downloads: ApiDownloadRecord[]
    values: ApiValueRegistry
    plans: ApiPlanIr[]
    validations: ApiValidationReport[]
    nextRequestId: number
    nextSpanId: number
    nextDownloadId: number
    nextPlanId: number
    nextValidationId: number
    activeManualSpanRef: string | null
}

interface TraceSearchResult extends ApiValueTraceCandidate {
    producerRef: string
}

interface RequestSlot {
    name: string
    slotPath: string
    rawValue: string
    source: 'path' | 'query' | 'body' | 'header' | 'cookie'
}

interface SpanToken {
    ref: string
}

export class ApiReverseController {
    private readonly opensteer: Opensteer
    private readonly scopeDir: string
    private readonly logicalSession: string
    private runSequence = 0
    private currentRun: InternalRunState | null = null
    private readonly responseListener = (response: Response) => {
        this.handlePlaywrightResponse(response)
    }
    private readonly downloadListener = (download: Download) => {
        this.handleDownload(download)
    }

    constructor(opensteer: Opensteer, options: ApiReverseControllerOptions) {
        this.opensteer = opensteer
        this.scopeDir = options.scopeDir
        this.logicalSession = options.logicalSession
    }

    isMutatingCommand(command: string): boolean {
        return MUTATING_COMMANDS.has(command)
    }

    async startCapture(): Promise<ApiRuntimeStatus> {
        if (this.currentRun?.active) {
            throw new Error('API capture is already active for this session.')
        }

        const page = this.opensteer.page
        let session: CDPSession
        try {
            session = await page.context().newCDPSession(page)
        } catch (error) {
            throw new Error(
                'API capture requires Chromium CDP support for the current page.',
                { cause: error }
            )
        }

        this.runSequence += 1
        const startedAt = Date.now()
        const ref = buildApiRef('run', this.runSequence)
        const id = buildRunId(this.runSequence, startedAt)
        const dir = path.join(
            this.scopeDir,
            '.opensteer',
            'api',
            'runs',
            id
        )
        await mkdir(path.join(dir, 'plans'), { recursive: true })
        await mkdir(path.join(dir, 'validations'), { recursive: true })
        await mkdir(path.join(dir, 'codegen'), { recursive: true })

        const captureStream = createWriteStream(path.join(dir, 'capture.ndjson'), {
            flags: 'a',
        })

        const run: InternalRunState = {
            ref,
            id,
            dir,
            startedAt,
            active: true,
            session,
            captureStream,
            requestsById: new Map(),
            requestOrder: [],
            spans: [],
            downloads: [],
            values: new ApiValueRegistry(),
            plans: [],
            validations: [],
            nextRequestId: 1,
            nextSpanId: 1,
            nextDownloadId: 1,
            nextPlanId: 1,
            nextValidationId: 1,
            activeManualSpanRef: null,
        }

        this.currentRun = run
        this.attachSessionListeners(run)
        this.attachPageListeners()

        await session.send('Network.enable')
        await this.writeManifest(run)

        return this.getStatus()
    }

    async stopCapture(): Promise<ApiRuntimeStatus> {
        const run = this.requireRun()
        if (run.activeManualSpanRef) {
            await this.stopManualSpan()
        }
        run.active = false
        this.detachPageListeners()
        await run.session.detach().catch(() => undefined)
        await this.flushArtifacts(run)
        run.captureStream.end()
        return this.getStatus()
    }

    async shutdown(): Promise<void> {
        const run = this.currentRun
        if (!run) return
        if (run.active) {
            await this.stopCapture().catch(() => undefined)
        }
        this.currentRun = null
    }

    getStatus(): ApiRuntimeStatus {
        const run = this.currentRun
        return {
            active: Boolean(run?.active),
            runRef: run ? run.ref : null,
            runDir: run ? run.dir : null,
            requestCount: run?.requestOrder.length || 0,
            spanCount: run?.spans.length || 0,
            planCount: run?.plans.length || 0,
            validationCount: run?.validations.length || 0,
            activeManualSpanRef: run ? run.activeManualSpanRef : null,
        }
    }

    listSpans(): ApiActionSpan[] {
        const run = this.requireRun()
        return redactRecordStrings(run.spans, run.values)
    }

    async startManualSpan(label: string): Promise<ApiActionSpan> {
        const run = this.requireRun(true)
        if (run.activeManualSpanRef) {
            throw new Error('A manual API span is already active.')
        }

        const span = await this.createSpan(run, label, 'manual', null)
        run.activeManualSpanRef = span.ref
        await this.flushArtifacts(run)
        return redactRecordStrings(span, run.values)
    }

    async stopManualSpan(): Promise<ApiActionSpan> {
        const run = this.requireRun()
        if (!run.activeManualSpanRef) {
            throw new Error('No manual API span is active.')
        }

        const span = run.spans.find((candidate) => candidate.ref === run.activeManualSpanRef)
        if (!span) {
            throw new Error('The active manual API span could not be found.')
        }

        await this.finalizeSpan(run, span)
        run.activeManualSpanRef = null
        await this.flushArtifacts(run)
        return redactRecordStrings(span, run.values)
    }

    async beginAutomaticSpan(
        command: string,
        args: Record<string, unknown>
    ): Promise<SpanToken | null> {
        const run = this.currentRun
        if (!run?.active) return null
        if (run.activeManualSpanRef) return null

        const label = buildAutomaticSpanLabel(command, args)
        const span = await this.createSpan(run, label, 'automatic', command)
        return { ref: span.ref }
    }

    async endAutomaticSpan(token: SpanToken | null): Promise<void> {
        if (!token) return
        const run = this.currentRun
        if (!run) return
        const span = run.spans.find((candidate) => candidate.ref === token.ref)
        if (!span || span.endedAt) return
        await this.finalizeSpan(run, span)
        await this.flushArtifacts(run)
    }

    listRequests(options?: {
        spanRef?: string | null
        kind?: 'candidates' | 'all'
        limit?: number
    }): ApiCandidateRow[] {
        const run = this.requireRun()
        const span = options?.spanRef ? this.getSpan(run, options.spanRef) : null
        const requests = this.getRequestsForSpan(run, span?.ref || null)
        const candidates = requests.map((request) =>
            this.buildCandidateRow(run, request, span)
        )

        if (options?.kind === 'all') {
            return candidates
                .sort((left, right) =>
                    compareRequestRefs(right.ref, left.ref)
                )
                .slice(0, options?.limit ?? CANDIDATE_LIMIT)
        }

        return candidates
            .sort((left, right) => right.candidateScore - left.candidateScore)
            .slice(0, options?.limit ?? CANDIDATE_LIMIT)
    }

    inspectRequest(
        ref: string,
        options?: {
            body?: 'summary' | 'full'
            raw?: boolean
        }
    ): Record<string, unknown> {
        const run = this.requireRun()
        const request = this.getRequest(run, ref)
        const span = request.spanRef ? this.getSpan(run, request.spanRef) : null
        const bodyMode = options?.body || 'summary'
        const dossier = {
            ref: request.ref,
            method: request.method,
            url: request.url,
            urlTemplate: request.urlTemplate,
            requestId: request.requestId,
            status: request.status,
            ok: request.ok,
            failed: request.failed,
            failureText: request.failureText,
            resourceType: request.resourceType,
            responseMime: request.responseMime,
            signature: request.signature,
            spanRef: request.spanRef,
            matchedDownloadRef: request.matchedDownloadRef,
            matchedNavigation: request.matchedNavigation,
            fromServiceWorker: request.fromServiceWorker,
            hasUserGesture: request.hasUserGesture,
            initiator: {
                type: request.initiatorType,
                url: request.initiatorUrl,
                requestRef: request.initiatorRequestRef,
            },
            redirectFromRef: request.redirectFromRef,
            graphql: request.graphql,
            spanEffects: span?.effects || [],
            requestHeaders: request.requestHeaders,
            responseHeaders: request.responseHeaders,
            requestBody:
                bodyMode === 'summary'
                    ? summarizeBodyRecord(request.requestBody)
                    : request.requestBody,
            responseBody:
                bodyMode === 'summary'
                    ? summarizeBodyRecord(request.responseBody)
                    : request.responseBody,
            artifactPaths: {
                capture: path.join(run.dir, 'capture.ndjson'),
                requestIndex: path.join(run.dir, 'request-index.json'),
            },
        }

        if (options?.raw) {
            return dossier
        }
        return redactRecordStrings(dossier, run.values)
    }

    traceValue(
        query: string,
        options?: {
            spanRef?: string | null
        }
    ): {
        valueRef: string | null
        query: string
        candidates: ApiValueTraceCandidate[]
    } {
        const run = this.requireRun()
        const valueRecord = isApiRefKind(query, 'value')
            ? run.values.getByRef(query)
            : null
        const rawValue = valueRecord ? valueRecord.raw : query
        const span = options?.spanRef ? this.getSpan(run, options.spanRef) : null
        const candidates = this.traceValueInternal(run, rawValue, {
            limitToSpanRef: span?.ref || null,
        }).map((candidate) => redactRecordStrings(candidate, run.values))

        return {
            valueRef: run.values.getByRaw(rawValue)?.ref || null,
            query: run.values.redactString(rawValue).value,
            candidates,
        }
    }

    async inferPlan(args: {
        task: string
        spanRef?: string | null
    }): Promise<ApiPlanIr> {
        const run = this.requireRun()
        const span = args.spanRef ? this.getSpan(run, args.spanRef) : null
        const target = this.chooseTargetRequest(run, span?.ref || null)
        if (!target) {
            throw new Error('No candidate request could be selected for inference.')
        }

        const visited = new Set<string>()
        const inputs: ApiPlanInput[] = []
        const unresolved = new Set<string>()
        const steps: ApiPlanStep[] = []

        const visit = (request: InternalRequestRecord): void => {
            if (visited.has(request.ref)) return
            visited.add(request.ref)

            const slots = this.extractRequestSlots(run, request)
            for (const slot of slots) {
                const trace = this.traceValueInternal(run, slot.rawValue, {
                    beforeRequestRef: request.ref,
                }).filter((candidate) => candidate.producerRef !== request.ref)

                const best = trace[0]
                if (best) {
                    const producer = this.getRequest(run, best.producerRef)
                    visit(producer)
                    inputs.push({
                        name: slot.name,
                        slotPath: slot.slotPath,
                        valueRef: run.values.getByRaw(slot.rawValue)?.ref || null,
                        source: resolveInputSource(best.location),
                        producerRef: best.producerRef,
                        sourceLocation: best.location,
                        transformChain: best.transformChain,
                    })
                    continue
                }

                const userInput =
                    slot.source === 'query' ||
                    slot.source === 'path' ||
                    slot.source === 'body'
                inputs.push({
                    name: slot.name,
                    slotPath: slot.slotPath,
                    valueRef: run.values.getByRaw(slot.rawValue)?.ref || null,
                    source: userInput ? 'user_input' : 'unresolved',
                    transformChain: [],
                })
                if (!userInput) {
                    unresolved.add(slot.slotPath)
                }
            }

            steps.push({
                id: `step_${steps.length + 1}`,
                requestRef: request.ref,
                method: request.method,
                urlTemplate: request.urlTemplate,
                extracts: inputs
                    .filter((input) => input.producerRef === request.ref)
                    .map((input) => input.name),
                httpExecutable: isHttpExecutableRequest(request),
            })
        }

        visit(target)

        const plan: ApiPlanIr = {
            ref: buildApiRef('plan', run.nextPlanId++),
            operation: slugifyOperationName(args.task),
            task: args.task,
            createdAt: Date.now(),
            targetRequestRef: target.ref,
            confidence: clampConfidence(target, unresolved.size),
            transport: 'http',
            fallbackMode: resolveFallbackMode(target, unresolved.size),
            inputs: dedupePlanInputs(inputs),
            steps,
            extracts: dedupeStrings(inputs.map((input) => input.name)),
            successOracle: {
                status: target.status,
                mime: target.responseMime,
                expectsDownload: Boolean(target.matchedDownloadRef),
            },
            unresolvedSlots: [...unresolved],
        }

        run.plans.push(plan)
        await this.writePlanArtifact(run, plan)
        await this.flushArtifacts(run)
        return redactRecordStrings(plan, run.values)
    }

    inspectPlan(ref: string): ApiPlanIr {
        const run = this.requireRun()
        const plan = run.plans.find((candidate) => candidate.ref === ref)
        if (!plan) {
            throw new Error(`Unknown API plan ref "${ref}".`)
        }
        return redactRecordStrings(plan, run.values)
    }

    async validatePlan(args: {
        ref: string
        mode: ApiPlanValidationMode
    }): Promise<ApiValidationReport> {
        const run = this.requireRun()
        const plan = run.plans.find((candidate) => candidate.ref === args.ref)
        if (!plan) {
            throw new Error(`Unknown API plan ref "${args.ref}".`)
        }

        const report: ApiValidationReport = {
            ref: buildApiRef('validation', run.nextValidationId++),
            planRef: plan.ref,
            createdAt: Date.now(),
            mode: args.mode,
            steps: [],
            oracle: {
                statusMatches: false,
                mimeMatches: false,
            },
            notes: [],
        }

        if (args.mode === 'dry-run') {
            report.notes.push('Dry-run validated plan assembly only.')
            report.oracle.statusMatches = true
            report.oracle.mimeMatches = true
        } else {
            for (const step of plan.steps) {
                const request = this.getRequest(run, step.requestRef)
                if (!step.httpExecutable) {
                    report.steps.push({
                        stepId: step.id,
                        requestRef: step.requestRef,
                        ok: false,
                        status: null,
                        mime: null,
                        error: 'Step requires browser assistance and cannot be executed as direct HTTP.',
                    })
                    continue
                }
                const executionResult = await executeCapturedHttpRequest(request)
                report.steps.push({
                    stepId: step.id,
                    requestRef: step.requestRef,
                    ok: executionResult.ok,
                    status: executionResult.status,
                    mime: executionResult.mime,
                    error: executionResult.error,
                })
            }

            const targetStep = report.steps[report.steps.length - 1]
            report.oracle.statusMatches =
                targetStep?.status === plan.successOracle.status
            report.oracle.mimeMatches =
                (targetStep?.mime || null) === plan.successOracle.mime

            if (plan.fallbackMode !== 'http_only') {
                report.notes.push(
                    `Plan fallback mode is ${plan.fallbackMode}; browser assistance may still be required.`
                )
            }
        }

        run.validations.push(report)
        await this.writeValidationArtifact(run, report)
        await this.flushArtifacts(run)
        return redactRecordStrings(report, run.values)
    }

    async codegenPlan(args: {
        ref: string
        lang: ApiCodegenLanguage
    }): Promise<{
        file: string
        language: ApiCodegenLanguage
    }> {
        const run = this.requireRun()
        const plan = run.plans.find((candidate) => candidate.ref === args.ref)
        if (!plan) {
            throw new Error(`Unknown API plan ref "${args.ref}".`)
        }

        const file = path.join(
            run.dir,
            'codegen',
            `${plan.ref.slice(1)}.${args.lang === 'ts' ? 'ts' : 'py'}`
        )
        const rendered =
            args.lang === 'ts'
                ? renderTypeScriptClient(run, plan)
                : renderPythonClient(run, plan)
        await writeFile(file, rendered, 'utf8')
        await this.flushArtifacts(run)
        return { file, language: args.lang }
    }

    async exportPlan(args: {
        ref: string
        format: ApiExportFormat
    }): Promise<{
        file: string
        format: ApiExportFormat
    }> {
        const run = this.requireRun()
        const plan = run.plans.find((candidate) => candidate.ref === args.ref)
        if (!plan) {
            throw new Error(`Unknown API plan ref "${args.ref}".`)
        }

        const file = path.join(run.dir, 'plans', `${plan.ref.slice(1)}.${args.format === 'ir' ? 'json' : args.format === 'openapi' ? 'openapi.json' : 'sh'}`)
        const content =
            args.format === 'ir'
                ? JSON.stringify(plan, null, 2)
                : args.format === 'openapi'
                  ? JSON.stringify(renderOpenApi(run, plan), null, 2)
                  : renderCurlScript(run, plan)
        await writeFile(file, content, 'utf8')
        return { file, format: args.format }
    }

    private attachSessionListeners(run: InternalRunState): void {
        const session = run.session

        session.on('Network.requestWillBeSent', (params: unknown) => {
            void this.handleRequestWillBeSent(run, params)
        })
        session.on('Network.responseReceived', (params: unknown) => {
            this.handleResponseReceived(run, params)
        })
        session.on('Network.loadingFinished', (params: unknown) => {
            void this.handleLoadingFinished(run, params)
        })
        session.on('Network.loadingFailed', (params: unknown) => {
            this.handleLoadingFailed(run, params)
        })
        session.on('Network.webSocketCreated', (params: unknown) => {
            this.handleWebSocketCreated(run, params)
        })
        session.on('Network.webSocketFrameSent', (params: unknown) => {
            this.appendCaptureEvent(run, {
                type: 'websocket_frame_sent',
                at: Date.now(),
                payload: params,
            })
        })
        session.on('Network.webSocketFrameReceived', (params: unknown) => {
            this.appendCaptureEvent(run, {
                type: 'websocket_frame_received',
                at: Date.now(),
                payload: params,
            })
        })
        session.on('Network.eventSourceMessageReceived', (params: unknown) => {
            this.appendCaptureEvent(run, {
                type: 'eventsource_message',
                at: Date.now(),
                payload: params,
            })
        })
    }

    private attachPageListeners(): void {
        this.opensteer.page.on('response', this.responseListener)
        this.opensteer.page.on('download', this.downloadListener)
    }

    private detachPageListeners(): void {
        this.opensteer.page.off('response', this.responseListener)
        this.opensteer.page.off('download', this.downloadListener)
    }

    private async handleRequestWillBeSent(
        run: InternalRunState,
        params: unknown
    ): Promise<void> {
        const record = asRecord(params)
        const requestId = asString(record.requestId)
        const requestPayload = asRecord(record.request)
        const url = asString(requestPayload.url)
        const method = asString(requestPayload.method) || 'GET'
        if (!requestId || !url) return

        const requestHeaders = normalizeHeaders(asRecord(requestPayload.headers))
        const rawPostData = asString(requestPayload.postData) || null
        const parsedRequestBody = safeJsonParse(rawPostData)
        const graphql = inferGraphqlMetadata(parsedRequestBody)
        const resourceType = asString(record.type)?.toLowerCase() || null
        const responseMime = null
        const entry: InternalRequestRecord = {
            ref: buildApiRef('request', run.nextRequestId++),
            requestId,
            startedAt: Date.now(),
            finishedAt: null,
            method,
            url,
            urlTemplate: buildUrlTemplate(url),
            resourceType,
            status: null,
            ok: null,
            failed: false,
            failureText: null,
            requestHeaders,
            responseHeaders: {},
            requestBody: buildBodyRecord(rawPostData, requestHeaders['content-type']),
            responseBody: null,
            responseMime,
            responseSize: null,
            hasUserGesture: Boolean(record.hasUserGesture),
            initiatorType: asString(asRecord(record.initiator).type) || null,
            initiatorUrl: resolveInitiatorUrl(asRecord(record.initiator)),
            initiatorRequestRef: null,
            redirectFromRef: resolveRedirectRef(run, asRecord(record.redirectResponse), url),
            fromServiceWorker: null,
            graphql,
            signature: normalizeRequestSignature({
                method,
                url,
                resourceType,
                body: parsedRequestBody ?? rawPostData,
                graphql,
            }),
            spanRef: run.activeManualSpanRef,
            matchedDownloadRef: null,
            matchedNavigation: false,
        }

        this.captureValueOccurrences(run, entry.requestHeaders, {
            requestRef: entry.ref,
            source: 'request.header',
        })
        const parsedUrl = new URL(url)
        for (const [key, value] of parsedUrl.searchParams.entries()) {
            run.values.register(value, {
                requestRef: entry.ref,
                source: 'request.query',
                path: key,
            }, {
                key,
                requestRef: entry.ref,
            })
        }
        if (entry.requestBody?.raw) {
            this.captureBodyValues(run, entry.requestBody.raw, entry.ref, 'request.body')
        }

        run.requestsById.set(requestId, entry)
        run.requestOrder.push(entry.ref)
        this.appendCaptureEvent(run, {
            type: 'request',
            at: entry.startedAt,
            payload: {
                ref: entry.ref,
                requestId,
                method,
                url,
            },
        })
    }

    private handleResponseReceived(run: InternalRunState, params: unknown): void {
        const record = asRecord(params)
        const requestId = asString(record.requestId)
        if (!requestId) return
        const request = run.requestsById.get(requestId)
        if (!request) return

        const response = asRecord(record.response)
        request.status = asNumber(response.status)
        request.ok =
            typeof request.status === 'number'
                ? request.status >= 200 && request.status < 400
                : null
        request.responseMime = summarizeMime(asString(response.mimeType) || null)
        request.responseHeaders = normalizeHeaders(asRecord(response.headers))
        request.responseSize = asNumber(response.encodedDataLength)
    }

    private async handleLoadingFinished(
        run: InternalRunState,
        params: unknown
    ): Promise<void> {
        const record = asRecord(params)
        const requestId = asString(record.requestId)
        if (!requestId) return
        const request = run.requestsById.get(requestId)
        if (!request) return

        request.finishedAt = Date.now()
        request.responseSize = asNumber(record.encodedDataLength) ?? request.responseSize

        try {
            const payload = (await run.session.send('Network.getResponseBody', {
                requestId,
            })) as Record<string, unknown>
            const rawBody = typeof payload.body === 'string' ? payload.body : null
            const base64Encoded = payload.base64Encoded === true
            const decoded = rawBody
                ? decodeResponseBody(rawBody, base64Encoded)
                : null
            request.responseBody = buildBodyRecord(
                decoded,
                request.responseMime,
                rawBody ? Buffer.byteLength(rawBody, 'utf8') : 0,
                base64Encoded
            )
            if (decoded) {
                this.captureBodyValues(run, decoded, request.ref, 'response.body')
            }
        } catch {
            request.responseBody = request.responseBody || null
        }

        this.appendCaptureEvent(run, {
            type: 'request_finished',
            at: request.finishedAt,
            payload: {
                ref: request.ref,
                requestId,
                status: request.status,
            },
        })
    }

    private handleLoadingFailed(run: InternalRunState, params: unknown): void {
        const record = asRecord(params)
        const requestId = asString(record.requestId)
        if (!requestId) return
        const request = run.requestsById.get(requestId)
        if (!request) return

        request.finishedAt = Date.now()
        request.failed = true
        request.failureText = asString(record.errorText) || 'Request failed.'
        request.ok = false
    }

    private handleWebSocketCreated(run: InternalRunState, params: unknown): void {
        const record = asRecord(params)
        const requestId = asString(record.requestId)
        const url = asString(record.url)
        if (!requestId || !url) return

        const entry: InternalRequestRecord = {
            ref: buildApiRef('request', run.nextRequestId++),
            requestId,
            startedAt: Date.now(),
            finishedAt: null,
            method: 'GET',
            url,
            urlTemplate: buildUrlTemplate(url),
            resourceType: 'websocket',
            status: null,
            ok: null,
            failed: false,
            failureText: null,
            requestHeaders: {},
            responseHeaders: {},
            requestBody: null,
            responseBody: null,
            responseMime: 'websocket',
            responseSize: null,
            hasUserGesture: false,
            initiatorType: 'websocket',
            initiatorUrl: null,
            initiatorRequestRef: null,
            redirectFromRef: null,
            fromServiceWorker: null,
            graphql: {
                operationName: null,
                persistedQueryHash: null,
            },
            signature: normalizeRequestSignature({
                method: 'GET',
                url,
                resourceType: 'websocket',
                body: null,
                graphql: {
                    operationName: null,
                    persistedQueryHash: null,
                },
            }),
            spanRef: run.activeManualSpanRef,
            matchedDownloadRef: null,
            matchedNavigation: false,
        }

        run.requestsById.set(requestId, entry)
        run.requestOrder.push(entry.ref)
    }

    private handlePlaywrightResponse(response: Response): void {
        const run = this.currentRun
        if (!run) return
        const request = findBestMatchingRequest(run, {
            url: response.url(),
            method: response.request().method(),
        })
        if (!request) return
        request.fromServiceWorker = response.fromServiceWorker()
        request.matchedNavigation =
            request.resourceType === 'document' &&
            response.request().frame() === this.opensteer.page.mainFrame()
    }

    private handleDownload(download: Download): void {
        const run = this.currentRun
        if (!run) return
        const entry: ApiDownloadRecord = {
            ref: buildApiRef('download', run.nextDownloadId++),
            url: download.url(),
            suggestedFilename: download.suggestedFilename() || null,
            createdAt: Date.now(),
        }
        run.downloads.push(entry)
        const matchingRequest = findBestMatchingRequest(run, {
            url: entry.url,
        })
        if (matchingRequest) {
            matchingRequest.matchedDownloadRef = entry.ref
        }
    }

    private async createSpan(
        run: InternalRunState,
        label: string,
        kind: 'automatic' | 'manual',
        command: string | null
    ): Promise<ApiActionSpan> {
        const span: ApiActionSpan = {
            ref: buildApiRef('span', run.nextSpanId++),
            label,
            kind,
            command,
            startedAt: Date.now(),
            endedAt: null,
            before: await this.capturePageSnapshot(),
            after: null,
            requestRefs: [],
            downloadRefs: [],
            effects: [],
        }
        run.spans.push(span)
        return span
    }

    private async finalizeSpan(
        run: InternalRunState,
        span: ApiActionSpan
    ): Promise<void> {
        if (span.endedAt) return
        span.endedAt = Date.now()
        span.after = await this.capturePageSnapshot()
        span.requestRefs = this.collectSpanRequestRefs(run, span)
        span.downloadRefs = run.downloads
            .filter(
                (download) =>
                    download.createdAt >= span.startedAt &&
                    download.createdAt <= span.endedAt!
            )
            .map((download) => download.ref)
        span.effects = detectSpanEffects(span)

        for (const requestRef of span.requestRefs) {
            const request = getRequestByRef(run, requestRef)
            if (request && !request.spanRef) {
                request.spanRef = span.ref
            }
        }
    }

    private async capturePageSnapshot(): Promise<ApiPageSnapshotSummary> {
        const page = this.opensteer.page
        const [title, html, cookies, storage] = await Promise.all([
            page.title().catch(() => ''),
            page.content().catch(() => ''),
            this.opensteer.context.cookies().catch(() => []),
            captureStorage(page).catch(() => ({
                origin: getOrigin(page.url()),
                localStorage: {},
                sessionStorage: {},
            })),
        ])

        return {
            url: page.url(),
            title,
            domHash: hashText(html),
            domLength: html.length,
            cookies: Object.fromEntries(
                cookies.map((cookie) => [cookie.name, cookie.value])
            ),
            storage,
        }
    }

    private getRequestsForSpan(
        run: InternalRunState,
        spanRef: string | null
    ): InternalRequestRecord[] {
        const requests = run.requestOrder
            .map((ref) => getRequestByRef(run, ref))
            .filter((request): request is InternalRequestRecord => Boolean(request))
        if (!spanRef) return requests
        return requests.filter((request) => request.spanRef === spanRef)
    }

    private buildCandidateRow(
        run: InternalRunState,
        request: InternalRequestRecord,
        span: ApiActionSpan | null
    ): ApiCandidateRow {
        const requestSpan = request.spanRef ? this.getSpan(run, request.spanRef) : null
        const reasons: ApiCandidateReason[] = []
        const add = (label: string, score: number): void => {
            reasons.push({ label, score })
        }

        if (request.spanRef && span && request.spanRef === span.ref) add('in_span', 4)
        if (request.hasUserGesture) add('user_gesture', 3)
        if (request.resourceType === 'xhr' || request.resourceType === 'fetch') {
            add('async_api', 4)
        }
        if (request.resourceType === 'document') add('document', 2)
        if (request.matchedDownloadRef) add('download', 6)
        if (request.matchedNavigation) add('navigation', 3)
        if (request.responseMime === 'application/json') add('json', 2)
        if (
            request.responseMime === 'application/pdf' ||
            request.responseMime === 'text/csv' ||
            request.responseMime === 'application/zip'
        ) {
            add('business_output', 4)
        }
        if (request.method === 'OPTIONS') add('preflight', -8)
        if (isRepeatedSignature(run, request.signature)) add('repeated_signature', -3)
        if (request.resourceType === 'websocket') add('websocket_evidence_only', -2)
        if (request.failed) add('failed', -4)

        const redactedRequestBody = request.requestBody?.raw
            ? run.values.redactString(request.requestBody.raw).refs
            : []
        const redactedResponseBody = request.responseBody?.raw
            ? run.values.redactString(request.responseBody.raw).refs
            : []

        return {
            ref: request.ref,
            method: request.method,
            urlTemplate: request.urlTemplate,
            status: request.status,
            resourceType: request.resourceType,
            mime: request.responseMime,
            spanRef: request.spanRef,
            candidateScore: reasons.reduce((sum, reason) => sum + reason.score, 0),
            effects: dedupeStrings([
                request.matchedDownloadRef ? 'download' : '',
                request.matchedNavigation ? 'navigation' : '',
                requestSpan?.effects.includes('dom_change') ? 'dom_change' : '',
            ].filter(Boolean)),
            initiatorRef: request.initiatorRequestRef,
            redactionSummary: {
                requestValues: redactedRequestBody,
                responseValues: redactedResponseBody,
            },
            reasons,
        }
    }

    private chooseTargetRequest(
        run: InternalRunState,
        spanRef: string | null
    ): InternalRequestRecord | null {
        const rows = this.listRequests({
            spanRef,
            kind: 'candidates',
            limit: 1,
        })
        const top = rows[0]
        if (!top) return null
        return this.getRequest(run, top.ref)
    }

    private extractRequestSlots(
        run: InternalRunState,
        request: InternalRequestRecord
    ): RequestSlot[] {
        const slots: RequestSlot[] = []
        const url = new URL(request.url)
        const pathSegments = url.pathname.split('/').filter(Boolean)
        for (let index = 0; index < pathSegments.length; index += 1) {
            const value = pathSegments[index]
            if (!isDynamicSlot(value)) continue
            slots.push({
                name: `path_${index + 1}`,
                slotPath: `path[${index}]`,
                rawValue: value,
                source: 'path',
            })
        }

        for (const [key, value] of url.searchParams.entries()) {
            if (!isDynamicSlot(value, key)) continue
            slots.push({
                name: key,
                slotPath: `query.${key}`,
                rawValue: value,
                source: 'query',
            })
        }

        for (const [key, value] of Object.entries(request.requestHeaders)) {
            if (!/(authorization|cookie|csrf|xsrf|token)/i.test(key)) continue
            if (!value.trim()) continue
            slots.push({
                name: key.toLowerCase().replace(/[^a-z0-9]+/gi, '_'),
                slotPath: `headers.${key}`,
                rawValue: value,
                source: /cookie/i.test(key) ? 'cookie' : 'header',
            })
        }

        if (request.requestBody?.parsedJson) {
            for (const occurrence of collectScalarOccurrences(
                request.requestBody.parsedJson
            )) {
                if (!isDynamicSlot(occurrence.value, occurrence.path)) continue
                slots.push({
                    name: sanitizeName(occurrence.path),
                    slotPath: `body.${occurrence.path}`,
                    rawValue: occurrence.value,
                    source: 'body',
                })
            }
        }

        return dedupeSlots(slots)
    }

    private traceValueInternal(
        run: InternalRunState,
        rawValue: string,
        options?: {
            beforeRequestRef?: string | null
            limitToSpanRef?: string | null
        }
    ): TraceSearchResult[] {
        const candidates: TraceSearchResult[] = []
        const searchValues = buildSearchVariants(rawValue)
        const beforeStartedAt =
            options?.beforeRequestRef
                ? this.getRequest(run, options.beforeRequestRef).startedAt
                : null

        for (const request of this.getRequestsForSpan(run, options?.limitToSpanRef || null)) {
            if (beforeStartedAt !== null && request.startedAt >= beforeStartedAt) {
                continue
            }

            for (const variant of searchValues) {
                const match = findRequestValueMatch(request, variant.value)
                if (!match) continue
                candidates.push({
                    producerRef: request.ref,
                    location: match.location,
                    matchType: variant.matchType,
                    transformChain: variant.transforms,
                    confidence: scoreTraceCandidate(variant.matchType, request),
                    whyNotOthers: buildTraceRationale(variant.matchType, request),
                })
            }
        }

        return dedupeTraceResults(candidates).sort(
            (left, right) => right.confidence - left.confidence
        )
    }

    private captureValueOccurrences(
        run: InternalRunState,
        record: Record<string, string>,
        options: {
            requestRef: string
            source:
                | 'request.header'
                | 'response.header'
        }
    ): void {
        for (const [key, value] of Object.entries(record)) {
            run.values.register(value, {
                requestRef: options.requestRef,
                source: options.source,
                path: key,
            }, {
                key,
                requestRef: options.requestRef,
            })
        }
    }

    private captureBodyValues(
        run: InternalRunState,
        body: string,
        requestRef: string,
        source: 'request.body' | 'response.body'
    ): void {
        const parsed = safeJsonParse(body)
        if (parsed) {
            for (const occurrence of collectScalarOccurrences(parsed)) {
                run.values.register(occurrence.value, {
                    requestRef,
                    source,
                    path: occurrence.path,
                }, {
                    key: occurrence.path,
                    requestRef,
                })
            }
            return
        }

        for (const token of collectOpaqueStringTokens(body)) {
            run.values.register(token, {
                requestRef,
                source,
            }, {
                requestRef,
            })
        }
    }

    private collectSpanRequestRefs(
        run: InternalRunState,
        span: ApiActionSpan
    ): string[] {
        return run.requestOrder.filter((ref) => {
            const request = getRequestByRef(run, ref)
            if (!request) return false
            if (request.startedAt < span.startedAt) return false
            if (span.endedAt && request.startedAt > span.endedAt + 2_000) return false
            return true
        })
    }

    private getSpan(run: InternalRunState, ref: string): ApiActionSpan {
        const span = run.spans.find((candidate) => candidate.ref === ref)
        if (!span) {
            throw new Error(`Unknown API span ref "${ref}".`)
        }
        return span
    }

    private getRequest(run: InternalRunState, ref: string): InternalRequestRecord {
        const request = getRequestByRef(run, ref)
        if (!request) {
            throw new Error(`Unknown API request ref "${ref}".`)
        }
        return request
    }

    private requireRun(activeOnly = false): InternalRunState {
        if (!this.currentRun) {
            throw new Error('No API capture run exists for this session yet.')
        }
        if (activeOnly && !this.currentRun.active) {
            throw new Error('API capture is not active for this session.')
        }
        return this.currentRun
    }

    private async flushArtifacts(run: InternalRunState): Promise<void> {
        await Promise.all([
            writeFile(
                path.join(run.dir, 'request-index.json'),
                JSON.stringify(
                    redactRecordStrings(
                        run.requestOrder
                            .map((ref) => getRequestByRef(run, ref))
                            .filter(
                                (request): request is InternalRequestRecord => Boolean(request)
                            ),
                        run.values
                    ),
                    null,
                    2
                ),
                'utf8'
            ),
            writeFile(
                path.join(run.dir, 'action-spans.json'),
                JSON.stringify(redactRecordStrings(run.spans, run.values), null, 2),
                'utf8'
            ),
            writeFile(
                path.join(run.dir, 'value-index.json'),
                JSON.stringify(redactRecordStrings(run.values.list(), run.values), null, 2),
                'utf8'
            ),
            writeFile(
                path.join(run.dir, 'candidates.json'),
                JSON.stringify(this.listRequests({ kind: 'candidates', limit: 50 }), null, 2),
                'utf8'
            ),
            writeFile(
                path.join(run.dir, 'provenance-graph.json'),
                JSON.stringify(
                    {
                        nodes: run.requestOrder,
                        plans: run.plans,
                        validations: run.validations,
                    },
                    null,
                    2
                ),
                'utf8'
            ),
            this.writeManifest(run),
        ])
    }

    private async writeManifest(run: InternalRunState): Promise<void> {
        await writeFile(
            path.join(run.dir, 'manifest.json'),
            JSON.stringify(
                {
                    ref: run.ref,
                    id: run.id,
                    logicalSession: this.logicalSession,
                    active: run.active,
                    startedAt: run.startedAt,
                    requestCount: run.requestOrder.length,
                    spanCount: run.spans.length,
                    planCount: run.plans.length,
                    validationCount: run.validations.length,
                },
                null,
                2
            ),
            'utf8'
        )
    }

    private async writePlanArtifact(
        run: InternalRunState,
        plan: ApiPlanIr
    ): Promise<void> {
        await writeFile(
            path.join(run.dir, 'plans', `${plan.ref.slice(1)}.json`),
            JSON.stringify(redactRecordStrings(plan, run.values), null, 2),
            'utf8'
        )
    }

    private async writeValidationArtifact(
        run: InternalRunState,
        report: ApiValidationReport
    ): Promise<void> {
        await writeFile(
            path.join(run.dir, 'validations', `${report.ref.slice(1)}.json`),
            JSON.stringify(redactRecordStrings(report, run.values), null, 2),
            'utf8'
        )
    }

    private appendCaptureEvent(
        run: InternalRunState,
        event: Record<string, unknown>
    ): void {
        run.captureStream.write(JSON.stringify(event) + '\n')
    }
}

function buildRunId(sequence: number, at: number): string {
    const iso = new Date(at).toISOString().replace(/[-:.]/g, '')
    return `${iso}-${sequence}`
}

function buildAutomaticSpanLabel(
    command: string,
    args: Record<string, unknown>
): string {
    const detail = [
        typeof args.description === 'string' ? args.description : null,
        typeof args.url === 'string' ? args.url : null,
        typeof args.text === 'string' ? String(args.text).slice(0, 32) : null,
    ].find(Boolean)
    return detail ? `${command}:${detail}` : command
}

function resolveRedirectRef(
    run: InternalRunState,
    redirectResponse: Record<string, unknown>,
    nextUrl: string
): string | null {
    const redirectUrl = asString(redirectResponse.url)
    if (!redirectUrl) return null
    const match = [...run.requestsById.values()]
        .filter((request) => request.url === redirectUrl && request.url !== nextUrl)
        .sort((left, right) => right.startedAt - left.startedAt)[0]
    return match?.ref || null
}

function resolveInitiatorUrl(initiator: Record<string, unknown>): string | null {
    const stack = asRecord(initiator.stack)
    const callFrames = Array.isArray(stack.callFrames)
        ? stack.callFrames
        : []
    for (const frame of callFrames) {
        const url = asString(asRecord(frame).url)
        if (url) return url
    }
    return asString(initiator.url) || null
}

function buildBodyRecord(
    raw: string | null,
    contentType: string | null | undefined,
    explicitSize?: number,
    base64Encoded?: boolean
): ApiRequestBodyRecord | ApiResponseBodyRecord | null {
    if (raw == null) return null
    const size = explicitSize ?? Buffer.byteLength(raw, 'utf8')
    const truncated = size > MAX_CAPTURED_BODY_BYTES
    const rawValue = truncated
        ? raw.slice(0, MAX_CAPTURED_BODY_BYTES)
        : raw
    const parsedJson = safeJsonParse(rawValue)
    return {
        raw: rawValue,
        truncated,
        size,
        contentType: summarizeMime(contentType || null),
        ...(parsedJson ? { parsedJson } : {}),
        ...(typeof base64Encoded === 'boolean'
            ? { base64Encoded }
            : {}),
    }
}

function summarizeBodyRecord(
    record: ApiRequestBodyRecord | ApiResponseBodyRecord | null
): Record<string, unknown> | null {
    if (!record) return null
    const preview =
        typeof record.raw === 'string'
            ? `${record.raw.slice(0, 200)}${record.raw.length > 200 ? '…' : ''}`
            : null
    return {
        size: record.size,
        truncated: record.truncated,
        contentType: record.contentType,
        preview,
        hasParsedJson: Boolean(record.parsedJson),
    }
}

function decodeResponseBody(rawBody: string, base64Encoded: boolean): string {
    if (!base64Encoded) return rawBody
    return Buffer.from(rawBody, 'base64').toString('utf8')
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string> {
    const output: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
        if (typeof value === 'string') {
            output[key.toLowerCase()] = value
        }
    }
    return output
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {}
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : null
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function captureStorage(page: Page): Promise<ApiStorageSnapshot> {
    return await page.evaluate(() => {
        const readStorage = (storage: Storage): Record<string, string> => {
            const output: Record<string, string> = {}
            for (let index = 0; index < storage.length; index += 1) {
                const key = storage.key(index)
                if (!key) continue
                const value = storage.getItem(key)
                if (value == null) continue
                output[key] = value
            }
            return output
        }

        return {
            origin: window.location.origin,
            localStorage: readStorage(window.localStorage),
            sessionStorage: readStorage(window.sessionStorage),
        }
    })
}

function getRequestByRef(
    run: InternalRunState,
    ref: string
): InternalRequestRecord | null {
    for (const request of run.requestsById.values()) {
        if (request.ref === ref) return request
    }
    return null
}

function compareRequestRefs(left: string, right: string): number {
    return right.localeCompare(left, undefined, { numeric: true })
}

function dedupeStrings(values: string[]): string[] {
    return [...new Set(values)]
}

function detectSpanEffects(span: ApiActionSpan): string[] {
    const effects: string[] = []
    if (span.before && span.after) {
        if (span.before.url !== span.after.url) effects.push('navigation')
        if (span.before.domHash !== span.after.domHash) effects.push('dom_change')
        if (
            hashText(JSON.stringify(span.before.cookies)) !==
            hashText(JSON.stringify(span.after.cookies))
        ) {
            effects.push('cookie_change')
        }
        if (
            hashText(JSON.stringify(span.before.storage)) !==
            hashText(JSON.stringify(span.after.storage))
        ) {
            effects.push('storage_change')
        }
    }
    if (span.downloadRefs.length) effects.push('download')
    return effects
}

function isRepeatedSignature(run: InternalRunState, signature: string): boolean {
    let count = 0
    for (const request of run.requestsById.values()) {
        if (request.signature !== signature) continue
        count += 1
        if (count > 1) return true
    }
    return false
}

function isDynamicSlot(value: string, key?: string): boolean {
    const normalized = normalizePrimitive(value)
    if (normalized !== '<string>') return true
    if (key && /(id|token|csrf|session|auth|hash|key)/i.test(key)) return true
    return value.length >= 24
}

function collectScalarOccurrences(
    value: unknown,
    pathPrefix = ''
): Array<{ path: string; value: string }> {
    const output: Array<{ path: string; value: string }> = []
    if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            output.push(
                ...collectScalarOccurrences(entry, `${pathPrefix}[${index}]`)
            )
        })
        return output
    }
    if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key
            output.push(...collectScalarOccurrences(child, nextPath))
        }
        return output
    }
    if (value == null) return output
    output.push({
        path: pathPrefix || '$',
        value: String(value),
    })
    return output
}

function collectOpaqueStringTokens(body: string): string[] {
    const matches = body.match(/[A-Za-z0-9+/_=-]{24,}/g)
    return matches ? dedupeStrings(matches) : []
}

function findBestMatchingRequest(
    run: InternalRunState,
    matcher: {
        url?: string
        method?: string
    }
): InternalRequestRecord | null {
    const candidates = [...run.requestsById.values()].filter((request) => {
        if (matcher.url && request.url !== matcher.url) return false
        if (matcher.method && request.method !== matcher.method) return false
        return true
    })
    if (!candidates.length) return null
    return candidates.sort((left, right) => right.startedAt - left.startedAt)[0] ?? null
}

function findRequestValueMatch(
    request: InternalRequestRecord,
    candidateValue: string
): {
    location: string
} | null {
    const url = request.url
    if (url.includes(candidateValue)) {
        return { location: 'request.url' }
    }

    for (const [key, value] of Object.entries(request.requestHeaders)) {
        if (value.includes(candidateValue)) {
            return { location: `request.header:${key}` }
        }
    }
    if (request.requestBody?.raw?.includes(candidateValue)) {
        return { location: 'request.body' }
    }
    if (request.responseBody?.raw?.includes(candidateValue)) {
        const parsed = request.responseBody.parsedJson
        if (parsed) {
            const exact = collectScalarOccurrences(parsed).find(
                (occurrence) => occurrence.value === candidateValue
            )
            if (exact) {
                return { location: `response.body:${exact.path}` }
            }
        }
        return { location: 'response.body' }
    }
    return null
}

function buildSearchVariants(
    rawValue: string
): Array<{
    value: string
    matchType: ApiRequestMatchType
    transforms: string[]
}> {
    const variants = new Map<string, {
        value: string
        matchType: ApiRequestMatchType
        transforms: string[]
    }>()
    const add = (
        value: string,
        matchType: ApiRequestMatchType,
        transforms: string[]
    ): void => {
        if (!value || variants.has(value)) return
        variants.set(value, { value, matchType, transforms })
    }

    add(rawValue, 'exact', [])

    try {
        const decoded = decodeURIComponent(rawValue)
        if (decoded !== rawValue) {
            add(decoded, 'url_decoded', ['decodeURIComponent'])
        }
    } catch {
    }

    try {
        const base64Decoded = Buffer.from(rawValue, 'base64').toString('utf8')
        if (base64Decoded && base64Decoded !== rawValue) {
            add(base64Decoded, 'base64_decoded', ['base64.decode'])
        }
    } catch {
    }

    const base64Encoded = Buffer.from(rawValue, 'utf8').toString('base64')
    add(base64Encoded, 'base64_encoded', ['base64.encode'])

    return [...variants.values()]
}

function scoreTraceCandidate(
    matchType: ApiRequestMatchType,
    request: InternalRequestRecord
): number {
    let score = request.startedAt / 1_000_000_000
    switch (matchType) {
        case 'exact':
            score += 1
            break
        case 'url_decoded':
        case 'base64_decoded':
            score += 0.8
            break
        default:
            score += 0.5
            break
    }
    if (request.responseBody?.parsedJson) score += 0.4
    if (request.responseMime === 'application/json') score += 0.2
    return score
}

function buildTraceRationale(
    matchType: ApiRequestMatchType,
    request: InternalRequestRecord
): string {
    const source =
        request.responseBody?.parsedJson
            ? 'structured response'
            : 'captured request/response text'
    return `${matchType} match in ${source} from ${request.ref}.`
}

function dedupeTraceResults(results: TraceSearchResult[]): TraceSearchResult[] {
    const seen = new Set<string>()
    const output: TraceSearchResult[] = []
    for (const result of results) {
        const key = `${result.producerRef}:${result.location}:${result.matchType}`
        if (seen.has(key)) continue
        seen.add(key)
        output.push(result)
    }
    return output
}

function sanitizeName(value: string): string {
    const cleaned = value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    return cleaned || 'value'
}

function dedupeSlots(slots: RequestSlot[]): RequestSlot[] {
    const seen = new Set<string>()
    const output: RequestSlot[] = []
    for (const slot of slots) {
        const key = `${slot.slotPath}:${slot.rawValue}`
        if (seen.has(key)) continue
        seen.add(key)
        output.push(slot)
    }
    return output
}

function dedupePlanInputs(inputs: ApiPlanInput[]): ApiPlanInput[] {
    const seen = new Set<string>()
    const output: ApiPlanInput[] = []
    for (const input of inputs) {
        const key = `${input.slotPath}:${input.producerRef || ''}:${input.sourceLocation || ''}`
        if (seen.has(key)) continue
        seen.add(key)
        output.push(input)
    }
    return output
}

function slugifyOperationName(task: string): string {
    return task
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'operation'
}

function clampConfidence(
    target: InternalRequestRecord,
    unresolvedCount: number
): number {
    const base = target.matchedDownloadRef || target.responseMime === 'application/json'
        ? 0.85
        : 0.7
    return Math.max(0.2, Math.min(0.99, base - unresolvedCount * 0.1))
}

function resolveFallbackMode(
    target: InternalRequestRecord,
    unresolvedCount: number
): ApiPlanFallbackMode {
    if (unresolvedCount > 0) return 'browser_fallback_required'
    if (
        target.resourceType === 'websocket' ||
        target.responseMime === 'text/event-stream'
    ) {
        return 'browser_assisted'
    }
    return 'http_only'
}

function isHttpExecutableRequest(request: InternalRequestRecord): boolean {
    if (request.resourceType === 'websocket') return false
    try {
        const protocol = new URL(request.url).protocol
        return protocol === 'http:' || protocol === 'https:'
    } catch {
        return false
    }
}

function resolveInputSource(
    location: string
): ApiPlanInput['source'] {
    if (location.startsWith('response.body')) return 'response'
    if (location.startsWith('request.header:cookie')) return 'cookie'
    if (location.startsWith('request.header')) return 'request'
    return 'response'
}

async function executeCapturedHttpRequest(
    request: InternalRequestRecord
): Promise<{
    ok: boolean
    status: number | null
    mime: string | null
    error: string | null
}> {
    try {
        const headers = sanitizeExecutionHeaders(request.requestHeaders)
        const response = await fetch(request.url, {
            method: request.method,
            headers,
            body:
                request.method === 'GET' || request.method === 'HEAD'
                    ? undefined
                    : request.requestBody?.raw || undefined,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        return {
            ok: response.ok,
            status: response.status,
            mime: summarizeMime(response.headers.get('content-type')),
            error: null,
        }
    } catch (error) {
        return {
            ok: false,
            status: null,
            mime: null,
            error: error instanceof Error ? error.message : 'HTTP execution failed.',
        }
    }
}

function sanitizeExecutionHeaders(headers: Record<string, string>): Headers {
    const out = new Headers()
    for (const [key, value] of Object.entries(headers)) {
        if (HTTP_EXECUTION_HEADER_BLOCKLIST.has(key.toLowerCase())) continue
        out.set(key, value)
    }
    return out
}

function renderTypeScriptClient(
    run: InternalRunState,
    plan: ApiPlanIr
): string {
    if (planRequiresBrowserAssistance(plan)) {
        return `export async function ${plan.operation}() {
  throw new Error(${JSON.stringify(buildBrowserAssistanceMessage(plan))});
}
`
    }

    const steps = plan.steps.map((step, index) => {
        const request = getRequestByRef(run, step.requestRef)
        if (!request) return ''
        return `
  const res${index + 1} = await fetch(${JSON.stringify(request.url)}, {
    method: ${JSON.stringify(request.method)},
    headers: ${JSON.stringify(sanitizeExecutionHeaderObject(request.requestHeaders), null, 4)},
    ${request.method === 'GET' || request.method === 'HEAD' ? '' : `body: ${JSON.stringify(request.requestBody?.raw || '')},`}
  });
  const body${index + 1} = await readResponse(res${index + 1});
`
    }).join('\n')

    return `export async function ${plan.operation}() {
${steps}
}

async function readResponse(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await response.json();
  }
  return await response.text();
}
`
}

function renderPythonClient(
    run: InternalRunState,
    plan: ApiPlanIr
): string {
    if (planRequiresBrowserAssistance(plan)) {
        return `def ${plan.operation}():
    raise RuntimeError(${JSON.stringify(buildBrowserAssistanceMessage(plan))})
`
    }

    const steps = plan.steps.map((step, index) => {
        const request = getRequestByRef(run, step.requestRef)
        if (!request) return ''
        return `    res_${index + 1} = session.request(
        ${JSON.stringify(request.method)},
        ${JSON.stringify(request.url)},
        headers=${JSON.stringify(sanitizeExecutionHeaderObject(request.requestHeaders), null, 8)},
        ${request.method === 'GET' || request.method === 'HEAD' ? '' : `data=${JSON.stringify(request.requestBody?.raw || '')},`}
    )
`
    }).join('\n')

    return `import requests

def ${plan.operation}():
    session = requests.Session()
${steps}
`
}

function renderOpenApi(run: InternalRunState, plan: ApiPlanIr): Record<string, unknown> {
    const target = getRequestByRef(run, plan.targetRequestRef)
    if (!target) {
        return {}
    }
    const parsed = new URL(target.url)
    return {
        openapi: '3.1.0',
        info: {
            title: plan.operation,
            version: '1.0.0',
        },
        paths: {
            [parsed.pathname]: {
                [target.method.toLowerCase()]: {
                    operationId: plan.operation,
                    parameters: [...parsed.searchParams.keys()].map((key) => ({
                        name: key,
                        in: 'query',
                        required: false,
                        schema: { type: 'string' },
                    })),
                    responses: {
                        default: {
                            description: 'Captured response',
                        },
                    },
                    'x-opensteer-plan-ref': plan.ref,
                },
            },
        },
    }
}

function renderCurlScript(run: InternalRunState, plan: ApiPlanIr): string {
    if (planRequiresBrowserAssistance(plan)) {
        return `# ${buildBrowserAssistanceMessage(plan)}`
    }

    return plan.steps.map((step) => {
        const request = getRequestByRef(run, step.requestRef)
        if (!request) return ''
        const headerFlags = Object.entries(sanitizeExecutionHeaderObject(request.requestHeaders))
            .map(([key, value]) => `  -H ${JSON.stringify(`${key}: ${value}`)}`)
            .join(' \\\n')
        const bodyFlag =
            request.method === 'GET' || request.method === 'HEAD'
                ? ''
                : ` \\\n  --data-raw ${JSON.stringify(request.requestBody?.raw || '')}`
        return `curl -X ${request.method} ${JSON.stringify(request.url)} \\
${headerFlags}${bodyFlag}`
    }).join('\n\n')
}

function sanitizeExecutionHeaderObject(
    headers: Record<string, string>
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).filter(
            ([key]) => !HTTP_EXECUTION_HEADER_BLOCKLIST.has(key)
        )
    )
}

function planRequiresBrowserAssistance(plan: ApiPlanIr): boolean {
    return (
        plan.fallbackMode !== 'http_only' ||
        plan.steps.some((step) => !step.httpExecutable)
    )
}

function buildBrowserAssistanceMessage(plan: ApiPlanIr): string {
    const unresolved =
        plan.unresolvedSlots.length > 0
            ? ` Unresolved slots: ${plan.unresolvedSlots.join(', ')}.`
            : ''
    return `Plan ${plan.ref} requires browser assistance before direct HTTP execution can complete. Fallback mode: ${plan.fallbackMode}.${unresolved}`
}
