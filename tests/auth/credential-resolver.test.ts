import { describe, expect, it } from 'vitest'
import {
    applyCloudCredentialToEnv,
    resolveCloudCredential,
} from '../../src/auth/credential-resolver.js'

describe('credential-resolver', () => {
    it('prefers explicit flags over env credentials', () => {
        const resolved = resolveCloudCredential({
            env: {
                OPENSTEER_API_KEY: 'ork_env_123',
            },
            apiKeyFlag: 'ork_flag_123',
        })

        expect(resolved).toEqual({
            kind: 'api-key',
            source: 'flag',
            token: 'ork_flag_123',
            authScheme: 'api-key',
        })
    })

    it('prefers --api-key when conflicting flags are provided', () => {
        const resolved = resolveCloudCredential({
            env: {},
            apiKeyFlag: 'ork_123',
            accessTokenFlag: 'ost_123',
        })

        expect(resolved).toEqual({
            kind: 'api-key',
            source: 'flag',
            token: 'ork_123',
            authScheme: 'api-key',
        })
    })

    it('prefers OPENSTEER_API_KEY when conflicting env credentials are set', () => {
        const resolved = resolveCloudCredential({
            env: {
                OPENSTEER_API_KEY: 'ork_123',
                OPENSTEER_ACCESS_TOKEN: 'ost_123',
            },
        })

        expect(resolved).toEqual({
            kind: 'api-key',
            source: 'env',
            token: 'ork_123',
            authScheme: 'api-key',
        })
    })

    it('maps OPENSTEER_AUTH_SCHEME=bearer + OPENSTEER_API_KEY to access-token compatibility mode', () => {
        const resolved = resolveCloudCredential({
            env: {
                OPENSTEER_AUTH_SCHEME: 'bearer',
                OPENSTEER_API_KEY: 'legacy_bearer_token',
            },
        })

        expect(resolved).toEqual({
            kind: 'access-token',
            source: 'env',
            token: 'legacy_bearer_token',
            authScheme: 'bearer',
            compatibilityBearerApiKey: true,
        })
    })

    it('keeps bearer compatibility when OPENSTEER_AUTH_SCHEME=bearer and both env credentials are set', () => {
        const resolved = resolveCloudCredential({
            env: {
                OPENSTEER_AUTH_SCHEME: 'bearer',
                OPENSTEER_API_KEY: 'legacy_bearer_token',
                OPENSTEER_ACCESS_TOKEN: 'ost_ignored',
            },
        })

        expect(resolved).toEqual({
            kind: 'access-token',
            source: 'env',
            token: 'legacy_bearer_token',
            authScheme: 'bearer',
            compatibilityBearerApiKey: true,
        })
    })

    it('returns null when explicit flag/env credentials are missing', () => {
        const resolved = resolveCloudCredential({
            env: {},
        })

        expect(resolved).toBeNull()
    })

    it('applies access-token credentials to env with bearer auth scheme', () => {
        const env: Record<string, string | undefined> = {
            OPENSTEER_API_KEY: 'ork_stale',
        }
        applyCloudCredentialToEnv(env, {
            kind: 'access-token',
            source: 'saved',
            token: 'ost_new',
            authScheme: 'bearer',
        })

        expect(env.OPENSTEER_ACCESS_TOKEN).toBe('ost_new')
        expect(env.OPENSTEER_AUTH_SCHEME).toBe('bearer')
        expect(env.OPENSTEER_API_KEY).toBeUndefined()
    })
})
