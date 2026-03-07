import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createKeychainStore } from './keychain-store.js'
import { stripTrailingSlashes } from '../utils/strip-trailing-slashes.js'

const METADATA_VERSION = 1
const ACTIVE_TARGET_VERSION = 1
const KEYCHAIN_SERVICE = 'com.opensteer.cli.cloud'
const KEYCHAIN_ACCOUNT_PREFIX = 'machine:'
const LEGACY_KEYCHAIN_ACCOUNT = 'machine'
const LEGACY_METADATA_FILE_NAME = 'cli-login.json'
const LEGACY_FALLBACK_SECRET_FILE_NAME = 'cli-login.secret.json'
const ACTIVE_TARGET_FILE_NAME = 'cli-target.json'

interface MachineCredentialMetadata {
    version: number
    secretBackend: 'keychain' | 'file'
    baseUrl: string
    siteUrl: string
    scope: string[]
    obtainedAt: number
    expiresAt: number
    updatedAt: number
}

interface CloudCredentialSecretPayload {
    accessToken: string
    refreshToken: string
}

interface ActiveCloudTargetMetadata {
    version: number
    baseUrl: string
    siteUrl: string
    updatedAt: number
}

export interface StoredMachineCloudCredential {
    baseUrl: string
    siteUrl: string
    scope: string[]
    accessToken: string
    refreshToken: string
    obtainedAt: number
    expiresAt: number
}

export interface WriteMachineCloudCredentialArgs {
    baseUrl: string
    siteUrl: string
    scope: string[]
    accessToken: string
    refreshToken: string
    obtainedAt: number
    expiresAt: number
}

export interface CloudCredentialStoreTarget {
    baseUrl: string
    siteUrl: string
}

export interface MachineCredentialStoreWarning {
    code: 'fallback_file_store'
    path: string
    message: string
}

export interface MachineCredentialStoreOptions {
    appName?: string
    env?: Record<string, string | undefined>
    warn?: (warning: MachineCredentialStoreWarning) => void
}

export class MachineCredentialStore {
    private readonly authDir: string
    private readonly warn: (warning: MachineCredentialStoreWarning) => void
    private readonly keychain = createKeychainStore()
    private warnedFallback = false

    constructor(options: MachineCredentialStoreOptions = {}) {
        const appName = options.appName || 'opensteer'
        const env = options.env ?? process.env
        const configDir = resolveConfigDir(appName, env)
        this.authDir = path.join(configDir, 'auth')
        this.warn = options.warn ?? (() => undefined)
    }

    readCloudCredential(
        target: CloudCredentialStoreTarget
    ): StoredMachineCloudCredential | null {
        const slot = resolveCredentialSlot(this.authDir, target)
        return (
            this.readCredentialSlot(slot, target) ??
            this.readAndMigrateLegacyCredential(target)
        )
    }

    writeCloudCredential(args: WriteMachineCloudCredentialArgs): void {
        const accessToken = args.accessToken.trim()
        const refreshToken = args.refreshToken.trim()
        if (!accessToken || !refreshToken) {
            throw new Error('Cannot persist empty machine credential secrets.')
        }

        const baseUrl = normalizeCredentialUrl(args.baseUrl, 'baseUrl')
        const siteUrl = normalizeCredentialUrl(args.siteUrl, 'siteUrl')
        const slot = resolveCredentialSlot(this.authDir, {
            baseUrl,
            siteUrl,
        })
        ensureDirectory(this.authDir)

        const secretPayload: CloudCredentialSecretPayload = {
            accessToken,
            refreshToken,
        }

        let secretBackend: MachineCredentialMetadata['secretBackend'] = 'file'
        if (this.keychain) {
            try {
                this.keychain.set(
                    KEYCHAIN_SERVICE,
                    slot.keychainAccount,
                    JSON.stringify(secretPayload)
                )
                secretBackend = 'keychain'
                removeFileIfExists(slot.fallbackSecretPath)
            } catch {
                this.writeFallbackSecret(slot, secretPayload)
                secretBackend = 'file'
            }
        } else {
            this.writeFallbackSecret(slot, secretPayload)
        }

        const metadata: MachineCredentialMetadata = {
            version: METADATA_VERSION,
            secretBackend,
            baseUrl,
            siteUrl,
            scope: args.scope,
            obtainedAt: args.obtainedAt,
            expiresAt: args.expiresAt,
            updatedAt: Date.now(),
        }

        writeJsonFile(slot.metadataPath, metadata)
    }

    readActiveCloudTarget(): CloudCredentialStoreTarget | null {
        return readActiveCloudTargetMetadata(resolveActiveTargetPath(this.authDir))
    }

