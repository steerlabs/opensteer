import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
} from 'playwright'
import { OpensteerCloudError } from './errors.js'
import { withTokenQuery } from './ws-url.js'

export interface CloudCdpConnectArgs {
    wsUrl: string
    token: string
}

export interface CloudCdpConnection {
    browser: Browser
    context: BrowserContext
    page: Page
}

export class CloudCdpClient {
    async connect(args: CloudCdpConnectArgs): Promise<CloudCdpConnection> {
        const endpoint = withTokenQuery(args.wsUrl, args.token)

        let browser: Browser
        try {
            browser = await chromium.connectOverCDP(endpoint)
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : 'Failed to connect to cloud CDP endpoint.'
            throw new OpensteerCloudError('CLOUD_TRANSPORT_ERROR', message)
        }

        const contexts = browser.contexts()
        const context = contexts[0]
        if (!context) {
            await browser.close()
            throw new OpensteerCloudError(
                'CLOUD_INTERNAL',
                'Cloud browser returned no context.'
            )
        }

        const preferred = selectPreferredContextPage(browser, contexts)
        if (preferred) {
            return preferred
        }

        const page = context.pages()[0] || (await context.newPage())

        return { browser, context, page }
    }
}

function selectPreferredContextPage(
    browser: Browser,
    contexts: BrowserContext[]
): CloudCdpConnection | null {
    let aboutBlankCandidate: CloudCdpConnection | null = null

    for (const context of contexts) {
        for (const page of context.pages()) {
            const url = safePageUrl(page)

            if (!isInternalOrEmptyUrl(url)) {
                return { browser, context, page }
            }

            if (!aboutBlankCandidate && url === 'about:blank') {
                aboutBlankCandidate = { browser, context, page }
            }
        }
    }

    return aboutBlankCandidate
}

function safePageUrl(page: Page): string {
    try {
        return page.url()
    } catch {
        return ''
    }
}

function isInternalOrEmptyUrl(url: string): boolean {
    if (!url) return true
    if (url === 'about:blank') return true
    return (
        url.startsWith('chrome://') ||
        url.startsWith('devtools://') ||
        url.startsWith('edge://')
    )
}
