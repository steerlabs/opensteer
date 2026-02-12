import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { OversteerConfig } from './types.js'

const DEFAULT_CONFIG: Required<
    Pick<OversteerConfig, 'browser' | 'storage' | 'debug'>
> & {
    ai: NonNullable<OversteerConfig['ai']>
} = {
    browser: {
        headless: false,
        executablePath: undefined,
        slowMo: 0,
    },
    storage: {
        rootDir: process.cwd(),
    },
    ai: {},
    debug: false,
}

export function loadConfigFile(rootDir: string): Partial<OversteerConfig> {
    const configPath = path.join(rootDir, '.oversteer', 'config.json')
    if (!fs.existsSync(configPath)) return {}

    try {
        const raw = fs.readFileSync(configPath, 'utf8')
        return JSON.parse(raw) as Partial<OversteerConfig>
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

export function resolveConfig(input: OversteerConfig = {}): OversteerConfig {
    const rootDir =
        input.storage?.rootDir ??
        DEFAULT_CONFIG.storage.rootDir ??
        process.cwd()
    const fileConfig = loadConfigFile(rootDir)

    const envConfig: Partial<OversteerConfig> = {
        browser: {
            headless: parseBool(process.env.OVERSTEER_HEADLESS),
            executablePath: process.env.OVERSTEER_BROWSER_PATH || undefined,
            slowMo: parseNumber(process.env.OVERSTEER_SLOW_MO),
        },
        debug: parseBool(process.env.OVERSTEER_DEBUG),
    }

    const mergedWithFile = mergeDeep(DEFAULT_CONFIG, fileConfig)
    const mergedWithEnv = mergeDeep(mergedWithFile, envConfig)
    const mergedWithInput = mergeDeep(mergedWithEnv, input)

    if (process.env.OVERSTEER_AI_MODEL) {
        mergedWithInput.ai = mergedWithInput.ai || {}
        mergedWithInput.ai.model =
            mergedWithInput.ai.model || process.env.OVERSTEER_AI_MODEL
    }

    return mergedWithInput
}

export function resolveNamespace(
    config: OversteerConfig,
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
        if (rawPath.includes('/oversteer-oss/src/')) continue

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
