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
            if (next !== undefined && !next.startsWith('--')) {
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
        'connect-url',
        'channel',
        'profile-dir',
        'cursor',
    ]) {
        if (key in flags) {
            globalFlags[key] = flags[key]
            delete flags[key]
        }
    }

    const args = { ...globalFlags, ...flags }

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
        if (existingPid && isPidAlive(existingPid)) {
            await sleep(POLL_INTERVAL)
            continue
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

Skills:
  skills install [options]  Install Opensteer skill pack for supported agents
  skills add [options]      Alias for "skills install"
  skills --help             Show skills installer help

Global Flags:
  --session <id>            Logical session id (scoped by canonical cwd)
  --name <namespace>        Selector namespace for cache storage on 'open'
  --headless                Launch browser in headless mode
  --connect-url <url>       Connect to a running browser (e.g. http://localhost:9222)
  --channel <browser>       Use installed browser (chrome, chrome-beta, msedge)
  --profile-dir <path>      Browser profile directory for logged-in sessions
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
  OPENSTEER_API_KEY         Required when cloud mode is selected
  OPENSTEER_BASE_URL        Override cloud control-plane base URL
  OPENSTEER_AUTH_SCHEME     Cloud auth scheme: api-key (default) or bearer
  OPENSTEER_REMOTE_ANNOUNCE Cloud session announcement policy: always (default), off, tty
`)
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

    const { command, flags, positional } = parseArgs(process.argv)

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

    let resolvedSession
    let resolvedName
    const scopeDir = resolveScopeDir()
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

    delete flags.name
    delete flags.session
    delete flags.all

    const request = buildRequest(command, flags, positional)
    if (command === 'open') {
        request.args.name = name
    }

    if (!(await isServerHealthy(runtimeSession))) {
        if (command !== 'open') {
            error(
                `No server running for session '${logicalSession}' in cwd scope '${scopeDir}' (resolved from ${sessionSource}). Run 'opensteer open' first or use 'opensteer sessions' to see active sessions.`
            )
        }

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
