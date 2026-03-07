import type { OpensteerAuthScheme } from '../types.js'
import {
    selectCloudCredential,
    type SelectedCloudCredential,
} from '../cloud/credential-selection.js'

export type CloudCredentialKind = 'api-key' | 'access-token'
export type CloudCredentialSource = 'flag' | 'env' | 'saved'

export interface ResolvedCloudCredential {
    kind: CloudCredentialKind
    source: CloudCredentialSource
    token: string
    authScheme: OpensteerAuthScheme
    compatibilityBearerApiKey?: boolean
}

export interface ResolveCloudCredentialOptions {
    env: Record<string, string | undefined>
    apiKeyFlag?: string
    accessTokenFlag?: string
}

export function resolveCloudCredential(
    options: ResolveCloudCredentialOptions
): ResolvedCloudCredential | null {
    const flagCredential = selectCloudCredential({
        apiKey: options.apiKeyFlag,
        accessToken: options.accessTokenFlag,
    })
    if (flagCredential) {
        return toResolvedCloudCredential('flag', flagCredential)
    }

    const envAuthScheme = parseEnvAuthScheme(options.env.OPENSTEER_AUTH_SCHEME)
    const envCredential = selectCloudCredential({
        apiKey: options.env.OPENSTEER_API_KEY,
        accessToken: options.env.OPENSTEER_ACCESS_TOKEN,
        authScheme: envAuthScheme,
    })
    if (envCredential) {
        return toResolvedCloudCredential('env', envCredential)
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

function toResolvedCloudCredential(
    source: CloudCredentialSource,
    credential: SelectedCloudCredential
): ResolvedCloudCredential {
    if (credential.compatibilityBearerApiKey) {
        return {
            kind: credential.kind,
            source,
            token: credential.token,
            authScheme: credential.authScheme,
            compatibilityBearerApiKey: true,
        }
    }

    return {
        kind: credential.kind,
        source,
        token: credential.token,
        authScheme: credential.authScheme,
    }
}
