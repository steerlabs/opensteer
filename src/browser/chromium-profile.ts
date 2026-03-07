import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import {
    copyFile,
    mkdtemp,
    readdir,
    readFile,
    rm,
} from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Cookie } from 'playwright'
import { createKeychainStore } from '../auth/keychain-store.js'
import { expandHome } from './chrome.js'

const execFileAsync = promisify(execFile)

const CHROMIUM_EPOCH_MICROS = 11_644_473_600_000_000n
const AES_BLOCK_BYTES = 16
const MAC_KEY_ITERATIONS = 1003
const LINUX_KEY_ITERATIONS = 1
const KEY_LENGTH = 16
const KEY_SALT = 'saltysalt'

export interface ChromiumLaunchProfile {
    userDataDir: string
    profileDirectory?: string
}

interface ChromiumProfileLocation extends ChromiumLaunchProfile {
    profileDir: string
    cookieDbPath: string
    localStatePath: string | null
}

interface ChromiumCookieRow {
    host_key: string
    name: string
    value: string
    encrypted_value: string | null
    path: string
    expires_utc: string
    is_secure: number
    is_httponly: number
    has_expires: number
    samesite: number
}

interface ChromiumBrand {
    macService: string
    macAccount: string
    linuxApplications: string[]
}

const DEFAULT_CHROMIUM_BRAND: ChromiumBrand = {
    macService: 'Chrome Safe Storage',
    macAccount: 'Chrome',
    linuxApplications: ['chrome', 'google-chrome'],
}

const CHROMIUM_BRANDS: Array<{ match: string[]; brand: ChromiumBrand }> = [
    {
        match: ['bravesoftware', 'brave-browser'],
        brand: {
            macService: 'Brave Safe Storage',
            macAccount: 'Brave',
            linuxApplications: ['brave-browser', 'brave'],
        },
    },
    {
        match: ['microsoft', 'edge'],
        brand: {
            macService: 'Microsoft Edge Safe Storage',
            macAccount: 'Microsoft Edge',
            linuxApplications: ['microsoft-edge'],
        },
    },
    {
        match: ['google', 'chrome beta'],
        brand: {
            macService: 'Chrome Beta Safe Storage',
            macAccount: 'Chrome Beta',
            linuxApplications: ['chrome-beta'],
        },
    },
    {
        match: ['google', 'chrome'],
        brand: {
            macService: 'Chrome Safe Storage',
            macAccount: 'Chrome',
            linuxApplications: ['chrome', 'google-chrome'],
        },
    },
    {
        match: ['chromium'],
        brand: {
            macService: 'Chromium Safe Storage',
            macAccount: 'Chromium',
            linuxApplications: ['chromium'],
        },
    },
]

function directoryExists(filePath: string): boolean {
    try {
        return statSync(filePath).isDirectory()
    } catch {
        return false
    }
}

function fileExists(filePath: string): boolean {
    try {
        return statSync(filePath).isFile()
    } catch {
        return false
    }
}

function resolveCookieDbPath(profileDir: string): string | null {
    const candidates = [join(profileDir, 'Network', 'Cookies'), join(profileDir, 'Cookies')]
    for (const candidate of candidates) {
        if (fileExists(candidate)) {
            return candidate
        }
    }
    return null
}

async function selectProfileDirFromUserDataDir(
    userDataDir: string
): Promise<string | null> {
    const defaultProfileDir = join(userDataDir, 'Default')
    if (resolveCookieDbPath(defaultProfileDir)) {
        return defaultProfileDir
    }

    const entries = await readdir(userDataDir, {
        withFileTypes: true,
    }).catch(() => [])

    const candidates = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(userDataDir, entry.name))
        .filter((entryPath) => resolveCookieDbPath(entryPath))

    return candidates.length === 1 ? candidates[0] : null
}

