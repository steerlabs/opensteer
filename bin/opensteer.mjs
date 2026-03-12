#!/usr/bin/env node

import { createHash } from 'crypto'
import { spawn } from 'child_process'
import {
    closeSync,
    existsSync,
    openSync,
    realpathSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_SCRIPT = join(__dirname, '..', 'dist', 'cli', 'server.js')
const SKILLS_INSTALLER_SCRIPT = join(
    __dirname,
    '..',
    'dist',
    'cli',
    'skills-installer.js'
)
const PROFILE_CLI_SCRIPT = join(__dirname, '..', 'dist', 'cli', 'profile.js')
const LOCAL_PROFILE_CLI_SCRIPT = join(
    __dirname,
    '..',
    'dist',
    'cli',
    'local-profile.js'
)
const AUTH_CLI_SCRIPT = join(__dirname, '..', 'dist', 'cli', 'auth.js')
const SKILLS_HELP_TEXT = `Usage: opensteer skills <install|add> [options]

Installs the first-party Opensteer skill using the upstream "skills" CLI.

Commands:
  install                  Install the opensteer skill
  add                      Alias for install

Supported Options:
  -a, --agent <agents...>  Target specific agent(s)
  -g, --global             Install globally
  -y, --yes                Skip confirmations
  --copy                   Copy files instead of symlinking
  --all                    Install to all agents
  -h, --help               Show this help

Examples:
  opensteer skills install
  opensteer skills add --agent codex --global --yes
  opensteer skills install --all --yes
`
const PROFILE_HELP_TEXT = `Usage: opensteer profile <command> [options]

Manage cloud browser profiles and sync local cookie state into cloud profiles.

Commands:
  list
  create --name <name>
  sync

Run "opensteer profile --help" after building for full command details.
`
const LOCAL_PROFILE_HELP_TEXT = `Usage: opensteer local-profile <command> [options]

Inspect local Chrome profiles for real-browser mode.

Commands:
  list

Run "opensteer local-profile --help" after building for full command details.
`
const AUTH_HELP_TEXT = `Usage: opensteer auth <command> [options]

Authenticate Opensteer CLI with Opensteer Cloud.

Commands:
  login
  status
  logout

Run "opensteer auth --help" after building for full command details.
`
const API_HELP_TEXT = `Usage: opensteer api <resource> <action> [options]

Reverse-engineer internal APIs from browser traffic captured in the current Opensteer session.

Commands:
  capture start
  capture stop
  capture status
  span list
  span start --label <label>
  span stop
  request list [--span <@span1>] [--kind candidates|all] [--limit <n>]
  request inspect <@request1> [--body summary|full] [--raw true|false]
  slot list [--request <@request1>] [--span <@span1>]
  slot inspect <@slot1>
  evidence inspect <@slot1|@evidence1>
  value trace <literal-or-@value1> [--span <@span1>]
  probe run --span <@span1> --values <json-array|csv>
  plan infer --task <task> [--span <@span1>] [--request <@request1>]
  plan list [--operation <name>]
  plan inspect <@plan1>
  plan validate <@plan1> [--dry-run] [--inputs <json>]
  plan execute <@plan1|operation> [--version <n>] [--inputs <json>] [--refreshSession true|false]
  plan codegen <@plan1> --lang <ts|py>
  plan render <@plan1> --format <ir|exec|curl-trace>
  plan export <@plan1> --format <ir|exec|curl-trace>
  session ensure <@plan1|operation> [--version <n>] [--interactive true|false]
`

const CONNECT_TIMEOUT = 15000
const POLL_INTERVAL = 100
const RESPONSE_TIMEOUT = 120000
const HEALTH_TIMEOUT = 1500
const RUNTIME_PREFIX = 'opensteer-'
const SOCKET_SUFFIX = '.sock'
const PID_SUFFIX = '.pid'
const LOCK_SUFFIX = '.lock'
const METADATA_SUFFIX = '.meta.json'
const CLIENT_BINDING_PREFIX = `${RUNTIME_PREFIX}client-`
const CLIENT_BINDING_SUFFIX = '.session'
const CLOSE_ALL_REQUEST = { id: 1, command: 'close', args: {} }
const PING_REQUEST = { id: 1, command: 'ping', args: {} }
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const RUNTIME_SESSION_PREFIX = 'sc-'
const BOOLEAN_FLAGS = new Set(['all', 'headless', 'headed', 'json'])

function getVersion() {
    try {
        const pkgPath = join(__dirname, '..', 'package.json')
        return JSON.parse(readFileSync(pkgPath, 'utf-8')).version
    } catch {
        return 'unknown'
    }
}

function parseArgs(argv) {
    const args = argv.slice(2)
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printHelp()
        process.exit(0)
    }

    if (args[0] === '--version' || args[0] === '-v') {
        console.log(getVersion())
        process.exit(0)
    }

    const command = args[0]
    const flags = {}
    const positional = []

    for (let i = 1; i < args.length; i++) {
        const arg = args[i]
        if (arg.startsWith('--')) {
            const key = arg.slice(2)
            const next = args[i + 1]
            if (
                BOOLEAN_FLAGS.has(key) &&
                next !== undefined &&
                next !== 'true' &&
                next !== 'false'
            ) {
                flags[key] = true
            } else if (next !== undefined && !next.startsWith('--')) {
                flags[key] = parseValue(next)
                i++
            } else {
                flags[key] = true
            }
        } else {
            positional.push(arg)
        }
    }

    return { command, flags, positional }
}

function parseValue(str) {
    if (str === 'true') return true
    if (str === 'false') return false
    const num = Number(str)
    if (!Number.isNaN(num) && str.trim() !== '') return num
    return str
}

