import WebSocket, { WebSocketServer, type RawData } from 'ws'

const CDP_DISCOVERY_TIMEOUT_MS = 3_000
const LOCAL_PROXY_HOST = '127.0.0.1'
const INTERNAL_COMMAND_ID_START = 1_000_000_000

interface CDPMessage {
    id?: unknown
    method?: unknown
    params?: unknown
    sessionId?: unknown
}

export interface CDPPageTarget {
    id: string
    url: string
    title: string
    webSocketDebuggerUrl: string
}

export interface DiscoverTargetsResult {
    browserWsUrl: string
    targets: CDPPageTarget[]
}

export async function discoverTargets(
    cdpUrl: string
): Promise<DiscoverTargetsResult> {
    const baseUrl = resolveHttpDiscoveryBase(cdpUrl)

    const [targetsPayload, versionPayload] = await Promise.all([
        fetchJson(new URL('/json', baseUrl)),
        fetchJson(new URL('/json/version', baseUrl)),
    ])

    return {
        browserWsUrl: readBrowserWsUrl(versionPayload),
        targets: readPageTargets(targetsPayload),
    }
}

export async function createBlankTarget(browserWsUrl: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(browserWsUrl)
        const timeout = setTimeout(() => {
            ws.close()
            reject(new Error('Timed out creating a blank tab via CDP.'))
        }, 5_000)

        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Target.createTarget',
                params: { url: 'about:blank' },
            }))
        })

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(String(data))
                if (msg.id === 1) {
                    clearTimeout(timeout)
                    ws.close()
                    if (msg.error) {
                        reject(new Error(
                            `Target.createTarget failed: ${msg.error.message ?? JSON.stringify(msg.error)}`
                        ))
                        return
                    }
                    const targetId = msg.result?.targetId
                    if (typeof targetId === 'string' && targetId) {
                        resolve(targetId)
                    } else {
                        reject(new Error(
                            'Target.createTarget succeeded but no targetId was returned.'
                        ))
                    }
                }
            } catch {
                // ignore non-JSON or unrelated messages
            }
        })

        ws.on('error', (err) => {
            clearTimeout(timeout)
            ws.close()
            reject(new Error(`Failed to create blank tab: ${String(err)}`))
        })
    })
}

export class CDPProxy {
    private server: WebSocketServer | null = null
    private browserSocket: WebSocket | null = null
    private clientSocket: WebSocket | null = null
    private readonly allowedSessions = new Set<string>()
    private readonly internalCommandIds = new Set<number>()
    private nextInternalCommandId = INTERNAL_COMMAND_ID_START

    constructor(
        private readonly browserWsUrl: string,
        private readonly targetId: string
    ) {}

    async start(): Promise<string> {
        if (this.server) {
            throw new Error('CDP proxy is already running.')
        }

        const server = new WebSocketServer({
            host: LOCAL_PROXY_HOST,
            port: 0,
        })
        this.server = server

        server.on('connection', (socket) => this.handleClientConnection(socket))

        try {
            await new Promise<void>((resolve, reject) => {
                const onListening = () => {
                    server.off('error', onError)
                    resolve()
                }

                const onError = (error: Error) => {
                    server.off('listening', onListening)
                    reject(error)
                }

                server.once('listening', onListening)
                server.once('error', onError)
            })
        } catch (error) {
            this.close()
            throw error
        }

        const address = server.address()
        if (!address || typeof address === 'string') {
            this.close()
            throw new Error('CDP proxy failed to bind to a local TCP port.')
        }

        return `ws://${LOCAL_PROXY_HOST}:${address.port}`
    }

    close(): void {
        this.allowedSessions.clear()
        this.internalCommandIds.clear()

        const clientSocket = this.clientSocket
        this.clientSocket = null
        closeSocket(clientSocket)

        const browserSocket = this.browserSocket
        this.browserSocket = null
        closeSocket(browserSocket)

        const server = this.server
        this.server = null
        if (server) {
            for (const socket of server.clients) {
                closeSocket(socket)
            }
            server.close()
        }
    }

