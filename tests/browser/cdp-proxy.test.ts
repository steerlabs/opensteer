import { createServer, type Server, type ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import {
    CDPProxy,
    createBlankTarget,
    discoverTargets,
} from '../../src/browser/cdp-proxy.js'

describe('discoverTargets', () => {
    const servers: Server[] = []

    afterEach(async () => {
        while (servers.length > 0) {
            const server = servers.pop()
            if (!server) continue
            await closeHttpServer(server)
        }
    })

    it('discovers browser websocket URL and filters page targets', async () => {
        const server = createServer((req, res) => {
            if (req.url === '/json/version') {
                sendJson(res, {
                    webSocketDebuggerUrl:
                        'ws://127.0.0.1:9222/devtools/browser/root',
                })
                return
            }

            if (req.url === '/json') {
                sendJson(res, [
                    {
                        id: 'page-http',
                        type: 'page',
                        title: 'Example',
                        url: 'https://example.com',
                        webSocketDebuggerUrl: 'ws://target-1',
                    },
                    {
                        id: 'page-blank',
                        type: 'page',
                        title: 'Blank',
                        url: 'about:blank',
                        webSocketDebuggerUrl: 'ws://target-2',
                    },
                    {
                        id: 'page-chrome',
                        type: 'page',
                        title: 'Chrome Internal',
                        url: 'chrome://settings',
                        webSocketDebuggerUrl: 'ws://target-3',
                    },
                    {
                        id: 'service-worker',
                        type: 'service_worker',
                        title: 'Worker',
                        url: 'https://example.com/worker.js',
                        webSocketDebuggerUrl: 'ws://target-4',
                    },
                ])
                return
            }

            res.statusCode = 404
            res.end('not found')
        })

        await listenHttpServer(server)
        servers.push(server)

        const port = getServerPort(server)

        const discovered = await discoverTargets(
            `ws://127.0.0.1:${port}/devtools/browser/random`
        )

        expect(discovered.browserWsUrl).toBe(
            'ws://127.0.0.1:9222/devtools/browser/root'
        )
        expect(discovered.targets).toEqual([
            {
                id: 'page-http',
                title: 'Example',
                url: 'https://example.com',
                webSocketDebuggerUrl: 'ws://target-1',
            },
            {
                id: 'page-blank',
                title: 'Blank',
                url: 'about:blank',
                webSocketDebuggerUrl: 'ws://target-2',
            },
        ])
    })

    it('throws a clear error when /json/version misses browser websocket URL', async () => {
        const server = createServer((req, res) => {
            if (req.url === '/json/version') {
                sendJson(res, {})
                return
            }

            if (req.url === '/json') {
                sendJson(res, [])
                return
            }

            res.statusCode = 404
            res.end('not found')
        })

        await listenHttpServer(server)
        servers.push(server)

        const port = getServerPort(server)

        await expect(
            discoverTargets(`http://127.0.0.1:${port}`)
        ).rejects.toThrow(
            'CDP endpoint /json/version did not include webSocketDebuggerUrl.'
        )
    })
})

describe('CDPProxy', () => {
    const servers: WebSocketServer[] = []
    const sockets: WebSocket[] = []

    afterEach(async () => {
        while (sockets.length > 0) {
            const socket = sockets.pop()
            if (!socket) continue
            await closeSocket(socket)
        }

        while (servers.length > 0) {
            const server = servers.pop()
            if (!server) continue
            await closeWsServer(server)
        }
    })

    it('forwards only the selected target session and unblocks filtered targets', async () => {
        const browserMessages: Record<string, unknown>[] = []
        let resolveBrowserSocket: ((socket: WebSocket) => void) | null = null
        const browserSocketReady = new Promise<WebSocket>((resolve) => {
            resolveBrowserSocket = resolve
        })

        const browserServer = new WebSocketServer({
            host: '127.0.0.1',
            port: 0,
        })
        servers.push(browserServer)

        browserServer.on('connection', (socket) => {
            sockets.push(socket)
            resolveBrowserSocket?.(socket)
            resolveBrowserSocket = null

            socket.on('message', (rawData) => {
                const payload = JSON.parse(rawData.toString()) as Record<
                    string,
                    unknown
                >
                browserMessages.push(payload)

                if (payload.method === 'Runtime.runIfWaitingForDebugger') {
                    socket.send(
                        JSON.stringify({
                            id: payload.id,
                            result: {},
                        })
                    )
                }
            })
        })

        await waitForListening(browserServer)
        const browserPort = getWsServerPort(browserServer)

        const proxy = new CDPProxy(
            `ws://127.0.0.1:${browserPort}/devtools/browser/root`,
            'keep-target'
        )
        const proxyUrl = await proxy.start()

        const client = new WebSocket(proxyUrl)
        sockets.push(client)
        const clientMessages: Record<string, unknown>[] = []

        client.on('message', (rawData) => {
            clientMessages.push(
                JSON.parse(rawData.toString()) as Record<string, unknown>
            )
        })

        try {
            await waitForOpen(client)
            const activeBrowserSocket = await browserSocketReady

            activeBrowserSocket.send(
                JSON.stringify({
                    method: 'Target.attachedToTarget',
                    params: {
                        sessionId: 'allowed-session',
                        targetInfo: {
                            targetId: 'keep-target',
                            type: 'page',
                        },
                        waitingForDebugger: false,
                    },
                })
            )

            activeBrowserSocket.send(
                JSON.stringify({
                    method: 'Target.attachedToTarget',
                    params: {
                        sessionId: 'blocked-session',
                        targetInfo: {
                            targetId: 'other-target',
                            type: 'page',
                        },
                        waitingForDebugger: true,
                    },
                })
            )

            activeBrowserSocket.send(
                JSON.stringify({
                    method: 'Runtime.executionContextCreated',
                    sessionId: 'blocked-session',
                    params: {},
                })
            )

            activeBrowserSocket.send(
                JSON.stringify({
                    method: 'Page.frameNavigated',
                    sessionId: 'allowed-session',
                    params: {},
                })
            )

            await waitFor(() =>
                browserMessages.some(
                    (message) =>
                        message.method === 'Runtime.runIfWaitingForDebugger' &&
                        message.sessionId === 'blocked-session'
                )
            )

            await waitFor(() =>
                clientMessages.some(
                    (message) =>
                        message.method === 'Page.frameNavigated' &&
                        message.sessionId === 'allowed-session'
                )
            )

            expect(
                clientMessages.some(
                    (message) =>
                        message.method === 'Target.attachedToTarget' &&
                        asObject(message.params)?.sessionId === 'allowed-session'
                )
            ).toBe(true)

            expect(
                clientMessages.some(
                    (message) =>
                        message.method === 'Target.attachedToTarget' &&
                        asObject(message.params)?.sessionId === 'blocked-session'
                )
            ).toBe(false)

            expect(
                clientMessages.some(
                    (message) => message.sessionId === 'blocked-session'
                )
            ).toBe(false)
        } finally {
            proxy.close()
        }
    })
})

describe('createBlankTarget', () => {
    const servers: WebSocketServer[] = []
    const sockets: WebSocket[] = []

    afterEach(async () => {
        while (sockets.length > 0) {
            const socket = sockets.pop()
            if (!socket) continue
            await closeSocket(socket)
        }

        while (servers.length > 0) {
            const server = servers.pop()
            if (!server) continue
            await closeWsServer(server)
        }
    })

    it('creates an about:blank target through the browser websocket', async () => {
        const browserMessages: Record<string, unknown>[] = []
        const browserServer = new WebSocketServer({
            host: '127.0.0.1',
            port: 0,
        })
        servers.push(browserServer)

        browserServer.on('connection', (socket) => {
            sockets.push(socket)

            socket.on('message', (rawData) => {
                const payload = JSON.parse(rawData.toString()) as Record<
                    string,
                    unknown
                >
                browserMessages.push(payload)

                if (payload.method === 'Target.createTarget') {
                    socket.send(
                        JSON.stringify({
                            id: payload.id,
                            result: {
                                targetId: 'blank-target',
                            },
                        })
                    )
                }
            })
        })

        await waitForListening(browserServer)
        const browserPort = getWsServerPort(browserServer)

        await expect(
            createBlankTarget(
                `ws://127.0.0.1:${browserPort}/devtools/browser/root`
            )
        ).resolves.toBe('blank-target')

        expect(browserMessages).toContainEqual({
            id: 1,
            method: 'Target.createTarget',
            params: {
                url: 'about:blank',
            },
        })
    })
})

function sendJson(
    response: ServerResponse,
    payload: unknown
): void {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(payload))
}