function sanitizeNamespace(value) {
    const trimmed = String(value || '').trim()
    if (!trimmed || trimmed === '.' || trimmed === '..') {
        return 'default'
    }

    const replaced = trimmed.replace(/[^a-zA-Z0-9_-]+/g, '_')
    const collapsed = replaced.replace(/_+/g, '_')
    const bounded = collapsed.replace(/^_+|_+$/g, '')

    return bounded || 'default'
}

function isValidSessionId(value) {
    return SESSION_ID_PATTERN.test(value)
}

function validateSessionId(rawValue, label) {
    const value = String(rawValue ?? '').trim()
    if (!value) {
        throw new Error(`${label} cannot be empty.`)
    }
    if (!isValidSessionId(value)) {
        throw new Error(
            `${label} "${value}" is invalid. Use only letters, numbers, underscores, and hyphens.`
        )
    }
    return value
}

function resolveName(flags, session) {
    if (flags.name !== undefined) {
        if (flags.name === true) {
            throw new Error('--name requires a namespace value.')
        }
        const raw = String(flags.name).trim()
        if (raw.length > 0) {
            return { name: sanitizeNamespace(raw), source: 'flag' }
        }
    }

    if (
        typeof process.env.OPENSTEER_NAME === 'string' &&
        process.env.OPENSTEER_NAME.trim().length > 0
    ) {
        return {
            name: sanitizeNamespace(process.env.OPENSTEER_NAME),
            source: 'env',
        }
    }

    return { name: sanitizeNamespace(session), source: 'session' }
}

function hashKey(value) {
    return createHash('sha256').update(value).digest('hex')
}

function getClientBindingPath(clientKey) {
    return join(
        tmpdir(),
        `${CLIENT_BINDING_PREFIX}${hashKey(clientKey).slice(0, 24)}${CLIENT_BINDING_SUFFIX}`
    )
}

function readClientBinding(clientKey) {
    const bindingPath = getClientBindingPath(clientKey)
    if (!existsSync(bindingPath)) {
        return null
    }

    try {
        const rawSession = readFileSync(bindingPath, 'utf-8').trim()
        if (!rawSession) {
            unlinkSync(bindingPath)
            return null
        }
        if (!isValidSessionId(rawSession)) {
            unlinkSync(bindingPath)
            return null
        }
        return rawSession
    } catch {
        return null
    }
}

function writeClientBinding(clientKey, session) {
    try {
        writeFileSync(getClientBindingPath(clientKey), session)
    } catch { /* best-effort */ }
}

function createDefaultSessionId(prefix, clientKey) {
    return `${prefix}-${hashKey(clientKey).slice(0, 12)}`
}

function isInteractiveTerminal() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

function resolveScopeDir() {
    const cwd = process.cwd()
    try {
        return realpathSync(cwd)
    } catch {
        return cwd
    }
}

function buildRuntimeSession(scopeDir, logicalSession) {
    return `${RUNTIME_SESSION_PREFIX}${hashKey(`${scopeDir}:${logicalSession}`).slice(0, 24)}`
}

function resolveSession(flags, scopeDir) {
    if (flags.session !== undefined) {
        if (flags.session === true) {
            throw new Error('--session requires a session id value.')
        }

        return {
            session: validateSessionId(flags.session, 'Session id'),
            source: 'flag',
        }
    }

    if (
        typeof process.env.OPENSTEER_SESSION === 'string' &&
        process.env.OPENSTEER_SESSION.trim().length > 0
    ) {
        return {
            session: validateSessionId(
                process.env.OPENSTEER_SESSION,
                'OPENSTEER_SESSION'
            ),
            source: 'env',
        }
    }

    if (
        typeof process.env.OPENSTEER_CLIENT_ID === 'string' &&
        process.env.OPENSTEER_CLIENT_ID.trim().length > 0
    ) {
        const clientId = process.env.OPENSTEER_CLIENT_ID.trim()
        const clientKey = `client:${scopeDir}:${clientId}`
        const bound = readClientBinding(clientKey)
        if (bound) {
            return { session: bound, source: 'client_binding' }
        }

        const created = createDefaultSessionId('client', clientKey)
        writeClientBinding(clientKey, created)
        return { session: created, source: 'client_binding' }
    }

    if (isInteractiveTerminal()) {
        const ttyKey = `tty:${scopeDir}:${process.ppid}`
        const bound = readClientBinding(ttyKey)
        if (bound) {
            return { session: bound, source: 'tty_default' }
        }

        const created = createDefaultSessionId('tty', ttyKey)
        writeClientBinding(ttyKey, created)
        return { session: created, source: 'tty_default' }
    }

    throw new Error(
        'No session resolved for this non-interactive command. Set OPENSTEER_SESSION or OPENSTEER_CLIENT_ID, or pass --session <id>.'
    )
}

function getSocketPath(session) {
    return join(tmpdir(), `${RUNTIME_PREFIX}${session}${SOCKET_SUFFIX}`)
}

function getPidPath(session) {
    return join(tmpdir(), `${RUNTIME_PREFIX}${session}${PID_SUFFIX}`)
}

function getLockPath(session) {
    return join(tmpdir(), `${RUNTIME_PREFIX}${session}${LOCK_SUFFIX}`)
}

function getMetadataPath(session) {
    return join(tmpdir(), `${RUNTIME_PREFIX}${session}${METADATA_SUFFIX}`)
}

