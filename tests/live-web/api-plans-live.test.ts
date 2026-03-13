import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import {
    ApiReverseController,
    Opensteer,
    OpensteerApiPlans,
} from '../../src/index.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'

const describeLiveApiPlans =
    process.env.RUN_LIVE_WEB_API_PLANS === '1' ? describe : describe.skip

type PlanHandle = ReturnType<OpensteerApiPlans['plan']>
type ValidationResult = Awaited<ReturnType<PlanHandle['validate']>>
type ExecutionResult = Awaited<ReturnType<PlanHandle['execute']>>

interface LiveApiScenario {
    id: string
    seedValue: string
    validateValue: string
    executeValue: string
    task: string
    setup: (ctx: {
        page: Page
        opensteer: Opensteer
        controller: ApiReverseController
    }) => Promise<{
        requestRef: string
        capturedPlan: Awaited<ReturnType<ApiReverseController['inferPlan']>>
    }>
    assertOutcome: (args: {
        capturedPlan: Awaited<ReturnType<ApiReverseController['inferPlan']>>
        validation: ValidationResult
        execution: ExecutionResult
        calls: FetchCall[]
        executeValue: string
    }) => void
}

interface FetchCall {
    method: string
    url: string
    body: string | null
}

const scenarios: LiveApiScenario[] = [
    {
        id: 'hn-algolia-search',
        task: 'search hacker news stories',
        seedValue: 'openai',
        validateValue: 'ada lovelace',
        executeValue: 'sam altman',
        async setup({ page, opensteer, controller }) {
            await page.goto('https://hn.algolia.com/', {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            })
            await page.waitForSelector('input[type="search"]', { timeout: 20000 })
            await page.waitForTimeout(1500)
            await controller.startCapture()

            const [, inputSpanRef] = await Promise.all([
                page.waitForResponse(
                    (response) =>
                        response.url().includes('/indexes/Item_dev/query') &&
                        response.request().method() === 'POST' &&
                        response.status() === 200,
                    { timeout: 30000 }
                ),
                runCapturedAction(
                    controller,
                    'input',
                    {
                        selector: 'input[type="search"]',
                        text: this.seedValue,
                    },
                    () =>
                        opensteer.input({
                            selector: 'input[type="search"]',
                            text: this.seedValue,
                            clear: true,
                        })
                ),
            ])

            await page.waitForTimeout(1500)
            const requestRef = requireRequestRef(
                controller,
                requireSpanRef(inputSpanRef, 'input'),
                '/indexes/Item_dev/query'
            )
            const capturedPlan = await controller.inferPlan({
                task: this.task,
                requestRef,
            })
            return {
                requestRef,
                capturedPlan,
            }
        },
        assertOutcome({ capturedPlan, validation, execution, calls, executeValue }) {
            expect(capturedPlan.callerInputs.length).toBeGreaterThan(0)
            expect(validation.meta.lifecycle).toBe('validated')
            expect(validation.promotionIssues).toEqual([])
            expect(execution.ok).toBe(true)
            const algoliaCall = requireFetchCall(calls, '/indexes/Item_dev/query')
            expect(algoliaCall.method).toBe('POST')
            expect(algoliaCall.body || '').toContain(executeValue)
        },
    },
    {
        id: 'wikipedia-title-search',
        task: 'search wikipedia titles',
        seedValue: 'Ada',
        validateValue: 'Grace Hopper',
        executeValue: 'Alan Turing',
        async setup({ page, opensteer, controller }) {
            await page.goto('https://en.wikipedia.org/wiki/Main_Page', {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            })
            await page.waitForSelector('#searchInput', { timeout: 20000 })
            await page.waitForTimeout(1000)
            await controller.startCapture()

            const [, inputSpanRef] = await Promise.all([
                page.waitForResponse(
                    (response) => {
                        if (
                            !response.url().includes('/w/rest.php/v1/search/title') ||
                            response.status() !== 200
                        ) {
                            return false
                        }
                        return (
                            new URL(response.url()).searchParams.get('q') === this.seedValue
                        )
                    },
                    { timeout: 30000 }
                ),
                runCapturedAction(
                    controller,
                    'input',
                    { selector: '#searchInput', text: this.seedValue },
                    () =>
                        opensteer.input({
                            selector: '#searchInput',
                            text: this.seedValue,
                            clear: true,
                        })
                ),
            ])

            await page.waitForTimeout(1500)
            const requestRef = requireRequestRef(
                controller,
                requireSpanRef(inputSpanRef, 'input'),
                '/w/rest.php/v1/search/title'
            )
            const capturedPlan = await controller.inferPlan({
                task: this.task,
                requestRef,
            })
            return {
                requestRef,
                capturedPlan,
            }
        },
        assertOutcome({ capturedPlan, validation, execution, calls, executeValue }) {
            expect(capturedPlan.callerInputs.length).toBeGreaterThan(0)
            expect(validation.meta.lifecycle).toBe('validated')
            expect(validation.promotionIssues).toEqual([])
            expect(execution.ok).toBe(true)
            const request = requireFetchCall(calls, '/w/rest.php/v1/search/title')
            expect(request.method).toBe('GET')
            expect(new URL(request.url).searchParams.get('q')).toBe(executeValue)
        },
    },
    {
        id: 'openlibrary-transport-boundary',
        task: 'search open library books',
        seedValue: 'tolkien',
        validateValue: 'asimov',
        executeValue: 'ursula le guin',
        async setup({ page, opensteer, controller }) {
            await page.goto('https://openlibrary.org/', {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            })
            const selector = 'input[name="q"], input[type="search"]'
            await page.waitForSelector(selector, { timeout: 20000 })
            await page.waitForTimeout(1500)
            await controller.startCapture()

            const [, inputSpanRef] = await Promise.all([
                page.waitForResponse(
                    (response) =>
                        response.url().includes('/search.json') &&
                        response.request().method() === 'GET' &&
                        response.status() === 200,
                    { timeout: 30000 }
                ),
                runCapturedAction(
                    controller,
                    'input',
                    { selector, text: this.seedValue },
                    () =>
                        opensteer.input({
                            selector,
                            text: this.seedValue,
                            clear: true,
                        })
                ),
            ])

            await page.waitForTimeout(1500)
            const requestRef = requireRequestRef(
                controller,
                requireSpanRef(inputSpanRef, 'input'),
                '/search.json'
            )
            const capturedPlan = await controller.inferPlan({
                task: this.task,
                requestRef,
            })
            return {
                requestRef,
                capturedPlan,
            }
        },
        assertOutcome({ capturedPlan, validation, execution, calls, executeValue }) {
            expect(capturedPlan.lifecycle).toBe('draft')
            expect(capturedPlan.callerInputs.length).toBeGreaterThan(0)
            expect(validation.meta.lifecycle).toBe('validated')
            expect(validation.promotionIssues).toEqual([])
            expect(execution.ok).toBe(true)
            if (calls.length) {
                const request = requireFetchCall(calls, '/search.json')
                expect(new URL(request.url).searchParams.get('q')).toBe(executeValue)
            }
        },
    },
]