    writeActiveCloudTarget(target: CloudCredentialStoreTarget): void {
        const baseUrl = normalizeCredentialUrl(target.baseUrl, 'baseUrl')
        const siteUrl = normalizeCredentialUrl(target.siteUrl, 'siteUrl')
        ensureDirectory(this.authDir)
        writeJsonFile(resolveActiveTargetPath(this.authDir), {
            version: ACTIVE_TARGET_VERSION,
            baseUrl,
            siteUrl,
            updatedAt: Date.now(),
        } satisfies ActiveCloudTargetMetadata)
    }

    clearCloudCredential(target: CloudCredentialStoreTarget): void {
        this.clearCredentialSlot(resolveCredentialSlot(this.authDir, target))

        const legacySlot = resolveLegacyCredentialSlot(this.authDir)
        const legacyMetadata = readMetadata(legacySlot.metadataPath)
        if (legacyMetadata && matchesCredentialTarget(legacyMetadata, target)) {
            this.clearCredentialSlot(legacySlot)
        }
    }

    private readCredentialSlot(
        slot: ResolvedCredentialSlot,
        target?: CloudCredentialStoreTarget
    ): StoredMachineCloudCredential | null {
        const metadata = readMetadata(slot.metadataPath)
        if (!metadata) {
            return null
        }
        if (target && !matchesCredentialTarget(metadata, target)) {
            return null
        }

        const secret = this.readSecret(slot, metadata.secretBackend)
        if (!secret) {
            return null
        }

        return {
            baseUrl: metadata.baseUrl,
            siteUrl: metadata.siteUrl,
            scope: metadata.scope,
            accessToken: secret.accessToken,
            refreshToken: secret.refreshToken,
            obtainedAt: metadata.obtainedAt,
            expiresAt: metadata.expiresAt,
        }
    }

    private readAndMigrateLegacyCredential(
        target: CloudCredentialStoreTarget
    ): StoredMachineCloudCredential | null {
        const legacySlot = resolveLegacyCredentialSlot(this.authDir)
        const legacyCredential = this.readCredentialSlot(legacySlot, target)
        if (!legacyCredential) {
            return null
        }

        this.writeCloudCredential(legacyCredential)
        this.clearCredentialSlot(legacySlot)
        return legacyCredential
    }

    private readSecret(
        slot: ResolvedCredentialSlot,
        backend: MachineCredentialMetadata['secretBackend']
    ): CloudCredentialSecretPayload | null {
        if (backend === 'keychain' && this.keychain) {
            try {
                const secret = this.keychain.get(
                    KEYCHAIN_SERVICE,
                    slot.keychainAccount
                )
                if (!secret) return null
                return parseSecretPayload(secret)
            } catch {
                return null
            }
        }

        return readSecretFile(slot.fallbackSecretPath)
    }

    private writeFallbackSecret(
        slot: ResolvedCredentialSlot,
        secretPayload: CloudCredentialSecretPayload
    ): void {
        writeJsonFile(slot.fallbackSecretPath, secretPayload, {
            mode: 0o600,
        })
        if (!this.warnedFallback) {
            this.warn({
                code: 'fallback_file_store',
                path: slot.fallbackSecretPath,
                message:
                    'Secure keychain is unavailable. Falling back to file-based credential storage with mode 0600.',
            })
            this.warnedFallback = true
        }
    }

    private clearCredentialSlot(slot: ResolvedCredentialSlot): void {
        removeFileIfExists(slot.metadataPath)
        removeFileIfExists(slot.fallbackSecretPath)

        if (this.keychain) {
            this.keychain.delete(KEYCHAIN_SERVICE, slot.keychainAccount)
        }
    }
}

export function createMachineCredentialStore(
    options: MachineCredentialStoreOptions = {}
): MachineCredentialStore {
    return new MachineCredentialStore(options)
}

interface ResolvedCredentialSlot {
    keychainAccount: string
    metadataPath: string
    fallbackSecretPath: string
}

function resolveCredentialSlot(
    authDir: string,
    target: CloudCredentialStoreTarget
): ResolvedCredentialSlot {
    const normalizedBaseUrl = normalizeCredentialUrl(target.baseUrl, 'baseUrl')
    const normalizedSiteUrl = normalizeCredentialUrl(target.siteUrl, 'siteUrl')
    const storageKey = createHash('sha256')
        .update(`${normalizedBaseUrl}\u0000${normalizedSiteUrl}`)
        .digest('hex')
        .slice(0, 24)

    return {
        keychainAccount: `${KEYCHAIN_ACCOUNT_PREFIX}${storageKey}`,
        metadataPath: path.join(authDir, `cli-login.${storageKey}.json`),
        fallbackSecretPath: path.join(
            authDir,
            `cli-login.${storageKey}.secret.json`
        ),
    }
}

function resolveLegacyCredentialSlot(authDir: string): ResolvedCredentialSlot {
    return {
        keychainAccount: LEGACY_KEYCHAIN_ACCOUNT,
        metadataPath: path.join(authDir, LEGACY_METADATA_FILE_NAME),
        fallbackSecretPath: path.join(authDir, LEGACY_FALLBACK_SECRET_FILE_NAME),
    }
}

