import { createServer, type Socket } from 'net'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { Opensteer } from '../opensteer.js'
import type { CliRequest, CliResponse } from './protocol.js'
import { getSocketPath, getPidPath } from './paths.js'
import { getCommandHandler } from './commands.js'

let instance: Opensteer | null = null
let launchPromise: Promise<void> | null = null

const socketPath = getSocketPath()
const pidPath = getPidPath()

function cleanup() {
    try { unlinkSync(socketPath) } catch { /* file may not exist */ }
    try { unlinkSync(pidPath) } catch { /* file may not exist */ }
}

function sendResponse(socket: Socket, response: CliResponse) {
    try {
        socket.write(JSON.stringify(response) + '\n')
    } catch { /* socket may already be closed */ }
}

async function handleRequest(
    request: CliRequest,
    socket: Socket
): Promise<void> {
    const { id, command, args } = request

    if (command === 'open') {
        try {
            const url = args.url as string | undefined
            const headless = args.headless as boolean | undefined
            const name = args.name as string | undefined
            const cdpUrl = args['cdp-url'] as string | undefined
            const channel = args.channel as string | undefined
            const userDataDir = args['user-data-dir'] as string | undefined

            if (!instance) {
                instance = new Opensteer({
                    name: name ?? 'cli',
                    browser: {
                        headless: headless ?? false,
                        cdpUrl,
                        channel,
                        userDataDir,
                    },
                })
                launchPromise = instance.launch({
                    headless: headless ?? false,
                    timeout: cdpUrl ? 120_000 : 30_000,
                })
                try {
                    await launchPromise
                } catch (err) {
                    instance = null
                    throw err
                } finally {
                    launchPromise = null
                }
            } else if (launchPromise) {
                await launchPromise
            }

            if (url) {
                await instance.page.goto(url)
            }

            sendResponse(socket, {
                id,
                ok: true,
                result: { url: instance.page.url() },
            })
        } catch (err) {
            sendResponse(socket, {
                id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            })
        }
        return
    }

    if (command === 'close') {
        try {
            if (instance) {
                await instance.close()
                instance = null
            }
            sendResponse(socket, { id, ok: true, result: {} })
        } catch (err) {
            sendResponse(socket, {
                id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            })
        }
        setTimeout(() => {
            cleanup()
            process.exit(0)
        }, 100)
        return
    }

    if (command === 'ping') {
        sendResponse(socket, { id, ok: true, result: { pong: true } })
        return
    }

    if (!instance) {
        sendResponse(socket, {
            id,
            ok: false,
            error: "No browser session. Call 'opensteer open' first.",
        })
        return
    }

    const handler = getCommandHandler(command)
    if (!handler) {
        sendResponse(socket, {
            id,
            ok: false,
            error: `Unknown command: ${command}`,
        })
        return
    }

    try {
        const result = await handler(instance, args)
        sendResponse(socket, { id, ok: true, result })
    } catch (err) {
        sendResponse(socket, {
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        })
    }
}

if (existsSync(socketPath)) {
    unlinkSync(socketPath)
}

const server = createServer((socket: Socket) => {
    let buffer = ''

    socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
            if (!line.trim()) continue
            try {
                const request = JSON.parse(line) as CliRequest
                handleRequest(request, socket)
            } catch {
                sendResponse(socket, {
                    id: 0,
                    ok: false,
                    error: 'Invalid JSON request',
                })
            }
        }
    })

    socket.on('error', () => { /* client disconnected unexpectedly */ })
})

server.listen(socketPath, () => {
    writeFileSync(pidPath, String(process.pid))

    if (process.send) {
        process.send('ready')
    }
})

server.on('error', (err) => {
    console.error('Server error:', err.message)
    cleanup()
    process.exit(1)
})

async function shutdown() {
    if (instance) {
        try { await instance.close() } catch { /* best-effort cleanup on shutdown */ }
        instance = null
    }
    server.close()
    cleanup()
    process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
