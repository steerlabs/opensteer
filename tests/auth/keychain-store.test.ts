import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpawnSyncReturns } from 'node:child_process'

const spawnSyncMock = vi.fn()

vi.mock('node:child_process', () => ({
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}))

import { createKeychainStore } from '../../src/auth/keychain-store.js'

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform'
)

function setProcessPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value,
    })
}

function result(partial: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
    return {
        pid: 1,
        output: [],
        stdout: '',
        stderr: '',
        status: 0,
        signal: null,
        ...partial,
    }
}

afterEach(() => {
    spawnSyncMock.mockReset()
    if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor)
    }
})

describe('keychain-store', () => {
    it('redacts secrets from macOS security command errors', () => {
        setProcessPlatform('darwin')

        spawnSyncMock.mockImplementation(
            (command: string, args?: string[] | undefined) => {
                if (command === 'security' && args?.[0] === '--help') {
                    return result({})
                }
                if (command === 'security' && args?.[0] === 'add-generic-password') {
                    return result({
                        status: 1,
                        stderr: 'security failed',
                    })
                }
                return result({})
            }
        )

        const store = createKeychainStore()
        expect(store).not.toBeNull()
        expect(store?.backend).toBe('macos-security')

        const secret = 'ost_secret_abc123'
        try {
            store?.set('com.opensteer.cli.cloud', 'machine', secret)
            throw new Error('Expected keychain set to fail.')
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            expect(message).toContain('Unable to persist credential via security.')
            expect(message).toContain('[REDACTED]')
            expect(message).not.toContain(secret)
        }
    })
})
