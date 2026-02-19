import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudSessionClient } from '../../src/cloud/session-client.js'
import { OpensteerCloudError } from '../../src/cloud/errors.js'

const ORIGINAL_FETCH = globalThis.fetch

describe('CloudSessionClient#importSelectorCache', () => {
    afterEach(() => {
        globalThis.fetch = ORIGINAL_FETCH
    })

    it('does not call the backend when there are no entries', async () => {
        const fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new CloudSessionClient('http://localhost:8080', 'osk_key')
        const result = await client.importSelectorCache({ entries: [] })

        expect(fetchMock).not.toHaveBeenCalled()
        expect(result).toEqual({
            imported: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
        })
    })

    it('treats 404 import endpoint as backward-compatible no-op', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 404 })) as never

        const client = new CloudSessionClient('http://localhost:8080', 'osk_key')
        const result = await client.importSelectorCache({
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

        expect(result).toEqual({
            imported: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
        })
    })

    it('throws on non-404 backend errors', async () => {
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

        const client = new CloudSessionClient('http://localhost:8080', 'osk_key')

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
})
