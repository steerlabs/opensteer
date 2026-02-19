import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { collectLocalSelectorCacheEntries } from '../../src/cloud/local-cache-sync.js'
import { LocalSelectorStorage } from '../../src/storage/local.js'

describe('collectLocalSelectorCacheEntries', () => {
    it('collects valid entries and normalizes method and origin', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-cloud-sync-'))
        const storage = new LocalSelectorStorage(root, 'cloud-suite')

        storage.writeSelector({
            id: 'abcdef0123456789',
            method: 'getElementText',
            description: 'Price label',
            path: { context: [], nodes: [] },
            metadata: {
                createdAt: 1000,
                updatedAt: 2000,
                sourceUrl: 'https://shop.example.com/p/1?ref=home',
            },
        })

        storage.writeSelector({
            id: '0123456789abcdef',
            method: 'rightclick',
            description: 'Menu button',
            path: { context: [], nodes: [] },
            metadata: {
                createdAt: 3000,
                updatedAt: 4000,
                sourceUrl: 'https://shop.example.com/p/2',
            },
        })

        const entries = collectLocalSelectorCacheEntries(storage)

        expect(entries).toHaveLength(2)
        expect(entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    namespace: 'cloud-suite',
                    descriptionHash: 'abcdef0123456789',
                    method: 'getElementText',
                    siteOrigin: 'https://shop.example.com',
                    createdAt: 1000,
                    updatedAt: 2000,
                }),
                expect.objectContaining({
                    descriptionHash: '0123456789abcdef',
                    method: 'click',
                }),
            ])
        )
    })

    it('skips invalid entries and keeps newest duplicate', () => {
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), 'ov-cloud-sync-dedupe-')
        )
        const storage = new LocalSelectorStorage(root, 'cloud-suite')

        storage.writeSelector({
            id: 'fedcba9876543210',
            method: 'click',
            description: 'Checkout',
            path: { old: true },
            metadata: {
                createdAt: 1000,
                updatedAt: 1500,
                sourceUrl: 'https://example.com/cart',
            },
        })

        fs.writeFileSync(
            path.join(storage.getNamespaceDir(), 'duplicate.json'),
            JSON.stringify({
                id: 'fedcba9876543210',
                method: 'click',
                description: 'Checkout',
                path: { old: false },
                metadata: {
                    createdAt: 1000,
                    updatedAt: 2500,
                    sourceUrl: 'https://example.com/cart?fresh=1',
                },
            }),
            'utf8'
        )

        storage.writeSelector({
            id: 'not-a-hash',
            method: 'hover',
            description: 'Bad hash',
            path: { context: [], nodes: [] },
            metadata: {
                createdAt: 10,
                updatedAt: 20,
                sourceUrl: 'https://example.com/bad',
            },
        })

        storage.writeSelector({
            id: '0011223344556677',
            method: 'hover',
            description: 'Missing origin',
            path: { context: [], nodes: [] },
            metadata: {
                createdAt: 10,
                updatedAt: 20,
                sourceUrl: 'about:blank',
            },
        })

        const entries = collectLocalSelectorCacheEntries(storage)

        expect(entries).toHaveLength(1)
        expect(entries[0]).toEqual(
            expect.objectContaining({
                descriptionHash: 'fedcba9876543210',
                path: { old: false },
                updatedAt: 2500,
                siteOrigin: 'https://example.com',
            })
        )
    })
})
