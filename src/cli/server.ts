import { createServer, type Socket } from 'net'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { Opensteer } from '../opensteer.js'
import type { CliRequest, CliResponse } from './protocol.js'
import { getMetadataPath, getPidPath, getSocketPath } from './paths.js'
import { getCommandHandler } from './commands.js'
import { normalizeError } from '../error-normalization.js'
import {
    assertCompatibleCloudProfileBinding,
    normalizeCloudProfileBinding,
    resolveSessionCloudProfileBinding,
    type CloudProfileBinding,
} from './cloud-profile-binding.js'

let instance: Opensteer | null = null
let launchPromise: Promise<void> | null = null
let selectorNamespace: string | null = null
let cloudProfileBinding: CloudProfileBinding | null = null
let cursorEnabledPreference: boolean | null = readCursorPreferenceFromEnv()
let requestQueue: Promise<void> = Promise.resolve()
let shuttingDown = false

function sanitizeNamespace(value: string): string {
    const trimmed = String(value || '').trim()
    if (!trimmed || trimmed === '.' || trimmed === '..') {
        return 'default'
    }

    const replaced = trimmed.replace(/[^a-zA-Z0-9_-]+/g, '_')
    const collapsed = replaced.replace(/_+/g, '_')
    const bounded = collapsed.replace(/^_+|_+$/g, '')

    return bounded || 'default'
}

function invalidateInstance() {
    if (!instance) return
    instance.close().catch(() => {})
    instance = null
    cloudProfileBinding = null
}

function normalizeCursorFlag(value: unknown): boolean | null {
    if (value === undefined || value === null) {
        return null
    }

    if (typeof value === 'boolean') {
        return value
    }

    if (typeof value === 'number') {
        if (value === 1) return true
        if (value === 0) return false
    }

    throw new Error(
        '--cursor must be a boolean value ("true" or "false").'
    )
}

function readCursorPreferenceFromEnv(): boolean | null {
    const value = process.env.OPENSTEER_CURSOR
    if (typeof value !== 'string') {
        return null
    }

    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') {
        return true
    }
    if (normalized === 'false' || normalized === '0') {
        return false
    }

    return null
}

function attachLifecycleListeners(inst: Opensteer) {
    try {
        inst.page.on('close', invalidateInstance)
        inst.context.on('close', invalidateInstance)
    } catch { /* page/context may not be ready yet */ }
}

const sessionEnv = process.env.OPENSTEER_SESSION?.trim()
if (!sessionEnv) {
    process.stderr.write('Missing OPENSTEER_SESSION environment variable.\n')
    process.exit(1)
}
const session = sessionEnv
const logicalSession = process.env.OPENSTEER_LOGICAL_SESSION?.trim() || session
const scopeDir = process.env.OPENSTEER_SCOPE_DIR?.trim() || process.cwd()

const socketPath = getSocketPath(session)
const pidPath = getPidPath(session)

function cleanup() {
    try { unlinkSync(socketPath) } catch { /* file may not exist */ }
    try { unlinkSync(pidPath) } catch { /* file may not exist */ }
    try { unlinkSync(getMetadataPath(session)) } catch { /* file may not exist */ }
}

function beginShutdown() {
    if (shuttingDown) return
    shuttingDown = true
    cleanup()

    server.close(() => {
        process.exit(0)
    })

    setTimeout(() => {
        process.exit(0)
    }, 250).unref()
}

function sendResponse(socket: Socket, response: CliResponse) {
    try {
        socket.write(JSON.stringify(response) + '\n')
    } catch { /* socket may already be closed */ }
}

function enqueueRequest(request: CliRequest, socket: Socket) {
    if (request.command === 'ping') {
        void handleRequest(request, socket)
        return
    }

    requestQueue = requestQueue
        .then(() => handleRequest(request, socket))
        .catch((error) => {
            sendResponse(
                socket,
                buildErrorResponse(
                    request.id,
                    error,
                    'Unexpected server error while handling request.',
                    'CLI_INTERNAL_ERROR'
                )
            )
        })
}

