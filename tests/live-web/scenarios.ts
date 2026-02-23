import type { Frame, Page } from 'playwright'
import type {
    LiveWebScenario,
    ScenarioContext,
    ScenarioResult,
    ScenarioStepTrace,
} from './types.js'

function normalizeText(value: string | null | undefined): string {
    return (value || '').replace(/\s+/g, ' ').trim()
}

async function waitForFrameByName(
    page: Page,
    frameName: string,
    timeoutMs = 15000
): Promise<Frame> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
        const frame = page.frame({ name: frameName })
        if (frame) {
            return frame
        }
        await page.waitForTimeout(100)
    }

    throw new Error(`Timed out waiting for frame named "${frameName}".`)
}

async function getShoelaceSwitchState(
    page: Page,
    label: string
): Promise<boolean | null> {
    return page.evaluate((target) => {
        const switches = Array.from(document.querySelectorAll('sl-switch'))
        const match = switches.find(
            (element) =>
                element.textContent?.replace(/\s+/g, ' ').trim() === target
        )

        return match ? match.hasAttribute('checked') : null
    }, label)
}

async function getShoelaceDetailsStates(
    page: Page,
    summaries: string[]
): Promise<Record<string, boolean>> {
    return page.evaluate((targets) => {
        const state: Record<string, boolean> = {}

        for (const summary of targets) {
            const details = document.querySelector(
                `sl-details[summary="${summary}"]`
            )
            state[summary] = Boolean(details?.hasAttribute('open'))
        }

        return state
    }, summaries)
}

async function getFrameParagraphColor(frame: Frame): Promise<string> {
    const color = await frame.$eval(
        'p',
        (element) => getComputedStyle(element).color
    )

    return normalizeText(color)
}

async function waitForColorChange(
    page: Page,
    frame: Frame,
    previousColor: string,
    timeoutMs = 5000
): Promise<string> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
        const currentColor = await getFrameParagraphColor(frame)
        if (currentColor !== previousColor && currentColor.length > 0) {
            return currentColor
        }

        await page.waitForTimeout(200)
    }

    return getFrameParagraphColor(frame)
}

const wikipediaSearchScenario: LiveWebScenario = {
    id: 'wikipedia-search',
    title: 'Resolve search input and submit action on Wikipedia',
    websiteUrl: 'https://en.wikipedia.org/wiki/Main_Page',
    run: async ({ page, opensteer }: ScenarioContext): Promise<ScenarioResult> => {
        const traces: ScenarioStepTrace[] = []

        await page.goto('https://en.wikipedia.org/wiki/Main_Page', {
            waitUntil: 'domcontentloaded',
        })
        await page.waitForSelector('#searchInput', { timeout: 15000 })

        const beforeUrl = page.url()
        const beforeTitle = await page.title()

        traces.push({
            step: 'goto-main-page',
            action: 'goto',
            description: 'Navigate to Wikipedia main page',
            outcome: { url: beforeUrl },
        })

        const inputResult = await opensteer.input({
            description:
                'The main Wikipedia search input with id searchInput at the top of the page',
            text: 'Ada Lovelace',
        })

        traces.push({
            step: 'input-search-query',
            action: 'input',
            description: 'Type Ada Lovelace into the primary search field',
            outcome: inputResult,
        })

        const clickResult = await opensteer.click({
            description:
                'The Search button next to the main Wikipedia search input',
        })

        traces.push({
            step: 'submit-search',
            action: 'click',
            description: 'Submit search query',
            outcome: clickResult,
        })

        await page.waitForLoadState('domcontentloaded')
        await page.waitForFunction(
            () => location.pathname.includes('/wiki/Ada_Lovelace'),
            undefined,
            { timeout: 15000 }
        )

        const heading = normalizeText(
            await page.locator('#firstHeading').first().textContent()
        )
        const afterUrl = page.url()
        const afterTitle = await page.title()

        const checks = [
            {
                name: 'navigated-to-ada-page',
                ok: afterUrl.includes('/wiki/Ada_Lovelace'),
                expected: 'URL contains /wiki/Ada_Lovelace',
                actual: afterUrl,
            },
            {
                name: 'heading-is-ada-lovelace',
                ok: heading === 'Ada Lovelace',
                expected: 'Heading equals Ada Lovelace',
                actual: heading || '<empty>',
            },
        ]

        return {
            traces,
            checks,
            evidence: {
                beforeUrl,
                afterUrl,
                beforeTitle,
                afterTitle,
                extractedData: {
                    heading,
                },
            },
        }
    },
}

