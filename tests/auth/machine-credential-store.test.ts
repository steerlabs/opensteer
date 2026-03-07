import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeychainStore } from '../../src/auth/keychain-store.js'

const createKeychainStoreMock = vi.fn<() => KeychainStore | null>()

vi.mock('../../src/auth/keychain-store.js', () => ({
    createKeychainStore: () => createKeychainStoreMock(),
}))

import { MachineCredentialStore } from '../../src/auth/machine-credential-store.js'

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform'
)
const tempRoots: string[] = []

function setProcessPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value,
    })
}

function createStoreRoot(): string {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'opensteer-machine-store-')
    )
    tempRoots.push(root)
    return root
}

function createTestStore(root = createStoreRoot()): MachineCredentialStore {
    setProcessPlatform('linux')
    createKeychainStoreMock.mockReturnValue(null)
    return new MachineCredentialStore({
        env: {
            XDG_CONFIG_HOME: root,
        },
    })
}

function resolveAuthDir(root: string): string {
    return path.join(root, 'opensteer', 'auth')
}

afterEach(() => {
    createKeychainStoreMock.mockReset()
    if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor)
    }
    while (tempRoots.length > 0) {
        const root = tempRoots.pop()
        if (root) {
            fs.rmSync(root, { recursive: true, force: true })
        }
    }
})

describe('machine-credential-store', () => {
    it('normalizes trailing slashes in persisted cloud targets and credentials', () => {
        const store = createTestStore()

        store.writeActiveCloudTarget({
            baseUrl: 'http://localhost:8080///',
            siteUrl: 'http://localhost:3001////',
        })
        store.writeCloudCredential({
            baseUrl: 'https://api.opensteer.com///',
            siteUrl: 'https://opensteer.com////',
            scope: ['cloud:browser'],
            accessToken: 'ost_prod_access',
            refreshToken: 'ost_prod_refresh',
            obtainedAt: 1,
            expiresAt: 2,
        })

        expect(store.readActiveCloudTarget()).toEqual({
            baseUrl: 'http://localhost:8080',
            siteUrl: 'http://localhost:3001',
        })
        expect(
            store.readCloudCredential({
                baseUrl: 'https://api.opensteer.com',
                siteUrl: 'https://opensteer.com',
            })
        ).toEqual(
            expect.objectContaining({
                baseUrl: 'https://api.opensteer.com',
                siteUrl: 'https://opensteer.com',
            })
        )
    })

    it('persists the active cloud target separately from credentials', () => {
        const store = createTestStore()

        expect(store.readActiveCloudTarget()).toBeNull()

        store.writeActiveCloudTarget({
            baseUrl: 'http://localhost:8080',
            siteUrl: 'http://localhost:3001',
        })

        expect(store.readActiveCloudTarget()).toEqual({
            baseUrl: 'http://localhost:8080',
            siteUrl: 'http://localhost:3001',
        })
    })

    it('stores and clears credentials independently for each cloud host', () => {
        const store = createTestStore()
        const prodCredential = {
            baseUrl: 'https://api.opensteer.com',
            siteUrl: 'https://opensteer.com',
            scope: ['cloud:browser'],
            accessToken: 'ost_prod_access',
            refreshToken: 'ost_prod_refresh',
            obtainedAt: 1,
            expiresAt: 2,
        }
        const stagingCredential = {
            baseUrl: 'https://api.staging.example',
            siteUrl: 'https://staging.example',
            scope: ['cloud:browser'],
            accessToken: 'ost_stage_access',
            refreshToken: 'ost_stage_refresh',
            obtainedAt: 3,
            expiresAt: 4,
        }

        store.writeCloudCredential(prodCredential)
        store.writeCloudCredential(stagingCredential)

        expect(
            store.readCloudCredential({
                baseUrl: prodCredential.baseUrl,
                siteUrl: prodCredential.siteUrl,
            })
        ).toEqual(prodCredential)
        expect(
            store.readCloudCredential({
                baseUrl: stagingCredential.baseUrl,
                siteUrl: stagingCredential.siteUrl,
            })
        ).toEqual(stagingCredential)

        store.clearCloudCredential({
            baseUrl: stagingCredential.baseUrl,
            siteUrl: stagingCredential.siteUrl,
        })

        expect(
            store.readCloudCredential({
                baseUrl: prodCredential.baseUrl,
                siteUrl: prodCredential.siteUrl,
            })
        ).toEqual(prodCredential)
        expect(
            store.readCloudCredential({
                baseUrl: stagingCredential.baseUrl,
                siteUrl: stagingCredential.siteUrl,
            })
        ).toBeNull()
    })

    it('migrates a legacy single-slot credential into the host-scoped layout', () => {
        const root = createStoreRoot()
        const authDir = resolveAuthDir(root)
        const legacyMetadataPath = path.join(authDir, 'cli-login.json')
        const legacySecretPath = path.join(authDir, 'cli-login.secret.json')
        fs.mkdirSync(authDir, { recursive: true })
        fs.writeFileSync(
            legacyMetadataPath,
            JSON.stringify(
                {
                    version: 1,
                    secretBackend: 'file',
                    baseUrl: 'https://api.opensteer.com',
                    siteUrl: 'https://opensteer.com',
                    scope: ['cloud:browser'],
                    obtainedAt: 11,
                    expiresAt: 22,
                    updatedAt: 33,
                },
                null,
                2
            ),
            'utf8'
        )
        fs.writeFileSync(
            legacySecretPath,
            JSON.stringify(
                {
                    accessToken: 'ost_legacy_access',
                    refreshToken: 'ost_legacy_refresh',
                },
                null,
                2
            ),
            'utf8'
        )

        const store = createTestStore(root)
        const credential = store.readCloudCredential({
            baseUrl: 'https://api.opensteer.com',
            siteUrl: 'https://opensteer.com',
        })

        expect(credential).toEqual({
            baseUrl: 'https://api.opensteer.com',
            siteUrl: 'https://opensteer.com',
            scope: ['cloud:browser'],
            accessToken: 'ost_legacy_access',
            refreshToken: 'ost_legacy_refresh',
            obtainedAt: 11,
            expiresAt: 22,
        })
        expect(fs.existsSync(legacyMetadataPath)).toBe(false)
        expect(fs.existsSync(legacySecretPath)).toBe(false)

        const authFiles = fs.readdirSync(authDir).sort()
        expect(authFiles).toHaveLength(2)
        expect(authFiles[0]).toMatch(/^cli-login\.[a-f0-9]{24}\.json$/)
        expect(authFiles[1]).toMatch(/^cli-login\.[a-f0-9]{24}\.secret\.json$/)
    })
})
