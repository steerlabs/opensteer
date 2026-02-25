import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'
import type {
    OpensteerAuthScheme,
    OpensteerCloudAnnouncePolicy,
    OpensteerCloudOptions,
    OpensteerConfig,
} from './types.js'
import { normalizeNamespace } from './storage/namespace.js'

export interface ResolvedOpensteerConfig extends OpensteerConfig {
    model: string
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
    Pick<OpensteerConfig, 'browser' | 'storage' | 'debug' | 'model'>
> = {
    browser: {
        headless: false,
        executablePath: undefined,
        slowMo: 0,
        connectUrl: undefined,
        channel: undefined,
        profileDir: undefined,
    },
    storage: {
        rootDir: process.cwd(),
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

function loadDotenv(rootDir: string): void {
    if (parseBool(process.env.OPENSTEER_DISABLE_DOTENV_AUTOLOAD) === true) {
        return
    }

    const baseDir = path.resolve(rootDir)
    const nodeEnv = process.env.NODE_ENV?.trim() || ''

    for (const filename of dotenvFileOrder(nodeEnv)) {
        const filePath = path.join(baseDir, filename)
        if (!fs.existsSync(filePath)) continue

        dotenvConfig({
            path: filePath,
            override: false,
            quiet: true,
        })
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

export function loadConfigFile(rootDir: string): Partial<OpensteerConfig> {
    const configPath = path.join(rootDir, '.opensteer', 'config.json')
    if (!fs.existsSync(configPath)) return {}

    try {
        const raw = fs.readFileSync(configPath, 'utf8')
        return JSON.parse(raw) as Partial<OpensteerConfig>
    } catch {
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

function resolveOpensteerApiKey(): string | undefined {
    const value = process.env.OPENSTEER_API_KEY?.trim()
    if (!value) return undefined
    return value
}

function resolveOpensteerAuthScheme(): OpensteerAuthScheme | undefined {
    return parseAuthScheme(
        process.env.OPENSTEER_AUTH_SCHEME,
        'OPENSTEER_AUTH_SCHEME'
    )
}

function normalizeCloudOptions(
    value: OpensteerConfig['cloud']
): OpensteerCloudOptions | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined
    }

    return value as OpensteerCloudOptions
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

export function resolveCloudSelection(
    config: Pick<OpensteerConfig, 'cloud'>
): CloudSelection {
    const configCloud = parseCloudEnabled(config.cloud, 'cloud')

    if (configCloud !== undefined) {
        return {
            cloud: configCloud,
            source: 'config.cloud',
        }
    }

    const envMode = parseRuntimeMode(
        process.env.OPENSTEER_MODE,
        'OPENSTEER_MODE'
    )
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

export function resolveConfig(
    input: OpensteerConfig = {}
): ResolvedOpensteerConfig {
    const rootDir =
        input.storage?.rootDir ??
        DEFAULT_CONFIG.storage.rootDir ??
        process.cwd()
    loadDotenv(rootDir)

    if (process.env.OPENSTEER_AI_MODEL) {
        throw new Error(
            'OPENSTEER_AI_MODEL is no longer supported. Use OPENSTEER_MODEL instead.'
        )
    }
    if (process.env.OPENSTEER_RUNTIME != null) {
        throw new Error(
            'OPENSTEER_RUNTIME is no longer supported. Use OPENSTEER_MODE instead.'
        )
    }

    assertNoLegacyAiConfig('Opensteer constructor config', input)
    assertNoLegacyRuntimeConfig('Opensteer constructor config', input)

    const fileConfig = loadConfigFile(rootDir)
    assertNoLegacyAiConfig('.opensteer/config.json', fileConfig)
    assertNoLegacyRuntimeConfig('.opensteer/config.json', fileConfig)

    const envConfig: Partial<OpensteerConfig> = {
        browser: {
            headless: parseBool(process.env.OPENSTEER_HEADLESS),
            executablePath: process.env.OPENSTEER_BROWSER_PATH || undefined,
            slowMo: parseNumber(process.env.OPENSTEER_SLOW_MO),
            connectUrl: process.env.OPENSTEER_CONNECT_URL || undefined,
            channel: process.env.OPENSTEER_CHANNEL || undefined,
            profileDir: process.env.OPENSTEER_PROFILE_DIR || undefined,
        },
        model: process.env.OPENSTEER_MODEL || undefined,
        debug: parseBool(process.env.OPENSTEER_DEBUG),
    }

    const mergedWithFile = mergeDeep(DEFAULT_CONFIG, fileConfig)
    const mergedWithEnv = mergeDeep(mergedWithFile, envConfig)
    const resolved = mergeDeep(mergedWithEnv, input) as ResolvedOpensteerConfig

    const envApiKey = resolveOpensteerApiKey()
    const envAuthScheme = resolveOpensteerAuthScheme()
    const envCloudAnnounce = parseCloudAnnounce(
        process.env.OPENSTEER_REMOTE_ANNOUNCE,
        'OPENSTEER_REMOTE_ANNOUNCE'
    )
    const inputCloudOptions = normalizeCloudOptions(input.cloud)
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
    const cloudSelection = resolveCloudSelection({
        cloud: resolved.cloud,
    })

    if (cloudSelection.cloud) {
        const resolvedCloud = normalizeCloudOptions(resolved.cloud) ?? {}
        const authScheme =
            inputAuthScheme ??
            envAuthScheme ??
            parseAuthScheme(resolvedCloud.authScheme, 'cloud.authScheme') ??
            'api-key'
        const announce =
            inputCloudAnnounce ??
            envCloudAnnounce ??
            parseCloudAnnounce(resolvedCloud.announce, 'cloud.announce') ??
            'always'
        resolved.cloud = {
            ...resolvedCloud,
            authScheme,
            announce,
        }
    }

    if (envApiKey && cloudSelection.cloud && !inputHasCloudApiKey) {
        resolved.cloud = {
            ...(normalizeCloudOptions(resolved.cloud) ?? {}),
            apiKey: envApiKey,
        }
    }

    return resolved
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
