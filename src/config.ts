import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parse as parseDotenv } from 'dotenv'
import { extractErrorMessage } from './error-normalization.js'
import {
    selectCloudCredentialByPrecedence,
    type SelectedCloudCredentialLayer,
} from './cloud/credential-selection.js'
import type {
    OpensteerAuthScheme,
    OpensteerCloudBrowserProfileOptions,
    OpensteerCloudAnnouncePolicy,
    OpensteerCloudOptions,
    OpensteerConfig,
} from './types.js'
import { normalizeNamespace } from './storage/namespace.js'

export interface ResolvedOpensteerConfig extends OpensteerConfig {
    model: string
}

export type RuntimeEnv = Record<string, string | undefined>

export interface ResolvedConfigWithEnv {
    config: ResolvedOpensteerConfig
    env: RuntimeEnv
}

type RuntimeMode = 'local' | 'cloud'

export type CloudSelectionSource =
    | 'config.cloud'
    | 'env.OPENSTEER_MODE'
    | 'default'

export interface CloudSelection {
    cloud: boolean
    source: CloudSelectionSource
}

const DEFAULT_CONFIG: Required<
    Pick<OpensteerConfig, 'browser' | 'storage' | 'cursor' | 'debug' | 'model'>
> = {
    browser: {
        headless: false,
        executablePath: undefined,
        slowMo: 0,
        mode: undefined,
        cdpUrl: undefined,
        userDataDir: undefined,
        profileDirectory: undefined,
    },
    storage: {
        rootDir: process.cwd(),
    },
    cursor: {
        enabled: false,
        profile: 'snappy',
    },
    model: 'gpt-5.1',
    debug: false,
}

function dotenvFileOrder(nodeEnv: string | undefined): string[] {
    const normalized = nodeEnv?.trim() || ''
    const files: string[] = []

    if (normalized) {
        files.push(`.env.${normalized}.local`)
    }
    if (normalized !== 'test') {
        files.push('.env.local')
    }
    if (normalized) {
        files.push(`.env.${normalized}`)
    }
    files.push('.env')

    return files
}

function loadDotenvValues(
    rootDir: string,
    baseEnv: RuntimeEnv,
    options: { debug?: boolean } = {}
): RuntimeEnv {
    const values: RuntimeEnv = {}
    if (parseBool(baseEnv.OPENSTEER_DISABLE_DOTENV_AUTOLOAD) === true) {
        return values
    }
    const debug = options.debug ?? (parseBool(baseEnv.OPENSTEER_DEBUG) === true)

    const baseDir = path.resolve(rootDir)
    const nodeEnv = baseEnv.NODE_ENV?.trim() || ''

    for (const filename of dotenvFileOrder(nodeEnv)) {
        const filePath = path.join(baseDir, filename)
        if (!fs.existsSync(filePath)) continue

        try {
            const raw = fs.readFileSync(filePath, 'utf8')
            const parsed = parseDotenv(raw)
            for (const [key, value] of Object.entries(parsed)) {
                if (values[key] === undefined) {
                    values[key] = value
                }
            }
        } catch (error) {
            const message = extractErrorMessage(
                error,
                'Unable to read or parse dotenv file.'
            )
            if (debug) {
                console.warn(
                    `[opensteer] failed to load dotenv file "${filePath}": ${message}`
                )
            }
            continue
        }
    }

    return values
}

function resolveEnv(
    rootDir: string,
    options: { debug?: boolean; baseEnv?: RuntimeEnv } = {}
): RuntimeEnv {
    const baseEnv = options.baseEnv ?? (process.env as RuntimeEnv)
    const dotenvValues = loadDotenvValues(rootDir, baseEnv, options)
    return {
        ...dotenvValues,
        ...baseEnv,
    }
}

function hasOwn(config: unknown, key: string): boolean {
    if (!config || typeof config !== 'object') return false
    return Object.prototype.hasOwnProperty.call(config, key)
}

function hasLegacyAiConfig(config: unknown): boolean {
    return hasOwn(config, 'ai')
}

function assertNoLegacyAiConfig(source: string, config: unknown): void {
    if (hasLegacyAiConfig(config)) {
        throw new Error(
            `Legacy "ai" config is no longer supported in ${source}. Use top-level "model" instead.`
        )
    }
}

