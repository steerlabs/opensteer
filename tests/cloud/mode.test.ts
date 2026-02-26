import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { OpensteerActionError } from '../../src/actions/errors.js'
import { OpensteerCloudError } from '../../src/cloud/errors.js'
import { ActionWsClient } from '../../src/cloud/action-ws-client.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.restoreAllMocks()
})

describe('cloud mode', () => {
    it('requires a non-empty cloud API key when OPENSTEER_MODE=cloud', () => {
        process.env.OPENSTEER_MODE = 'cloud'
        delete process.env.OPENSTEER_API_KEY

        expect(() => new Opensteer({})).toThrow(
            'Cloud mode requires a non-empty API key via cloud.apiKey or OPENSTEER_API_KEY.'
        )
    })

    it('uses OPENSTEER_API_KEY when OPENSTEER_MODE=cloud', () => {
        process.env.OPENSTEER_MODE = 'cloud'
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        expect(() => new Opensteer({})).not.toThrow()
    })

    it('uses OPENSTEER_API_KEY when cloud apiKey is omitted', () => {
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        expect(() => new Opensteer({ cloud: true })).not.toThrow()
    })

    it('requires a non-empty cloud API key when cloud mode is enabled', () => {
        delete process.env.OPENSTEER_API_KEY

        expect(() => new Opensteer({ cloud: true })).toThrow(
            'Cloud mode requires a non-empty API key via cloud.apiKey or OPENSTEER_API_KEY.'
        )
    })

    it('treats explicit empty cloud.apiKey as an override of OPENSTEER_API_KEY', () => {
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        expect(
            () =>
                new Opensteer({
                    cloud: {
                        apiKey: '   ',
                    },
                })
        ).toThrow(
            'Cloud mode requires a non-empty API key via cloud.apiKey or OPENSTEER_API_KEY.'
        )
    })

    it('rejects Opensteer.from(page) in cloud mode', () => {
        expect(() =>
            Opensteer.from({} as never, {
                cloud: {
                    apiKey: 'ork_test_123',
                },
            })
        ).toThrow('Opensteer.from(page) is not supported in cloud mode.')
    })

    it('rejects Opensteer.from(page) when OPENSTEER_MODE=cloud', () => {
        process.env.OPENSTEER_MODE = 'cloud'
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        expect(() => Opensteer.from({} as never, {})).toThrow(
            'Opensteer.from(page) is not supported in cloud mode.'
        )
    })

    it('throws explicit unsupported errors for path-based methods', async () => {
        const opensteer = new Opensteer({
            cloud: {
                apiKey: 'ork_test_123',
            },
        })

        await expect(
            opensteer.uploadFile({
                description: 'resume upload',
                paths: ['/tmp/file.pdf'],
            })
        ).rejects.toThrow(
            'uploadFile() is not supported in cloud mode because file paths must be accessible on the cloud runtime.'
        )

        await expect(
            opensteer.exportCookies('/tmp/cookies.json')
        ).rejects.toThrow(
            'exportCookies() is not supported in cloud mode because it depends on local filesystem paths.'
        )
    })

    it('requires launch before cloud action calls', async () => {
        const opensteer = new Opensteer({
            cloud: {
                apiKey: 'ork_test_123',
            },
        })

        await expect(
            opensteer.click({
                description: 'login button',
            })
        ).rejects.toThrow('Cloud session is not connected. Call launch() first.')
    })

    it('uses cloudSessionUrl from the cloud session payload', async () => {
        const opensteer = new Opensteer({
            cloud: {
                apiKey: 'ork_test_123',
                baseUrl: 'https://internal.example/api',
            },
        })

        const access = opensteer as unknown as {
            cloud: {
                sessionClient: {
                    create: (
                        args: Record<string, unknown>
                    ) => Promise<Record<string, unknown>>
                }
                cdpClient: {
                    connect: (
                        args: Record<string, unknown>
                    ) => Promise<{
                        browser: unknown
                        context: unknown
                        page: unknown
                    }>
                }
            } | null
        }

        if (!access.cloud) throw new Error('Expected cloud runtime state to exist.')

        const sessionResponse = {
            sessionId: 'sess_123',
            actionWsUrl: 'wss://action.example.com',
            cdpWsUrl: 'wss://cdp.example.com',
            actionToken: 'act_123',
            cdpToken: 'cdp_123',
            cloudSessionUrl: 'https://app.opensteer.com/browser/cloud_123',
            cloudSession: {
                sessionId: 'cloud_123',
                workspaceId: 'ws_123',
                state: 'active',
                createdAt: 1735707600000,
                sourceType: 'local-cloud' as const,
            },
        }

        vi.spyOn(access.cloud.sessionClient, 'create').mockResolvedValue(
            sessionResponse
        )
        vi.spyOn(access.cloud.cdpClient, 'connect').mockResolvedValue({
            browser: { close: async () => undefined },
            context: {},
            page: {},
        })
        vi.spyOn(ActionWsClient, 'connect').mockResolvedValue({
            close: async () => undefined,
            request: async () => undefined,
        } as unknown as ActionWsClient)

        await opensteer.launch()

        expect(opensteer.getCloudSessionUrl()).toBe(sessionResponse.cloudSessionUrl)
        expect(opensteer.getCloudSessionUrl()).not.toBe(
            'https://internal.example/api/browser/cloud_123'
        )
    })

    it('maps cloud action failures with details into OpensteerActionError', async () => {
        const opensteer = new Opensteer({
            cloud: {
                apiKey: 'ork_test_123',
            },
        })

        const access = opensteer as unknown as {
            cloud: {
                actionClient: {
                    request: (
                        method: string,
                        args: Record<string, unknown>
                    ) => Promise<unknown>
                }
                sessionId: string
            } | null
        }

        if (!access.cloud) throw new Error('Expected cloud runtime state to exist.')

        access.cloud.sessionId = 'sess_test_123'
        access.cloud.actionClient = {
            request: async () => {
                throw new OpensteerCloudError(
                    'CLOUD_ACTION_FAILED',
                    'cloud click failed',
                    undefined,
                    {
                        actionFailure: {
                            code: 'BLOCKED_BY_INTERCEPTOR',
                            message: 'Blocked by overlay.',
                            retryable: true,
                            classificationSource: 'typed_error',
                        },
                    }
                )
            },
        }

        try {
            await opensteer.click({ description: 'login button' })
            throw new Error('Expected cloud click to fail.')
        } catch (err) {
            expect(err).toBeInstanceOf(OpensteerActionError)
            const actionError = err as OpensteerActionError
            expect(actionError.failure.code).toBe('BLOCKED_BY_INTERCEPTOR')
            expect(actionError.failure.message).toBe('Blocked by overlay.')
        }
    })

    it('re-syncs cloud page reference after cloud goto', async () => {
        const opensteer = new Opensteer({
            cloud: {
                apiKey: 'ork_test_123',
            },
        })

        const access = opensteer as unknown as {
            cloud: {
                sessionClient: {
                    create: (
                        args: Record<string, unknown>
                    ) => Promise<Record<string, unknown>>
                }
                cdpClient: {
                    connect: (
                        args: Record<string, unknown>
                    ) => Promise<{
                        browser: unknown
                        context: unknown
                        page: unknown
                    }>
                }
            } | null
        }
        if (!access.cloud) throw new Error('Expected cloud runtime state to exist.')

        const internalPage = {
            url: () => 'chrome://new-tab-page/',
            title: async () => 'New Tab',
        } as unknown as Page
        const targetPage = {
            url: () => 'https://www.amazon.com/',
            title: async () => 'Amazon.com. Spend less. Smile more.',
        } as unknown as Page
        const context = {
            pages: () => [internalPage, targetPage],
        }
        const browser = {
            contexts: () => [context],
            close: async () => undefined,
        }

        vi.spyOn(access.cloud.sessionClient, 'create').mockResolvedValue({
            sessionId: 'sess_123',
            actionWsUrl: 'wss://action.example.com',
            cdpWsUrl: 'wss://cdp.example.com',
            actionToken: 'act_123',
            cdpToken: 'cdp_123',
            cloudSessionUrl: 'https://app.opensteer.com/browser/cloud_123',
            cloudSession: {
                sessionId: 'cloud_123',
                workspaceId: 'ws_123',
                state: 'active',
                createdAt: 1735707600000,
                sourceType: 'local-cloud' as const,
            },
        })
        vi.spyOn(access.cloud.cdpClient, 'connect').mockResolvedValue({
            browser,
            context,
            page: internalPage,
        })

        let navigated = false
        const request = vi.fn(async (method: string) => {
            if (method === 'goto') {
                navigated = true
                return null
            }
            if (method === 'tabs') {
                if (!navigated) {
                    return [
                        {
                            index: 0,
                            url: 'chrome://new-tab-page/',
                            title: 'New Tab',
                            active: true,
                        },
                        {
                            index: 1,
                            url: 'about:blank',
                            title: '',
                            active: false,
                        },
                    ]
                }

                return [
                    {
                        index: 0,
                        url: 'chrome://new-tab-page/',
                        title: 'New Tab',
                        active: false,
                    },
                    {
                        index: 1,
                        url: 'https://www.amazon.com/',
                        title: 'Amazon.com. Spend less. Smile more.',
                        active: true,
                    },
                ]
            }
            return null
        })

        vi.spyOn(ActionWsClient, 'connect').mockResolvedValue({
            close: async () => undefined,
            request,
        } as unknown as ActionWsClient)

        await opensteer.launch()
        expect(opensteer.page).toBe(internalPage)

        await opensteer.goto('https://www.amazon.com')
        expect(opensteer.page).toBe(targetPage)
    })
})
