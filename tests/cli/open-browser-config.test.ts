import { describe, expect, it } from 'vitest'

import { resolveCliBrowserRequestConfig } from '../../src/cli/open-browser-config.js'

describe('CLI browser request config', () => {
    it('preserves browser mode as unset when the request does not specify browser settings', () => {
        expect(resolveCliBrowserRequestConfig({})).toEqual({
            mode: undefined,
            headless: undefined,
            cdpUrl: undefined,
            profileDirectory: undefined,
            userDataDir: undefined,
            executablePath: undefined,
        })
    })

    it('infers real-browser mode from real-only CLI flags', () => {
        expect(
            resolveCliBrowserRequestConfig({
                userDataDir: '/tmp/profile',
            })
        ).toEqual({
            mode: 'real',
            headless: true,
            cdpUrl: undefined,
            profileDirectory: undefined,
            userDataDir: '/tmp/profile',
            executablePath: undefined,
        })
    })

    it('preserves explicit browser selections', () => {
        expect(
            resolveCliBrowserRequestConfig({
                browser: 'chromium',
                headless: false,
            })
        ).toEqual({
            mode: 'chromium',
            headless: false,
            cdpUrl: undefined,
            profileDirectory: undefined,
            userDataDir: undefined,
            executablePath: undefined,
        })
    })
})
