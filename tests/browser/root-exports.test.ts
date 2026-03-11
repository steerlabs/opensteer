import { describe, expect, it } from 'vitest'
import {
    BrowserPool,
    createIsolatedRuntimeProfile,
    clearPersistentProfileSingletons,
    detectChromePaths,
    getOrCreatePersistentProfile,
} from '../../src/index.js'

describe('root browser exports', () => {
    it('re-exports browser helpers from the package root', () => {
        expect(BrowserPool).toBeTypeOf('function')
        expect(detectChromePaths).toBeTypeOf('function')
        expect(getOrCreatePersistentProfile).toBeTypeOf('function')
        expect(createIsolatedRuntimeProfile).toBeTypeOf('function')
        expect(clearPersistentProfileSingletons).toBeTypeOf('function')
    })
})
