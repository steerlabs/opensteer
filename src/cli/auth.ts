import { spawn } from 'node:child_process'
import { DEFAULT_CLOUD_BASE_URL } from '../cloud/runtime.js'
import { normalizeCloudBaseUrl } from '../cloud/http-client.js'
import { resolveCloudSelection, resolveConfigWithEnv } from '../config.js'
import type { OpensteerAuthScheme } from '../types.js'
import {
    applyCloudCredentialToEnv,
    resolveCloudCredential,
    type ResolvedCloudCredential,
} from '../auth/credential-resolver.js'
import {
    createMachineCredentialStore,
    type StoredMachineCloudCredential,
    type WriteMachineCloudCredentialArgs,
} from '../auth/machine-credential-store.js'

interface CliDeviceStartResponse {
    device_code: string
    user_code: string
    verification_uri: string
    verification_uri_complete: string
    expires_in: number
    interval: number
}

interface CliTokenResponse {
    access_token: string
    token_type: string
    expires_in: number
    refresh_token: string
    scope?: string
}

interface CliOauthErrorResponse {
    error?: string
    error_description?: string
    interval?: number
}

class CliAuthHttpError extends Error {
    readonly status: number
    readonly body: unknown

    constructor(message: string, status: number, body: unknown) {
        super(message)
        this.name = 'CliAuthHttpError'
        this.status = status
        this.body = body
    }
}

export type AuthFetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface CloudCredentialStore {
    readCloudCredential(): StoredMachineCloudCredential | null
    writeCloudCredential(args: WriteMachineCloudCredentialArgs): void
    clearCloudCredential(): void
}

export interface EnsuredCloudAuthContext {
    token: string
    authScheme: OpensteerAuthScheme
    source: 'flag' | 'env' | 'saved'
    kind: 'api-key' | 'access-token'
    baseUrl: string
    siteUrl: string
}

export interface EnsureCloudCredentialsOptions {
    commandName: string
    env?: Record<string, string | undefined>
    store?: CloudCredentialStore
    apiKeyFlag?: string
    accessTokenFlag?: string
    baseUrl?: string
    siteUrl?: string
    interactive?: boolean
    autoLoginIfNeeded?: boolean
    writeStdout?: (message: string) => void
    writeStderr?: (message: string) => void
    fetchFn?: AuthFetchFn
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    openExternalUrl?: (url: string) => void
}

export interface EnsureCloudCredentialsForOpenOptions {
    scopeDir: string
    env?: Record<string, string | undefined>
    apiKeyFlag?: string
    accessTokenFlag?: string
    interactive?: boolean
    writeStdout?: (message: string) => void
    writeStderr?: (message: string) => void
    fetchFn?: AuthFetchFn
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    openExternalUrl?: (url: string) => void
}

interface AuthCliDeps {
    env: Record<string, string | undefined>
    store: CloudCredentialStore
    fetchFn: AuthFetchFn
    writeStdout: (message: string) => void
    writeStderr: (message: string) => void
    isInteractive: () => boolean
    sleep: (ms: number) => Promise<void>
    now: () => number
    openExternalUrl: (url: string) => void
}

interface DeviceLoginResult {
    accessToken: string
    refreshToken: string
    expiresAt: number
    scope: string[]
}

interface RefreshResult {
    accessToken: string
    refreshToken: string
    expiresAt: number
    scope: string[]
}

interface AuthCommonArgs {
    baseUrl?: string
    siteUrl?: string
    json?: boolean
}

interface AuthLoginArgs extends AuthCommonArgs {
    openBrowser: boolean
}

interface AuthStatusArgs extends AuthCommonArgs {}
interface AuthLogoutArgs extends AuthCommonArgs {}

type ParsedAuthArgs =
    | { mode: 'help' }
    | { mode: 'error'; error: string }
    | { mode: 'login'; args: AuthLoginArgs }
    | { mode: 'status'; args: AuthStatusArgs }
    | { mode: 'logout'; args: AuthLogoutArgs }