function buildRequest(command, flags, positional) {
    const id = 1
    const globalFlags = {}
    for (const key of [
        'headless',
        'json',
        'browser',
        'profile',
        'cdp-url',
        'user-data-dir',
        'browser-path',
        'cloud-profile-id',
        'cloud-profile-reuse-if-active',
        'cursor',
    ]) {
        if (key in flags) {
            globalFlags[key] = flags[key]
            delete flags[key]
        }
    }

    const args = { ...globalFlags, ...flags }
    if ('headed' in flags) {
        const headed = flags.headed === false ? false : Boolean(flags.headed)
        args.headless = args.headless ?? !headed
        delete args.headed
    }

    switch (command) {
        case 'open':
        case 'navigate':
            args.url = positional[0] || args.url
            break

        case 'click':
        case 'dblclick':
        case 'rightclick':
        case 'hover':
        case 'select':
        case 'scroll':
        case 'get-text':
        case 'get-value':
        case 'get-attrs':
            if (positional[0] !== undefined && args.element === undefined) {
                args.element = Number(positional[0])
            }
            break

        case 'input': {
            // input 12 "text" or input "text" --element 12
            if (positional.length >= 2) {
                const first = Number(positional[0])
                if (!Number.isNaN(first)) {
                    args.element = args.element ?? first
                    args.text = args.text ?? positional[1]
                } else {
                    args.text = args.text ?? positional[0]
                    args.element = args.element ?? Number(positional[1])
                }
            } else if (positional.length === 1) {
                args.text = args.text ?? positional[0]
            }
            break
        }

        case 'press':
            args.key = positional[0] || args.key
            break

        case 'type':
            args.text = positional[0] || args.text
            break

        case 'get-html':
            if (positional[0] && !args.selector) {
                args.selector = positional[0]
            }
            break

        case 'tab-new':
            args.url = positional[0] || args.url
            break

        case 'tab-switch':
        case 'tab-close':
            args.index =
                positional[0] !== undefined ? Number(positional[0]) : args.index
            break

        case 'cookies-export':
        case 'cookies-import':
        case 'screenshot':
            args.file = positional[0] || args.file
            break

        case 'eval':
            args.expression = positional[0] || args.expression
            break

        case 'wait-for':
            args.text = positional[0] || args.text
            break

        case 'wait-selector':
            args.selector = positional[0] || args.selector
            break

        case 'extract':
            if (positional[0] && !args.schema) {
                try {
                    args.schema = JSON.parse(positional[0])
                } catch {
                    error(`Invalid JSON schema: ${positional[0]}`)
                }
            }
            break

        case 'snapshot':
            args.mode = positional[0] || args.mode
            break

        case 'cursor':
            args.mode = positional[0] || args.mode || 'status'
            break

        case 'api-span-start':
            args.label = positional[0] || args.label
            break

        case 'api-request-inspect':
        case 'api-slot-inspect':
        case 'api-evidence-inspect':
        case 'api-plan-inspect':
        case 'api-plan-execute':
        case 'api-session-ensure':
        case 'api-plan-codegen':
        case 'api-plan-export':
        case 'api-plan-render':
            args.ref = positional[0] || args.ref
            if (
                args.ref &&
                typeof args.ref === 'string' &&
                !String(args.ref).startsWith('@') &&
                !args.operation
            ) {
                args.operation = args.ref
                delete args.ref
            }
            break

        case 'api-plan-list':
            args.operation = positional[0] || args.operation
            break

        case 'api-slot-list':
            args.request = positional[0] || args.request
            break

        case 'api-value-trace':
            args.value = positional[0] || args.value
            break

        case 'api-probe-run':
            args.span = positional[0] || args.span
            if (args.values == null && positional[1]) {
                try {
                    args.values = JSON.parse(positional[1])
                } catch {
                    args.values = positional[1]
                }
            } else if (typeof args.values === 'string') {
                try {
                    args.values = JSON.parse(args.values)
                } catch {
                }
            }
            break

        case 'api-plan-infer':
            args.task = args.task || positional[0]
            break

        case 'api-plan-validate':
        case 'api-plan-execute':
            args.ref = positional[0] || args.ref
            if (typeof args.inputs === 'string') {
                try {
                    args.inputs = JSON.parse(args.inputs)
                } catch {
                    error(`Invalid JSON inputs: ${args.inputs}`)
                }
            }
            break
    }

    return { id, command, args }
}

function readPid(pidPath) {
    if (!existsSync(pidPath)) {
        return null
    }

    const parsed = Number.parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null
    }

    return parsed
}

function isPidAlive(pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

function cleanStaleFiles(session, options = {}) {
    const removeSocket = options.removeSocket !== false
    const removePid = options.removePid !== false

    if (removeSocket) {
        try {
            unlinkSync(getSocketPath(session))
        } catch { }
    }

    if (removePid) {
        try {
            unlinkSync(getPidPath(session))
        } catch { }
    }

    try {
        unlinkSync(getMetadataPath(session))
    } catch { }
}

function startServer(runtimeSession, logicalSession, scopeDir) {
    const child = spawn('node', [SERVER_SCRIPT], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
            ...process.env,
            OPENSTEER_SESSION: runtimeSession,
            OPENSTEER_LOGICAL_SESSION: logicalSession,
            OPENSTEER_SCOPE_DIR: scopeDir,
        },
    })
    child.unref()
}

