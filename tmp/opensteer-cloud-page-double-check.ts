import path from 'path'
import process from 'process'
import dotenv from 'dotenv'
import { Opensteer } from '/Users/timjang/Desktop/oversteer/opensteer-oss/opensteer/src/opensteer.ts'
import { startTestApp } from '/Users/timjang/Desktop/oversteer/opensteer-oss/opensteer/tests/fixtures/server.ts'

dotenv.config({ path: '/Users/timjang/Desktop/oversteer/opensteer-oss/.env' })
dotenv.config({ path: '/Users/timjang/Desktop/oversteer/opensteer-oss/opensteer/.env' })

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
        await opensteer.goto(`${server.url}/navigation-churn?stage=1`, {
            timeout: 5000,
            settleMs: 120,
        })

        await opensteer.page.waitForSelector('#navigation-churn-input', {
            state: 'visible',
            timeout: 5000,
        })
        checks.waitForSelector = 'ok'

        const stage = (await opensteer.page.textContent('#navigation-churn-stage'))?.trim()
        assert(stage === 'Stage 2', `Expected Stage 2 after churn, got ${stage}`)
        checks.textContent = stage

        await opensteer.page.fill('#navigation-churn-input', 'airpods')
        checks.fill = 'ok'

        await opensteer.page.keyboard.press('Enter')
        checks.keyboardPress = 'ok'

        await opensteer.page.waitForURL(/navigation-churn\?stage=2/)
        checks.waitForURL = opensteer.page.url()

        const inputValue = await opensteer.page.$eval(
            '#navigation-churn-input',
            (el) => (el as HTMLInputElement).value
        )
        assert(inputValue === 'airpods', `Expected input value to be airpods, got ${inputValue}`)
        checks.$eval = inputValue

        await opensteer.page.goto(`${server.url}/iframe`, { waitUntil: 'domcontentloaded' })
        await opensteer.page.waitForSelector('#named-iframe', { timeout: 5000 })
        checks.pageGoto = 'ok'

        const frameOutputBefore = await opensteer.page
            .frameLocator('#named-iframe')
            .locator('#iframe-output')
            .textContent()
        checks.frameBefore = frameOutputBefore?.trim()

        await opensteer.page
            .frameLocator('#named-iframe')
            .locator('#iframe-input')
            .fill('inside-cloud')
        await opensteer.page
            .frameLocator('#named-iframe')
            .locator('#iframe-submit-btn')
            .click()

        await opensteer.page.waitForFunction(() => {
            const frame = document.querySelector<HTMLIFrameElement>('#named-iframe')
            if (!frame) return false
            const doc = frame.contentDocument
            if (!doc) return false
            const text = doc.querySelector('#iframe-output')?.textContent ?? ''
            return text.includes('inside-cloud')
        })
        checks.waitForFunction = 'ok'

        const frameOutputAfter = await opensteer.page
            .frameLocator('#named-iframe')
            .locator('#iframe-output')
            .textContent()
        assert(
            (frameOutputAfter ?? '').includes('inside-cloud'),
            `Expected iframe output update, got ${frameOutputAfter}`
        )
        checks.frameLocator = frameOutputAfter?.trim()

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
        await opensteer.close()
        await server.close()
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
        const opensteer = new Opensteer({
            name: `cloud-amazon-page-check-${i + 1}`,
            storage: { rootDir: process.cwd() },
            cloud: true,
        })

        try {
            await opensteer.launch({ headless: true })
            const sessionId = opensteer.cloudSession?.sessionId
            if (sessionId) sessions.push(sessionId)

            await opensteer.goto('https://www.amazon.com', {
                timeout: 30000,
                settleMs: 300,
            })

            await opensteer.page.waitForSelector('input[type="text"]', {
                timeout: 20000,
            })

            passed += 1
        } catch (error) {
            failures.push({
                attempt: i + 1,
                error: error instanceof Error ? error.message : String(error),
            })
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
