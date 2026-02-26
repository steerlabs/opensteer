import process from 'process'
import dotenv from 'dotenv'
import { Opensteer } from '/Users/timjang/Desktop/oversteer/opensteer-oss/opensteer/src/opensteer.ts'
import { startTestApp } from '/Users/timjang/Desktop/oversteer/opensteer-oss/opensteer/tests/fixtures/server.ts'

dotenv.config({
    path: '/Users/timjang/Desktop/oversteer/opensteer-oss/.env',
    quiet: true,
})
dotenv.config({
    path: '/Users/timjang/Desktop/oversteer/opensteer-oss/opensteer/.env',
    quiet: true,
})

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

async function runDeterministicCloudPageChecks(): Promise<Record<string, unknown>> {
    const distDir = '/Users/timjang/Desktop/oversteer/opensteer-oss/opensteer/tests/test-app/dist'
    const server = await startTestApp(distDir)

    const opensteer = new Opensteer({
        name: 'cloud-page-api-double-check',
        storage: { rootDir: process.cwd() },
        cloud: true,
    })

    const checks: Record<string, unknown> = {}

    await opensteer.launch({ headless: true })

    try {
        console.log('[deterministic] goto navigation-churn')
        await opensteer.goto(`${server.url}/navigation-churn?stage=1`, {
            timeout: 5000,
            settleMs: 120,
        })

        console.log('[deterministic] waitForSelector')
        await opensteer.page.waitForSelector('#navigation-churn-input', {
            state: 'visible',
            timeout: 5000,
        })
        checks.waitForSelector = 'ok'

        const stage = (await opensteer.page.textContent('#navigation-churn-stage'))?.trim()
        assert(stage === 'Stage 2', `Expected Stage 2 after churn, got ${stage}`)
        checks.textContent = stage

        console.log('[deterministic] fill + keyboard.press + waitForURL')
        await opensteer.page.fill('#navigation-churn-input', 'airpods')
        checks.fill = 'ok'

        await opensteer.page.keyboard.press('Enter')
        checks.keyboardPress = 'ok'

        await opensteer.page.waitForURL(/navigation-churn\?stage=2/, {
            timeout: 5000,
        })
        checks.waitForURL = opensteer.page.url()

        const inputValue = await opensteer.page.$eval(
            '#navigation-churn-input',
            (el) => (el as HTMLInputElement).value
        )
        assert(inputValue === 'airpods', `Expected input value to be airpods, got ${inputValue}`)
        checks.$eval = inputValue

        console.log('[deterministic] iframe frameLocator checks')
        await opensteer.page.goto(`${server.url}/iframe`, { waitUntil: 'domcontentloaded' })
        await opensteer.page.waitForSelector('#named-iframe', { timeout: 5000 })
        checks.pageGoto = 'ok'

        await opensteer.page
            .frameLocator('#named-iframe')
            .locator('#iframe-input')
            .fill('inside-cloud')
        await opensteer.page
            .frameLocator('#named-iframe')
            .locator('#iframe-submit-btn')
            .click()

        const frameOutputAfter = await opensteer.page
            .frameLocator('#named-iframe')
            .locator('#iframe-output')
            .textContent()
        assert(
            (frameOutputAfter ?? '').includes('inside-cloud'),
            `Expected iframe output update, got ${frameOutputAfter}`
        )
        checks.frameLocator = frameOutputAfter?.trim()

        console.log('[deterministic] $$eval + evaluate + title + snapshot compatibility')
        await opensteer.page.goto(`${server.url}/`, { waitUntil: 'domcontentloaded' })
        const linkCount = await opensteer.page.$$eval('a[href]', (nodes) => nodes.length)
        assert(linkCount > 5, `Expected >5 links, got ${linkCount}`)
        checks.$$eval = linkCount

        const pathname = await opensteer.page.evaluate(() => window.location.pathname)
        assert(pathname === '/', `Expected pathname /, got ${pathname}`)
        checks.evaluate = pathname

        await opensteer.snapshot({ mode: 'action' })
        const title = await opensteer.page.title()
        assert(title.length > 0, 'Expected non-empty title after snapshot')
        checks.title = title

        return checks
    } finally {
        await opensteer.close().catch(() => undefined)
        await server.close().catch(() => undefined)
    }
}

async function runAmazonFlowChecks(attempts: number): Promise<{
    passed: number
    failed: number
    sessions: string[]
    failures: Array<{ attempt: number; error: string }>
}> {
    const sessions: string[] = []
    const failures: Array<{ attempt: number; error: string }> = []
    let passed = 0

    for (let i = 0; i < attempts; i += 1) {
        const attempt = i + 1
        const opensteer = new Opensteer({
            name: `cloud-amazon-page-check-${attempt}`,
            storage: { rootDir: process.cwd() },
            cloud: true,
        })

        try {
            console.log(`[amazon ${attempt}/${attempts}] launch`)
            await opensteer.launch({ headless: true })
            const sessionId = opensteer.cloudSession?.sessionId
            if (sessionId) sessions.push(sessionId)

            console.log(`[amazon ${attempt}/${attempts}] opensteer.goto amazon`) 
            await opensteer.goto('https://www.amazon.com', {
                timeout: 25000,
                settleMs: 300,
            })

            console.log(`[amazon ${attempt}/${attempts}] page.waitForSelector input[type="text"]`)
            await opensteer.page.waitForSelector('input[type="text"]', {
                timeout: 15000,
            })

            passed += 1
            console.log(`[amazon ${attempt}/${attempts}] pass`)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push({
                attempt,
                error: message,
            })
            console.log(`[amazon ${attempt}/${attempts}] fail: ${message}`)
        } finally {
            await opensteer.close().catch(() => undefined)
        }
    }

    return {
        passed,
        failed: attempts - passed,
        sessions,
        failures,
    }
}

async function main(): Promise<void> {
    const deterministic = await runDeterministicCloudPageChecks()
    const amazon = await runAmazonFlowChecks(5)

    const output = {
        deterministic,
        amazon,
        timestamp: new Date().toISOString(),
    }

    console.log(JSON.stringify(output, null, 2))

    if (amazon.failed > 0) {
        process.exitCode = 1
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
