import {
  AesGcmCredentialVault,
  AesGcmSecretVault,
  StaticEncryptionKeyProvider,
} from "@opensteer/access/host";
import type { ChannelCredentialPurpose } from "@opensteer/channel-protocol";
import {
  OpensteerError,
  createId,
  type CredentialId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { IntegrationConnectionId } from "@opensteer/integration-core";
import { isNodeError } from "@opensteer/shared/nodeError";
import {
  noFollowFlag,
  setPrivateDirectoryMode,
  setPrivateFileMode,
} from "@opensteer/shared/privateFiles";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function loadOrCreateCredentialKey(options: {
  readonly dataDirectory: string;
  readonly keyPath?: string;
}): Promise<Buffer> {
  return loadOrCreateHostEncryptionKey({
    dataDirectory: options.dataDirectory,
    fileName: "credential-v1.key",
    label: "Credential",
    ...(options.keyPath ? { keyPath: options.keyPath } : {}),
  });
}

async function loadOrCreateHostEncryptionKey(options: {
  readonly dataDirectory: string;
  readonly fileName: string;
  readonly keyPath?: string;
  readonly label: string;
}): Promise<Buffer> {
  const generated = options.keyPath === undefined;
  const path = resolve(options.keyPath ?? join(options.dataDirectory, "keys", options.fileName));
  if (generated) {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    await setPrivateDirectoryMode(dirname(path));
    try {
      await writeFile(path, `${randomBytes(32).toString("base64url")}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!(isNodeError(error) && error.code === "EEXIST")) throw error;
    }
    await setPrivateFileMode(path);
  }
  let encoded: string;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag() | fsConstants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 4_096) {
      throw new Error(`${options.label} encryption key file is invalid`);
    }
    encoded = (await handle.readFile("utf8")).trim();
  } catch (error) {
    throw new Error(`Unable to read ${options.label.toLowerCase()} encryption key at ${path}`, {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength !== 32)
    throw new Error(`${options.label} encryption key must be 32 bytes in base64url form`);
  return key;
}

export class CredentialService {
  readonly #canaryVault: AesGcmSecretVault;
  readonly #store: OpensteerStore;
  readonly #vault: AesGcmCredentialVault;

  constructor(options: { readonly key: Buffer; readonly store: OpensteerStore }) {
    this.#store = options.store;
    const keys = new StaticEncryptionKeyProvider(new Map([[1, options.key]]), 1);
    this.#vault = new AesGcmCredentialVault(keys);
    this.#canaryVault = new AesGcmSecretVault(keys);
  }

  async initialize(): Promise<void> {
    const keyVersion = 1;
    const context = {
      purpose: "credential-vault-canary",
      recordId: "credential-vault",
      scope: "host",
    } as const;
    let canary = await this.#store.credentialVaultCanary(keyVersion);
    if (!canary) {
      const sealed = await this.#canaryVault.seal(
        { value: "opensteer-credential-vault-canary-v1" },
        context,
      );
      await this.#store.createCredentialVaultCanary({
        encryptedPayload: sealed.envelope,
        keyVersion: sealed.keyVersion,
      });
      canary = await this.#store.credentialVaultCanary(keyVersion);
    }
    if (!canary) throw new Error("Credential vault canary could not be created");
    const opened = await this.#canaryVault.open(canary.encryptedPayload, context);
    if (opened.value !== "opensteer-credential-vault-canary-v1") {
      throw new Error("Credential vault canary is invalid");
    }
  }

  async prepare(input: {
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly name: string;
    readonly ownerId: UserId;
    readonly provider: string;
    readonly secrets: Readonly<Record<string, string>>;
  }) {
    const id = createId("credential");
    const sealed = await this.#vault.seal(input.secrets, {
      credentialId: id,
      ownerId: input.ownerId,
      provider: input.provider,
    });
    return {
      encryptedPayload: sealed.envelope,
      encryptionKeyVersion: sealed.keyVersion,
      id,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      name: input.name,
      ownerId: input.ownerId,
      provider: input.provider,
    };
  }

  channelConnectionForReplacement(connectionId: IntegrationConnectionId, ownerId: UserId) {
    return this.#store.channelCredentialForReplacement(connectionId, ownerId);
  }

  async replaceChannelConnection(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerId: UserId;
    readonly secrets: Readonly<Record<string, string>>;
  }): Promise<RunnerId> {
    const credential = await this.#store.channelCredentialForReplacement(
      input.connectionId,
      input.ownerId,
    );
    if (!credential || !credential.provider.startsWith("channel:")) {
      throw new OpensteerError({ code: "not_found", message: "Channel connection not found" });
    }
    const sealed = await this.#vault.seal(input.secrets, {
      credentialId: credential.credentialId,
      ownerId: input.ownerId,
      provider: credential.provider,
    });
    return this.#store.replaceChannelCredential({
      connectionId: input.connectionId,
      credentialId: credential.credentialId,
      encryptedPayload: sealed.envelope,
      encryptionKeyVersion: sealed.keyVersion,
      ownerId: input.ownerId,
    });
  }

  async materializeForChannelRuntime(
    credentialId: CredentialId,
    ownerId: UserId,
    context: {
      readonly connectionId: IntegrationConnectionId;
      readonly purpose: ChannelCredentialPurpose;
      readonly runnerId: RunnerId;
    },
    fields: readonly string[],
  ): Promise<Readonly<Record<string, string>>> {
    const credential = await this.#store.getCredential(credentialId);
    if (
      !credential ||
      credential.ownerId !== ownerId ||
      !credential.provider.startsWith("channel:")
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Channel credential is unavailable",
      });
    }
    const secrets = await this.#vault.open(credential.encryptedPayload, {
      credentialId,
      ownerId,
      provider: credential.provider,
    });
    const scoped: Record<string, string> = {};
    for (const field of fields) {
      const value = secrets[field];
      if (!value) {
        throw new OpensteerError({
          code: "conflict",
          message: `Channel credential is missing ${field}`,
        });
      }
      scoped[field] = value;
    }
    await this.#store.recordChannelCredentialAccess({
      runnerId: context.runnerId,
      connectionId: context.connectionId,
      credentialId,
      purpose:
        context.purpose === "delivery"
          ? "channel-delivery"
          : context.purpose === "transport"
            ? "channel-transport"
            : "channel-webhook",
    });
    return Object.freeze(scoped);
  }
}
