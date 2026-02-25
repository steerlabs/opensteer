import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type {
    OpensteerAuthScheme,
    OpensteerConfig,
    OpensteerMode,
    OpensteerRemoteAnnouncePolicy,
    OpensteerRemoteOptions,
} from './types.js'
import { normalizeNamespace } from './storage/namespace.js'

export interface ResolvedOpensteerConfig extends OpensteerConfig {
    model: string
}

export type Mode = OpensteerMode

export type ModeSelectionSource = 'config.mode' | 'env.OPENSTEER_MODE' | 'default'

export interface ModeSelection {
    mode: Mode
    source: ModeSelectionSource
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

function assertNoLegacyModeConfig(source: string, config: unknown): void {
    if (!config || typeof config !== 'object') return

    const configRecord = config as Record<string, unknown>

    if (hasOwn(configRecord, 'runtime')) {
        throw new Error(
            `Legacy "runtime" config is no longer supported in ${source}. Use top-level "mode" instead.`
        )
    }

    if (hasOwn(configRecord, 'apiKey')) {
        throw new Error(
            `Top-level "apiKey" config is not supported in ${source}. Use "remote.apiKey" instead.`
        )
    }

    const remoteValue = configRecord.remote
    if (typeof remoteValue === 'boolean') {
        throw new Error(
            `Boolean "remote" config is no longer supported in ${source}. Use "mode: \\"remote\\"" with "remote" options.`
        )
    }

    if (
        remoteValue &&
        typeof remoteValue === 'object' &&
        !Array.isArray(remoteValue) &&
        hasOwn(remoteValue, 'key')
    ) {
        throw new Error(
            `Legacy "remote.key" config is no longer supported in ${source}. Use "remote.apiKey" instead.`
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

function parseMode(
    value: unknown,
    source: 'OPENSTEER_MODE' | 'mode'
): Mode | undefined {
    if (value == null) return undefined
    if (typeof value !== 'string') {
        throw new Error(
            `Invalid ${source} value "${String(value)}". Use "local" or "remote".`
        )
    }

    const normalized = value.trim().toLowerCase()
    if (!normalized) return undefined

    if (normalized === 'local' || normalized === 'remote') {
        return normalized
    }

    throw new Error(
        `Invalid ${source} value "${value}". Use "local" or "remote".`
    )
}

function parseAuthScheme(
    value: unknown,
    source: 'OPENSTEER_AUTH_SCHEME' | 'remote.authScheme'
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

function parseRemoteAnnounce(
    value: unknown,
    source: 'OPENSTEER_REMOTE_ANNOUNCE' | 'remote.announce'
): OpensteerRemoteAnnouncePolicy | undefined {
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

function normalizeRemoteOptions(
    value: OpensteerConfig['remote']
): OpensteerRemoteOptions | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined
    }

    return value as OpensteerRemoteOptions
}

export function resolveModeSelection(
    config: Pick<OpensteerConfig, 'mode'>
): ModeSelection {
    const configMode = parseMode(config.mode, 'mode')

    if (configMode) {
        return {
            mode: configMode,
            source: 'config.mode',
        }
    }

    const envMode = parseMode(process.env.OPENSTEER_MODE, 'OPENSTEER_MODE')
    if (envMode) {
        return {
            mode: envMode,
            source: 'env.OPENSTEER_MODE',
        }
    }

    return {
        mode: 'local',
        source: 'default',
    }
}

export function resolveConfig(
    input: OpensteerConfig = {}
): ResolvedOpensteerConfig {
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
    assertNoLegacyModeConfig('Opensteer constructor config', input)

    const rootDir =
        input.storage?.rootDir ??
        DEFAULT_CONFIG.storage.rootDir ??
        process.cwd()
    const fileConfig = loadConfigFile(rootDir)
    assertNoLegacyAiConfig('.opensteer/config.json', fileConfig)
    assertNoLegacyModeConfig('.opensteer/config.json', fileConfig)

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
    const envRemoteAnnounce = parseRemoteAnnounce(
        process.env.OPENSTEER_REMOTE_ANNOUNCE,
        'OPENSTEER_REMOTE_ANNOUNCE'
    )
    const inputRemoteOptions = normalizeRemoteOptions(input.remote)
    const inputAuthScheme = parseAuthScheme(
        inputRemoteOptions?.authScheme,
        'remote.authScheme'
    )
    const inputRemoteAnnounce = parseRemoteAnnounce(
        inputRemoteOptions?.announce,
        'remote.announce'
    )
    const inputHasRemoteApiKey = Boolean(
        inputRemoteOptions &&
            Object.prototype.hasOwnProperty.call(inputRemoteOptions, 'apiKey')
    )
    const modeSelection = resolveModeSelection({
        mode: resolved.mode,
    })

    if (modeSelection.mode === 'remote') {
        const resolvedRemote = normalizeRemoteOptions(resolved.remote) ?? {}
        const authScheme =
            inputAuthScheme ??
            envAuthScheme ??
            parseAuthScheme(resolvedRemote.authScheme, 'remote.authScheme') ??
            'api-key'
        const announce =
            inputRemoteAnnounce ??
            envRemoteAnnounce ??
            parseRemoteAnnounce(resolvedRemote.announce, 'remote.announce') ??
            'always'
        resolved.remote = {
            ...resolvedRemote,
            authScheme,
            announce,
        }
    }

    if (envApiKey && modeSelection.mode === 'remote' && !inputHasRemoteApiKey) {
        resolved.remote = {
            ...(normalizeRemoteOptions(resolved.remote) ?? {}),
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
