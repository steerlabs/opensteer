import { execFile as execFileCallback } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { DatabaseSync as NodeSqliteDatabaseSync } from "node:sqlite";

import {
  type BrowserBrandId,
  type BrowserBrandRecord,
  detectInstalledBrowserBrands,
  getBrowserBrand,
  resolveBrandUserDataDir,
} from "./browser-brands.js";
import type { BrowserProfileSyncCookie } from "../cloud/cookie-sync.js";

const execFile = promisify(execFileCallback);

const NODE_SQLITE_SPECIFIER = `node:${"sqlite"}`;
const CHROME_EPOCH_OFFSET = 11644473600000000n;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReadBrowserCookiesInput {
  readonly brandId?: BrowserBrandId;
  readonly userDataDir?: string;
  readonly profileDirectory?: string;
}

export interface ReadBrowserCookiesResult {
  readonly cookies: readonly BrowserProfileSyncCookie[];
  readonly brandId: BrowserBrandId;
  readonly brandDisplayName: string;
  readonly userDataDir: string;
  readonly profileDirectory: string;
}

export async function readBrowserCookies(
  input: ReadBrowserCookiesInput = {},
): Promise<ReadBrowserCookiesResult> {
  const brand = resolveRequestedBrand(input);
  const userDataDir = resolveBrandUserDataDir(brand, input.userDataDir);
  const profileDirectory = input.profileDirectory ?? "Default";
  const cookiesPath = join(userDataDir, profileDirectory, "Cookies");

  if (!existsSync(cookiesPath)) {
    throw new Error(
      `Cookies database not found at "${cookiesPath}". ` +
        `Verify the browser brand, user-data-dir, and profile-directory are correct.`,
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), "opensteer-cookies-"));

  try {
    await copyCookiesDatabase(cookiesPath, tempDir);

    const decryptionKey = await resolveDecryptionKey(brand.id, userDataDir);
    const rows = queryAllCookies(join(tempDir, "Cookies"));
    const cookies = decryptCookieRows(rows, decryptionKey);

    return {
      cookies,
      brandId: brand.id,
      brandDisplayName: brand.displayName,
      userDataDir,
      profileDirectory,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Brand resolution
// ---------------------------------------------------------------------------

function resolveRequestedBrand(input: ReadBrowserCookiesInput): BrowserBrandRecord {
  if (input.brandId !== undefined) {
    return getBrowserBrand(input.brandId);
  }

  const installed = detectInstalledBrowserBrands()[0];
  if (!installed) {
    throw new Error(
      "No Chromium browser found. Install a supported browser or pass brandId explicitly.",
    );
  }
  return installed.brand;
}

// ---------------------------------------------------------------------------
// Database copy (WAL-lock workaround)
// ---------------------------------------------------------------------------

async function copyCookiesDatabase(cookiesPath: string, destDir: string): Promise<void> {
  await copyFile(cookiesPath, join(destDir, "Cookies"));

  for (const suffix of ["-wal", "-journal", "-shm"]) {
    const src = cookiesPath + suffix;
    if (existsSync(src)) {
      await copyFile(src, join(destDir, "Cookies" + suffix)).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// SQLite query
// ---------------------------------------------------------------------------

interface RawCookieRow {
  readonly host_key: string;
  readonly name: string;
  readonly value: string;
  readonly encrypted_value: Buffer;
  readonly path: string;
  readonly expires_utc: number | bigint;
  readonly is_secure: number | bigint;
  readonly is_httponly: number | bigint;
  readonly samesite: number | bigint;
  readonly is_persistent: number | bigint;
}

function queryAllCookies(dbPath: string): readonly RawCookieRow[] {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ DatabaseSync } = require(NODE_SQLITE_SPECIFIER) as typeof import("node:sqlite"));
  } catch {
    throw new Error(
      "Reading browser cookies requires Node's built-in SQLite support. " +
        "Use Node 22.5+ or a build with node:sqlite enabled.",
    );
  }

  const database: NodeSqliteDatabaseSync = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = database.prepare(
      `SELECT host_key, name, value, encrypted_value, path,
              expires_utc, is_secure, is_httponly, samesite, is_persistent
       FROM cookies`,
    );
    stmt.setReadBigInts(true);
    return stmt.all() as RawCookieRow[];
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Decryption key resolution
// ---------------------------------------------------------------------------

interface DecryptionKey {
  readonly platform: "darwin" | "linux" | "win32";
  readonly key: Buffer;
  readonly algorithm: "aes-128-cbc" | "aes-256-gcm";
}

async function resolveDecryptionKey(
  brandId: BrowserBrandId,
  userDataDir: string,
): Promise<DecryptionKey> {
  if (process.platform === "darwin") {
    const password = await resolveKeychainPassword(brandId);
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    return { platform: "darwin", key, algorithm: "aes-128-cbc" };
  }

  if (process.platform === "linux") {
    const key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
    return { platform: "linux", key, algorithm: "aes-128-cbc" };
  }

  if (process.platform === "win32") {
    const key = await resolveWindowsMasterKey(userDataDir);
    return { platform: "win32", key, algorithm: "aes-256-gcm" };
  }

  throw new Error(`Unsupported platform "${process.platform}" for cookie decryption.`);
}

// ---------------------------------------------------------------------------
// macOS Keychain
// ---------------------------------------------------------------------------

const BRAND_KEYCHAIN_SERVICE: Record<BrowserBrandId, string> = {
  chrome: "Chrome Safe Storage",
  "chrome-canary": "Chrome Safe Storage",
  chromium: "Chromium Safe Storage",
  brave: "Brave Safe Storage",
  edge: "Microsoft Edge Safe Storage",
  vivaldi: "Chrome Safe Storage",
  helium: "Chrome Safe Storage",
};

async function resolveKeychainPassword(brandId: BrowserBrandId): Promise<string> {
  const service = BRAND_KEYCHAIN_SERVICE[brandId];
  try {
    const { stdout } = await execFile("security", [
      "find-generic-password",
      "-s",
      service,
      "-w",
    ]);
    return stdout.trim();
  } catch {
    throw new Error(
      `Failed to retrieve "${service}" from macOS Keychain. ` +
        "Ensure the browser has been opened at least once and Keychain access is allowed.",
    );
  }
}

// ---------------------------------------------------------------------------
// Windows DPAPI master key
// ---------------------------------------------------------------------------

async function resolveWindowsMasterKey(userDataDir: string): Promise<Buffer> {
  const localStatePath = join(userDataDir, "Local State");
  let localState: { os_crypt?: { encrypted_key?: string } };
  try {
    localState = JSON.parse(await readFile(localStatePath, "utf8"));
  } catch {
    throw new Error(
      `Failed to read "${localStatePath}". Ensure the browser has been opened at least once.`,
    );
  }

  const encodedKey = localState.os_crypt?.encrypted_key;
  if (!encodedKey) {
    throw new Error(`No encrypted key found in "${localStatePath}".`);
  }

  // Base64 decode and strip the "DPAPI" prefix (5 bytes)
  const rawKey = Buffer.from(encodedKey, "base64").subarray(5);

  // Decrypt via PowerShell DPAPI
  const psScript = `
    Add-Type -AssemblyName System.Security
    $bytes = [byte[]]@(${Array.from(rawKey).join(",")})
    $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
    [Convert]::ToBase64String($decrypted)
  `;

  try {
    const { stdout } = await execFile("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      psScript,
    ]);
    return Buffer.from(stdout.trim(), "base64");
  } catch {
    throw new Error(
      "Failed to decrypt browser master key via Windows DPAPI. " +
        "Ensure you are running as the same user who owns the browser profile.",
    );
  }
}

// ---------------------------------------------------------------------------
// Cookie value decryption
// ---------------------------------------------------------------------------

function decryptCookieRows(
  rows: readonly RawCookieRow[],
  decryptionKey: DecryptionKey,
): BrowserProfileSyncCookie[] {
  const cookies: BrowserProfileSyncCookie[] = [];
  const nowSeconds = Math.floor(Date.now() / 1000);

  for (const row of rows) {
    const name = row.name.trim();
    const domain = row.host_key.trim();
    if (!name || !domain) {
      continue;
    }

    const value = decryptCookieValue(row, decryptionKey);
    if (value === null) {
      continue;
    }

    const expiresSeconds = chromeDateToUnixSeconds(row.expires_utc);
    const isSession = expiresSeconds <= 0;

    // Skip expired non-session cookies
    if (!isSession && expiresSeconds < nowSeconds) {
      continue;
    }

    const sameSite = chromeSameSiteToString(row.samesite);
    let secure = Number(row.is_secure) === 1;

    // CDP requires Secure=true when SameSite=None
    if (sameSite === "None") {
      secure = true;
    }

    cookies.push({
      name,
      value,
      domain,
      path: row.path || "/",
      secure,
      httpOnly: Number(row.is_httponly) === 1,
      ...(isSession ? {} : { expires: expiresSeconds }),
      ...(sameSite !== undefined ? { sameSite } : {}),
    });
  }

  return cookies;
}

function decryptCookieValue(row: RawCookieRow, decryptionKey: DecryptionKey): string | null {
  // Prefer the unencrypted value column when present
  if (row.value && row.value.length > 0) {
    return row.value;
  }

  const encrypted = Buffer.isBuffer(row.encrypted_value)
    ? row.encrypted_value
    : Buffer.from(row.encrypted_value);

  if (encrypted.length === 0) {
    return "";
  }

  // Check for version prefix (v10 or v11)
  const prefix = encrypted.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") {
    // Not encrypted — return raw value
    return encrypted.toString("utf8");
  }

  const ciphertext = encrypted.subarray(3);

  if (decryptionKey.algorithm === "aes-128-cbc") {
    return decryptAes128Cbc(ciphertext, decryptionKey.key);
  }

  if (decryptionKey.algorithm === "aes-256-gcm") {
    return decryptAes256Gcm(ciphertext, decryptionKey.key);
  }

  return null;
}

function decryptAes128Cbc(ciphertext: Buffer, key: Buffer): string | null {
  try {
    const iv = Buffer.alloc(16, 0x20); // 16 bytes of space character
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Strip PKCS7 padding
    const padLen = decrypted[decrypted.length - 1];
    if (padLen !== undefined && padLen > 0 && padLen <= 16) {
      return decrypted.subarray(0, decrypted.length - padLen).toString("utf8");
    }
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

function decryptAes256Gcm(ciphertext: Buffer, key: Buffer): string | null {
  try {
    // Layout: 12-byte nonce | encrypted data | 16-byte auth tag
    const nonce = ciphertext.subarray(0, 12);
    const authTag = ciphertext.subarray(ciphertext.length - 16);
    const encrypted = ciphertext.subarray(12, ciphertext.length - 16);

    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chrome date conversion
// ---------------------------------------------------------------------------

function chromeDateToUnixSeconds(chromeTimestamp: number | bigint): number {
  const ts = BigInt(chromeTimestamp);
  if (ts <= 0n) {
    return -1;
  }
  return Number((ts - CHROME_EPOCH_OFFSET) / 1000000n);
}

function chromeSameSiteToString(
  value: number | bigint,
): BrowserProfileSyncCookie["sameSite"] | undefined {
  const v = Number(value);
  if (v === 0) return "None";
  if (v === 1) return "Lax";
  if (v === 2) return "Strict";
  return undefined;
}
