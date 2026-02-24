import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'

const runExternalWaitSmoke = process.env.RUN_EXTERNAL_WAIT_SMOKE === '1'
const describeExternalWaitSmoke = runExternalWaitSmoke ? describe : describe.skip

interface ExternalWaitScenario {
    id: string
    url: string
    selector: string
    selectorCandidates?: string[]
    query: string
    expectedUrlContains: string
    maxElapsedMs?: number
    allowedChallengeUrlContains?: string[]
    preActions?: Array<{
        clickSelector: string
    }>
}

const scenarios: ExternalWaitScenario[] = [
    {
        id: 'amazon',
        url: 'https://www.amazon.com',
        selector: '#twotabsearchtextbox',
        selectorCandidates: [
            '#twotabsearchtextbox',
            'input[aria-label="Search Amazon"]',
            'input.nav-input',
        ],
        query: 'airpods',
        expectedUrlContains: '/s?k=airpods',
        allowedChallengeUrlContains: ['/errors/validateCaptcha', '/ap/signin'],
        preActions: [
            {
                clickSelector:
                    'button:has-text("Continue shopping"), input[type="submit"][value*="Continue shopping"]',
            },
        ],
    },
    {
        id: 'wikipedia',
        url: 'https://en.wikipedia.org/wiki/Main_Page',
        selector: '#searchInput',
        query: 'airpods',
        expectedUrlContains: '/wiki/AirPods',
    },
    {
        id: 'ebay',
        url: 'https://www.ebay.com',
        selector: '#gh-ac',
        query: 'airpods',
        expectedUrlContains: '/sch/i.html?_nkw=airpods',
        allowedChallengeUrlContains: ['/splashui/challenge'],
    },
    {
        id: 'target',
        url: 'https://www.target.com',
        selector: '#search',
        query: 'airpods',
        expectedUrlContains: '/s?searchTerm=airpods',
    },
    {
        id: 'walmart',
        url: 'https://www.walmart.com',
        selector: 'input[name="q"]',
        query: 'airpods',
        expectedUrlContains: '/search?q=airpods',
    },
    {
        id: 'flexport',
        url: 'https://www.flexport.com',
        selector: 'input[aria-label="Search"]',
        query: 'airpods',
        expectedUrlContains: '/search/?q=airpods',
        maxElapsedMs: 7000,
        preActions: [
            {
                clickSelector: 'button[aria-label="Show search panel"]',
            },
        ],
    },
]

describeExternalWaitSmoke('integration/external-wait-smoke', () => {
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

    for (const scenario of scenarios) {
        it(
            `keeps ${scenario.id} search submission responsive`,
            async () => {
                await page.goto(scenario.url, { waitUntil: 'domcontentloaded' })

                for (const action of scenario.preActions ?? []) {
                    const locator = page.locator(action.clickSelector).first()
                    const canClick = await locator
                        .isVisible({ timeout: 10000 })
                        .catch(() => false)
                    if (canClick) {
                        await locator.click().catch(() => undefined)
                    }
                }

                const activeSelector = await waitForAnyVisibleSelector(
                    page,
                    scenario.selectorCandidates ?? [scenario.selector],
                    25000
                )

                if (!activeSelector) {
                    const currentUrl = page.url()
                    const challengeMatched =
                        scenario.allowedChallengeUrlContains?.some((fragment) =>
                            currentUrl.includes(fragment)
                        ) ?? false

                    if (challengeMatched || (await hasChallengeMarkers(page))) {
                        return
                    }

                    throw new Error(
                        `No visible selector matched and no challenge marker detected for ${scenario.id}`
                    )
                }

                const opensteer = Opensteer.from(page, {
                    name: `external-wait-${scenario.id}`,
                })

                const startedAt = Date.now()
                await opensteer.input({
                    selector: activeSelector,
                    text: scenario.query,
                    pressEnter: true,
                })
                const elapsed = Date.now() - startedAt

                const currentUrl = page.url()
                const challengeMatched =
                    scenario.allowedChallengeUrlContains?.some((fragment) =>
                        currentUrl.includes(fragment)
                    ) ?? false

                if (!challengeMatched) {
                    expect(currentUrl).toContain(scenario.expectedUrlContains)
                }
                expect(elapsed).toBeLessThan(scenario.maxElapsedMs ?? 6000)
            },
            { timeout: 45000 }
        )
    }
})

async function waitForAnyVisibleSelector(
    page: Page,
    selectors: string[],
    timeoutMs: number
): Promise<string | null> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
        for (const selector of selectors) {
            const locator = page.locator(selector).first()
            if ((await locator.count()) === 0) continue

            if (await locator.isVisible().catch(() => false)) {
                return selector
            }
        }

        await page.waitForTimeout(150)
    }

    return null
}

async function hasChallengeMarkers(page: Page): Promise<boolean> {
    const bodyText = await page
        .textContent('body')
        .catch(() => '')
        .then((value) => (value ?? '').toLowerCase())

    if (!bodyText) return false
    return (
        bodyText.includes('enter the characters you see below') ||
        bodyText.includes('type the characters you see in this image') ||
        bodyText.includes('unusual traffic') ||
        bodyText.includes('captcha')
    )
}
