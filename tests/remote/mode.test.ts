import { afterEach, describe, expect, it } from 'vitest'
import { Opensteer } from '../../src/opensteer.js'
import { OpensteerActionError } from '../../src/actions/errors.js'
import { OpensteerRemoteError } from '../../src/remote/errors.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
})

describe('remote mode', () => {
    it('requires a non-empty remote API key when OPENSTEER_MODE=remote', () => {
        process.env.OPENSTEER_MODE = 'remote'
        delete process.env.OPENSTEER_API_KEY

        expect(() => new Opensteer({})).toThrow(
            'Remote mode requires a non-empty API key via remote.apiKey or OPENSTEER_API_KEY.'
        )
    })

    it('uses OPENSTEER_API_KEY when OPENSTEER_MODE=remote', () => {
        process.env.OPENSTEER_MODE = 'remote'
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        expect(() => new Opensteer({})).not.toThrow()
    })

    it('uses OPENSTEER_API_KEY when remote apiKey is omitted', () => {
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        expect(() => new Opensteer({ mode: 'remote' })).not.toThrow()
    })

    it('requires a non-empty remote API key when mode is remote', () => {
        delete process.env.OPENSTEER_API_KEY

        expect(() => new Opensteer({ mode: 'remote' })).toThrow(
            'Remote mode requires a non-empty API key via remote.apiKey or OPENSTEER_API_KEY.'
        )
    })

    it('treats explicit empty remote.apiKey as an override of OPENSTEER_API_KEY', () => {
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        expect(
            () =>
                new Opensteer({
                    mode: 'remote',
                    remote: {
                        apiKey: '   ',
                    },
                })
        ).toThrow(
            'Remote mode requires a non-empty API key via remote.apiKey or OPENSTEER_API_KEY.'
        )
    })

    it('rejects Opensteer.from(page) in remote mode', () => {
        expect(() =>
            Opensteer.from({} as never, {
                mode: 'remote',
                remote: {
                    apiKey: 'ork_test_123',
                },
            })
        ).toThrow('Opensteer.from(page) is not supported in remote mode.')
    })

    it('rejects Opensteer.from(page) when OPENSTEER_MODE=remote', () => {
        process.env.OPENSTEER_MODE = 'remote'
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        expect(() => Opensteer.from({} as never, {})).toThrow(
            'Opensteer.from(page) is not supported in remote mode.'
        )
    })

    it('throws explicit unsupported errors for path-based methods', async () => {
        const opensteer = new Opensteer({
            mode: 'remote',
            remote: {
                apiKey: 'ork_test_123',
            },
        })

        await expect(
            opensteer.uploadFile({
                description: 'resume upload',
                paths: ['/tmp/file.pdf'],
            })
        ).rejects.toThrow(
            'uploadFile() is not supported in remote mode because file paths must be accessible on the remote server.'
        )

        await expect(
            opensteer.exportCookies('/tmp/cookies.json')
        ).rejects.toThrow(
            'exportCookies() is not supported in remote mode because it depends on local filesystem paths.'
        )
    })

    it('requires launch before remote action calls', async () => {
        const opensteer = new Opensteer({
            mode: 'remote',
            remote: {
                apiKey: 'ork_test_123',
            },
        })

        await expect(
            opensteer.click({
                description: 'login button',
            })
        ).rejects.toThrow('Remote session is not connected. Call launch() first.')
    })

    it('maps remote action failures with details into OpensteerActionError', async () => {
        const opensteer = new Opensteer({
            mode: 'remote',
            remote: {
                apiKey: 'ork_test_123',
            },
        })

        const access = opensteer as unknown as {
            remote: {
                actionClient: {
                    request: (
                        method: string,
                        args: Record<string, unknown>
                    ) => Promise<unknown>
                }
                sessionId: string
            } | null
        }

        if (!access.remote) throw new Error('Expected remote state to exist.')

        access.remote.sessionId = 'sess_test_123'
        access.remote.actionClient = {
            request: async () => {
                throw new OpensteerRemoteError(
                    'REMOTE_ACTION_FAILED',
                    'remote click failed',
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
            throw new Error('Expected remote click to fail.')
        } catch (err) {
            expect(err).toBeInstanceOf(OpensteerActionError)
            const actionError = err as OpensteerActionError
            expect(actionError.failure.code).toBe('BLOCKED_BY_INTERCEPTOR')
            expect(actionError.failure.message).toBe('Blocked by overlay.')
        }
    })
})
