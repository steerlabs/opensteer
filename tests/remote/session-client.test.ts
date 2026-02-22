import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteSessionClient } from '../../src/remote/session-client.js'
import { OpensteerRemoteError } from '../../src/remote/errors.js'

const ORIGINAL_FETCH = globalThis.fetch

describe('RemoteSessionClient#importSelectorCache', () => {
    afterEach(() => {
        globalThis.fetch = ORIGINAL_FETCH
    })

    it('does not call the backend when there are no entries', async () => {
        const fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new RemoteSessionClient('http://localhost:8080', 'ork_key')
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

        const client = new RemoteSessionClient('http://localhost:8080', 'ork_key')
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
            expect.objectContaining<Partial<OpensteerRemoteError>>({
                code: 'REMOTE_TRANSPORT_ERROR',
                status: 404,
            })
        )
    })

    it('throws on backend errors with recognized remote codes', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(
                new Response(
                    JSON.stringify({
                        error: 'bad request',
                        code: 'REMOTE_INVALID_REQUEST',
                    }),
                    {
                        status: 400,
                        headers: { 'content-type': 'application/json' },
                    }
                )
            ) as never

        const client = new RemoteSessionClient('http://localhost:8080', 'ork_key')

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
            expect.objectContaining<Partial<OpensteerRemoteError>>({
                code: 'REMOTE_INVALID_REQUEST',
                status: 400,
            })
        )
    })
})