const HELP_TEXT = `Usage: opensteer auth <command> [options]

Authenticate Opensteer CLI with Opensteer Cloud.

Commands:
  login                     Start device login flow in browser
  status                    Show saved machine login state
  logout                    Revoke and remove saved machine login

Options:
  --base-url <url>          Cloud API base URL (defaults to OPENSTEER_BASE_URL)
  --site-url <url>          Cloud site URL for browser/device auth
  --json                    Print JSON output
  --no-browser              Do not auto-open browser during login
  -h, --help                Show this help
`

function createDefaultDeps(): AuthCliDeps {
    const env = process.env as Record<string, string | undefined>
    return {
        env,
        store: createMachineCredentialStore({
            env,
            warn: (warning) => {
                process.stderr.write(`${warning.message} (${warning.path})\n`)
            },
        }),
        fetchFn: fetch,
        writeStdout: (message) => process.stdout.write(message),
        writeStderr: (message) => process.stderr.write(message),
        isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
        sleep: async (ms) => {
            await new Promise((resolve) => setTimeout(resolve, ms))
        },
        now: () => Date.now(),
        openExternalUrl: (url) => {
            openBrowser(url)
        },
    }
}

function readFlagValue(
    args: string[],
    index: number,
    flag: string
): { ok: true; value: string; nextIndex: number } | { ok: false; error: string } {
    const value = args[index + 1]
    if (value === undefined || value.startsWith('-')) {
        return {
            ok: false,
            error: `${flag} requires a value.`,
        }
    }
    return {
        ok: true,
        value,
        nextIndex: index + 1,
    }
}

function parseAuthCommonArgs(rawArgs: string[]): {
    args: AuthCommonArgs
    error?: string
} {
    const args: AuthCommonArgs = {}

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i]
        if (arg === '--json') {
            args.json = true
            continue
        }
        if (arg === '--base-url') {
            const value = readFlagValue(rawArgs, i, '--base-url')
            if (!value.ok) return { args, error: value.error }
            args.baseUrl = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--site-url') {
            const value = readFlagValue(rawArgs, i, '--site-url')
            if (!value.ok) return { args, error: value.error }
            args.siteUrl = value.value
            i = value.nextIndex
            continue
        }

        return {
            args,
            error: `Unsupported option "${arg}".`,
        }
    }

    return { args }
}

export function parseOpensteerAuthArgs(rawArgs: string[]): ParsedAuthArgs {
    if (!rawArgs.length) {
        return { mode: 'help' }
    }

    const [subcommand, ...rest] = rawArgs
    if (
        subcommand === '--help' ||
        subcommand === '-h' ||
        subcommand === 'help'
    ) {
        return { mode: 'help' }
    }

    if (subcommand === 'login') {
        let openBrowser = true
        const filtered: string[] = []
        for (const arg of rest) {
            if (arg === '--no-browser') {
                openBrowser = false
                continue
            }
            filtered.push(arg)
        }
        const parsed = parseAuthCommonArgs(filtered)
        if (parsed.error) return { mode: 'error', error: parsed.error }
        return {
            mode: 'login',
            args: {
                ...parsed.args,
                openBrowser,
            },
        }
    }

    if (subcommand === 'status') {
        const parsed = parseAuthCommonArgs(rest)
        if (parsed.error) return { mode: 'error', error: parsed.error }
        return { mode: 'status', args: parsed.args }
    }

    if (subcommand === 'logout') {
        const parsed = parseAuthCommonArgs(rest)
        if (parsed.error) return { mode: 'error', error: parsed.error }
        return { mode: 'logout', args: parsed.args }
    }

    return {
        mode: 'error',
        error: `Unsupported auth subcommand "${subcommand}".`,
    }
}

function printHelp(deps: AuthCliDeps): void {
    deps.writeStdout(`${HELP_TEXT}\n`)
}

function writeHumanLine(deps: AuthCliDeps, message: string): void {
    deps.writeStdout(`${message}\n`)
}

