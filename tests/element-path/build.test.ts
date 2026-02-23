import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import type { ElementPath, PathNode } from '../../src/element-path/types.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('element-path/build', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    const requirePath = (path: ElementPath | null): ElementPath => {
        expect(path).toBeTruthy()
        if (!path) {
            throw new Error('Expected path to exist.')
        }
        return path
    }

    const requireTargetNode = (path: ElementPath): PathNode => {
        const target = path.nodes[path.nodes.length - 1]
        expect(target).toBeTruthy()
        if (!target) {
            throw new Error('Expected target node to exist.')
        }
        return target
    }

    it('builds a normalized path for standard DOM elements', async () => {
        await setFixture(
            page,
            `
            <main>
              <button id="save-btn" name="save">Save</button>
            </main>
            `
        )

        const path = await buildElementPathFromSelector(page, '#save-btn')

        expect(path).toBeTruthy()
        expect(path?.context).toEqual([])
        const lastNode = path?.nodes[path.nodes.length - 1]
        expect(lastNode?.tag).toBe('button')
        expect(lastNode?.attrs.id).toBe('save-btn')
        expect(lastNode?.attrs.name).toBe('save')
    })

    it('captures shadow hops when selector resolves inside open shadow root', async () => {
        await setFixture(
            page,
            `
            <opensteer-shadow-host id="shadow-host"></opensteer-shadow-host>
            <script>
              class OvShadowHost extends HTMLElement {
                connectedCallback() {
                  if (this.shadowRoot) return
                  const root = this.attachShadow({ mode: 'open' })
                  root.innerHTML = '<button id="inside-shadow">Inside</button>'
                }
              }
              customElements.define('opensteer-shadow-host', OvShadowHost)
            </script>
            `
        )

        const path = await buildElementPathFromSelector(
            page,
            '#shadow-host #inside-shadow'
        )

        expect(path).toBeTruthy()
        expect(path?.context.length).toBe(1)
        expect(path?.context[0]?.kind).toBe('shadow')
        expect(path?.context[0]?.host.at(-1)?.attrs.id).toBe('shadow-host')
        expect(path?.nodes.at(-1)?.attrs.id).toBe('inside-shadow')
    })

    it('keeps top-page selector semantics and does not traverse iframe documents', async () => {
        await setFixture(
            page,
            `
            <iframe id="inner" srcdoc="<button id='inside-frame'>Frame</button>"></iframe>
            `
        )

        await page.waitForSelector('#inner', { state: 'attached' })

        const path = await buildElementPathFromSelector(page, '#inside-frame')
        expect(path).toBeNull()
    })

    it('seeds class match clauses on classed nodes before escalating other attrs', async () => {
        await setFixture(
            page,
            `
            <main class="shell">
              <section class="panel">
                <button id="save-btn" class="action primary">Save</button>
                <button id="cancel-btn" class="action primary">Cancel</button>
              </section>
            </main>
            `
        )

        const path = await buildElementPathFromSelector(page, '#save-btn')

        const resolved = requirePath(path)

        const classNodes = resolved.nodes.filter(
            (node) => String(node.attrs.class || '').trim().length > 0
        )
        expect(classNodes.length).toBeGreaterThan(0)
        for (const node of classNodes) {
            const hasClassMatch = node.match.some(
                (clause) =>
                    clause.kind === 'attr' &&
                    clause.key === 'class' &&
                    clause.op === 'exact'
            )
            expect(hasClassMatch).toBe(true)
        }

        const target = requireTargetNode(resolved)

        const classIndex = target.match.findIndex(
            (clause) => clause.kind === 'attr' && clause.key === 'class'
        )
        const idIndex = target.match.findIndex(
            (clause) => clause.kind === 'attr' && clause.key === 'id'
        )

        expect(classIndex).toBeGreaterThanOrEqual(0)
        if (idIndex >= 0) {
            expect(classIndex).toBeLessThan(idIndex)
        }
    })

    it('prefers non-id attrs before id when class-only matching is ambiguous', async () => {
        await setFixture(
            page,
            `
            <main class="shell">
              <section class="panel">
                <button id="save-btn" class="action primary" data-testid="save-target">Save</button>
                <button id="cancel-btn" class="action primary" data-testid="cancel-target">Cancel</button>
              </section>
            </main>
            `
        )

        const path = await buildElementPathFromSelector(page, '#save-btn')

        const target = requireTargetNode(requirePath(path))

        const hasClass = target.match.some(
            (clause) => clause.kind === 'attr' && clause.key === 'class'
        )
        const hasDataTestId = target.match.some(
            (clause) => clause.kind === 'attr' && clause.key === 'data-testid'
        )
        const hasId = target.match.some(
            (clause) => clause.kind === 'attr' && clause.key === 'id'
        )

        expect(hasClass).toBe(true)
        expect(hasDataTestId).toBe(true)
        expect(hasId).toBe(false)
    })

    it('treats data-id style attributes as deferred fallback keys', async () => {
        await setFixture(
            page,
            `
            <main class="shell">
              <section class="panel">
                <button class="action primary" data-testid="save-target" data-id="save-12345">Save</button>
                <button class="action primary" data-testid="cancel-target" data-id="cancel-67890">Cancel</button>
              </section>
            </main>
            `
        )

        const path = await buildElementPathFromSelector(
            page,
            'button[data-testid="save-target"]'
        )

        const target = requireTargetNode(requirePath(path))

        const hasClass = target.match.some(
            (clause) => clause.kind === 'attr' && clause.key === 'class'
        )
        const hasDataTestId = target.match.some(
            (clause) => clause.kind === 'attr' && clause.key === 'data-testid'
        )
        const hasDataId = target.match.some(
            (clause) => clause.kind === 'attr' && clause.key === 'data-id'
        )

        expect(hasClass).toBe(true)
        expect(hasDataTestId).toBe(true)
        expect(hasDataId).toBe(false)
    })
})
