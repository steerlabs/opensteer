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

    it('rejects conflicting flags', () => {
        expect(() =>
            resolveCloudCredential({
                env: {},
                apiKeyFlag: 'ork_123',
                accessTokenFlag: 'ost_123',
            })
        ).toThrow('--api-key and --access-token are mutually exclusive.')
    })

    it('rejects conflicting env credentials when flags are not set', () => {
        expect(() =>
            resolveCloudCredential({
                env: {
                    OPENSTEER_API_KEY: 'ork_123',
                    OPENSTEER_ACCESS_TOKEN: 'ost_123',
                },
            })
        ).toThrow(
            'OPENSTEER_API_KEY and OPENSTEER_ACCESS_TOKEN are mutually exclusive. Set only one.'
        )
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

    it('falls back to saved machine credentials when flag/env credentials are missing', () => {
        const store = {
            readCloudCredential: () => ({
                baseUrl: 'https://api.opensteer.com',
                siteUrl: 'https://opensteer.com',
                scope: ['cloud:browser'],
                accessToken: 'ost_saved_123',
                refreshToken: 'rt_saved_123',
                obtainedAt: 1,
                expiresAt: 2,
            }),
        }
        const resolved = resolveCloudCredential({
            env: {},
            store,
        })

        expect(resolved).toEqual(
            expect.objectContaining({
                kind: 'access-token',
                source: 'saved',
                token: 'ost_saved_123',
                authScheme: 'bearer',
            })
        )
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
