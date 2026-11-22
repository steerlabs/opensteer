import { setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { isNodeError } from "@opensteer/shared/nodeError";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DeploymentIdSchema,
  HostInstanceIdSchema,
  OpensteerError,
  type DeploymentId,
  type HostInstanceId,
} from "@opensteer/core";
import {
  HostDiscoveryDocumentSchema,
  HostDiscoveryEnvelopeSchema,
  PersonalHostAccessRouteDocumentSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  hostDiscoverySigningBytes,
  personalHostAccessRouteSigningBytes,
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
  type PersonalHostAccessRouteDocument,
  type PersonalHostAccessRouteEnvelope,
} from "@opensteer/deployment-authority";
import {
  PersonalHostAccountLinkProofDocumentSchema,
  PersonalHostAccountLinkProofEnvelopeSchema,
  personalHostAccountLinkProofSigningBytes,
  type PersonalHostAccountLinkProofDocument,
  type PersonalHostAccountLinkProofEnvelope,
} from "@opensteer/control-plane-protocol";
import { z } from "zod";

const TOKEN_HEADER = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", v: 1 })).toString(
  "base64url",
);
const MAX_TOKEN_BYTES = 64 * 1_024;

export interface HostKeyPair {
  readonly privateKey: KeyObject;
  readonly privateKeyPath: string;
  readonly publicKey: KeyObject;
  readonly publicKeyPath: string;
  readonly publicKeyPem: string;
}

export function signHostDiscovery(
  keys: Pick<HostKeyPair, "privateKey" | "publicKey">,
  input: HostDiscoveryDocument,
): HostDiscoveryEnvelope {
  const document = HostDiscoveryDocumentSchema.parse(input);
  const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const signature = sign(null, hostDiscoverySigningBytes(document), keys.privateKey).toString(
    "base64url",
  );
  return HostDiscoveryEnvelopeSchema.parse({
    document,
    publicKey: { algorithm: "Ed25519", spki },
    signature,
  });
}

export function signPersonalHostAccessRoute(
  keys: Pick<HostKeyPair, "privateKey" | "publicKey">,
  input: PersonalHostAccessRouteDocument,
): PersonalHostAccessRouteEnvelope {
  const document = PersonalHostAccessRouteDocumentSchema.parse(input);
  const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const signature = sign(
    null,
    personalHostAccessRouteSigningBytes(document),
    keys.privateKey,
  ).toString("base64url");
  return PersonalHostAccessRouteEnvelopeSchema.parse({
    document,
    publicKey: { algorithm: "Ed25519", spki },
    schemaVersion: 1,
    signature,
  });
}

export function signPersonalHostAccountLinkProof(
  keys: Pick<HostKeyPair, "privateKey" | "publicKey">,
  input: PersonalHostAccountLinkProofDocument,
): PersonalHostAccountLinkProofEnvelope {
  const document = PersonalHostAccountLinkProofDocumentSchema.parse(input);
  const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const signature = sign(
    null,
    personalHostAccountLinkProofSigningBytes(document),
    keys.privateKey,
  ).toString("base64url");
  return PersonalHostAccountLinkProofEnvelopeSchema.parse({
    document,
    publicKey: { algorithm: "Ed25519", spki },
    signature,
  });
}

export async function loadOrCreateHostKeys(options: {
  readonly dataDirectory: string;
  readonly privateKeyPath?: string;
  readonly publicKeyPath?: string;
}): Promise<HostKeyPair> {
  if (Boolean(options.privateKeyPath) !== Boolean(options.publicKeyPath)) {
    throw new Error("Host private and public key paths must be provided together");
  }
  const generatedDirectory = resolve(options.dataDirectory, "keys");
  const privateKeyPath = resolve(
    options.privateKeyPath ?? join(generatedDirectory, "host-private.pem"),
  );
  const publicKeyPath = resolve(
    options.publicKeyPath ?? join(generatedDirectory, "host-public.pem"),
  );
  if (!options.privateKeyPath) await mkdir(generatedDirectory, { mode: 0o700, recursive: true });

  let privatePem = await readOptional(privateKeyPath);
  let publicPem = await readOptional(publicKeyPath);
  if (!privatePem && publicPem) {
    throw new Error("Host public key exists without its private key");
  }
  if (!privatePem) {
    const generated = generateKeyPairSync("ed25519");
    privatePem = generated.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    await atomicCreate(privateKeyPath, privatePem, 0o600);
    privatePem = await readFile(privateKeyPath, "utf8");
  }

  const privateKey = createPrivateKey(privatePem);
  const derivedPublic = createPublicKey(privateKey);
  const derivedPublicPem = derivedPublic.export({ format: "pem", type: "spki" }).toString();
  publicPem = await readOptional(publicKeyPath);
  if (!publicPem) {
    await atomicCreate(publicKeyPath, derivedPublicPem, 0o644);
    publicPem = derivedPublicPem;
  }
  const publicKey = createPublicKey(publicPem);
  assertMatchingKeys(privateKey, publicKey);
  await setPrivateFileMode(privateKeyPath);
  return { privateKey, privateKeyPath, publicKey, publicKeyPath, publicKeyPem: publicPem };
}