describeLiveApiPlans('live-web/api-plans', () => {
    let context: BrowserContext | null = null
    let page: Page | null = null

    afterEach(async () => {
        await context?.close()
        context = null
        page = null
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    for (const scenario of scenarios) {
        it(
            scenario.id,
            async () => {
                ;({ context, page } = await createTestPage())
                const rootDir = fs.mkdtempSync(
                    path.join(os.tmpdir(), `opensteer-api-plan-live-${scenario.id}-`)
                )
                const opensteer = Opensteer.from(page, {
                    name: `api-plan-live-${scenario.id}`,
                    storage: { rootDir },
                })
                const controller = new ApiReverseController(opensteer, {
                    scopeDir: rootDir,
                    logicalSession: 'live-web',
                })

                try {
                    const { capturedPlan } = await scenario.setup({
                        page,
                        opensteer,
                        controller,
                    })

                    await controller.stopCapture()
                    await controller.shutdown()
                    await context?.close()
                    context = null
                    page = null

                    const client = new OpensteerApiPlans({ rootDir })
                    const inputName = capturedPlan.callerInputs[0]?.name || null
                    const validationInputs =
                        inputName && scenario.validateValue
                            ? { [inputName]: scenario.validateValue }
                            : {}
                    const executeInputs =
                        inputName && scenario.executeValue
                            ? { [inputName]: scenario.executeValue }
                            : {}

                    const validation = await client.plan(capturedPlan.operation).validate(
                        validationInputs
                    )
                    const savedRecord = await client.registry.loadLatest(
                        capturedPlan.operation
                    )
                    expect(savedRecord).not.toBeNull()
                    expect(savedRecord?.plan.schemaVersion).toBe(
                        'deterministic-plan.v2'
                    )
                    expect(fs.existsSync(savedRecord?.planPath || '')).toBe(true)
                    expect(fs.existsSync(savedRecord?.metaPath || '')).toBe(true)
                    expect(
                        fs.readdirSync(savedRecord?.fixturesDir || '').length
                    ).toBeGreaterThan(0)
                    const { calls, result } = await withFetchSpy(() =>
                        client.plan(capturedPlan.operation).execute(executeInputs)
                    )
                    scenario.assertOutcome({
                        capturedPlan,
                        validation,
                        execution: result,
                        calls,
                        executeValue: scenario.executeValue,
                    })
                } finally {
                    await controller.shutdown().catch(() => undefined)
                    await opensteer.close().catch(() => undefined)
                }
            },
            { timeout: 180000 }
        )
    }
})

async function runCapturedAction(
    controller: ApiReverseController,
    command: string,
    args: Record<string, unknown>,
    action: () => Promise<unknown>
): Promise<string | null> {
    const token = await controller.beginAutomaticSpan(command, args)
    try {
        await action()
        await controller.endAutomaticSpan(token, {})
        return token?.spanRef ?? null
    } catch (error) {
        await controller.endAutomaticSpan(token, { error })
        throw error
    }
}

function requireSpanRef(spanRef: string | null, command: string): string {
    if (!spanRef) {
        throw new Error(`No span recorded for command "${command}".`)
    }
    return spanRef
}

function requireRequestRef(
    controller: ApiReverseController,
    spanRef: string,
    urlFragment: string
): string {
    const rows = controller.listRequests({ spanRef, kind: 'all' })
    const match = rows.find((row) => row.urlTemplate.includes(urlFragment))
    if (!match) {
        throw new Error(`No captured request matched "${urlFragment}".`)
    }
    return match.ref
}

function requireFetchCall(calls: FetchCall[], urlFragment: string): FetchCall {
    const match = calls.find((call) => call.url.includes(urlFragment))
    if (!match) {
        throw new Error(`No deterministic execution request matched "${urlFragment}".`)
    }
    return match
}

async function withFetchSpy<T>(
    callback: () => Promise<T>
): Promise<{ calls: FetchCall[]; result: T }> {
    const originalFetch = globalThis.fetch
    const calls: FetchCall[] = []

    globalThis.fetch = async (input, init) => {
        calls.push({
            method:
                init?.method ||
                (input instanceof Request ? input.method : null) ||
                'GET',
            url:
                typeof input === 'string'
                    ? input
                    : input instanceof URL
                      ? input.toString()
                      : input.url,
            body: typeof init?.body === 'string' ? init.body : null,
        })
        return originalFetch(input, init)
    }

    try {
        const result = await callback()
        return { calls, result }
    } finally {
        globalThis.fetch = originalFetch
    }
}
