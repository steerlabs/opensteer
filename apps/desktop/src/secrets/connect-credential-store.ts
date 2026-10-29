import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import {
  ConnectCredentialResponseSchema,
  ConnectOperationIdSchema,
} from "@opensteer/control-plane-protocol";
import { hostAuthorityIdentityMatches, hostKeyFingerprint } from "@opensteer/deployment-authority";
import { z } from "zod";
import {
  desktopConnectSecretsPath,
  prepareDesktopDeploymentDirectories,
  preparePrivateDesktopDeploymentDirectories,
} from "../app/application-paths.js";
import {
  PersonalHostRuntimeRecordSchema,
  assertSamePersonalHostAuthority,
  type PersonalHostRuntimeRecord,
} from "../supervisor/personal-host-runtime.js";
import { ProtectedJsonFile, type DesktopSecretCryptography } from "./protected-json-file.js";
import type { DesktopPrivateFilesystem } from "./desktop-private-files.js";

const maximumConnectFileBytes = 128 * 1_024;
const maximumConnectPlaintextBytes = 96 * 1_024;

export const DesktopConnectPendingOperationSchema = z.strictObject({
  kind: z.enum(["provision", "rotate", "revoke"]),
  operationId: ConnectOperationIdSchema,
});

export const DesktopConnectCredentialStateSchema = z
  .strictObject({
    authority: PersonalHostRuntimeRecordSchema,
    credential: ConnectCredentialResponseSchema.nullable(),
    desiredState: z.enum(["disabled", "enabled", "rotating"]),
    pendingOperation: DesktopConnectPendingOperationSchema.nullable(),
    schemaVersion: z.literal(2),
  })
  .superRefine((state, context) => {
    const operation = state.pendingOperation;
    if (state.desiredState === "disabled" && operation?.kind !== "revoke") {
      context.addIssue({
        code: "custom",
        message: "A disabled Connect record must contain its pending revoke operation",
        path: ["pendingOperation"],
      });
    }
    if (state.desiredState === "enabled" && state.credential === null) {
      if (operation?.kind !== "provision") {
        context.addIssue({
          code: "custom",
          message: "An enabled Connect record without a credential must be provisioning",
          path: ["pendingOperation"],
        });
      }
    }
    if (operation?.kind === "provision" && state.credential !== null) {
      context.addIssue({
        code: "custom",
        message: "A provisioning Connect record cannot contain an earlier credential",
        path: ["credential"],
      });
    }
    if (operation?.kind === "rotate") {
      if (state.credential === null) {
        context.addIssue({
          code: "custom",
          message: "Connect credential rotation requires the current credential",
          path: ["credential"],
        });
      }
      if (state.desiredState !== "rotating") {
        context.addIssue({
          code: "custom",
          message: "A Connect rotate operation requires rotating intent",
          path: ["desiredState"],
        });
      }
    } else if (state.desiredState === "rotating") {
      context.addIssue({
        code: "custom",
        message: "Rotating Connect intent requires its pending rotate operation",
        path: ["pendingOperation"],
      });
    }
    if (operation?.kind === "revoke" && state.desiredState !== "disabled") {
      context.addIssue({
        code: "custom",
        message: "A Connect revoke operation requires a disabled desired state",
        path: ["desiredState"],
      });
    }
    if (state.credential && !credentialMatchesAuthority(state.credential, state.authority)) {
      context.addIssue({
        code: "custom",
        message: "The Connect credential does not belong to its stored Host authority",
        path: ["credential"],
      });
    }
  });
export type DesktopConnectCredentialState = z.infer<typeof DesktopConnectCredentialStateSchema>;

/** Rebuildable connector credential cache: obsolete versions reset disabled. */
export class DesktopConnectCredentialStore {
  readonly #cryptography: DesktopSecretCryptography;
  readonly #dataDirectory: string;
  readonly #files = new Map<DeploymentId, ProtectedJsonFile<DesktopConnectCredentialState>>();
  readonly #platform: NodeJS.Platform | undefined;
  readonly #privateFiles: DesktopPrivateFilesystem | undefined;
  readonly #tails = new Map<DeploymentId, Promise<void>>();

