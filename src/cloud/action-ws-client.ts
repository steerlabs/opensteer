import WebSocket from 'ws'
import type { RawData } from 'ws'
import type {
    CloudActionMethod,
    CloudActionRequest,
    CloudActionResponse,
} from './contracts.js'
import { OpensteerCloudError } from './errors.js'

interface ActionWsClientOptions {
    url: string
    token: string
    sessionId: string
}

interface PendingRequest {
    resolve(value: unknown): void
    reject(error: Error): void
}

export class ActionWsClient {
    private readonly ws: WebSocket
    private readonly sessionId: string
    private readonly token: string
    private nextRequestId = 1
    private readonly pending = new Map<number, PendingRequest>()
    private closed = false

    private constructor(ws: WebSocket, options: ActionWsClientOptions) {
        this.ws = ws
        this.sessionId = options.sessionId
        this.token = options.token

        ws.on('message', (raw: RawData) => {
            this.handleMessage(raw)
        })

        ws.on('error', (error: Error) => {
            this.rejectAll(
                new OpensteerCloudError(
                    'CLOUD_TRANSPORT_ERROR',
                    `Cloud action websocket error: ${error.message}`
                )
            )
        })

        ws.on('close', () => {
            this.closed = true
            this.rejectAll(
                new OpensteerCloudError(
                    'CLOUD_SESSION_CLOSED',
                    'Cloud action websocket closed.'
                )
            )
        })
    }

    static async connect(options: ActionWsClientOptions): Promise<ActionWsClient> {
        const wsUrl = withTokenQuery(options.url, options.token)
        const ws = new WebSocket(wsUrl)

        await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve())
            ws.once('error', (error: Error) => {
                reject(
                    new OpensteerCloudError(
                        'CLOUD_TRANSPORT_ERROR',
                        `Failed to connect action websocket: ${error.message}`
                    )
                )
            })
        })

        return new ActionWsClient(ws, options)
    }

    async request<T>(
        method: CloudActionMethod,
        args: Record<string, unknown>
    ): Promise<T> {
        if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
            throw new OpensteerCloudError(
                'CLOUD_SESSION_CLOSED',
                'Cloud action websocket is closed.'
            )
        }

        const id = this.nextRequestId
        this.nextRequestId += 1

        const payload: CloudActionRequest = {
            id,
            method,
            args,
            sessionId: this.sessionId,
            token: this.token,
        }

        const resultPromise = new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
        })

        try {
            this.ws.send(JSON.stringify(payload))
        } catch (error) {
            this.pending.delete(id)
            const message =
                error instanceof Error
                    ? error.message
                    : 'Failed to send cloud action request.'
            throw new OpensteerCloudError('CLOUD_TRANSPORT_ERROR', message)
        }

        return await resultPromise
    }

    async close(): Promise<void> {
        if (this.closed) return

        this.closed = true
        await new Promise<void>((resolve) => {
            this.ws.once('close', () => resolve())
            this.ws.close()
        })
    }

    private handleMessage(raw: RawData): void {
        let parsed: CloudActionResponse

        try {
            parsed = JSON.parse(rawDataToUtf8(raw)) as CloudActionResponse
        } catch {
            this.rejectAll(
                new OpensteerCloudError(
                    'CLOUD_TRANSPORT_ERROR',
                    'Invalid cloud action response payload.'
                )
            )
            return
        }

        const pending = this.pending.get(parsed.id)
        if (!pending) return

        this.pending.delete(parsed.id)

        if (parsed.ok) {
            pending.resolve(parsed.result)
            return
        }

        pending.reject(new OpensteerCloudError(parsed.code, parsed.error))
    }

    private rejectAll(error: Error): void {
        const pending = [...this.pending.values()]
        this.pending.clear()

        for (const item of pending) {
            item.reject(error)
        }
    }
}

function rawDataToUtf8(raw: RawData): string {
    if (typeof raw === 'string') return raw
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
    if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
    return raw.toString('utf8')
}

function withTokenQuery(wsUrl: string, token: string): string {
    const url = new URL(wsUrl)
    url.searchParams.set('token', token)
    return url.toString()
}