function readMetadata(session) {
    const metadataPath = getMetadataPath(session)
    if (!existsSync(metadataPath)) {
        return null
    }

    try {
        const raw = JSON.parse(readFileSync(metadataPath, 'utf-8'))
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return null
        }

        if (
            typeof raw.logicalSession !== 'string' ||
            !raw.logicalSession.trim() ||
            typeof raw.scopeDir !== 'string' ||
            !raw.scopeDir.trim() ||
            typeof raw.runtimeSession !== 'string' ||
            !raw.runtimeSession.trim()
        ) {
            return null
        }

        return {
            logicalSession: raw.logicalSession.trim(),
            scopeDir: raw.scopeDir,
            runtimeSession: raw.runtimeSession.trim(),
            createdAt:
                typeof raw.createdAt === 'number' ? raw.createdAt : undefined,
            updatedAt:
                typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined,
        }
    } catch {
        return null
    }
}

function writeMetadata(runtimeSession, logicalSession, scopeDir) {
    const metadataPath = getMetadataPath(runtimeSession)
    const existing = readMetadata(runtimeSession)
    const now = Date.now()
    const payload = {
        runtimeSession,
        logicalSession,
        scopeDir,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    }

    try {
        writeFileSync(metadataPath, JSON.stringify(payload, null, 2))
    } catch { }
}

function sendCommand(socketPath, request, timeoutMs = RESPONSE_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const socket = connect(socketPath)
        let buffer = ''
        let settled = false

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true
                socket.destroy()
                reject(new Error('Response timeout'))
            }
        }, timeoutMs)

        socket.on('connect', () => {
            socket.write(JSON.stringify(request) + '\n')
        })

        socket.on('data', (chunk) => {
            buffer += chunk.toString()
            const idx = buffer.indexOf('\n')
            if (idx !== -1) {
                const line = buffer.slice(0, idx)
                clearTimeout(timer)
                settled = true
                socket.end()
                try {
                    resolve(JSON.parse(line))
                } catch {
                    reject(new Error('Invalid JSON response from server'))
                }
            }
        })

        socket.on('error', (err) => {
            if (!settled) {
                clearTimeout(timer)
                settled = true
                reject(err)
            }
        })

        socket.on('close', () => {
            if (!settled) {
                clearTimeout(timer)
                settled = true
                reject(new Error('Connection closed before response'))
            }
        })
    })
}

async function pingServer(session) {
    const socketPath = getSocketPath(session)
    if (!existsSync(socketPath)) return false

    try {
        const response = await sendCommand(socketPath, PING_REQUEST, HEALTH_TIMEOUT)
        return Boolean(response?.ok && response?.result?.pong)
    } catch {
        return false
    }
}

async function isServerHealthy(session) {
    const pid = readPid(getPidPath(session))
    const pidAlive = pid ? isPidAlive(pid) : false
    const socketExists = existsSync(getSocketPath(session))

    if (pid && !pidAlive) {
        cleanStaleFiles(session)
        return false
    }

    if (!socketExists) {
        return false
    }

    const healthy = await pingServer(session)
    if (healthy) {
        return true
    }

    if (!pid) {
        cleanStaleFiles(session, { removeSocket: true, removePid: false })
    }

    return false
}

function acquireStartLock(session) {
    const lockPath = getLockPath(session)

    try {
        const fd = openSync(lockPath, 'wx')
        writeFileSync(
            fd,
            JSON.stringify({
                pid: process.pid,
                createdAt: Date.now(),
            })
        )
        closeSync(fd)
        return true
    } catch {
        return false
    }
}

function releaseStartLock(session) {
    try {
        unlinkSync(getLockPath(session))
    } catch { /* best-effort */ }
}