    private handleClientConnection(clientSocket: WebSocket): void {
        if (this.clientSocket) {
            closeSocket(clientSocket, 1013, 'CDP proxy supports a single client.')
            return
        }

        this.allowedSessions.clear()
        this.internalCommandIds.clear()
        this.clientSocket = clientSocket

        const browserSocket = new WebSocket(this.browserWsUrl)
        this.browserSocket = browserSocket

        const pendingClientMessages: Array<{
            data: RawData
            isBinary: boolean
        }> = []

        clientSocket.on('message', (data, isBinary) => {
            if (browserSocket.readyState === WebSocket.OPEN) {
                browserSocket.send(data, { binary: isBinary })
                return
            }

            if (browserSocket.readyState === WebSocket.CONNECTING) {
                pendingClientMessages.push({ data, isBinary })
            }
        })

        clientSocket.on('close', () => {
            if (this.clientSocket === clientSocket) {
                this.clientSocket = null
            }
            this.allowedSessions.clear()
            this.internalCommandIds.clear()
            closeSocket(browserSocket)
        })

        clientSocket.on('error', () => {
            closeSocket(clientSocket)
        })

        browserSocket.on('open', () => {
            for (const message of pendingClientMessages) {
                browserSocket.send(message.data, { binary: message.isBinary })
            }
            pendingClientMessages.length = 0
        })

        browserSocket.on('message', (data, isBinary) => {
            this.handleBrowserMessage(data, isBinary)
        })

        browserSocket.on('close', () => {
            if (this.browserSocket === browserSocket) {
                this.browserSocket = null
            }
            this.allowedSessions.clear()
            this.internalCommandIds.clear()
            closeSocket(clientSocket)
        })

        browserSocket.on('error', () => {
            closeSocket(browserSocket)
        })
    }

    private handleBrowserMessage(data: RawData, isBinary: boolean): void {
        const clientSocket = this.clientSocket
        if (!clientSocket || clientSocket.readyState !== WebSocket.OPEN) {
            return
        }

        if (isBinary) {
            clientSocket.send(data, { binary: true })
            return
        }

        const message = parseMessage(data)
        if (!message) {
            clientSocket.send(data, { binary: false })
            return
        }

        const id = asNumber(message.id)
        if (id !== null && this.internalCommandIds.has(id)) {
            this.internalCommandIds.delete(id)
            return
        }

        if (message.method === 'Target.attachedToTarget') {
            const params = asObject(message.params)
            const sessionId = asString(params?.sessionId)
            const targetInfo = asObject(params?.targetInfo)
            const targetId = asString(targetInfo?.targetId)
            const targetType = asString(targetInfo?.type)
            const waitingForDebugger = params?.waitingForDebugger === true

            if (
                sessionId &&
                (targetType === 'browser' || targetId === this.targetId)
            ) {
                this.allowedSessions.add(sessionId)
                clientSocket.send(data, { binary: false })
                return
            }

            if (sessionId && waitingForDebugger) {
                this.sendRunIfWaitingForDebugger(sessionId)
            }
            return
        }

        if (message.method === 'Target.detachedFromTarget') {
            const params = asObject(message.params)
            const sessionId = asString(params?.sessionId)
            if (sessionId) {
                const wasAllowed = this.allowedSessions.delete(sessionId)
                if (!wasAllowed) {
                    return
                }
            }
            clientSocket.send(data, { binary: false })
            return
        }

        const sessionId = asString(message.sessionId)
        if (sessionId && !this.allowedSessions.has(sessionId)) {
            return
        }

        clientSocket.send(data, { binary: false })
    }

    private sendRunIfWaitingForDebugger(sessionId: string): void {
        const browserSocket = this.browserSocket
        if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
            return
        }

