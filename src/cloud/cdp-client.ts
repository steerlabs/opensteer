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

        const context = browser.contexts()[0]
        if (!context) {
            await browser.close()
            throw new OpensteerCloudError(
                'CLOUD_INTERNAL',
                'Cloud browser returned no context.'
            )
        }

        const page = context.pages()[0] || (await context.newPage())

        return { browser, context, page }
    }
}

function withTokenQuery(wsUrl: string, token: string): string {
    const url = new URL(wsUrl)
    url.searchParams.set('token', token)
    return url.toString()
}