function assertNoLegacyRuntimeConfig(source: string, config: unknown): void {
    if (!config || typeof config !== 'object') return

    const configRecord = config as Record<string, unknown>

    if (hasOwn(configRecord, 'runtime')) {
        throw new Error(
            `Legacy "runtime" config is no longer supported in ${source}. Use top-level "cloud" instead.`
        )
    }

    if (hasOwn(configRecord, 'mode')) {
        throw new Error(
            `Top-level "mode" config is no longer supported in ${source}. Use "cloud: true" to enable cloud mode.`
        )
    }

    if (hasOwn(configRecord, 'remote')) {
        throw new Error(
            `Top-level "remote" config is no longer supported in ${source}. Use "cloud" options instead.`
        )
    }

    if (hasOwn(configRecord, 'apiKey')) {
        throw new Error(
            `Top-level "apiKey" config is not supported in ${source}. Use "cloud.apiKey" instead.`
        )
    }
}

export function loadConfigFile(
    rootDir: string,
    options: { debug?: boolean } = {}
): Partial<OpensteerConfig> {
    const configPath = path.join(rootDir, '.opensteer', 'config.json')
    if (!fs.existsSync(configPath)) return {}

    try {
        const raw = fs.readFileSync(configPath, 'utf8')
        return JSON.parse(raw) as Partial<OpensteerConfig>
    } catch (error) {
        const message = extractErrorMessage(
            error,
            'Unable to read or parse config file.'
        )
        if (options.debug) {
            console.warn(
                `[opensteer] failed to load config file "${configPath}": ${message}`
            )
        }
        return {}
    }
}

function mergeDeep<T>(base: T, patch: Partial<T>): T {
    const out: Record<string, unknown> = {
        ...(base as Record<string, unknown>),
    }

    for (const [key, value] of Object.entries(patch || {})) {
        const currentValue = out[key]
        if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            currentValue &&
            typeof currentValue === 'object' &&
            !Array.isArray(currentValue)
        ) {
            out[key] = mergeDeep(
                currentValue as Record<string, unknown>,
                value as Record<string, unknown>
            )
            continue
        }

        if (value !== undefined) {
            out[key] = value
        }
    }

    return out as T
}

function parseBool(value: string | undefined): boolean | undefined {
    if (value == null) return undefined
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
    return undefined
}

function parseNumber(value: string | undefined): number | undefined {
    if (value == null || value.trim() === '') return undefined
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return undefined
    return parsed
}

function parseRuntimeMode(
    value: unknown,
    source: 'OPENSTEER_MODE'
): RuntimeMode | undefined {
    if (value == null) return undefined
    if (typeof value !== 'string') {
        throw new Error(
            `Invalid ${source} value "${String(value)}". Use "local" or "cloud".`
        )
    }

    const normalized = value.trim().toLowerCase()
    if (!normalized) return undefined

    if (normalized === 'local' || normalized === 'cloud') {
        return normalized
    }

    throw new Error(
        `Invalid ${source} value "${value}". Use "local" or "cloud".`
    )
}

function parseAuthScheme(
    value: unknown,
    source: 'OPENSTEER_AUTH_SCHEME' | 'cloud.authScheme'
): OpensteerAuthScheme | undefined {
    if (value == null) return undefined
    if (typeof value !== 'string') {
        throw new Error(
            `Invalid ${source} value "${String(value)}". Use "api-key" or "bearer".`
        )
    }

    const normalized = value.trim().toLowerCase()
    if (!normalized) return undefined

    if (normalized === 'api-key' || normalized === 'bearer') {
        return normalized
    }

    throw new Error(
        `Invalid ${source} value "${value}". Use "api-key" or "bearer".`
    )
}

function parseCloudAnnounce(
    value: unknown,
    source: 'OPENSTEER_REMOTE_ANNOUNCE' | 'cloud.announce'
): OpensteerCloudAnnouncePolicy | undefined {
    if (value == null) return undefined
    if (typeof value !== 'string') {
        throw new Error(
            `Invalid ${source} value "${String(value)}". Use "always", "off", or "tty".`
        )
    }

    const normalized = value.trim().toLowerCase()
    if (!normalized) return undefined

    if (normalized === 'always' || normalized === 'off' || normalized === 'tty') {
        return normalized
    }

    throw new Error(
        `Invalid ${source} value "${value}". Use "always", "off", or "tty".`
    )
}