async function resolveChromiumProfileLocation(
    inputPath: string
): Promise<ChromiumProfileLocation | null> {
    const expandedPath = expandHome(inputPath.trim())
    if (!expandedPath) {
        return null
    }

    if (fileExists(expandedPath) && basename(expandedPath) === 'Cookies') {
        const directParent = dirname(expandedPath)
        const profileDir =
            basename(directParent) === 'Network' ? dirname(directParent) : directParent
        const userDataDir = dirname(profileDir)
        return {
            userDataDir,
            profileDir,
            profileDirectory: basename(profileDir),
            cookieDbPath: expandedPath,
            localStatePath: fileExists(join(userDataDir, 'Local State'))
                ? join(userDataDir, 'Local State')
                : null,
        }
    }

    if (!directoryExists(expandedPath)) {
        return null
    }

    const directCookieDb = resolveCookieDbPath(expandedPath)
    if (directCookieDb) {
        const userDataDir = dirname(expandedPath)
        return {
            userDataDir,
            profileDir: expandedPath,
            profileDirectory: basename(expandedPath),
            cookieDbPath: directCookieDb,
            localStatePath: fileExists(join(userDataDir, 'Local State'))
                ? join(userDataDir, 'Local State')
                : null,
        }
    }

    const localStatePath = join(expandedPath, 'Local State')
    if (!fileExists(localStatePath)) {
        return null
    }

    const selectedProfileDir = await selectProfileDirFromUserDataDir(expandedPath)
    if (!selectedProfileDir) {
        return null
    }

    const cookieDbPath = resolveCookieDbPath(selectedProfileDir)
    if (!cookieDbPath) {
        return null
    }

    return {
        userDataDir: expandedPath,
        profileDir: selectedProfileDir,
        profileDirectory: basename(selectedProfileDir),
        cookieDbPath,
        localStatePath,
    }
}

export function resolvePersistentChromiumLaunchProfile(
    inputPath: string
): ChromiumLaunchProfile {
    const expandedPath = expandHome(inputPath.trim())
    if (!expandedPath) {
        return {
            userDataDir: inputPath,
        }
    }

    if (fileExists(expandedPath) && basename(expandedPath) === 'Cookies') {
        const directParent = dirname(expandedPath)
        const profileDir =
            basename(directParent) === 'Network' ? dirname(directParent) : directParent
        return {
            userDataDir: dirname(profileDir),
            profileDirectory: basename(profileDir),
        }
    }

    if (
        directoryExists(expandedPath) &&
        resolveCookieDbPath(expandedPath) &&
        fileExists(join(dirname(expandedPath), 'Local State'))
    ) {
        return {
            userDataDir: dirname(expandedPath),
            profileDirectory: basename(expandedPath),
        }
    }

    return {
        userDataDir: expandedPath,
    }
}

function detectChromiumBrand(location: ChromiumProfileLocation): ChromiumBrand {
    const normalizedPath = location.userDataDir.toLowerCase()
    for (const candidate of CHROMIUM_BRANDS) {
        if (candidate.match.every((fragment) => normalizedPath.includes(fragment))) {
            return candidate.brand
        }
    }
    return DEFAULT_CHROMIUM_BRAND
}

async function createSqliteSnapshot(dbPath: string): Promise<{
    snapshotPath: string
    cleanup(): Promise<void>
}> {
    const snapshotDir = await mkdtemp(join(tmpdir(), 'opensteer-cookie-db-'))
    const snapshotPath = join(snapshotDir, 'Cookies')

    await copyFile(dbPath, snapshotPath)

    for (const suffix of ['-wal', '-shm', '-journal']) {
        const source = `${dbPath}${suffix}`
        if (!existsSync(source)) {
            continue
        }
        await copyFile(source, `${snapshotPath}${suffix}`)
    }

    return {
        snapshotPath,
        cleanup: async () => {
            await rm(snapshotDir, { recursive: true, force: true })
        },
    }
}

