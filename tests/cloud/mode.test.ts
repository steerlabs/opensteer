import { afterEach, describe, expect, it } from 'vitest'
import { Opensteer } from '../../src/opensteer.js'
import { OpensteerActionError } from '../../src/actions/errors.js'
import { OpensteerCloudError } from '../../src/cloud/errors.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
})

describe('cloud mode', () => {
    it('uses OPENSTEER_API_KEY when cloud.key is omitted', () => {
        process.env.OPENSTEER_API_KEY = 'osk_env_123'

        expect(
            () =>
                new Opensteer({
                    cloud: {
                        enabled: true,
                    },
                })
        ).not.toThrow()
    })

    it('requires a non-empty cloud API key when enabled', () => {
        delete process.env.OPENSTEER_API_KEY

        expect(
            () =>
                new Opensteer({
                    cloud: {
                        enabled: true,
                    },
                })
        ).toThrow(
            'Cloud mode requires a non-empty API key via cloud.key or OPENSTEER_API_KEY.'
        )
    })

    it('treats explicit empty cloud.key as an override of OPENSTEER_API_KEY', () => {
        process.env.OPENSTEER_API_KEY = 'osk_env_123'

        expect(
            () =>
                new Opensteer({
                    cloud: {
                        enabled: true,
                        key: '   ',
                    },
                })
        ).toThrow(
            'Cloud mode requires a non-empty API key via cloud.key or OPENSTEER_API_KEY.'
        )
    })

    it('rejects Opensteer.from(page) in cloud mode', () => {
        expect(() =>
            Opensteer.from({} as never, {
                cloud: {
                    enabled: true,
                    key: 'osk_test_123',
                },
            })
        ).toThrow('Opensteer.from(page) is not supported in cloud mode.')
    })

    it('throws explicit unsupported errors for path-based methods', async () => {
        const ov = new Opensteer({
            cloud: {
                enabled: true,
                key: 'osk_test_123',
            },
        })

        await expect(
            ov.uploadFile({
                description: 'resume upload',
                paths: ['/tmp/file.pdf'],
            })
        ).rejects.toThrow(
            'uploadFile() is not supported in cloud mode because file paths must be accessible on the remote server.'
        )

        await expect(
            ov.exportCookies('/tmp/cookies.json')
        ).rejects.toThrow(
            'exportCookies() is not supported in cloud mode because it depends on local filesystem paths.'
        )
    })

    it('requires launch before cloud action calls', async () => {
        const ov = new Opensteer({
            cloud: {
                enabled: true,
                key: 'osk_test_123',
            },
        })

        await expect(
            ov.click({
                description: 'login button',
            })
        ).rejects.toThrow('Cloud session is not connected. Call launch() first.')
    })

    it('maps cloud action failures with details into OpensteerActionError', async () => {
        const ov = new Opensteer({
            cloud: {
                enabled: true,
                key: 'osk_test_123',
            },
        })

        const access = ov as unknown as {
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

        if (!access.cloud) throw new Error('Expected cloud state to exist.')

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
            await ov.click({ description: 'login button' })
            throw new Error('Expected cloud click to fail.')
        } catch (err) {
            expect(err).toBeInstanceOf(OpensteerActionError)
            const actionError = err as OpensteerActionError
            expect(actionError.failure.code).toBe('BLOCKED_BY_INTERCEPTOR')
            expect(actionError.failure.message).toBe('Blocked by overlay.')
        }
    })
})