function resolveActiveTargetPath(authDir: string): string {
    return path.join(authDir, ACTIVE_TARGET_FILE_NAME)
}

function matchesCredentialTarget(
    value: Pick<StoredMachineCloudCredential, 'baseUrl' | 'siteUrl'>,
    target: CloudCredentialStoreTarget
): boolean {
    return (
        normalizeCredentialUrl(value.baseUrl, 'baseUrl') ===
            normalizeCredentialUrl(target.baseUrl, 'baseUrl') &&
        normalizeCredentialUrl(value.siteUrl, 'siteUrl') ===
            normalizeCredentialUrl(target.siteUrl, 'siteUrl')
    )
}

function normalizeCredentialUrl(value: string, field: 'baseUrl' | 'siteUrl'): string {
    const normalized = stripTrailingSlashes(value.trim())
    if (!normalized) {
        throw new Error(`Cannot persist machine credential without ${field}.`)
    }
    return normalized
}

function resolveConfigDir(
    appName: string,
    env: Record<string, string | undefined>
): string {
    if (process.platform === 'win32') {
        const appData =
            env.APPDATA?.trim() ||
            path.join(os.homedir(), 'AppData', 'Roaming')
        return path.join(appData, appName)
    }

    if (process.platform === 'darwin') {
        return path.join(
            os.homedir(),
            'Library',
            'Application Support',
            appName
        )
    }

    const xdgConfigHome =
        env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config')
    return path.join(xdgConfigHome, appName)
}

function ensureDirectory(directoryPath: string): void {
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 })
}

function removeFileIfExists(filePath: string): void {
    try {
        fs.rmSync(filePath, { force: true })
    } catch {
        return
    }
}

function readMetadata(filePath: string): MachineCredentialMetadata | null {
    if (!fs.existsSync(filePath)) {
        return null
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf8')
        const parsed = JSON.parse(raw) as Partial<MachineCredentialMetadata>
        if (parsed.version !== METADATA_VERSION) return null
        if (parsed.secretBackend !== 'keychain' && parsed.secretBackend !== 'file') {
            return null
        }
        if (typeof parsed.baseUrl !== 'string' || !parsed.baseUrl.trim()) return null
        if (typeof parsed.siteUrl !== 'string' || !parsed.siteUrl.trim()) return null
        if (!Array.isArray(parsed.scope)) return null
        if (typeof parsed.obtainedAt !== 'number') return null
        if (typeof parsed.expiresAt !== 'number') return null
        if (typeof parsed.updatedAt !== 'number') return null

        return {
            version: parsed.version,
            secretBackend: parsed.secretBackend,
            baseUrl: parsed.baseUrl,
            siteUrl: parsed.siteUrl,
            scope: parsed.scope.filter((value): value is string =>
                typeof value === 'string'
            ),
            obtainedAt: parsed.obtainedAt,
            expiresAt: parsed.expiresAt,
            updatedAt: parsed.updatedAt,
        }
    } catch {
        return null
    }
}

function readActiveCloudTargetMetadata(
    filePath: string
): CloudCredentialStoreTarget | null {
    if (!fs.existsSync(filePath)) {
        return null
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf8')
        const parsed = JSON.parse(raw) as Partial<ActiveCloudTargetMetadata>
        if (parsed.version !== ACTIVE_TARGET_VERSION) {
            return null
        }
        if (typeof parsed.baseUrl !== 'string' || !parsed.baseUrl.trim()) {
            return null
        }
        if (typeof parsed.siteUrl !== 'string' || !parsed.siteUrl.trim()) {
            return null
        }

        return {
            baseUrl: parsed.baseUrl,
            siteUrl: parsed.siteUrl,
        }
    } catch {
        return null
    }
}

function parseSecretPayload(raw: string): CloudCredentialSecretPayload | null {
    try {
        const parsed = JSON.parse(raw) as Partial<CloudCredentialSecretPayload>
        if (
            typeof parsed.accessToken !== 'string' ||
            !parsed.accessToken.trim() ||
            typeof parsed.refreshToken !== 'string' ||
            !parsed.refreshToken.trim()
        ) {
            return null
        }

        return {
            accessToken: parsed.accessToken,
            refreshToken: parsed.refreshToken,
        }
    } catch {
        return null
    }
}

function readSecretFile(filePath: string): CloudCredentialSecretPayload | null {
    if (!fs.existsSync(filePath)) {
        return null
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf8')
        return parseSecretPayload(raw)
    } catch {
        return null
    }
}

function writeJsonFile(
    filePath: string,
    payload: unknown,
    options: { mode?: number } = {}
): void {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), {
        encoding: 'utf8',
        mode: options.mode ?? 0o600,
    })
    if (typeof options.mode === 'number') {
        fs.chmodSync(filePath, options.mode)
    }
}
