import {
    createWriteStream,
    existsSync,
    readdirSync,
    readFileSync,
    type WriteStream,
} from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import path from 'path'
import type { APIResponse, CDPSession, Download, Page, Response } from 'playwright'
import { parseDataPath } from '../extraction/data-path.js'
import type { Opensteer } from '../opensteer.js'
import { parseCapturedBody } from './body-parser.js'
import {
    getExecutionBindingResolver,
    getExecutionBindingResolverCandidates,
    getResolverCapability,
    normalizeDeterministicPlan,
} from './compiler.js'
import { PlanExecutor } from './executor.js'
import { PlanLifecycleService } from './lifecycle.js'
import { ApiValueRegistry, redactRecordStrings } from './redact.js'
import { PlanRegistry } from './registry.js'
import { buildUrlTemplate, getOrigin, hashText, inferGraphqlMetadata, inferValueShape, normalizePrimitive, normalizeRequestSignature, safeJsonParse, summarizeMime } from './normalize.js'
import { buildApiRef, isApiRefKind } from './refs.js'
import { PlanRuntimeManager } from './runtime.js'
import { normalizeBindingTransforms } from './transforms.js'
import type {
    ApiActionFact,
    ApiActionSpan,
    ApiActionTargetFact,
    ApiBindingResolver,
    ApiCandidateReason,
    ApiCandidateRow,
    ApiCodegenLanguage,
    ApiDomFieldFact,
    ApiDomSnapshotFact,
    ApiDownloadRecord,
    ApiExecutionBinding,
    ApiEvidenceKind,
    ApiGraphqlMetadata,
    ApiInlineValueFact,
    ApiPageSnapshotSummary,
    ApiPlanAttemptMeta,
    ApiPlanExecutionReport,
    ApiPlanExecutionMode,
    ApiPlanInput,
    ApiPlanIr,
    ApiPlanRuntimeMode,
    ApiPlanSummary,
    ApiPlanStep,
    ApiPlanSuccessOracle,
    ApiPlanValidationMode,
    ApiProbeRun,
    ApiProbeSlotComparison,
    ApiProbeVariantResult,
    ApiRenderFormat,
    ApiRequestBodyRecord,
    ApiRequestMatchType,
    ApiRequestRecord,
    ApiRequestSlot,
    ApiResponseBodyRecord,
    ApiRuntimeStatus,
    ApiSlotEvidence,
    ApiSlotRole,
    ApiSlotSource,
    ApiStorageEvent,
    ApiStorageSnapshot,
    ApiValidationReport,
    ApiValidationStepResult,
    ApiValueRecord,
    ApiValueTraceCandidate,
} from './types.js'

const MAX_CAPTURED_BODY_BYTES = 256_000
const MAX_DOM_FIELDS = 200
const MAX_INLINE_VALUES = 200
const MAX_TRACE_CANDIDATES = 50
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
const TRACEABLE_HEADER_PATTERN =
    /^(authorization|cookie|x-[a-z0-9-]+|csrf|xsrf|origin|referer|content-type|accept)$/i
const LOW_INFORMATION_HEADER_NAMES = new Set([
    'accept',
    'accept-encoding',
    'accept-language',
    'connection',
    'content-length',
    'content-type',
    'host',
    'origin',
    'referer',
    'user-agent',
])
const SESSION_KEY_PATTERN = /(auth|token|csrf|xsrf|session|cookie|bearer)/i
const SEMANTIC_NOISE_TOKENS = new Set([
    'input',
    'field',
    'button',
    'text',
    'value',
    'submit',
    'request',
    'response',
    'query',
    'header',
    'headers',
    'body',
    'path',
    'cookie',
    'cookies',
    'dom',
    'action',
    'target',
    'args',
    'local',
    'session',
    'storage',
    'inline',
    'html',
])

interface ApiReverseControllerOptions {
    scopeDir: string
    logicalSession: string
}

type InternalRequestRecord = ApiRequestRecord

interface InternalRunState {
    ref: string
    id: string
    dir: string
    startedAt: number
    active: boolean
    session: CDPSession | null
    captureStream: WriteStream | null
    requestsById: Map<string, InternalRequestRecord>
    requestsByRef: Map<string, InternalRequestRecord>
    requestOrder: string[]
    spans: ApiActionSpan[]
    actionFacts: ApiActionFact[]
    storageEvents: ApiStorageEvent[]
    downloads: ApiDownloadRecord[]
    values: ApiValueRegistry
    plans: ApiPlanIr[]
    probes: ApiProbeRun[]
    validations: ApiValidationReport[]
    nextRequestId: number
    nextSpanId: number
    nextActionId: number
    nextStorageEventId: number
    nextDownloadId: number
    nextPlanId: number
    nextProbeId: number
    nextValidationId: number
    activeManualSpanRef: string | null
}

interface PersistedRunState {
    ref: string
    id: string
    startedAt: number
    active: boolean
    requests: InternalRequestRecord[]
    requestOrder: string[]
    spans: ApiActionSpan[]
    actionFacts: ApiActionFact[]
    storageEvents: ApiStorageEvent[]
    downloads: ApiDownloadRecord[]
    values: ApiValueRecord[]
    plans: ApiPlanIr[]
    probes: ApiProbeRun[]
    validations: ApiValidationReport[]
    nextRequestId: number
    nextSpanId: number
    nextActionId: number
    nextStorageEventId: number
    nextDownloadId: number
    nextPlanId: number
    nextProbeId: number
    nextValidationId: number
    activeManualSpanRef: string | null
}

interface AutomaticSpanToken {
    spanRef: string
    actionRef: string
}

interface SlotSeed {
    ref: string
    requestRef: string
    name: string
    slotPath: string
    source: ApiSlotSource
    rawValue: string
    shape: string
    required: boolean
}

interface EvidenceSeed {
    role: ApiSlotRole
    kind: ApiEvidenceKind
    score: number
    sourceRef: string | null
    sourceLabel: string
    sourceLocation: string | null
    observedValue: string
    transformChain: string[]
    rationale: string
}

interface BindingSeedBase {
    transforms?: string[]
    resolverCandidates?: ApiBindingResolver[]
}

type BindingSeed =
    | (BindingSeedBase & {
          kind: 'caller'
      })
    | (BindingSeedBase & {
          kind: 'constant'
          value: string
      })
    | (BindingSeedBase & {
          kind: 'derived_response'
          producerRef: string
          responsePath: string
      })
    | (BindingSeedBase & {
          kind: 'derived_response_header'
          producerRef: string
          headerName: string
      })
    | (BindingSeedBase & {
          kind: 'ambient_cookie'
          cookieName: string
      })
    | (BindingSeedBase & {
          kind: 'session_cookie'
          cookieName: string
      })
    | (BindingSeedBase & {
          kind: 'session_storage'
          storageType: 'local' | 'session'
          key: string
      })
    | (BindingSeedBase & {
          kind: 'dom_field'
          fieldName: string | null
          fieldId: string | null
          fieldType: string | null
          hidden: boolean
      })
    | (BindingSeedBase & {
          kind: 'inline_json'
          source: string
          dataPath: string
      })
    | (BindingSeedBase & {
          kind: 'unknown'
          reason: string
      })

interface SlotAnalysis {
    seed: SlotSeed
    role: ApiSlotRole
    confidence: number
    evidence: EvidenceSeed[]
    binding: BindingSeed
}

interface RunAnalysis {
    slotsByRef: Map<string, ApiRequestSlot>
    slotsByRequestRef: Map<string, ApiRequestSlot[]>
    slotSeedsByRef: Map<string, SlotSeed>
    slotSeedByRequestAndPath: Map<string, SlotSeed>
    evidenceBySlotRef: Map<string, ApiSlotEvidence[]>
    evidenceByRef: Map<string, ApiSlotEvidence>
    bindingBySlotRef: Map<string, BindingSeed>
}

interface CandidateSelectionProfile {
    requestRef: string
    userInputSlotCount: number
    nonCallerSlotCount: number
    totalSlotCount: number
    executionModeCost: number
    asyncPreference: number
    strongInputSources: Set<string>
}

interface StructuredOccurrence {
    requestRef: string
    source:
        | 'request.path'
        | 'request.query'
        | 'request.body'
        | 'request.header'
        | 'response.body'
        | 'response.header'
    location: string
    slotPath: string | null
    value: string
    key: string | null
}

interface OccurrenceValueStats {
    occurrenceCount: number
    requestCount: number
}

interface ExecutedStepState {
    status: number | null
    mime: string | null
    text: string | null
    json: unknown
    url: string | null
    headers: Record<string, string>
}

export class ApiReverseController {
    private opensteer: Opensteer | null
    private readonly scopeDir: string
    private readonly logicalSession: string
    private readonly registry: PlanRegistry
    private readonly executor: PlanExecutor
    private readonly runtimeManager: PlanRuntimeManager
    private readonly lifecycle: PlanLifecycleService
    private runSequence = 0
    private currentRun: InternalRunState | null = null
    private readonly responseListener = (response: Response) => {
        this.handlePlaywrightResponse(response)
    }
    private readonly downloadListener = (download: Download) => {
        this.handleDownload(download)
    }

    constructor(opensteer: Opensteer | null, options: ApiReverseControllerOptions) {
        this.opensteer = opensteer
        this.scopeDir = options.scopeDir
        this.logicalSession = options.logicalSession
        this.registry = new PlanRegistry({ rootDir: this.scopeDir })
        this.executor = new PlanExecutor({ opensteer })
        this.runtimeManager = new PlanRuntimeManager({ opensteer })
        this.lifecycle = new PlanLifecycleService({
            executor: this.executor,
            runtimeManager: this.runtimeManager,
        })
    }

    setOpensteer(opensteer: Opensteer | null): void {
        this.opensteer = opensteer
        this.executor.setOpensteer(opensteer)
        this.runtimeManager.setOpensteer(opensteer)
    }

    private requireOpensteer(): Opensteer {
        if (!this.opensteer) {
            throw new Error(
                `No browser session in logical session '${this.logicalSession}' (scope '${this.scopeDir}'). Open a browser session before running this command.`
            )
        }
        return this.opensteer
    }

    private ensureLoadedRun(): InternalRunState | null {
        if (this.currentRun) return this.currentRun
        const loaded = loadLatestPersistedRun(this.scopeDir, this.logicalSession)
        if (!loaded) return null
        this.currentRun = loaded
        this.runSequence = Math.max(this.runSequence, extractNumericApiRef(loaded.ref))
        return loaded
    }

    isMutatingCommand(command: string): boolean {
        return MUTATING_COMMANDS.has(command)
    }

    async startCapture(): Promise<ApiRuntimeStatus> {
        if (this.currentRun?.active) {
            throw new Error('API capture is already active for this session.')
        }
        const opensteer = this.requireOpensteer()

        let session: CDPSession
        try {
            session = await opensteer.page.context().newCDPSession(opensteer.page)
        } catch (error) {
            throw new Error(
                'API capture requires Chromium CDP support for the current page.',
                { cause: error }
            )
        }

        this.runSequence += 1
        const startedAt = Date.now()
        const ref = buildApiRef('run', this.runSequence)
        const id = buildRunId(this.logicalSession, this.runSequence, startedAt)
        const dir = path.join(this.scopeDir, '.opensteer', 'api', 'evidence', 'runs', id)
        await mkdir(path.join(dir, 'plans'), { recursive: true })
        await mkdir(path.join(dir, 'validations'), { recursive: true })
        await mkdir(path.join(dir, 'codegen'), { recursive: true })

        const run: InternalRunState = {
            ref,
            id,
            dir,
            startedAt,
            active: true,
            session,
            captureStream: createWriteStream(path.join(dir, 'capture.ndjson'), {
                flags: 'a',
            }),
            requestsById: new Map(),
            requestsByRef: new Map(),
            requestOrder: [],
            spans: [],
            actionFacts: [],
            storageEvents: [],
            downloads: [],
            values: new ApiValueRegistry(),
            plans: [],
            probes: [],
            validations: [],
            nextRequestId: 1,
            nextSpanId: 1,
            nextActionId: 1,
            nextStorageEventId: 1,
            nextDownloadId: 1,
            nextPlanId: 1,
            nextProbeId: 1,
            nextValidationId: 1,
            activeManualSpanRef: null,
        }

        this.currentRun = run
        this.attachSessionListeners(run)
        this.attachPageListeners()

        await session.send('Network.enable')
        await session.send('DOMStorage.enable').catch(() => undefined)
        await session
            .send('Network.setAttachDebugStack' as never, { enabled: true } as never)
            .catch(() => undefined)
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
        await run.session?.detach().catch(() => undefined)
        await this.flushArtifacts(run)
        run.captureStream?.end()
        return this.getStatus()
    }

    async shutdown(): Promise<void> {
        const run = this.currentRun
        if (!run) return
        if (run.active) {
            await this.stopCapture().catch(() => undefined)
        }
        this.currentRun = null
        await this.runtimeManager.shutdown().catch(() => undefined)
    }

    getStatus(): ApiRuntimeStatus {
        const run = this.currentRun || this.ensureLoadedRun()
        return {
            active: Boolean(run?.active),
            runRef: run?.ref || null,
            runDir: run?.dir || null,
            requestCount: run?.requestOrder.length || 0,
            spanCount: run?.spans.length || 0,
            actionFactCount: run?.actionFacts.length || 0,
            planCount: run?.plans.length || 0,
            validationCount: run?.validations.length || 0,
            probeCount: run?.probes.length || 0,
            activeManualSpanRef: run?.activeManualSpanRef || null,
        }
    }

    listSpans(): ApiActionSpan[] {
        const run = this.requireRun()
        return redactRecordStrings(run.spans, run.values)
    }

    async startManualSpan(label: string): Promise<ApiActionSpan> {
        const run = this.requireRun(true)
        if (run.activeManualSpanRef) {
            throw new Error('A manual span is already active.')
        }
        const span = await this.createSpan(run, label, 'manual', null)
        run.activeManualSpanRef = span.ref
        await this.flushArtifacts(run)
        return redactRecordStrings(span, run.values)
    }

    async stopManualSpan(): Promise<ApiActionSpan> {
        const run = this.requireRun(true)
        if (!run.activeManualSpanRef) {
            throw new Error('No manual span is currently active.')
        }
        const span = this.getSpan(run, run.activeManualSpanRef)
        await this.finalizeSpan(run, span)
        run.activeManualSpanRef = null
        await this.flushArtifacts(run)
        return redactRecordStrings(span, run.values)
    }

    async beginAutomaticSpan(
        command: string,
        args: Record<string, unknown>
    ): Promise<AutomaticSpanToken | null> {
        const run = this.currentRun
        if (!run?.active || run.activeManualSpanRef) return null

        const span = await this.createSpan(
            run,
            buildAutomaticSpanLabel(command, args),
            'automatic',
            command
        )
        const actionFact: ApiActionFact = {
            ref: buildApiRef('action', run.nextActionId++),
            spanRef: span.ref,
            command,
            startedAt: Date.now(),
            completedAt: null,
            args: sanitizeSerializableArgs(args),
            target: await this.captureActionTarget(args),
            beforeDom: await this.captureDomFactSnapshot(),
            afterDom: null,
            error: null,
        }
        span.actionFactRefs.push(actionFact.ref)
        run.actionFacts.push(actionFact)
        this.captureActionFactValues(run, actionFact)
        return {
            spanRef: span.ref,
            actionRef: actionFact.ref,
        }
    }

    async endAutomaticSpan(
        token: AutomaticSpanToken | null,
        outcome?: {
            error?: unknown
        }
    ): Promise<void> {
        if (!token) return
        const run = this.currentRun
        if (!run) return
        const span = run.spans.find((candidate) => candidate.ref === token.spanRef)
        if (!span || span.endedAt) return
        const actionFact = run.actionFacts.find(
            (candidate) => candidate.ref === token.actionRef
        )
        if (actionFact) {
            actionFact.completedAt = Date.now()
            actionFact.afterDom = await this.captureDomFactSnapshot().catch(() => null)
            actionFact.error =
                outcome?.error instanceof Error
                    ? outcome.error.message
                    : typeof outcome?.error === 'string'
                      ? outcome.error
                      : null
            actionFact.target = await this.captureActionTarget(
                actionFact.args,
                actionFact.target
            ).catch(() => actionFact.target)
            this.captureActionFactValues(run, actionFact)
        }
        await this.finalizeSpan(run, span)
        await this.flushArtifacts(run)
    }

    listRequests(options?: {
        spanRef?: string | null
        kind?: 'candidates' | 'all'
        limit?: number
    }): ApiCandidateRow[] {
        const run = this.requireRun()
        const analysis = this.analyzeRun(run)
        const span = options?.spanRef ? this.getSpan(run, options.spanRef) : null
        const requests = this.getRequestsForSpan(run, span?.ref || null)
        const rows = requests.map((request) =>
            this.buildCandidateRow(run, analysis, request, span)
        )
        const requestByRef = new Map(requests.map((request) => [request.ref, request]))
        const profileByRef = new Map(
            requests.map((request) => [
                request.ref,
                this.buildCandidateSelectionProfile(analysis, request),
            ])
        )
        const compareRows = (left: ApiCandidateRow, right: ApiCandidateRow) =>
            this.compareCandidatePreference(
                {
                    row: left,
                    request: requestByRef.get(left.ref)!,
                    profile: profileByRef.get(left.ref)!,
                },
                {
                    row: right,
                    request: requestByRef.get(right.ref)!,
                    profile: profileByRef.get(right.ref)!,
                }
            )

        if (options?.kind === 'all') {
            return rows
                .sort((left, right) => compareRequestRefs(right.ref, left.ref))
                .slice(0, options?.limit ?? CANDIDATE_LIMIT)
        }

        return rows
            .sort(compareRows)
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
        const analysis = this.analyzeRun(run)
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
            actionFactRefs: span?.actionFactRefs || [],
            requestHeaders: request.requestHeaders,
            requestExtraHeaders: request.requestExtraHeaders,
            responseHeaders: request.responseHeaders,
            responseExtraHeaders: request.responseExtraHeaders,
            associatedCookies: request.associatedCookies,
            blockedCookies: request.blockedCookies,
            requestBody:
                bodyMode === 'summary'
                    ? summarizeBodyRecord(request.requestBody)
                    : request.requestBody,
            responseBody:
                bodyMode === 'summary'
                    ? summarizeBodyRecord(request.responseBody)
                    : request.responseBody,
            slots: analysis.slotsByRequestRef.get(request.ref) || [],
            artifactPaths: {
                capture: path.join(run.dir, 'capture.ndjson'),
                requestIndex: path.join(run.dir, 'request-index.json'),
                slots: path.join(run.dir, 'slot-index.json'),
                evidence: path.join(run.dir, 'slot-evidence.json'),
            },
        }

