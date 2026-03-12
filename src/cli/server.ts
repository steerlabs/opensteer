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
import {
    buildServerOpenConfig,
    normalizeCliOpenCloudAuth,
    type CliOpenCloudAuth,
} from './open-cloud-auth.js'
import { resolveCliBrowserRequestConfig } from './open-browser-config.js'
import { ApiReverseController } from '../api-reverse/controller.js'

let instance: Opensteer | null = null
let apiController: ApiReverseController | null = null
let launchPromise: Promise<void> | null = null
let selectorNamespace: string | null = null
let cloudProfileBinding: CloudProfileBinding | null = null
let cloudAuthOverride: CliOpenCloudAuth | null = null
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
    apiController?.shutdown().catch(() => {})
    apiController = null
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

function ensureApiController(inst: Opensteer | null): ApiReverseController {
    if (!apiController) {
        apiController = new ApiReverseController(inst, {
            scopeDir,
            logicalSession,
        })
    } else {
        apiController.setOpensteer(inst)
    }
    return apiController
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
            const browser =
                args.browser === 'real' || args.browser === 'chromium'
                    ? (args.browser as 'real' | 'chromium')
                    : args.browser === undefined
                      ? undefined
                      : null
            const cdpUrl = args['cdp-url'] as string | undefined
            const profileDirectory = args.profile as string | undefined
            const userDataDir =
                args['user-data-dir'] as string | undefined
            const executablePath =
                args['browser-path'] as string | undefined
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
            const requestedCloudAuth = normalizeCliOpenCloudAuth(
                args['cloud-auth']
            )
            if (cloudProfileReuseIfActive !== undefined && !cloudProfileId) {
                throw new Error(
                    '--cloud-profile-reuse-if-active requires --cloud-profile-id.'
                )
            }
            if (browser === null) {
                throw new Error(
                    '--browser must be either "chromium" or "real".'
                )
            }
            if (
                browser === 'chromium' &&
                (profileDirectory || userDataDir || executablePath)
            ) {
                throw new Error(
                    '--profile, --user-data-dir, and --browser-path require --browser real.'
                )
            }
            if (cdpUrl && browser === 'real') {
                throw new Error(
                    '--cdp-url cannot be combined with --browser real.'
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

            if (requestedCloudAuth) {
                cloudAuthOverride = requestedCloudAuth
            }

            if (instance && !launchPromise) {
                try {
                    if (instance.page.isClosed()) {
                        invalidateInstance()
                    }
                } catch {
                    invalidateInstance()
                }
            }

            const requestedBrowserConfig = resolveCliBrowserRequestConfig({
                browser: browser ?? undefined,
                headless,
                cdpUrl,
                profileDirectory,
                userDataDir,
                executablePath,
            })

            if (instance && !launchPromise) {
                assertCompatibleCloudProfileBinding(
                    logicalSession,
                    cloudProfileBinding,
                    requestedCloudProfileBinding
                )

                const existingBrowserConfig =
                    instance.getConfig().browser || {}
                const existingBrowserRecord =
                    existingBrowserConfig as Record<string, unknown>
                const mismatch = Object.entries(requestedBrowserConfig).find(
                    ([key, value]) =>
                        value !== undefined &&
                        existingBrowserRecord[key] !== value
                )
                if (mismatch) {
                    const [key, value] = mismatch
                    throw new Error(
                        `Session '${logicalSession}' is already bound to browser setting "${key}"=${JSON.stringify(existingBrowserRecord[key])}. Requested ${JSON.stringify(value)} does not match. Use the same browser flags for this session or start a different --session.`
                    )
                }
            }

            let shouldLaunchInitialUrl = false

            if (!instance) {
                instance = new Opensteer(
                    buildServerOpenConfig({
                        scopeDir,
                        name: activeNamespace,
                        cursorEnabled: effectiveCursorEnabled,
                        ...requestedBrowserConfig,
                        cloudAuth: cloudAuthOverride,
                    })
                )
                const resolvedBrowserConfig = instance.getConfig().browser || {}
                shouldLaunchInitialUrl =
                    Boolean(url) &&
                    resolvedBrowserConfig.mode === 'real' &&
                    !resolvedBrowserConfig.cdpUrl
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
                    initialUrl: shouldLaunchInitialUrl ? url : undefined,
                    ...requestedBrowserConfig,
                    cloudBrowserProfile: cloudProfileId
                        ? {
                              profileId: cloudProfileId,
                              reuseIfActive: cloudProfileReuseIfActive,
                          }
                        : undefined,
                    timeout: cdpUrl ? 120_000 : 30_000,
                })
                try {
                    await launchPromise
                    attachLifecycleListeners(instance)
                    cloudProfileBinding = nextCloudProfileBinding
                } catch (err) {
                    instance = null
                    apiController = null
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

            ensureApiController(instance)

            if (url && !shouldLaunchInitialUrl) {
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
            await apiController?.shutdown().catch(() => undefined)
            apiController = null
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

    if (command.startsWith('api-')) {
        try {
            const controller = ensureApiController(instance)
            if (command === 'api-capture-status') {
                sendResponse(socket, {
                    id,
                    ok: true,
                    result: controller.getStatus(),
                })
                return
            }

            if (
                !instance &&
                (command === 'api-capture-start' ||
                    command === 'api-capture-stop' ||
                    command === 'api-span-start' ||
                    command === 'api-span-stop' ||
                    command === 'api-probe-run')
            ) {
                throw new Error(
                    `No browser session in session '${logicalSession}' (scope '${scopeDir}'). Call 'opensteer open --session ${logicalSession}' first.`
                )
            }

            switch (command) {
                case 'api-capture-start':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: await controller.startCapture(),
                    })
                    return
                case 'api-capture-stop':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: await controller.stopCapture(),
                    })
                    return
                case 'api-span-list':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            spans: controller.listSpans(),
                        },
                    })
                    return
                case 'api-span-start':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            span: await controller.startManualSpan(
                                String(args.label || '').trim() || 'manual_span'
                            ),
                        },
                    })
                    return
                case 'api-span-stop':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            span: await controller.stopManualSpan(),
                        },
                    })
                    return
                case 'api-request-list':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            requests: controller.listRequests({
                                spanRef:
                                    typeof args.span === 'string'
                                        ? args.span
                                        : null,
                                kind:
                                    args.kind === 'all' ? 'all' : 'candidates',
                                limit:
                                    typeof args.limit === 'number'
                                        ? args.limit
                                        : undefined,
                            }),
                        },
                    })
                    return
                case 'api-request-inspect':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            request: controller.inspectRequest(String(args.ref), {
                                body:
                                    args.body === 'full' ? 'full' : 'summary',
                                raw: args.raw === true,
                            }),
                        },
                    })
                    return
                case 'api-slot-list':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            slots: controller.listSlots({
                                requestRef:
                                    typeof args.request === 'string'
                                        ? args.request
                                        : null,
                                spanRef:
                                    typeof args.span === 'string'
                                        ? args.span
                                        : null,
                            }),
                        },
                    })
                    return
                case 'api-slot-inspect':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: controller.inspectSlot(String(args.ref)),
                    })
                    return
                case 'api-evidence-inspect':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: controller.inspectEvidence(String(args.ref)),
                    })
                    return
                case 'api-value-trace':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: controller.traceValue(String(args.value), {
                            spanRef:
                                typeof args.span === 'string'
                                    ? args.span
                                    : null,
                        }),
                    })
                    return
                case 'api-plan-infer':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            plan: await controller.inferPlan({
                                task: String(args.task || '').trim(),
                                spanRef:
                                    typeof args.span === 'string'
                                        ? args.span
                                        : null,
                                requestRef:
                                    typeof args.request === 'string'
                                        ? args.request
                                        : null,
                            }),
                        },
                    })
                    return
                case 'api-plan-list':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            plans: await controller.listPlans(),
                        },
                    })
                    return
                case 'api-probe-run':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            probe: await controller.runProbe({
                                spanRef: String(args.span),
                                values: Array.isArray(args.values)
                                    ? args.values.map((value) => String(value))
                                    : typeof args.values === 'string'
                                      ? args.values
                                            .split(',')
                                            .map((value) => value.trim())
                                            .filter(Boolean)
                                      : [],
                            }),
                        },
                    })
                    return
                case 'api-plan-inspect':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            plan: controller.inspectPlan(String(args.ref)),
                        },
                    })
                    return
                case 'api-plan-validate': {
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            validation: await controller.validatePlan({
                                ref: String(args.ref),
                                mode:
                                    args['dry-run'] === true
                                        ? 'dry-run'
                                        : 'execute',
                                inputs:
                                    typeof args.inputs === 'string' ||
                                    (args.inputs &&
                                        typeof args.inputs === 'object')
                                        ? (args.inputs as
                                              | string
                                              | Record<string, unknown>)
                                        : null,
                            }),
                        },
                    })
                    return
                }
                case 'api-plan-execute':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            execution: await controller.executePlan({
                                ref:
                                    typeof args.ref === 'string'
                                        ? args.ref
                                        : null,
                                operation:
                                    typeof args.operation === 'string'
                                        ? args.operation
                                        : null,
                                version:
                                    typeof args.version === 'number'
                                        ? args.version
                                        : typeof args.version === 'string'
                                          ? Number.parseInt(args.version, 10)
                                          : null,
                                inputs:
                                    typeof args.inputs === 'string' ||
                                    (args.inputs &&
                                        typeof args.inputs === 'object')
                                        ? (args.inputs as
                                              | string
                                              | Record<string, unknown>)
                                        : null,
                                refreshSession: args.refreshSession !== false,
                            }),
                        },
                    })
                    return
                case 'api-session-ensure':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: {
                            session: await controller.ensureSession({
                                ref:
                                    typeof args.ref === 'string'
                                        ? args.ref
                                        : null,
                                operation:
                                    typeof args.operation === 'string'
                                        ? args.operation
                                        : null,
                                version:
                                    typeof args.version === 'number'
                                        ? args.version
                                        : typeof args.version === 'string'
                                          ? Number.parseInt(args.version, 10)
                                          : null,
                                interactive: args.interactive !== false,
                            }),
                        },
                    })
                    return
                case 'api-plan-codegen':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: await controller.codegenPlan({
                            ref: String(args.ref),
                            lang: args.lang === 'py' ? 'py' : 'ts',
                        }),
                    })
                    return
                case 'api-plan-export':
                case 'api-plan-render':
                    sendResponse(socket, {
                        id,
                        ok: true,
                        result: await controller.renderPlan({
                            ref: String(args.ref),
                            format:
                                args.format === 'exec'
                                    ? 'exec'
                                    : args.format === 'curl' ||
                                        args.format === 'curl-trace'
                                      ? 'curl-trace'
                                      : 'ir',
                        }),
                    })
                    return
                default:
                    throw new Error(`Unknown command: ${command}`)
            }
        } catch (err) {
            sendResponse(
                socket,
                buildErrorResponse(
                    id,
                    err,
                    `Command "${command}" failed.`,
                    undefined,
                    { command }
                )
            )
        }
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

    let autoSpan = null
    try {
        autoSpan = apiController?.isMutatingCommand(command)
            ? await apiController.beginAutomaticSpan(command, args)
            : null
        const result = await handler(instance, args)
        await apiController?.endAutomaticSpan(autoSpan ?? null, {})
        sendResponse(socket, { id, ok: true, result })
    } catch (err) {
        await apiController
            ?.endAutomaticSpan(autoSpan ?? null, { error: err })
            .catch(() => undefined)
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
    if (apiController) {
        try { await apiController.shutdown() } catch { /* best-effort cleanup on shutdown */ }
        apiController = null
    }
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