function resolveOpensteerApiKey(env: RuntimeEnv): string | undefined {
    const value = env.OPENSTEER_API_KEY?.trim()
    if (!value) return undefined
    return value
}

function resolveOpensteerAccessToken(env: RuntimeEnv): string | undefined {
    const value = env.OPENSTEER_ACCESS_TOKEN?.trim()
    if (!value) return undefined
    return value
}

function resolveOpensteerBaseUrl(env: RuntimeEnv): string | undefined {
    const value = env.OPENSTEER_BASE_URL?.trim()
    if (!value) return undefined
    return value
}

function resolveOpensteerAuthScheme(env: RuntimeEnv): OpensteerAuthScheme | undefined {
    return parseAuthScheme(env.OPENSTEER_AUTH_SCHEME, 'OPENSTEER_AUTH_SCHEME')
}

function resolveOpensteerCloudProfileId(env: RuntimeEnv): string | undefined {
    const value = env.OPENSTEER_CLOUD_PROFILE_ID?.trim()
    if (!value) return undefined
    return value
}

function resolveOpensteerCloudProfileReuseIfActive(
    env: RuntimeEnv
): boolean | undefined {
    return parseBool(env.OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE)
}

function parseCloudBrowserProfileReuseIfActive(
    value: unknown
): boolean | undefined {
    if (value == null) return undefined
    if (typeof value !== 'boolean') {
        throw new Error(
            `Invalid cloud.browserProfile.reuseIfActive value "${String(
                value
            )}". Use true or false.`
        )
    }

    return value
}

function normalizeCloudBrowserProfileOptions(
    value: unknown,
    source: 'cloud.browserProfile' | 'resolved.cloud.browserProfile'
): OpensteerCloudBrowserProfileOptions | undefined {
    if (value == null) {
        return undefined
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(
            `Invalid ${source} value "${String(value)}". Use an object with profileId and optional reuseIfActive.`
        )
    }

    const record = value as Record<string, unknown>
    const rawProfileId = record.profileId
    if (typeof rawProfileId !== 'string' || !rawProfileId.trim()) {
        throw new Error(
            `${source}.profileId must be a non-empty string when browserProfile is provided.`
        )
    }

    return {
        profileId: rawProfileId.trim(),
        reuseIfActive: parseCloudBrowserProfileReuseIfActive(record.reuseIfActive),
    }
}

function resolveEnvCloudBrowserProfile(
    profileId: string | undefined,
    reuseIfActive: boolean | undefined
): OpensteerCloudBrowserProfileOptions | undefined {
    if (reuseIfActive !== undefined && !profileId) {
        throw new Error(
            'OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE requires OPENSTEER_CLOUD_PROFILE_ID.'
        )
    }
    if (!profileId) {
        return undefined
    }

    return {
        profileId,
        reuseIfActive,
    }
}

function normalizeCloudOptions(
    value: OpensteerConfig['cloud']
): OpensteerCloudOptions | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined
    }

    return value as OpensteerCloudOptions
}

function normalizeNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length ? normalized : undefined
}

function parseCloudEnabled(
    value: OpensteerConfig['cloud'],
    source: 'cloud'
): boolean | undefined {
    if (value == null) return undefined
    if (typeof value === 'boolean') return value
    if (typeof value === 'object' && !Array.isArray(value)) return true

    throw new Error(
        `Invalid ${source} value "${String(value)}". Use true, false, or a cloud options object.`
    )
}

function resolveCloudCredentialFields(
    selectedLayer: SelectedCloudCredentialLayer | null | undefined
): Pick<OpensteerCloudOptions, 'apiKey' | 'accessToken'> {
    const credential = selectedLayer?.credential
    if (!credential) return {}

    if (
        credential.kind === 'api-key' ||
        (credential.compatibilityBearerApiKey === true &&
            selectedLayer?.source !== 'env')
    ) {
        return {
            apiKey: credential.token,
        }
    }

    return {
        accessToken: credential.token,
    }
}

