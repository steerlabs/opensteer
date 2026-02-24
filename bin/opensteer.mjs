#!/usr/bin/env node

import { spawn } from 'child_process'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_SCRIPT = join(__dirname, '..', 'dist', 'cli', 'server.js')

const CONNECT_TIMEOUT = 15000
const POLL_INTERVAL = 100
const RESPONSE_TIMEOUT = 120000
const RUNTIME_PREFIX = 'opensteer-'
const SOCKET_SUFFIX = '.sock'
const PID_SUFFIX = '.pid'
const CLOSE_ALL_REQUEST = { id: 1, command: 'close', args: {} }

function parseArgs(argv) {
    const args = argv.slice(2)
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printHelp()
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

function resolveNamespace(flags) {
    if (flags.name !== undefined && String(flags.name).trim().length > 0) {
        return sanitizeNamespace(String(flags.name))
    }

    if (
        typeof process.env.OPENSTEER_NAME === 'string' &&
        process.env.OPENSTEER_NAME.trim().length > 0
    ) {
        return sanitizeNamespace(process.env.OPENSTEER_NAME)
    }

    const cwdBase = basename(process.cwd())
    if (cwdBase && cwdBase !== '.' && cwdBase !== '/') {
        return sanitizeNamespace(cwdBase)
    }

    return 'default'
}

function getSocketPath(namespace) {
    return join(tmpdir(), `${RUNTIME_PREFIX}${namespace}${SOCKET_SUFFIX}`)
}

function getPidPath(namespace) {
    return join(tmpdir(), `${RUNTIME_PREFIX}${namespace}${PID_SUFFIX}`)
}

function buildRequest(command, flags, positional) {
    const id = 1
    const globalFlags = {}
    for (const key of ['headless', 'json', 'connect-url', 'channel', 'profile-dir']) {
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

function cleanStaleFiles(namespace) {
    try {
        unlinkSync(getSocketPath(namespace))
    } catch { }
    try {
        unlinkSync(getPidPath(namespace))
    } catch { }
}

function isServerRunning(namespace) {
    const pidPath = getPidPath(namespace)
    const pid = readPid(pidPath)
    if (!pid) {
        cleanStaleFiles(namespace)
        return false
    }

    if (!isPidAlive(pid)) {
        cleanStaleFiles(namespace)
        return false
    }

    return existsSync(getSocketPath(namespace))
}

function startServer(namespace) {
    const child = spawn('node', [SERVER_SCRIPT], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
            ...process.env,
            OPENSTEER_NAME: namespace,
        },
    })
    child.unref()
}

function waitForSocket(socketPath, timeout) {
    return new Promise((resolve, reject) => {
        const start = Date.now()

        function poll() {
            if (Date.now() - start > timeout) {
                reject(new Error('Timed out waiting for server to start'))
                return
            }

            if (existsSync(socketPath)) {
                resolve()
                return
            }

            setTimeout(poll, POLL_INTERVAL)
        }

        poll()
    })
}

function sendCommand(socketPath, request) {
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
        }, RESPONSE_TIMEOUT)

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

function listSessions() {
    const sessions = []
    const entries = readdirSync(tmpdir())

    for (const entry of entries) {
        if (!entry.startsWith(RUNTIME_PREFIX) || !entry.endsWith(PID_SUFFIX)) {
            continue
        }

        const name = entry.slice(
            RUNTIME_PREFIX.length,
            entry.length - PID_SUFFIX.length
        )
        if (!name) {
            continue
        }

        const pid = readPid(join(tmpdir(), entry))
        if (!pid || !isPidAlive(pid)) {
            cleanStaleFiles(name)
            continue
        }

        sessions.push({ name, pid })
    }

    sessions.sort((a, b) => a.name.localeCompare(b.name))
    return sessions
}

async function closeAllSessions() {
    const sessions = listSessions()
    const closed = []
    const failures = []

    for (const session of sessions) {
        const socketPath = getSocketPath(session.name)
        if (!existsSync(socketPath)) {
            cleanStaleFiles(session.name)
            continue
        }

        try {
            const response = await sendCommand(socketPath, CLOSE_ALL_REQUEST)
            if (response && response.ok === true) {
                closed.push(session)
            } else {
                failures.push(
                    `${session.name}: ${response?.error || 'unknown close error'}`
                )
            }
        } catch (err) {
            failures.push(
                `${session.name}: ${err instanceof Error ? err.message : String(err)}`
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

function printHelp() {
    console.log(`Usage: opensteer <command> [options]

Navigation:
  open <url>                Open browser and navigate to URL
  navigate <url>            Navigate and wait for visual stability
  back                      Go back
  forward                   Go forward
  reload                    Reload page
  close                     Close browser and server
  close --all               Close all active namespace-scoped servers

Sessions:
  sessions                  List active namespace-scoped sessions

Observation:
  snapshot [--mode action]  Get page snapshot
  state                     Get page URL, title, and snapshot
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

Global Flags:
  --name <namespace>        Session namespace (default: CWD basename or OPENSTEER_NAME)
  --headless                Launch browser in headless mode
  --connect-url <url>       Connect to a running browser (e.g. http://localhost:9222)
  --channel <browser>       Use installed browser (chrome, chrome-beta, msedge)
  --profile-dir <path>      Browser profile directory for logged-in sessions
  --element <N>             Target element by counter
  --selector <css>          Target element by CSS selector
  --description <text>      Description for selector persistence
  --help                    Show this help

Environment:
  OPENSTEER_NAME            Default session namespace when --name is omitted
  OPENSTEER_MODE            Runtime mode: "local" (default) or "remote"
  OPENSTEER_API_KEY         Required when remote mode is selected
  OPENSTEER_BASE_URL        Override remote control-plane base URL
`)
}

async function main() {
    const { command, flags, positional } = parseArgs(process.argv)
    const namespace = resolveNamespace(flags)
    const socketPath = getSocketPath(namespace)

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

    delete flags.name
    delete flags.all
    const request = buildRequest(command, flags, positional)

    if (!isServerRunning(namespace)) {
        if (!existsSync(SERVER_SCRIPT)) {
            error(
                `Server script not found: ${SERVER_SCRIPT}. Run the build script first.`
            )
        }
        startServer(namespace)
        try {
            await waitForSocket(socketPath, CONNECT_TIMEOUT)
        } catch {
            error('Failed to start server. Check that the build is complete.')
        }
    }

    try {
        const response = await sendCommand(socketPath, request)

        if (response.ok) {
            output({ ok: true, ...response.result })
        } else {
            process.stderr.write(
                JSON.stringify({ ok: false, error: response.error }) + '\n'
            )
            process.exit(1)
        }
    } catch (err) {
        error(err instanceof Error ? err.message : 'Connection failed')
    }
}

main()