function writeJsonLine(deps: AuthCliDeps, payload: unknown): void {
    deps.writeStdout(`${JSON.stringify(payload)}\n`)
}

function resolveBaseUrl(
    provided: string | undefined,
    env: Record<string, string | undefined>
): string {
    const baseUrl = normalizeCloudBaseUrl(
        (provided || env.OPENSTEER_BASE_URL || DEFAULT_CLOUD_BASE_URL).trim()
    )
    assertSecureUrl(baseUrl, '--base-url')
    return baseUrl
}

function resolveSiteUrl(
    provided: string | undefined,
    baseUrl: string,
    env: Record<string, string | undefined>
): string {
    const siteUrl = normalizeCloudBaseUrl(
        (
            provided ||
            env.OPENSTEER_CLOUD_SITE_URL ||
            deriveSiteUrlFromBaseUrl(baseUrl)
        ).trim()
    )
    assertSecureUrl(siteUrl, '--site-url')
    return siteUrl
}

function deriveSiteUrlFromBaseUrl(baseUrl: string): string {
    let parsed: URL
    try {
        parsed = new URL(baseUrl)
    } catch {
        return 'https://opensteer.com'
    }

    const hostname = parsed.hostname.toLowerCase()
    if (hostname.startsWith('api.')) {
        parsed.hostname = hostname.slice('api.'.length)
        parsed.pathname = ''
        parsed.search = ''
        parsed.hash = ''
        return parsed.toString().replace(/\/+$/, '')
    }

    if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1'
    ) {
        parsed.port = '3001'
        parsed.pathname = ''
        parsed.search = ''
        parsed.hash = ''
        return parsed.toString().replace(/\/+$/, '')
    }

    parsed.pathname = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/, '')
}

function assertSecureUrl(value: string, flag: string): void {
    let parsed: URL
    try {
        parsed = new URL(value)
    } catch {
        throw new Error(`Invalid ${flag} "${value}".`)
    }

    if (parsed.protocol === 'https:') {
        return
    }

    if (parsed.protocol === 'http:') {
        const host = parsed.hostname.toLowerCase()
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
            return
        }
    }

    throw new Error(
        `Insecure URL "${value}". Use HTTPS, or HTTP only for localhost.`
    )
}

async function postJson<TResponse>(
    fetchFn: AuthFetchFn,
    url: string,
    body: Record<string, unknown>
): Promise<TResponse> {
    const response = await fetchFn(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    })

    let payload: unknown = null
    try {
        payload = await response.json()
    } catch {
        payload = null
    }

    if (!response.ok) {
        throw new CliAuthHttpError(
            `Auth request failed with status ${response.status}.`,
            response.status,
            payload
        )
    }

    return payload as TResponse
}

function parseScope(rawScope: string | undefined): string[] {
    if (!rawScope) return ['cloud:browser']
    const values = rawScope
        .split(' ')
        .map((value) => value.trim())
        .filter(Boolean)
    return values.length ? values : ['cloud:browser']
}

function parseCliTokenResponse(payload: CliTokenResponse): {
    accessToken: string
    refreshToken: string
    expiresInSec: number
    scope: string[]
} {
    const accessToken =
        typeof payload.access_token === 'string' ? payload.access_token.trim() : ''
    const refreshToken =
        typeof payload.refresh_token === 'string' ? payload.refresh_token.trim() : ''
    const expiresInSec =
        typeof payload.expires_in === 'number' &&
        Number.isFinite(payload.expires_in) &&
        payload.expires_in > 0
            ? Math.trunc(payload.expires_in)
            : 0

    if (!accessToken || !refreshToken || !expiresInSec) {
        throw new Error('Invalid token response from cloud auth endpoint.')
    }

    return {
        accessToken,
        refreshToken,
        expiresInSec,
        scope: parseScope(payload.scope),
    }
}

