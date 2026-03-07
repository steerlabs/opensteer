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

export type CloudCredentialLayerSource = 'input' | 'env' | 'file'

export interface SelectCloudCredentialLayer {
    source?: CloudCredentialLayerSource
    apiKey?: string
    accessToken?: string
    hasApiKey?: boolean
    hasAccessToken?: boolean
    authScheme?: OpensteerAuthScheme
}

export interface SelectedCloudCredentialLayer {
    source?: CloudCredentialLayerSource
    apiKey?: string
    accessToken?: string
    hasApiKey: boolean
    hasAccessToken: boolean
    credential: SelectedCloudCredential | null
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

export function selectCloudCredentialByPrecedence(
    layers: SelectCloudCredentialLayer[],
    authScheme?: OpensteerAuthScheme
): SelectedCloudCredentialLayer | null {
    for (const layer of layers) {
        const hasApiKey =
            layer.hasApiKey ??
            Object.prototype.hasOwnProperty.call(layer, 'apiKey')
        const hasAccessToken =
            layer.hasAccessToken ??
            Object.prototype.hasOwnProperty.call(layer, 'accessToken')

        if (!hasApiKey && !hasAccessToken) {
            continue
        }

        return {
            source: layer.source,
            apiKey: layer.apiKey,
            accessToken: layer.accessToken,
            hasApiKey,
            hasAccessToken,
            credential: selectCloudCredential({
                apiKey: layer.apiKey,
                accessToken: layer.accessToken,
                authScheme: layer.authScheme ?? authScheme,
            }),
        }
    }

    return null
}

function normalizeNonEmptyString(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length ? normalized : undefined
}
