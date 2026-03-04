import { describe, expect, it } from 'vitest'
import { Opensteer } from '../../src/opensteer.js'

describe('integration/cursor-headless', () => {
    it('degrades safely when cursor rendering is enabled in headless mode', async () => {
        const opensteer = new Opensteer({
            name: 'cursor-headless-test',
            cursor: {
                enabled: true,
            },
            browser: {
                headless: true,
            },
        })

        await opensteer.launch({ headless: true })

        try {
            await opensteer.page.setContent(
                `
                <button id="target">save</button>
                <div id="result">idle</div>
                <script>
                  document.getElementById('target')?.addEventListener('click', () => {
                    document.getElementById('result').textContent = 'done'
                  })
                </script>
                `
            )

            await opensteer.click({ selector: '#target' })
            const text = await opensteer.page.textContent('#result')
            expect(text?.trim()).toBe('done')
        } finally {
            await opensteer.close()
        }
    })
})