  constructor(options: {
    readonly cryptography: DesktopSecretCryptography;
    readonly dataDirectory: string;
    readonly platform?: NodeJS.Platform;
    readonly privateFiles?: DesktopPrivateFilesystem;
  }) {
    this.#cryptography = options.cryptography;
    this.#dataDirectory = options.dataDirectory;
    this.#platform = options.platform;
    this.#privateFiles = options.privateFiles;
  }

  filePath(deploymentId: DeploymentId | string): string {
    return desktopConnectSecretsPath(this.#dataDirectory, DeploymentIdSchema.parse(deploymentId));
  }

  load(
    deploymentId: DeploymentId | string,
    currentAuthority?: PersonalHostRuntimeRecord,
  ): Promise<DesktopConnectCredentialState | null> {
    const id = DeploymentIdSchema.parse(deploymentId);
    return this.#serialize(id, async () => {
      const state = await this.#file(id).read();
      if (state && state.authority.discovery.deploymentId !== id) {
        throw new Error("The protected Desktop Connect store belongs to another Deployment.");
      }
      if (state && currentAuthority) {
        assertSamePersonalHostAuthority(state.authority, currentAuthority);
        if (
          JSON.stringify(state.authority.discoveryEnvelope) !==
          JSON.stringify(currentAuthority.discoveryEnvelope)
        ) {
          const migrated = DesktopConnectCredentialStateSchema.parse({
            ...state,
            authority: currentAuthority,
          });
          await this.#file(id).write(migrated);
          return migrated;
        }
      }
      return state;
    });
  }

  save(
    deploymentId: DeploymentId | string,
    input: DesktopConnectCredentialState,
  ): Promise<DesktopConnectCredentialState> {
    const id = DeploymentIdSchema.parse(deploymentId);
    const state = DesktopConnectCredentialStateSchema.parse(input);
    if (state.authority.discovery.deploymentId !== id) {
      throw new Error("A Connect state cannot be written under another Deployment.");
    }
    return this.#serialize(id, async () => {
      if (this.#privateFiles) {
        await preparePrivateDesktopDeploymentDirectories(
          this.#privateFiles,
          this.#dataDirectory,
          id,
        );
      } else {
        prepareDesktopDeploymentDirectories(this.#dataDirectory, id);
      }
      await this.#file(id).write(state);
      return state;
    });
  }

  clear(deploymentId: DeploymentId | string): Promise<void> {
    const id = DeploymentIdSchema.parse(deploymentId);
    return this.#serialize(id, () => this.#file(id).remove());
  }

  #file(deploymentId: DeploymentId): ProtectedJsonFile<DesktopConnectCredentialState> {
    let file = this.#files.get(deploymentId);
    if (!file) {
      file = new ProtectedJsonFile({
        content: "rebuildable",
        cryptography: this.#cryptography,
        filePath: this.filePath(deploymentId),
        maxFileBytes: maximumConnectFileBytes,
        maxPlaintextBytes: maximumConnectPlaintextBytes,
        messages: {
          protectedState: "The Desktop Connect state",
          protectedStore: "The protected Desktop Connect store",
        },
        ...(this.#platform === undefined ? {} : { platform: this.#platform }),
        ...(this.#privateFiles === undefined ? {} : { privateFiles: this.#privateFiles }),
        schema: DesktopConnectCredentialStateSchema,
      });
      this.#files.set(deploymentId, file);
    }
    return file;
  }

  #serialize<T>(deploymentId: DeploymentId, operation: () => Promise<T>): Promise<T> {
    const tail = this.#tails.get(deploymentId) ?? Promise.resolve();
    const result = tail.then(operation, operation);
    const next = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(deploymentId, next);
    void next.finally(() => {
      if (this.#tails.get(deploymentId) === next) this.#tails.delete(deploymentId);
    });
    return result;
  }
}

function credentialMatchesAuthority(
  credential: z.infer<typeof ConnectCredentialResponseSchema>,
  authority: z.infer<typeof PersonalHostRuntimeRecordSchema>,
): boolean {
  const discovery = authority.discovery;
  return hostAuthorityIdentityMatches(
    discovery,
    hostKeyFingerprint(authority.discoveryEnvelope.publicKey.spki),
    credential,
  );
}
