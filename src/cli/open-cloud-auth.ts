import { resolveCloudSelection, resolveConfigWithEnv } from '../config.js'
import type { EnsuredCloudAuthContext } from './auth.js'
import type {
    OpensteerAuthScheme,
    OpensteerCloudOptions,
    OpensteerConfig,
} from '../types.js'

export interface CliOpenCloudAuth {
    apiKey?: string
    accessToken?: string
    baseUrl: string
    authScheme: OpensteerAuthScheme
}

interface BuildServerOpenConfigOptions {
    scopeDir: string
    name: string
    cursorEnabled: boolean
    headless?: boolean
    connectUrl?: string
    channel?: string
    profileDir?: string
    cloudAuth?: CliOpenCloudAuth | null
    env?: Record<string, string | undefined>
}

export function serializeCliOpenCloudAuth(
    auth: EnsuredCloudAuthContext | null
): CliOpenCloudAuth | null {
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

export function normalizeCliOpenCloudAuth(
    value: unknown
): CliOpenCloudAuth | null {
    if (value == null) {
        return null
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid open request cloud auth payload.')
    }

    const record = value as Record<string, unknown>
    const apiKey = normalizeNonEmptyString(record.apiKey)
    const accessToken = normalizeNonEmptyString(record.accessToken)
    const baseUrl = normalizeNonEmptyString(record.baseUrl)
    const authScheme = normalizeAuthScheme(record.authScheme)

    if (!baseUrl) {
        throw new Error('Open request cloud auth payload is missing baseUrl.')
    }
    if ((apiKey ? 1 : 0) + (accessToken ? 1 : 0) !== 1) {
        throw new Error(
            'Open request cloud auth payload must include exactly one credential.'
        )
    }
    if (accessToken && authScheme !== 'bearer') {
        throw new Error(
            'Open request cloud auth payload must use authScheme "bearer" with accessToken.'
        )
    }

    return {
        ...(apiKey ? { apiKey } : {}),
        ...(accessToken ? { accessToken } : {}),
        baseUrl,
        authScheme,
    }
}

export function buildServerOpenConfig(
    options: BuildServerOpenConfigOptions
): OpensteerConfig {
    const config: OpensteerConfig = {
        name: options.name,
        storage: {
            rootDir: options.scopeDir,
        },
        cursor: {
            enabled: options.cursorEnabled,
        },
        browser: {
            headless: options.headless ?? false,
            connectUrl: options.connectUrl,
            channel: options.channel,
            profileDir: options.profileDir,
        },
    }

    if (!options.cloudAuth) {
        return config
    }

    const resolved = resolveConfigWithEnv(
        {
            storage: {
                rootDir: options.scopeDir,
            },
        },
        {
            env: options.env,
        }
    )
    const cloudSelection = resolveCloudSelection(
        {
            cloud: resolved.config.cloud,
        },
        resolved.env
    )

    if (!cloudSelection.cloud) {
        return config
    }

    config.cloud = toOpensteerCloudOptions(options.cloudAuth)
    return config
}

function toOpensteerCloudOptions(auth: CliOpenCloudAuth): OpensteerCloudOptions {
    return {
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        ...(auth.accessToken ? { accessToken: auth.accessToken } : {}),
        baseUrl: auth.baseUrl,
        authScheme: auth.authScheme,
    }
}

function normalizeNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined
    }

    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

function normalizeAuthScheme(value: unknown): OpensteerAuthScheme {
    if (value === 'api-key' || value === 'bearer') {
        return value
    }

    throw new Error(
        'Open request cloud auth payload must use authScheme "api-key" or "bearer".'
    )
}