async function handleRequest(
    request: CliRequest,
    socket: Socket
): Promise<void> {
    const { id, command, args } = request

    if (command === 'ping' && shuttingDown) {
        sendResponse(socket, {
            id,
            ok: false,
            error: `Session '${logicalSession}' is shutting down.`,
            errorInfo: {
                message: `Session '${logicalSession}' is shutting down.`,
                code: 'SESSION_SHUTTING_DOWN',
                details: {
                    session: logicalSession,
                    runtimeSession: session,
                    scopeDir,
                },
            },
        })
        return
    }

    if (shuttingDown) {
        sendResponse(socket, {
            id,
            ok: false,
            error: `Session '${logicalSession}' is shutting down. Retry your command.`,
            errorInfo: {
                message: `Session '${logicalSession}' is shutting down. Retry your command.`,
                code: 'SESSION_SHUTTING_DOWN',
                details: {
                    session: logicalSession,
                    runtimeSession: session,
                    scopeDir,
                },
            },
        })
        return
    }

    if (command === 'open') {
        try {
            const url = args.url as string | undefined
            const headless = args.headless as boolean | undefined
            const connectUrl = args['connect-url'] as string | undefined
            const channel = args.channel as string | undefined
            const profileDir = args['profile-dir'] as string | undefined
            const cloudProfileId =
                typeof args['cloud-profile-id'] === 'string'
                    ? args['cloud-profile-id'].trim()
                    : undefined
            const cloudProfileReuseIfActive =
                typeof args['cloud-profile-reuse-if-active'] === 'boolean'
                    ? args['cloud-profile-reuse-if-active']
                    : undefined
            const requestedCloudProfileBinding = normalizeCloudProfileBinding({
                profileId: cloudProfileId,
                reuseIfActive: cloudProfileReuseIfActive,
            })
            if (cloudProfileReuseIfActive !== undefined && !cloudProfileId) {
                throw new Error(
                    '--cloud-profile-reuse-if-active requires --cloud-profile-id.'
                )
            }
            const requestedCursor = normalizeCursorFlag(args.cursor)
            const requestedName =
                typeof args.name === 'string' && args.name.trim().length > 0
                    ? sanitizeNamespace(args.name)
                    : null

            if (requestedCursor !== null) {
                cursorEnabledPreference = requestedCursor
            }

            const effectiveCursorEnabled =
                cursorEnabledPreference !== null ? cursorEnabledPreference : true

            if (
                selectorNamespace &&
                requestedName &&
                requestedName !== selectorNamespace
            ) {
                sendResponse(socket, {
                    id,
                    ok: false,
                    error: `Session '${logicalSession}' is already bound to selector namespace '${selectorNamespace}'. Requested '${requestedName}' does not match. Use the same --name for this session or start a different --session.`,
                    errorInfo: {
                        message: `Session '${logicalSession}' is already bound to selector namespace '${selectorNamespace}'. Requested '${requestedName}' does not match. Use the same --name for this session or start a different --session.`,
                        code: 'SESSION_NAMESPACE_MISMATCH',
                        details: {
                            session: logicalSession,
                            runtimeSession: session,
                            scopeDir,
                            activeNamespace: selectorNamespace,
                            requestedNamespace: requestedName,
                        },
                    },
                })
                return
            }

            if (!selectorNamespace) {
                selectorNamespace = requestedName ?? logicalSession
            }
            const activeNamespace = selectorNamespace ?? logicalSession

            if (instance && !launchPromise) {
                try {
                    if (instance.page.isClosed()) {
                        invalidateInstance()
                    }
                } catch {
                    invalidateInstance()
                }
            }

            if (instance && !launchPromise) {
                assertCompatibleCloudProfileBinding(
                    logicalSession,
                    cloudProfileBinding,
                    requestedCloudProfileBinding
                )
            }

            if (!instance) {
                instance = new Opensteer({
                    name: activeNamespace,
                    cursor: {
                        enabled: effectiveCursorEnabled,
                    },
                    browser: {
                        headless: headless ?? false,
                        connectUrl,
                        channel,
                        profileDir,
                    },
                })
                const nextCloudProfileBinding = resolveSessionCloudProfileBinding(
                    instance.getConfig(),
                    requestedCloudProfileBinding
                )
                if (requestedCloudProfileBinding && !nextCloudProfileBinding) {
                    instance = null
                    throw new Error(
                        '--cloud-profile-id can only be used when cloud mode is enabled for this session.'
                    )
                }
                launchPromise = instance.launch({
                    headless: headless ?? false,
                    cloudBrowserProfile: cloudProfileId
                        ? {
                              profileId: cloudProfileId,
                              reuseIfActive: cloudProfileReuseIfActive,
                          }
                        : undefined,
                    timeout: connectUrl ? 120_000 : 30_000,
                })
                try {
                    await launchPromise
                    attachLifecycleListeners(instance)
                    cloudProfileBinding = nextCloudProfileBinding
                } catch (err) {
                    instance = null
                    cloudProfileBinding = null
                    throw err
                } finally {
                    launchPromise = null
                }
            } else if (launchPromise) {
                await launchPromise
            } else if (requestedCursor !== null) {
                instance.setCursorEnabled(requestedCursor)
            }

            if (url) {
                await instance.goto(url)
            }

            sendResponse(socket, {
                id,
                ok: true,
                result: {
                    url: instance.page.url(),
                    session: logicalSession,
                    logicalSession,
                    runtimeSession: session,
                    scopeDir,
                    name: activeNamespace,
                    cursor: instance.getCursorState(),
                    cloudSessionId: instance.getCloudSessionId() ?? undefined,
                    cloudSessionUrl: instance.getCloudSessionUrl() ?? undefined,
                },
            })
        } catch (err) {
            sendResponse(
                socket,
                buildErrorResponse(id, err, 'Failed to open browser session.')
            )
        }
        return
    }

    if (command === 'cursor') {
        try {
            const mode = typeof args.mode === 'string' ? args.mode : 'status'
            if (mode === 'on') {
                cursorEnabledPreference = true
                instance?.setCursorEnabled(true)
            } else if (mode === 'off') {
                cursorEnabledPreference = false
                instance?.setCursorEnabled(false)
            } else if (mode !== 'status') {
                throw new Error(
                    `Invalid cursor mode "${mode}". Use "on", "off", or "status".`
                )
            }

            const defaultEnabled =
                cursorEnabledPreference !== null ? cursorEnabledPreference : true

            const cursor = instance
                ? instance.getCursorState()
                : {
                      enabled: defaultEnabled,
                      active: false,
                      reason: 'session_not_open',
                  }

            sendResponse(socket, {
                id,
                ok: true,
                result: {
                    cursor,
                },
            })
        } catch (err) {
            sendResponse(
                socket,
                buildErrorResponse(id, err, 'Failed to update cursor mode.')
            )
        }
        return
    }

    if (command === 'close') {
        try {
            if (instance) {
                await instance.close()
                instance = null
            }
            sendResponse(socket, {
                id,
                ok: true,
                result: { sessionClosed: true },
            })
        } catch (err) {
            sendResponse(
                socket,
                buildErrorResponse(id, err, 'Failed to close browser session.')
            )
        }
        beginShutdown()
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
            error: `No browser session in session '${logicalSession}' (scope '${scopeDir}'). Call 'opensteer open --session ${logicalSession}' first, or use 'opensteer sessions' to list active sessions.`,
            errorInfo: {
                message: `No browser session in session '${logicalSession}' (scope '${scopeDir}'). Call 'opensteer open --session ${logicalSession}' first, or use 'opensteer sessions' to list active sessions.`,
                code: 'SESSION_NOT_OPEN',
                details: {
                    session: logicalSession,
                    runtimeSession: session,
                    scopeDir,
                },
            },
        })
        return
    }

    const handler = getCommandHandler(command)
    if (!handler) {
        sendResponse(socket, {
            id,
            ok: false,
            error: `Unknown command: ${command}`,
            errorInfo: {
                message: `Unknown command: ${command}`,
                code: 'UNKNOWN_COMMAND',
                details: {
                    command,
                },
            },
        })
        return
    }

    try {
        const result = await handler(instance, args)
        sendResponse(socket, { id, ok: true, result })
    } catch (err) {
        sendResponse(
            socket,
            buildErrorResponse(id, err, `Command "${command}" failed.`, undefined, {
                command,
            })
        )
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
                enqueueRequest(request, socket)
            } catch {
                sendResponse(socket, {
                    id: 0,
                    ok: false,
                    error: 'Invalid JSON request',
                    errorInfo: {
                        message: 'Invalid JSON request',
                        code: 'INVALID_JSON_REQUEST',
                    },
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
    if (shuttingDown) return
    shuttingDown = true
    if (instance) {
        try { await instance.close() } catch { /* best-effort cleanup on shutdown */ }
        instance = null
    }
    cleanup()
    server.close(() => {
        process.exit(0)
    })

    setTimeout(() => {
        process.exit(0)
    }, 250).unref()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

function buildErrorResponse(
    id: number,
    error: unknown,
    fallbackMessage: string,
    fallbackCode?: string,
    details?: Record<string, unknown>
): CliResponse {
    const normalized = normalizeError(error, fallbackMessage)
    let mergedDetails: Record<string, unknown> | undefined
    if (normalized.details || details) {
        mergedDetails = {
            ...(normalized.details || {}),
            ...(details || {}),
        }
    }

    return {
        id,
        ok: false,
        error: normalized.message,
        errorInfo: {
            message: normalized.message,
            ...(normalized.code || fallbackCode
                ? { code: normalized.code || fallbackCode }
                : {}),
            ...(normalized.name ? { name: normalized.name } : {}),
            ...(mergedDetails ? { details: mergedDetails } : {}),
            ...(normalized.cause ? { cause: normalized.cause } : {}),
        },
    }
}
