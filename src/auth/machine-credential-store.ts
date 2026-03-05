import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createKeychainStore } from './keychain-store.js'

const METADATA_VERSION = 1
const KEYCHAIN_SERVICE = 'com.opensteer.cli.cloud'
const KEYCHAIN_ACCOUNT = 'machine'

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
    private readonly metadataPath: string
    private readonly fallbackSecretPath: string
    private readonly warn: (warning: MachineCredentialStoreWarning) => void
    private readonly keychain = createKeychainStore()
    private warnedFallback = false

    constructor(options: MachineCredentialStoreOptions = {}) {
        const appName = options.appName || 'opensteer'
        const env = options.env ?? process.env
        const configDir = resolveConfigDir(appName, env)
        const authDir = path.join(configDir, 'auth')
        this.metadataPath = path.join(authDir, 'cli-login.json')
        this.fallbackSecretPath = path.join(authDir, 'cli-login.secret.json')
        this.warn = options.warn ?? (() => undefined)
    }

    readCloudCredential(): StoredMachineCloudCredential | null {
        const metadata = readMetadata(this.metadataPath)
        if (!metadata) {
            return null
        }

        const secret = this.readSecret(metadata.secretBackend)
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

    writeCloudCredential(args: WriteMachineCloudCredentialArgs): void {
        const accessToken = args.accessToken.trim()
        const refreshToken = args.refreshToken.trim()
        if (!accessToken || !refreshToken) {
            throw new Error('Cannot persist empty machine credential secrets.')
        }

        ensureDirectory(path.dirname(this.metadataPath))

        const secretPayload: CloudCredentialSecretPayload = {
            accessToken,
            refreshToken,
        }

        let secretBackend: MachineCredentialMetadata['secretBackend'] = 'file'
        if (this.keychain) {
            try {
                this.keychain.set(
                    KEYCHAIN_SERVICE,
                    KEYCHAIN_ACCOUNT,
                    JSON.stringify(secretPayload)
                )
                secretBackend = 'keychain'
                removeFileIfExists(this.fallbackSecretPath)
            } catch {
                this.writeFallbackSecret(secretPayload)
                secretBackend = 'file'
            }
        } else {
            this.writeFallbackSecret(secretPayload)
        }

        const metadata: MachineCredentialMetadata = {
            version: METADATA_VERSION,
            secretBackend,
            baseUrl: args.baseUrl.trim(),
            siteUrl: args.siteUrl.trim(),
            scope: args.scope,
            obtainedAt: args.obtainedAt,
            expiresAt: args.expiresAt,
            updatedAt: Date.now(),
        }

        writeJsonFile(this.metadataPath, metadata)
    }

    clearCloudCredential(): void {
        removeFileIfExists(this.metadataPath)
        removeFileIfExists(this.fallbackSecretPath)

        if (this.keychain) {
            this.keychain.delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        }
    }

    private readSecret(
        backend: MachineCredentialMetadata['secretBackend']
    ): CloudCredentialSecretPayload | null {
        if (backend === 'keychain' && this.keychain) {
            try {
                const secret = this.keychain.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
                if (!secret) return null
                return parseSecretPayload(secret)
            } catch {
                return null
            }
        }

        return readSecretFile(this.fallbackSecretPath)
    }

    private writeFallbackSecret(secretPayload: CloudCredentialSecretPayload): void {
        writeJsonFile(this.fallbackSecretPath, secretPayload, {
            mode: 0o600,
        })
        if (!this.warnedFallback) {
            this.warn({
                code: 'fallback_file_store',
                path: this.fallbackSecretPath,
                message:
                    'Secure keychain is unavailable. Falling back to file-based credential storage with mode 0600.',
            })
            this.warnedFallback = true
        }
    }
}

export function createMachineCredentialStore(
    options: MachineCredentialStoreOptions = {}
): MachineCredentialStore {
    return new MachineCredentialStore(options)
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