function recoverStaleStartLock(session) {
    const lockPath = getLockPath(session)
    if (!existsSync(lockPath)) {
        return false
    }

    try {
        const raw = readFileSync(lockPath, 'utf-8')
        const parsed = JSON.parse(raw)
        const pid =
            parsed && Number.isInteger(parsed.pid) && parsed.pid > 0
                ? parsed.pid
                : null

        if (!pid || !isPidAlive(pid)) {
            unlinkSync(lockPath)
            return true
        }

        return false
    } catch {
        try {
            unlinkSync(lockPath)
            return true
        } catch {
            return false
        }
    }
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForServerReady(session, timeout) {
    const start = Date.now()

    while (Date.now() - start <= timeout) {
        if (await isServerHealthy(session)) {
            return
        }
        await sleep(POLL_INTERVAL)
    }

    throw new Error(`Timed out waiting for server '${session}' to become healthy.`)
}

async function ensureServer(context) {
    const runtimeSession = context.runtimeSession
    if (await isServerHealthy(runtimeSession)) {
        writeMetadata(
            runtimeSession,
            context.logicalSession,
            context.scopeDir
        )
        return
    }

    if (!existsSync(SERVER_SCRIPT)) {
        throw new Error(
            `Server script not found: ${SERVER_SCRIPT}. Run the build script first.`
        )
    }

    const deadline = Date.now() + CONNECT_TIMEOUT

    while (Date.now() < deadline) {
        if (await isServerHealthy(runtimeSession)) {
            writeMetadata(
                runtimeSession,
                context.logicalSession,
                context.scopeDir
            )
            return
        }

        const existingPid = readPid(getPidPath(runtimeSession))
        const startLockExists = existsSync(getLockPath(runtimeSession))
        if (existingPid && isPidAlive(existingPid) && startLockExists) {
            await sleep(POLL_INTERVAL)
            continue
        }
        if (existingPid && isPidAlive(existingPid) && !startLockExists) {
            cleanStaleFiles(runtimeSession)
        }

        recoverStaleStartLock(runtimeSession)

        if (acquireStartLock(runtimeSession)) {
            try {
                if (!(await isServerHealthy(runtimeSession))) {
                    startServer(
                        runtimeSession,
                        context.logicalSession,
                        context.scopeDir
                    )
                }

                await waitForServerReady(
                    runtimeSession,
                    Math.max(500, deadline - Date.now())
                )
                writeMetadata(
                    runtimeSession,
                    context.logicalSession,
                    context.scopeDir
                )
                return
            } finally {
                releaseStartLock(runtimeSession)
            }
        }

        await sleep(POLL_INTERVAL)
    }

    throw new Error(
        `Failed to start server for session '${context.logicalSession}' in cwd scope '${context.scopeDir}' within ${CONNECT_TIMEOUT}ms.`
    )
}

function listSessions() {
    const sessions = []
    const entries = readdirSync(tmpdir())

    for (const entry of entries) {
        if (!entry.startsWith(RUNTIME_PREFIX) || !entry.endsWith(PID_SUFFIX)) {
            continue
        }

        const runtimeSession = entry.slice(
            RUNTIME_PREFIX.length,
            entry.length - PID_SUFFIX.length
        )
        if (!runtimeSession) {
            continue
        }

        const pid = readPid(join(tmpdir(), entry))
        if (!pid || !isPidAlive(pid)) {
            cleanStaleFiles(runtimeSession)
            continue
        }

        const metadata = readMetadata(runtimeSession)
        sessions.push({
            name: metadata?.logicalSession || runtimeSession,
            logicalSession: metadata?.logicalSession || runtimeSession,
            runtimeSession,
            scopeDir: metadata?.scopeDir || null,
            pid,
        })
    }

    sessions.sort((a, b) => {
        const scopeA = a.scopeDir || ''
        const scopeB = b.scopeDir || ''
        if (scopeA !== scopeB) {
            return scopeA.localeCompare(scopeB)
        }

        return a.logicalSession.localeCompare(b.logicalSession)
    })
    return sessions
}

async function closeAllSessions() {
    const sessions = listSessions()
    const closed = []
    const failures = []

    for (const session of sessions) {
        const socketPath = getSocketPath(session.runtimeSession)
        if (!existsSync(socketPath)) {
            cleanStaleFiles(session.runtimeSession)
            continue
        }

        try {
            const response = await sendCommand(socketPath, CLOSE_ALL_REQUEST)
            if (response && response.ok === true) {
                closed.push(session)
            } else {
                failures.push(
                    `${session.logicalSession} (${session.scopeDir || 'unknown scope'}): ${response?.error || 'unknown close error'}`
                )
            }
        } catch (err) {
            failures.push(
                `${session.logicalSession} (${session.scopeDir || 'unknown scope'}): ${err instanceof Error ? err.message : String(err)}`
            )
        }
    }

    if (failures.length > 0) {
        throw new Error(`Failed to close sessions: ${failures.join('; ')}`)
    }

    return closed
}

function output(data) {
    process.stdout.write(JSON.stringify(data) + '\n')
}

function error(msg) {
    process.stderr.write(JSON.stringify({ ok: false, error: msg }) + '\n')
    process.exit(1)
}

function normalizeFailedResponse(response) {
    const info = toObject(response?.errorInfo)

    let message = 'Request failed.'
    if (typeof info?.message === 'string' && info.message.trim()) {
        message = info.message.trim()
    } else if (typeof response?.error === 'string' && response.error.trim()) {
        message = response.error.trim()
    }

    return {
        ok: false,
        error: message,
        ...(info && typeof info.code === 'string' && info.code.trim()
            ? { code: info.code.trim() }
            : {}),
        ...(toObject(info?.details)
            ? { details: info.details }
            : {}),
        ...(info ? { errorInfo: info } : {}),
    }
}

function formatTransportFailure(error, context) {
    const message = error instanceof Error ? error.message : String(error)
    return `${context}: ${message}`
}

function toObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value
}

function isSkillsHelpRequest(args) {
    if (args.length === 0) return true

    const [subcommand, ...rest] = args
    if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        return true
    }

    if (subcommand !== 'install' && subcommand !== 'add') {
        return false
    }

    return rest.includes('--help') || rest.includes('-h')
}

function printSkillsHelp() {
    process.stdout.write(SKILLS_HELP_TEXT)
}

async function runSkillsSubcommand(args) {
    if (isSkillsHelpRequest(args)) {
        printSkillsHelp()
        return
    }

    if (!existsSync(SKILLS_INSTALLER_SCRIPT)) {
        throw new Error(
            `Skills installer module not found: ${SKILLS_INSTALLER_SCRIPT}. Run the build script first.`
        )
    }

    const moduleUrl = pathToFileURL(SKILLS_INSTALLER_SCRIPT).href
    const { runOpensteerSkillsInstaller } = await import(moduleUrl)

    const exitCode = await runOpensteerSkillsInstaller(args)
    if (exitCode !== 0) {
        process.exit(exitCode)
    }
}

async function runProfileSubcommand(args) {
    if (isProfileHelpRequest(args)) {
        process.stdout.write(PROFILE_HELP_TEXT)
        return
    }

    if (!existsSync(PROFILE_CLI_SCRIPT)) {
        throw new Error(
            `Profile CLI module was not found at "${PROFILE_CLI_SCRIPT}". Run "npm run build" to generate dist artifacts.`
        )
    }

    const moduleUrl = pathToFileURL(PROFILE_CLI_SCRIPT).href
    const { runOpensteerProfileCli } = await import(moduleUrl)
    const exitCode = await runOpensteerProfileCli(args)
    if (exitCode !== 0) {
        process.exit(exitCode)
    }
}