async function listenHttpServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve())
        server.once('error', reject)
    })
}

function getServerPort(server: Server): number {
    const address = server.address()
    if (!address || typeof address === 'string') {
        throw new Error('Expected server to expose a TCP port.')
    }
    return address.port
}

async function closeHttpServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error)
                return
            }
            resolve()
        })
    })
}

async function waitForListening(server: WebSocketServer): Promise<void> {
    if (server.address()) return

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
}

function getWsServerPort(server: WebSocketServer): number {
    const address = server.address()
    if (!address || typeof address === 'string') {
        throw new Error('Expected websocket server to expose a TCP port.')
    }
    return address.port
}

async function closeWsServer(server: WebSocketServer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error)
                return
            }
            resolve()
        })
    })
}

async function closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return

    await new Promise<void>((resolve) => {
        socket.once('close', () => resolve())
        socket.close()
    })
}

async function waitForOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) return

    await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
            socket.off('error', onError)
            resolve()
        }

        const onError = (error: Error) => {
            socket.off('open', onOpen)
            reject(error)
        }

        socket.once('open', onOpen)
        socket.once('error', onError)
    })
}

async function waitFor(
    condition: () => boolean,
    timeoutMs: number = 2_000
): Promise<void> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
        if (condition()) {
            return
        }
        await delay(10)
    }

    throw new Error('Timed out waiting for condition.')
}

function asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}
