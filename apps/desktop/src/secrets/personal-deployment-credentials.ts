import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";
import { setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { noFollowFlag } from "@opensteer/shared/privateFiles";
import { constants } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { lstat, open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { DeploymentIdSchema, HostKeyFingerprintSchema } from "@opensteer/core";
import { hostKeyFingerprint } from "@opensteer/deployment-authority";
import { z } from "zod";
import { ProtectedJsonFile, type DesktopSecretCryptography } from "./protected-json-file.js";
import type { DesktopPrivateFilesystem } from "./desktop-private-files.js";
import type {
  PersonalDeploymentManifest,
  PersonalDeploymentPreparedPaths,
} from "./personal-deployment-store.js";

const PersonalDeploymentSecretStateSchema = z.strictObject({
  databasePassword: z.string().regex(/^[A-Za-z0-9_-]{64}$/u),
  deploymentId: DeploymentIdSchema,
  hostAuthSecret: z.string().regex(/^[A-Za-z0-9_-]{64}$/u),
  /**
   * Optional rather than a new schema version so a store written before
   * messaging existed still reads; `ensure` fills it in on the next start.
   *
   * It is durable on purpose. The Host pre-registers this token under a fixed
   * idempotency key (`deployment-managed-messaging-runner`), and
   * `createRunnerEnrollment` refuses a replay of that key carrying a different
   * token hash. Minting a fresh one per Host start would therefore stop a
   * Personal Host from starting a second time.
   */
  messagingEnrollmentToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{64}$/u)
    .optional(),
  schemaVersion: z.literal(1),
});

export interface PersonalDeploymentSecrets {
  readonly databasePassword: string;
  readonly hostAuthSecret: string;
  readonly hostKeyFingerprint: z.infer<typeof HostKeyFingerprintSchema>;
  readonly messagingEnrollmentToken: string;
}

export interface PersonalDeploymentCredentialPort {
  ensure(
    manifest: PersonalDeploymentManifest,
    paths: PersonalDeploymentPreparedPaths,
  ): Promise<PersonalDeploymentSecrets>;
}

/** Ownership-bound secrets; the strict v1 state shape is unchanged across this upgrade. */
export class NativePersonalDeploymentCredentials implements PersonalDeploymentCredentialPort {
  readonly #cryptography: DesktopSecretCryptography;
  readonly #privateFiles: DesktopPrivateFilesystem | undefined;

  constructor(
    cryptography: DesktopSecretCryptography,
    options: { readonly privateFiles?: DesktopPrivateFilesystem } = {},
  ) {
    this.#cryptography = cryptography;
    this.#privateFiles = options.privateFiles;
  }

  async ensure(
    manifest: PersonalDeploymentManifest,
    paths: PersonalDeploymentPreparedPaths,
  ): Promise<PersonalDeploymentSecrets> {
    const store = new ProtectedJsonFile({
      // The running Deployment already depends on these exact secrets.
      content: "critical",
      cryptography: this.#cryptography,
      filePath: path.join(paths.rootDirectory, "personal-secrets.v1.json"),
      maxFileBytes: 64 * 1_024,
      maxPlaintextBytes: 16 * 1_024,
      messages: {
        protectedState: "Personal deployment secrets",
        protectedStore: "Personal deployment secret store",
      },
      schema: PersonalDeploymentSecretStateSchema,
      ...(this.#privateFiles === undefined ? {} : { privateFiles: this.#privateFiles }),
    });
    let state = await store.read();
    if (state && state.deploymentId !== manifest.deploymentId) {
      throw new Error("Personal deployment secret store belongs to another Deployment.");
    }
    if (!state) {
      state = PersonalDeploymentSecretStateSchema.parse({
        databasePassword: randomSecret(),
        deploymentId: manifest.deploymentId,
        hostAuthSecret: randomSecret(),
        messagingEnrollmentToken: randomSecret(),
        schemaVersion: 1,
      });
      await store.write(state);
    } else if (!state.messagingEnrollmentToken) {
      state = PersonalDeploymentSecretStateSchema.parse({
        ...state,
        messagingEnrollmentToken: randomSecret(),
      });
      await store.write(state);
    }
    const messagingEnrollmentToken = state.messagingEnrollmentToken;
    if (!messagingEnrollmentToken) {
      throw new Error("Personal messaging enrollment token was not stored.");
    }
    const hostKeyFingerprint = await ensureHostKeyPair(paths, this.#privateFiles);
    await Promise.all([
      ensureHostDataEncryptionKey(paths.browserProfileKeyPath, this.#privateFiles),
      ensureHostDataEncryptionKey(paths.credentialKeyPath, this.#privateFiles),
    ]);
    return { ...state, hostKeyFingerprint, messagingEnrollmentToken };
  }
}

async function ensureHostDataEncryptionKey(
  keyPath: string,
  privateFiles?: DesktopPrivateFilesystem,
): Promise<void> {
  const exists = privateFiles
    ? await privateFiles.fileExists(keyPath)
    : await regularFileExists(keyPath);
  if (!exists) {
    const encoded = `${randomBytes(32).toString("base64url")}\n`;
    if (privateFiles) await privateFiles.writeFileExclusive(keyPath, encoded);
    else await writeExclusivePrivateFile(keyPath, encoded, 0o600);
  }
  let contents: Buffer | null;
  try {
    contents = privateFiles
      ? await privateFiles.readFile(keyPath, 4_096)
      : await readBoundedKey(keyPath, 4_096);
  } catch (error) {
    throw new Error("Personal Host data encryption key is invalid.", { cause: error });
  }
  const encoded = contents?.toString("utf8").trim() ?? "";
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(encoded) ||
    Buffer.from(encoded, "base64url").byteLength !== 32
  ) {
    throw new Error("Personal Host data encryption key is invalid.");
  }
}

async function ensureHostKeyPair(
  paths: PersonalDeploymentPreparedPaths,
  privateFiles?: DesktopPrivateFilesystem,
): Promise<z.infer<typeof HostKeyFingerprintSchema>> {
  const privateExists = privateFiles
    ? await privateFiles.fileExists(paths.hostPrivateKeyPath)
    : await regularFileExists(paths.hostPrivateKeyPath);
  const publicExists = privateFiles
    ? await privateFiles.fileExists(paths.hostPublicKeyPath)
    : await regularFileExists(paths.hostPublicKeyPath);
  if (privateExists !== publicExists) {
    throw new Error("Personal Host signing key pair is incomplete.");
  }
  if (!privateExists) {
    const pair = generateKeyPairSync("ed25519");
    const privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    if (privateFiles) {
      await privateFiles.writeFileExclusive(paths.hostPrivateKeyPath, privatePem);
    } else {
      await writeExclusivePrivateFile(paths.hostPrivateKeyPath, privatePem, 0o600);
    }
    try {
      if (privateFiles) {
        await privateFiles.writeFileExclusive(paths.hostPublicKeyPath, publicPem);
      } else {
        await writeExclusivePrivateFile(paths.hostPublicKeyPath, publicPem, 0o600);
      }
    } catch (error) {
      if (privateFiles) await privateFiles.removeFile(paths.hostPrivateKeyPath);
      else await rm(paths.hostPrivateKeyPath, { force: true });
      throw error;
    }
  }
  const [privatePem, publicPem] = await Promise.all([
    privateFiles
      ? privateFiles.readFile(paths.hostPrivateKeyPath, 16 * 1_024)
      : readBoundedKey(paths.hostPrivateKeyPath),
    privateFiles
      ? privateFiles.readFile(paths.hostPublicKeyPath, 16 * 1_024)
      : readBoundedKey(paths.hostPublicKeyPath),
  ]);
  if (!privatePem || !publicPem || privatePem.byteLength < 32 || publicPem.byteLength < 32) {
    throw new Error("Personal Host signing key has an invalid size.");
  }
  let privateKey;
  let publicKey;
  try {
    privateKey = createPrivateKey(privatePem);
    publicKey = createPublicKey(publicPem);
  } catch (error) {
    throw new Error("Personal Host signing key pair is invalid.", { cause: error });
  }
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Personal Host signing key pair must use Ed25519.");
  }
  const expectedPublic = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const actualPublic = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.from(expectedPublic).equals(Buffer.from(actualPublic))) {
    throw new Error("Personal Host public and private signing keys do not match.");
  }
  return hostKeyFingerprint(Buffer.from(actualPublic).toString("base64url"));
}

async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Personal Host signing key path must be a real regular file.");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("Personal Host signing key path has unsafe permissions.");
    }
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readBoundedKey(filePath: string, maximumBytes = 16 * 1_024): Promise<Buffer> {
  const invalid = () => new Error("Personal Host key has an invalid size or type.");
  return (
    (await readBoundedRegularFile(filePath, maximumBytes, {
      changedError: invalid,
      invalidFileError: invalid,
      minimumBytes: 32,
      sizeError: invalid,
    })) ?? Buffer.alloc(0)
  );
}

async function writeExclusivePrivateFile(
  filePath: string,
  contents: string,
  mode: number,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      mode,
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await setPrivateFileMode(filePath, mode);
}

function randomSecret(): string {
  return randomBytes(48).toString("base64url");
}
