import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { LocalSelectorStorage } from '../../src/storage/local.js'

describe('LocalSelectorStorage', () => {
    it('builds deterministic paths and sanitizes file names', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-storage-paths-'))
        const storage = new LocalSelectorStorage(root, 'demo-suite')

        expect(storage.getSelectorFileName('my selector:id')).toBe(
            'my_selector_id.json'
        )
        expect(storage.getNamespaceDir()).toContain(
            path.join('.opensteer', 'selectors', 'demo-suite')
        )
    })

    it('normalizes namespace hierarchy and blocks traversal escapes', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-storage-ns-'))

        const nested = new LocalSelectorStorage(root, 'suite-a/run-1')
        expect(nested.getNamespace()).toBe('suite-a/run-1')
        expect(nested.getNamespaceDir()).toContain(
            path.join('.opensteer', 'selectors', 'suite-a', 'run-1')
        )

        const escaped = new LocalSelectorStorage(root, '../../escape')
        expect(escaped.getNamespace()).toBe('escape')
        expect(escaped.getNamespaceDir()).toContain(
            path.join('.opensteer', 'selectors', 'escape')
        )
    })

    it('writes and reads selectors', () => {
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), 'ov-storage-selector-')
        )
        const storage = new LocalSelectorStorage(root, 'demo-suite')

        storage.writeSelector({
            id: 'submit-btn',
            method: 'click',
            description: 'Submit button path',
            path: {
                context: [],
                nodes: [
                    {
                        tag: 'button',
                        attrs: { id: 'submit-btn' },
                        position: {
                            nthChild: 1,
                            nthOfType: 1,
                        },
                        match: [{ kind: 'attr', key: 'id', op: 'exact' }],
                    },
                ],
            },
            metadata: { createdAt: Date.now() },
        })

        const read = storage.readSelector('submit-btn')
        expect(read?.id).toBe('submit-btn')
        expect(read?.method).toBe('click')
        expect(
            (
                read?.path as {
                    nodes: Array<{ tag: string }>
                }
            ).nodes[0]?.tag
        ).toBe('button')
    })

    it('loads/saves registry and recovers from malformed files', () => {
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), 'ov-storage-registry-')
        )
        const storage = new LocalSelectorStorage(root, 'demo-suite')

        const registry = storage.loadRegistry()
        expect(registry.name).toBe('demo-suite')
        expect(registry.selectors).toEqual({})

        registry.selectors['submit-btn'] = {
            file: 'submit-btn.json',
            method: 'click',
            createdAt: Date.now(),
        }
        storage.saveRegistry(registry)

        const loaded = storage.loadRegistry()
        expect(Object.keys(loaded.selectors)).toContain('submit-btn')

        fs.writeFileSync(storage.getRegistryPath(), '{bad json', 'utf8')
        const recovered = storage.loadRegistry()
        expect(recovered.selectors).toEqual({})
    })

    it('clears all selector files in the namespace', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-storage-clear-'))
        const storage = new LocalSelectorStorage(root, 'demo-suite')

        storage.writeSelector({
            id: 'to-clear',
            method: 'click',
            description: 'Temporary path',
            path: {
                context: [],
                nodes: [
                    {
                        tag: 'button',
                        attrs: { id: 'to-clear' },
                        position: {
                            nthChild: 1,
                            nthOfType: 1,
                        },
                        match: [{ kind: 'attr', key: 'id', op: 'exact' }],
                    },
                ],
            },
            metadata: { createdAt: Date.now() },
        })

        expect(fs.existsSync(storage.getNamespaceDir())).toBe(true)
        storage.clearNamespace()
        expect(fs.existsSync(storage.getNamespaceDir())).toBe(false)
    })
})