function parseCliOauthError(error: unknown): CliOauthErrorResponse | null {
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
        return null
    }
    const root = error as Record<string, unknown>
    return {
        error: typeof root.error === 'string' ? root.error : undefined,
        error_description:
            typeof root.error_description === 'string'
                ? root.error_description
                : undefined,
        interval: typeof root.interval === 'number' ? root.interval : undefined,
    }
}

async function startDeviceAuthorization(
    siteUrl: string,
    fetchFn: AuthFetchFn
): Promise<CliDeviceStartResponse> {
    const response = await postJson<CliDeviceStartResponse>(
        fetchFn,
        `${siteUrl}/api/cli-auth/device/start`,
        {
            scope: ['cloud:browser'],
        }
    )

    if (
        !response ||
        typeof response.device_code !== 'string' ||
        !response.device_code.trim() ||
        typeof response.user_code !== 'string' ||
        !response.user_code.trim() ||
        typeof response.verification_uri_complete !== 'string' ||
        !response.verification_uri_complete.trim() ||
        typeof response.expires_in !== 'number' ||
        response.expires_in <= 0 ||
        typeof response.interval !== 'number' ||
        response.interval <= 0
    ) {
        throw new Error('Invalid device authorization response from cloud.')
    }

    return response
}

async function pollDeviceToken(
    siteUrl: string,
    deviceCode: string,
    fetchFn: AuthFetchFn
): Promise<CliTokenResponse> {
    return await postJson<CliTokenResponse>(
        fetchFn,
        `${siteUrl}/api/cli-auth/device/token`,
        {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
        }
    )
}

async function refreshToken(
    siteUrl: string,
    refreshTokenValue: string,
    fetchFn: AuthFetchFn
): Promise<CliTokenResponse> {
    return await postJson<CliTokenResponse>(fetchFn, `${siteUrl}/api/cli-auth/token`, {
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
    })
}

async function revokeToken(
    siteUrl: string,
    refreshTokenValue: string,
    fetchFn: AuthFetchFn
): Promise<void> {
    await postJson<{ revoked: boolean }>(fetchFn, `${siteUrl}/api/cli-auth/revoke`, {
        token: refreshTokenValue,
    })
}

function openBrowser(url: string): void {
    try {
        if (process.platform === 'darwin') {
            const child = spawn('open', [url], {
                detached: true,
                stdio: 'ignore',
            })
            child.unref()
            return
        }

        if (process.platform === 'win32') {
            const child = spawn('cmd', ['/c', 'start', '', url], {
                detached: true,
                stdio: 'ignore',
            })
            child.unref()
            return
        }

        const child = spawn('xdg-open', [url], {
            detached: true,
            stdio: 'ignore',
        })
        child.unref()
    } catch {}
}

