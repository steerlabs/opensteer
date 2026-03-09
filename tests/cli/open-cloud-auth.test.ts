import { describe, expect, it } from 'vitest'
import {
    buildServerOpenConfig,
    normalizeCliOpenCloudAuth,
    serializeCliOpenCloudAuth,
} from '../../src/cli/open-cloud-auth.js'

describe('CLI open cloud auth helpers', () => {
    it('serializes resolved access-token auth for IPC transport', () => {
        expect(
            serializeCliOpenCloudAuth({
                token: 'token-123',
                kind: 'access-token',
                authScheme: 'bearer',
                source: 'saved',
                baseUrl: 'https://api.opensteer.test',
            })
        ).toEqual({
            accessToken: 'token-123',
            authScheme: 'bearer',
            baseUrl: 'https://api.opensteer.test',
        })
    })

    it('normalizes a valid request payload and rejects malformed credentials', () => {
        expect(
            normalizeCliOpenCloudAuth({
                apiKey: 'key-123',
                authScheme: 'api-key',
                baseUrl: 'https://api.opensteer.test',
            })
        ).toEqual({
            apiKey: 'key-123',
            authScheme: 'api-key',
            baseUrl: 'https://api.opensteer.test',
        })

        expect(() =>
            normalizeCliOpenCloudAuth({
                authScheme: 'bearer',
                baseUrl: 'https://api.opensteer.test',
            })
        ).toThrow(
            'Open request cloud auth payload must include exactly one credential.'
        )
    })

    it('applies stored cloud auth to server config only for cloud sessions', () => {
        const cloudAuth = {
            accessToken: 'token-123',
            authScheme: 'bearer' as const,
            baseUrl: 'https://api.opensteer.test',
        }

        const cloudConfig = buildServerOpenConfig({
            scopeDir: '/tmp/opensteer-scope',
            name: 'session-a',
            cursorEnabled: true,
            cdpUrl: 'http://localhost:9222',
            cloudAuth,
            env: {
                OPENSTEER_MODE: 'cloud',
            },
        })

        expect(cloudConfig.storage?.rootDir).toBe('/tmp/opensteer-scope')
        expect(cloudConfig.cloud).toEqual(cloudAuth)
        expect(cloudConfig.browser).toEqual({
            headless: undefined,
            mode: undefined,
            cdpUrl: 'http://localhost:9222',
            userDataDir: undefined,
            profileDirectory: undefined,
            executablePath: undefined,
        })

        const localConfig = buildServerOpenConfig({
            scopeDir: '/tmp/opensteer-scope',
            name: 'session-a',
            cursorEnabled: true,
            cloudAuth,
            env: {
                OPENSTEER_MODE: 'local',
            },
        })

        expect(localConfig.cloud).toBeUndefined()
    })

    it('preserves unset browser overrides so config and env defaults can resolve later', () => {
        expect(
            buildServerOpenConfig({
                scopeDir: '/tmp/opensteer-scope',
                name: 'session-a',
                cursorEnabled: true,
            }).browser
        ).toEqual({
            headless: undefined,
            mode: undefined,
            cdpUrl: undefined,
            userDataDir: undefined,
            profileDirectory: undefined,
            executablePath: undefined,
        })
    })
})
