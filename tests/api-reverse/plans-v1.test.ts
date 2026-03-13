import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import {
    normalizeDeterministicPlan,
    Opensteer,
    OpensteerApiPlans,
    PlanLifecycleService,
    PlanExecutor,
    PlanRegistry,
    PlanRuntimeManager,
    SessionManager,
    type ApiPlanIr,
} from '../../src/index.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'

describe('api-reverse deterministic plans v1', () => {
    let context: BrowserContext | null = null
    let page: Page | null = null
    let server: http.Server | null = null

    afterEach(async () => {
        await context?.close()
        context = null
        page = null
        if (server) {
            await new Promise<void>((resolve, reject) => {
                server?.close((error) => {
                    if (error) reject(error)
                    else resolve()
                })
            })
            server = null
        }
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('normalizes legacy bindings into deterministic resolvers and per-step transport', () => {
        const plan = normalizeDeterministicPlan(
            createPlan({
                bindings: [
                    {
                        kind: 'caller',
                        stepId: 'step_1',
                        slotRef: '@slot1',
                        inputName: 'query',
                        transforms: [{ kind: 'trim' }, { kind: 'lowercase' }],
                    },
                    {
                        kind: 'session_storage',
                        stepId: 'step_2',
                        slotRef: '@slot2',
                        storageType: 'local',
                        key: 'session_token',
                    },
                ],
                steps: [
                    createStep('step_1'),
                    createStep('step_2'),
                ],
                slots: [
                    createQuerySlot('@slot1', '@request1', 'query', 'OpenAI'),
                    {
                        ...createQuerySlot('@slot2', '@request2', 'token', 'captured'),
                        source: 'header',
                        slotPath: 'headers.x-session-token',
                        name: 'x-session-token',
                        role: 'session',
                    },
                ],
            })
        )

        expect(plan.bindings[0]?.resolver?.kind).toBe('computed')
        expect(plan.steps[0]?.transport).toBe('node_http')
        expect(plan.steps[1]?.transport).toBe('browser_fetch')
        expect(plan.sessionRequirementDetails?.[0]?.kind).toBe('storage_live')
    })

    it('upgrades legacy status into v2 lifecycle and runtime profile metadata', () => {
        const plan = normalizeDeterministicPlan(
            createPlan({
                status: 'healthy',
                bindings: [
                    {
                        kind: 'session_storage',
                        stepId: 'step_1',
                        slotRef: '@slot1',
                        storageType: 'local',
                        key: 'session_token',
                    },
                ],
                slots: [
                    {
                        ...createQuerySlot('@slot1', '@request1', 'token', 'captured'),
                        source: 'header',
                        slotPath: 'headers.x-session-token',
                        name: 'x-session-token',
                        role: 'session',
                    },
                ],
            })
        )

        expect(plan.schemaVersion).toBe('deterministic-plan.v2')
        expect(plan.lifecycle).toBe('validated')
        expect(plan.runtimeProfile?.capability).toBe('browser_fetch')
        expect(plan.runtimeProfile?.browserlessReplayable).toBe(false)
    })

    it('persists plans and fixtures in the versioned registry', async () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-plan-registry-'))
        const registry = new PlanRegistry({ rootDir })
        const plan = normalizeDeterministicPlan(createPlan())

        const saved = await registry.savePlan(plan)
        await registry.saveFixture(saved.plan.operation, saved.plan.version ?? 1, {
            name: 'alternate-query',
            createdAt: Date.now(),
            inputs: { query: 'Ada' },
        })

        const loaded = await registry.load(plan.operation)
        const listed = await registry.list(plan.operation)

        expect(loaded.plan.version).toBe(1)
        expect(loaded.meta.lifecycle).toBe('draft')
        expect(fs.existsSync(path.join(saved.dir, 'fixtures', 'alternate-query.json'))).toBe(true)
        expect(listed).toHaveLength(1)
        expect(listed[0]?.operation).toBe(plan.operation)
    })

    it('executes a self-contained deterministic plan without discovery state', async () => {
        const requests: Array<Record<string, string>> = []
        const baseUrl = await startServer((req, res, url) => {
            requests.push(Object.fromEntries(url.searchParams.entries()))
            if (url.pathname === '/api/search') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: true, query: url.searchParams.get('query') }))
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        const executor = new PlanExecutor()
        const plan = normalizeDeterministicPlan(
            createPlan({
                operation: 'search_people',
                task: 'search people',
                callerInputs: [
                    {
                        ref: '@input1',
                        name: 'query',
                        slotRef: '@slot1',
                        slotPath: 'query.query',
                        role: 'user_input',
                        required: true,
                        defaultValue: ' OpenAI ',
                        evidenceRefs: [],
                    },
                ],
                steps: [
                    createStep('step_1', `${baseUrl}/api/search?query=OpenAI`),
                ],
                slots: [
                    createQuerySlot('@slot1', '@request1', 'query', ' OpenAI '),
                ],
                bindings: [
                    {
                        kind: 'caller',
                        stepId: 'step_1',
                        slotRef: '@slot1',
                        inputName: 'query',
                        transforms: [{ kind: 'trim' }, { kind: 'lowercase' }],
                    },
                ],
                successOracle: {
                    status: 200,
                    mime: 'application/json',
                    expectsDownload: false,
                    jsonPathChecks: [{ path: 'ok', equals: 'true' }],
                },
            })
        )

        const result = await executor.execute(plan, {
            inputs: { query: '  Ada  ' },
            allowDraft: true,
        })

        expect(result.ok).toBe(true)
        expect(requests[0]?.query).toBe('ada')
    })

    it('promotes a saved draft plan through the high-level SDK', async () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-api-plans-'))
        const baseUrl = await startServer((req, res, url) => {
            if (url.pathname === '/api/search') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: true, query: url.searchParams.get('query') }))
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        const client = new OpensteerApiPlans({ rootDir })
        await client.registry.savePlan(
            normalizeDeterministicPlan(
                createPlan({
                    operation: 'search_people',
                    task: 'search people',
                    callerInputs: [
                        {
                            ref: '@input1',
                            name: 'query',
                            slotRef: '@slot1',
                            slotPath: 'query.query',
                            role: 'user_input',
                            required: true,
                            defaultValue: 'OpenAI',
                            evidenceRefs: [],
                        },
                    ],
                    steps: [
                        createStep('step_1', `${baseUrl}/api/search?query=OpenAI`),
                    ],
                    slots: [
                        createQuerySlot('@slot1', '@request1', 'query', 'OpenAI'),
                    ],
                    bindings: [
                        {
                            kind: 'caller',
                            stepId: 'step_1',
                            slotRef: '@slot1',
                            inputName: 'query',
                        },
                    ],
                    successOracle: {
                        status: 200,
                        mime: 'application/json',
                        expectsDownload: false,
                        jsonPathChecks: [{ path: 'ok', equals: 'true' }],
                    },
                })
            )
        )

        const validation = await client.plan('search_people').validate({
            query: 'Ada',
        })
        const execution = await client.plan('search_people').execute({
            query: 'Grace',
        })

        expect(validation.meta.lifecycle).toBe('validated')
        expect(validation.promotionIssues).toHaveLength(0)
        expect(execution.ok).toBe(true)
    })

    it('reduces browser-only constant scaffolding into browserless replay', async () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-api-reduce-'))
        const requests: Array<Record<string, string>> = []
        const baseUrl = await startServer((req, res, url) => {
            requests.push(Object.fromEntries(url.searchParams.entries()))
            if (url.pathname === '/api/search') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: url.searchParams.get('mode') === 'everything',
                        q: url.searchParams.get('q'),
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        const client = new OpensteerApiPlans({ rootDir })
        await client.registry.savePlan(
            normalizeDeterministicPlan(
                createPlan({
                    operation: 'search_open_library_books',
                    task: 'search open library books',
                    targetOrigin: baseUrl,
                    callerInputs: [
                        {
                            ref: '@input1',
                            name: 'q',
                            slotRef: '@slot1',
                            slotPath: 'query.q',
                            role: 'user_input',
                            required: true,
                            defaultValue: 'tolkien',
                            evidenceRefs: [],
                        },
                    ],
                    steps: [
                        createStep('step_1', `${baseUrl}/api/search?q=tolkien&mode=everything`),
                    ],
                    slots: [
                        createQuerySlot('@slot1', '@request1', 'q', 'tolkien'),
                        {
                            ...createQuerySlot('@slot2', '@request1', 'mode', 'everything'),
                            role: 'derived',
                            confidence: 0.53,
                        },
                    ],
                    bindings: [
                        {
                            kind: 'caller',
                            stepId: 'step_1',
                            slotRef: '@slot1',
                            inputName: 'q',
                        },
                        {
                            kind: 'dom_field',
                            stepId: 'step_1',
                            slotRef: '@slot2',
                            fieldName: 'mode',
                            fieldId: 'mode',
                            fieldType: 'hidden',
                            hidden: true,
                            resolverCandidates: [
                                {
                                    kind: 'constant',
                                    value: 'everything',
                                },
                                {
                                    kind: 'dom_field',
                                    fieldName: 'mode',
                                    fieldId: 'mode',
                                    fieldType: 'hidden',
                                    hidden: true,
                                },
                            ],
                        },
                    ],
                    successOracle: {
                        status: 200,
                        mime: 'application/json',
                        expectsDownload: false,
                        jsonPathChecks: [{ path: 'ok', equals: 'true' }],
                    },
                })
            )
        )

        const validation = await client.plan('search_open_library_books').validate({
            q: 'asimov',
        })
        const saved = await client.registry.loadLatest('search_open_library_books')
        const execution = await client.plan('search_open_library_books').execute({
            q: 'ursula',
        })

        expect(validation.meta.lifecycle).toBe('validated')
        expect(validation.promotionIssues).toEqual([])
        expect(saved?.plan.runtimeProfile?.capability).toBe('http')
        expect(saved?.plan.bindings[1]?.resolver?.kind).toBe('constant')
        expect(execution.ok).toBe(true)
        expect(requests.at(-1)?.mode).toBe('everything')
    })

    it('preserves browser-backed resolvers when cheaper candidates fail validation', async () => {
        const requests: Array<Record<string, string>> = []
        const liveToken = 'live-token'
        const baseUrl = await startServer((req, res, url) => {
            if (url.pathname === '/') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                res.end(`<!doctype html><html><body><input id="csrf" name="csrf" type="hidden" value="${liveToken}" /></body></html>`)
                return
            }
            if (url.pathname === '/api/search') {
                requests.push({
                    q: url.searchParams.get('q') || '',
                    token: String(req.headers['x-csrf-token'] || ''),
                })
                const ok = String(req.headers['x-csrf-token'] || '') === liveToken
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok }))
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        await page.goto(baseUrl, { waitUntil: 'networkidle' })
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-runtime-manager',
            storage: { rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-runtime-manager-')) },
        })
        const runtimeManager = new PlanRuntimeManager()
        Object.defineProperty(runtimeManager, 'ensureLocalBrowser', {
            value: async () => opensteer,
        })
        const lifecycle = new PlanLifecycleService({
            executor: new PlanExecutor(),
            runtimeManager,
        })
        const plan = normalizeDeterministicPlan(
            createPlan({
                operation: 'browser_backed_search',
                task: 'browser backed search',
                targetOrigin: baseUrl,
                callerInputs: [
                    {
                        ref: '@input1',
                        name: 'q',
                        slotRef: '@slot1',
                        slotPath: 'query.q',
                        role: 'user_input',
                        required: true,
                        defaultValue: 'OpenAI',
                        evidenceRefs: [],
                    },
                ],
                steps: [
                    createStep('step_1', `${baseUrl}/api/search?q=OpenAI`),
                ],
                slots: [
                    createQuerySlot('@slot1', '@request1', 'q', 'OpenAI'),
                    {
                        ref: '@slot2',
                        requestRef: '@request1',
                        name: 'x_csrf_token',
                        slotPath: 'headers.x-csrf-token',
                        source: 'header',
                        rawValue: 'stale-token',
                        shape: 'string',
                        role: 'session',
                        confidence: 0.95,
                        required: true,
                        evidenceRefs: [],
                    },
                ],
                bindings: [
                    {
                        kind: 'caller',
                        stepId: 'step_1',
                        slotRef: '@slot1',
                        inputName: 'q',
                    },
                    {
                        kind: 'dom_field',
                        stepId: 'step_1',
                        slotRef: '@slot2',
                        fieldName: 'csrf',
                        fieldId: 'csrf',
                        fieldType: 'hidden',
                        hidden: true,
                        resolverCandidates: [
                            {
                                kind: 'constant',
                                value: 'stale-token',
                            },
                            {
                                kind: 'dom_field',
                                fieldName: 'csrf',
                                fieldId: 'csrf',
                                fieldType: 'hidden',
                                hidden: true,
                            },
                        ],
                    },
                ],
                successOracle: {
                    status: 200,
                    mime: 'application/json',
                    expectsDownload: false,
                    jsonPathChecks: [{ path: 'ok', equals: 'true' }],
                },
            })
        )

        const validation = await lifecycle.validate(plan, {
            inputs: { q: 'Ada' },
        })

        expect(validation.lifecycle).toBe('validated')
        expect(validation.plan.runtimeProfile?.capability).toBe('browser_page')
        expect(validation.plan.bindings[1]?.resolver?.kind).toBe('dom_field')
        expect(validation.baseline.ok).toBe(true)
        expect(requests.at(-1)?.token).toBe(liveToken)
    })

    it('reuses an existing browser session when live storage requirements are already satisfied', async () => {
        const baseUrl = await startServer((req, res, url) => {
            if (url.pathname === '/app') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                res.end('<!doctype html><html><body>session app</body></html>')
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        await page.goto(`${baseUrl}/app`, { waitUntil: 'networkidle' })
        await page.evaluate(() => {
            window.localStorage.setItem('session_token', 'abc123')
        })

        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-session-manager',
            storage: { rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-session-manager-')) },
        })
        const sessionManager = new SessionManager({ opensteer })
        const plan = normalizeDeterministicPlan(
            createPlan({
                targetOrigin: baseUrl,
                sessionRequirements: ['localStorage:session_token'],
                sessionRequirementDetails: [
                    {
                        ref: 'local:session_token',
                        kind: 'storage_live',
                        label: 'localStorage:session_token',
                        storageType: 'local',
                        key: 'session_token',
                        required: true,
                    },
                ],
            })
        )

        const result = await sessionManager.ensurePlanSession(plan)
        expect(result.ok).toBe(true)
        expect(result.runtime.source).toBe('attached')
    })
})