export function resolveCloudSelection(
    config: Pick<OpensteerConfig, 'cloud'>,
    env: RuntimeEnv = process.env as RuntimeEnv
): CloudSelection {
    const configCloud = parseCloudEnabled(config.cloud, 'cloud')

    if (configCloud !== undefined) {
        return {
            cloud: configCloud,
            source: 'config.cloud',
        }
    }

    const envMode = parseRuntimeMode(env.OPENSTEER_MODE, 'OPENSTEER_MODE')
    if (envMode) {
        return {
            cloud: envMode === 'cloud',
            source: 'env.OPENSTEER_MODE',
        }
    }

    return {
        cloud: false,
        source: 'default',
    }
}

export function resolveConfigWithEnv(
    input: OpensteerConfig = {},
    options: { env?: RuntimeEnv } = {}
): ResolvedConfigWithEnv {
    const processEnv = options.env ?? (process.env as RuntimeEnv)
    const debugHint =
        typeof input.debug === 'boolean'
            ? input.debug
            : parseBool(processEnv.OPENSTEER_DEBUG) === true
    const initialRootDir =
        input.storage?.rootDir ?? process.cwd()
    const runtimeDefaults = mergeDeep(DEFAULT_CONFIG, {
        storage: {
            rootDir: initialRootDir,
        },
    })

    assertNoLegacyAiConfig('Opensteer constructor config', input)
    assertNoLegacyRuntimeConfig('Opensteer constructor config', input)

    const fileConfig = loadConfigFile(initialRootDir, {
        debug: debugHint,
    })
    assertNoLegacyAiConfig('.opensteer/config.json', fileConfig)
    assertNoLegacyRuntimeConfig('.opensteer/config.json', fileConfig)
    const fileCloudOptions = normalizeCloudOptions(fileConfig.cloud)
    const fileHasCloudApiKey = hasOwn(fileCloudOptions, 'apiKey')
    const fileHasCloudAccessToken = hasOwn(fileCloudOptions, 'accessToken')
    const fileRootDir =
        typeof fileConfig.storage?.rootDir === 'string'
            ? fileConfig.storage.rootDir
            : undefined
    assertNoRemovedBrowserConfig(input.browser, 'Opensteer constructor config')
    assertNoRemovedBrowserConfig(fileConfig.browser, '.opensteer/config.json')
    const envRootDir =
        input.storage?.rootDir ??
        fileRootDir ??
        initialRootDir
    const env = resolveEnv(envRootDir, {
        debug: debugHint,
        baseEnv: processEnv,
    })

    if (env.OPENSTEER_AI_MODEL) {
        throw new Error(
            'OPENSTEER_AI_MODEL is no longer supported. Use OPENSTEER_MODEL instead.'
        )
    }
    if (env.OPENSTEER_RUNTIME != null) {
        throw new Error(
            'OPENSTEER_RUNTIME is no longer supported. Use OPENSTEER_MODE instead.'
        )
    }
    if (env.OPENSTEER_CONNECT_URL != null) {
        throw new Error(
            'OPENSTEER_CONNECT_URL is no longer supported. Use OPENSTEER_CDP_URL instead.'
        )
    }
    if (env.OPENSTEER_CHANNEL != null) {
        throw new Error(
            'OPENSTEER_CHANNEL is no longer supported. Use OPENSTEER_BROWSER plus OPENSTEER_BROWSER_PATH when needed.'
        )
    }
    if (env.OPENSTEER_PROFILE_DIR != null) {
        throw new Error(
            'OPENSTEER_PROFILE_DIR is no longer supported. Use OPENSTEER_USER_DATA_DIR and OPENSTEER_PROFILE_DIRECTORY instead.'
        )
    }

    const envConfig: Partial<OpensteerConfig> = {
        browser: {
            headless: parseBool(env.OPENSTEER_HEADLESS),
            executablePath: env.OPENSTEER_BROWSER_PATH || undefined,
            slowMo: parseNumber(env.OPENSTEER_SLOW_MO),
            mode:
                env.OPENSTEER_BROWSER === 'real' ||
                env.OPENSTEER_BROWSER === 'chromium'
                    ? env.OPENSTEER_BROWSER
                    : undefined,
            cdpUrl: env.OPENSTEER_CDP_URL || undefined,
            userDataDir: env.OPENSTEER_USER_DATA_DIR || undefined,
            profileDirectory:
                env.OPENSTEER_PROFILE_DIRECTORY || undefined,
        },
        cursor: {
            enabled: parseBool(env.OPENSTEER_CURSOR),
        },
        model: env.OPENSTEER_MODEL || undefined,
        debug: parseBool(env.OPENSTEER_DEBUG),
    }

    const mergedWithFile = mergeDeep(runtimeDefaults, fileConfig)
    const mergedWithEnv = mergeDeep(mergedWithFile, envConfig)
    const resolved = mergeDeep(mergedWithEnv, input) as ResolvedOpensteerConfig
    const browserHeadlessExplicit =
        input.browser?.headless !== undefined ||
        fileConfig.browser?.headless !== undefined ||
        envConfig.browser?.headless !== undefined

    if (!browserHeadlessExplicit && resolved.browser?.mode === 'real') {
        resolved.browser = {
            ...resolved.browser,
            headless: true,
        }
    }

    function assertNoRemovedBrowserConfig(
        value: unknown,
        source: string
    ): void {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return
        }

        const record = value as Record<string, unknown>
        if (record.connectUrl !== undefined) {
            throw new Error(
                `${source}.browser.connectUrl is no longer supported. Use browser.cdpUrl instead.`
            )
        }
        if (record.channel !== undefined) {
            throw new Error(
                `${source}.browser.channel is no longer supported. Use browser.mode plus browser.executablePath instead.`
            )
        }
        if (record.profileDir !== undefined) {
            throw new Error(
                `${source}.browser.profileDir is no longer supported. Use browser.userDataDir and browser.profileDirectory instead.`
            )
        }
    }

    const envApiKey = resolveOpensteerApiKey(env)
    const envAccessTokenRaw = resolveOpensteerAccessToken(env)
    const envBaseUrl = resolveOpensteerBaseUrl(env)
    const envAuthScheme = resolveOpensteerAuthScheme(env)
    const envCloudProfileId = resolveOpensteerCloudProfileId(env)
    const envCloudProfileReuseIfActive =
        resolveOpensteerCloudProfileReuseIfActive(env)
    const envCloudAnnounce = parseCloudAnnounce(
        env.OPENSTEER_REMOTE_ANNOUNCE,
        'OPENSTEER_REMOTE_ANNOUNCE'
    )
    const inputCloudOptions = normalizeCloudOptions(input.cloud)
    const inputCloudBrowserProfile = normalizeCloudBrowserProfileOptions(
        inputCloudOptions?.browserProfile,
        'cloud.browserProfile'
    )
    const inputAuthScheme = parseAuthScheme(
        inputCloudOptions?.authScheme,
        'cloud.authScheme'
    )
    const inputCloudAnnounce = parseCloudAnnounce(
        inputCloudOptions?.announce,
        'cloud.announce'
    )
    const inputHasCloudApiKey = Boolean(
        inputCloudOptions &&
            Object.prototype.hasOwnProperty.call(inputCloudOptions, 'apiKey')
    )
    const inputHasCloudAccessToken = Boolean(
        inputCloudOptions &&
            Object.prototype.hasOwnProperty.call(inputCloudOptions, 'accessToken')
    )
    const inputHasCloudBaseUrl = Boolean(
        inputCloudOptions &&
            Object.prototype.hasOwnProperty.call(inputCloudOptions, 'baseUrl')
    )
    const cloudSelection = resolveCloudSelection({
        cloud: resolved.cloud,
    }, env)

    if (cloudSelection.cloud) {
        const resolvedCloud = normalizeCloudOptions(resolved.cloud) ?? {}
        const {
            apiKey: resolvedCloudApiKeyRaw,
            accessToken: resolvedCloudAccessTokenRaw,
            ...resolvedCloudRest
        } = resolvedCloud
        const resolvedCloudBrowserProfile = normalizeCloudBrowserProfileOptions(
            resolvedCloud.browserProfile,
            'resolved.cloud.browserProfile'
        )
        const envCloudBrowserProfile = resolveEnvCloudBrowserProfile(
            envCloudProfileId,
            envCloudProfileReuseIfActive
        )
        const browserProfile =
            inputCloudBrowserProfile ??
            envCloudBrowserProfile ??
            resolvedCloudBrowserProfile
        let authScheme =
            inputAuthScheme ??
            envAuthScheme ??
            parseAuthScheme(resolvedCloud.authScheme, 'cloud.authScheme') ??
            'api-key'
        const announce =
            inputCloudAnnounce ??
            envCloudAnnounce ??
            parseCloudAnnounce(resolvedCloud.announce, 'cloud.announce') ??
            'always'
        const selectedCredentialLayer = selectCloudCredentialByPrecedence(
            [
                {
                    source: 'input',
                    apiKey: inputCloudOptions?.apiKey,
                    accessToken: inputCloudOptions?.accessToken,
                    hasApiKey: inputHasCloudApiKey,
                    hasAccessToken: inputHasCloudAccessToken,
                },
                {
                    source: 'env',
                    apiKey: envApiKey,
                    accessToken: envAccessTokenRaw,
                    hasApiKey: envApiKey !== undefined,
                    hasAccessToken: envAccessTokenRaw !== undefined,
                },
                {
                    source: 'file',
                    apiKey: fileCloudOptions?.apiKey,
                    accessToken: fileCloudOptions?.accessToken,
                    hasApiKey: fileHasCloudApiKey,
                    hasAccessToken: fileHasCloudAccessToken,
                },
            ],
            authScheme
        )
        const { apiKey, accessToken } =
            resolveCloudCredentialFields(selectedCredentialLayer)

        if (accessToken) {
            authScheme = 'bearer'
        }

        resolved.cloud = {
            ...resolvedCloudRest,
            ...(apiKey
                ? { apiKey }
                : selectedCredentialLayer?.hasApiKey && !accessToken
                  ? { apiKey: selectedCredentialLayer.apiKey }
                  : {}),
            ...(accessToken
                ? { accessToken }
                : selectedCredentialLayer?.hasAccessToken && !apiKey
                  ? { accessToken: selectedCredentialLayer.accessToken }
                  : {}),
            authScheme,
            announce,
            ...(browserProfile ? { browserProfile } : {}),
        }
    }

    if (envBaseUrl && cloudSelection.cloud && !inputHasCloudBaseUrl) {
        resolved.cloud = {
            ...(normalizeCloudOptions(resolved.cloud) ?? {}),
            baseUrl: envBaseUrl,
        }
    }

    return {
        config: resolved,
        env,
    }
}

