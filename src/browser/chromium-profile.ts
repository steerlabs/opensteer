import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import {
    cp,
    copyFile,
    mkdtemp,
    readdir,
    readFile,
    rm,
} from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, type Cookie } from 'playwright'
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

export interface LoadLocalProfileCookiesOptions {
    headless?: boolean
    timeout?: number
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
    playwrightChannel?: 'chrome' | 'chrome-beta' | 'msedge'
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
            playwrightChannel: 'msedge',
        },
    },
    {
        match: ['google', 'chrome beta'],
        brand: {
            macService: 'Chrome Beta Safe Storage',
            macAccount: 'Chrome Beta',
            linuxApplications: ['chrome-beta'],
            playwrightChannel: 'chrome-beta',
        },
    },
    {
        match: ['google', 'chrome'],
        brand: {
            macService: 'Chrome Safe Storage',
            macAccount: 'Chrome',
            linuxApplications: ['chrome', 'google-chrome'],
            playwrightChannel: 'chrome',
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
): Promise<string[]> {
    const entries = await readdir(userDataDir, {
        withFileTypes: true,
    }).catch(() => [])

    const candidates = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(userDataDir, entry.name))
        .filter((entryPath) => resolveCookieDbPath(entryPath))

    return candidates
}

async function resolveChromiumProfileLocation(
    inputPath: string
): Promise<ChromiumProfileLocation> {
    const expandedPath = expandHome(inputPath.trim())
    if (!expandedPath) {
        throw new Error('Profile path cannot be empty.')
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

    if (fileExists(expandedPath)) {
        throw new Error(
            `Unsupported profile source "${inputPath}". Pass a Chromium profile directory, user-data dir, or Cookies database path.`
        )
    }

    if (!directoryExists(expandedPath)) {
        throw new Error(
            `Could not find a Chromium profile at "${inputPath}".`
        )
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
        throw new Error(
            `Unsupported profile source "${inputPath}". Pass a Chromium profile directory, user-data dir, or Cookies database path.`
        )
    }

    const profileDirs = await selectProfileDirFromUserDataDir(expandedPath)
    if (profileDirs.length === 0) {
        throw new Error(
            `No Chromium profile with a Cookies database was found under "${inputPath}".`
        )
    }
    if (profileDirs.length > 1) {
        const candidates = profileDirs.map((entry) => basename(entry)).join(', ')
        throw new Error(
            `"${inputPath}" contains multiple Chromium profiles (${candidates}). Pass a specific profile directory such as "${profileDirs[0]}".`
        )
    }

    const selectedProfileDir = profileDirs[0]
    const cookieDbPath = resolveCookieDbPath(selectedProfileDir)
    if (!cookieDbPath) {
        throw new Error(
            `No Chromium Cookies database was found for "${inputPath}".`
        )
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
    const result = await execFileAsync('sqlite3', ['-json', dbPath, query], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    })
    const stdout = result.stdout

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
    inputPath: string,
    options: LoadLocalProfileCookiesOptions = {}
): Promise<Cookie[]> {
    const location = await resolveChromiumProfileLocation(inputPath)

    try {
        return await loadCookiesFromSqlite(location)
    } catch (error) {
        if (!isMissingSqliteBinary(error)) {
            throw error
        }
    }

    return await loadCookiesFromBrowserSnapshot(location, options)
}

async function loadCookiesFromSqlite(
    location: ChromiumProfileLocation
): Promise<Cookie[]> {
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

async function loadCookiesFromBrowserSnapshot(
    location: ChromiumProfileLocation,
    options: LoadLocalProfileCookiesOptions
): Promise<Cookie[]> {
    const snapshotRootDir = await mkdtemp(join(tmpdir(), 'opensteer-profile-'))
    const snapshotProfileDir = join(
        snapshotRootDir,
        basename(location.profileDir)
    )

    let context:
        | Awaited<ReturnType<typeof chromium.launchPersistentContext>>
        | null = null

    try {
        await cp(location.profileDir, snapshotProfileDir, {
            recursive: true,
        })
        if (location.localStatePath) {
            await copyFile(location.localStatePath, join(snapshotRootDir, 'Local State'))
        }

        const brand = detectChromiumBrand(location)
        const args = [`--profile-directory=${basename(snapshotProfileDir)}`]

        context = await chromium.launchPersistentContext(snapshotRootDir, {
            channel: brand.playwrightChannel,
            headless: options.headless ?? true,
            timeout: options.timeout ?? 120_000,
            args,
        })

        return await context.cookies()
    } finally {
        await context?.close().catch(() => undefined)
        await rm(snapshotRootDir, { recursive: true, force: true })
    }
}

function isMissingSqliteBinary(error: unknown): boolean {
    return Boolean(
        error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
    )
}
