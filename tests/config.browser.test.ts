import { describe, expect, it } from 'vitest'

import { resolveConfigWithEnv } from '../src/config.js'

describe('browser config compatibility', () => {
    it('leaves headless unset until the browser mode is known', () => {
        expect(resolveConfigWithEnv({}).config.browser?.headless).toBeUndefined()
    })

    it('rejects removed browser config keys', () => {
        expect(() =>
            resolveConfigWithEnv({
                browser: {
                    connectUrl: 'http://localhost:9222',
                } as never,
            })
        ).toThrow('browser.connectUrl')
    })

    it('rejects removed browser env vars', () => {
        expect(() =>
            resolveConfigWithEnv(
                {},
                {
                    env: {
                        OPENSTEER_CONNECT_URL: 'http://localhost:9222',
                    },
                }
            )
        ).toThrow('OPENSTEER_CONNECT_URL')
    })

    it('defaults real-browser mode to headless when not explicitly configured', () => {
        expect(
            resolveConfigWithEnv({
                browser: {
                    mode: 'real',
                },
            }).config.browser?.headless
        ).toBe(true)
    })

    it('preserves explicit real-browser headless settings', () => {
        expect(
            resolveConfigWithEnv({
                browser: {
                    mode: 'real',
                    headless: false,
                },
            }).config.browser?.headless
        ).toBe(false)
    })
})