const githubDocsNavigationScenario: LiveWebScenario = {
    id: 'github-docs-navigation',
    title: 'Resolve docs navigation link on GitHub Docs',
    websiteUrl: 'https://docs.github.com/en',
    run: async ({ page, opensteer }: ScenarioContext): Promise<ScenarioResult> => {
        const traces: ScenarioStepTrace[] = []

        await page.goto('https://docs.github.com/en', {
            waitUntil: 'domcontentloaded',
        })
        await page.waitForSelector('a[href="/en/get-started"]', {
            timeout: 15000,
        })

        const beforeUrl = page.url()
        const beforeTitle = await page.title()

        traces.push({
            step: 'goto-docs-home',
            action: 'goto',
            description: 'Navigate to GitHub Docs homepage',
            outcome: { url: beforeUrl },
        })

        const clickResult = await opensteer.click({
            description:
                'The Get started link in the primary GitHub Docs navigation menu',
        })

        traces.push({
            step: 'click-get-started-link',
            action: 'click',
            description: 'Open the Get started section',
            outcome: clickResult,
        })

        await page.waitForLoadState('domcontentloaded')
        await page.waitForFunction(
            () => location.pathname === '/en/get-started',
            undefined,
            { timeout: 15000 }
        )

        const heading = normalizeText(
            await page.locator('h1').first().textContent()
        )
        const afterUrl = page.url()
        const afterTitle = await page.title()

        const checks = [
            {
                name: 'navigated-to-get-started',
                ok: afterUrl.includes('/en/get-started'),
                expected: 'URL contains /en/get-started',
                actual: afterUrl,
            },
            {
                name: 'heading-has-get-started',
                ok: heading.includes('Get started with GitHub documentation'),
                expected:
                    'Heading contains "Get started with GitHub documentation"',
                actual: heading || '<empty>',
            },
        ]

        return {
            traces,
            checks,
            evidence: {
                beforeUrl,
                afterUrl,
                beforeTitle,
                afterTitle,
                extractedData: {
                    heading,
                },
            },
        }
    },
}

const jsFiddleIframeScenario: LiveWebScenario = {
    id: 'jsfiddle-iframe-toggle',
    title: 'Resolve and click control inside JSFiddle result iframe',
    websiteUrl: 'https://jsfiddle.net/boilerplate/jquery',
    run: async ({ page, opensteer }: ScenarioContext): Promise<ScenarioResult> => {
        const traces: ScenarioStepTrace[] = []

        await page.goto('https://jsfiddle.net/boilerplate/jquery', {
            waitUntil: 'domcontentloaded',
        })

        const frame = await waitForFrameByName(page, 'result', 20000)
        await frame.waitForSelector('button', { timeout: 15000 })

        const beforeUrl = page.url()
        const beforeTitle = await page.title()
        const beforeColor = await getFrameParagraphColor(frame)

        traces.push({
            step: 'goto-jsfiddle',
            action: 'goto',
            description: 'Navigate to JSFiddle jQuery boilerplate example',
            outcome: { url: beforeUrl, frameUrl: frame.url() },
        })

        const clickResult = await opensteer.click({
            description:
                'The Change color button inside the result preview iframe',
        })

        traces.push({
            step: 'click-frame-button',
            action: 'click',
            description: 'Toggle paragraph color by clicking the iframe button',
            outcome: clickResult,
        })

        const afterColor = await waitForColorChange(page, frame, beforeColor)
        const frameParagraph = normalizeText(
            await frame.locator('p').first().textContent()
        )
        const afterUrl = page.url()
        const afterTitle = await page.title()

        const checks = [
            {
                name: 'paragraph-color-changed',
                ok: beforeColor !== afterColor,
                expected: 'Paragraph color changes after clicking button',
                actual: `before=${beforeColor || '<empty>'}, after=${afterColor || '<empty>'}`,
            },
            {
                name: 'paragraph-text-stable',
                ok: frameParagraph === 'Hello World',
                expected: 'Iframe paragraph text equals Hello World',
                actual: frameParagraph || '<empty>',
            },
        ]

        return {
            traces,
            checks,
            evidence: {
                beforeUrl,
                afterUrl,
                beforeTitle,
                afterTitle,
                extractedData: {
                    frameUrl: frame.url(),
                    beforeColor,
                    afterColor,
                    frameParagraph,
                },
            },
        }
    },
}

const shoelaceSwitchScenario: LiveWebScenario = {
    id: 'shoelace-shadow-switch',
    title: 'Resolve shadow host toggle on Shoelace switch docs',
    websiteUrl: 'https://shoelace.style/components/switch',
    run: async ({ page, opensteer }: ScenarioContext): Promise<ScenarioResult> => {
        const traces: ScenarioStepTrace[] = []

        await page.goto('https://shoelace.style/components/switch', {
            waitUntil: 'domcontentloaded',
        })
        await page.waitForSelector('sl-switch', { timeout: 15000 })

        const beforeUrl = page.url()
        const beforeTitle = await page.title()
        const beforeState = await getShoelaceSwitchState(page, 'Switch')

        traces.push({
            step: 'goto-shoelace-switch',
            action: 'goto',
            description: 'Navigate to Shoelace switch docs page',
            outcome: { url: beforeUrl },
        })

        const clickResult = await opensteer.click({
            description:
                'The Switch toggle labeled Switch on the Shoelace Switch page',
        })

        traces.push({
            step: 'toggle-switch',
            action: 'click',
            description: 'Toggle the primary switch component',
            outcome: clickResult,
        })

        const afterState = await getShoelaceSwitchState(page, 'Switch')
        const afterUrl = page.url()
        const afterTitle = await page.title()

        const checks = [
            {
                name: 'switch-exists',
                ok: beforeState !== null,
                expected: 'Switch labeled "Switch" exists',
                actual: String(beforeState),
            },
            {
                name: 'switch-became-checked',
                ok: beforeState === false && afterState === true,
                expected: 'Switch changes from unchecked to checked',
                actual: `before=${String(beforeState)}, after=${String(afterState)}`,
            },
        ]

        return {
            traces,
            checks,
            evidence: {
                beforeUrl,
                afterUrl,
                beforeTitle,
                afterTitle,
                extractedData: {
                    beforeState,
                    afterState,
                },
            },
        }
    },
}

