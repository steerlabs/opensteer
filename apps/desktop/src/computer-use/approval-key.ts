import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import path from "node:path";
import type { ComputerAppApproval, ComputerAppSetupRequest } from "@opensteer/integration-core";
import {
  canonicalComputerAppApprovalPublicKey,
  computerAppApprovalKeyId,
  createComputerAppApproval,
  signComputerAppApprovalKeyChallenge,
  type ComputerAppApprovalDecision,
} from "@opensteer/runner-auth";
import type {
  ComputerAppApprovalKeyChallenge,
  ComputerAppApprovalKeyProof,
} from "@opensteer/protocol";
import { z } from "zod";
import type { DesktopPrivateFilesystem } from "../secrets/desktop-private-files.js";
import {
  ProtectedJsonFile,
  type DesktopSecretCryptography,
} from "../secrets/protected-json-file.js";

const ApprovalKeyStateSchema = z.strictObject({
  privateKeyPem: z.string().min(1).max(4_096),
  schemaVersion: z.literal(1),
});

/** This desktop's approval key's public half, as the Host pins it. */
export interface ComputerUseApprovalPublicKey {
  readonly keyId: string;
  readonly publicKey: string;
}

/**
 * The key this desktop signs the person's computer-app approvals with.
 *
 * It is not the Runner's key. That one sits in `identity.json`, readable by
 * every process running as the person — which on a Mac includes every agent —
 * so a signature by it proves a process, not a person. This key is generated
 * here, in desktop main, and its private half is stored only through Electron
 * `safeStorage`: encrypted with a key in the login keychain whose access list
 * names this app, so another program cannot decrypt it without the person
 * allowing that in a keychain prompt. It never enters a Runner, a renderer or
 * a file in plaintext.
 *
 * One key serves every Deployment this desktop reaches; the Host pins its
 * public half per Mac when the owner opens that Mac's page here. If protected
 * storage cannot decrypt it, approvals fail closed until the keychain or the
 * stored file is repaired. A transient keychain failure does not rotate the
 * approval authority behind the person's back.
 */
export class ComputerUseApprovalKey {
  readonly #file: ProtectedJsonFile<z.infer<typeof ApprovalKeyStateSchema>>;
  #loading: Promise<{
    readonly privateKey: KeyObject;
    readonly public: ComputerUseApprovalPublicKey;
  }> | null = null;

  constructor(options: {
    readonly cryptography: DesktopSecretCryptography;
    readonly dataDirectory: string;
    readonly platform?: NodeJS.Platform;
    readonly privateFiles?: DesktopPrivateFilesystem;
  }) {
    this.#file = new ProtectedJsonFile({
      content: "critical",
      cryptography: options.cryptography,
      filePath: path.join(path.resolve(options.dataDirectory), "computer-use-approval-key.v1.json"),
      maxFileBytes: 16 * 1_024,
      maxPlaintextBytes: 8 * 1_024,
      messages: {
        protectedState: "The computer use approval key",
        protectedStore: "The protected computer use approval key",
      },
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.privateFiles === undefined ? {} : { privateFiles: options.privateFiles }),
      schema: ApprovalKeyStateSchema,
    });
  }

  async publicKey(): Promise<ComputerUseApprovalPublicKey> {
    return (await this.#load()).public;
  }

  /** The person's answer, over exactly the request the panel showed. */
  async sign(
    request: ComputerAppSetupRequest,
    decision: ComputerAppApprovalDecision = "allow",
  ): Promise<ComputerAppApproval> {
    return createComputerAppApproval(
      (await this.#load()).privateKey,
      request,
      Date.now(),
      decision,
    );
  }

  async prove(challenge: ComputerAppApprovalKeyChallenge): Promise<ComputerAppApprovalKeyProof> {
    return {
      challengeId: challenge.challengeId,
      signature: signComputerAppApprovalKeyChallenge((await this.#load()).privateKey, challenge),
    };
  }

  #load() {
    this.#loading ??= this.#readOrCreate().catch((error: unknown) => {
      // A keychain that refused once may accept the next time it is asked.
      this.#loading = null;
      throw error;
    });
    return this.#loading;
  }

  async #readOrCreate() {
    const stored = await this.#file.read();
    let privateKey: KeyObject;
    if (stored) {
      try {
        privateKey = createPrivateKey(stored.privateKeyPem);
      } catch (error) {
        throw new Error("The protected computer use approval key is invalid.", { cause: error });
      }
    } else {
      privateKey = generateKeyPairSync("ed25519").privateKey;
      await this.#file.write({
        privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        schemaVersion: 1,
      });
    }
    const publicKey = canonicalComputerAppApprovalPublicKey(createPublicKey(privateKey));
    return {
      privateKey,
      public: { keyId: computerAppApprovalKeyId(publicKey), publicKey },
    };
  }
}