async function querySqliteJson<T>(dbPath: string, query: string): Promise<T[]> {
    let stdout: string
    try {
        const result = await execFileAsync(
            'sqlite3',
            ['-json', dbPath, query],
            {
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
            }
        )
        stdout = result.stdout
    } catch (error) {
        if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            throw new Error(
                'Local Chromium cookie sync requires the `sqlite3` command-line tool to be installed.'
            )
        }
        throw error
    }

    const trimmed = stdout.trim()
    if (!trimmed) {
        return []
    }

    return JSON.parse(trimmed) as T[]
}

function convertChromiumTimestampToUnixSeconds(value: string): number {
    if (!value || value === '0') {
        return -1
    }

    const micros = BigInt(value)
    if (micros <= CHROMIUM_EPOCH_MICROS) {
        return -1
    }

    return Number((micros - CHROMIUM_EPOCH_MICROS) / 1_000_000n)
}

function mapChromiumSameSite(value: number): Cookie['sameSite'] {
    if (value === 2) {
        return 'Strict'
    }
    if (value === 0) {
        return 'None'
    }
    return 'Lax'
}

function stripChromiumPadding(buffer: Buffer): Buffer {
    const paddingLength = buffer[buffer.length - 1]
    if (paddingLength <= 0 || paddingLength > AES_BLOCK_BYTES) {
        return buffer
    }

    return buffer.subarray(0, buffer.length - paddingLength)
}

function stripDomainHashPrefix(buffer: Buffer, hostKey: string): Buffer {
    if (buffer.length < 32) {
        return buffer
    }

    const domainHash = createHash('sha256').update(hostKey, 'utf8').digest()
    if (buffer.subarray(0, 32).equals(domainHash)) {
        return buffer.subarray(32)
    }

    return buffer
}

function decryptChromiumAes128CbcValue(
    encryptedValue: Buffer,
    key: Buffer,
    hostKey: string
): string {
    const ciphertext =
        encryptedValue.length > 3 &&
        encryptedValue[0] === 0x76 &&
        encryptedValue[1] === 0x31 &&
        (encryptedValue[2] === 0x30 || encryptedValue[2] === 0x31)
            ? encryptedValue.subarray(3)
            : encryptedValue
    const iv = Buffer.alloc(AES_BLOCK_BYTES, ' ')
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ])

    return stripDomainHashPrefix(stripChromiumPadding(plaintext), hostKey).toString(
        'utf8'
    )
}

function decryptChromiumAes256GcmValue(
    encryptedValue: Buffer,
    key: Buffer
): string {
    const nonce = encryptedValue.subarray(3, 15)
    const ciphertext = encryptedValue.subarray(15, encryptedValue.length - 16)
    const authTag = encryptedValue.subarray(encryptedValue.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(authTag)
    return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]).toString('utf8')
}

async function dpapiUnprotect(buffer: Buffer): Promise<Buffer> {
    const script = [
        `$inputBytes = [Convert]::FromBase64String('${buffer.toString('base64')}')`,
        '$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(',
        '  $inputBytes,',
        '  $null,',
        '  [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
        ')',
        '[Convert]::ToBase64String($plainBytes)',
    ].join('\n')

    const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
        }
    )

    return Buffer.from(stdout.trim(), 'base64')
}

