import type { OpensteerAuthScheme } from '../types.js'
import type { StoredMachineCloudCredential } from './machine-credential-store.js'

export type CloudCredentialKind = 'api-key' | 'access-token'
export type CloudCredentialSource = 'flag' | 'env' | 'saved'

export interface ResolvedCloudCredential {
    kind: CloudCredentialKind
    source: CloudCredentialSource
    token: string
    authScheme: OpensteerAuthScheme
    compatibilityBearerApiKey?: boolean
    savedCredential?: StoredMachineCloudCredential
}

export interface ResolveCloudCredentialOptions {
    env: Record<string, string | undefined>
    apiKeyFlag?: string
    accessTokenFlag?: string
    allowSaved?: boolean
    store?: {
        readCloudCredential(): StoredMachineCloudCredential | null
    }
}

export function resolveCloudCredential(
    options: ResolveCloudCredentialOptions
): ResolvedCloudCredential | null {
    const flagApiKey = normalizeToken(options.apiKeyFlag)
    const flagAccessToken = normalizeToken(options.accessTokenFlag)

    if (flagApiKey && flagAccessToken) {
        throw new Error('--api-key and --access-token are mutually exclusive.')
    }

    if (flagAccessToken) {
        return {
            kind: 'access-token',
            source: 'flag',
            token: flagAccessToken,
            authScheme: 'bearer',
        }
    }

    if (flagApiKey) {
        return {
            kind: 'api-key',
            source: 'flag',
            token: flagApiKey,
            authScheme: 'api-key',
        }
    }

    const envAuthScheme = parseEnvAuthScheme(options.env.OPENSTEER_AUTH_SCHEME)
    const envApiKey = normalizeToken(options.env.OPENSTEER_API_KEY)
    const envAccessToken = normalizeToken(options.env.OPENSTEER_ACCESS_TOKEN)

    if (envApiKey && envAccessToken) {
        throw new Error(
            'OPENSTEER_API_KEY and OPENSTEER_ACCESS_TOKEN are mutually exclusive. Set only one.'
        )
    }

    if (envAccessToken) {
        return {
            kind: 'access-token',
            source: 'env',
            token: envAccessToken,
            authScheme: 'bearer',
        }
    }

    if (envApiKey) {
        if (envAuthScheme === 'bearer') {
            return {
                kind: 'access-token',
                source: 'env',
                token: envApiKey,
                authScheme: 'bearer',
                compatibilityBearerApiKey: true,
            }
        }

        return {
            kind: 'api-key',
            source: 'env',
            token: envApiKey,
            authScheme: envAuthScheme ?? 'api-key',
        }
    }

    if (options.allowSaved !== false && options.store) {
        const savedCredential = options.store.readCloudCredential()
        if (savedCredential?.accessToken.trim()) {
            return {
                kind: 'access-token',
                source: 'saved',
                token: savedCredential.accessToken.trim(),
                authScheme: 'bearer',
                savedCredential,
            }
        }
    }

    return null
}

export function applyCloudCredentialToEnv(
    env: Record<string, string | undefined>,
    credential: ResolvedCloudCredential
): void {
    if (credential.kind === 'access-token') {
        env.OPENSTEER_ACCESS_TOKEN = credential.token
        delete env.OPENSTEER_API_KEY
        env.OPENSTEER_AUTH_SCHEME = 'bearer'
        return
    }

    env.OPENSTEER_API_KEY = credential.token
    delete env.OPENSTEER_ACCESS_TOKEN
    env.OPENSTEER_AUTH_SCHEME = credential.authScheme
}

export function parseEnvAuthScheme(
    value: string | undefined
): OpensteerAuthScheme | undefined {
    const normalized = normalizeToken(value)
    if (!normalized) return undefined
    if (normalized === 'api-key' || normalized === 'bearer') {
        return normalized
    }
    throw new Error(
        `Invalid OPENSTEER_AUTH_SCHEME value "${value}". Use "api-key" or "bearer".`
    )
}

function normalizeToken(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length ? normalized : undefined
}