async function runDeviceLoginFlow(
    args: {
        siteUrl: string
        fetchFn: AuthFetchFn
        writeStdout: (message: string) => void
        openExternalUrl: (url: string) => void
        sleep: (ms: number) => Promise<void>
        now: () => number
        openBrowser: boolean
    }
): Promise<DeviceLoginResult> {
    const start = await startDeviceAuthorization(args.siteUrl, args.fetchFn)

    args.writeStdout(
        `Open this URL to authenticate Opensteer CLI:\n${start.verification_uri_complete}\n`
    )
    args.writeStdout(`Verification code: ${start.user_code}\n`)

    if (args.openBrowser) {
        args.openExternalUrl(start.verification_uri_complete)
        args.writeStdout('Opened browser for authentication.\n')
    }

    const deadline = args.now() + start.expires_in * 1000
    let pollIntervalMs = Math.max(1, Math.trunc(start.interval)) * 1000

    while (args.now() <= deadline) {
        await args.sleep(pollIntervalMs)

        try {
            const tokenPayload = await pollDeviceToken(
                args.siteUrl,
                start.device_code,
                args.fetchFn
            )
            const parsed = parseCliTokenResponse(tokenPayload)
            return {
                accessToken: parsed.accessToken,
                refreshToken: parsed.refreshToken,
                expiresAt: args.now() + parsed.expiresInSec * 1000,
                scope: parsed.scope,
            }
        } catch (error) {
            if (error instanceof CliAuthHttpError) {
                const oauthError = parseCliOauthError(error.body)
                if (!oauthError?.error) {
                    throw error
                }

                if (oauthError.error === 'authorization_pending') {
                    continue
                }
                if (oauthError.error === 'slow_down') {
                    const hintedInterval =
                        typeof oauthError.interval === 'number' &&
                        oauthError.interval > 0
                            ? Math.trunc(oauthError.interval) * 1000
                            : pollIntervalMs + 5000
                    pollIntervalMs = Math.max(hintedInterval, pollIntervalMs + 1000)
                    continue
                }
                if (oauthError.error === 'expired_token') {
                    throw new Error(
                        'Device authorization expired before approval. Run "opensteer auth login" again.'
                    )
                }
                if (oauthError.error === 'access_denied') {
                    throw new Error(
                        'Cloud login was denied. Run "opensteer auth login" to retry.'
                    )
                }
                throw new Error(
                    oauthError.error_description ||
                        `Cloud login failed: ${oauthError.error}.`
                )
            }
            throw error
        }
    }

    throw new Error(
        'Timed out waiting for cloud login approval. Run "opensteer auth login" again.'
    )
}

async function refreshSavedCredential(
    saved: StoredMachineCloudCredential,
    deps: Pick<AuthCliDeps, 'fetchFn' | 'store' | 'now'>
): Promise<RefreshResult> {
    const tokenPayload = await refreshToken(
        saved.siteUrl,
        saved.refreshToken,
        deps.fetchFn
    )
    const parsed = parseCliTokenResponse(tokenPayload)
    const updated: RefreshResult = {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: deps.now() + parsed.expiresInSec * 1000,
        scope: parsed.scope,
    }

    deps.store.writeCloudCredential({
        baseUrl: saved.baseUrl,
        siteUrl: saved.siteUrl,
        scope: updated.scope,
        accessToken: updated.accessToken,
        refreshToken: updated.refreshToken,
        obtainedAt: deps.now(),
        expiresAt: updated.expiresAt,
    })

    return updated
}

async function ensureSavedCredentialIsFresh(
    credential: ResolvedCloudCredential,
    deps: Pick<AuthCliDeps, 'fetchFn' | 'store' | 'now' | 'writeStderr'>
): Promise<ResolvedCloudCredential | null> {
    const saved = credential.savedCredential
    if (!saved) return credential

    const refreshSkewMs = 60_000
    if (saved.expiresAt > deps.now() + refreshSkewMs) {
        return credential
    }

    try {
        const refreshed = await refreshSavedCredential(saved, deps)
        return {
            ...credential,
            token: refreshed.accessToken,
            savedCredential: {
                ...saved,
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken,
                expiresAt: refreshed.expiresAt,
                scope: refreshed.scope,
                obtainedAt: deps.now(),
            },
        }
    } catch (error) {
        if (error instanceof CliAuthHttpError) {
            const oauth = parseCliOauthError(error.body)
            if (oauth?.error === 'invalid_grant' || oauth?.error === 'expired_token') {
                deps.store.clearCloudCredential()
                return null
            }
        }
        deps.writeStderr(
            `Unable to refresh saved cloud login: ${
                error instanceof Error ? error.message : 'unknown error'
            }\n`
        )
        return null
    }
}

function toAuthMissingMessage(commandName: string): string {
    return [
        `${commandName} requires cloud authentication.`,
        'Use --api-key, --access-token, OPENSTEER_API_KEY, OPENSTEER_ACCESS_TOKEN, or run "opensteer auth login".',
    ].join(' ')
}

export function isCloudModeEnabledForRootDir(rootDir: string): boolean {
    const resolved = resolveConfigWithEnv({
        storage: { rootDir },
    })
    return resolveCloudSelection(
        {
            cloud: resolved.config.cloud,
        },
        resolved.env
    ).cloud
}