async function runLocalProfileSubcommand(args) {
    if (
        args.length === 0 ||
        args.includes('--help') ||
        args.includes('-h')
    ) {
        process.stdout.write(LOCAL_PROFILE_HELP_TEXT)
        return
    }

    if (!existsSync(LOCAL_PROFILE_CLI_SCRIPT)) {
        throw new Error(
            `Local profile CLI module was not found at "${LOCAL_PROFILE_CLI_SCRIPT}". Run "npm run build" to generate dist artifacts.`
        )
    }

    const moduleUrl = pathToFileURL(LOCAL_PROFILE_CLI_SCRIPT).href
    const { runOpensteerLocalProfileCli } = await import(moduleUrl)
    const exitCode = await runOpensteerLocalProfileCli(args)
    if (exitCode !== 0) {
        process.exit(exitCode)
    }
}

async function runAuthSubcommand(args) {
    if (isAuthHelpRequest(args)) {
        process.stdout.write(AUTH_HELP_TEXT)
        return
    }

    if (!existsSync(AUTH_CLI_SCRIPT)) {
        throw new Error(
            `Auth CLI module was not found at "${AUTH_CLI_SCRIPT}". Run "npm run build" to generate dist artifacts.`
        )
    }

    const moduleUrl = pathToFileURL(AUTH_CLI_SCRIPT).href
    const { runOpensteerAuthCli } = await import(moduleUrl)
    const exitCode = await runOpensteerAuthCli(args)
    if (exitCode !== 0) {
        process.exit(exitCode)
    }
}

function isAuthHelpRequest(args) {
    if (args.length === 0) return true
    const [subcommand, ...rest] = args
    if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
        return true
    }
    return rest.includes('--help') || rest.includes('-h')
}

async function ensureOpenCloudCredentials(flags, scopeDir) {
    if (!existsSync(AUTH_CLI_SCRIPT)) {
        throw new Error(
            `Auth CLI module was not found at "${AUTH_CLI_SCRIPT}". Run "npm run build" to generate dist artifacts.`
        )
    }

    const apiKeyFlag =
        typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined
    const accessTokenFlag =
        typeof flags['access-token'] === 'string'
            ? flags['access-token']
            : undefined

    const moduleUrl = pathToFileURL(AUTH_CLI_SCRIPT).href
    const { ensureCloudCredentialsForOpenCommand } = await import(moduleUrl)
    return await ensureCloudCredentialsForOpenCommand({
        scopeDir,
        env: process.env,
        apiKeyFlag,
        accessTokenFlag,
        interactive: isInteractiveTerminal(),
        writeProgress: (message) => process.stderr.write(message),
        writeStderr: (message) => process.stderr.write(message),
    })
}

function isProfileHelpRequest(args) {
    if (args.length === 0) return true
    const [subcommand, ...rest] = args
    if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
        return true
    }
    return rest.includes('--help') || rest.includes('-h')
}

function buildOpenCloudAuthPayload(auth) {
    if (!auth) {
        return null
    }

    return {
        ...(auth.kind === 'access-token'
            ? { accessToken: auth.token }
            : { apiKey: auth.token }),
        baseUrl: auth.baseUrl,
        authScheme: auth.authScheme,
    }
}

function printHelp() {
    console.log(`Usage: opensteer <command> [options]

Navigation:
  open <url>                Open browser and navigate to URL
  navigate <url>            Navigate and wait for visual stability
  back                      Go back
  forward                   Go forward
  reload                    Reload page
  close                     Close browser and server
  close --all               Close all active session-scoped servers

Sessions:
  sessions                  List active session-scoped daemons
  status                    Show resolved logical/runtime session and session state

Observation:
  snapshot [--mode action]  Get page snapshot
  state                     Get page URL, title, and snapshot
  cursor [on|off|status]    Configure/query cursor preview mode
  screenshot [file]         Take screenshot

Actions:
  click [element]           Click element
  dblclick [element]        Double-click element
  rightclick [element]      Right-click element
  hover [element]           Hover over element
  input [element] <text>    Input text into element
  select [element]          Select option from dropdown
  scroll [element]          Scroll page or element

Keyboard:
  press <key>               Press key
  type <text>               Type text into focused element

Element Info:
  get-text [element]        Get element text
  get-value [element]       Get element value
  get-attrs [element]       Get element attributes
  get-html [selector]       Get page or element HTML

Tabs:
  tabs                      List tabs
  tab-new [url]             Open new tab
  tab-switch <index>        Switch to tab
  tab-close [index]         Close tab

Cookies:
  cookies [--url]           Get cookies
  cookie-set                Set cookie (--name, --value, ...)
  cookies-clear             Clear all cookies
  cookies-export <file>     Export cookies to file
  cookies-import <file>     Import cookies from file

Utility:
  eval <expression>         Evaluate JavaScript
  wait-for <text>           Wait for text to appear
  wait-selector <selector>  Wait for selector
  extract <schema-json>     Extract structured data

API Reverse Engineering:
  api <resource> <action>   Reverse-engineer APIs from browser network traffic
  api --help                Show API reverse-engineering help

Skills:
  skills install [options]  Install Opensteer skill pack for supported agents
  skills add [options]      Alias for "skills install"
  skills --help             Show skills installer help
  profile <command>         Manage cloud browser profiles and cookie sync
  local-profile <command>   Inspect local Chrome profiles for real-browser mode
  auth <command>            Manage cloud login credentials (login/status/logout)
  login                     Alias for "auth login"
  logout                    Alias for "auth logout"

Global Flags:
  --session <id>            Logical session id (scoped by canonical cwd)
  --name <namespace>        Selector namespace for cache storage on 'open'
  --headless                Launch chromium mode in headless mode
  --browser <mode>          Browser mode: chromium or real
  --profile <name>          Browser profile directory name for real-browser mode
  --headed                  Launch real-browser mode with a visible window
  --cdp-url <url>           Connect to a running browser (e.g. http://localhost:9222)
  --user-data-dir <path>    Browser user-data root for real-browser mode
  --browser-path <path>     Override Chrome executable path for real-browser mode
  --cloud-profile-id <id>   Launch cloud session with a specific browser profile
  --cloud-profile-reuse-if-active <true|false>
                            Reuse active cloud session for that browser profile
  --cursor <true|false>     Enable/disable cursor preview for the session
  --element <N>             Target element by counter
  --selector <css>          Target element by CSS selector
  --description <text>      Description for selector persistence
  --help                    Show this help
  --version, -v             Show version

Environment:
  OPENSTEER_SESSION         Logical session id (equivalent to --session)
  OPENSTEER_CLIENT_ID       Stable client identity for default session binding
  OPENSTEER_NAME            Default selector namespace for 'open' when --name is omitted
  OPENSTEER_CURSOR          Default cursor enablement (SDK + CLI session bootstrap)
  OPENSTEER_MODE            Runtime routing: "local" (default) or "cloud"
  OPENSTEER_API_KEY         Cloud API key credential
  OPENSTEER_ACCESS_TOKEN    Cloud bearer access token credential
  OPENSTEER_BASE_URL        Override cloud control-plane base URL
  OPENSTEER_AUTH_SCHEME     Cloud auth scheme: api-key (default) or bearer
  OPENSTEER_REMOTE_ANNOUNCE Cloud session announcement policy: always (default), off, tty
  OPENSTEER_BROWSER         Local browser mode: chromium or real
  OPENSTEER_CDP_URL         Connect to a running browser (e.g. http://localhost:9222)
  OPENSTEER_USER_DATA_DIR   Browser user-data root for real-browser mode
  OPENSTEER_PROFILE_DIRECTORY Browser profile directory for real-browser mode
`)
}

