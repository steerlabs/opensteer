import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { OpensteerConfig } from './types.js'

export interface ResolvedOpensteerConfig extends OpensteerConfig {
    model: string
}

const DEFAULT_CONFIG: Required<
    Pick<OpensteerConfig, 'browser' | 'storage' | 'debug' | 'model'>
> = {
    browser: {
        headless: false,
        executablePath: undefined,
        slowMo: 0,
    },
    storage: {
        rootDir: process.cwd(),
    },
    model: 'gpt-5.1',
    debug: false,
}

function hasLegacyAiConfig(config: unknown): boolean {
    if (!config || typeof config !== 'object') return false
    return Object.prototype.hasOwnProperty.call(
        config as Record<string, unknown>,
        'ai'
    )
}

function assertNoLegacyAiConfig(source: string, config: unknown): void {
    if (hasLegacyAiConfig(config)) {
        throw new Error(
            `Legacy "ai" config is no longer supported in ${source}. Use top-level "model" instead.`
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

export function resolveConfig(
    input: OpensteerConfig = {}
): ResolvedOpensteerConfig {
    if (process.env.OPENSTEER_AI_MODEL) {
        throw new Error(
            'OPENSTEER_AI_MODEL is no longer supported. Use OPENSTEER_MODEL instead.'
        )
    }

    assertNoLegacyAiConfig('Opensteer constructor config', input as unknown)

    const rootDir =
        input.storage?.rootDir ??
        DEFAULT_CONFIG.storage.rootDir ??
        process.cwd()
    const fileConfig = loadConfigFile(rootDir)
    assertNoLegacyAiConfig('.opensteer/config.json', fileConfig as unknown)

    const envConfig: Partial<OpensteerConfig> = {
        browser: {
            headless: parseBool(process.env.OPENSTEER_HEADLESS),
            executablePath: process.env.OPENSTEER_BROWSER_PATH || undefined,
            slowMo: parseNumber(process.env.OPENSTEER_SLOW_MO),
        },
        model: process.env.OPENSTEER_MODEL || undefined,
        debug: parseBool(process.env.OPENSTEER_DEBUG),
    }

    const mergedWithFile = mergeDeep(DEFAULT_CONFIG, fileConfig)
    const mergedWithEnv = mergeDeep(mergedWithFile, envConfig)
    return mergeDeep(mergedWithEnv, input) as ResolvedOpensteerConfig
}

export function resolveNamespace(
    config: OpensteerConfig,
    rootDir: string
): string {
    if (config.name && config.name.trim()) return config.name.trim()

    const caller = getCallerFilePath()
    if (!caller) return 'default'

    const relative = path.relative(rootDir, caller)
    const cleaned = relative
        .replace(/\\/g, '/')
        .replace(/\.(ts|tsx|js|mjs|cjs)$/, '')

    return cleaned || 'default'
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
