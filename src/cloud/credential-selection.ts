import type { OpensteerAuthScheme } from '../types.js'

export interface SelectCloudCredentialOptions {
    apiKey?: string
    accessToken?: string
    authScheme?: OpensteerAuthScheme
}

export interface SelectedCloudCredential {
    apiKey?: string
    accessToken?: string
    authScheme: OpensteerAuthScheme
    kind: 'api-key' | 'access-token'
    token: string
    compatibilityBearerApiKey?: boolean
}

export function selectCloudCredential(
    options: SelectCloudCredentialOptions
): SelectedCloudCredential | null {
    const apiKey = normalizeNonEmptyString(options.apiKey)
    const accessToken = normalizeNonEmptyString(options.accessToken)

    if (apiKey) {
        if (options.authScheme === 'bearer') {
            return {
                apiKey,
                authScheme: 'bearer',
                kind: 'access-token',
                token: apiKey,
                compatibilityBearerApiKey: true,
            }
        }

        return {
            apiKey,
            authScheme: 'api-key',
            kind: 'api-key',
            token: apiKey,
        }
    }

    if (accessToken) {
        return {
            accessToken,
            authScheme: 'bearer',
            kind: 'access-token',
            token: accessToken,
        }
    }

    return null
}

function normalizeNonEmptyString(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length ? normalized : undefined
}
