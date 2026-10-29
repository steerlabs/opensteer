import { noFollowFlag } from "@opensteer/shared/privateFiles";
import { isNodeError } from "@opensteer/shared/nodeError";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PortableFsManagerTlsIdentity } from "@opensteer/workspace-portablefs";

const MAX_PRIVATE_KEY_BYTES = 128 * 1_024;
const MAX_CERTIFICATE_BUNDLE_BYTES = 1024 * 1_024;

interface PortableFsProductKey {
  readonly privateKey: KeyObject;
  readonly privateKeyPath: string;
  readonly publicKeyPath: string | undefined;
  readonly publicKeyPem: string;
}

export async function loadOrCreatePortableFsProductKey(options: {
  readonly dataDirectory: string;
  readonly privateKeyPath?: string;
}): Promise<PortableFsProductKey> {
  const generatedDirectory = resolve(options.dataDirectory, "keys");
  const privateKeyPath = resolve(
    options.privateKeyPath ?? join(generatedDirectory, "portablefs-product-private.pem"),
  );
  const publicKeyPath = options.privateKeyPath
    ? undefined
    : join(generatedDirectory, "portablefs-product-public.pem");

  if (!options.privateKeyPath) {
    await mkdir(generatedDirectory, { mode: 0o700, recursive: true });
    try {
      const generated = generateKeyPairSync("ed25519");
      const privatePem = generated.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      await writeFile(privateKeyPath, privatePem, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  }

  const privatePem = await readRegularFile(
    privateKeyPath,
    MAX_PRIVATE_KEY_BYTES,
    "PortableFS product private key",
  );
  const privateKey = createPrivateKey(privatePem);
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("PortableFS product private key must be Ed25519");
  }
  const publicKeyPem = createPublicKey(privateKey)
    .export({ format: "pem", type: "spki" })
    .toString();
  if (publicKeyPath) {
    try {
      await writeFile(publicKeyPath, publicKeyPem, { flag: "wx", mode: 0o644 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const persisted = await readRegularFile(
        publicKeyPath,
        MAX_PRIVATE_KEY_BYTES,
        "PortableFS product public key",
      );
      if (persisted !== publicKeyPem) {
        throw new Error("PortableFS product public key does not match its private key");
      }
    }
  }
  return { privateKey, privateKeyPath, publicKeyPath, publicKeyPem };
}

export async function loadPortableFsManagerTlsIdentity(options: {
  readonly caPath: string;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly serverName?: string;
}): Promise<PortableFsManagerTlsIdentity> {
  const [caCertificatePem, clientCertificatePem, clientPrivateKeyPem] = await Promise.all([
    readRegularFile(options.caPath, MAX_CERTIFICATE_BUNDLE_BYTES, "PortableFS manager CA"),
    readRegularFile(
      options.certificatePath,
      MAX_CERTIFICATE_BUNDLE_BYTES,
      "PortableFS product mTLS certificate",
    ),
    readRegularFile(
      options.privateKeyPath,
      MAX_PRIVATE_KEY_BYTES,
      "PortableFS product mTLS private key",
    ),
  ]);
  return {
    caCertificatePem,
    clientCertificatePem,
    clientPrivateKeyPem,
    ...(options.serverName ? { serverName: options.serverName } : {}),
  };
}

async function readRegularFile(path: string, maxBytes: number, label: string): Promise<string> {
  const resolved = resolve(path);
  const flags = constants.O_RDONLY | noFollowFlag() | constants.O_NONBLOCK;
  let handle;
  try {
    handle = await open(resolved, flags);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) {
      throw new Error(`${label} must be one bounded regular file with one link`);
    }
    return await handle.readFile("utf8");
  } catch (error) {
    throw new Error(`${label} could not be loaded`, { cause: error });
  } finally {
    await handle?.close();
  }
}
