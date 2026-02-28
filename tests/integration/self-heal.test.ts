import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { OpensteerActionError } from '../../src/actions/errors.js'
import type { ElementPath } from '../../src/element-path/types.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { buildPathFromId, findCounterById, setFixture } from '../helpers/fixture.js'

interface StoredSelectorRecord {
    id: string
    method: string
    description: string
    path: unknown
    metadata: {
        createdAt: number
        updatedAt?: number
        sourceUrl?: string | null
    }
}

interface OpensteerPrivateAccess {
    resolvePathWithAi(
        action: string,
        description: string
    ): Promise<{ path?: ElementPath; counter?: number } | null>
    parseAiExtractPlan(options: unknown): Promise<{
        fields: Array<{ key: string; path: ElementPath }>
        data?: unknown
    }>
}

function resolveStorageKey(description: string): string {
    return createHash('sha256').update(description).digest('hex').slice(0, 16)
}

function readStoredSelector(
    rootDir: string,
    namespace: string,
    description: string
): StoredSelectorRecord {
    const id = resolveStorageKey(description)
    const file = path.join(
        rootDir,
        '.opensteer',
        'selectors',
        namespace,
        `${id}.json`
    )
    return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredSelectorRecord
}

async function waitForTimestampTick(): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 12)
    })
}