function printApiHelp() {
    console.log(API_HELP_TEXT)
}

function normalizeApiCliArgs(rawArgs) {
    if (rawArgs[0] !== 'api') {
        return rawArgs
    }

    const rest = rawArgs.slice(1)
    if (
        rest.length === 0 ||
        rest[0] === '--help' ||
        rest[0] === '-h' ||
        rest[0] === 'help'
    ) {
        printApiHelp()
        process.exit(0)
    }

    if (rest[0] === 'capture' && rest[1] === 'start') {
        return ['api-capture-start', ...rest.slice(2)]
    }
    if (rest[0] === 'capture' && rest[1] === 'stop') {
        return ['api-capture-stop', ...rest.slice(2)]
    }
    if (rest[0] === 'capture' && rest[1] === 'status') {
        return ['api-capture-status', ...rest.slice(2)]
    }
    if (rest[0] === 'span' && rest[1] === 'list') {
        return ['api-span-list', ...rest.slice(2)]
    }
    if (rest[0] === 'span' && rest[1] === 'start') {
        return ['api-span-start', ...rest.slice(2)]
    }
    if (rest[0] === 'span' && rest[1] === 'stop') {
        return ['api-span-stop', ...rest.slice(2)]
    }
    if (rest[0] === 'request' && rest[1] === 'list') {
        return ['api-request-list', ...rest.slice(2)]
    }
    if (rest[0] === 'request' && rest[1] === 'inspect') {
        return ['api-request-inspect', ...rest.slice(2)]
    }
    if (rest[0] === 'slot' && rest[1] === 'list') {
        return ['api-slot-list', ...rest.slice(2)]
    }
    if (rest[0] === 'slot' && rest[1] === 'inspect') {
        return ['api-slot-inspect', ...rest.slice(2)]
    }
    if (rest[0] === 'evidence' && rest[1] === 'inspect') {
        return ['api-evidence-inspect', ...rest.slice(2)]
    }
    if (rest[0] === 'value' && rest[1] === 'trace') {
        return ['api-value-trace', ...rest.slice(2)]
    }
    if (rest[0] === 'probe' && rest[1] === 'run') {
        return ['api-probe-run', ...rest.slice(2)]
    }
    if (rest[0] === 'plan' && rest[1] === 'infer') {
        return ['api-plan-infer', ...rest.slice(2)]
    }
    if (rest[0] === 'plan' && rest[1] === 'list') {
        return ['api-plan-list', ...rest.slice(2)]
    }
    if (rest[0] === 'plan' && rest[1] === 'inspect') {
        return ['api-plan-inspect', ...rest.slice(2)]
    }
    if (rest[0] === 'plan' && rest[1] === 'validate') {
        return ['api-plan-validate', ...rest.slice(2)]
    }
    if (rest[0] === 'plan' && rest[1] === 'execute') {
        return ['api-plan-execute', ...rest.slice(2)]
    }
    if (rest[0] === 'plan' && rest[1] === 'codegen') {
        return ['api-plan-codegen', ...rest.slice(2)]
    }
    if (rest[0] === 'plan' && rest[1] === 'export') {
        return ['api-plan-export', ...rest.slice(2)]
    }
    if (rest[0] === 'plan' && rest[1] === 'render') {
        return ['api-plan-render', ...rest.slice(2)]
    }
    if (rest[0] === 'session' && rest[1] === 'ensure') {
        return ['api-session-ensure', ...rest.slice(2)]
    }

    error(`Unknown api command: ${rest.join(' ')}`)
}

