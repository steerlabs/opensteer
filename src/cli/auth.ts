import open from 'open'
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
    type CloudCredentialStoreTarget,
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
export type OpenExternalUrlFn = (url: string) => boolean | Promise<boolean>

export interface CloudCredentialStore {
    readCloudCredential(
        target: CloudCredentialStoreTarget
    ): StoredMachineCloudCredential | null
    writeCloudCredential(args: WriteMachineCloudCredentialArgs): void
    readActiveCloudTarget(): CloudCredentialStoreTarget | null
    writeActiveCloudTarget(target: CloudCredentialStoreTarget): void
    clearCloudCredential(target: CloudCredentialStoreTarget): void
}

export interface EnsuredCloudAuthContext {
    token: string
    authScheme: OpensteerAuthScheme
    source: 'flag' | 'env' | 'saved'
    kind: 'api-key' | 'access-token'
    baseUrl: string
}

export interface EnsureCloudCredentialsOptions {
    commandName: string
    env?: Record<string, string | undefined>
    store?: CloudCredentialStore
    apiKeyFlag?: string
    accessTokenFlag?: string
    baseUrl?: string
    interactive?: boolean
    autoLoginIfNeeded?: boolean
    writeProgress?: (message: string) => void
    writeStdout?: (message: string) => void
    writeStderr?: (message: string) => void
    fetchFn?: AuthFetchFn
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    openExternalUrl?: OpenExternalUrlFn
}