describe('integration/self-heal', () => {
    let context: BrowserContext
    let page: Page
    let rootDir: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-self-heal-'))
    })

    afterEach(async () => {
        await context.close()
        fs.rmSync(rootDir, { recursive: true, force: true })
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('self-heals stale cached click paths and refreshes selector cache', async () => {
        const namespace = 'self-heal-click'
        const description = 'self heal submit button'

        await setFixture(
            page,
            `
            <button id="old-submit">Submit</button>
            <p id="status">idle</p>
            <script>
              const btn = document.querySelector('#old-submit')
              const status = document.querySelector('#status')
              btn?.addEventListener('click', () => {
                if (status) status.textContent = 'clicked'
              })
            </script>
            `
        )

        const first = Opensteer.from(page, {
            name: namespace,
            storage: { rootDir },
        })
        const firstResult = await first.click({
            selector: '#old-submit',
            description,
        })
        expect(firstResult.persisted).toBe(true)
        const before = readStoredSelector(rootDir, namespace, description)

        await waitForTimestampTick()

        await setFixture(
            page,
            `
            <a id="new-submit" href="#">Submit</a>
            <p id="status">idle</p>
            <script>
              const btn = document.querySelector('#new-submit')
              const status = document.querySelector('#status')
              btn?.addEventListener('click', (event) => {
                event.preventDefault()
                if (status) status.textContent = 'clicked'
              })
            </script>
            `
        )

        const healedCounter = await findCounterById(page, 'new-submit')
        expect(healedCounter).toBeTruthy()
        if (!healedCounter) throw new Error('Expected counter for healed button.')

        const second = Opensteer.from(page, {
            name: namespace,
            storage: { rootDir },
        })
        const access = second as unknown as OpensteerPrivateAccess
        const aiSpy = vi
            .spyOn(access, 'resolvePathWithAi')
            .mockResolvedValue({ counter: healedCounter })

        const secondResult = await second.click({ description })
        expect(secondResult.persisted).toBe(true)
        expect(aiSpy).toHaveBeenCalledTimes(1)

        const after = readStoredSelector(rootDir, namespace, description)
        expect(after.metadata.updatedAt || 0).toBeGreaterThan(
            before.metadata.updatedAt || before.metadata.createdAt
        )
        expect(JSON.stringify(after.path)).not.toBe(JSON.stringify(before.path))
    })

    it('does not self-heal when cached click failure is not TARGET_NOT_FOUND', async () => {
        const namespace = 'self-heal-no-retry'
        const description = 'blocked target button'

        await setFixture(page, '<button id="target">Blocked target</button>')
        const seed = Opensteer.from(page, {
            name: namespace,
            storage: { rootDir },
        })
        await seed.click({
            selector: '#target',
            description,
        })

        await setFixture(
            page,
            `
            <style>
              #target {
                position: absolute;
                top: 20px;
                left: 20px;
                width: 140px;
                height: 40px;
              }
              #overlay {
                position: absolute;
                inset: 0;
                pointer-events: auto;
              }
            </style>
            <button id="target">Blocked target</button>
            <div id="overlay"></div>
            `
        )
        page.setDefaultTimeout(1200)

        const replay = Opensteer.from(page, {
            name: namespace,
            storage: { rootDir },
        })
        const access = replay as unknown as OpensteerPrivateAccess
        const aiSpy = vi.spyOn(access, 'resolvePathWithAi')

        try {
            await replay.click({ description })
            throw new Error('Expected blocked click to fail.')
        } catch (error) {
            expect(error).toBeInstanceOf(OpensteerActionError)
            const actionError = error as OpensteerActionError
            expect(actionError.failure.code).toBe('BLOCKED_BY_INTERCEPTOR')
            expect(aiSpy).toHaveBeenCalledTimes(0)
        }
    })

    it('self-heals stale cached element-info lookups', async () => {
        const namespace = 'self-heal-element-info'
        const description = 'shared element info target'

        await setFixture(page, '<button id="old-label">Old Label</button>')

        const first = Opensteer.from(page, {
            name: namespace,
            storage: { rootDir },
        })
        await first.click({
            selector: '#old-label',
            description,
        })
        const before = readStoredSelector(rootDir, namespace, description)

        await waitForTimestampTick()

        await setFixture(page, '<a id="new-label" href="#">Fresh Label</a>')
        const healedCounter = await findCounterById(page, 'new-label')
        expect(healedCounter).toBeTruthy()
        if (!healedCounter) throw new Error('Expected counter for healed label.')

        const second = Opensteer.from(page, {
            name: namespace,
            storage: { rootDir },
        })
        const access = second as unknown as OpensteerPrivateAccess
        const aiSpy = vi
            .spyOn(access, 'resolvePathWithAi')
            .mockResolvedValue({ counter: healedCounter })

        const text = await second.getElementText({ description })
        expect(text).toBe('Fresh Label')
        expect(aiSpy).toHaveBeenCalledTimes(1)

        const after = readStoredSelector(rootDir, namespace, description)
        expect(after.method).toBe('getElementText')
        expect(after.metadata.updatedAt || 0).toBeGreaterThan(
            before.metadata.updatedAt || before.metadata.createdAt
        )
    })

    it('self-heals unresolved cached extraction replay and refreshes persisted paths', async () => {
        const namespace = 'self-heal-extract'
        const description = 'self heal extraction target'

        await setFixture(page, '<div id="old-value">Alpha</div>')
        const first = Opensteer.from(page, {
            name: namespace,
            storage: { rootDir },
        })
        const seeded = await first.extractFromPlan<{ value: string }>({
            description,
            schema: { value: '' },
            plan: {
                fields: {
                    value: { selector: '#old-value' },
                },
            },
        })
        expect(seeded.data).toEqual({ value: 'Alpha' })
        const before = readStoredSelector(rootDir, namespace, description)

        await waitForTimestampTick()

        await setFixture(page, '<section id="new-value">Beta</section>')
        const healedPath = await buildPathFromId(page, 'new-value')
        expect(healedPath).toBeTruthy()
        if (!healedPath) throw new Error('Expected healed extraction path.')

        const second = Opensteer.from(page, {
            name: namespace,
            storage: { rootDir },
        })
        const access = second as unknown as OpensteerPrivateAccess
        const parseSpy = vi.spyOn(access, 'parseAiExtractPlan').mockResolvedValue({
            fields: [{ key: 'value', path: healedPath }],
        })

        const extracted = await second.extract<{ value: string }>({
            description,
            schema: { value: '' },
        })

        expect(extracted).toEqual({ value: 'Beta' })
        expect(parseSpy).toHaveBeenCalledTimes(1)

        const after = readStoredSelector(rootDir, namespace, description)
        expect(after.metadata.updatedAt || 0).toBeGreaterThan(
            before.metadata.updatedAt || before.metadata.createdAt
        )
        expect(JSON.stringify(after.path)).not.toBe(JSON.stringify(before.path))
    })

    it('replays healthy cached selectors without calling AI', async () => {
        const namespace = 'self-heal-stable-replay'
        const description = 'stable replay button'

        await setFixture(
            page,
            `
            <button id="stable-btn">Stable</button>
            <p id="status">idle</p>
            <script>
              const btn = document.querySelector('#stable-btn')
              const status = document.querySelector('#status')
              btn?.addEventListener('click', () => {
                if (status) status.textContent = 'clicked'
              })
            </script>
            `
        )

        const first = Opensteer.from(page, {
            name: namespace,
            storage: { rootDir },
        })
        await first.click({
            selector: '#stable-btn',
            description,
        })

        const second = Opensteer.from(page, {
            name: namespace,
            storage: { rootDir },
        })
        const access = second as unknown as OpensteerPrivateAccess
        const aiSpy = vi.spyOn(access, 'resolvePathWithAi')

        const result = await second.click({ description })
        expect(result.persisted).toBe(false)
        expect(aiSpy).toHaveBeenCalledTimes(0)
        expect((await page.textContent('#status'))?.trim()).toBe('clicked')
    })
})