        if (options?.raw) {
            return dossier
        }
        return redactRecordStrings(dossier, run.values)
    }

    listSlots(options?: {
        requestRef?: string | null
        spanRef?: string | null
    }): ApiRequestSlot[] {
        const run = this.requireRun()
        const analysis = this.analyzeRun(run)
        if (options?.requestRef) {
            return redactRecordStrings(
                analysis.slotsByRequestRef.get(options.requestRef) || [],
                run.values
            )
        }
        if (options?.spanRef) {
            const requestRefs = new Set(
                this.getRequestsForSpan(run, options.spanRef).map((request) => request.ref)
            )
            const output: ApiRequestSlot[] = []
            for (const [requestRef, slots] of analysis.slotsByRequestRef.entries()) {
                if (!requestRefs.has(requestRef)) continue
                output.push(...slots)
            }
            return redactRecordStrings(output, run.values)
        }
        const output: ApiRequestSlot[] = []
        for (const slots of analysis.slotsByRequestRef.values()) {
            output.push(...slots)
        }
        return redactRecordStrings(output, run.values)
    }

    inspectSlot(ref: string): Record<string, unknown> {
        const run = this.requireRun()
        const analysis = this.analyzeRun(run)
        const slot = analysis.slotsByRef.get(ref)
        if (!slot) {
            throw new Error(`Unknown API slot ref "${ref}".`)
        }
        const request = this.getRequest(run, slot.requestRef)
        return redactRecordStrings(
            {
                slot,
                request: {
                    ref: request.ref,
                    method: request.method,
                    urlTemplate: request.urlTemplate,
                },
                evidence: analysis.evidenceBySlotRef.get(slot.ref) || [],
            },
            run.values
        )
    }

    inspectEvidence(ref: string): Record<string, unknown> {
        const run = this.requireRun()
        const analysis = this.analyzeRun(run)
        const slot = analysis.slotsByRef.get(ref)
        if (slot) {
            return redactRecordStrings(
                {
                    slot,
                    evidence: analysis.evidenceBySlotRef.get(slot.ref) || [],
                },
                run.values
            )
        }
        const evidence = analysis.evidenceByRef.get(ref)
        if (!evidence) {
            throw new Error(`Unknown API evidence ref "${ref}".`)
        }
        return redactRecordStrings({ evidence }, run.values)
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
        const analysis = this.analyzeRun(run)
        const valueRecord = isApiRefKind(query, 'value') ? run.values.getByRef(query) : null
        const rawValue = valueRecord?.raw || query
        const spanRef = options?.spanRef || null
        const candidates: ApiValueTraceCandidate[] = []

        for (const [slotRef, evidence] of analysis.evidenceBySlotRef.entries()) {
            const slot = analysis.slotsByRef.get(slotRef)
            if (!slot) continue
            const request = this.getRequest(run, slot.requestRef)
            if (spanRef && request.spanRef !== spanRef) continue
            if (slot.rawValue === rawValue) {
                candidates.push({
                    ref: slot.ref,
                    role: slot.role,
                    kind: 'request_value',
                    sourceRef: request.ref,
                    location: slot.slotPath,
                    matchType: 'exact',
                    transformChain: [],
                    confidence: slot.confidence,
                    whyNotOthers: `Exact match in ${slot.slotPath} on ${request.ref}.`,
                })
            }
            for (const item of evidence) {
                if (item.observedValue !== rawValue) continue
                candidates.push({
                    ref: item.ref,
                    role: item.role,
                    kind: item.kind,
                    sourceRef: item.sourceRef,
                    location: item.sourceLocation,
                    matchType: 'exact',
                    transformChain: item.transformChain,
                    confidence: clamp(item.score / 10, 0.2, 0.99),
                    whyNotOthers: item.rationale,
                })
            }
        }

        return {
            valueRef: valueRecord?.ref || run.values.getByRaw(rawValue)?.ref || null,
            query: run.values.redactString(rawValue).value,
            candidates: redactRecordStrings(
                candidates
                    .sort((left, right) => right.confidence - left.confidence)
                    .slice(0, MAX_TRACE_CANDIDATES),
                run.values
            ),
        }
    }

    async runProbe(args: {
        spanRef: string
        values: string[]
    }): Promise<ApiProbeRun> {
        const run = this.requireRun(true)
        const span = this.getSpan(run, args.spanRef)
        const actionFact = this.getActionFactForSpan(run, span.ref)
        if (!actionFact) {
            throw new Error('Probe requires a captured automatic action.')
        }
        if (actionFact.command !== 'input' && actionFact.command !== 'select') {
            throw new Error('Probes currently support only captured input/select spans.')
        }
        if (!span.requestRefs.length) {
            throw new Error('Probe span does not have any captured requests to compare.')
        }
        const originalRequests = span.requestRefs.map((ref) => this.getRequest(run, ref))
        if (
            originalRequests.some(
                (request) =>
                    request.method !== 'GET' &&
                    request.method !== 'HEAD' &&
                    request.method !== 'OPTIONS'
            )
        ) {
            throw new Error('Probe only supports read-only request bursts.')
        }

        const originalValue = readActionPrimaryValue(actionFact)
        const variants: ApiProbeVariantResult[] = []
        const signatures = new Set(originalRequests.map((request) => request.signature))
        const originalRequestBySignature = new Map<string, InternalRequestRecord>()
        for (const request of originalRequests) {
            if (!originalRequestBySignature.has(request.signature)) {
                originalRequestBySignature.set(request.signature, request)
            }
        }

        for (const value of args.values) {
            const startIndex = run.requestOrder.length
            await this.replayActionValue(actionFact, value)
            await waitMs(750)
            const newRequests = run.requestOrder
                .slice(startIndex)
                .map((ref) => this.getRequest(run, ref))
            const matched = newRequests.find((request) => signatures.has(request.signature))
            const baseline =
                matched ? originalRequestBySignature.get(matched.signature) || null : null
            variants.push({
                label: value,
                requestRef: matched?.ref || null,
                matchedSignature: matched?.signature || null,
                slots:
                    matched && baseline
                        ? this.buildProbeSlotComparisons(baseline, matched)
                        : [],
            })
        }

        if (originalValue != null) {
            await this.replayActionValue(actionFact, originalValue).catch(() => undefined)
        }

        const probe: ApiProbeRun = {
            ref: buildApiRef('probe', run.nextProbeId++),
            spanRef: span.ref,
            createdAt: Date.now(),
            mode: 'read_only',
            values: [...args.values],
            variants,
        }
        run.probes.push(probe)
        await this.flushArtifacts(run)
        return redactRecordStrings(probe, run.values)
    }

    async inferPlan(args: {
        task: string
        spanRef?: string | null
        requestRef?: string | null
    }): Promise<ApiPlanIr> {
        const run = this.requireRun()
        const analysis = this.analyzeRun(run)
        const target =
            args.requestRef
                ? this.getRequest(run, args.requestRef)
                : this.chooseTargetRequest(run, analysis, args.spanRef || null)
        if (!target) {
            throw new Error('No candidate request could be selected for inference.')
        }

        const draftPlan = normalizeDeterministicPlan(
            this.buildPlan(run, analysis, target, args.task),
            {
                sourceRunRef: run.ref,
                sourceRunId: run.id,
                status: 'draft',
            }
        )
        run.plans.push(draftPlan)
        await this.writePlanArtifact(run, draftPlan)
        await this.registry.savePlan(draftPlan)
        await this.flushArtifacts(run)
        return redactRecordStrings(draftPlan, run.values)
    }

    inspectPlan(ref: string): ApiPlanIr {
        const run = this.requireRun()
        const plan = run.plans.find((candidate) => candidate.ref === ref)
        if (!plan) {
            throw new Error(`Unknown API plan ref "${ref}".`)
        }
        return redactRecordStrings(plan, run.values)
    }

    async listPlans(): Promise<ApiPlanSummary[]> {
        return this.registry.list()
    }

    async ensureSession(args: {
        ref?: string | null
        operation?: string | null
        version?: number | null
        interactive?: boolean
        runtimeMode?: ApiPlanRuntimeMode
    }) {
        const plan = await this.loadDeterministicPlan(args)
        return this.runtimeManager.prepare(plan, {
            mode: args.runtimeMode ?? 'required',
            interactive: args.interactive,
        })
    }

    async executePlan(args: {
        ref?: string | null
        operation?: string | null
        version?: number | null
        inputs?: Record<string, unknown> | string | null
        refreshSession?: boolean
        allowDraft?: boolean
        runtimeMode?: ApiPlanRuntimeMode
        interactiveRuntime?: boolean
    }): Promise<ApiPlanExecutionReport> {
        const plan = await this.loadDeterministicPlan(args)
        return this.lifecycle.execute(plan, {
            inputs: normalizeInputMap(args.inputs),
            allowDraft: args.allowDraft,
            runtimeMode: args.runtimeMode,
            interactiveRuntime: args.interactiveRuntime,
        })
    }

    async validatePlan(args: {
        ref: string
        mode: ApiPlanValidationMode
        inputs?: Record<string, unknown> | string | null
    }): Promise<ApiValidationReport> {
        const run = this.requireRun()
        const planIndex = run.plans.findIndex((candidate) => candidate.ref === args.ref)
        const plan = planIndex >= 0 ? run.plans[planIndex] : null
        if (!plan) {
            throw new Error(`Unknown API plan ref "${args.ref}".`)
        }
        const inputs = normalizeInputMap(args.inputs)
        const report: ApiValidationReport = {
            ref: buildApiRef('validation', run.nextValidationId++),
            planRef: plan.ref,
            createdAt: Date.now(),
            mode: args.mode,
            inputs,
            steps: [],
            oracle: {
                statusMatches: false,
                mimeMatches: false,
            },
            notes: [],
            failureKind: null,
        }

        const missingInputs = plan.callerInputs
            .filter((input) => input.required && !(input.name in inputs))
            .map((input) => input.name)
        if (missingInputs.length) {
            report.notes.push(
                `Missing caller inputs; defaulting to captured values: ${missingInputs.join(', ')}.`
            )
        }

        if (args.mode === 'dry-run') {
            report.oracle.statusMatches = true
            report.oracle.mimeMatches = true
            report.notes.push(`Execution mode: ${plan.executionMode}.`)
        } else {
            const outcome = await this.lifecycle.validate(plan, {
                inputs,
                runtimeMode: 'required',
            })
            const execution = outcome.baseline

            for (const step of execution.steps) {
                report.steps.push({
                    stepId: step.stepId,
                    requestRef: step.requestRef,
                    ok: step.ok,
                    status: step.status,
                    mime: step.mime,
                    url: step.url,
                    error: step.error,
                })
            }
            report.failureKind = execution.failureKind
            report.oracle.statusMatches = execution.oracleChecks
                .filter((check) => check.kind === 'status')
                .every((check) => check.ok)
            report.oracle.mimeMatches = execution.oracleChecks
                .filter((check) => check.kind === 'mime')
                .every((check) => check.ok)

            const promotedPlan = outcome.plan
            run.plans[planIndex] = promotedPlan
            await this.writePlanArtifact(run, promotedPlan)

            const existingRecord = await this.registry.loadByRef(plan.ref).catch(() => null)
            const now = Date.now()
            await this.registry.savePlan(promotedPlan, {
                ...(existingRecord?.meta || {}),
                lifecycle: outcome.lifecycle,
                lastValidation: buildAttemptMeta(execution, promotedPlan, now, 'required'),
            })

            report.notes.push(...outcome.promotionIssues)
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
        await writeTextArtifact(file, rendered)
        await this.flushArtifacts(run)
        return { file, language: args.lang }
    }

    async renderPlan(args: {
        ref: string
        format: ApiRenderFormat
    }): Promise<{
        file: string
        format: ApiRenderFormat
    }> {
        const run = this.requireRun()
        const plan = run.plans.find((candidate) => candidate.ref === args.ref)
        if (!plan) {
            throw new Error(`Unknown API plan ref "${args.ref}".`)
        }
        const extension =
            args.format === 'ir'
                ? 'json'
                : args.format === 'exec'
                  ? 'exec.json'
                  : 'curl.sh'
        const file = path.join(run.dir, 'plans', `${plan.ref.slice(1)}.${extension}`)
        const content =
            args.format === 'ir'
                ? JSON.stringify(plan, null, 2)
                : args.format === 'exec'
                  ? JSON.stringify(renderExecPlan(run, plan), null, 2)
                  : renderCurlTrace(run, plan)
        await writeTextArtifact(file, content)
        return { file, format: args.format }
    }

    async exportPlan(args: {
        ref: string
        format: ApiRenderFormat | 'curl'
    }): Promise<{
        file: string
        format: ApiRenderFormat
    }> {
        return this.renderPlan({
            ref: args.ref,
            format: args.format === 'curl' ? 'curl-trace' : args.format,
        })
    }

    private attachSessionListeners(run: InternalRunState): void {
        const session = run.session
        if (!session) return
        session.on('Network.requestWillBeSent', (params: unknown) => {
            void this.handleRequestWillBeSent(run, params)
        })
        session.on('Network.requestWillBeSentExtraInfo', (params: unknown) => {
            this.handleRequestWillBeSentExtraInfo(run, params)
        })
        session.on('Network.responseReceived', (params: unknown) => {
            this.handleResponseReceived(run, params)
        })
        session.on('Network.responseReceivedExtraInfo', (params: unknown) => {
            this.handleResponseReceivedExtraInfo(run, params)
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
        session.on('DOMStorage.domStorageItemAdded', (params: unknown) => {
            this.handleStorageEvent(run, 'added', params)
        })
        session.on('DOMStorage.domStorageItemUpdated', (params: unknown) => {
            this.handleStorageEvent(run, 'updated', params)
        })
        session.on('DOMStorage.domStorageItemRemoved', (params: unknown) => {
            this.handleStorageEvent(run, 'removed', params)
        })
        session.on('DOMStorage.domStorageItemsCleared', (params: unknown) => {
            this.handleStorageEvent(run, 'cleared', params)
        })
    }

    private attachPageListeners(): void {
        const opensteer = this.requireOpensteer()
        opensteer.page.on('response', this.responseListener)
        opensteer.page.on('download', this.downloadListener)
    }

    private detachPageListeners(): void {
        if (!this.opensteer) return
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
        if (!requestId || !url) return
        const method = asString(requestPayload.method) || 'GET'
        const requestHeaders = normalizeHeaders(asRecord(requestPayload.headers))
        const rawPostData = asString(requestPayload.postData) || null
        const requestBody = buildBodyRecord(rawPostData, requestHeaders['content-type'])
        const graphql = inferGraphqlMetadata(requestBody?.parsedJson)
        const requestRef = buildApiRef('request', run.nextRequestId++)
        const entry: InternalRequestRecord = {
            ref: requestRef,
            requestId,
            startedAt: Date.now(),
            finishedAt: null,
            method,
            url,
            urlTemplate: buildUrlTemplate(url),
            resourceType: asString(record.type)?.toLowerCase() || null,
            status: null,
            ok: null,
            failed: false,
            failureText: null,
            requestHeaders,
            responseHeaders: {},
            requestExtraHeaders: {},
            responseExtraHeaders: {},
            requestBody,
            responseBody: null,
            responseMime: null,
            responseSize: null,
            hasUserGesture: Boolean(record.hasUserGesture),
            initiatorType: asString(asRecord(record.initiator).type) || null,
            initiatorUrl: resolveInitiatorUrl(asRecord(record.initiator)),
            initiatorRequestRef: resolveInitiatorRequestRef(run, asRecord(record.initiator)),
            redirectFromRef: resolveRedirectRef(run, asRecord(record.redirectResponse), url),
            fromServiceWorker: null,
            graphql,
            signature: normalizeRequestSignature({
                method,
                url,
                resourceType: asString(record.type)?.toLowerCase() || null,
                body: requestBody?.parsedJson ?? requestBody?.parsedForm ?? rawPostData,
                graphql,
            }),
            spanRef: run.activeManualSpanRef,
            matchedDownloadRef: null,
            matchedNavigation: false,
            associatedCookies: [],
            blockedCookies: [],
        }

        run.requestsById.set(requestId, entry)
        run.requestsByRef.set(entry.ref, entry)
        run.requestOrder.push(entry.ref)
        captureValueOccurrences(run, requestHeaders, {
            requestRef: entry.ref,
            source: 'request.header',
        })
        captureUrlAndBodyValues(run, entry)
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

    private handleRequestWillBeSentExtraInfo(
        run: InternalRunState,
        params: unknown
    ): void {
        const record = asRecord(params)
        const requestId = asString(record.requestId)
        if (!requestId) return
        const request = run.requestsById.get(requestId)
        if (!request) return
        request.requestExtraHeaders = normalizeHeaders(asRecord(record.headers))
        request.associatedCookies = normalizeCookieNames(record.associatedCookies)
        captureValueOccurrences(run, request.requestExtraHeaders, {
            requestRef: request.ref,
            source: 'request.header',
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
        captureValueOccurrences(run, request.responseHeaders, {
            requestRef: request.ref,
            source: 'response.header',
        })
    }

    private handleResponseReceivedExtraInfo(
        run: InternalRunState,
        params: unknown
    ): void {
        const record = asRecord(params)
        const requestId = asString(record.requestId)
        if (!requestId) return
        const request = run.requestsById.get(requestId)
        if (!request) return
        request.responseExtraHeaders = normalizeHeaders(asRecord(record.headers))
        request.blockedCookies = normalizeBlockedCookieNames(record.blockedCookies)
        captureValueOccurrences(run, request.responseExtraHeaders, {
            requestRef: request.ref,
            source: 'response.header',
        })
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
        if (!run.session) return
        try {
            const payload = (await run.session.send('Network.getResponseBody', {
                requestId,
            })) as Record<string, unknown>
            const rawBody = typeof payload.body === 'string' ? payload.body : null
            const base64Encoded = payload.base64Encoded === true
            const decoded = rawBody ? decodeResponseBody(rawBody, base64Encoded) : null
            request.responseBody = buildBodyRecord(
                decoded,
                request.responseMime,
                rawBody ? Buffer.byteLength(rawBody, 'utf8') : 0,
                base64Encoded
            )
            if (decoded) {
                captureBodyValues(run, request.responseBody, request.ref, 'response.body')
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
            requestExtraHeaders: {},
            responseExtraHeaders: {},
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
            associatedCookies: [],
            blockedCookies: [],
        }
        run.requestsById.set(requestId, entry)
        run.requestsByRef.set(entry.ref, entry)
        run.requestOrder.push(entry.ref)
    }

    private handlePlaywrightResponse(response: Response): void {
        const run = this.currentRun
        const opensteer = this.opensteer
        if (!run || !opensteer) return
        const request = findBestMatchingRequest(run, {
            url: response.url(),
            method: response.request().method(),
        })
        if (!request) return
        request.fromServiceWorker = response.fromServiceWorker()
        request.matchedNavigation =
            request.resourceType === 'document' &&
            response.request().frame() === opensteer.page.mainFrame()
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

    private handleStorageEvent(
        run: InternalRunState,
        kind: ApiStorageEvent['kind'],
        params: unknown
    ): void {
        const record = asRecord(params)
        const storageId = asRecord(record.storageId)
        const event: ApiStorageEvent = {
            ref: `storage_${run.nextStorageEventId++}`,
            at: Date.now(),
            kind,
            storageType: storageId.isLocalStorage === false ? 'session' : 'local',
            origin: asString(storageId.securityOrigin),
            key: asString(record.key),
            value: asString(record.newValue) || asString(record.value),
        }
        run.storageEvents.push(event)
        if (event.value) {
            run.values.register(
                event.value,
                {
                    source:
                        event.storageType === 'local'
                            ? 'storage.local'
                            : 'storage.session',
                    path: event.key || undefined,
                },
                { key: event.key || undefined }
            )
        }
    }

    private async createSpan(
        run: InternalRunState,
        label: string,
        kind: ApiActionSpan['kind'],
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
            actionFactRefs: [],
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
        const opensteer = this.requireOpensteer()
        const page = opensteer.page
        const [title, html, cookies, storage] = await Promise.all([
            page.title().catch(() => ''),
            page.content().catch(() => ''),
            opensteer.context.cookies().catch(() => []),
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
            cookies: Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value])),
            storage,
        }
    }

    private async captureDomFactSnapshot(): Promise<ApiDomSnapshotFact> {
        const opensteer = this.requireOpensteer()
        const page = opensteer.page
        return await page.evaluate<
            ApiDomSnapshotFact,
            { maxFields: number; maxInline: number }
        >(
            ({ maxFields, maxInline }) => {
                const limitText = (value: string | null | undefined, length = 512) => {
                    if (typeof value !== 'string') return null
                    const trimmed = value.trim()
                    if (!trimmed) return null
                    return trimmed.slice(0, length)
                }

                const fields = Array.from(
                    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
                        'input, textarea, select'
                    )
                )
                    .slice(0, maxFields)
                    .map((element) => {
                        const tagName = element.tagName.toLowerCase()
                        const type =
                            'type' in element && typeof element.type === 'string'
                                ? element.type
                                : null
                        const hidden =
                            type === 'hidden' ||
                            element.hidden ||
                            (element as HTMLElement).offsetParent === null
                        const value =
                            'value' in element && typeof element.value === 'string'
                                ? limitText(element.value)
                                : null
                        return {
                            tagName,
                            type,
                            name: limitText(element.getAttribute('name'), 128),
                            id: limitText(element.getAttribute('id'), 128),
                            formName: limitText(element.form?.getAttribute('name'), 128),
                            formId: limitText(element.form?.getAttribute('id'), 128),
                            formAction: limitText(element.form?.action, 256),
                            formMethod: limitText(element.form?.method, 32),
                            placeholder: limitText(element.getAttribute('placeholder'), 128),
                            ariaLabel: limitText(element.getAttribute('aria-label'), 128),
                            title: limitText(element.getAttribute('title'), 128),
                            value,
                            hidden,
                            checked:
                                'checked' in element && typeof element.checked === 'boolean'
                                    ? element.checked
                                    : null,
                        }
                    })
                    .filter((field) => field.value != null)

                const inlineValues: Array<{ path: string; value: string; source: string }> = []
                const visit = (value: unknown, path: string, source: string): void => {
                    if (inlineValues.length >= maxInline) return
                    if (Array.isArray(value)) {
                        value.forEach((entry, index) => visit(entry, `${path}[${index}]`, source))
                        return
                    }
                    if (value && typeof value === 'object') {
                        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
                            visit(child, path ? `${path}.${key}` : key, source)
                            if (inlineValues.length >= maxInline) return
                        }
                        return
                    }
                    if (value == null) return
                    const text = limitText(String(value), 256)
                    if (!text) return
                    inlineValues.push({
                        path,
                        value: text,
                        source,
                    })
                }

                const scripts = Array.from(
                    document.querySelectorAll<HTMLScriptElement>(
                        'script[type="application/json"], script#__NEXT_DATA__, script#__NUXT_DATA__'
                    )
                )
                scripts.slice(0, 24).forEach((script, index) => {
                    const text = script.textContent?.trim() || ''
                    if (!text || inlineValues.length >= maxInline) return
                    try {
                        const parsed = JSON.parse(text)
                        const id = script.id ? `#${script.id}` : `script[${index}]`
                        visit(parsed, '', `inline:${id}`)
                    } catch {
                        return
                    }
                })

                return {
                    url: window.location.href,
                    fields,
                    inlineValues,
                }
            },
            {
                maxFields: MAX_DOM_FIELDS,
                maxInline: MAX_INLINE_VALUES,
            }
        )
    }

    private async captureActionTarget(
        args: Record<string, unknown>,
        existing?: ApiActionTargetFact | null
    ): Promise<ApiActionTargetFact | null> {
        const opensteer = this.requireOpensteer()
        const options = {
            description: asString(args.description) || undefined,
            selector: asString(args.selector) || undefined,
            element: asNumber(args.element) || undefined,
        }
        if (!options.description && !options.selector && options.element == null) {
            return existing || null
        }

        const [value, text, attributes] = await Promise.all([
            opensteer.getElementValue(options).catch(() => null),
            opensteer.getElementText(options).catch(() => null),
            opensteer.getElementAttributes(options).catch(() => ({})),
        ])

        return {
            description: options.description || null,
            selector: options.selector || null,
            element: options.element ?? null,
            beforeValue: existing?.beforeValue ?? value,
            afterValue: value,
            beforeText: existing?.beforeText ?? text,
            afterText: text,
            attributes,
        }
    }

    private captureActionFactValues(run: InternalRunState, actionFact: ApiActionFact): void {
        for (const location of collectActionFactValueLocations(actionFact)) {
            run.values.register(
                location.value,
                {
                    actionRef: actionFact.ref,
                    spanRef: actionFact.spanRef,
                    source: location.source,
                    path: location.path,
                },
                {
                    key: location.path,
                }
            )
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

    private buildCandidateSelectionProfile(
        analysis: RunAnalysis,
        request: InternalRequestRecord
    ): CandidateSelectionProfile {
        const slots = analysis.slotsByRequestRef.get(request.ref) || []
        const bindings = slots
            .map((slot) => analysis.bindingBySlotRef.get(slot.ref))
            .filter((binding): binding is BindingSeed => Boolean(binding))
        const userInputSlotCount = slots.filter((slot) => slot.role === 'user_input').length
        const nonCallerSlotCount = bindings.filter((binding) => binding.kind !== 'caller').length
        const executionModeCost = bindings.reduce((sum, binding) => {
            switch (binding.kind) {
                case 'caller':
                case 'constant':
                    return sum
                case 'derived_response':
                case 'derived_response_header':
                    return sum + 1
                case 'ambient_cookie':
                case 'session_cookie':
                case 'session_storage':
                    return sum + 2
                case 'dom_field':
                case 'inline_json':
                    return sum + 3
                case 'unknown':
                    return sum + 4
            }
        }, 0)
        const asyncPreference =
            request.resourceType === 'xhr' || request.resourceType === 'fetch'
                ? 4
                : request.responseMime === 'application/json' || Boolean(request.graphql.operationName)
                  ? 3
                  : request.resourceType === 'document' && request.responseMime === 'text/html'
                    ? 0
                    : 1
        const strongInputSources = new Set<string>()
        for (const slot of slots) {
            if (slot.role !== 'user_input') continue
            for (const evidence of analysis.evidenceBySlotRef.get(slot.ref) || []) {
                if (
                    evidence.kind !== 'action_argument' &&
                    evidence.kind !== 'action_choice' &&
                    evidence.kind !== 'action_target' &&
                    evidence.kind !== 'probe_changed' &&
                    evidence.kind !== 'upstream_slot'
                ) {
                    continue
                }
                const sourceKey = evidence.sourceRef || evidence.sourceLocation || slot.ref
                strongInputSources.add(`${evidence.kind}:${sourceKey}`)
            }
        }
        return {
            requestRef: request.ref,
            userInputSlotCount,
            nonCallerSlotCount,
            totalSlotCount: slots.length,
            executionModeCost,
            asyncPreference,
            strongInputSources,
        }
    }

    private compareCandidatePreference(
        left: {
            row: ApiCandidateRow
            request: InternalRequestRecord
            profile: CandidateSelectionProfile
        },
        right: {
            row: ApiCandidateRow
            request: InternalRequestRecord
            profile: CandidateSelectionProfile
        }
    ): number {
        const dominance = this.compareDominatedCandidates(left, right)
        if (dominance !== 0) return dominance
        if (left.profile.userInputSlotCount !== right.profile.userInputSlotCount) {
            return right.profile.userInputSlotCount - left.profile.userInputSlotCount
        }
        if (left.profile.asyncPreference !== right.profile.asyncPreference) {
            return right.profile.asyncPreference - left.profile.asyncPreference
        }
        if (left.profile.executionModeCost !== right.profile.executionModeCost) {
            return left.profile.executionModeCost - right.profile.executionModeCost
        }
        if (left.profile.nonCallerSlotCount !== right.profile.nonCallerSlotCount) {
            return left.profile.nonCallerSlotCount - right.profile.nonCallerSlotCount
        }
        if (left.profile.totalSlotCount !== right.profile.totalSlotCount) {
            return left.profile.totalSlotCount - right.profile.totalSlotCount
        }
        if (left.row.candidateScore !== right.row.candidateScore) {
            return right.row.candidateScore - left.row.candidateScore
        }
        return right.request.startedAt - left.request.startedAt
    }

    private compareDominatedCandidates(
        left: {
            request: InternalRequestRecord
            profile: CandidateSelectionProfile
        },
        right: {
            request: InternalRequestRecord
            profile: CandidateSelectionProfile
        }
    ): number {
        const leftDominates = this.candidateDominates(left, right)
        const rightDominates = this.candidateDominates(right, left)
        if (leftDominates && !rightDominates) return -1
        if (rightDominates && !leftDominates) return 1
        return 0
    }

    private candidateDominates(
        winner: {
            request: InternalRequestRecord
            profile: CandidateSelectionProfile
        },
        loser: {
            request: InternalRequestRecord
            profile: CandidateSelectionProfile
        }
    ): boolean {
        if (
            winner.request.ref === loser.request.ref ||
            winner.request.spanRef !== loser.request.spanRef
        ) {
            return false
        }
        if (
            !setsIntersect(
                winner.profile.strongInputSources,
                loser.profile.strongInputSources
            )
        ) {
            return false
        }
        const winnerIsNarrower =
            winner.profile.asyncPreference >= loser.profile.asyncPreference &&
            winner.profile.executionModeCost <= loser.profile.executionModeCost &&
            winner.profile.nonCallerSlotCount <= loser.profile.nonCallerSlotCount &&
            winner.profile.totalSlotCount <= loser.profile.totalSlotCount
        if (!winnerIsNarrower) {
            return false
        }
        return (
            winner.profile.asyncPreference > loser.profile.asyncPreference ||
            winner.profile.executionModeCost < loser.profile.executionModeCost ||
            winner.profile.nonCallerSlotCount < loser.profile.nonCallerSlotCount ||
            winner.profile.totalSlotCount < loser.profile.totalSlotCount
        )
    }

    private getSpan(run: InternalRunState, ref: string): ApiActionSpan {
        const span = run.spans.find((candidate) => candidate.ref === ref)
        if (!span) {
            throw new Error(`Unknown API span ref "${ref}".`)
        }
        return span
    }

    private getActionFactForSpan(
        run: InternalRunState,
        spanRef: string
    ): ApiActionFact | null {
        return run.actionFacts.find((candidate) => candidate.spanRef === spanRef) || null
    }

    private getRequest(run: InternalRunState, ref: string): InternalRequestRecord {
        const request = getRequestByRef(run, ref)
        if (!request) {
            throw new Error(`Unknown API request ref "${ref}".`)
        }
        return request
    }

    private requireRun(activeOnly = false): InternalRunState {
        const run = this.currentRun || this.ensureLoadedRun()
        if (!run) {
            throw new Error('No API capture run exists for this session yet.')
        }
        if (activeOnly && !run.active) {
            throw new Error('API capture is not active for this session.')
        }
        return run
    }

    private async loadDeterministicPlan(args: {
        ref?: string | null
        operation?: string | null
        version?: number | null
    }): Promise<ApiPlanIr> {
        if (args.ref) {
            const run = this.currentRun || this.ensureLoadedRun()
            const fromRun = run?.plans.find((candidate) => candidate.ref === args.ref)
            if (fromRun) {
                return normalizeDeterministicPlan(fromRun)
            }
            const fromRegistry = await this.registry.loadByRef(args.ref)
            if (fromRegistry) {
                return fromRegistry.plan
            }
            throw new Error(`Unknown API plan ref "${args.ref}".`)
        }

        if (!args.operation) {
            throw new Error('A plan ref or operation name is required.')
        }

        const record =
            args.version != null
                ? await this.registry.load(args.operation, args.version)
                : await this.registry.load(args.operation)
        return record.plan
    }

    private buildCandidateRow(
        run: InternalRunState,
        analysis: RunAnalysis,
        request: InternalRequestRecord,
        span: ApiActionSpan | null
    ): ApiCandidateRow {
        const requestSpan = request.spanRef ? this.getSpan(run, request.spanRef) : null
        const reasons: ApiCandidateReason[] = []
        const add = (label: string, score: number): void => {
            reasons.push({ label, score })
        }
        const profile = this.buildCandidateSelectionProfile(analysis, request)

        if (request.spanRef && span && request.spanRef === span.ref) add('in_span', 4)
        if (request.hasUserGesture) add('user_gesture', 3)
        if (request.resourceType === 'xhr' || request.resourceType === 'fetch') add('async_api', 4)
        if (request.resourceType === 'document') add('document', 2)
        if (request.resourceType === 'document' && request.responseMime === 'text/html') {
            add('broad_html_surface', -2)
        }
        if (request.matchedDownloadRef) add('download', 6)
        if (request.matchedNavigation) add('navigation', 3)
        if (request.responseMime === 'application/json') add('json', 2)
        if (request.method === 'OPTIONS') add('preflight', -8)
        if (isRepeatedSignature(run, request.signature)) add('repeated_signature', -3)
        if (request.resourceType === 'websocket') add('websocket_evidence_only', -2)
        if (request.failed) add('failed', -4)
        if (analysis.slotsByRequestRef.get(request.ref)?.some((slot) => slot.role === 'user_input')) {
            add('parameterized', 3)
        }
        if (profile.executionModeCost === 0 && request.resourceType !== 'document') {
            add('minimal_http_surface', 2)
        }
        if (profile.executionModeCost >= 3) {
            add('high_coupling', -2)
        }

        const spanActionFactRefs = requestSpan?.actionFactRefs || []
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
            effects: dedupeStrings(
                [
                    request.matchedDownloadRef ? 'download' : '',
                    request.matchedNavigation ? 'navigation' : '',
                    requestSpan?.effects.includes('dom_change') ? 'dom_change' : '',
                ].filter(Boolean)
            ),
            initiatorRef: request.initiatorRequestRef,
            slotCount: analysis.slotsByRequestRef.get(request.ref)?.length || 0,
            actionFactRefs: spanActionFactRefs,
            redactionSummary: {
                requestValues: redactedRequestBody,
                responseValues: redactedResponseBody,
            },
            reasons,
        }
    }

    private chooseTargetRequest(
        run: InternalRunState,
        analysis: RunAnalysis,
        spanRef: string | null
    ): InternalRequestRecord | null {
        const span = spanRef ? this.getSpan(run, spanRef) : null
        const requests = this.getRequestsForSpan(run, spanRef)
        if (!requests.length) return null
        const rowsByRef = new Map(
            requests.map((request) => [
                request.ref,
                this.buildCandidateRow(run, analysis, request, span),
            ])
        )
        const profilesByRef = new Map(
            requests.map((request) => [
                request.ref,
                this.buildCandidateSelectionProfile(analysis, request),
            ])
        )
        return (
            [...requests].sort((left, right) =>
                this.compareCandidatePreference(
                    {
                        row: rowsByRef.get(left.ref)!,
                        request: left,
                        profile: profilesByRef.get(left.ref)!,
                    },
                    {
                        row: rowsByRef.get(right.ref)!,
                        request: right,
                        profile: profilesByRef.get(right.ref)!,
                    }
                )
            )[0] || null
        )
    }

    private analyzeRun(run: InternalRunState): RunAnalysis {
        const requests = run.requestOrder
            .map((ref) => getRequestByRef(run, ref))
            .filter((request): request is InternalRequestRecord => Boolean(request))
        const slotSeedsByRef = new Map<string, SlotSeed>()
        const slotSeedsByRequestRef = new Map<string, SlotSeed[]>()
        const slotSeedByRequestAndPath = new Map<string, SlotSeed>()
        let nextSlotId = 1
        for (const request of requests) {
            const seeds = extractRequestSlots(request, nextSlotId)
            nextSlotId += seeds.length
            slotSeedsByRequestRef.set(request.ref, seeds)
            for (const seed of seeds) {
                slotSeedsByRef.set(seed.ref, seed)
                slotSeedByRequestAndPath.set(`${seed.requestRef}:${seed.slotPath}`, seed)
            }
        }

        const familyValues = buildFamilyValueIndex(requests, slotSeedsByRequestRef)
        const occurrencesByRequestRef = new Map<string, StructuredOccurrence[]>()
        const valueStatsByValue = buildOccurrenceValueStats(requests, occurrencesByRequestRef)
        const probeIndex = buildProbeIndex(run.probes, requests, slotSeedsByRequestRef)
        const memo = new Map<string, SlotAnalysis>()
        const analyzing = new Set<string>()

        const analyzeSlot = (seed: SlotSeed): SlotAnalysis => {
            const existing = memo.get(seed.ref)
            if (existing) return existing
            if (analyzing.has(seed.ref)) {
                const cycle: SlotAnalysis = {
                    seed,
                    role: 'unknown',
                    confidence: 0.25,
                    evidence: [
                        {
                            role: 'unknown',
                            kind: 'default_inference',
                            score: 2,
                            sourceRef: null,
                            sourceLabel: 'cycle',
                            sourceLocation: null,
                            observedValue: seed.rawValue,
                            transformChain: [],
                            rationale: 'Upstream provenance cycle detected.',
                        },
                    ],
                    binding: {
                        kind: 'unknown',
                        reason: 'Upstream provenance cycle detected.',
                    },
                }
                memo.set(seed.ref, cycle)
                return cycle
            }

            analyzing.add(seed.ref)
            const request = this.getRequest(run, seed.requestRef)
            const evidence = dedupeEvidenceSeeds(
                this.collectSlotEvidence(
                    run,
                    seed,
                    request,
                    slotSeedsByRequestRef,
                    slotSeedByRequestAndPath,
                    occurrencesByRequestRef,
                    valueStatsByValue,
                    familyValues,
                    probeIndex,
                    analyzeSlot
                )
            )
            const { role, confidence } = classifySlotRole(seed, evidence)
            const binding = resolveBindingSeed(seed, role, evidence)
            const result: SlotAnalysis = {
                seed,
                role,
                confidence,
                evidence,
                binding,
            }
            memo.set(seed.ref, result)
            analyzing.delete(seed.ref)
            return result
        }

        for (const request of requests) {
            for (const seed of slotSeedsByRequestRef.get(request.ref) || []) {
                analyzeSlot(seed)
            }
        }

        const slotsByRef = new Map<string, ApiRequestSlot>()
        const slotsByRequestRef = new Map<string, ApiRequestSlot[]>()
        const evidenceBySlotRef = new Map<string, ApiSlotEvidence[]>()
        const evidenceByRef = new Map<string, ApiSlotEvidence>()
        const bindingBySlotRef = new Map<string, BindingSeed>()
        let nextEvidenceId = 1

        for (const request of requests) {
            const slots: ApiRequestSlot[] = []
            for (const seed of slotSeedsByRequestRef.get(request.ref) || []) {
                const analysis = memo.get(seed.ref)
                if (!analysis) continue
                const evidence = analysis.evidence.map((item) => {
                    const entry: ApiSlotEvidence = {
                        ref: buildApiRef('evidence', nextEvidenceId++),
                        slotRef: seed.ref,
                        requestRef: request.ref,
                        role: item.role,
                        kind: item.kind,
                        score: item.score,
                        sourceRef: item.sourceRef,
                        sourceLabel: item.sourceLabel,
                        sourceLocation: item.sourceLocation,
                        observedValue: item.observedValue,
                        transformChain: item.transformChain,
                        rationale: item.rationale,
                    }
                    evidenceByRef.set(entry.ref, entry)
                    return entry
                })
                const slot: ApiRequestSlot = {
                    ref: seed.ref,
                    requestRef: seed.requestRef,
                    name: seed.name,
                    slotPath: seed.slotPath,
                    source: seed.source,
                    rawValue: seed.rawValue,
                    shape: seed.shape,
                    role: analysis.role,
                    confidence: analysis.confidence,
                    required: seed.required,
                    evidenceRefs: evidence.map((entry) => entry.ref),
                }
                slots.push(slot)
                slotsByRef.set(slot.ref, slot)
                evidenceBySlotRef.set(slot.ref, evidence)
                bindingBySlotRef.set(slot.ref, analysis.binding)
            }
            slotsByRequestRef.set(request.ref, slots)
        }

        return {
            slotsByRef,
            slotsByRequestRef,
            slotSeedsByRef,
            slotSeedByRequestAndPath,
            evidenceBySlotRef,
            evidenceByRef,
            bindingBySlotRef,
        }
    }

    private collectSlotEvidence(
        run: InternalRunState,
        seed: SlotSeed,
        request: InternalRequestRecord,
        slotSeedsByRequestRef: Map<string, SlotSeed[]>,
        slotSeedByRequestAndPath: Map<string, SlotSeed>,
        occurrencesByRequestRef: Map<string, StructuredOccurrence[]>,
        valueStatsByValue: Map<string, OccurrenceValueStats>,
        familyValues: Map<string, Set<string>>,
        probeIndex: Map<string, Map<string, string[]>>,
        analyzeSlot: (seed: SlotSeed) => SlotAnalysis
    ): EvidenceSeed[] {
        const evidence: EvidenceSeed[] = []
        const requests = run.requestOrder
            .map((ref) => getRequestByRef(run, ref))
            .filter((candidate): candidate is InternalRequestRecord => Boolean(candidate))
        const requestIndex = requests.findIndex((candidate) => candidate.ref === request.ref)
        const priorRequests = requestIndex >= 0 ? requests.slice(0, requestIndex) : []
        const priorActions = run.actionFacts
            .filter((candidate) => candidate.startedAt <= request.startedAt)
            .sort((left, right) => right.startedAt - left.startedAt)
            .slice(0, 16)

        for (const action of priorActions) {
            evidence.push(...collectActionEvidence(seed, action))
        }

        for (const span of run.spans) {
            if (!span.endedAt || span.endedAt > request.startedAt) continue
            evidence.push(
                ...collectSpanStateEvidence(
                    seed,
                    span,
                    valueStatsByValue.get(seed.rawValue) || null
                )
            )
        }

        for (const event of run.storageEvents) {
            if (event.at > request.startedAt || event.value !== seed.rawValue) continue
            if (!event.key) continue
            if (
                !shouldTreatAmbientStateMatchAsSession(
                    seed,
                    event.key,
                    valueStatsByValue.get(seed.rawValue) || null
                )
            ) {
                continue
            }
            evidence.push({
                role: 'session',
                kind: 'storage_event',
                score: 8,
                sourceRef: event.ref,
                sourceLabel: `${event.storageType}:${event.key}`,
                sourceLocation: `${event.storageType}.${event.key}`,
                observedValue: seed.rawValue,
                transformChain: [],
                rationale: `Value matched ${event.storageType} storage mutation for "${event.key}".`,
            })
        }

        for (const producer of priorRequests) {
            for (const occurrence of occurrencesByRequestRef.get(producer.ref) || []) {
                if (occurrence.value !== seed.rawValue) continue
                if (occurrence.source === 'response.body') {
                    const responseBodyMatch = analyzeResponseBodyOccurrence(
                        seed,
                        occurrence,
                        valueStatsByValue.get(seed.rawValue) || null
                    )
                    if (!responseBodyMatch) continue
                    evidence.push({
                        role: 'derived',
                        kind: 'response_value',
                        score: responseBodyMatch.score,
                        sourceRef: producer.ref,
                        sourceLabel: producer.ref,
                        sourceLocation: occurrence.location,
                        observedValue: seed.rawValue,
                        transformChain: [],
                        rationale: responseBodyMatch.rationale,
                    })
                    continue
                }

                if (occurrence.source === 'response.header') {
                    const responseHeaderMatch = analyzeResponseHeaderOccurrence(seed, occurrence)
                    if (!responseHeaderMatch) continue
                    evidence.push({
                        role: responseHeaderMatch.role,
                        kind: 'response_header',
                        score: responseHeaderMatch.score,
                        sourceRef: producer.ref,
                        sourceLabel: producer.ref,
                        sourceLocation: occurrence.location,
                        observedValue: seed.rawValue,
                        transformChain: [],
                        rationale: responseHeaderMatch.rationale,
                    })
                    continue
                }

                if (!occurrence.slotPath) continue
                const producerSeed = slotSeedByRequestAndPath.get(
                    `${producer.ref}:${occurrence.slotPath}`
                )
                if (!producerSeed) continue
                const producerAnalysis = analyzeSlot(producerSeed)
                if (
                    !shouldLinkUpstreamSlot(
                        seed,
                        producerSeed,
                        producerAnalysis.role
                    )
                ) {
                    continue
                }
                evidence.push({
                    role: producerAnalysis.role,
                    kind: 'upstream_slot',
                    score: producerAnalysis.role === 'user_input' ? 9 : producerAnalysis.role === 'constant' ? 7 : producerAnalysis.role === 'session' ? 8 : 7,
                    sourceRef: producerSeed.ref,
                    sourceLabel: producer.ref,
                    sourceLocation: occurrence.location,
                    observedValue: seed.rawValue,
                    transformChain: [],
                    rationale: `Value matched upstream slot ${producerSeed.slotPath} on ${producer.ref}, classified as ${producerAnalysis.role}.`,
                })
            }
        }

        const familyKey = `${request.method}:${request.urlTemplate}:${seed.slotPath}`
        const family = familyValues.get(familyKey)
        if (family && family.size === 1 && requests.filter((candidate) => candidate.method === request.method && candidate.urlTemplate === request.urlTemplate).length > 1) {
            evidence.push({
                role: 'constant',
                kind: 'signature_constant',
                score: 7,
                sourceRef: null,
                sourceLabel: request.urlTemplate,
                sourceLocation: seed.slotPath,
                observedValue: seed.rawValue,
                transformChain: [],
                rationale: 'Value stayed constant across repeated requests with the same template.',
            })
        }

        const probeValues = probeIndex.get(request.signature)?.get(seed.slotPath)
        if (probeValues && probeValues.length > 1) {
            const unique = new Set(probeValues)
            evidence.push({
                role: unique.size > 1 ? 'user_input' : 'constant',
                kind: unique.size > 1 ? 'probe_changed' : 'probe_constant',
                score: unique.size > 1 ? 11 : 9,
                sourceRef: null,
                sourceLabel: request.signature,
                sourceLocation: seed.slotPath,
                observedValue: seed.rawValue,
                transformChain: [],
                rationale:
                    unique.size > 1
                        ? 'Slot changed across safe probe variants.'
                        : 'Slot stayed constant across safe probe variants.',
            })
        }

        if (!evidence.length) {
            if (seed.source === 'cookie') {
                evidence.push({
                    role: 'session',
                    kind: 'default_inference',
                    score: 5,
                    sourceRef: null,
                    sourceLabel: seed.name,
                    sourceLocation: seed.slotPath,
                    observedValue: seed.rawValue,
                    transformChain: [],
                    rationale: 'Cookie slots default to session state.',
                })
            } else if (seed.source === 'header' && isSessionLikeKey(seed.name)) {
                evidence.push({
                    role: 'session',
                    kind: 'default_inference',
                    score: 5,
                    sourceRef: null,
                    sourceLabel: seed.name,
                    sourceLocation: seed.slotPath,
                    observedValue: seed.rawValue,
                    transformChain: [],
                    rationale: 'Auth and anti-CSRF headers default to session state.',
                })
            } else {
                evidence.push({
                    role: 'constant',
                    kind: 'default_inference',
                    score: 4,
                    sourceRef: null,
                    sourceLabel: seed.slotPath,
                    sourceLocation: seed.slotPath,
                    observedValue: seed.rawValue,
                    transformChain: [],
                    rationale:
                        'No direct provenance evidence was found; preserve the captured scaffolding instead of promoting this slot to caller input.',
                })
            }
        }

        return evidence
    }

    private buildPlan(
        run: InternalRunState,
        analysis: RunAnalysis,
        target: InternalRequestRecord,
        task: string
    ): ApiPlanIr {
        const includedRequests: string[] = []
        const includeRequest = (requestRef: string): void => {
            if (includedRequests.includes(requestRef)) return
            const slots = analysis.slotsByRequestRef.get(requestRef) || []
            for (const slot of slots) {
                const binding = analysis.bindingBySlotRef.get(slot.ref)
                if (
                    binding?.kind === 'derived_response' ||
                    binding?.kind === 'derived_response_header'
                ) {
                    includeRequest(binding.producerRef)
                }
            }
            includedRequests.push(requestRef)
        }
        includeRequest(target.ref)

        const requestOrderIndex = new Map<string, number>()
        run.requestOrder.forEach((ref, index) => requestOrderIndex.set(ref, index))
        includedRequests.sort(
            (left, right) =>
                (requestOrderIndex.get(left) ?? 0) - (requestOrderIndex.get(right) ?? 0)
        )

        const steps: ApiPlanStep[] = []
        const stepIdByRequestRef = new Map<string, string>()
        includedRequests.forEach((requestRef, index) => {
            stepIdByRequestRef.set(requestRef, `step_${index + 1}`)
        })

        for (const requestRef of includedRequests) {
            const request = this.getRequest(run, requestRef)
            const slotRefs = (analysis.slotsByRequestRef.get(requestRef) || []).map(
                (slot) => slot.ref
            )
            const prerequisiteStepIds = dedupeStrings(
                slotRefs
                    .map((slotRef) => analysis.bindingBySlotRef.get(slotRef))
                    .filter(
                        (
                            binding
                        ): binding is Extract<
                            BindingSeed,
                            { kind: 'derived_response' | 'derived_response_header' }
                        > =>
                            binding?.kind === 'derived_response' ||
                            binding?.kind === 'derived_response_header'
                    )
                    .map(
                        (binding) => stepIdByRequestRef.get(binding.producerRef) || ''
                    )
                    .filter(Boolean)
            )
            steps.push({
                id: stepIdByRequestRef.get(requestRef)!,
                requestRef,
                method: request.method,
                urlTemplate: request.urlTemplate,
                requestTemplate: buildExecutablePlanRequestTemplate(request),
                httpExecutable: isHttpExecutableRequest(request),
                prerequisiteStepIds,
                slotRefs,
            })
        }

        const slots = steps.flatMap(
            (step) => analysis.slotsByRequestRef.get(step.requestRef) || []
        )
        const callerInputs = buildCallerInputs(slots, analysis.bindingBySlotRef)
        const inputNameBySlotRef = new Map<string, string>()
        const inputNameByKey = new Map<string, string>()
        for (const input of callerInputs) {
            inputNameBySlotRef.set(input.slotRef, input.name)
            const slot = slots.find((candidate) => candidate.ref === input.slotRef)
            if (!slot) continue
            inputNameByKey.set(`${slot.name}:${slot.rawValue}`, input.name)
        }
        for (const slot of slots) {
            const binding = analysis.bindingBySlotRef.get(slot.ref)
            if (binding?.kind !== 'caller') continue
            const sharedName = inputNameByKey.get(`${slot.name}:${slot.rawValue}`)
            if (sharedName) {
                inputNameBySlotRef.set(slot.ref, sharedName)
            }
        }

        const bindings: ApiExecutionBinding[] = []
        for (const step of steps) {
            for (const slotRef of step.slotRefs) {
                const binding = analysis.bindingBySlotRef.get(slotRef)
                if (!binding) continue
                bindings.push(
                    buildExecutionBinding(
                        step.id,
                        slotRef,
                        binding,
                        inputNameBySlotRef,
                        stepIdByRequestRef
                    )
                )
            }
        }

        const executionMode = resolveExecutionMode(bindings)
        const ambiguousSlotRefs = slots
            .filter((slot) => slot.role === 'unknown' || slot.confidence < 0.55)
            .map((slot) => slot.ref)
        const sessionRequirements = dedupeStrings(
            bindings
                .map((binding) => describeSessionRequirement(binding))
                .filter((value): value is string => Boolean(value))
        )
        const confidence = clamp(
            slots.reduce((sum, slot) => sum + slot.confidence, 0) /
                Math.max(1, slots.length) -
                ambiguousSlotRefs.length * 0.05,
            0.2,
            0.99
        )

        return {
            ref: buildApiRef('plan', run.nextPlanId++),
            operation: slugifyOperationName(task),
            task,
            createdAt: Date.now(),
            targetRequestRef: target.ref,
            targetStepId: stepIdByRequestRef.get(target.ref)!,
            confidence,
            transport: 'http',
            executionMode,
            callerInputs,
            steps,
            slots,
            bindings,
            sessionRequirements,
            ambiguousSlotRefs,
            successOracle: {
                status: target.status,
                mime: target.responseMime,
                expectsDownload: Boolean(target.matchedDownloadRef),
            },
        }
    }

    private async executePlanStep(
        run: InternalRunState,
        plan: ApiPlanIr,
        step: ApiPlanStep,
        inputs: Record<string, string>,
        executed: Map<string, ExecutedStepState>
    ): Promise<ExecutedStepState & { error: string | null }> {
        const request = this.getRequest(run, step.requestRef)
        try {
            const resolved = await this.buildExecutableRequest(
                run,
                plan,
                step,
                request,
                inputs,
                executed
            )
            const executedStep =
                plan.executionMode === 'direct_http'
                    ? await executeDirectHttpStep(request.method, resolved)
                    : await this.executeBrowserStep(request.method, resolved)
            return {
                ...executedStep,
                error: null,
            }
        } catch (error) {
            return {
                status: null,
                mime: null,
                text: null,
                json: null,
                url: null,
                headers: {},
                error:
                    error instanceof Error
                        ? error.message
                        : 'HTTP execution failed.',
            }
        }
    }

    private async executeBrowserStep(
        method: string,
        resolved: {
            url: string
            headers: Record<string, string>
            body: string | null
            cookieHeader: string | null
        }
    ): Promise<ExecutedStepState> {
        const opensteer = this.requireOpensteer()
        await seedBrowserCookies(opensteer, resolved.url, resolved.cookieHeader)
        const response = await opensteer.page.evaluate(
            async ({ url, method, headers, body, includeCredentials }) => {
                const requestHeaders = new Headers()
                for (const [key, value] of Object.entries(headers)) {
                    try {
                        requestHeaders.set(key, value)
                    } catch {
                        // Ignore headers the browser refuses to set from script.
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
                includeCredentials: Boolean(resolved.cookieHeader),
            }
        )
        return readBrowserFetchResponse(response)
    }

    private async buildExecutableRequest(
        run: InternalRunState,
        plan: ApiPlanIr,
        step: ApiPlanStep,
        request: InternalRequestRecord,
        inputs: Record<string, string>,
        executed: Map<string, ExecutedStepState>
    ): Promise<{
        url: string
        headers: Record<string, string>
        body: string | null
        cookieHeader: string | null
    }> {
        const template = buildRequestTemplate(request)
        const slotMap = new Map(plan.slots.map((slot) => [slot.ref, slot]))
        const bindings = plan.bindings.filter((binding) => binding.stepId === step.id)
        for (const binding of bindings) {
            const slot = slotMap.get(binding.slotRef)
            if (!slot) continue
            const value = await this.resolveBindingValue(binding, slot, plan, inputs, executed)
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
        plan: ApiPlanIr,
        inputs: Record<string, string>,
        executed: Map<string, ExecutedStepState>
    ): Promise<unknown> {
        switch (binding.kind) {
            case 'caller':
                return inputs[binding.inputName] ?? slot.rawValue
            case 'constant':
                return binding.value
            case 'ambient_cookie':
                return slot.rawValue
            case 'derived_response': {
                const state = executed.get(binding.producerStepId)
                const value = getValueAtDataPath(state?.json, binding.responsePath)
                if (value == null) {
                    throw new Error(
                        `Unable to resolve derived response value at ${binding.responsePath} for ${binding.producerStepId}.`
                    )
                }
                return value
            }
            case 'derived_response_header': {
                const state = executed.get(binding.producerStepId)
                const value = state?.headers?.[binding.headerName.toLowerCase()] ?? null
                if (value == null) {
                    throw new Error(
                        `Unable to resolve derived response header ${binding.headerName} for ${binding.producerStepId}.`
                    )
                }
                return value
            }
            case 'session_cookie': {
                const opensteer = this.requireOpensteer()
                const cookies = await opensteer.context.cookies(opensteer.page.url())
                const cookie = cookies.find((candidate) => candidate.name === binding.cookieName)
                if (!cookie) {
                    throw new Error(`Cookie "${binding.cookieName}" is not available in the current browser session.`)
                }
                return cookie.value
            }
            case 'session_storage': {
                const opensteer = this.requireOpensteer()
                const value = await opensteer.page.evaluate(
                    ({ storageType, key }) =>
                        storageType === 'local'
                            ? window.localStorage.getItem(key)
                            : window.sessionStorage.getItem(key),
                    {
                        storageType: binding.storageType,
                        key: binding.key,
                    }
                )
                if (value == null) {
                    throw new Error(
                        `Storage key "${binding.key}" is not available in ${binding.storageType}Storage.`
                    )
                }
                return value
            }
            case 'dom_field': {
                const opensteer = this.requireOpensteer()
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
                    binding
                )
                if (value == null) {
                    throw new Error(`Unable to resolve DOM field value for ${slot.slotPath}.`)
                }
                return value
            }
            case 'inline_json': {
                const opensteer = this.requireOpensteer()
                const value = await opensteer.page.evaluate(
                    ({ source, dataPath }) => {
                        const [prefix, selector] = source.split(':', 2)
                        if (prefix !== 'inline' || !selector) return null
                        const node =
                            selector.startsWith('#')
                                ? document.querySelector(selector)
                                : document.querySelector('script')
                        if (!(node instanceof HTMLScriptElement)) return null
                        try {
                            const parsed = JSON.parse(node.textContent || '')
                            const tokens = dataPath
                                .split(/(?=\[)|\./)
                                .filter(Boolean)
                            let current: any = parsed
                            for (const token of tokens) {
                                if (token.startsWith('[')) {
                                    const index = Number.parseInt(token.slice(1, -1), 10)
                                    current = current?.[index]
                                } else {
                                    current = current?.[token]
                                }
                            }
                            return current == null ? null : String(current)
                        } catch {
                            return null
                        }
                    },
                    binding
                )
                if (value == null) {
                    throw new Error(`Unable to resolve inline JSON value for ${slot.slotPath}.`)
                }
                return value
            }
            case 'unknown':
                throw new Error(binding.reason)
        }
    }

    private buildProbeSlotComparisons(
        baselineRequest: InternalRequestRecord,
        request: InternalRequestRecord
    ): ApiProbeSlotComparison[] {
        const baselineValueByPath = new Map(
            extractRequestSlots(baselineRequest, 1).map((slot) => [
                slot.slotPath,
                slot.rawValue,
            ])
        )
        return extractRequestSlots(request, 1).map((slot) => {
            const baselineValue = baselineValueByPath.get(slot.slotPath)
            return {
                slotPath: slot.slotPath,
                values: dedupeStrings(
                    [baselineValue, slot.rawValue].filter(
                        (value): value is string => value != null
                    )
                ),
                changed: baselineValue != null && baselineValue !== slot.rawValue,
            }
        })
    }

    private async replayActionValue(
        actionFact: ApiActionFact,
        value: string
    ): Promise<void> {
        const opensteer = this.requireOpensteer()
        const args = {
            ...actionFact.args,
        }
        if (actionFact.command === 'input') {
            args.text = value
            await opensteer.input({
                description: asString(args.description) || undefined,
                selector: asString(args.selector) || undefined,
                element: asNumber(args.element) || undefined,
                text: value,
                clear: asBoolean(args.clear),
                pressEnter: asBoolean(args.pressEnter),
            })
            return
        }

        await opensteer.select({
            description: asString(args.description) || undefined,
            selector: asString(args.selector) || undefined,
            element: asNumber(args.element) || undefined,
            label: typeof args.label === 'string' ? args.label : undefined,
            value,
            index: asNumber(args.index) || undefined,
        })
    }

    private async flushArtifacts(run: InternalRunState): Promise<void> {
        const analysis = this.analyzeRun(run)
        await Promise.all([
            writeTextArtifact(
                path.join(run.dir, 'request-index.json'),
                JSON.stringify(
                    redactRecordStrings(
                        run.requestOrder
                            .map((ref) => getRequestByRef(run, ref))
                            .filter((request): request is InternalRequestRecord => Boolean(request)),
                        run.values
                    ),
                    null,
                    2
                ),
            ),
            writeTextArtifact(
                path.join(run.dir, 'action-spans.json'),
                JSON.stringify(redactRecordStrings(run.spans, run.values), null, 2),
            ),
            writeTextArtifact(
                path.join(run.dir, 'action-facts.json'),
                JSON.stringify(redactRecordStrings(run.actionFacts, run.values), null, 2),
            ),
            writeTextArtifact(
                path.join(run.dir, 'storage-events.json'),
                JSON.stringify(redactRecordStrings(run.storageEvents, run.values), null, 2),
            ),
            writeTextArtifact(
                path.join(run.dir, 'value-index.json'),
                JSON.stringify(redactRecordStrings(run.values.list(), run.values), null, 2),
            ),
            writeTextArtifact(
                path.join(run.dir, 'slot-index.json'),
                JSON.stringify(
                    redactRecordStrings(
                        [...analysis.slotsByRef.values()],
                        run.values
                    ),
                    null,
                    2
                ),
            ),
            writeTextArtifact(
                path.join(run.dir, 'slot-evidence.json'),
                JSON.stringify(
                    redactRecordStrings(
                        [...analysis.evidenceByRef.values()],
                        run.values
                    ),
                    null,
                    2
                ),
            ),
            writeTextArtifact(
                path.join(run.dir, 'candidates.json'),
                JSON.stringify(this.listRequests({ kind: 'candidates', limit: 50 }), null, 2),
            ),
            writeTextArtifact(
                path.join(run.dir, 'probes.json'),
                JSON.stringify(redactRecordStrings(run.probes, run.values), null, 2),
            ),
            writeTextArtifact(
                path.join(run.dir, 'provenance-graph.json'),
                JSON.stringify(
                    redactRecordStrings(
                        {
                            requests: run.requestOrder,
                            actions: run.actionFacts,
                            slots: [...analysis.slotsByRef.values()],
                            evidence: [...analysis.evidenceByRef.values()],
                            plans: run.plans,
                            validations: run.validations,
                            probes: run.probes,
                        },
                        run.values
                    ),
                    null,
                    2
                ),
            ),
            writeTextArtifact(
                path.join(run.dir, 'state.json'),
                JSON.stringify(serializeRunState(run), null, 2)
            ),
            this.writeManifest(run),
        ])
    }

    private async writeManifest(run: InternalRunState): Promise<void> {
        await writeTextArtifact(
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
                    actionFactCount: run.actionFacts.length,
                    planCount: run.plans.length,
                    probeCount: run.probes.length,
                    validationCount: run.validations.length,
                },
                null,
                2
            )
        )
    }

    private async writePlanArtifact(run: InternalRunState, plan: ApiPlanIr): Promise<void> {
        await writeTextArtifact(
            path.join(run.dir, 'plans', `${plan.ref.slice(1)}.json`),
            JSON.stringify(redactRecordStrings(plan, run.values), null, 2)
        )
    }

    private async writeValidationArtifact(
        run: InternalRunState,
        report: ApiValidationReport
    ): Promise<void> {
        await writeTextArtifact(
            path.join(run.dir, 'validations', `${report.ref.slice(1)}.json`),
            JSON.stringify(redactRecordStrings(report, run.values), null, 2)
        )
    }

    private collectSpanRequestRefs(run: InternalRunState, span: ApiActionSpan): string[] {
        return run.requestOrder.filter((ref) => {
            const request = getRequestByRef(run, ref)
            if (!request) return false
            if (request.startedAt < span.startedAt) return false
            if (span.endedAt && request.startedAt > span.endedAt + 2_000) return false
            return true
        })
    }

    private appendCaptureEvent(run: InternalRunState, event: Record<string, unknown>): void {
        run.captureStream?.write(JSON.stringify(event) + '\n')
    }
}

function serializeRunState(run: InternalRunState): PersistedRunState {
    return {
        ref: run.ref,
        id: run.id,
        startedAt: run.startedAt,
        active: run.active,
        requests: run.requestOrder
            .map((ref) => getRequestByRef(run, ref))
            .filter((request): request is InternalRequestRecord => Boolean(request)),
        requestOrder: [...run.requestOrder],
        spans: cloneStructured(run.spans),
        actionFacts: cloneStructured(run.actionFacts),
        storageEvents: cloneStructured(run.storageEvents),
        downloads: cloneStructured(run.downloads),
        values: cloneStructured(run.values.list()),
        plans: cloneStructured(run.plans),
        probes: cloneStructured(run.probes),
        validations: cloneStructured(run.validations),
        nextRequestId: run.nextRequestId,
        nextSpanId: run.nextSpanId,
        nextActionId: run.nextActionId,
        nextStorageEventId: run.nextStorageEventId,
        nextDownloadId: run.nextDownloadId,
        nextPlanId: run.nextPlanId,
        nextProbeId: run.nextProbeId,
        nextValidationId: run.nextValidationId,
        activeManualSpanRef: run.activeManualSpanRef,
    }
}

function loadLatestPersistedRun(
    scopeDir: string,
    logicalSession: string
): InternalRunState | null {
    const runsDirs = [
        path.join(scopeDir, '.opensteer', 'api', 'evidence', 'runs'),
        path.join(scopeDir, '.opensteer', 'api', 'runs'),
    ].filter((dir, index, values) => values.indexOf(dir) === index && existsSync(dir))
    if (!runsDirs.length) return null
    const candidates = runsDirs.flatMap((runsDir) =>
        readdirSync(runsDir)
        .map((entry) => {
            const dir = path.join(runsDir, entry)
            const manifestPath = path.join(dir, 'manifest.json')
            const statePath = path.join(dir, 'state.json')
            if (!existsSync(manifestPath) || !existsSync(statePath)) return null
            try {
                const manifest = safeJsonParse(readFileSync(manifestPath, 'utf8')) as
                    | Record<string, unknown>
                    | null
                if (!manifest || manifest.logicalSession !== logicalSession) return null
                return {
                    dir,
                    startedAt: Number(manifest.startedAt || 0),
                    statePath,
                }
            } catch {
                return null
            }
        })
        .filter((candidate): candidate is { dir: string; startedAt: number; statePath: string } =>
            Boolean(candidate)
        )
    )
        .sort((left, right) => right.startedAt - left.startedAt)
    const latest = candidates[0]
    if (!latest) return null
    try {
        const raw = safeJsonParse(readFileSync(latest.statePath, 'utf8')) as PersistedRunState | null
        if (!raw) return null
        return hydrateRunState(raw, latest.dir)
    } catch {
        return null
    }
}

function hydrateRunState(raw: PersistedRunState, dir: string): InternalRunState {
    const values = ApiValueRegistry.fromRecords(raw.values || [])
    const requestsById = new Map<string, InternalRequestRecord>()
    const requestsByRef = new Map<string, InternalRequestRecord>()
    for (const request of raw.requests || []) {
        requestsById.set(request.requestId, request)
        requestsByRef.set(request.ref, request)
    }
    return {
        ref: raw.ref,
        id: raw.id,
        dir,
        startedAt: raw.startedAt,
        active: false,
        session: null,
        captureStream: null,
        requestsById,
        requestsByRef,
        requestOrder: [...(raw.requestOrder || [])],
        spans: cloneStructured(raw.spans || []),
        actionFacts: cloneStructured(raw.actionFacts || []),
        storageEvents: cloneStructured(raw.storageEvents || []),
        downloads: cloneStructured(raw.downloads || []),
        values,
        plans: cloneStructured(raw.plans || []),
        probes: cloneStructured(raw.probes || []),
        validations: cloneStructured(raw.validations || []),
        nextRequestId: raw.nextRequestId || 1,
        nextSpanId: raw.nextSpanId || 1,
        nextActionId: raw.nextActionId || 1,
        nextStorageEventId: raw.nextStorageEventId || 1,
        nextDownloadId: raw.nextDownloadId || 1,
        nextPlanId: raw.nextPlanId || 1,
        nextProbeId: raw.nextProbeId || 1,
        nextValidationId: raw.nextValidationId || 1,
        activeManualSpanRef: raw.activeManualSpanRef || null,
    }
}

async function writeTextArtifact(file: string, content: string): Promise<void> {
    const tempFile = `${file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tempFile, content, 'utf8')
    await rename(tempFile, file)
}

function buildRunId(logicalSession: string, sequence: number, at: number): string {
    const iso = new Date(at).toISOString().replace(/[-:.]/g, '')
    return `${sanitizeName(logicalSession)}-${iso}-${sequence}`
}

function buildAutomaticSpanLabel(command: string, args: Record<string, unknown>): string {
    const detail = [
        typeof args.description === 'string' ? args.description : null,
        typeof args.url === 'string' ? args.url : null,
        typeof args.text === 'string' ? String(args.text).slice(0, 32) : null,
    ].find(Boolean)
    return detail ? `${command}:${detail}` : command
}

function sanitizeSerializableArgs(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {}
    }
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (
            typeof child === 'string' ||
            typeof child === 'number' ||
            typeof child === 'boolean' ||
            child == null
        ) {
            output[key] = child
            continue
        }
        if (Array.isArray(child)) {
            output[key] = child.filter(
                (entry) =>
                    typeof entry === 'string' ||
                    typeof entry === 'number' ||
                    typeof entry === 'boolean'
            )
            continue
        }
    }
    return output
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
    const directUrl = asString(initiator.url)
    if (directUrl) return directUrl
    const stack = asRecord(initiator.stack)
    const callFrames = Array.isArray(stack.callFrames) ? stack.callFrames : []
    for (const frame of callFrames) {
        const url = asString(asRecord(frame).url)
        if (url) return url
    }
    return null
}

function resolveInitiatorRequestRef(
    run: InternalRunState,
    initiator: Record<string, unknown>
): string | null {
    const requestId = asString(initiator.requestId)
    if (!requestId) return null
    return run.requestsById.get(requestId)?.ref || null
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
    const rawValue = truncated ? raw.slice(0, MAX_CAPTURED_BODY_BYTES) : raw
    const parsedBody = parseCapturedBody(rawValue, contentType)
    return {
        raw: rawValue,
        truncated,
        size,
        contentType: summarizeMime(contentType || null),
        ...(parsedBody.format ? { format: parsedBody.format } : {}),
        ...(parsedBody.parsedJson !== undefined
            ? { parsedJson: parsedBody.parsedJson }
            : {}),
        ...(parsedBody.parsedForm !== undefined
            ? { parsedForm: parsedBody.parsedForm }
            : {}),
        ...(typeof base64Encoded === 'boolean' ? { base64Encoded } : {}),
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
        format: record.format || null,
        preview,
        hasParsedJson: 'parsedJson' in record,
        hasParsedForm: 'parsedForm' in record,
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

function normalizeCookieNames(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const names = value
        .map((entry) => {
            const record = asRecord(entry)
            const cookie = asRecord(record.cookie)
            return asString(cookie.name)
        })
        .filter((name): name is string => Boolean(name))
    return dedupeStrings(names)
}

function normalizeBlockedCookieNames(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const names = value
        .map((entry) => {
            const record = asRecord(entry)
            const cookie = asRecord(record.cookie)
            return asString(cookie.name)
        })
        .filter((name): name is string => Boolean(name))
    return dedupeStrings(names)
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {}
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined
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
    return run.requestsByRef.get(ref) || null
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
    for (const request of run.requestsByRef.values()) {
        if (request.signature !== signature) continue
        count += 1
        if (count > 1) return true
    }
    return false
}

function extractRequestSlots(
    request: InternalRequestRecord,
    startIndex: number
): SlotSeed[] {
    const slots: SlotSeed[] = []
    let index = startIndex
    const url = new URL(request.url)
    const pathSegments = url.pathname.split('/').filter(Boolean)
    for (let pathIndex = 0; pathIndex < pathSegments.length; pathIndex += 1) {
        const value = pathSegments[pathIndex]
        slots.push({
            ref: buildApiRef('slot', index++),
            requestRef: request.ref,
            name: `path_${pathIndex + 1}`,
            slotPath: `path[${pathIndex}]`,
            source: 'path',
            rawValue: value,
            shape: inferValueShape(value),
            required: true,
        })
    }

    for (const [key, value] of url.searchParams.entries()) {
        slots.push({
            ref: buildApiRef('slot', index++),
            requestRef: request.ref,
            name: sanitizeName(key),
            slotPath: `query.${key}`,
            source: 'query',
            rawValue: value,
            shape: inferValueShape(value),
            required: true,
        })
    }

    const headers = {
        ...request.requestHeaders,
        ...request.requestExtraHeaders,
    }
    for (const [key, value] of Object.entries(headers)) {
        if (!TRACEABLE_HEADER_PATTERN.test(key)) continue
        if (!value.trim()) continue
        const source = /cookie/i.test(key) ? 'cookie' : 'header'
        if (source === 'cookie') {
            for (const [cookieName, cookieValue] of parseCookieHeader(value)) {
                slots.push({
                    ref: buildApiRef('slot', index++),
                    requestRef: request.ref,
                    name: sanitizeName(cookieName),
                    slotPath: `cookie.${cookieName}`,
                    source: 'cookie',
                    rawValue: cookieValue,
                    shape: inferValueShape(cookieValue),
                    required: true,
                })
            }
            continue
        }
        slots.push({
            ref: buildApiRef('slot', index++),
            requestRef: request.ref,
            name: sanitizeName(key),
            slotPath: `headers.${key}`,
            source: 'header',
            rawValue: value,
            shape: inferValueShape(value),
            required: true,
        })
    }

    for (const occurrence of collectBodyOccurrences(request.requestBody)) {
        slots.push({
            ref: buildApiRef('slot', index++),
            requestRef: request.ref,
            name: sanitizeName(occurrence.path),
            slotPath: `body.${occurrence.path}`,
            source: 'body',
            rawValue: occurrence.value,
            shape: inferValueShape(occurrence.value),
            required: true,
        })
    }

    return dedupeSlots(slots)
}

function collectBodyOccurrences(
    body: ApiRequestBodyRecord | ApiResponseBodyRecord | null
): Array<{ path: string; value: string }> {
    if (!body) return []
    if ('parsedJson' in body) {
        return collectScalarOccurrences(body.parsedJson)
    }
    if ('parsedForm' in body) {
        return collectScalarOccurrences(body.parsedForm)
    }
    return []
}

function collectScalarOccurrences(
    value: unknown,
    pathPrefix = ''
): Array<{ path: string; value: string }> {
    const output: Array<{ path: string; value: string }> = []
    if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            output.push(...collectScalarOccurrences(entry, `${pathPrefix}[${index}]`))
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

function dedupeSlots(slots: SlotSeed[]): SlotSeed[] {
    const seen = new Set<string>()
    const output: SlotSeed[] = []
    for (const slot of slots) {
        const key = `${slot.requestRef}:${slot.slotPath}:${slot.rawValue}`
        if (seen.has(key)) continue
        seen.add(key)
        output.push(slot)
    }
    return output
}

function collectStructuredOccurrences(request: InternalRequestRecord): StructuredOccurrence[] {
    const occurrences: StructuredOccurrence[] = []
    const url = new URL(request.url)
    const pathSegments = url.pathname.split('/').filter(Boolean)
    for (let index = 0; index < pathSegments.length; index += 1) {
        occurrences.push({
            requestRef: request.ref,
            source: 'request.path',
            location: `request.path[${index}]`,
            slotPath: `path[${index}]`,
            value: pathSegments[index],
            key: `path_${index + 1}`,
        })
    }
    for (const [key, value] of url.searchParams.entries()) {
        occurrences.push({
            requestRef: request.ref,
            source: 'request.query',
            location: `request.query:${key}`,
            slotPath: `query.${key}`,
            value,
            key,
        })
    }
    const headers = {
        ...request.requestHeaders,
        ...request.requestExtraHeaders,
    }
    for (const [key, value] of Object.entries(headers)) {
        if (!TRACEABLE_HEADER_PATTERN.test(key)) continue
        if (/cookie/i.test(key)) {
            for (const [cookieName, cookieValue] of parseCookieHeader(value)) {
                occurrences.push({
                    requestRef: request.ref,
                    source: 'request.header',
                    location: `request.header:cookie.${cookieName}`,
                    slotPath: `cookie.${cookieName}`,
                    value: cookieValue,
                    key: cookieName,
                })
            }
            continue
        }
        occurrences.push({
            requestRef: request.ref,
            source: 'request.header',
            location: `request.header:${key}`,
            slotPath: `headers.${key}`,
            value,
            key,
        })
    }
    for (const occurrence of collectBodyOccurrences(request.requestBody)) {
        occurrences.push({
            requestRef: request.ref,
            source: 'request.body',
            location: `request.body:${occurrence.path}`,
            slotPath: `body.${occurrence.path}`,
            value: occurrence.value,
            key: occurrence.path,
        })
    }
    for (const occurrence of collectBodyOccurrences(request.responseBody)) {
        occurrences.push({
            requestRef: request.ref,
            source: 'response.body',
            location: `response.body:${occurrence.path}`,
            slotPath: null,
            value: occurrence.value,
            key: occurrence.path,
        })
    }
    const responseHeaders = {
        ...request.responseHeaders,
        ...request.responseExtraHeaders,
    }
    for (const [key, value] of Object.entries(responseHeaders)) {
        if (key === 'set-cookie') {
            for (const [cookieName, cookieValue] of parseSetCookieHeader(value)) {
                occurrences.push({
                    requestRef: request.ref,
                    source: 'response.header',
                    location: `response.header:set-cookie.${cookieName}`,
                    slotPath: null,
                    value: cookieValue,
                    key: cookieName,
                })
            }
            continue
        }
        if (!value.trim()) continue
        occurrences.push({
            requestRef: request.ref,
            source: 'response.header',
            location: `response.header:${key}`,
            slotPath: null,
            value,
            key,
        })
    }
    return occurrences
}

function buildOccurrenceValueStats(
    requests: InternalRequestRecord[],
    occurrencesByRequestRef: Map<string, StructuredOccurrence[]>
): Map<string, OccurrenceValueStats> {
    const statsByValue = new Map<
        string,
        {
            occurrenceCount: number
            requestRefs: Set<string>
        }
    >()
    for (const request of requests) {
        const occurrences = collectStructuredOccurrences(request)
        occurrencesByRequestRef.set(request.ref, occurrences)
        for (const occurrence of occurrences) {
            const stats = statsByValue.get(occurrence.value) || {
                occurrenceCount: 0,
                requestRefs: new Set<string>(),
            }
            stats.occurrenceCount += 1
            stats.requestRefs.add(occurrence.requestRef)
            statsByValue.set(occurrence.value, stats)
        }
    }
    return new Map(
        [...statsByValue.entries()].map(([value, stats]) => [
            value,
            {
                occurrenceCount: stats.occurrenceCount,
                requestCount: stats.requestRefs.size,
            },
        ])
    )
}

function collectActionEvidence(seed: SlotSeed, action: ApiActionFact): EvidenceSeed[] {
    const output: EvidenceSeed[] = []
    const value = seed.rawValue
    const primaryValue = readActionPrimaryValue(action)
    const argText = readSerializableString(action.args.text)
    const argValue = readSerializableString(action.args.value)
    const argLabel = readSerializableString(action.args.label)
    const argTextTransform = matchComparableValue(argText, value)
    if (argTextTransform) {
        output.push({
            role: 'user_input',
            kind: 'action_argument',
            score: applyTransformPenalty(11, argTextTransform),
            sourceRef: action.ref,
            sourceLabel: action.command,
            sourceLocation: 'action.args.text',
            observedValue: argText || value,
            transformChain: argTextTransform,
            rationale: describeValueMatchRationale(
                `Value matched typed text for ${action.command}.`,
                argTextTransform
            ),
        })
    }
    const argValueTransform = matchComparableValue(argValue, value)
    const argLabelTransform = matchComparableValue(argLabel, value)
    if (argValueTransform || argLabelTransform) {
        output.push({
            role: 'user_input',
            kind: 'action_argument',
            score: applyTransformPenalty(10, argValueTransform || argLabelTransform || []),
            sourceRef: action.ref,
            sourceLabel: action.command,
            sourceLocation: argValueTransform ? 'action.args.value' : 'action.args.label',
            observedValue: argValueTransform ? argValue || value : argLabel || value,
            transformChain: argValueTransform || argLabelTransform || [],
            rationale: describeValueMatchRationale(
                `Value matched selected option for ${action.command}.`,
                argValueTransform || argLabelTransform || []
            ),
        })
    }

    const target = action.target
    const targetValueTransform = matchComparableValue(target?.afterValue || null, value)
    if (targetValueTransform && target && slotMatchesActionTarget(seed, action, target)) {
        output.push({
            role:
                action.command === 'input' || action.command === 'select'
                    ? 'user_input'
                    : isSessionLikeKey(target.attributes.name)
                      ? 'session'
                      : 'derived',
            kind: 'action_target',
            score: applyTransformPenalty(
                action.command === 'input' || action.command === 'select' ? 10 : 7,
                targetValueTransform
            ),
            sourceRef: action.ref,
            sourceLabel: action.command,
            sourceLocation: 'target.afterValue',
            observedValue: target.afterValue || value,
            transformChain: targetValueTransform,
            rationale: describeValueMatchRationale(
                'Value matched the action target field value.',
                targetValueTransform
            ),
        })
    }
    const choiceValue = target
        ? collectActionChoiceValues(action, target).find((candidate) =>
              Boolean(matchComparableValue(candidate, value))
          )
        : null
    const choiceTransform = choiceValue ? matchComparableValue(choiceValue, value) : null
    if (target && choiceValue && choiceTransform && slotMatchesActionTarget(seed, action, target)) {
        output.push({
            role: 'user_input',
            kind: 'action_choice',
            score: applyTransformPenalty(action.command === 'click' ? 10 : 9, choiceTransform),
            sourceRef: action.ref,
            sourceLabel: action.command,
            sourceLocation: 'target.choice',
            observedValue: choiceValue,
            transformChain: choiceTransform,
            rationale: describeValueMatchRationale(
                'Value matched a structured choice carried by the triggering action target.',
                choiceTransform
            ),
        })
    }

    const afterFieldMap = buildDomFieldMap(action.afterDom?.fields || [])
    for (const field of afterFieldMap.values()) {
        if (field.hidden) continue
        const fieldValueTransform = matchComparableValue(field.value, value)
        if (!fieldValueTransform) continue
        if (!slotMatchesDomField(seed, action, field)) continue
        const beforeField = getMatchingDomField(action.beforeDom?.fields || [], field)
        const beforeFieldTransform = matchComparableValue(beforeField?.value || null, value)
        const changed =
            fieldValueTransform.join('|') !== (beforeFieldTransform || []).join('|') ||
            beforeField?.value !== field.value
        if (!isCausalVisibleDomField(action, field, value, changed, primaryValue)) {
            continue
        }
        output.push({
            role: 'user_input',
            kind: 'dom_field',
            score: applyTransformPenalty(changed ? 8 : 7, fieldValueTransform),
            sourceRef: action.ref,
            sourceLabel: action.afterDom?.url || action.command,
            sourceLocation: buildDomFieldLocation(field),
            observedValue: field.value || value,
            transformChain: fieldValueTransform,
            rationale: describeValueMatchRationale(
                changed
                    ? 'Value matched a visible field that changed on the action target during the triggering interaction.'
                    : 'Value matched the visible action target field after the triggering interaction.',
                fieldValueTransform
            ),
        })
    }

    const hiddenFieldSnapshots = [action.afterDom, action.beforeDom]
    const hiddenSeen = new Set<string>()
    for (const snapshot of hiddenFieldSnapshots) {
        if (!snapshot) continue
        for (const field of snapshot.fields) {
            if (!field.hidden) continue
            const fieldValueTransform = matchComparableValue(field.value, value)
            if (!fieldValueTransform) continue
            if (!slotMatchesDomField(seed, action, field)) {
                continue
            }
            const fieldKey = buildDomFieldIdentity(field)
            if (hiddenSeen.has(fieldKey)) continue
            hiddenSeen.add(fieldKey)
            output.push({
                role: isSessionLikeKey(field.name) ? 'session' : 'derived',
                kind: 'hidden_input',
                score: applyTransformPenalty(isSessionLikeKey(field.name) ? 8 : 7, fieldValueTransform),
                sourceRef: action.ref,
                sourceLabel: snapshot.url,
                sourceLocation: buildDomFieldLocation(field),
                observedValue: field.value || value,
                transformChain: fieldValueTransform,
                rationale: describeValueMatchRationale(
                    'Value matched a hidden DOM field present around the triggering action.',
                    fieldValueTransform
                ),
            })
        }
    }

    for (const snapshot of [action.afterDom, action.beforeDom]) {
        if (!snapshot) continue
        for (const inlineValue of snapshot.inlineValues) {
            if (inlineValue.value !== value) continue
            output.push({
                role: 'constant',
                kind: 'inline_json',
                score: 6,
                sourceRef: action.ref,
                sourceLabel: inlineValue.source,
                sourceLocation: inlineValue.path,
                observedValue: value,
                transformChain: [],
                rationale: 'Value matched inline bootstrap JSON on the page.',
            })
        }
    }

    return output
}

function collectSpanStateEvidence(
    seed: SlotSeed,
    span: ApiActionSpan,
    valueStats: OccurrenceValueStats | null
): EvidenceSeed[] {
    const output: EvidenceSeed[] = []
    const value = seed.rawValue
    const snapshots = [span.before, span.after]
    for (const snapshot of snapshots) {
        if (!snapshot) continue
        for (const [name, cookieValue] of Object.entries(snapshot.cookies)) {
            if (cookieValue !== value) continue
            if (!shouldTreatAmbientStateMatchAsSession(seed, name, valueStats)) {
                continue
            }
            output.push({
                role: 'session',
                kind: 'cookie',
                score: 8,
                sourceRef: span.ref,
                sourceLabel: name,
                sourceLocation: `cookie.${name}`,
                observedValue: value,
                transformChain: [],
                rationale: `Value matched cookie "${name}" in browser state.`,
            })
        }
        for (const [key, storageValue] of Object.entries(snapshot.storage.localStorage)) {
            if (storageValue !== value) continue
            if (!shouldTreatAmbientStateMatchAsSession(seed, key, valueStats)) {
                continue
            }
            output.push({
                role: 'session',
                kind: 'storage',
                score: 8,
                sourceRef: span.ref,
                sourceLabel: key,
                sourceLocation: `local.${key}`,
                observedValue: value,
                transformChain: [],
                rationale: `Value matched localStorage key "${key}".`,
            })
        }
        for (const [key, storageValue] of Object.entries(snapshot.storage.sessionStorage)) {
            if (storageValue !== value) continue
            if (!shouldTreatAmbientStateMatchAsSession(seed, key, valueStats)) {
                continue
            }
            output.push({
                role: 'session',
                kind: 'storage',
                score: 8,
                sourceRef: span.ref,
                sourceLabel: key,
                sourceLocation: `session.${key}`,
                observedValue: value,
                transformChain: [],
                rationale: `Value matched sessionStorage key "${key}".`,
            })
        }
    }
    return output
}

function shouldTreatAmbientStateMatchAsSession(
    seed: SlotSeed,
    sessionKey: string,
    valueStats: OccurrenceValueStats | null
): boolean {
    if (isSessionCarrierSeed(seed)) {
        return true
    }
    if (slotMatchesSemanticLabels(seed, [sessionKey])) {
        return true
    }
    return isDistinctiveProvenanceValue(seed.rawValue, seed.shape, valueStats)
}

function dedupeEvidenceSeeds(evidence: EvidenceSeed[]): EvidenceSeed[] {
    const seen = new Set<string>()
    const output: EvidenceSeed[] = []
    for (const item of evidence) {
        const key = `${item.kind}:${item.role}:${item.sourceRef || ''}:${item.sourceLocation || ''}:${item.observedValue}`
        if (seen.has(key)) continue
        seen.add(key)
        output.push(item)
    }
    return output.sort((left, right) => right.score - left.score)
}

function hasStrongCallerEvidence(evidence: EvidenceSeed[]): boolean {
    return evidence.some(
        (item) =>
            item.kind === 'action_argument' ||
            item.kind === 'action_choice' ||
            item.kind === 'probe_changed' ||
            (item.kind === 'action_target' && item.role === 'user_input')
    )
}

function isSessionCarrierSeed(seed: SlotSeed): boolean {
    return seed.source === 'cookie' || (seed.source === 'header' && isSessionLikeKey(seed.name))
}

function classifySlotRole(
    seed: SlotSeed,
    evidence: EvidenceSeed[]
): {
    role: ApiSlotRole
    confidence: number
} {
    const scores = new Map<ApiSlotRole, number>([
        ['user_input', 0],
        ['derived', 0],
        ['constant', 0],
        ['session', 0],
        ['unknown', 0],
    ])
    const hasCallerEvidence = hasStrongCallerEvidence(evidence)
    const sessionCarrier = isSessionCarrierSeed(seed)
    if (seed.source === 'cookie' && !hasCallerEvidence) {
        return {
            role: 'session',
            confidence: 0.94,
        }
    }
    if (sessionCarrier && !hasCallerEvidence) {
        scores.set('session', (scores.get('session') || 0) + 10)
    }
    for (const item of evidence) {
        scores.set(item.role, (scores.get(item.role) || 0) + item.score)
    }

    if (hasCallerEvidence) {
        return {
            role: 'user_input',
            confidence: 0.92,
        }
    }

    let role: ApiSlotRole = 'unknown'
    let score = -1
    for (const candidate of ['user_input', 'derived', 'session', 'constant', 'unknown'] as const) {
        const next = scores.get(candidate) || 0
        if (next > score) {
            score = next
            role = candidate
        }
    }

    if (role === 'unknown' && sessionCarrier) {
        role = 'session'
    }

    return {
        role,
        confidence: clamp(0.2 + score / 15, 0.2, 0.99),
    }
}

function analyzeResponseBodyOccurrence(
    seed: SlotSeed,
    occurrence: StructuredOccurrence,
    valueStats: OccurrenceValueStats | null
): {
    score: number
    rationale: string
} | null {
    const distinctive = isDistinctiveProvenanceValue(
        seed.rawValue,
        seed.shape,
        valueStats
    )
    if (!distinctive) {
        return null
    }
    const semanticMatch = slotMatchesOccurrence(seed, occurrence)
    if (semanticMatch) {
        return {
            score: 10,
            rationale: `Value matched prior response scalar at ${occurrence.location} with aligned slot semantics.`,
        }
    }
    if (isSessionCarrierSeed(seed)) {
        return null
    }
    return {
        score: 7,
        rationale: `Value matched a distinctive prior response scalar at ${occurrence.location}.`,
    }
}

function analyzeResponseHeaderOccurrence(
    seed: SlotSeed,
    occurrence: StructuredOccurrence
): {
    role: ApiSlotRole
    score: number
    rationale: string
} | null {
    const semanticMatch = slotMatchesOccurrence(seed, occurrence)
    const cookieName = readCookieNameFromSlotPath(seed.slotPath)
    const sessionCarrier = isSessionCarrierSeed(seed)
    const cookieMatch =
        seed.source === 'cookie' && cookieName != null && cookieName === occurrence.key
    const sessionMatch =
        sessionCarrier && (cookieMatch || isSessionLikeKey(occurrence.key) || semanticMatch)
    if (sessionMatch) {
        return {
            role: 'session',
            score: 8,
            rationale: `Value matched prior response header at ${occurrence.location} for a session carrier.`,
        }
    }
    if (
        isLowInformationHttpHeader(occurrence.key) ||
        (seed.source === 'header' && isLowInformationHttpHeader(seed.name))
    ) {
        return null
    }
    if (semanticMatch) {
        return {
            role: 'derived',
            score: 8,
            rationale: `Value matched prior response header at ${occurrence.location} with aligned slot semantics.`,
        }
    }
    return null
}

function shouldLinkUpstreamSlot(
    seed: SlotSeed,
    producerSeed: SlotSeed,
    producerRole: ApiSlotRole
): boolean {
    const seedIsSessionCarrier = isSessionCarrierSeed(seed)
    const producerIsSessionCarrier = isSessionCarrierSeed(producerSeed)
    if (producerRole === 'constant' || producerRole === 'unknown') {
        return false
    }
    if (seed.slotPath === producerSeed.slotPath) {
        return true
    }
    if (
        seed.source !== producerSeed.source &&
        seedIsSessionCarrier !== producerIsSessionCarrier
    ) {
        return false
    }
    return slotSeedsSemanticallyAlign(seed, producerSeed)
}

function resolveBindingSeed(
    seed: SlotSeed,
    role: ApiSlotRole,
    evidence: EvidenceSeed[]
): BindingSeed {
    const best = evidence[0]
    const transforms = pickBindingTransforms(evidence)
    let binding: BindingSeed
    if (role === 'user_input') {
        binding = { kind: 'caller', transforms }
    } else if (role === 'constant') {
        binding = {
            kind: 'constant',
            value: seed.rawValue,
            transforms,
        }
    } else if (role === 'derived') {
        const responseEvidence = evidence.find(
            (item) =>
                item.kind === 'response_value' &&
                item.sourceRef &&
                item.sourceLocation?.startsWith('response.body:')
        )
        if (responseEvidence && responseEvidence.sourceRef && responseEvidence.sourceLocation) {
            binding = {
                kind: 'derived_response',
                producerRef: responseEvidence.sourceRef,
                responsePath: responseEvidence.sourceLocation.replace('response.body:', ''),
                transforms: responseEvidence.transformChain,
            }
        } else {
            const responseHeaderEvidence = evidence.find(
                (item) =>
                    item.kind === 'response_header' &&
                    item.sourceRef &&
                    item.sourceLocation?.startsWith('response.header:')
            )
            if (
                responseHeaderEvidence &&
                responseHeaderEvidence.sourceRef &&
                responseHeaderEvidence.sourceLocation
            ) {
                binding = {
                    kind: 'derived_response_header',
                    producerRef: responseHeaderEvidence.sourceRef,
                    headerName: responseHeaderEvidence.sourceLocation.replace(
                        'response.header:',
                        ''
                    ),
                    transforms: responseHeaderEvidence.transformChain,
                }
            } else {
                const domEvidence = evidence.find(
                    (item) => item.kind === 'hidden_input' || item.kind === 'dom_field'
                )
                if (domEvidence) {
                    const match = parseDomFieldLocation(domEvidence.sourceLocation)
                    binding = {
                        kind: 'dom_field',
                        fieldName: match?.name || null,
                        fieldId: match?.id || null,
                        fieldType: match?.type || null,
                        hidden: domEvidence.kind === 'hidden_input',
                        transforms: domEvidence.transformChain,
                    }
                } else {
                    const inlineEvidence = evidence.find((item) => item.kind === 'inline_json')
                    if (inlineEvidence && inlineEvidence.sourceLabel && inlineEvidence.sourceLocation) {
                        binding = {
                            kind: 'inline_json',
                            source: inlineEvidence.sourceLabel,
                            dataPath: inlineEvidence.sourceLocation,
                            transforms: inlineEvidence.transformChain,
                        }
                    } else {
                        binding = {
                            kind: 'unknown',
                            reason: best?.rationale || `No executable binding for ${seed.slotPath}.`,
                            transforms,
                        }
                    }
                }
            }
        }
    } else if (role === 'session') {
        if (seed.source === 'cookie') {
            binding = {
                kind: 'ambient_cookie',
                cookieName: readCookieNameFromSlotPath(seed.slotPath) || seed.rawValue,
                transforms,
            }
        } else {
            const storageEvidence = evidence.find(
                (item) => item.kind === 'storage' || item.kind === 'storage_event'
            )
            if (storageEvidence?.sourceLocation) {
                const [storageType, key] = storageEvidence.sourceLocation.split('.', 2)
                if (key && (storageType === 'local' || storageType === 'session')) {
                    binding = {
                        kind: 'session_storage',
                        storageType,
                        key,
                        transforms: storageEvidence.transformChain,
                    }
                } else {
                    binding = {
                        kind: 'unknown',
                        reason: best?.rationale || `No executable binding for ${seed.slotPath}.`,
                        transforms,
                    }
                }
            } else {
                const domEvidence = evidence.find((item) => item.kind === 'hidden_input')
                if (domEvidence) {
                    const match = parseDomFieldLocation(domEvidence.sourceLocation)
                    binding = {
                        kind: 'dom_field',
                        fieldName: match?.name || null,
                        fieldId: match?.id || null,
                        fieldType: match?.type || null,
                        hidden: true,
                        transforms: domEvidence.transformChain,
                    }
                } else {
                    binding = {
                        kind: 'unknown',
                        reason: best?.rationale || `No executable binding for ${seed.slotPath}.`,
                        transforms,
                    }
                }
            }
        }
    } else {
        binding = {
            kind: 'unknown',
            reason: best?.rationale || `No executable binding for ${seed.slotPath}.`,
            transforms,
        }
    }
    return {
        ...binding,
        resolverCandidates: collectResolverCandidates(seed, binding, evidence),
    }
}

function pickBindingTransforms(evidence: EvidenceSeed[]): string[] {
    for (const item of evidence) {
        if (item.transformChain.length) {
            return [...item.transformChain]
        }
    }
    return []
}

function collectResolverCandidates(
    seed: SlotSeed,
    binding: BindingSeed,
    evidence: EvidenceSeed[]
): ApiBindingResolver[] {
    const candidates: ApiBindingResolver[] = []
    if (binding.kind !== 'caller') {
        candidates.push({
            kind: 'constant',
            value: seed.rawValue,
        })
    }

    const responseBodyEvidence = evidence.find(
        (item) =>
            item.kind === 'response_value' &&
            item.sourceRef &&
            item.sourceLocation?.startsWith('response.body:')
    )
    if (responseBodyEvidence?.sourceRef && responseBodyEvidence.sourceLocation) {
        candidates.push({
            kind: 'response_json',
            producerStepId: responseBodyEvidence.sourceRef,
            producerRef: responseBodyEvidence.sourceRef,
            responsePath: responseBodyEvidence.sourceLocation.replace('response.body:', ''),
        })
    }

    const responseHeaderEvidence = evidence.find(
        (item) =>
            item.kind === 'response_header' &&
            item.sourceRef &&
            item.sourceLocation?.startsWith('response.header:')
    )
    if (responseHeaderEvidence?.sourceRef && responseHeaderEvidence.sourceLocation) {
        candidates.push({
            kind: 'response_header',
            producerStepId: responseHeaderEvidence.sourceRef,
            producerRef: responseHeaderEvidence.sourceRef,
            headerName: responseHeaderEvidence.sourceLocation.replace('response.header:', ''),
        })
    }

    const cookieName = readCookieNameFromSlotPath(seed.slotPath)
    if (cookieName) {
        candidates.push({
            kind: 'cookie_live',
            cookieName,
        })
    }

    const storageEvidence = evidence.find(
        (item) => item.kind === 'storage' || item.kind === 'storage_event'
    )
    if (storageEvidence?.sourceLocation) {
        const [storageType, key] = storageEvidence.sourceLocation.split('.', 2)
        if (key && (storageType === 'local' || storageType === 'session')) {
            candidates.push({
                kind: 'storage_live',
                storageType,
                key,
            })
        }
    }

    const domEvidence = evidence.find(
        (item) => item.kind === 'hidden_input' || item.kind === 'dom_field'
    )
    if (domEvidence) {
        const match = parseDomFieldLocation(domEvidence.sourceLocation)
        candidates.push({
            kind: 'dom_field',
            fieldName: match?.name || null,
            fieldId: match?.id || null,
            fieldType: match?.type || null,
            hidden: domEvidence.kind === 'hidden_input',
        })
    }

    const inlineEvidence = evidence.find((item) => item.kind === 'inline_json')
    if (inlineEvidence?.sourceLabel && inlineEvidence.sourceLocation) {
        candidates.push({
            kind: 'script_json',
            source: inlineEvidence.sourceLabel,
            dataPath: inlineEvidence.sourceLocation,
        })
    }

    candidates.push(bindingSeedToResolver(binding, seed.rawValue))
    return candidates
}

function bindingSeedToResolver(binding: BindingSeed, slotRawValue: string): ApiBindingResolver {
    switch (binding.kind) {
        case 'caller':
            return {
                kind: 'input',
                inputName: sanitizeName(slotRawValue || 'input'),
            }
        case 'constant':
            return {
                kind: 'constant',
                value: binding.value,
            }
        case 'derived_response':
            return {
                kind: 'response_json',
                producerStepId: binding.producerRef,
                producerRef: binding.producerRef,
                responsePath: binding.responsePath,
            }
        case 'derived_response_header':
            return {
                kind: 'response_header',
                producerStepId: binding.producerRef,
                producerRef: binding.producerRef,
                headerName: binding.headerName,
            }
        case 'ambient_cookie':
            return {
                kind: 'cookie_captured',
                cookieName: binding.cookieName,
                capturedValue: slotRawValue,
            }
        case 'session_cookie':
            return {
                kind: 'cookie_live',
                cookieName: binding.cookieName,
            }
        case 'session_storage':
            return {
                kind: 'storage_live',
                storageType: binding.storageType,
                key: binding.key,
            }
        case 'dom_field':
            return {
                kind: 'dom_field',
                fieldName: binding.fieldName,
                fieldId: binding.fieldId,
                fieldType: binding.fieldType,
                hidden: binding.hidden,
            }
        case 'inline_json':
            return {
                kind: 'script_json',
                source: binding.source,
                dataPath: binding.dataPath,
            }
        case 'unknown':
            return {
                kind: 'unsupported',
                reason: binding.reason,
            }
    }
}

function buildFamilyValueIndex(
    requests: InternalRequestRecord[],
    slotSeedsByRequestRef: Map<string, SlotSeed[]>
): Map<string, Set<string>> {
    const output = new Map<string, Set<string>>()
    for (const request of requests) {
        for (const slot of slotSeedsByRequestRef.get(request.ref) || []) {
            const key = `${request.method}:${request.urlTemplate}:${slot.slotPath}`
            const values = output.get(key) || new Set<string>()
            values.add(slot.rawValue)
            output.set(key, values)
        }
    }
    return output
}

function buildProbeIndex(
    probes: ApiProbeRun[],
    requests: InternalRequestRecord[],
    slotSeedsByRequestRef: Map<string, SlotSeed[]>
): Map<string, Map<string, string[]>> {
    const requestByRef = new Map(requests.map((request) => [request.ref, request]))
    const output = new Map<string, Map<string, string[]>>()
    for (const probe of probes) {
        for (const variant of probe.variants) {
            if (!variant.requestRef) continue
            const request = requestByRef.get(variant.requestRef)
            if (!request) continue
            const requestMap = output.get(request.signature) || new Map<string, string[]>()
            for (const slot of slotSeedsByRequestRef.get(request.ref) || []) {
                const values = requestMap.get(slot.slotPath) || []
                values.push(slot.rawValue)
                requestMap.set(slot.slotPath, values)
            }
            output.set(request.signature, requestMap)
        }
    }
    return output
}

function buildCallerInputs(
    slots: ApiRequestSlot[],
    bindings: Map<string, BindingSeed>
): ApiPlanInput[] {
    const output: ApiPlanInput[] = []
    const seen = new Map<string, ApiPlanInput>()
    let nextId = 1
    for (const slot of slots) {
        const binding = bindings.get(slot.ref)
        if (binding?.kind !== 'caller') continue
        const key = `${slot.name}:${slot.rawValue}`
        const existing = seen.get(key)
        if (existing) {
            continue
        }
        const entry: ApiPlanInput = {
            ref: `@input${nextId++}`,
            name: pickCallerInputName(slot, output.map((item) => item.name)),
            slotRef: slot.ref,
            slotPath: slot.slotPath,
            role: slot.role,
            required: slot.required,
            defaultValue: slot.rawValue,
            evidenceRefs: slot.evidenceRefs,
            sourceLocation: slot.slotPath,
        }
        seen.set(key, entry)
        output.push(entry)
    }
    return output
}

function pickCallerInputName(slot: ApiRequestSlot, existing: string[]): string {
    const base = sanitizeName(slot.name || slot.slotPath)
    if (!existing.includes(base)) return base
    let index = 2
    while (existing.includes(`${base}_${index}`)) {
        index += 1
    }
    return `${base}_${index}`
}

function buildExecutionBinding(
    stepId: string,
    slotRef: string,
    binding: BindingSeed,
    inputNameBySlotRef: Map<string, string>,
    stepIdByRequestRef: Map<string, string>
): ApiExecutionBinding {
    const resolverCandidates = mapResolverCandidates(
        binding.resolverCandidates,
        stepIdByRequestRef
    )
    switch (binding.kind) {
        case 'caller':
            return {
                kind: 'caller',
                slotRef,
                stepId,
                inputName: inputNameBySlotRef.get(slotRef) || sanitizeName(slotRef),
                resolverCandidates,
                transforms: normalizeBindingTransforms(binding.transforms),
            }
        case 'constant':
            return {
                kind: 'constant',
                slotRef,
                stepId,
                value: binding.value,
                resolverCandidates,
                transforms: normalizeBindingTransforms(binding.transforms),
            }
        case 'derived_response':
            return {
                kind: 'derived_response',
                slotRef,
                stepId,
                producerStepId: stepIdByRequestRef.get(binding.producerRef) || 'step_0',
                producerRef: binding.producerRef,
                responsePath: binding.responsePath,
                resolverCandidates,
                transforms: normalizeBindingTransforms(binding.transforms),
            }
        case 'derived_response_header':
            return {
                kind: 'derived_response_header',
                slotRef,
                stepId,
                producerStepId: stepIdByRequestRef.get(binding.producerRef) || 'step_0',
                producerRef: binding.producerRef,
                headerName: binding.headerName,
                resolverCandidates,
                transforms: normalizeBindingTransforms(binding.transforms),
            }
        case 'ambient_cookie':
            return {
                kind: 'ambient_cookie',
                slotRef,
                stepId,
                cookieName: binding.cookieName,
                resolverCandidates,
                transforms: normalizeBindingTransforms(binding.transforms),
            }
        case 'session_cookie':
            return {
                kind: 'session_cookie',
                slotRef,
                stepId,
                cookieName: binding.cookieName,
                resolverCandidates,
                transforms: normalizeBindingTransforms(binding.transforms),
            }
        case 'session_storage':
            return {
                kind: 'session_storage',
                slotRef,
                stepId,
                storageType: binding.storageType,
                key: binding.key,
                resolverCandidates,
                transforms: normalizeBindingTransforms(binding.transforms),
            }
        case 'dom_field':
            return {
                kind: 'dom_field',
                slotRef,
                stepId,
                fieldName: binding.fieldName,
                fieldId: binding.fieldId,
                fieldType: binding.fieldType,
                hidden: binding.hidden,
                resolverCandidates,
                transforms: normalizeBindingTransforms(binding.transforms),
            }
        case 'inline_json':
            return {
                kind: 'inline_json',
                slotRef,
                stepId,
                source: binding.source,
                dataPath: binding.dataPath,
                resolverCandidates,
                transforms: normalizeBindingTransforms(binding.transforms),
            }
        case 'unknown':
            return {
                kind: 'unknown',
                slotRef,
                stepId,
                reason: binding.reason,
                resolverCandidates,
                transforms: normalizeBindingTransforms(binding.transforms),
            }
    }
}

function resolveExecutionMode(bindings: ApiExecutionBinding[]): ApiPlanExecutionMode {
    if (bindings.some((binding) => getResolverCapability(getExecutionBindingResolver(binding, '')) === 'browser_page')) {
        return 'browser_dom'
    }
    if (bindings.some((binding) => getResolverCapability(getExecutionBindingResolver(binding, '')) === 'browser_fetch')) {
        return 'browser_session'
    }
    return 'direct_http'
}

function describeSessionRequirement(binding: ApiExecutionBinding): string | null {
    const resolver = getExecutionBindingResolver(binding, '')
    switch (resolver.kind) {
        case 'computed':
            return describeSessionRequirement({
                ...binding,
                resolver: resolver.source,
            })
        case 'cookie_live':
            return `cookie:${resolver.cookieName}`
        case 'storage_live':
            return `${resolver.storageType}Storage:${resolver.key}`
        case 'dom_field':
            return `dom:${resolver.fieldName || resolver.fieldId || resolver.fieldType || 'field'}`
        case 'script_json':
            return `inline:${resolver.source}:${resolver.dataPath}`
        case 'unsupported':
            return `unknown:${resolver.reason}`
        default:
            return null
    }
}

function mapResolverCandidates(
    candidates: ApiBindingResolver[] | undefined,
    stepIdByRequestRef: Map<string, string>
): ApiBindingResolver[] | undefined {
    if (!candidates?.length) {
        return undefined
    }
    return candidates.map((candidate) =>
        mapResolverCandidate(candidate, stepIdByRequestRef)
    )
}

function mapResolverCandidate(
    resolver: ApiBindingResolver,
    stepIdByRequestRef: Map<string, string>
): ApiBindingResolver {
    if (resolver.kind === 'computed') {
        const source = mapResolverCandidate(resolver.source, stepIdByRequestRef)
        return {
            ...resolver,
            source: source.kind === 'computed' ? source.source : source,
        }
    }
    if (resolver.kind === 'response_json' || resolver.kind === 'response_header') {
        return {
            ...resolver,
            producerStepId:
                stepIdByRequestRef.get(resolver.producerRef) || resolver.producerStepId,
        }
    }
    return resolver
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

function buildRequestTemplate(request: InternalRequestRecord): RequestTemplateState {
    const headers = {
        ...request.requestHeaders,
        ...request.requestExtraHeaders,
    }
    const cookies = headers.cookie
        ? Object.fromEntries(parseCookieHeader(headers.cookie))
        : {}
    delete headers.cookie
    return {
        url: new URL(request.url),
        headers,
        cookies,
        bodyFormat: request.requestBody?.format || 'text',
        bodyJson: cloneStructured(request.requestBody?.parsedJson),
        bodyForm: request.requestBody?.parsedForm
            ? buildUrlSearchParamsFromRecord(request.requestBody.parsedForm)
            : null,
        bodyRaw: request.requestBody?.raw || null,
        rawJsonPlaceholders: new Map(),
    }
}

function buildExecutablePlanRequestTemplate(request: InternalRequestRecord) {
    const headers = {
        ...request.requestHeaders,
        ...request.requestExtraHeaders,
    }
    delete headers.cookie
    return {
        url: request.url,
        headers,
        bodyFormat: request.requestBody?.format || 'text',
        bodyJson: cloneStructured(request.requestBody?.parsedJson),
        bodyForm: request.requestBody?.parsedForm
            ? cloneStructured(request.requestBody.parsedForm)
            : undefined,
        bodyRaw: request.requestBody?.raw || null,
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
            template.cookies[key] = textValue
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
                Boolean(options?.allowRawJsonPlaceholders)
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

function serializeCookieHeaderValue(template: RequestTemplateState): string | null {
    const entries = Object.entries(template.cookies)
    if (!entries.length) return null
    return entries.map(([key, value]) => `${key}=${value}`).join('; ')
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

function cloneStructured<T>(value: T): T {
    if (value == null) return value
    return JSON.parse(JSON.stringify(value)) as T
}

function sanitizeExecutionHeaderObject(
    headers: Record<string, string>
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).filter(
            ([key]) =>
                !key.startsWith(':') &&
                !HTTP_EXECUTION_HEADER_BLOCKLIST.has(key.toLowerCase())
        )
    )
}

function sanitizeBrowserFetchHeaderObject(
    headers: Record<string, string>
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).filter(([key]) => isBrowserFetchHeaderAllowed(key))
    )
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

async function readApiResponse(response: APIResponse): Promise<ExecutedStepState> {
    const text = await response.text()
    const headers = normalizeHeaderRecord(response.headers())
    const mime = summarizeMime(headers['content-type'])
    return {
        status: response.status(),
        mime,
        text,
        json: mime === 'application/json' ? safeJsonParse(text) : null,
        url: response.url(),
        headers,
    }
}

function readBrowserFetchResponse(response: {
    status: number
    headers: Record<string, string>
    text: string
    url: string
}): ExecutedStepState {
    const headers = normalizeHeaderRecord(response.headers)
    const mime = summarizeMime(headers['content-type'])
    return {
        status: response.status,
        mime,
        text: response.text,
        json: mime === 'application/json' ? safeJsonParse(response.text) : null,
        url: response.url,
        headers,
    }
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
        return await readFetchResponse(response)
    } finally {
        clearTimeout(timeout)
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

function renderExecPlan(run: InternalRunState, plan: ApiPlanIr): Record<string, unknown> {
    const steps = plan.steps.map((step) => {
        const request = getRequestByRef(run, step.requestRef)
        return {
            id: step.id,
            requestRef: step.requestRef,
            method: step.method,
            urlTemplate: step.urlTemplate,
            originalUrl: request?.url || null,
            prerequisiteStepIds: step.prerequisiteStepIds,
            bindings: plan.bindings.filter((binding) => binding.stepId === step.id),
        }
    })

    return {
        plan,
        steps,
    }
}

function renderCurlTrace(run: InternalRunState, plan: ApiPlanIr): string {
    const lines: string[] = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '',
        `# Plan ${plan.ref}`,
        `# Execution mode: ${plan.executionMode}`,
    ]
    if (plan.sessionRequirements.length) {
        lines.push('# Session requirements:')
        for (const requirement of plan.sessionRequirements) {
            lines.push(`#   ${requirement}`)
        }
        lines.push('')
    }
    for (const input of plan.callerInputs) {
        lines.push(`${input.name}="${escapeShell(input.defaultValue || '')}"`)
    }
    if (plan.callerInputs.length) {
        lines.push('')
    }

    for (const step of plan.steps) {
        const request = getRequestByRef(run, step.requestRef)
        if (!request) continue
        const bindings = plan.bindings.filter((binding) => binding.stepId === step.id)
        lines.push(`# ${step.id} ${request.method} ${request.urlTemplate}`)
        const renderedUrl = renderRequestUrlTemplateForShell(request, plan, step, bindings)
        const headerFlags = renderCurlHeadersForShell(request, plan, bindings)
        const bodyFlag = renderCurlBodyForShell(request, plan, bindings)
        lines.push(`curl -X ${request.method} "${renderedUrl}" \\`)
        if (headerFlags.length) {
            headerFlags.forEach((flag, index) => {
                lines.push(`${flag}${index === headerFlags.length - 1 && !bodyFlag ? '' : ' \\'}`)
            })
        }
        if (bodyFlag) {
            lines.push(`${bodyFlag}`)
        }
        lines.push('')
    }
    return lines.join('\n')
}

function renderCurlHeadersForShell(
    request: InternalRequestRecord,
    plan: ApiPlanIr,
    bindings: ApiExecutionBinding[]
): string[] {
    const template = buildRequestTemplate(request)
    const output: string[] = []
    for (const slot of plan.slots.filter(
        (candidate) =>
            candidate.requestRef === request.ref &&
            (candidate.source === 'header' || candidate.source === 'cookie')
    )) {
        const binding = bindings.find((candidate) => candidate.slotRef === slot.ref)
        if (!binding) continue
        applyResolvedSlotValue(
            template,
            slot,
            renderBindingShellValue(binding, slot.rawValue),
            { allowRawJsonPlaceholders: true }
        )
    }
    for (const [key, value] of Object.entries(sanitizeExecutionHeaderObject(template.headers))) {
        output.push(`  -H ${JSON.stringify(`${key}: ${value}`)}`)
    }
    const cookieHeader = serializeCookieHeaderValue(template)
    if (cookieHeader) {
        output.push(`  -H ${JSON.stringify(`cookie: ${restoreShellPlaceholders(cookieHeader)}`)}`)
    }
    return output
}

function renderCurlBodyForShell(
    request: InternalRequestRecord,
    plan: ApiPlanIr,
    bindings: ApiExecutionBinding[]
): string {
    if (request.method === 'GET' || request.method === 'HEAD') return ''
    const template = buildRequestTemplate(request)
    for (const slot of plan.slots.filter(
        (candidate) => candidate.requestRef === request.ref && candidate.source === 'body'
    )) {
        const binding = bindings.find((candidate) => candidate.slotRef === slot.ref)
        if (!binding) continue
        applyResolvedSlotValue(
            template,
            slot,
            renderBindingShellValue(binding, slot.rawValue),
            { allowRawJsonPlaceholders: true }
        )
    }
    const body = serializeRequestBodyTemplate(template)
    return body
        ? `  --data-raw ${JSON.stringify(restoreShellPlaceholders(body))}`
        : ''
}

function renderRequestUrlTemplateForShell(
    request: InternalRequestRecord,
    plan: ApiPlanIr,
    step: ApiPlanStep,
    bindings: ApiExecutionBinding[]
): string {
    const template = buildRequestTemplate(request)
    for (const slot of plan.slots.filter(
        (candidate) =>
            candidate.requestRef === step.requestRef &&
            (candidate.source === 'path' || candidate.source === 'query')
    )) {
        const binding = bindings.find((candidate) => candidate.slotRef === slot.ref)
        if (!binding) continue
        applyResolvedSlotValue(
            template,
            slot,
            renderBindingShellValue(binding, slot.rawValue),
            { allowRawJsonPlaceholders: true }
        )
    }
    return restoreShellPlaceholders(template.url.toString())
}

function renderBindingShellValue(binding: ApiExecutionBinding | undefined, fallback: string): string {
    if (!binding) return fallback
    switch (binding.kind) {
        case 'caller':
            return `\${${binding.inputName}}`
        case 'constant':
            return binding.value
        case 'derived_response':
            return `\${${binding.producerStepId}_${sanitizeName(binding.responsePath)}}`
        case 'derived_response_header':
            return `\${${binding.producerStepId}_HEADER_${sanitizeName(binding.headerName)}}`
        case 'ambient_cookie':
            return fallback
        case 'session_cookie':
            return `\${COOKIE_${sanitizeName(binding.cookieName).toUpperCase()}}`
        case 'session_storage':
            return `\${${binding.storageType.toUpperCase()}_${sanitizeName(binding.key).toUpperCase()}}`
        case 'dom_field':
            return `\${DOM_${sanitizeName(binding.fieldName || binding.fieldId || binding.fieldType || 'field').toUpperCase()}}`
        case 'inline_json':
            return `\${INLINE_${sanitizeName(binding.dataPath).toUpperCase()}}`
        case 'unknown':
            return fallback
    }
}

function renderTypeScriptClient(run: InternalRunState, plan: ApiPlanIr): string {
    return `export const plan = ${JSON.stringify(renderExecPlan(run, plan), null, 2)} as const;\n`
}

function renderPythonClient(run: InternalRunState, plan: ApiPlanIr): string {
    return `plan = ${renderPythonLiteral(renderExecPlan(run, plan))}\n`
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

function parseSetCookieHeader(value: string): Array<[string, string]> {
    const entries = value
        .split(/,(?=[^;,]+=)/)
        .map((part) => part.trim())
        .filter(Boolean)
    const output: Array<[string, string]> = []
    for (const part of entries) {
        const first = part.split(';', 1)[0] || ''
        const [name, ...rest] = first.split('=')
        const cookieName = name || ''
        const cookieValue = rest.join('=')
        if (!cookieName || !cookieValue) continue
        output.push([cookieName, cookieValue])
    }
    return output
}

function captureUrlAndBodyValues(run: InternalRunState, request: InternalRequestRecord): void {
    const url = new URL(request.url)
    for (const [key, value] of url.searchParams.entries()) {
        run.values.register(
            value,
            {
                requestRef: request.ref,
                source: 'request.query',
                path: key,
            },
            {
                key,
                requestRef: request.ref,
            }
        )
    }
    const pathSegments = url.pathname.split('/').filter(Boolean)
    pathSegments.forEach((segment, index) => {
        run.values.register(
            segment,
            {
                requestRef: request.ref,
                source: 'request.path',
                path: `path[${index}]`,
            },
            {
                key: `path_${index + 1}`,
                requestRef: request.ref,
            }
        )
    })
    captureBodyValues(run, request.requestBody, request.ref, 'request.body')
}

function captureBodyValues(
    run: InternalRunState,
    body: ApiRequestBodyRecord | ApiResponseBodyRecord | null,
    requestRef: string,
    source: 'request.body' | 'response.body'
): void {
    if (!body) return
    if ('parsedJson' in body || 'parsedForm' in body) {
        for (const occurrence of collectBodyOccurrences(body)) {
            run.values.register(
                occurrence.value,
                {
                    requestRef,
                    source,
                    path: occurrence.path,
                },
                {
                    key: occurrence.path,
                    requestRef,
                }
            )
        }
        return
    }
    if (!body.raw) return
    for (const token of collectOpaqueStringTokens(body.raw)) {
        run.values.register(
            token,
            {
                requestRef,
                source,
            },
            {
                requestRef,
            }
        )
    }
}

function collectActionFactValueLocations(
    actionFact: ApiActionFact
): Array<{
    value: string
    source: 'action.arg' | 'dom.field' | 'inline.html'
    path?: string
}> {
    const output: Array<{
        value: string
        source: 'action.arg' | 'dom.field' | 'inline.html'
        path?: string
    }> = []
    for (const [key, value] of Object.entries(actionFact.args)) {
        if (typeof value === 'string' && value.trim()) {
            output.push({
                value,
                source: 'action.arg',
                path: key,
            })
        }
    }
    const snapshots = [actionFact.beforeDom, actionFact.afterDom]
    for (const snapshot of snapshots) {
        if (!snapshot) continue
        for (const field of snapshot.fields) {
            if (field.value) {
                output.push({
                    value: field.value,
                    source: 'dom.field',
                    path: field.name || field.id || field.type || field.tagName,
                })
            }
        }
        for (const inlineValue of snapshot.inlineValues) {
            output.push({
                value: inlineValue.value,
                source: 'inline.html',
                path: `${inlineValue.source}:${inlineValue.path}`,
            })
        }
    }
    return output
}

function collectOpaqueStringTokens(body: string): string[] {
    const matches = body.match(/[A-Za-z0-9+/_=-]{24,}/g)
    return matches ? dedupeStrings(matches) : []
}

function captureValueOccurrences(
    run: InternalRunState,
    record: Record<string, string>,
    options: {
        requestRef: string
        source: 'request.header' | 'response.header'
    }
): void {
    for (const [key, value] of Object.entries(record)) {
        run.values.register(
            value,
            {
                requestRef: options.requestRef,
                source: options.source,
                path: key,
            },
            {
                key,
                requestRef: options.requestRef,
            }
        )
    }
}

function readSerializableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

function slotMatchesActionTarget(
    seed: SlotSeed,
    action: ApiActionFact,
    target: ApiActionTargetFact
): boolean {
    return slotMatchesSemanticLabels(seed, collectActionTargetSemanticLabels(action, target))
}

function slotMatchesDomField(
    seed: SlotSeed,
    action: ApiActionFact,
    field: ApiDomFieldFact
): boolean {
    return slotMatchesSemanticLabels(seed, [
        field.name,
        field.id,
        field.type,
        field.tagName,
        field.formName,
        field.formId,
        field.placeholder,
        field.ariaLabel,
        field.title,
        readSerializableString(action.args.description),
        readSerializableString(action.args.selector),
        action.target?.description || null,
        action.target?.selector || null,
        action.target?.attributes.name || null,
        action.target?.attributes.id || null,
        action.target?.attributes.placeholder || null,
        action.target?.attributes['aria-label'] || null,
    ])
}

function collectActionTargetSemanticLabels(
    action: ApiActionFact,
    target: ApiActionTargetFact
): Array<string | null | undefined> {
    return [
        action.command,
        readSerializableString(action.args.description),
        readSerializableString(action.args.selector),
        target.description,
        target.selector,
        target.beforeText,
        target.afterText,
        target.attributes.name,
        target.attributes.id,
        target.attributes.placeholder,
        target.attributes['aria-label'],
        target.attributes.title,
        target.attributes.role,
        target.attributes['data-testid'],
        target.attributes['data-test'],
        target.attributes['data-value'],
        target.attributes.value,
        ...collectAttributeQueryKeys(target.attributes),
    ]
}

function collectActionChoiceValues(action: ApiActionFact, target: ApiActionTargetFact): string[] {
    const values = [
        target.afterValue,
        target.beforeValue,
        target.afterText,
        target.beforeText,
        readSerializableString(action.args.text),
        readSerializableString(action.args.value),
        readSerializableString(action.args.label),
        target.attributes.value,
        target.attributes['data-value'],
        target.attributes['data-id'],
        target.attributes['aria-label'],
        target.attributes.title,
        ...collectAttributeQueryValues(target.attributes),
    ]
    return dedupeStrings(
        values
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .filter(Boolean)
    )
}

function collectAttributeQueryKeys(attributes: Record<string, string>): string[] {
    return [...parseAttributeUrls(attributes).keys()]
}

function collectAttributeQueryValues(attributes: Record<string, string>): string[] {
    return [...parseAttributeUrls(attributes).values()]
}

function parseAttributeUrls(attributes: Record<string, string>): Map<string, string> {
    const output = new Map<string, string>()
    for (const key of ['href', 'formaction', 'action', 'data-url']) {
        const value = attributes[key]
        if (!value) continue
        let parsed: URL
        try {
            parsed = new URL(value, 'https://opensteer.invalid')
        } catch {
            continue
        }
        for (const [param, paramValue] of parsed.searchParams.entries()) {
            if (!param || !paramValue) continue
            output.set(param, paramValue)
        }
    }
    return output
}

function buildDomFieldMap(fields: ApiDomFieldFact[]): Map<string, ApiDomFieldFact> {
    const output = new Map<string, ApiDomFieldFact>()
    for (const field of fields) {
        output.set(buildDomFieldIdentity(field), field)
    }
    return output
}

function getMatchingDomField(
    fields: ApiDomFieldFact[],
    targetField: ApiDomFieldFact
): ApiDomFieldFact | null {
    return buildDomFieldMap(fields).get(buildDomFieldIdentity(targetField)) || null
}

function buildDomFieldIdentity(field: ApiDomFieldFact): string {
    return [
        field.tagName,
        field.type || '',
        field.name || '',
        field.id || '',
        field.formName || '',
        field.formId || '',
        field.placeholder || '',
        field.ariaLabel || '',
    ].join('|')
}

function isCausalVisibleDomField(
    action: ApiActionFact,
    field: ApiDomFieldFact,
    value: string,
    changed: boolean,
    primaryValue: string | null
): boolean {
    if (action.command !== 'input' && action.command !== 'select') {
        return false
    }
    if (!fieldMatchesActionTargetField(field, action.target)) {
        return false
    }
    if (primaryValue && primaryValue === value) {
        return true
    }
    return changed
}

function fieldMatchesActionTargetField(
    field: ApiDomFieldFact,
    target: ApiActionTargetFact | null
): boolean {
    if (!target) return false
    const pairs: Array<[string | null, string | null]> = [
        [field.name, target.attributes.name || null],
        [field.id, target.attributes.id || null],
        [field.type, target.attributes.type || null],
        [field.placeholder, target.attributes.placeholder || null],
        [field.ariaLabel, target.attributes['aria-label'] || null],
        [field.title, target.attributes.title || null],
    ]
    return pairs.some(([left, right]) => Boolean(left) && Boolean(right) && left === right)
}

function slotMatchesSemanticLabels(
    seed: SlotSeed,
    labels: Array<string | null | undefined>
): boolean {
    const slotTokens = tokenizeSemanticLabels(collectSlotSemanticLabels(seed))
    const labelTokens = tokenizeSemanticLabels(labels)
    return hasSemanticTokenOverlap(slotTokens, labelTokens)
}

function collectSlotSemanticLabels(seed: SlotSeed): string[] {
    const labels = [seed.name, seed.slotPath]
    switch (seed.source) {
        case 'query':
            labels.push(seed.slotPath.replace(/^query\./, ''))
            break
        case 'header':
            labels.push(seed.slotPath.replace(/^headers\./, ''))
            break
        case 'cookie':
            labels.push(seed.slotPath.replace(/^cookie\./, ''))
            break
        case 'body':
            labels.push(seed.slotPath.replace(/^body\./, ''))
            break
    }
    return labels.filter((label): label is string => Boolean(label))
}

function collectOccurrenceSemanticLabels(occurrence: StructuredOccurrence): string[] {
    const labels = [occurrence.key, occurrence.location, occurrence.slotPath]
    if (occurrence.slotPath?.startsWith('query.')) {
        labels.push(occurrence.slotPath.replace(/^query\./, ''))
    } else if (occurrence.slotPath?.startsWith('headers.')) {
        labels.push(occurrence.slotPath.replace(/^headers\./, ''))
    } else if (occurrence.slotPath?.startsWith('cookie.')) {
        labels.push(occurrence.slotPath.replace(/^cookie\./, ''))
    } else if (occurrence.slotPath?.startsWith('body.')) {
        labels.push(occurrence.slotPath.replace(/^body\./, ''))
    } else if (occurrence.location.startsWith('response.body:')) {
        labels.push(occurrence.location.replace(/^response\.body:/, ''))
    } else if (occurrence.location.startsWith('response.header:')) {
        labels.push(occurrence.location.replace(/^response\.header:/, ''))
    }
    return labels.filter((label): label is string => Boolean(label))
}

function slotMatchesOccurrence(seed: SlotSeed, occurrence: StructuredOccurrence): boolean {
    return slotMatchesSemanticLabels(seed, collectOccurrenceSemanticLabels(occurrence))
}

function slotSeedsSemanticallyAlign(left: SlotSeed, right: SlotSeed): boolean {
    return slotMatchesSemanticLabels(left, collectSlotSemanticLabels(right))
}

function tokenizeSemanticLabels(labels: Array<string | null | undefined>): string[] {
    const tokens = labels.flatMap((label) => {
        if (!label) return []
        return label
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[^a-zA-Z0-9]+/g, ' ')
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean)
    })
    return dedupeStrings(
        tokens.filter(
            (token) =>
                isMeaningfulSemanticToken(token) &&
                !SEMANTIC_NOISE_TOKENS.has(token)
        )
    )
}

function isMeaningfulSemanticToken(token: string): boolean {
    if (!token) return false
    if (token.length > 1) return true
    return /^[a-z]$/i.test(token)
}

function hasSemanticTokenOverlap(left: string[], right: string[]): boolean {
    for (const leftToken of left) {
        for (const rightToken of right) {
            if (leftToken === rightToken) return true
            if (
                leftToken.length >= 3 &&
                rightToken.length >= 3 &&
                (leftToken.includes(rightToken) || rightToken.includes(leftToken))
            ) {
                return true
            }
        }
    }
    return false
}

function readCookieNameFromSlotPath(slotPath: string): string | null {
    return slotPath.startsWith('cookie.') ? slotPath.replace(/^cookie\./, '') : null
}

function buildAttemptMeta(
    report: ApiPlanExecutionReport,
    plan: ApiPlanIr,
    at: number,
    runtimeMode: ApiPlanRuntimeMode
): ApiPlanAttemptMeta {
    const normalized = normalizeDeterministicPlan(plan)
    const capability =
        normalized.runtimeProfile?.capability ??
        (normalized.executionMode === 'browser_dom'
            ? 'browser_page'
            : normalized.executionMode === 'browser_session'
              ? 'browser_fetch'
              : 'http')
    return {
        at,
        ok: report.ok,
        failureKind: report.failureKind,
        runtimeMode,
        capability,
    }
}

function isDistinctiveProvenanceValue(
    value: string,
    shape: string,
    valueStats: OccurrenceValueStats | null
): boolean {
    const normalized = value.trim()
    if (!normalized) return false
    const occurrenceCount = valueStats?.occurrenceCount || 0
    const requestCount = valueStats?.requestCount || 0
    if (requestCount > 2 || occurrenceCount > 3) {
        return false
    }
    if (shape === 'uuid' || shape === 'hex' || shape === 'opaque' || shape === 'bearer') {
        return true
    }
    if (shape === 'integer' || shape === 'float') {
        if (normalized === '0' || normalized === '1') {
            return false
        }
        return normalized.replace(/[^0-9]/g, '').length >= 3
    }
    return normalized.length >= 8
}

function parseDomFieldLocation(location: string | null): {
    name: string | null
    id: string | null
    type: string | null
} | null {
    if (!location?.startsWith('dom.field:')) return null
    const encoded = location.replace('dom.field:', '')
    const params = new URLSearchParams(encoded)
    if (!params.size) {
        return {
            name: encoded || null,
            id: null,
            type: null,
        }
    }
    return {
        name: params.get('name'),
        id: params.get('id'),
        type: params.get('type'),
    }
}

function buildDomFieldLocation(field: ApiDomFieldFact): string {
    const params = new URLSearchParams()
    if (field.name) params.set('name', field.name)
    if (field.id) params.set('id', field.id)
    if (field.type) params.set('type', field.type)
    return `dom.field:${params.toString() || field.tagName}`
}

function isSessionLikeKey(key: string | null | undefined): boolean {
    return SESSION_KEY_PATTERN.test(String(key || ''))
}

function isLowInformationHttpHeader(key: string | null | undefined): boolean {
    const normalized = String(key || '').trim().toLowerCase()
    if (!normalized) {
        return false
    }
    if (LOW_INFORMATION_HEADER_NAMES.has(normalized)) {
        return true
    }
    return normalized.startsWith('sec-ch-') || normalized.startsWith('sec-fetch-')
}

function sanitizeName(value: string): string {
    const cleaned = value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    return cleaned || 'value'
}

function slugifyOperationName(task: string): string {
    return (
        task
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'operation'
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

function buildAlternateValidationInputs(
    plan: ApiPlanIr,
    inputs: Record<string, string>
): Record<string, string>[] {
    if (!Object.keys(inputs).length) {
        return []
    }
    const defaults = Object.fromEntries(
        plan.callerInputs
            .filter((input) => input.defaultValue != null)
            .map((input) => [input.name, input.defaultValue || ''])
    )
    if (JSON.stringify(defaults) === JSON.stringify(inputs)) {
        return []
    }
    return [inputs]
}

function isRefreshableFailure(kind: ApiPlanExecutionReport['failureKind']): boolean {
    return (
        kind === 'session_missing' ||
        kind === 'session_expired' ||
        kind === 'auth_redirect'
    )
}

function findBestMatchingRequest(
    run: InternalRunState,
    matcher: {
        url?: string
        method?: string
    }
): InternalRequestRecord | null {
    const candidates = [...run.requestsByRef.values()].filter((request) => {
        if (matcher.url && request.url !== matcher.url) return false
        if (matcher.method && request.method !== matcher.method) return false
        return true
    })
    if (!candidates.length) return null
    return candidates.sort((left, right) => right.startedAt - left.startedAt)[0] ?? null
}

function readActionPrimaryValue(actionFact: ApiActionFact): string | null {
    return asString(actionFact.args.text) || asString(actionFact.args.value) || null
}

function matchComparableValue(left: string | null, right: string | null): string[] | null {
    if (typeof left !== 'string' || typeof right !== 'string') return null
    const checks: Array<{ chain: string[]; value: string }> = [
        { chain: [], value: left },
        { chain: ['trim'], value: left.trim() },
        { chain: ['lowercase'], value: left.toLowerCase() },
        { chain: ['trim', 'lowercase'], value: left.trim().toLowerCase() },
        { chain: ['url_decode'], value: safeDecodeURIComponent(left) },
        { chain: ['url_decode', 'lowercase'], value: safeDecodeURIComponent(left).toLowerCase() },
    ]
    const targets = new Map<string, string[]>([
        [right, []],
        [right.trim(), ['trim']],
        [right.toLowerCase(), ['lowercase']],
        [right.trim().toLowerCase(), ['trim', 'lowercase']],
        [safeDecodeURIComponent(right), ['url_decode']],
        [safeDecodeURIComponent(right).toLowerCase(), ['url_decode', 'lowercase']],
    ])
    let best: string[] | null = null
    for (const check of checks) {
        const targetTransforms = targets.get(check.value)
        if (!targetTransforms) continue
        const chain = dedupeStrings([...check.chain, ...targetTransforms])
        if (!best || chain.length < best.length) {
            best = chain
        }
    }
    return best
}

function safeDecodeURIComponent(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

function applyTransformPenalty(score: number, transformChain: string[]): number {
    return Math.max(4, score - Math.min(transformChain.length, 2))
}

function describeValueMatchRationale(base: string, transformChain: string[]): string {
    if (!transformChain.length) return base
    return `${base} Matched after ${transformChain.join(' + ')} normalization.`
}

function extractNumericApiRef(ref: string): number {
    const match = ref.match(/(\d+)$/)
    return match ? Number.parseInt(match[1] || '0', 10) : 0
}

function setsIntersect(left: Set<string>, right: Set<string>): boolean {
    for (const value of left) {
        if (right.has(value)) return true
    }
    return false
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

function escapeShell(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`')
}

function restoreShellPlaceholders(value: string): string {
    return value.replace(/%24%7B([A-Za-z0-9_]+)%7D/gi, (_match, name) => `\${${name}}`)
}

function waitMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function renderPythonLiteral(value: unknown, indent = 0): string {
    if (value == null) return 'None'
    if (typeof value === 'boolean') return value ? 'True' : 'False'
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None'
    if (typeof value === 'string') return JSON.stringify(value)

    const prefix = ' '.repeat(indent)
    if (Array.isArray(value)) {
        if (!value.length) return '[]'
        const items = value.map(
            (item) => `${prefix}    ${renderPythonLiteral(item, indent + 4)}`
        )
        return `[\n${items.join(',\n')}\n${prefix}]`
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value)
        if (!entries.length) return '{}'
        const lines = entries.map(
            ([key, child]) =>
                `${prefix}    ${JSON.stringify(key)}: ${renderPythonLiteral(child, indent + 4)}`
        )
        return `{\n${lines.join(',\n')}\n${prefix}}`
    }

    return JSON.stringify(String(value))
}
