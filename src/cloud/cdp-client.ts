import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
} from 'playwright'
import { OpensteerCloudError } from './errors.js'

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
    const candidates: Array<CloudCdpConnection> = []
    const fallbackCandidates: Array<CloudCdpConnection> = []

    for (const context of contexts) {
        for (const page of context.pages()) {
            const url = safePageUrl(page)
            const candidate = { browser, context, page }

            if (!isInternalOrEmptyUrl(url)) {
                candidates.push(candidate)
                continue
            }

            if (url === 'about:blank') {
                fallbackCandidates.push(candidate)
            }
        }
    }

    if (candidates.length > 0) {
        return candidates[0]
    }

    if (fallbackCandidates.length > 0) {
        return fallbackCandidates[0]
    }

    return null
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

function withTokenQuery(wsUrl: string, token: string): string {
    const url = new URL(wsUrl)
    url.searchParams.set('token', token)
    return url.toString()
}
