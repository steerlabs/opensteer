import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  createId,
  type EnvironmentId,
  type StorageAuthorityId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  HostWorkspaceLocalRequestSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  RunnerEnrollmentCredentialSchema,
  RunnerLocalStorageInventorySchema,
  runnerProofFormatVersion,
  type RunnerLocalStorageInventory,
  type RunnerProof,
} from "@opensteer/protocol";
import { createRunnerEnrollmentSignature } from "@opensteer/runner-auth";
import WebSocket from "ws";

/**
 * The disk half of a Runner, for tests that need a Deployment to hold
 * local-directory Workspaces without a real Runner process.
 *
 * It answers the lifecycle messages only — provision, inspect, destroy — by
 * echoing the fence and binding the Host addressed it with, which is exactly
 * what the registry checks before it believes the answer. It serves no bytes:
 * a Files pull is answered with a named failure rather than invented content,
 * so a test that reaches for file content fails where it asked instead of
 * reading a fiction.
 */
export interface LocalWorkspaceDiskFake {
  /** What the Runner's descriptor must advertise for this disk. */
  readonly inventory: RunnerLocalStorageInventory;
  readonly destroyed: readonly WorkspaceId[];
  readonly provisioned: readonly WorkspaceId[];
  readonly storageAuthorityId: StorageAuthorityId;
  readonly stop: () => void;
}

export function attachLocalWorkspaceDisk(
  socket: WebSocket,
  options: { readonly storageAuthorityId?: StorageAuthorityId } = {},
): LocalWorkspaceDiskFake {
  const storageAuthorityId = options.storageAuthorityId ?? createId("storageAuthority");
  const provisioned: WorkspaceId[] = [];
  const destroyed: WorkspaceId[] = [];

  const receive = (frame: WebSocket.RawData) => {
    const parsed = HostWorkspaceLocalRequestSchema.safeParse(JSON.parse(frame.toString()));
    if (!parsed.success) return;
    const request = parsed.data;
    const answered = {
      binding: request.binding,
      fence: request.fence,
      operationId: request.operationId,
      requestId: request.requestId,
    };
    switch (request.type) {
      case "host.workspace.local.provision": {
        provisioned.push(request.binding.workspaceId);
        socket.send(JSON.stringify({ ...answered, type: "runner.workspace.local.provisioned" }));
        return;
      }
      case "host.workspace.local.inspect": {
        socket.send(
          JSON.stringify({
            ...answered,
            health: { status: "ready" },
            type: "runner.workspace.local.inspected",
          }),
        );
        return;
      }
      case "host.workspace.local.destroy": {
        destroyed.push(request.binding.workspaceId);
        socket.send(
          JSON.stringify({
            ...answered,
            receipt: { destroyedAt: new Date().toISOString(), outcome: "destroyed" },
            type: "runner.workspace.local.destroyed",
          }),
        );
        return;
      }
      case "host.workspace.local.files.list":
      case "host.workspace.local.files.read": {
        socket.send(
          JSON.stringify({
            error: {
              code: "not-found",
              message: "This test disk holds no files.",
              retryable: false,
            },
            fence: request.fence,
            operationId: request.operationId,
            requestId: request.requestId,
            type: "runner.workspace.local.error",
          }),
        );
        return;
      }
    }
  };

  socket.on("message", receive);
  return {
    destroyed,
    inventory: RunnerLocalStorageInventorySchema.parse({
      bindings: [],
      storageAuthorityId,
      truncated: false,
    }),
    provisioned,
    stop: () => socket.off("message", receive),
    storageAuthorityId,
  };
}

/**
 * A whole fake Runner that holds its own directories: it opens the enrollment
 * socket, answers the challenge with a real Ed25519 proof, and stays attached
 * answering for its disk. It advertises no AI engines, because what a caller
 * wants from it is a machine that can hold a Workspace.
 */
export interface LocalWorkspaceRunnerFake extends LocalWorkspaceDiskFake {
  readonly close: () => void;
  readonly environmentId: EnvironmentId;
  readonly socket: WebSocket;
}

export async function connectLocalWorkspaceRunner(input: {
  readonly enrollmentToken: string;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly origin: string;
  readonly runnerKind: "main" | "local";
}): Promise<LocalWorkspaceRunnerFake> {
  const socket = new WebSocket(`${input.origin.replace(/^http/u, "ws")}/internal/v1/runners`);
  const challenged = waitForMessage(socket, "host.challenge");
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const challenge = RunnerChallengeSchema.parse(await challenged);
  const disk = attachLocalWorkspaceDisk(socket);
  const descriptor = RunnerDescriptorSchema.parse({
    bootId: `rbt_${randomUUID()}`,
    capabilities: ["filesystem"],
    modules: {
      agents: {
        environmentIds: [input.environmentId],
        harnessDrivers: [],
        localStorage: disk.inventory,
        maxConcurrentRuns: 2,
        providerStateModes: ["ambient", "isolated"],
        workspaceBackings: ["local-directory"],
        workspaceMounts: [],
      },
    },
    name: input.name,
    runnerId: createId("runner"),
    runnerKind: input.runnerKind,
    runtimeVersion: "test",
  });
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const credential = RunnerEnrollmentCredentialSchema.parse({
    enrollmentToken: input.enrollmentToken,
    kind: "host-enrollment-token",
  });
  const welcomed = waitForMessage(socket, "host.welcome");
  socket.send(
    JSON.stringify({
      challengeId: challenge.challengeId,
      credential,
      descriptor,
      proofFormatVersion: runnerProofFormatVersion,
      publicKeyPem,
      signature: createRunnerEnrollmentSignature(pair.privateKey, {
        challenge,
        credential,
        descriptor,
        publicKeyPem,
      }),
      type: "runner.enroll",
    } satisfies RunnerProof),
  );
  const welcome = (await welcomed) as unknown as {
    readonly bootId: string;
    readonly connectionGeneration: number;
    readonly connectionId: string;
    readonly connectionLeaseId: string;
    readonly runnerId: string;
  };
  // A Runner states the Runs it holds before the Host sends it any work.
  socket.send(
    JSON.stringify({
      bootId: welcome.bootId,
      complete: true,
      connectionGeneration: welcome.connectionGeneration,
      connectionId: welcome.connectionId,
      connectionLeaseId: welcome.connectionLeaseId,
      executions: [],
      runnerId: welcome.runnerId,
      type: "runner.executions.attach",
    }),
  );
  return {
    ...disk,
    close: () => {
      disk.stop();
      socket.close();
    },
    environmentId: input.environmentId,
    socket,
  };
}

function waitForMessage(socket: WebSocket, type: string): Promise<{ readonly type: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 15_000);
    const receive = (frame: WebSocket.RawData) => {
      const message = JSON.parse(frame.toString()) as { readonly type: string };
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", receive);
      resolve(message);
    };
    socket.on("message", receive);
  });
}