async function buildChromiumDecryptor(
    location: ChromiumProfileLocation
): Promise<(row: ChromiumCookieRow) => Promise<string>> {
    if (process.platform === 'darwin') {
        const brand = detectChromiumBrand(location)
        const keychainStore = createKeychainStore()
        const password =
            keychainStore?.get(brand.macService, brand.macAccount) ?? null

        if (!password) {
            throw new Error(
                `Unable to read ${brand.macService} from macOS Keychain.`
            )
        }

        const key = pbkdf2Sync(password, KEY_SALT, MAC_KEY_ITERATIONS, KEY_LENGTH, 'sha1')
        return async (row) =>
            decryptChromiumAes128CbcValue(
                Buffer.from(row.encrypted_value || '', 'hex'),
                key,
                row.host_key
            )
    }

    if (process.platform === 'linux') {
        const brand = detectChromiumBrand(location)
        const keychainStore = createKeychainStore()
        const password =
            keychainStore?.get(brand.macService, brand.macAccount) ??
            brand.linuxApplications
                .map((application) => keychainStore?.get(application, application) ?? null)
                .find(Boolean) ??
            null

        const key = pbkdf2Sync(
            password || 'peanuts',
            KEY_SALT,
            LINUX_KEY_ITERATIONS,
            KEY_LENGTH,
            'sha1'
        )

        return async (row) =>
            decryptChromiumAes128CbcValue(
                Buffer.from(row.encrypted_value || '', 'hex'),
                key,
                row.host_key
            )
    }

    if (process.platform === 'win32') {
        if (!location.localStatePath) {
            throw new Error(
                `Unable to locate Chromium Local State for profile: ${location.profileDir}`
            )
        }

        const localState = JSON.parse(
            await readFile(location.localStatePath, 'utf8')
        ) as {
            os_crypt?: {
                encrypted_key?: string
            }
        }

        const encryptedKeyBase64 = localState.os_crypt?.encrypted_key
        if (!encryptedKeyBase64) {
            throw new Error(
                `Local State did not include os_crypt.encrypted_key for ${location.userDataDir}`
            )
        }

        const encryptedKey = Buffer.from(encryptedKeyBase64, 'base64')
        const masterKey = await dpapiUnprotect(encryptedKey.subarray(5))

        return async (row) => {
            const encryptedValue = Buffer.from(row.encrypted_value || '', 'hex')
            if (
                encryptedValue.length > 4 &&
                encryptedValue[0] === 0x01 &&
                encryptedValue[1] === 0x00 &&
                encryptedValue[2] === 0x00 &&
                encryptedValue[3] === 0x00
            ) {
                const decrypted = await dpapiUnprotect(encryptedValue)
                return decrypted.toString('utf8')
            }

            return decryptChromiumAes256GcmValue(encryptedValue, masterKey)
        }
    }

    throw new Error(
        `Local Chromium cookie sync is not supported on ${process.platform}.`
    )
}

function buildPlaywrightCookie(row: ChromiumCookieRow, value: string): Cookie | null {
    if (!row.name.trim()) {
        return null
    }
    if (!row.host_key.trim()) {
        return null
    }

    const expires =
        row.has_expires === 1
            ? convertChromiumTimestampToUnixSeconds(row.expires_utc)
            : -1
    if (expires !== -1 && expires <= Math.floor(Date.now() / 1000)) {
        return null
    }

    return {
        name: row.name,
        value,
        domain: row.host_key,
        path: row.path || '/',
        expires,
        httpOnly: row.is_httponly === 1,
        secure: row.is_secure === 1,
        sameSite: mapChromiumSameSite(row.samesite),
    }
}

export async function loadCookiesFromLocalProfileDir(
    inputPath: string
): Promise<Cookie[] | null> {
    const location = await resolveChromiumProfileLocation(inputPath)
    if (!location) {
        return null
    }

    const snapshot = await createSqliteSnapshot(location.cookieDbPath)
    try {
        const rows = await querySqliteJson<ChromiumCookieRow>(
            snapshot.snapshotPath,
            [
                'SELECT',
                '  host_key,',
                '  name,',
                '  value,',
                '  hex(encrypted_value) AS encrypted_value,',
                '  path,',
                '  CAST(expires_utc AS TEXT) AS expires_utc,',
                '  is_secure,',
                '  is_httponly,',
                '  has_expires,',
                '  samesite',
                'FROM cookies',
            ].join(' ')
        )

        const decryptValue = await buildChromiumDecryptor(location)
        const cookies: Cookie[] = []

        for (const row of rows) {
            let value = row.value || ''
            if (!value && row.encrypted_value) {
                value = await decryptValue(row)
            }

            const cookie = buildPlaywrightCookie(row, value)
            if (cookie) {
                cookies.push(cookie)
            }
        }

        return cookies
    } finally {
        await snapshot.cleanup()
    }
}
