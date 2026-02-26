import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

const RUN_CUA_E2E = process.env.RUN_CUA_E2E === '1'
const DEFAULT_CUA_MODEL = 'openai/computer-use-preview'
const CUA_E2E_MODEL = (process.env.CUA_E2E_MODEL || DEFAULT_CUA_MODEL).trim()

if (RUN_CUA_E2E) {
    ensureProviderApiKeyForModel(CUA_E2E_MODEL, process.env)
}

const describeCuaE2E = RUN_CUA_E2E ? describe : describe.skip

describeCuaE2E('e2e/cua-agent', () => {
    let context: BrowserContext
    let page: Page
    let rootDir: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-cua-e2e-'))
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it(
        'executes a real CUA task and verifies the page outcome',
        async () => {
            await gotoRoute(page, '/forms')

            const opensteer = Opensteer.from(page, {
                name: 'cua-e2e',
                storage: { rootDir },
            })

            try {
                const agent = opensteer.agent({
                    mode: 'cua',
                    model: CUA_E2E_MODEL,
                    waitBetweenActionsMs: 200,
                })

                const expectedName = 'CUA Test User'
                const expectedEmail = 'cua-test@example.com'

                const result = await agent.execute({
                    instruction: `Complete this task on the current page:
1) Set the Full Name field to "${expectedName}".
2) Set the Email field to "${expectedEmail}".
3) Click the "Submit profile" button.
4) Verify the preview area reflects those exact values before you finish.
Finish immediately after the preview is correct.`,
                    maxSteps: 40,
                })

                expect(result.success, result.message || 'Agent reported failure').toBe(
                    true
                )
                expect(result.completed).toBe(true)
                expect(result.actions.length).toBeGreaterThan(0)
                expect(result.model).toBe(CUA_E2E_MODEL)
                expect(
                    result.actions.some(
                        (action) => action.type === 'type' || action.type === 'click'
                    )
                ).toBe(true)

                await expect
                    .poll(
                        async () => {
                            const previewName = (
                                await page.textContent('#preview-name')
                            )?.trim()
                            const previewEmail = (
                                await page.textContent('#preview-email')
                            )?.trim()
                            return {
                                previewName,
                                previewEmail,
                            }
                        },
                        {
                            timeout: 15_000,
                            interval: 500,
                        }
                    )
                    .toEqual({
                        previewName: expectedName,
                        previewEmail: expectedEmail,
                    })

                expect((await page.textContent('#preview-name'))?.trim()).toBe(
                    expectedName
                )
                expect((await page.textContent('#preview-email'))?.trim()).toBe(
                    expectedEmail
                )
                expect(await page.inputValue('#full-name')).toBe(expectedName)
                expect(await page.inputValue('#email-input')).toBe(
                    expectedEmail
                )
                expect(await page.textContent('#form-errors')).toContain(
                    'Password needs 8+ chars'
                )
            } finally {
                await opensteer.close()
            }
        },
        { timeout: 240_000 }
    )
})

function ensureProviderApiKeyForModel(model: string, env: NodeJS.ProcessEnv): void {
    const provider = resolveCuaProvider(model)

    if (provider === 'openai') {
        if (!env.OPENAI_API_KEY?.trim()) {
            throw new Error(
                `RUN_CUA_E2E=1 with CUA_E2E_MODEL="${model}" requires OPENAI_API_KEY.`
            )
        }
        return
    }

    if (provider === 'anthropic') {
        if (!env.ANTHROPIC_API_KEY?.trim()) {
            throw new Error(
                `RUN_CUA_E2E=1 with CUA_E2E_MODEL="${model}" requires ANTHROPIC_API_KEY.`
            )
        }
        return
    }

    const hasGoogleApiKey = Boolean(
        env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
            env.GEMINI_API_KEY?.trim() ||
            env.GOOGLE_API_KEY?.trim()
    )
    if (!hasGoogleApiKey) {
        throw new Error(
            `RUN_CUA_E2E=1 with CUA_E2E_MODEL="${model}" requires GOOGLE_GENERATIVE_AI_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY.`
        )
    }
}

function resolveCuaProvider(model: string): 'openai' | 'anthropic' | 'google' {
    const [providerRaw, providerModel] = model.split('/', 2)
    const provider = providerRaw?.trim().toLowerCase()
    if (!provider || !providerModel?.trim()) {
        throw new Error(
            `CUA_E2E_MODEL must use "provider/model" format. Received "${model}".`
        )
    }

    if (provider === 'openai' || provider === 'anthropic' || provider === 'google') {
        return provider
    }

    throw new Error(
        `Unsupported CUA_E2E_MODEL provider "${provider}" in "${model}". Supported providers: openai, anthropic, google.`
    )
}