async function main() {
    const rawArgs = process.argv.slice(2)
    if (rawArgs[0] === 'skills') {
        try {
            await runSkillsSubcommand(rawArgs.slice(1))
        } catch (err) {
            const message =
                err instanceof Error ? err.message : 'Failed to run skills command'
            process.stderr.write(`${message}\n`)
            process.exit(1)
        }
        return
    }
    if (rawArgs[0] === 'auth') {
        try {
            await runAuthSubcommand(rawArgs.slice(1))
        } catch (err) {
            const message =
                err instanceof Error ? err.message : 'Failed to run auth command'
            process.stderr.write(`${message}\n`)
            process.exit(1)
        }
        return
    }
    if (rawArgs[0] === 'login') {
        try {
            await runAuthSubcommand(['login', ...rawArgs.slice(1)])
        } catch (err) {
            const message =
                err instanceof Error ? err.message : 'Failed to run login command'
            process.stderr.write(`${message}\n`)
            process.exit(1)
        }
        return
    }
    if (rawArgs[0] === 'logout') {
        try {
            await runAuthSubcommand(['logout', ...rawArgs.slice(1)])
        } catch (err) {
            const message =
                err instanceof Error ? err.message : 'Failed to run logout command'
            process.stderr.write(`${message}\n`)
            process.exit(1)
        }
        return
    }
    if (rawArgs[0] === 'profile') {
        try {
            await runProfileSubcommand(rawArgs.slice(1))
        } catch (err) {
            const message =
                err instanceof Error ? err.message : 'Failed to run profile command'
            process.stderr.write(`${message}\n`)
            process.exit(1)
        }
        return
    }
    if (rawArgs[0] === 'local-profile') {
        try {
            await runLocalProfileSubcommand(rawArgs.slice(1))
        } catch (err) {
            const message =
                err instanceof Error
                    ? err.message
                    : 'Failed to run local-profile command'
            process.stderr.write(`${message}\n`)
            process.exit(1)
        }
        return
    }

    const scopeDir = resolveScopeDir()

    const normalizedArgs = normalizeApiCliArgs(rawArgs)
    const { command, flags, positional } = parseArgs([
        process.argv[0],
        process.argv[1],
        ...normalizedArgs,
    ])

    if (
        flags['connect-url'] !== undefined ||
        flags.channel !== undefined ||
        flags['profile-dir'] !== undefined
    ) {
        error(
            '--connect-url, --channel, and --profile-dir are no longer supported. Use --cdp-url, --browser real, --profile, --user-data-dir, and --browser-path instead.'
        )
    }

    if (command === 'sessions') {
        output({ ok: true, sessions: listSessions() })
        return
    }

    if (command === 'close' && flags.all === true) {
        try {
            const closed = await closeAllSessions()
            output({ ok: true, closed })
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to close sessions')
        }
        return
    }

    let openCloudAuth = null
    if (command === 'open') {
        try {
            openCloudAuth = await ensureOpenCloudCredentials(flags, scopeDir)
        } catch (err) {
            error(
                err instanceof Error
                    ? err.message
                    : 'Failed to resolve cloud authentication for open command.'
            )
        }
    }

    let resolvedSession
    let resolvedName
    try {
        resolvedSession = resolveSession(flags, scopeDir)
        resolvedName = resolveName(flags, resolvedSession.session)
    } catch (err) {
        error(err instanceof Error ? err.message : 'Failed to resolve session')
    }

    const logicalSession = resolvedSession.session
    const runtimeSession = buildRuntimeSession(scopeDir, logicalSession)
    const sessionSource = resolvedSession.source
    const name = resolvedName.name
    const nameSource = resolvedName.source
    const socketPath = getSocketPath(runtimeSession)
    const routingContext = {
        logicalSession,
        runtimeSession,
        scopeDir,
    }

    if (command === 'status') {
        output({
            ok: true,
            resolvedSession: logicalSession,
            logicalSession,
            runtimeSession,
            scopeDir,
            sessionSource,
            resolvedName: name,
            nameSource,
            serverRunning: await isServerHealthy(runtimeSession),
            socketPath,
            sessions: listSessions(),
        })
        return
    }

    if (command === 'api-capture-status') {
        const serverRunning = await isServerHealthy(runtimeSession)
        if (!serverRunning) {
            output({
                ok: true,
                active: false,
                runRef: null,
                runDir: null,
                requestCount: 0,
                spanCount: 0,
                actionFactCount: 0,
                planCount: 0,
                validationCount: 0,
                probeCount: 0,
                activeManualSpanRef: null,
                resolvedSession: logicalSession,
                runtimeSession,
                scopeDir,
                serverRunning: false,
            })
            return
        }
    }

    delete flags.name
    delete flags.session
    delete flags.all
    delete flags['api-key']
    delete flags['access-token']

    const request = buildRequest(command, flags, positional)
    if (command === 'open') {
        request.args.name = name
        const cloudAuthPayload = buildOpenCloudAuthPayload(openCloudAuth)
        if (cloudAuthPayload) {
            request.args['cloud-auth'] = cloudAuthPayload
        }
    }

    if (!(await isServerHealthy(runtimeSession))) {
        try {
            await ensureServer(routingContext)
        } catch (err) {
            error(
                err instanceof Error
                    ? err.message
                    : `Failed to start server for session '${logicalSession}' in cwd scope '${scopeDir}'.`
            )
        }
    }

    try {
        const response = await sendCommand(socketPath, request)

        if (response.ok) {
            output({ ok: true, ...response.result })
        } else {
            process.stderr.write(JSON.stringify(normalizeFailedResponse(response)) + '\n')
            process.exit(1)
        }
    } catch (err) {
        error(
            formatTransportFailure(
                err,
                `Failed to run '${command}' for session '${logicalSession}' in cwd scope '${scopeDir}'`
            )
        )
    }
}

main()