export function resolveConfig(
    input: OpensteerConfig = {}
): ResolvedOpensteerConfig {
    return resolveConfigWithEnv(input).config
}

export function resolveNamespace(
    config: OpensteerConfig,
    rootDir: string
): string {
    if (config.name && config.name.trim()) {
        return normalizeNamespace(config.name)
    }

    const caller = getCallerFilePath()
    if (!caller) return normalizeNamespace('default')

    const relative = path.relative(rootDir, caller)
    const cleaned = relative
        .replace(/\\/g, '/')
        .replace(/\.(ts|tsx|js|mjs|cjs)$/, '')

    return normalizeNamespace(cleaned || 'default')
}

function getCallerFilePath(): string | null {
    const stack = new Error().stack
    if (!stack) return null

    const lines = stack.split('\n').slice(2)
    for (const line of lines) {
        const match =
            line.match(/\((.*):(\d+):(\d+)\)/) ||
            line.match(/at\s+(.*):(\d+):(\d+)/)
        if (!match) continue

        const rawPath = match[1]
        if (!rawPath) continue
        if (rawPath.includes('node:internal')) continue
        if (rawPath.includes('node_modules')) continue
        if (rawPath.includes('/opensteer-oss/src/')) continue

        try {
            if (rawPath.startsWith('file://')) {
                return fileURLToPath(rawPath)
            }
            return rawPath
        } catch {
            continue
        }
    }

    return null
}
