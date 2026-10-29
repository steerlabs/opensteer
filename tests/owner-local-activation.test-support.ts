import { createPublicKey } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopUseComputerViewInput } from "../packages/protocol/src/desktop.js";
import { DesktopUseComputerViewResultSchema } from "../packages/protocol/src/desktop.js";
import { ComputerAppApprovalService } from "../apps/desktop/src/computer-app-approval-service.js";
import { PersonalDeploymentSupervisor } from "../apps/desktop/src/supervisor/personal-deployment-supervisor.js";
import { handleUseComputerViewOnThisMac } from "../apps/desktop/src/bridge/methods/computer-use.js";
import type { DesktopBridgeContext } from "../apps/desktop/src/bridge/context.js";
import type { ComputerUseService } from "../apps/desktop/src/computer-use/computer-use-service.js";
import type { connectComputerAppMachine } from "../apps/host/src/runtime/computer-apps.test-support.js";

/** Real enrollment-file verification and Desktop handler, without Electron or OS activation. */
export async function localActivationJourney(
  directory: string,
  deploymentId: string,
  computer: Awaited<ReturnType<typeof connectComputerAppMachine>>,
  desktop: ComputerUseService,
) {
  const runnerDataDirectory = path.join(directory, "personal-runner");
  await mkdir(runnerDataDirectory, { recursive: true, mode: 0o700 });
  const identity = {
    version: 3,
    createdAt: new Date().toISOString(),
    environmentId: null,
    runnerId: computer.runnerId,
    lastConnectionGeneration: computer.primary.fence.connectionGeneration,
    privateKeyPem: computer.primary.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: createPublicKey(computer.primary.privateKey)
      .export({ format: "pem", type: "spki" })
      .toString(),
  };
  const writeIdentity = (enrolled: boolean) =>
    writeFile(
      path.join(runnerDataDirectory, "identity.json"),
      JSON.stringify({
        ...identity,
        lastConnectionGeneration: enrolled ? identity.lastConnectionGeneration : 0,
      }),
      { mode: 0o600 },
    );
  await writeIdentity(true);
  const diagnostics: { event: string; message: string }[] = [];
  const supervisor = new PersonalDeploymentSupervisor({
    baseEnvironment: { PATH: "/usr/bin:/bin" },
    workspaceRoot: directory,
    releaseDirectory: directory,
    files: {
      load: async () => ({ deploymentId, runnerId: computer.runnerId }),
      prepare: async () => ({ runnerDataDirectory }),
    },
  } as unknown as ConstructorParameters<typeof PersonalDeploymentSupervisor>[0]);
  const calls: string[] = [];
  const approvals = new ComputerAppApprovalService({
    local: {
      checkComputerUseRunnerTarget: async () => {
        calls.push("slot");
        throw new Error("No slot on this Personal Mac");
      },
    },
    personal: {
      status: { deploymentId },
      checkComputerUseRunnerTarget: async (deployment: string, runner: string) => {
        calls.push("personal");
        return supervisor.checkComputerUseRunnerTarget(deployment, runner);
      },
    },
  } as unknown as ConstructorParameters<typeof ComputerAppApprovalService>[0]);
  let key = "personal-owner-attachment";
  let selectedDeployment = deploymentId;
  let changeDuringCheck = false;
  let routeError: Error | null = null;
  let malformedResult = false;
  const context = {
    options: {
      bridgeToken: "isolated-owner-activation",
      runner: {
        status: async () => ({ available: true, runner: { state: "stopped", runnerId: null } }),
      },
      hostTransport: {
        current: async () => {
          if (routeError) throw routeError;
          return { resolved: { deploymentId: selectedDeployment, key } };
        },
      },
      computerUse: {
        onActivationError: (error: unknown) => {
          diagnostics.push({
            event: "desktop.computer-use.activation-failed",
            message: error instanceof Error ? error.message : String(error),
          });
        },
        checkLocalComputerViewTarget: async (deployment: string, runner: string) => {
          const target = await approvals.checkComputerUseRunnerTarget(deployment, runner);
          if (changeDuringCheck) key = "replaced-attachment";
          return target;
        },
        useComputerViewOnThisMac: (input: DesktopUseComputerViewInput) =>
          malformedResult ? { activated: "invalid" } : desktop.useComputerViewOnThisMac(input),
      },
    },
  } as unknown as DesktopBridgeContext;
  const handler = handleUseComputerViewOnThisMac(context);
  const frame = { url: "app://opensteer/" };
  const event = { senderFrame: frame, sender: { mainFrame: frame } } as unknown as Parameters<
    typeof handler
  >[0];
  return {
    calls,
    diagnostics,
    routeFailure: (error: Error | null) => {
      routeError = error;
    },
    invalidResult: (invalid: boolean) => {
      malformedResult = invalid;
    },
    writeIdentity,
    unreadableIdentity: async () => {
      const file = path.join(runnerDataDirectory, "identity.json");
      await rm(file);
      await mkdir(file);
    },
    restoreIdentity: async () => {
      await rm(path.join(runnerDataDirectory, "identity.json"), { recursive: true });
      await writeIdentity(true);
    },
    changeDuringCheck: () => {
      changeDuringCheck = true;
    },
    select: (deployment: string) => {
      selectedDeployment = deployment;
    },
    invoke: async (input: DesktopUseComputerViewInput) =>
      DesktopUseComputerViewResultSchema.parse(
        await handler(event, { bridgeToken: "isolated-owner-activation", input }),
      ),
  };
}
