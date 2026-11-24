/**
 * The Home's own keys for its pooled browser (phase B, W4): made on the Home at its first start,
 * kept beside its host keys, and never sent. Only their public halves leave
 * (`managedBrowserPoolRegistration`). Read only for a Cloud Computer whose boot answer said
 * browserPool; no other Home touches this file.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { ManagedBrowserPoolHomeKeys } from "./managed-pool.js";

const StoredKeysSchema = z.strictObject({
  version: z.literal(1),
  homeKey: z.string().min(1),
  relayKey: z.string().min(1),
  relayCertificate: z.string().min(1),
  ticketKey: z.strictObject({ keyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u), key: z.string() }),
});

/** Where the keys are kept: the Home's data directory, beside its host keys. */
export function managedBrowserPoolKeysPath(dataDirectory: string): string {
  return resolve(dataDirectory, "keys", "browser-pool-keys.json");
}

/**
 * The Home's keys for its pooled browser: read when they exist, made once when they do not.
 * A lost file means new keys, which the Home registers again (the account raises the term).
 */
export async function loadOrCreateManagedBrowserPoolKeys(
  dataDirectory: string,
): Promise<ManagedBrowserPoolHomeKeys> {
  const path = managedBrowserPoolKeysPath(dataDirectory);
  let text = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    // Written whole beside it, then linked into place: the file exists only complete, and a
    // second start racing this one finds the first one's keys or none (never a partial file).
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(makeKeys()), { flag: "wx", mode: 0o600 });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    text = await readFile(path, "utf8");
  }
  await setPrivateFileMode(path);
  const stored = StoredKeysSchema.parse(JSON.parse(text));
  const keys: ManagedBrowserPoolHomeKeys = {
    homeKey: createPrivateKey(stored.homeKey),
    relayKey: stored.relayKey,
    relayCertificate: stored.relayCertificate,
    ticketKey: { keyId: stored.ticketKey.keyId, key: createPrivateKey(stored.ticketKey.key) },
  };
  assertKeys(keys);
  return keys;
}

function makeKeys(): z.infer<typeof StoredKeysSchema> {
  const pem = (key: KeyObject) => key.export({ format: "pem", type: "pkcs8" }).toString();
  const home = generateKeyPairSync("ed25519").privateKey;
  const relay = generateKeyPairSync("ed25519").privateKey;
  const ticket = generateKeyPairSync("ed25519").privateKey;
  return {
    version: 1,
    homeKey: pem(home),
    relayKey: pem(relay),
    relayCertificate: selfSignedCertificate(relay),
    ticketKey: { keyId: `pool-${randomUUID()}`, key: pem(ticket) },
  };
}

function assertKeys(keys: ManagedBrowserPoolHomeKeys): void {
  for (const key of [keys.homeKey, keys.ticketKey.key, createPrivateKey(keys.relayKey)])
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("A pooled browser key is not Ed25519.");
  const certificate = new X509Certificate(keys.relayCertificate);
  const spki = (key: KeyObject) => key.export({ format: "der", type: "spki" }).toString("base64");
  if (spki(certificate.publicKey) !== spki(createPublicKey(keys.relayKey)))
    throw new Error("The pooled browser's relay certificate is not its relay key's.");
}

// ---- A self-signed Ed25519 certificate, in DER, with nothing but Node's own crypto ------------
// The relay pins the key itself (no authority, no name, no expiry is checked), so the
// certificate only carries the key: subject and issuer "opensteer-pool", no expiry (RFC 5280).

/** A self-signed X.509 v3 certificate for an Ed25519 key, as PEM. */
export function selfSignedCertificate(key: KeyObject): string {
  const ed25519 = sequence(oid([1, 3, 101, 112]));
  const name = sequence(set(sequence(oid([2, 5, 4, 3]), tlv(0x0c, Buffer.from("opensteer-pool")))));
  const notBefore = generalizedTime(new Date(Date.now() - 24 * 60 * 60_000));
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(randomSerial()),
    ed25519,
    name,
    sequence(notBefore, tlv(0x18, Buffer.from("99991231235959Z"))),
    name,
    createPublicKey(key).export({ format: "der", type: "spki" }),
  );
  const signature = sign(null, tbs, key);
  const der = sequence(tbs, ed25519, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const body = der.toString("base64").replace(/(.{64})/gu, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${body.trimEnd()}\n-----END CERTIFICATE-----\n`;
}

function tlv(tag: number, value: Buffer): Buffer {
  const length =
    value.length < 0x80
      ? Buffer.from([value.length])
      : value.length < 0x100
        ? Buffer.from([0x81, value.length])
        : Buffer.from([0x82, value.length >> 8, value.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, value]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));

function integer(value: Buffer): Buffer {
  // Positive, minimal: a leading zero only when the high bit is set.
  const trimmed = value.subarray(
    Math.max(
      0,
      value.findIndex((byte) => byte !== 0),
    ),
  );
  const body =
    trimmed.length && trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
  return tlv(0x02, body.length ? body : Buffer.from([0]));
}

function oid(parts: readonly number[]): Buffer {
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    for (let rest = part >> 7; rest > 0; rest >>= 7) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function generalizedTime(date: Date): Buffer {
  const text = date
    .toISOString()
    .replace(/[-:T]/gu, "")
    .replace(/\.\d+Z$/u, "Z");
  return tlv(0x18, Buffer.from(text));
}

function randomSerial(): Buffer {
  const serial = Buffer.from(randomUUID().replace(/-/gu, ""), "hex");
  serial[0] = serial[0]! & 0x7f;
  return serial;
}
