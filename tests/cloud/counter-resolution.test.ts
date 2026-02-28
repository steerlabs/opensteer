import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { Opensteer } from '../../src/opensteer.js'
import type { ElementPath } from '../../src/element-path/types.js'

interface OpensteerPrivateAccess {
    resolvePath(
        action: string,
        options: {
            description?: string
            element?: number
            selector?: string
        },
        allowMissing?: boolean
    ): Promise<{
        path: ElementPath | null
        counter: number | null
        shouldPersist: boolean
        source: 'stored' | 'element' | 'selector' | 'ai' | 'none'
    }>
    resolvePathWithAi(
        action: string,
        description: string
    ): Promise<{ path?: ElementPath; counter?: number } | null>
}

describe('counter resolution fallback', () => {
    it('keeps counter targets when AI returns a counter', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-counter-ai-'))
        const opensteer = new Opensteer({
            storage: { rootDir: root },
        })
        const access = opensteer as unknown as OpensteerPrivateAccess

        vi.spyOn(access, 'resolvePathWithAi').mockResolvedValue({
            counter: 42,
        })

        const result = await access.resolvePath('click', {
            description: 'submit button',
        })

        expect(result).toEqual(
            expect.objectContaining({
                path: null,
                counter: 42,
                source: 'ai',
            })
        )
    })

    it('keeps counter targets when element option is provided', async () => {
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), 'opensteer-counter-element-')
        )
        const opensteer = new Opensteer({
            storage: { rootDir: root },
        })
        const access = opensteer as unknown as OpensteerPrivateAccess

        const result = await access.resolvePath('click', {
            element: 7,
        })

        expect(result).toEqual(
            expect.objectContaining({
                path: null,
                counter: 7,
                source: 'element',
            })
        )
    })
})
