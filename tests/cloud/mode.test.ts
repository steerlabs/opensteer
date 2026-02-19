import { afterEach, describe, expect, it } from 'vitest'
import { Opensteer } from '../../src/opensteer.js'

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

    it('rejects Opensteer.from(page) in cloud mode v1', () => {
        expect(() =>
            Opensteer.from({} as never, {
                cloud: {
                    enabled: true,
                    key: 'osk_test_123',
                },
            })
        ).toThrow('Opensteer.from(page) is not supported in cloud mode v1.')
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
            'uploadFile() is not supported in cloud mode v1 because file paths must be accessible on the remote server.'
        )

        await expect(
            ov.exportCookies('/tmp/cookies.json')
        ).rejects.toThrow(
            'exportCookies() is not supported in cloud mode v1 because it depends on local filesystem paths.'
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
})
