import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import * as pathResolver from '../../src/element-path/resolver.js'
import { CursorController } from '../../src/cursor/controller.js'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('integration/cursor-preview', () => {
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

    it('skips preview target path resolution when cursor is disabled', async () => {
        await setFixture(
            page,
            `
            <button id="target">Click me</button>
            <div id="status">idle</div>
            <script>
              document.getElementById('target')?.addEventListener('click', () => {
                const status = document.getElementById('status')
                if (status) status.textContent = 'clicked'
              })
            </script>
            `
        )

        const opensteer = Opensteer.from(page, {
            name: 'cursor-preview-disabled',
            cursor: {
                enabled: false,
            },
        })
        const resolvePathSpy = vi.spyOn(pathResolver, 'resolveElementPath')

        try {
            await opensteer.click({ selector: '#target' })

            expect((await page.textContent('#status'))?.trim()).toBe('clicked')
            expect(resolvePathSpy).toHaveBeenCalledTimes(1)
        } finally {
            resolvePathSpy.mockRestore()
        }
    })

    it('uses explicit hover position for the preview cursor point', async () => {
        await setFixture(
            page,
            `
            <style>
              #target {
                position: absolute;
                top: 32px;
                left: 40px;
                width: 160px;
                height: 120px;
                background: #ececec;
              }
            </style>
            <div id="target"></div>
            <div id="status">idle</div>
            <script>
              const target = document.getElementById('target')
              const status = document.getElementById('status')
              target?.addEventListener('mouseenter', () => {
                if (status) status.textContent = 'hovered'
              })
            </script>
            `
        )

        const opensteer = Opensteer.from(page, {
            name: 'cursor-preview-hover-position',
            cursor: {
                enabled: true,
            },
        })
        const previewSpy = vi.spyOn(CursorController.prototype, 'preview')
        const position = { x: 14, y: 18 }
        const handle = await page.$('#target')
        if (!handle) {
            throw new Error('Expected #target to exist.')
        }

        const box = await handle.boundingBox()
        await handle.dispose()
        if (!box) {
            throw new Error('Expected #target to have a bounding box.')
        }

        try {
            await opensteer.hover({
                selector: '#target',
                position,
            })

            expect((await page.textContent('#status'))?.trim()).toBe('hovered')
            expect(previewSpy).toHaveBeenCalled()

            const [previewPoint, previewIntent] =
                previewSpy.mock.calls[previewSpy.mock.calls.length - 1] || []

            expect(previewIntent).toBe('hover')
            expect(previewPoint).not.toBeNull()

            if (!previewPoint) {
                throw new Error('Expected preview point to be present.')
            }

            expect(previewPoint.x).toBeCloseTo(box.x + position.x, 5)
            expect(previewPoint.y).toBeCloseTo(box.y + position.y, 5)
        } finally {
            previewSpy.mockRestore()
        }
    })
})
