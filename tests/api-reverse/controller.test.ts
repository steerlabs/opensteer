import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { ApiReverseController } from '../../src/api-reverse/controller.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'

interface LoggedRequest {
    method: string
    pathname: string
    searchParams: Record<string, string>
    headers: Record<string, string | string[] | undefined>
}

describe('api-reverse/controller', () => {
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

    it('classifies true user input separately from constant scaffolding and session fields', async () => {
        const requests: LoggedRequest[] = []
        const baseUrl = await startServer((req, res, url) => {
            requests.push(logRequest(req, url))
            if (url.pathname === '/search') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="search" name="q" />
                        <input type="hidden" id="csrf" name="csrf" value="csrf-hidden-123" />
                        <button id="go">Go</button>
                        <script id="bootstrap" type="application/json">{"limit":6,"thumb":60}</script>
                        <script>
                          const bootstrap = JSON.parse(document.getElementById('bootstrap').textContent);
                          document.getElementById('go').addEventListener('click', async () => {
                            const q = document.getElementById('search').value;
                            const csrf = document.getElementById('csrf').value;
                            await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=' + bootstrap.limit + '&thumb=' + bootstrap.thumb + '&redirects=', {
                              headers: {
                                'x-csrf-token': csrf,
                              }
                            });
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/search') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        q: url.searchParams.get('q'),
                        limit: url.searchParams.get('limit'),
                        thumb: url.searchParams.get('thumb'),
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-search',
            storage: { rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-search-')) },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/search`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#search', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#search', text: 'OpenAI' })
        )
        await runCapturedAction(controller, 'click', { selector: '#go' }, () =>
            opensteer.click({ selector: '#go' })
        )
        await page.waitForTimeout(250)

        const clickSpan = controller
            .listSpans()
            .find((span) => span.command === 'click')
        expect(clickSpan).toBeTruthy()

        const requestsForSpan = controller.listRequests({
            spanRef: clickSpan?.ref || null,
            kind: 'all',
        })
        expect(requestsForSpan).toHaveLength(1)

        const plan = await controller.inferPlan({
            task: 'search items',
            requestRef: requestsForSpan[0]?.ref || null,
        })

        expect(plan.callerInputs.map((input) => input.name)).toContain('q')
        expect(plan.callerInputs.map((input) => input.name)).not.toContain('redirects')
        expect(findPlanSlot(plan, 'query.q')?.role).toBe('user_input')
        expect(findPlanSlot(plan, 'query.redirects')?.role).toBe('constant')
        expect(findPlanSlot(plan, 'query.limit')?.role).toBe('constant')
        expect(findPlanSlot(plan, 'query.thumb')?.role).toBe('constant')
        expect(findPlanSlot(plan, 'headers.x-csrf-token')?.role).toBe('session')
        expect(requests.some((entry) => entry.pathname === '/api/search')).toBe(true)
    })

    it('builds prerequisite steps and validates parameterized execution against a fresh input', async () => {
        const requests: LoggedRequest[] = []
        const baseUrl = await startServer((req, res, url) => {
            requests.push(logRequest(req, url))
            if (url.pathname === '/lookup') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="term" name="term" />
                        <button id="run">Run</button>
                        <script>
                          document.getElementById('run').addEventListener('click', async () => {
                            const term = document.getElementById('term').value;
                            const bootstrap = await fetch('/api/bootstrap?term=' + encodeURIComponent(term)).then((res) => res.json());
                            await fetch('/api/result?id=' + encodeURIComponent(bootstrap.id) + '&term=' + encodeURIComponent(term) + '&limit=6');
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/bootstrap') {
                const term = url.searchParams.get('term') || ''
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ id: `id-${term}` }))
                return
            }
            if (url.pathname === '/api/result') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        id: url.searchParams.get('id'),
                        term: url.searchParams.get('term'),
                        limit: url.searchParams.get('limit'),
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-derived',
            storage: { rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-derived-')) },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/lookup`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#term', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#term', text: 'OpenAI' })
        )
        await runCapturedAction(controller, 'click', { selector: '#run' }, () =>
            opensteer.click({ selector: '#run' })
        )
        await page.waitForTimeout(350)

        const requestRows = controller.listRequests({ kind: 'all' })
        const resultRequest = requestRows.find((row) =>
            row.urlTemplate.includes('/api/result')
        )
        expect(resultRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'lookup result',
            requestRef: resultRequest?.ref || null,
        })

        expect(plan.steps).toHaveLength(2)
        expect(findPlanSlot(plan, 'query.term')?.role).toBe('user_input')
        expect(findPlanSlot(plan, 'query.id')?.role).toBe('derived')
        expect(
            plan.bindings.some(
                (binding) =>
                    binding.kind === 'derived_response' &&
                    binding.responsePath === 'id'
            )
        ).toBe(true)

        const pythonClient = await controller.codegenPlan({
            ref: plan.ref,
            lang: 'py',
        })
        expect(fs.readFileSync(pythonClient.file, 'utf8')).toContain('plan = {')
        const curlTrace = await controller.renderPlan({
            ref: plan.ref,
            format: 'curl-trace',
        })
        const curlTraceText = fs.readFileSync(curlTrace.file, 'utf8')
        expect(curlTraceText).toContain('${term}')
        expect(curlTraceText).toContain('${step_1_id}')
        expect(curlTraceText).not.toContain('%24%7Bterm%7D')

        requests.length = 0
        const validation = await controller.validatePlan({
            ref: plan.ref,
            mode: 'execute',
            inputs: { term: 'Ada' },
        })

        expect(validation.steps).toHaveLength(2)
        expect(validation.steps.every((step) => step.ok)).toBe(true)
        expect(validation.oracle.statusMatches).toBe(true)

        const bootstrapCall = requests.find((entry) => entry.pathname === '/api/bootstrap')
        const resultCall = requests.find((entry) => entry.pathname === '/api/result')
        expect(bootstrapCall?.searchParams.term).toBe('Ada')
        expect(resultCall?.searchParams.term).toBe('Ada')
        expect(resultCall?.searchParams.id).toBe('id-Ada')
        expect(resultCall?.searchParams.limit).toBe('6')
    })

    it('binds upstream response headers as response_header resolvers instead of browser-only state', async () => {
        const requests: LoggedRequest[] = []
        const baseUrl = await startServer((req, res, url) => {
            requests.push(logRequest(req, url))
            if (url.pathname === '/lookup-header') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="term" name="term" />
                        <button id="run">Run</button>
                        <script>
                          document.getElementById('run').addEventListener('click', async () => {
                            const term = document.getElementById('term').value;
                            const bootstrap = await fetch('/api/bootstrap-header?term=' + encodeURIComponent(term));
                            const id = bootstrap.headers.get('x-result-id');
                            await fetch('/api/result-header?id=' + encodeURIComponent(id || '') + '&term=' + encodeURIComponent(term));
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/bootstrap-header') {
                const term = url.searchParams.get('term') || ''
                res.writeHead(204, {
                    'x-result-id': `header-${term}`,
                })
                res.end()
                return
            }
            if (url.pathname === '/api/result-header') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        id: url.searchParams.get('id'),
                        term: url.searchParams.get('term'),
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-response-header',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-response-header-')),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/lookup-header`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#term', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#term', text: 'OpenAI' })
        )
        await runCapturedAction(controller, 'click', { selector: '#run' }, () =>
            opensteer.click({ selector: '#run' })
        )
        await page.waitForTimeout(350)

        const requestRows = controller.listRequests({ kind: 'all' })
        const resultRequest = requestRows.find((row) =>
            row.urlTemplate.includes('/api/result-header')
        )
        expect(resultRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'lookup result from response header',
            requestRef: resultRequest?.ref || null,
        })

        expect(plan.steps).toHaveLength(2)
        expect(findPlanSlot(plan, 'query.term')?.role).toBe('user_input')
        expect(findPlanSlot(plan, 'query.id')?.role).toBe('derived')
        expect(
            plan.bindings.some(
                (binding) =>
                    binding.kind === 'derived_response_header' &&
                    binding.headerName === 'x-result-id'
            )
        ).toBe(true)

        requests.length = 0
        const validation = await controller.validatePlan({
            ref: plan.ref,
            mode: 'execute',
            inputs: { term: 'Ada' },
        })

        expect(validation.steps).toHaveLength(2)
        expect(validation.steps.every((step) => step.ok)).toBe(true)
        expect(validation.oracle.statusMatches).toBe(true)

        const bootstrapCall = requests
            .filter((entry) => entry.pathname === '/api/bootstrap-header')
            .at(-1)
        const resultCall = requests
            .filter((entry) => entry.pathname === '/api/result-header')
            .at(-1)
        expect(bootstrapCall?.searchParams.term).toBe('Ada')
        expect(resultCall?.searchParams.term).toBe('Ada')
        expect(resultCall?.searchParams.id).toBe('header-Ada')
    })

    it('treats captured cookies as ambient browser context instead of required caller bindings', async () => {
        const requests: LoggedRequest[] = []
        const baseUrl = await startServer((req, res, url) => {
            requests.push(logRequest(req, url))
            if (url.pathname === '/ambient') {
                res.writeHead(200, {
                    'content-type': 'text/html; charset=utf-8',
                    'set-cookie': 'portal-session=ambient-cookie; Path=/; SameSite=Lax',
                })
                res.end(`<!doctype html>
                    <html>
                      <body>
                        <input id="query" name="q" />
                        <button id="go">Go</button>
                        <script>
                          document.getElementById('go').addEventListener('click', async () => {
                            const q = document.getElementById('query').value;
                            await fetch('/api/public?q=' + encodeURIComponent(q));
                          });
                        </script>
                      </body>
                    </html>`)
                return
            }
            if (url.pathname === '/api/public') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        q: url.searchParams.get('q'),
                        cookie: req.headers.cookie || null,
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-ambient-cookie',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-ambient-cookie-')),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/ambient`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#query', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#query', text: 'OpenAI' })
        )
        await runCapturedAction(controller, 'click', { selector: '#go' }, () =>
            opensteer.click({ selector: '#go' })
        )
        await page.waitForTimeout(250)

        const requestRows = controller.listRequests({ kind: 'all' })
        const publicRequest = requestRows.find((row) =>
            row.urlTemplate.includes('/api/public')
        )
        expect(publicRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'public search',
            requestRef: publicRequest?.ref || null,
        })
        expect(
            plan.bindings.some((binding) => binding.kind === 'ambient_cookie')
        ).toBe(true)

        requests.length = 0
        await context?.clearCookies()
        const validation = await controller.validatePlan({
            ref: plan.ref,
            mode: 'execute',
            inputs: { q: 'Ada' },
        })

        expect(validation.steps).toHaveLength(1)
        expect(validation.steps[0]?.ok).toBe(true)
        expect(validation.oracle.statusMatches).toBe(true)
        const publicCall = requests.find((entry) => entry.pathname === '/api/public')
        expect(publicCall?.searchParams.q).toBe('Ada')
    })

    it('replays ambient cookies during offline direct HTTP validation', async () => {
        const requests: LoggedRequest[] = []
        const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-cookie-offline-scope-'))
        const baseUrl = await startServer((req, res, url) => {
            requests.push(logRequest(req, url))
            if (url.pathname === '/private') {
                res.writeHead(200, {
                    'content-type': 'text/html; charset=utf-8',
                    'set-cookie': 'portal-session=ambient-cookie; Path=/; SameSite=Lax',
                })
                res.end(`<!doctype html>
                    <html>
                      <body>
                        <input id="query" name="q" />
                        <button id="go">Go</button>
                        <script>
                          document.getElementById('go').addEventListener('click', async () => {
                            const q = document.getElementById('query').value;
                            await fetch('/api/private?q=' + encodeURIComponent(q));
                          });
                        </script>
                      </body>
                    </html>`)
                return
            }
            if (url.pathname === '/api/private') {
                const hasCookie = (req.headers.cookie || '').includes('portal-session=ambient-cookie')
                res.writeHead(hasCookie ? 200 : 403, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: hasCookie,
                        q: url.searchParams.get('q'),
                        cookie: req.headers.cookie || null,
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-cookie-offline',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-cookie-offline-')),
            },
        })
        const liveController = new ApiReverseController(opensteer, {
            scopeDir,
            logicalSession: 'cookie-offline-test',
        })

        await page.goto(`${baseUrl}/private`, { waitUntil: 'networkidle' })
        await liveController.startCapture()
        await runCapturedAction(liveController, 'input', { selector: '#query', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#query', text: 'OpenAI' })
        )
        await runCapturedAction(liveController, 'click', { selector: '#go' }, () =>
            opensteer.click({ selector: '#go' })
        )
        await page.waitForTimeout(250)

        const privateRequest = liveController
            .listRequests({ kind: 'all' })
            .find((row) => row.urlTemplate.includes('/api/private'))
        expect(privateRequest).toBeTruthy()

        const livePlan = await liveController.inferPlan({
            task: 'private search',
            requestRef: privateRequest?.ref || null,
        })
        await liveController.stopCapture()
        await context?.close()
        context = null
        page = null

        const offlineController = new ApiReverseController(null, {
            scopeDir,
            logicalSession: 'cookie-offline-test',
        })

        requests.length = 0
        const validation = await offlineController.validatePlan({
            ref: livePlan.ref,
            mode: 'execute',
            inputs: { q: 'Ada' },
        })
        expect(validation.steps).toHaveLength(1)
        expect(validation.steps[0]?.ok).toBe(true)
        expect(validation.oracle.statusMatches).toBe(true)
        const privateCall = requests.find((entry) => entry.pathname === '/api/private')
        expect(privateCall?.searchParams.q).toBe('Ada')
        expect(String(privateCall?.headers.cookie || '')).toContain('portal-session=ambient-cookie')
    })

    it('replays browser-backed plans through page fetch with captured ambient cookies', async () => {
        const requests: LoggedRequest[] = []
        const baseUrl = await startServer((req, res, url) => {
            requests.push(logRequest(req, url))
            if (url.pathname === '/browser-backed') {
                res.writeHead(200, {
                    'content-type': 'text/html; charset=utf-8',
                    'set-cookie': 'portal-session=ambient-cookie; Path=/; SameSite=Lax',
                })
                res.end(`<!doctype html>
                    <html>
                      <body>
                        <input id="query" name="q" />
                        <input type="hidden" id="csrf" name="csrf" value="csrf-hidden-123" />
                        <button id="go">Go</button>
                        <script>
                          const nativeFetch = window.fetch.bind(window);
                          window.fetch = (input, init = {}) => {
                            const headers = new Headers(init.headers || {});
                            headers.set('x-window-fetch', '1');
                            return nativeFetch(input, { ...init, headers });
                          };
                          document.getElementById('go').addEventListener('click', async () => {
                            const q = document.getElementById('query').value;
                            const csrf = document.getElementById('csrf').value;
                            await fetch('/api/browser-backed?q=' + encodeURIComponent(q), {
                              headers: {
                                'x-csrf-token': csrf,
                              },
                            });
                          });
                        </script>
                      </body>
                    </html>`)
                return
            }
            if (url.pathname === '/api/browser-backed') {
                const hasCookie = String(req.headers.cookie || '').includes('portal-session=ambient-cookie')
                const hasWrappedFetchHeader = req.headers['x-window-fetch'] === '1'
                const hasCsrf = req.headers['x-csrf-token'] === 'csrf-hidden-123'
                const ok = hasCookie && hasWrappedFetchHeader && hasCsrf
                res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok,
                        q: url.searchParams.get('q'),
                        hasCookie,
                        hasWrappedFetchHeader,
                        hasCsrf,
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-browser-backed',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-browser-backed-')),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/browser-backed`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#query', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#query', text: 'OpenAI', clear: true })
        )
        await runCapturedAction(controller, 'click', { selector: '#go' }, () =>
            opensteer.click({ selector: '#go' })
        )
        await page.waitForTimeout(250)

        const capturedRequest = controller
            .listRequests({ kind: 'all' })
            .find((row) => row.urlTemplate.includes('/api/browser-backed'))
        expect(capturedRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'browser backed search',
            requestRef: capturedRequest?.ref || null,
        })
        expect(plan.executionMode).toBe('browser_dom')

        requests.length = 0
        await context?.clearCookies()
        const validation = await controller.validatePlan({
            ref: plan.ref,
            mode: 'execute',
            inputs: { q: 'Ada' },
        })

        expect(validation.steps).toHaveLength(1)
        expect(validation.steps[0]?.ok).toBe(true)
        expect(validation.steps[0]?.status).toBe(200)
        expect(validation.oracle.statusMatches).toBe(true)

        const replayedCall = requests.find((entry) => entry.pathname === '/api/browser-backed')
        expect(replayedCall?.searchParams.q).toBe('Ada')
        expect(String(replayedCall?.headers.cookie || '')).toContain('portal-session=ambient-cookie')
        expect(String(replayedCall?.headers['x-window-fetch'] || '')).toBe('1')
        expect(String(replayedCall?.headers['x-csrf-token'] || '')).toBe('csrf-hidden-123')
    })

    it('prefers the narrower async request over reflected document navigation state', async () => {
        const baseUrl = await startServer((req, res, url) => {
            if (url.pathname === '/search') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="query" name="q" />
                        <button id="go">Go</button>
                        <script>
                          document.getElementById('go').addEventListener('click', async () => {
                            const q = document.getElementById('query').value;
                            await fetch('/api/suggest?q=' + encodeURIComponent(q) + '&limit=6');
                            window.location.href = '/results?q=' + encodeURIComponent(q) + '&chip-select=search&ia=web';
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/results') {
                const q = url.searchParams.get('q') || ''
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input name="q" value="${q}" />
                        <select name="chip-select">
                          <option value="search" selected>search</option>
                          <option value="news">news</option>
                        </select>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/suggest') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        q: url.searchParams.get('q'),
                        limit: url.searchParams.get('limit'),
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-auto-target',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-auto-target-')),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/search`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#query', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#query', text: 'OpenAI' })
        )
        await runCapturedAction(controller, 'click', { selector: '#go' }, () =>
            opensteer.click({ selector: '#go' })
        )
        await page.waitForTimeout(400)

        const requestRows = controller.listRequests({ kind: 'all' })
        const asyncRequest = requestRows.find((row) => row.urlTemplate.includes('/api/suggest'))
        const documentRequest = requestRows.find((row) => row.urlTemplate.includes('/results'))
        expect(asyncRequest).toBeTruthy()
        expect(documentRequest).toBeTruthy()

        const inferred = await controller.inferPlan({
            task: 'suggest search results',
        })
        expect(inferred.targetRequestRef).toBe(asyncRequest?.ref)

        const documentSlots = controller.listSlots({
            requestRef: documentRequest?.ref || null,
        })
        const chipSlot = documentSlots.find((slot) => slot.slotPath === 'query.chip-select')
        expect(chipSlot?.role).not.toBe('user_input')
        expect(inferred.callerInputs.map((input) => input.name)).toEqual(['q'])
    })

    it('classifies clicked control choices as user input without promoting reflected page state', async () => {
        const baseUrl = await startServer((req, res, url) => {
            if (url.pathname === '/filters') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <a id="price" href="/filters?sort=price">price</a>
                        <script>
                          document.getElementById('price').addEventListener('click', async (event) => {
                            event.preventDefault();
                            await fetch('/api/list?sort=price&view=grid');
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/list') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        sort: url.searchParams.get('sort'),
                        view: url.searchParams.get('view'),
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-action-choice',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-action-choice-')),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/filters`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'click', { selector: '#price' }, () =>
            opensteer.click({ selector: '#price' })
        )
        await page.waitForTimeout(250)

        const requestRows = controller.listRequests({ kind: 'all' })
        const listRequest = requestRows.find((row) => row.urlTemplate.includes('/api/list'))
        expect(listRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'list products by sort',
            requestRef: listRequest?.ref || null,
        })

        expect(findPlanSlot(plan, 'query.sort')?.role).toBe('user_input')
        expect(findPlanSlot(plan, 'query.view')?.role).toBe('constant')
        expect(plan.callerInputs.map((input) => input.name)).toContain('sort')
    })

    it('keeps user input when the site canonically normalizes the request value', async () => {
        const baseUrl = await startServer((req, res, url) => {
            if (url.pathname === '/normalize') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="query" name="q" />
                        <script>
                          const input = document.getElementById('query');
                          input.addEventListener('input', async () => {
                            await fetch('/api/normalize?q=' + encodeURIComponent(input.value.toLowerCase()) + '&limit=5');
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/normalize') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        q: url.searchParams.get('q'),
                        limit: url.searchParams.get('limit'),
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-normalize',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-normalize-')),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/normalize`, { waitUntil: 'networkidle' })
        await controller.startCapture()
        await runCapturedAction(controller, 'input', { selector: '#query', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#query', text: 'OpenAI', clear: true })
        )
        await page.waitForTimeout(250)

        const requestRows = controller.listRequests({ kind: 'all' })
        const normalizeRequest = requestRows.find((row) =>
            row.urlTemplate.includes('/api/normalize')
        )
        expect(normalizeRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'normalized search suggestions',
            requestRef: normalizeRequest?.ref || null,
        })
        expect(findPlanSlot(plan, 'query.q')?.role).toBe('user_input')
        expect(plan.callerInputs.map((input) => input.name)).toContain('q')
    })

    it('sniffs JSON request bodies even when the declared content type is misleading', async () => {
        const requests: LoggedRequest[] = []
        const baseUrl = await startServer(async (req, res, url) => {
            requests.push(logRequest(req, url))
            if (url.pathname === '/body-sniff') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="query" name="query" />
                        <button id="go">Go</button>
                        <script>
                          document.getElementById('go').addEventListener('click', async () => {
                            const query = document.getElementById('query').value;
                            await fetch('/api/body-sniff', {
                              method: 'POST',
                              headers: {
                                'content-type': 'application/x-www-form-urlencoded',
                              },
                              body: JSON.stringify({
                                query,
                                limit: 6,
                              }),
                            });
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/body-sniff') {
                const body = await readRequestBody(req)
                const parsed = JSON.parse(body || '{}')
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        query: parsed.query || null,
                        limit: parsed.limit || null,
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-body-sniff',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-body-sniff-')),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/body-sniff`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#query', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#query', text: 'OpenAI', clear: true })
        )
        await runCapturedAction(controller, 'click', { selector: '#go' }, () =>
            opensteer.click({ selector: '#go' })
        )
        await page.waitForTimeout(250)

        const sniffRequest = controller
            .listRequests({ kind: 'all' })
            .find((row) => row.urlTemplate.includes('/api/body-sniff'))
        expect(sniffRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'body sniff search',
            requestRef: sniffRequest?.ref || null,
        })

        expect(findPlanSlot(plan, 'body.query')?.role).toBe('user_input')
        expect(findPlanSlot(plan, 'body.limit')?.role).toBe('constant')
        expect(plan.callerInputs.map((input) => input.name)).toContain('query')

        requests.length = 0
        const validation = await controller.validatePlan({
            ref: plan.ref,
            mode: 'execute',
            inputs: { query: 'Ada' },
        })
        expect(validation.steps).toHaveLength(1)
        expect(validation.steps[0]?.ok).toBe(true)
        const sniffCall = requests.find((entry) => entry.pathname === '/api/body-sniff')
        expect(sniffCall?.method).toBe('POST')
    })

    it('sniffs form request bodies even when the declared content type is generic', async () => {
        const requests: LoggedRequest[] = []
        const baseUrl = await startServer(async (req, res, url) => {
            requests.push(logRequest(req, url))
            if (url.pathname === '/form-sniff') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="query" name="query" />
                        <button id="go">Go</button>
                        <script>
                          document.getElementById('go').addEventListener('click', async () => {
                            const query = document.getElementById('query').value;
                            await fetch('/api/form-sniff', {
                              method: 'POST',
                              headers: {
                                'content-type': 'text/plain',
                              },
                              body: 'query=' + encodeURIComponent(query) + '&limit=6',
                            });
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/form-sniff') {
                const body = await readRequestBody(req)
                const parsed = new URLSearchParams(body || '')
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        query: parsed.get('query'),
                        limit: parsed.get('limit'),
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-form-sniff',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-form-sniff-')),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/form-sniff`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#query', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#query', text: 'OpenAI', clear: true })
        )
        await runCapturedAction(controller, 'click', { selector: '#go' }, () =>
            opensteer.click({ selector: '#go' })
        )
        await page.waitForTimeout(250)

        const sniffRequest = controller
            .listRequests({ kind: 'all' })
            .find((row) => row.urlTemplate.includes('/api/form-sniff'))
        expect(sniffRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'form sniff search',
            requestRef: sniffRequest?.ref || null,
        })

        expect(findPlanSlot(plan, 'body.query')?.role).toBe('user_input')
        expect(findPlanSlot(plan, 'body.limit')?.role).toBe('constant')
        expect(plan.callerInputs.map((input) => input.name)).toContain('query')

        requests.length = 0
        const validation = await controller.validatePlan({
            ref: plan.ref,
            mode: 'execute',
            inputs: { query: 'Ada' },
        })
        expect(validation.steps).toHaveLength(1)
        expect(validation.steps[0]?.ok).toBe(true)
        const sniffCall = requests.find((entry) => entry.pathname === '/api/form-sniff')
        expect(sniffCall?.method).toBe('POST')
    })

    it('ignores low-information ambient cookie and storage matches for constant scaffolding', async () => {
        const requests: LoggedRequest[] = []
        const baseUrl = await startServer(async (req, res, url) => {
            requests.push(logRequest(req, url))
            if (url.pathname === '/ambient-noise') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="query" name="query" />
                        <button id="go">Go</button>
                        <script>
                          document.cookie = 'tracking_counter_1=1; Path=/; SameSite=Lax';
                          localStorage.setItem('announcement.dismissed', 'false');
                          document.getElementById('go').addEventListener('click', async () => {
                            const query = document.getElementById('query').value;
                            await fetch('/api/search/1', {
                              method: 'POST',
                              headers: {
                                'content-type': 'text/plain',
                              },
                              body: JSON.stringify({
                                query,
                                clickAnalytics: false,
                              }),
                            });
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/search/1') {
                const body = await readRequestBody(req)
                const parsed = JSON.parse(body || '{}')
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        query: parsed.query || null,
                        clickAnalytics: parsed.clickAnalytics ?? null,
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-ambient-noise',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-ambient-noise-')),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/ambient-noise`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#query', text: 'workspace' }, () =>
            opensteer.input({ selector: '#query', text: 'workspace', clear: true })
        )
        await runCapturedAction(controller, 'click', { selector: '#go' }, () =>
            opensteer.click({ selector: '#go' })
        )
        await page.waitForTimeout(250)

        const capturedRequest = controller
            .listRequests({ kind: 'all' })
            .find((row) => row.urlTemplate.includes('/api/search/:int'))
        expect(capturedRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'ambient noise search',
            requestRef: capturedRequest?.ref || null,
        })

        expect(findPlanSlot(plan, 'path[0]')?.role).toBe('constant')
        expect(findPlanSlot(plan, 'body.query')?.role).toBe('user_input')
        expect(findPlanSlot(plan, 'body.clickAnalytics')?.role).toBe('constant')
        expect(plan.callerInputs.map((input) => input.name)).toContain('query')
        expect(plan.executionMode).toBe('direct_http')
        expect(plan.sessionRequirements).toEqual([])

        requests.length = 0
        const validation = await controller.validatePlan({
            ref: plan.ref,
            mode: 'execute',
            inputs: { query: 'store' },
        })
        expect(validation.steps).toHaveLength(1)
        expect(validation.steps[0]?.ok).toBe(true)
        const replayedCall = requests.find((entry) => entry.pathname === '/api/search/1')
        expect(replayedCall?.method).toBe('POST')
    })

    it('preserves JSON scalar types during direct HTTP replay', async () => {
        const requests: LoggedRequest[] = []
        const baseUrl = await startServer(async (req, res, url) => {
            requests.push(logRequest(req, url))
            if (url.pathname === '/typed-json') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="limit" name="limit" />
                        <button id="go">Go</button>
                        <script>
                          document.getElementById('go').addEventListener('click', async () => {
                            const limit = Number(document.getElementById('limit').value);
                            await fetch('/api/typed-json', {
                              method: 'POST',
                              headers: {
                                'content-type': 'application/json',
                              },
                              body: JSON.stringify({
                                limit,
                                clickAnalytics: false,
                              }),
                            });
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/typed-json') {
                const body = await readRequestBody(req)
                const parsed = JSON.parse(body || '{}')
                const valid =
                    typeof parsed.limit === 'number' &&
                    parsed.limit === 12 &&
                    typeof parsed.clickAnalytics === 'boolean' &&
                    parsed.clickAnalytics === false
                res.writeHead(valid ? 200 : 400, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: valid,
                        limitType: typeof parsed.limit,
                        clickAnalyticsType: typeof parsed.clickAnalytics,
                        limit: parsed.limit,
                        clickAnalytics: parsed.clickAnalytics,
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-typed-json',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-typed-json-')),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/typed-json`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#limit', text: '6' }, () =>
            opensteer.input({ selector: '#limit', text: '6', clear: true })
        )
        await runCapturedAction(controller, 'click', { selector: '#go' }, () =>
            opensteer.click({ selector: '#go' })
        )
        await page.waitForTimeout(250)

        const capturedRequest = controller
            .listRequests({ kind: 'all' })
            .find((row) => row.urlTemplate.includes('/api/typed-json'))
        expect(capturedRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'typed json search',
            requestRef: capturedRequest?.ref || null,
        })

        expect(findPlanSlot(plan, 'body.limit')?.role).toBe('user_input')
        expect(findPlanSlot(plan, 'body.clickAnalytics')?.role).toBe('constant')

        const callerInputName = plan.callerInputs[0]?.name
        expect(callerInputName).toBeTruthy()

        requests.length = 0
        const validation = await controller.validatePlan({
            ref: plan.ref,
            mode: 'execute',
            inputs: {
                [callerInputName as string]: '12',
            },
        })
        expect(validation.steps).toHaveLength(1)
        expect(validation.steps[0]?.ok).toBe(true)

        const rendered = await controller.renderPlan({
            ref: plan.ref,
            format: 'curl-trace',
        })
        const curlTrace = fs.readFileSync(rendered.file, 'utf8')
        expect(curlTrace).toContain('\\"clickAnalytics\\":false')
        expect(curlTrace).toContain('\\"limit\\":${')
    })

    it('ignores repeated low-information prior values when classifying target slots', async () => {
        const baseUrl = await startServer((req, res, url) => {
            if (url.pathname === '/noisy-provenance') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="query" name="q" />
                        <button id="go">Go</button>
                        <script>
                          document.getElementById('go').addEventListener('click', async () => {
                            const q = document.getElementById('query').value;
                            await fetch('/api/noise-one?w=0').then((response) => response.json());
                            await fetch('/api/noise-two?w=0').then((response) => response.json());
                            await fetch('/api/search?q=' + encodeURIComponent(q) + '&cp=0');
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/noise-one' || url.pathname === '/api/noise-two') {
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'x-noise-state': '0',
                })
                res.end(JSON.stringify({ w: 0 }))
                return
            }
            if (url.pathname === '/api/search') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        q: url.searchParams.get('q'),
                        cp: url.searchParams.get('cp'),
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-noisy-provenance',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-noisy-provenance-')),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/noisy-provenance`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#query', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#query', text: 'OpenAI', clear: true })
        )
        await runCapturedAction(controller, 'click', { selector: '#go' }, () =>
            opensteer.click({ selector: '#go' })
        )
        await page.waitForTimeout(350)

        const searchRequest = controller
            .listRequests({ kind: 'all' })
            .find((row) => row.urlTemplate.includes('/api/search'))
        expect(searchRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'search with noisy provenance',
            requestRef: searchRequest?.ref || null,
        })

        expect(findPlanSlot(plan, 'query.q')?.role).toBe('user_input')
        expect(findPlanSlot(plan, 'query.cp')?.role).toBe('constant')
        expect(plan.callerInputs.map((input) => input.name)).toEqual(['q'])
    })

    it('keeps low-entropy echoed response fields constant across repeated autocomplete requests', async () => {
        const requests: LoggedRequest[] = []
        const baseUrl = await startServer(async (req, res, url) => {
            requests.push(logRequest(req, url))
            if (url.pathname === '/autocomplete-derived-noise') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="query" name="query" />
                        <script>
                          const input = document.getElementById('query');
                          input.addEventListener('input', async () => {
                            await fetch('/api/autocomplete', {
                              method: 'POST',
                              headers: {
                                'content-type': 'application/json',
                              },
                              body: JSON.stringify({
                                query: input.value,
                                page: 0,
                                hitsPerPage: 30,
                                typoTolerance: true,
                                tagFilters: [['story']],
                              }),
                            });
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/autocomplete') {
                const body = await readRequestBody(req)
                const parsed = JSON.parse(body || '{}')
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        query: parsed.query || null,
                        page: parsed.page ?? null,
                        hitsPerPage: parsed.hitsPerPage ?? null,
                        exhaustiveTypo: parsed.typoTolerance ?? null,
                        hits: [{ _tags: parsed.tagFilters?.[0] || [] }],
                        processingTimingsMS: { total: 4 },
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-autocomplete-derived-noise',
            storage: {
                rootDir: fs.mkdtempSync(
                    path.join(os.tmpdir(), 'api-reverse-autocomplete-derived-noise-')
                ),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/autocomplete-derived-noise`, {
            waitUntil: 'networkidle',
        })
        await controller.startCapture()

        await runCapturedAction(
            controller,
            'input',
            { selector: '#query', text: 'Open' },
            () => opensteer.input({ selector: '#query', text: 'Open', clear: true })
        )
        await runCapturedAction(
            controller,
            'input',
            { selector: '#query', text: 'OpenAI' },
            () => opensteer.input({ selector: '#query', text: 'OpenAI', clear: true })
        )
        await page.waitForTimeout(400)

        const capturedRequests = controller
            .listRequests({ kind: 'all' })
            .filter((row) => row.urlTemplate.includes('/api/autocomplete'))
        expect(capturedRequests.length).toBeGreaterThan(1)

        const targetRequest = capturedRequests[capturedRequests.length - 1]
        expect(targetRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'autocomplete search',
            requestRef: targetRequest?.ref || null,
        })

        expect(plan.steps).toHaveLength(1)
        expect(findPlanSlot(plan, 'body.query')?.role).toBe('user_input')
        expect(findPlanSlot(plan, 'body.page')?.role).toBe('constant')
        expect(findPlanSlot(plan, 'body.hitsPerPage')?.role).toBe('constant')
        expect(findPlanSlot(plan, 'body.typoTolerance')?.role).toBe('constant')
        expect(findPlanSlot(plan, 'body.tagFilters[0][0]')?.role).toBe('constant')
        expect(plan.callerInputs.map((input) => input.name)).toEqual(['query'])
        expect(plan.executionMode).toBe('direct_http')

        requests.length = 0
        const validation = await controller.validatePlan({
            ref: plan.ref,
            mode: 'execute',
            inputs: { query: 'Ada' },
        })
        expect(validation.steps).toHaveLength(1)
        expect(validation.steps[0]?.ok).toBe(true)

        const replayedCall = requests.find((entry) => entry.pathname === '/api/autocomplete')
        expect(replayedCall?.method).toBe('POST')
    })

    it('keeps cookie slots session-scoped even when the same token appears in unrelated requests', async () => {
        const baseUrl = await startServer((req, res, url) => {
            if (url.pathname === '/cookie-provenance') {
                res.writeHead(200, {
                    'content-type': 'text/html; charset=utf-8',
                    'set-cookie': 'sid=shared-token-12345678; Path=/; SameSite=Lax',
                })
                res.end(`<!doctype html>
                    <html>
                      <body>
                        <input id="query" name="q" />
                        <button id="go">Go</button>
                        <script>
                          document.getElementById('go').addEventListener('click', async () => {
                            const q = document.getElementById('query').value;
                            const token = 'shared-token-12345678';
                            await fetch('/api/noise?trace=' + encodeURIComponent(token)).then((response) => response.json());
                            await fetch('/api/noise?trace=' + encodeURIComponent(token)).then((response) => response.json());
                            await fetch('/api/public?q=' + encodeURIComponent(q));
                          });
                        </script>
                      </body>
                    </html>`)
                return
            }
            if (url.pathname === '/api/noise') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ trace: url.searchParams.get('trace') }))
                return
            }
            if (url.pathname === '/api/public') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        q: url.searchParams.get('q'),
                        cookie: req.headers.cookie || null,
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-cookie-provenance',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-cookie-provenance-')),
            },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/cookie-provenance`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#query', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#query', text: 'OpenAI', clear: true })
        )
        await runCapturedAction(controller, 'click', { selector: '#go' }, () =>
            opensteer.click({ selector: '#go' })
        )
        await page.waitForTimeout(350)

        const publicRequest = controller
            .listRequests({ kind: 'all' })
            .find((row) => row.urlTemplate.includes('/api/public'))
        expect(publicRequest).toBeTruthy()

        const plan = await controller.inferPlan({
            task: 'public search with cookies',
            requestRef: publicRequest?.ref || null,
        })

        expect(findPlanSlot(plan, 'query.q')?.role).toBe('user_input')
        expect(findPlanSlot(plan, 'cookie.sid')?.role).toBe('session')
        expect(plan.callerInputs.map((input) => input.name)).toEqual(['q'])
    })

    it('loads persisted runs and validates direct HTTP plans without a live browser session', async () => {
        const requests: LoggedRequest[] = []
        const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-offline-scope-'))
        const baseUrl = await startServer((req, res, url) => {
            requests.push(logRequest(req, url))
            if (url.pathname === '/offline') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="query" name="q" />
                        <button id="go">Go</button>
                        <script>
                          document.getElementById('go').addEventListener('click', async () => {
                            const q = document.getElementById('query').value;
                            await fetch('/api/offline?q=' + encodeURIComponent(q) + '&limit=6');
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/offline') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        q: url.searchParams.get('q'),
                        limit: url.searchParams.get('limit'),
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-offline',
            storage: {
                rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-offline-')),
            },
        })
        const liveController = new ApiReverseController(opensteer, {
            scopeDir,
            logicalSession: 'offline-test',
        })

        await page.goto(`${baseUrl}/offline`, { waitUntil: 'networkidle' })
        await liveController.startCapture()
        await runCapturedAction(liveController, 'input', { selector: '#query', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#query', text: 'OpenAI' })
        )
        await runCapturedAction(liveController, 'click', { selector: '#go' }, () =>
            opensteer.click({ selector: '#go' })
        )
        await page.waitForTimeout(250)

        const offlineRequest = liveController
            .listRequests({ kind: 'all' })
            .find((row) => row.urlTemplate.includes('/api/offline'))
        expect(offlineRequest).toBeTruthy()

        const livePlan = await liveController.inferPlan({
            task: 'offline search',
            requestRef: offlineRequest?.ref || null,
        })
        await liveController.stopCapture()
        await context?.close()
        context = null
        page = null

        const offlineController = new ApiReverseController(null, {
            scopeDir,
            logicalSession: 'offline-test',
        })

        const offlinePlan = offlineController.inspectPlan(livePlan.ref)
        expect(offlinePlan.targetRequestRef).toBe(livePlan.targetRequestRef)

        requests.length = 0
        const validation = await offlineController.validatePlan({
            ref: livePlan.ref,
            mode: 'execute',
            inputs: { q: 'Ada' },
        })
        expect(validation.steps).toHaveLength(1)
        expect(validation.steps[0]?.ok).toBe(true)
        expect(validation.oracle.statusMatches).toBe(true)
        const offlineCall = requests.find((entry) => entry.pathname === '/api/offline')
        expect(offlineCall?.searchParams.q).toBe('Ada')
    })

    it('records safe probe evidence for read-only input-driven requests', async () => {
        const baseUrl = await startServer((req, res, url) => {
            if (url.pathname === '/typeahead') {
                respondHtml(
                    res,
                    `<!doctype html>
                    <html>
                      <body>
                        <input id="search" name="q" />
                        <script>
                          const input = document.getElementById('search');
                          input.addEventListener('input', async () => {
                            await fetch('/api/typeahead?q=' + encodeURIComponent(input.value) + '&limit=6');
                          });
                        </script>
                      </body>
                    </html>`
                )
                return
            }
            if (url.pathname === '/api/typeahead') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        ok: true,
                        q: url.searchParams.get('q'),
                        limit: url.searchParams.get('limit'),
                    })
                )
                return
            }
            res.writeHead(404)
            res.end('not found')
        })
        server = activeServer

        ;({ context, page } = await createTestPage())
        const opensteer = Opensteer.from(page, {
            name: 'api-reverse-probe',
            storage: { rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-reverse-probe-')) },
        })
        const controller = new ApiReverseController(opensteer, {
            scopeDir: process.cwd(),
            logicalSession: 'test',
        })

        await page.goto(`${baseUrl}/typeahead`, { waitUntil: 'networkidle' })
        await controller.startCapture()

        await runCapturedAction(controller, 'input', { selector: '#search', text: 'OpenAI' }, () =>
            opensteer.input({ selector: '#search', text: 'OpenAI', clear: true })
        )
        await page.waitForTimeout(250)

        const inputSpan = controller
            .listSpans()
            .find((span) => span.command === 'input')
        expect(inputSpan).toBeTruthy()

        const probe = await controller.runProbe({
            spanRef: inputSpan?.ref || '',
            values: ['Ada', 'Grace'],
        })
        expect(probe.variants).toHaveLength(2)

        const requestRows = controller.listRequests({ spanRef: inputSpan?.ref || null, kind: 'all' })
        const plan = await controller.inferPlan({
            task: 'typeahead lookup',
            requestRef: requestRows[0]?.ref || null,
        })
        const querySlot = findPlanSlot(plan, 'query.q')
        expect(querySlot?.role).toBe('user_input')

        const evidenceResult = controller.inspectEvidence(querySlot?.ref || '')
        expect(
            JSON.stringify(evidenceResult).includes('probe_changed')
        ).toBe(true)
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

function respondHtml(res: http.ServerResponse, body: string): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
}

function logRequest(req: http.IncomingMessage, url: URL): LoggedRequest {
    return {
        method: req.method || 'GET',
        pathname: url.pathname,
        searchParams: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
    }
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString('utf8')
}

async function runCapturedAction(
    controller: ApiReverseController,
    command: string,
    args: Record<string, unknown>,
    action: () => Promise<unknown>
): Promise<void> {
    const token = await controller.beginAutomaticSpan(command, args)
    try {
        await action()
        await controller.endAutomaticSpan(token, {})
    } catch (error) {
        await controller.endAutomaticSpan(token, { error })
        throw error
    }
}

function findPlanSlot(
    plan: {
        slots: Array<{ ref: string; slotPath: string; role: string }>
    },
    slotPath: string
): { ref: string; slotPath: string; role: string } | undefined {
    return plan.slots.find(
        (slot) => slot.slotPath === slotPath
    )
}
