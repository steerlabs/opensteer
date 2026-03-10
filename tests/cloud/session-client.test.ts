import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudSessionClient } from '../../src/cloud/session-client.js'
import { OpensteerCloudError } from '../../src/cloud/errors.js'
import { cloudSessionContractVersion } from '../../src/cloud/contracts.js'

const ORIGINAL_FETCH = globalThis.fetch
const CREATE_REQUEST = {
    cloudSessionContractVersion,
    sourceType: 'local-cloud' as const,
    clientSessionHint: 'default',
    localRunId: 'default-run-1234',
}

const CREATE_RESPONSE = {
    sessionId: 'sess_123',
    actionWsUrl: 'wss://action.example.com',
    cdpWsUrl: 'wss://cdp.example.com',
    actionToken: 'act_123',
    cdpToken: 'cdp_123',
    cloudSessionUrl: 'https://opensteer.com/browser/cloud_123',
    cloudSession: {
        sessionId: 'cloud_123',
        workspaceId: 'ws_123',
        state: 'active',
        createdAt: 1735707600000,
        sourceType: 'local-cloud' as const,
    },
}

describe('CloudSessionClient#importSelectorCache', () => {
    afterEach(() => {
        globalThis.fetch = ORIGINAL_FETCH
    })

    it('does not call the backend when there are no entries', async () => {
        const fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new CloudSessionClient('http://localhost:8080', 'ork_key')
        const result = await client.importSelectorCache({ entries: [] })

        expect(fetchMock).not.toHaveBeenCalled()
        expect(result).toEqual({
            imported: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
        })
    })

    it('throws on 404 import endpoint responses', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 404 })) as never

        const client = new CloudSessionClient('http://localhost:8080', 'ork_key')
        await expect(
            client.importSelectorCache({
                entries: [
                    {
                        namespace: 'default',
                        siteOrigin: 'https://example.com',
                        method: 'click',
                        descriptionHash: 'abcdef0123456789',
                        path: { context: [], nodes: [] },
                        createdAt: 100,
                        updatedAt: 100,
                    },
                ],
            })
        ).rejects.toEqual(
            expect.objectContaining<Partial<OpensteerCloudError>>({
                code: 'CLOUD_TRANSPORT_ERROR',
                status: 404,
            })
        )
    })

    it('throws on backend errors with recognized cloud codes', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(
                new Response(
                    JSON.stringify({
                        error: 'bad request',
                        code: 'CLOUD_INVALID_REQUEST',
                    }),
                    {
                        status: 400,
                        headers: { 'content-type': 'application/json' },
                    }
                )
            ) as never

        const client = new CloudSessionClient('http://localhost:8080', 'ork_key')

        await expect(
            client.importSelectorCache({
                entries: [
                    {
                        namespace: 'default',
                        siteOrigin: 'https://example.com',
                        method: 'click',
                        descriptionHash: 'abcdef0123456789',
                        path: { context: [], nodes: [] },
                        createdAt: 100,
                        updatedAt: 100,
                    },
                ],
            })
        ).rejects.toEqual(
            expect.objectContaining<Partial<OpensteerCloudError>>({
                code: 'CLOUD_INVALID_REQUEST',
                status: 400,
            })
        )
    })

    it('preserves browser-profile cloud error codes from backend responses', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(
                new Response(
                    JSON.stringify({
                        error: 'profile not found',
                        code: 'CLOUD_BROWSER_PROFILE_NOT_FOUND',
                    }),
                    {
                        status: 404,
                        headers: { 'content-type': 'application/json' },
                    }
                )
            ) as never

        const client = new CloudSessionClient('http://localhost:8080', 'ork_key')
        await expect(client.create(CREATE_REQUEST)).rejects.toEqual(
            expect.objectContaining<Partial<OpensteerCloudError>>({
                code: 'CLOUD_BROWSER_PROFILE_NOT_FOUND',
                status: 404,
            })
        )
    })
})

describe('CloudSessionClient auth scheme', () => {
    afterEach(() => {
        globalThis.fetch = ORIGINAL_FETCH
    })

    it('normalizes trailing slashes in the configured base url', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify(CREATE_RESPONSE), {
                    status: 201,
                    headers: { 'content-type': 'application/json' },
                })
            )
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new CloudSessionClient(
            'http://localhost:8080////',
            'ork_key'
        )
        await client.create(CREATE_REQUEST)

        const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('http://localhost:8080/sessions')
    })

    it('uses x-api-key by default', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                new Response(
                    JSON.stringify(CREATE_RESPONSE),
                    {
                        status: 201,
                        headers: { 'content-type': 'application/json' },
                    }
                )
            )
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new CloudSessionClient('http://localhost:8080', 'ork_key')
        await client.create(CREATE_REQUEST)

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(init.headers).toEqual(
            expect.objectContaining({
                'content-type': 'application/json',
                'x-api-key': 'ork_key',
            })
        )
    })

    it('throws CLOUD_CONTRACT_MISMATCH when create response payload is malformed', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                new Response(
                    JSON.stringify({
                        ...CREATE_RESPONSE,
                        cloudSession: null,
                    }),
                    {
                        status: 201,
                        headers: { 'content-type': 'application/json' },
                    }
                )
            )
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new CloudSessionClient('http://localhost:8080', 'ork_key')
        await expect(client.create(CREATE_REQUEST)).rejects.toEqual(
            expect.objectContaining<Partial<OpensteerCloudError>>({
                code: 'CLOUD_CONTRACT_MISMATCH',
                status: 201,
            })
        )
    })

    it('accepts project-agent-run as a valid cloud session source type', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                new Response(
                    JSON.stringify({
                        ...CREATE_RESPONSE,
                        cloudSession: {
                            ...CREATE_RESPONSE.cloudSession,
                            sourceType: 'project-agent-run',
                        },
                    }),
                    {
                        status: 201,
                        headers: { 'content-type': 'application/json' },
                    }
                )
            )
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new CloudSessionClient('http://localhost:8080', 'ork_key')
        const response = await client.create(CREATE_REQUEST)

        expect(response.cloudSession.sourceType).toBe('project-agent-run')
    })

    it('rejects create responses with invalid session states', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                new Response(
                    JSON.stringify({
                        ...CREATE_RESPONSE,
                        cloudSession: {
                            ...CREATE_RESPONSE.cloudSession,
                            state: 'zombie',
                        },
                    }),
                    {
                        status: 201,
                        headers: { 'content-type': 'application/json' },
                    }
                )
            )
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new CloudSessionClient('http://localhost:8080', 'ork_key')
        await expect(client.create(CREATE_REQUEST)).rejects.toEqual(
            expect.objectContaining<Partial<OpensteerCloudError>>({
                code: 'CLOUD_CONTRACT_MISMATCH',
                status: 201,
            })
        )
    })

    it('throws CLOUD_CONTRACT_MISMATCH when create response is not valid JSON', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                new Response('not-json', {
                    status: 201,
                    headers: { 'content-type': 'application/json' },
                })
            )
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new CloudSessionClient('http://localhost:8080', 'ork_key')
        await expect(client.create(CREATE_REQUEST)).rejects.toEqual(
            expect.objectContaining<Partial<OpensteerCloudError>>({
                code: 'CLOUD_CONTRACT_MISMATCH',
                status: 201,
            })
        )
    })

    it('uses Authorization bearer header when authScheme is bearer', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 204 }))
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new CloudSessionClient(
            'http://localhost:8080',
            'sandbox_token',
            'bearer'
        )
        await client.close('sess_123')

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(init.headers).toEqual(
            expect.objectContaining({
                authorization: 'Bearer sandbox_token',
            })
        )
    })
})
