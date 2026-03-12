import { describe, expect, it } from 'vitest'
import { getOwnedRealBrowserProcessPolicy } from '../../src/browser/pool.js'

describe('owned real browser process policy', () => {
    it('keeps macOS real-browser launches in the login session', () => {
        expect(getOwnedRealBrowserProcessPolicy('darwin')).toEqual({
            detached: false,
            killStrategy: 'process',
            shouldUnref: true,
        })
    })

    it('keeps Linux real-browser launches in a dedicated process group', () => {
        expect(getOwnedRealBrowserProcessPolicy('linux')).toEqual({
            detached: true,
            killStrategy: 'process-group',
            shouldUnref: true,
        })
    })

    it('uses taskkill cleanup on Windows', () => {
        expect(getOwnedRealBrowserProcessPolicy('win32')).toEqual({
            detached: false,
            killStrategy: 'taskkill',
            shouldUnref: true,
        })
    })
})
