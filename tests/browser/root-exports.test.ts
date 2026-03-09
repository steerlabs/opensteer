import { describe, expect, it } from 'vitest'
import {
    BrowserPool,
    applyStealthScripts,
    clearPersistentProfileSingletons,
    detectChromePaths,
    getOrCreatePersistentProfile,
} from '../../src/index.js'

describe('root browser exports', () => {
    it('re-exports browser helpers from the package root', () => {
        expect(BrowserPool).toBeTypeOf('function')
        expect(detectChromePaths).toBeTypeOf('function')
        expect(getOrCreatePersistentProfile).toBeTypeOf('function')
        expect(clearPersistentProfileSingletons).toBeTypeOf('function')
        expect(applyStealthScripts).toBeTypeOf('function')
    })
})
