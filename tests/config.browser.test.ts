import { describe, expect, it } from 'vitest'

import { resolveConfigWithEnv } from '../src/config.js'

describe('browser config compatibility', () => {
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
})