let activeServer: http.Server | null = null

async function startServer(
    handler: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        url: URL
    ) => void | Promise<void>
): Promise<string> {
    activeServer = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        Promise.resolve(handler(req, res, url)).catch((error) => {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(error instanceof Error ? error.message : 'test server error')
        })
    })
    await new Promise<void>((resolve, reject) => {
        activeServer?.listen(0, '127.0.0.1', (error?: Error) => {
            if (error) reject(error)
            else resolve()
        })
    })
    const address = activeServer.address()
    if (!address || typeof address === 'string') {
        throw new Error('Unable to resolve test server address.')
    }
    return `http://127.0.0.1:${address.port}`
}

function createPlan(overrides: Partial<ApiPlanIr> = {}): ApiPlanIr {
    return {
        ref: '@plan1',
        operation: overrides.operation ?? 'search_items',
        task: overrides.task ?? 'search items',
        createdAt: Date.now(),
        targetRequestRef: '@request1',
        targetStepId: 'step_1',
        confidence: 0.92,
        transport: 'http',
        executionMode: 'direct_http',
        callerInputs: overrides.callerInputs ?? [],
        steps: overrides.steps ?? [createStep('step_1')],
        slots: overrides.slots ?? [createQuerySlot('@slot1', '@request1', 'query', 'OpenAI')],
        bindings:
            overrides.bindings ??
            [
                {
                    kind: 'constant',
                    stepId: 'step_1',
                    slotRef: '@slot1',
                    value: 'OpenAI',
                },
            ],
        sessionRequirements: overrides.sessionRequirements ?? [],
        sessionRequirementDetails: overrides.sessionRequirementDetails,
        ambiguousSlotRefs: overrides.ambiguousSlotRefs ?? [],
        successOracle:
            overrides.successOracle ?? {
                status: 200,
                mime: 'application/json',
                expectsDownload: false,
            },
        schemaVersion: overrides.schemaVersion,
        version: overrides.version,
        lifecycle: overrides.lifecycle,
        status: overrides.status,
        fingerprint: overrides.fingerprint,
        sourceRunRef: overrides.sourceRunRef ?? '@run1',
        sourceRunId: overrides.sourceRunId ?? 'run-1',
        targetOrigin: overrides.targetOrigin ?? null,
    }
}

function createStep(id: string, url = 'https://example.com/api/search?query=OpenAI') {
    return {
        id,
        requestRef: id === 'step_1' ? '@request1' : '@request2',
        method: 'GET',
        urlTemplate: url,
        requestTemplate: {
            url,
            headers: {
                accept: 'application/json',
            },
            bodyFormat: 'text' as const,
            bodyRaw: null,
        },
        httpExecutable: true,
        prerequisiteStepIds: [],
        slotRefs: [id === 'step_1' ? '@slot1' : '@slot2'],
    }
}

function createQuerySlot(
    ref: string,
    requestRef: string,
    name: string,
    rawValue: string
) {
    return {
        ref,
        requestRef,
        name,
        slotPath: `query.${name}`,
        source: 'query' as const,
        rawValue,
        shape: 'text',
        role: 'user_input' as const,
        confidence: 0.9,
        required: true,
        evidenceRefs: [],
    }
}
