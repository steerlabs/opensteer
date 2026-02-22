import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
} from 'playwright'
import { OpensteerRemoteError } from './errors.js'

export interface RemoteCdpConnectArgs {
    wsUrl: string
    token: string
}

export interface RemoteCdpConnection {
    browser: Browser
    context: BrowserContext
    page: Page
}

export class RemoteCdpClient {
    async connect(args: RemoteCdpConnectArgs): Promise<RemoteCdpConnection> {
        const endpoint = withTokenQuery(args.wsUrl, args.token)

        let browser: Browser
        try {
            browser = await chromium.connectOverCDP(endpoint)
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : 'Failed to connect to remote CDP endpoint.'
            throw new OpensteerRemoteError('REMOTE_TRANSPORT_ERROR', message)
        }

        const context = browser.contexts()[0]
        if (!context) {
            await browser.close()
            throw new OpensteerRemoteError(
                'REMOTE_INTERNAL',
                'Remote browser returned no context.'
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