const shoelaceDetailsScenario: LiveWebScenario = {
    id: 'shoelace-shadow-accordion',
    title: 'Resolve shadow-backed accordion disambiguation on Shoelace details docs',
    websiteUrl: 'https://shoelace.style/components/details',
    run: async ({ page, opensteer }: ScenarioContext): Promise<ScenarioResult> => {
        const traces: ScenarioStepTrace[] = []

        await page.goto('https://shoelace.style/components/details', {
            waitUntil: 'domcontentloaded',
        })
        await page.waitForSelector('sl-details[summary="Second"]', {
            timeout: 15000,
        })

        const beforeUrl = page.url()
        const beforeTitle = await page.title()
        const beforeStates = await getShoelaceDetailsStates(page, [
            'First',
            'Second',
        ])

        traces.push({
            step: 'goto-shoelace-details',
            action: 'goto',
            description: 'Navigate to Shoelace details docs page',
            outcome: { url: beforeUrl },
        })

        const clickResult = await opensteer.click({
            description:
                'The Second details accordion header in the group with First, Second, and Third',
        })

        traces.push({
            step: 'open-second-item',
            action: 'click',
            description: 'Open the Second accordion item',
            outcome: clickResult,
        })

        const afterStates = await getShoelaceDetailsStates(page, [
            'First',
            'Second',
        ])
        const afterUrl = page.url()
        const afterTitle = await page.title()

        const checks = [
            {
                name: 'initial-state-first-open',
                ok: beforeStates.First === true,
                expected: 'First item is open initially',
                actual: String(beforeStates.First),
            },
            {
                name: 'second-open-first-closed-after-click',
                ok: afterStates.Second === true && afterStates.First === false,
                expected: 'Second is open and First is closed after click',
                actual: `First=${String(afterStates.First)}, Second=${String(afterStates.Second)}`,
            },
        ]

        return {
            traces,
            checks,
            evidence: {
                beforeUrl,
                afterUrl,
                beforeTitle,
                afterTitle,
                extractedData: {
                    beforeStates,
                    afterStates,
                },
            },
        }
    },
}

const hackerNewsExtractScenario: LiveWebScenario = {
    id: 'hacker-news-live-extract',
    title: 'Extract first live headline on Hacker News',
    websiteUrl: 'https://news.ycombinator.com/',
    run: async ({ page, opensteer }: ScenarioContext): Promise<ScenarioResult> => {
        const traces: ScenarioStepTrace[] = []

        await page.goto('https://news.ycombinator.com/', {
            waitUntil: 'domcontentloaded',
        })
        await page.waitForSelector('.athing .titleline a', { timeout: 15000 })

        const beforeUrl = page.url()
        const beforeTitle = await page.title()
        const expectedTitle = normalizeText(
            await page.locator('.athing .titleline a').first().textContent()
        )

        traces.push({
            step: 'goto-hacker-news',
            action: 'goto',
            description: 'Navigate to Hacker News homepage',
            outcome: { url: beforeUrl },
        })

        const extracted = await opensteer.extract<{ title: string }>({
            description:
                'Extract the title text of the first story item in the Hacker News list',
            schema: {
                title: 'string',
            },
        })

        const extractedTitle = normalizeText(
            typeof extracted.title === 'string' ? extracted.title : ''
        )

        traces.push({
            step: 'extract-first-title',
            action: 'extract',
            description: 'Extract the first story title',
            outcome: extracted,
        })

        const afterUrl = page.url()
        const afterTitle = await page.title()

        const checks = [
            {
                name: 'baseline-title-not-empty',
                ok: expectedTitle.length > 0,
                expected: 'Baseline first story title is non-empty',
                actual: expectedTitle || '<empty>',
            },
            {
                name: 'extracted-title-matches-baseline',
                ok: extractedTitle === expectedTitle,
                expected: 'Extracted title matches first live story title',
                actual: `expected=${expectedTitle || '<empty>'}, extracted=${extractedTitle || '<empty>'}`,
            },
        ]

        return {
            traces,
            checks,
            evidence: {
                beforeUrl,
                afterUrl,
                beforeTitle,
                afterTitle,
                extractedData: {
                    expectedTitle,
                    extractedTitle,
                },
            },
        }
    },
}

export const liveWebScenarios: LiveWebScenario[] = [
    wikipediaSearchScenario,
    githubDocsNavigationScenario,
    jsFiddleIframeScenario,
    shoelaceSwitchScenario,
    shoelaceDetailsScenario,
    hackerNewsExtractScenario,
]