export interface EnsureCloudCredentialsForOpenOptions {
    scopeDir: string
    env?: Record<string, string | undefined>
    store?: CloudCredentialStore
    apiKeyFlag?: string
    accessTokenFlag?: string
    interactive?: boolean
    writeProgress?: (message: string) => void
    writeStderr?: (message: string) => void
    fetchFn?: AuthFetchFn
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    openExternalUrl?: OpenExternalUrlFn
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
    openExternalUrl: OpenExternalUrlFn
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
  status                    Show saved machine login state for the selected cloud host
  logout                    Revoke and remove saved machine login for the selected cloud host

Options:
  --base-url <url>          Cloud API base URL (defaults to env or the last selected host)
  --json                    JSON output (login prompts go to stderr)
  --no-browser              Do not auto-open your default browser during login
  -h, --help                Show this help
`

const DEFAULT_AUTH_SITE_URL = 'https://opensteer.com'
const INTERNAL_AUTH_SITE_URL_ENV = 'OPENSTEER_INTERNAL_AUTH_SITE_URL'

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
        openExternalUrl: openDefaultBrowser,
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

function resolveAuthSiteUrl(env: Record<string, string | undefined>): string {
    const authSiteUrl = normalizeCloudBaseUrl(
        (env[INTERNAL_AUTH_SITE_URL_ENV] || DEFAULT_AUTH_SITE_URL).trim()
    )
    assertSecureUrl(
        authSiteUrl,
        `environment variable ${INTERNAL_AUTH_SITE_URL_ENV}`
    )
    return authSiteUrl
}

function hasExplicitCloudTargetSelection(
    providedBaseUrl: string | undefined,
    env: Record<string, string | undefined>
): boolean {
    return Boolean(
        providedBaseUrl?.trim() || env.OPENSTEER_BASE_URL?.trim()
    )
}

function readRememberedCloudTarget(
    store: Pick<CloudCredentialStore, 'readActiveCloudTarget'>
): CloudCredentialStoreTarget | null {
    const activeTarget = store.readActiveCloudTarget()
    if (!activeTarget) {
        return null
    }

    try {
        const baseUrl = normalizeCloudBaseUrl(activeTarget.baseUrl)
        assertSecureUrl(baseUrl, '--base-url')
        return { baseUrl }
    } catch {
        return null
    }
}

function resolveCloudTarget(
    args: Pick<AuthCommonArgs, 'baseUrl'>,
    env: Record<string, string | undefined>,
    store: Pick<CloudCredentialStore, 'readActiveCloudTarget'>,
    options: { allowRememberedTarget?: boolean } = {}
): CloudCredentialStoreTarget {
    if (
        options.allowRememberedTarget !== false &&
        !hasExplicitCloudTargetSelection(args.baseUrl, env)
    ) {
        const rememberedTarget = readRememberedCloudTarget(store)
        if (rememberedTarget) {
            return rememberedTarget
        }
    }

    const baseUrl = resolveBaseUrl(args.baseUrl, env)
    return { baseUrl }
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
    authSiteUrl: string,
    fetchFn: AuthFetchFn
): Promise<CliDeviceStartResponse> {
    const response = await postJson<CliDeviceStartResponse>(
        fetchFn,
        `${authSiteUrl}/api/cli-auth/device/start`,
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
    authSiteUrl: string,
    deviceCode: string,
    fetchFn: AuthFetchFn
): Promise<CliTokenResponse> {
    return await postJson<CliTokenResponse>(
        fetchFn,
        `${authSiteUrl}/api/cli-auth/device/token`,
        {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
        }
    )
}

async function refreshToken(
    authSiteUrl: string,
    refreshTokenValue: string,
    fetchFn: AuthFetchFn
): Promise<CliTokenResponse> {
    return await postJson<CliTokenResponse>(fetchFn, `${authSiteUrl}/api/cli-auth/token`, {
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
    })
}

async function revokeToken(
    authSiteUrl: string,
    refreshTokenValue: string,
    fetchFn: AuthFetchFn
): Promise<void> {
    await postJson<{ revoked: boolean }>(fetchFn, `${authSiteUrl}/api/cli-auth/revoke`, {
        token: refreshTokenValue,
    })
}

async function openDefaultBrowser(url: string): Promise<boolean> {
    try {
        const child = await open(url, {
            wait: false,
        })
        child.on('error', () => undefined)
        child.unref()
        return true
    } catch {
        return false
    }
}

async function runDeviceLoginFlow(
    args: {
        authSiteUrl: string
        fetchFn: AuthFetchFn
        writeProgress: (message: string) => void
        openExternalUrl: OpenExternalUrlFn
        sleep: (ms: number) => Promise<void>
        now: () => number
        openBrowser: boolean
        openBrowserDisabledReason?: string
    }
): Promise<DeviceLoginResult> {
    const start = await startDeviceAuthorization(args.authSiteUrl, args.fetchFn)

    if (args.openBrowser) {
        args.writeProgress(
            'Opening your default browser for Opensteer CLI authentication.\n'
        )
        args.writeProgress(
            `If nothing opens, use this URL:\n${start.verification_uri_complete}\n`
        )
    } else {
        if (args.openBrowserDisabledReason) {
            args.writeProgress(
                `Automatic browser open is disabled (${args.openBrowserDisabledReason}).\n`
            )
        }
        args.writeProgress(
            `Open this URL to authenticate Opensteer CLI:\n${start.verification_uri_complete}\n`
        )
    }
    args.writeProgress(`Verification code: ${start.user_code}\n`)

    if (args.openBrowser) {
        const browserOpened = await args.openExternalUrl(
            start.verification_uri_complete
        )
        if (browserOpened) {
            args.writeProgress(
                'Opened your default browser. Finish authentication there; this terminal will continue automatically.\n'
            )
        } else {
            args.writeProgress(
                'Could not open your default browser automatically. Paste the URL above into a browser to continue.\n'
            )
        }
    }

    const deadline = args.now() + start.expires_in * 1000
    let pollIntervalMs = Math.max(1, Math.trunc(start.interval)) * 1000

    while (args.now() <= deadline) {
        await args.sleep(pollIntervalMs)

        try {
            const tokenPayload = await pollDeviceToken(
                args.authSiteUrl,
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
    deps: Pick<AuthCliDeps, 'env' | 'fetchFn' | 'store' | 'now'>
): Promise<RefreshResult> {
    const tokenPayload = await refreshToken(
        resolveAuthSiteUrl(deps.env),
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
        scope: updated.scope,
        accessToken: updated.accessToken,
        refreshToken: updated.refreshToken,
        obtainedAt: deps.now(),
        expiresAt: updated.expiresAt,
    })

    return updated
}

async function ensureSavedCredentialIsFresh(
    saved: StoredMachineCloudCredential,
    deps: Pick<AuthCliDeps, 'env' | 'fetchFn' | 'store' | 'now' | 'writeStderr'>
): Promise<StoredMachineCloudCredential | null> {
    const refreshSkewMs = 60_000
    if (saved.expiresAt > deps.now() + refreshSkewMs) {
        return saved
    }

    try {
        const refreshed = await refreshSavedCredential(saved, deps)
        return {
            ...saved,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            scope: refreshed.scope,
            obtainedAt: deps.now(),
        }
    } catch (error) {
        if (error instanceof CliAuthHttpError) {
            const oauth = parseCliOauthError(error.body)
            if (oauth?.error === 'invalid_grant' || oauth?.error === 'expired_token') {
                deps.store.clearCloudCredential({
                    baseUrl: saved.baseUrl,
                })
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

function describeBrowserOpenMode(
    args: Pick<AuthLoginArgs, 'openBrowser'>,
    deps: Pick<AuthCliDeps, 'env' | 'isInteractive'>
): { enabled: boolean; disabledReason?: string } {
    if (!args.openBrowser) {
        return {
            enabled: false,
            disabledReason: '--no-browser',
        }
    }
    if (!deps.isInteractive()) {
        return {
            enabled: false,
            disabledReason: 'this shell is not interactive',
        }
    }
    if (isCiEnvironment(deps.env)) {
        return {
            enabled: false,
            disabledReason: 'CI',
        }
    }
    return {
        enabled: true,
    }
}

function isCiEnvironment(env: Record<string, string | undefined>): boolean {
    const value = env.CI?.trim().toLowerCase()
    return Boolean(value && value !== '0' && value !== 'false')
}

function resolveCloudSessionEnvForRootDir(
    rootDir: string,
    env?: Record<string, string | undefined>
): {
    cloud: boolean
    env: Record<string, string | undefined>
} {
    const resolved = resolveConfigWithEnv(
        {
            storage: { rootDir },
        },
        {
            env,
        }
    )

    return {
        cloud: resolveCloudSelection(
            {
                cloud: resolved.config.cloud,
            },
            resolved.env
        ).cloud,
        env: resolved.env,
    }
}

export function isCloudModeEnabledForRootDir(
    rootDir: string,
    env?: Record<string, string | undefined>
): boolean {
    return resolveCloudSessionEnvForRootDir(rootDir, env).cloud
}

export async function ensureCloudCredentialsForOpenCommand(
    options: EnsureCloudCredentialsForOpenOptions
): Promise<EnsuredCloudAuthContext | null> {
    const processEnv = options.env ?? (process.env as Record<string, string | undefined>)
    const runtime = resolveCloudSessionEnvForRootDir(options.scopeDir, processEnv)
    if (!runtime.cloud) {
        return null
    }

    const writeStderr =
        options.writeStderr ?? ((message: string) => process.stderr.write(message))

    const auth = await ensureCloudCredentialsForCommand({
        commandName: 'opensteer open',
        env: runtime.env,
        store: options.store,
        apiKeyFlag: options.apiKeyFlag,
        accessTokenFlag: options.accessTokenFlag,
        interactive: options.interactive,
        autoLoginIfNeeded: true,
        writeProgress: options.writeProgress ?? writeStderr,
        writeStderr,
        fetchFn: options.fetchFn,
        sleep: options.sleep,
        now: options.now,
        openExternalUrl: options.openExternalUrl,
    })

    applyCloudCredentialToEnv(processEnv, {
        kind: auth.kind,
        source: auth.source,
        token: auth.token,
        authScheme: auth.authScheme,
    })
    processEnv.OPENSTEER_BASE_URL = auth.baseUrl

    return auth
}

export async function ensureCloudCredentialsForCommand(
    options: EnsureCloudCredentialsOptions
): Promise<EnsuredCloudAuthContext> {
    const env = options.env ?? (process.env as Record<string, string | undefined>)
    const writeProgress =
        options.writeProgress ??
        options.writeStdout ??
        ((message: string) => process.stdout.write(message))
    const writeStderr = options.writeStderr ?? ((message: string) => process.stderr.write(message))
    const fetchFn = options.fetchFn ?? fetch
    const sleep = options.sleep ?? (async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, ms))
    })
    const now = options.now ?? Date.now
    const openExternalUrl = options.openExternalUrl ?? openDefaultBrowser
    const store =
        options.store ??
        createMachineCredentialStore({
            env,
            warn: (warning) => {
                writeStderr(`${warning.message} (${warning.path})\n`)
            },
        })

    const { baseUrl } = resolveCloudTarget(options, env, store)

    const initialCredential = resolveCloudCredential({
        env,
        apiKeyFlag: options.apiKeyFlag,
        accessTokenFlag: options.accessTokenFlag,
    })

    let credential: ResolvedCloudCredential | null = initialCredential
    if (!credential) {
        const saved = store.readCloudCredential({ baseUrl })
        const freshSaved = saved
            ? await ensureSavedCredentialIsFresh(saved, {
                  env,
                  fetchFn,
                  store,
                  now,
                  writeStderr,
              })
            : null

        if (freshSaved) {
            credential = {
                kind: 'access-token',
                source: 'saved',
                token: freshSaved.accessToken,
                authScheme: 'bearer',
            }
        }
    }

    if (!credential) {
        if (options.autoLoginIfNeeded && (options.interactive ?? false)) {
            const loggedIn = await runDeviceLoginFlow({
                authSiteUrl: resolveAuthSiteUrl(env),
                fetchFn,
                writeProgress,
                openExternalUrl,
                sleep,
                now,
                openBrowser: true,
            })

            store.writeCloudCredential({
                baseUrl,
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
            writeProgress('Cloud login complete.\n')
        } else {
            throw new Error(toAuthMissingMessage(options.commandName))
        }
    }

    store.writeActiveCloudTarget({ baseUrl })
    applyCloudCredentialToEnv(env, credential)
    env.OPENSTEER_BASE_URL = baseUrl

    return {
        token: credential.token,
        authScheme: credential.authScheme,
        source: credential.source,
        kind: credential.kind,
        baseUrl,
    }
}

async function runLogin(
    args: AuthLoginArgs,
    deps: AuthCliDeps
): Promise<number> {
    const { baseUrl } = resolveCloudTarget(args, deps.env, deps.store, {
        allowRememberedTarget: false,
    })
    const writeProgress = args.json ? deps.writeStderr : deps.writeStdout
    const browserOpenMode = describeBrowserOpenMode(args, deps)
    const login = await runDeviceLoginFlow({
        authSiteUrl: resolveAuthSiteUrl(deps.env),
        fetchFn: deps.fetchFn,
        writeProgress,
        openExternalUrl: deps.openExternalUrl,
        sleep: deps.sleep,
        now: deps.now,
        openBrowser: browserOpenMode.enabled,
        openBrowserDisabledReason: browserOpenMode.disabledReason,
    })

    deps.store.writeCloudCredential({
        baseUrl,
        scope: login.scope,
        accessToken: login.accessToken,
        refreshToken: login.refreshToken,
        obtainedAt: deps.now(),
        expiresAt: login.expiresAt,
    })
    deps.store.writeActiveCloudTarget({ baseUrl })

    if (args.json) {
        writeJsonLine(deps, {
            loggedIn: true,
            baseUrl,
            expiresAt: login.expiresAt,
            scope: login.scope,
            authSource: 'device',
        })
        return 0
    }

    writeHumanLine(deps, 'Opensteer CLI login successful.')
    return 0
}

async function runStatus(
    args: AuthStatusArgs,
    deps: AuthCliDeps
): Promise<number> {
    const { baseUrl } = resolveCloudTarget(args, deps.env, deps.store)
    deps.store.writeActiveCloudTarget({ baseUrl })
    const saved = deps.store.readCloudCredential({ baseUrl })
    if (!saved) {
        if (args.json) {
            writeJsonLine(deps, {
                loggedIn: false,
                baseUrl,
            })
        } else {
            writeHumanLine(deps, `Opensteer CLI is not logged in for ${baseUrl}.`)
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
    writeHumanLine(deps, `  API Base URL: ${saved.baseUrl}`)
    writeHumanLine(deps, `  Expires At: ${new Date(saved.expiresAt).toISOString()}`)
    return 0
}

async function runLogout(
    args: AuthLogoutArgs,
    deps: AuthCliDeps
): Promise<number> {
    const { baseUrl } = resolveCloudTarget(args, deps.env, deps.store)
    deps.store.writeActiveCloudTarget({ baseUrl })
    const saved = deps.store.readCloudCredential({ baseUrl })
    if (saved) {
        try {
            await revokeToken(
                resolveAuthSiteUrl(deps.env),
                saved.refreshToken,
                deps.fetchFn
            )
        } catch {
            // Best-effort revoke; local logout still succeeds.
        }
    }

    deps.store.clearCloudCredential({ baseUrl })
    if (args.json) {
        writeJsonLine(deps, {
            loggedOut: true,
            baseUrl,
        })
        return 0
    }

    writeHumanLine(deps, `Opensteer CLI login removed for ${baseUrl}.`)
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