export async function ensureCloudCredentialsForOpenCommand(
    options: EnsureCloudCredentialsForOpenOptions
): Promise<EnsuredCloudAuthContext | null> {
    const env = options.env ?? (process.env as Record<string, string | undefined>)
    if (!isCloudModeEnabledForRootDir(options.scopeDir)) {
        return null
    }

    return await ensureCloudCredentialsForCommand({
        commandName: 'opensteer open',
        env,
        apiKeyFlag: options.apiKeyFlag,
        accessTokenFlag: options.accessTokenFlag,
        interactive: options.interactive,
        autoLoginIfNeeded: true,
        writeStdout: options.writeStdout,
        writeStderr: options.writeStderr,
        fetchFn: options.fetchFn,
        sleep: options.sleep,
        now: options.now,
        openExternalUrl: options.openExternalUrl,
    })
}

export async function ensureCloudCredentialsForCommand(
    options: EnsureCloudCredentialsOptions
): Promise<EnsuredCloudAuthContext> {
    const env = options.env ?? (process.env as Record<string, string | undefined>)
    const writeStdout = options.writeStdout ?? ((message: string) => process.stdout.write(message))
    const writeStderr = options.writeStderr ?? ((message: string) => process.stderr.write(message))
    const fetchFn = options.fetchFn ?? fetch
    const sleep = options.sleep ?? (async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, ms))
    })
    const now = options.now ?? Date.now
    const openExternalUrl = options.openExternalUrl ?? openBrowser
    const store =
        options.store ??
        createMachineCredentialStore({
            env,
            warn: (warning) => {
                writeStderr(`${warning.message} (${warning.path})\n`)
            },
        })

    const baseUrl = resolveBaseUrl(options.baseUrl, env)
    const siteUrl = resolveSiteUrl(options.siteUrl, baseUrl, env)

    const initialCredential = resolveCloudCredential({
        env,
        apiKeyFlag: options.apiKeyFlag,
        accessTokenFlag: options.accessTokenFlag,
        store,
        allowSaved: true,
    })

    let credential: ResolvedCloudCredential | null = initialCredential
    if (credential?.source === 'saved') {
        credential = await ensureSavedCredentialIsFresh(credential, {
            fetchFn,
            store,
            now,
            writeStderr,
        })
    }

    if (!credential) {
        if (options.autoLoginIfNeeded && (options.interactive ?? false)) {
            const loggedIn = await runDeviceLoginFlow({
                siteUrl,
                fetchFn,
                writeStdout,
                openExternalUrl,
                sleep,
                now,
                openBrowser: true,
            })

            store.writeCloudCredential({
                baseUrl,
                siteUrl,
                scope: loggedIn.scope,
                accessToken: loggedIn.accessToken,
                refreshToken: loggedIn.refreshToken,
                obtainedAt: now(),
                expiresAt: loggedIn.expiresAt,
            })

            credential = {
                kind: 'access-token',
                source: 'saved',
                token: loggedIn.accessToken,
                authScheme: 'bearer',
            }
            writeStdout('Cloud login complete.\n')
        } else {
            throw new Error(toAuthMissingMessage(options.commandName))
        }
    }

    applyCloudCredentialToEnv(env, credential)
    env.OPENSTEER_BASE_URL = baseUrl
    env.OPENSTEER_CLOUD_SITE_URL = siteUrl

    return {
        token: credential.token,
        authScheme: credential.authScheme,
        source: credential.source,
        kind: credential.kind,
        baseUrl,
        siteUrl,
    }
}