export const SignedTokenClaimsSchema = z
  .object({
    deploymentId: DeploymentIdSchema,
    exp: z.number().int().positive(),
    hostInstanceId: HostInstanceIdSchema,
    iat: z.number().int().nonnegative(),
    iss: z.literal("opensteer-host"),
    jti: z.uuid(),
  })
  .passthrough();

export interface TokenAuthority {
  readonly deploymentId: DeploymentId;
  readonly hostInstanceId: HostInstanceId;
}

export class SignedTokenService {
  readonly #authority: TokenAuthority;
  readonly #now: () => number;
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;

  constructor(
    keys: Pick<HostKeyPair, "privateKey" | "publicKey">,
    authority: TokenAuthority,
    now: () => number = () => Date.now(),
  ) {
    this.#now = now;
    this.#authority = { ...authority };
    this.#privateKey = keys.privateKey;
    this.#publicKey = keys.publicKey;
  }

  issue(claims: Readonly<Record<string, unknown>>, lifetimeSeconds: number): string {
    if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 86_400) {
      throw new TypeError("Token lifetime must be between 1 and 86400 seconds");
    }
    const now = Math.floor(this.#now() / 1_000);
    const payload = Buffer.from(
      JSON.stringify({
        ...claims,
        deploymentId: this.#authority.deploymentId,
        exp: now + lifetimeSeconds,
        hostInstanceId: this.#authority.hostInstanceId,
        iat: now,
        iss: "opensteer-host",
        jti: randomUUID(),
      }),
    ).toString("base64url");
    const signingInput = `${TOKEN_HEADER}.${payload}`;
    const signature = sign(null, Buffer.from(signingInput), this.#privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  deriveSecret(namespace: string, identity: string): string {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(namespace) || !identity || identity.length > 1_024) {
      throw new TypeError("Secret derivation input is invalid");
    }
    return sign(
      null,
      Buffer.from(`opensteer-secret\0${namespace}\0${identity}`, "utf8"),
      this.#privateKey,
    ).toString("base64url");
  }

  verify<T>(token: string, schema: z.ZodType<T>): T {
    if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) throw invalidToken();
    const parts = token.split(".");
    if (parts.length !== 3) throw invalidToken();
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (!encodedHeader || !encodedPayload || !encodedSignature) throw invalidToken();
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    let signature: Buffer;
    try {
      signature = Buffer.from(encodedSignature, "base64url");
    } catch {
      throw invalidToken();
    }
    if (!verify(null, Buffer.from(signingInput), this.#publicKey, signature)) throw invalidToken();

    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      throw invalidToken();
    }
    if (
      typeof header !== "object" ||
      header === null ||
      !("alg" in header) ||
      header.alg !== "EdDSA" ||
      !("typ" in header) ||
      header.typ !== "JWT" ||
      !("v" in header) ||
      header.v !== 1
    ) {
      throw invalidToken();
    }
    const base = SignedTokenClaimsSchema.safeParse(payload);
    if (!base.success || base.data.exp <= Math.floor(this.#now() / 1_000)) throw invalidToken();
    if (
      base.data.deploymentId !== this.#authority.deploymentId ||
      base.data.hostInstanceId !== this.#authority.hostInstanceId
    ) {
      throw invalidToken();
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw invalidToken();
    return parsed.data;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicCreate(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  try {
    await writeFile(path, content, { flag: "wx", mode });
  } catch (error) {
    if (!(isNodeError(error) && error.code === "EEXIST")) throw error;
  }
}

function assertMatchingKeys(privateKey: KeyObject, publicKey: KeyObject): void {
  const challenge = Buffer.from("opensteer-host-key-pair");
  const signature = sign(null, challenge, privateKey);
  if (!verify(null, challenge, publicKey, signature))
    throw new Error("Host key pair does not match");
}

function invalidToken(): OpensteerError {
  return new OpensteerError({ code: "unauthorized", message: "Invalid or expired signed token" });
}