        const id = this.nextInternalCommandId++
        this.internalCommandIds.add(id)

        browserSocket.send(
            JSON.stringify({
                id,
                method: 'Runtime.runIfWaitingForDebugger',
                sessionId,
            }),
            (error) => {
                if (error) {
                    this.internalCommandIds.delete(id)
                }
            }
        )
    }
}

async function fetchJson(url: URL): Promise<unknown> {
    let response: Response
    try {
        response = await fetch(url, {
            signal: AbortSignal.timeout(CDP_DISCOVERY_TIMEOUT_MS),
        })
    } catch (error) {
        throw new Error(
            `Failed to reach CDP discovery endpoint ${url.toString()}: ${errorMessage(
                error
            )}`
        )
    }

    if (!response.ok) {
        throw new Error(
            `CDP discovery endpoint ${url.toString()} returned ${response.status} ${response.statusText}.`
        )
    }

    try {
        return await response.json()
    } catch {
        throw new Error(
            `CDP discovery endpoint ${url.toString()} returned invalid JSON.`
        )
    }
}

function readBrowserWsUrl(payload: unknown): string {
    const value = asString(asObject(payload)?.webSocketDebuggerUrl)
    if (!value) {
        throw new Error(
            'CDP endpoint /json/version did not include webSocketDebuggerUrl.'
        )
    }
    return value
}

function readPageTargets(payload: unknown): CDPPageTarget[] {
    if (!Array.isArray(payload)) {
        throw new Error('CDP endpoint /json did not return a target array.')
    }

    const targets: CDPPageTarget[] = []

    for (const rawTarget of payload) {
        const target = asObject(rawTarget)
        if (!target) continue

        if (target.type !== 'page') continue

        const id = asString(target.id)
        const url = asString(target.url)
        if (!id || !url || !isInspectablePageUrl(url)) continue

        targets.push({
            id,
            url,
            title: asString(target.title) ?? '',
            webSocketDebuggerUrl: asString(target.webSocketDebuggerUrl) ?? '',
        })
    }

    return targets
}

function resolveHttpDiscoveryBase(cdpUrl: string): URL {
    let parsed: URL
    try {
        parsed = new URL(cdpUrl)
    } catch {
        throw new Error(
            `Invalid CDP URL "${cdpUrl}". Use an http(s) or ws(s) CDP endpoint.`
        )
    }

    const normalized = new URL(parsed.toString())
    if (normalized.protocol === 'ws:') {
        normalized.protocol = 'http:'
    } else if (normalized.protocol === 'wss:') {
        normalized.protocol = 'https:'
    } else if (
        normalized.protocol !== 'http:' &&
        normalized.protocol !== 'https:'
    ) {
        throw new Error(
            `Unsupported CDP URL protocol "${parsed.protocol}". Use http(s) or ws(s).`
        )
    }

    normalized.pathname = '/'
    normalized.search = ''
    normalized.hash = ''

    return normalized
}

function isInspectablePageUrl(url: string): boolean {
    return (
        url === 'about:blank' ||
        url.startsWith('http://') ||
        url.startsWith('https://')
    )
}

function parseMessage(data: RawData): CDPMessage | null {
    const text = toUtf8String(data)
    if (!text) return null

    try {
        const value = JSON.parse(text) as unknown
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return null
        }
        return value as CDPMessage
    } catch {
        return null
    }
}

function toUtf8String(data: RawData): string | null {
    if (typeof data === 'string') {
        return data
    }
    if (Buffer.isBuffer(data)) {
        return data.toString('utf8')
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data).toString('utf8')
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data).toString('utf8')
    }
    return null
}

function closeSocket(
    socket: WebSocket | null,
    code?: number,
    reason?: string
): void {
    if (!socket) return
    if (
        socket.readyState === WebSocket.CLOSING ||
        socket.readyState === WebSocket.CLOSED
    ) {
        return
    }
    socket.close(code, reason)
}

function asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' ? value : null
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