async function runLogin(
    args: AuthLoginArgs,
    deps: AuthCliDeps
): Promise<number> {
    const baseUrl = resolveBaseUrl(args.baseUrl, deps.env)
    const siteUrl = resolveSiteUrl(args.siteUrl, baseUrl, deps.env)
    const login = await runDeviceLoginFlow({
        siteUrl,
        fetchFn: deps.fetchFn,
        writeStdout: deps.writeStdout,
        openExternalUrl: deps.openExternalUrl,
        sleep: deps.sleep,
        now: deps.now,
        openBrowser: args.openBrowser,
    })

    deps.store.writeCloudCredential({
        baseUrl,
        siteUrl,
        scope: login.scope,
        accessToken: login.accessToken,
        refreshToken: login.refreshToken,
        obtainedAt: deps.now(),
        expiresAt: login.expiresAt,
    })

    if (args.json) {
        writeJsonLine(deps, {
            loggedIn: true,
            baseUrl,
            siteUrl,
            expiresAt: login.expiresAt,
            scope: login.scope,
            authSource: 'device',
        })
        return 0
    }

    writeHumanLine(deps, 'Opensteer CLI login successful.')
    writeHumanLine(deps, `  Site URL: ${siteUrl}`)
    writeHumanLine(deps, `  API Base URL: ${baseUrl}`)
    writeHumanLine(deps, `  Expires At: ${new Date(login.expiresAt).toISOString()}`)
    return 0
}

async function runStatus(
    args: AuthStatusArgs,
    deps: AuthCliDeps
): Promise<number> {
    const saved = deps.store.readCloudCredential()
    if (!saved) {
        if (args.json) {
            writeJsonLine(deps, { loggedIn: false })
        } else {
            writeHumanLine(deps, 'Opensteer CLI is not logged in.')
        }
        return 0
    }

    const now = deps.now()
    const expired = saved.expiresAt <= now
    if (args.json) {
        writeJsonLine(deps, {
            loggedIn: true,
            expired,
            baseUrl: saved.baseUrl,
            siteUrl: saved.siteUrl,
            expiresAt: saved.expiresAt,
            scope: saved.scope,
        })
        return 0
    }

    writeHumanLine(
        deps,
        expired
            ? 'Opensteer CLI has a saved login, but the access token is expired.'
            : 'Opensteer CLI is logged in.'
    )
    writeHumanLine(deps, `  Site URL: ${saved.siteUrl}`)
    writeHumanLine(deps, `  API Base URL: ${saved.baseUrl}`)
    writeHumanLine(deps, `  Expires At: ${new Date(saved.expiresAt).toISOString()}`)
    return 0
}

async function runLogout(
    args: AuthLogoutArgs,
    deps: AuthCliDeps
): Promise<number> {
    const saved = deps.store.readCloudCredential()
    if (saved) {
        const siteUrl = resolveSiteUrl(args.siteUrl, saved.baseUrl, deps.env)
        try {
            await revokeToken(siteUrl, saved.refreshToken, deps.fetchFn)
        } catch {
            // Best-effort revoke; local logout still succeeds.
        }
    }

    deps.store.clearCloudCredential()
    if (args.json) {
        writeJsonLine(deps, {
            loggedOut: true,
        })
        return 0
    }

    writeHumanLine(deps, 'Opensteer CLI login removed from this machine.')
    return 0
}

export async function runOpensteerAuthCli(
    rawArgs: string[],
    overrideDeps: Partial<AuthCliDeps> = {}
): Promise<number> {
    const deps: AuthCliDeps = {
        ...createDefaultDeps(),
        ...overrideDeps,
    }
    const parsed = parseOpensteerAuthArgs(rawArgs)
    if (parsed.mode === 'help') {
        printHelp(deps)
        return 0
    }
    if (parsed.mode === 'error') {
        deps.writeStderr(`${parsed.error}\n`)
        deps.writeStderr('Run "opensteer auth --help" for usage.\n')
        return 1
    }

    try {
        if (parsed.mode === 'login') {
            return await runLogin(parsed.args, deps)
        }
        if (parsed.mode === 'status') {
            return await runStatus(parsed.args, deps)
        }
        return await runLogout(parsed.args, deps)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Auth command failed.'
        deps.writeStderr(`${message}\n`)
        return 1
    }
}
