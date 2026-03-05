import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserProfileClient } from '../../src/cloud/browser-profile-client.js'
import { OpensteerCloudError } from '../../src/cloud/errors.js'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
})

describe('BrowserProfileClient', () => {
    it('uses x-api-key auth by default and returns list payload', async () => {
        const responsePayload = {
            profiles: [
                {
                    profileId: 'bp_123',
                    teamId: 'team_1',
                    ownerUserId: 'user_1',
                    name: 'Profile 1',
                    status: 'active',
                    proxyPolicy: 'strict_sticky',
                    fingerprintMode: 'auto',
                    latestStorageId: 'storage_123',
                    createdAt: 1,
                    updatedAt: 2,
                },
            ],
        }
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify(responsePayload), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        )
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new BrowserProfileClient(
            'https://api.opensteer.com',
            'ork_test_123'
        )
        const result = await client.list()

        expect(result).toEqual(responsePayload)
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(init.headers).toEqual(
            expect.objectContaining({
                'x-api-key': 'ork_test_123',
            })
        )
    })

    it('maps backend cloud error codes', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(
                new Response(
                    JSON.stringify({
                        error: 'not found',
                        code: 'CLOUD_BROWSER_PROFILE_NOT_FOUND',
                    }),
                    {
                        status: 404,
                        headers: { 'content-type': 'application/json' },
                    }
                )
            ) as never

        const client = new BrowserProfileClient(
            'https://api.opensteer.com',
            'ork_test_123'
        )

        await expect(client.get('bp_missing')).rejects.toEqual(
            expect.objectContaining<Partial<OpensteerCloudError>>({
                code: 'CLOUD_BROWSER_PROFILE_NOT_FOUND',
                status: 404,
            })
        )
    })
})
