import {
  OpensteerError,
  androidPhoneDefinitionId,
  type DeviceId,
  type PhoneDisplayDefinitionId,
  type UserId,
} from "@opensteer/core";
import type { IntegrationPlatformStore } from "@opensteer/database";
import type { ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import {
  type ComputerUseService,
  type ComputerUseMachineOption,
  type ComputerUseHolding,
  type ComputerUseScope,
  type ComputerUseTarget,
  type ComputerUseDispatchResult,
} from "../computer-use/computer-use-service.js";
import {
  ComputerUseInstalledAppsParamsSchema,
  getPhoneDisplayCodec,
  PhoneDisplayObservationResultSchema,
  PhoneDisplayInstalledAppsResultSchema,
  PhoneDisplayInstalledAppsParamsSchema,
  type PhoneDisplayObservation,
  type PhoneDisplayInstalledAppsParams,
  type PhoneDisplayInstalledAppsResult,
  type ComputerUseInstalledAppsParams,
  type ComputerUseInstalledAppsResultSchema,
  type DeviceAvailability,
  type PhoneDisplayView,
} from "@opensteer/protocol";
import type { IntegrationAccess } from "@opensteer/integration-core";
import type { z } from "zod";

export interface DeviceComputerOption extends Omit<ComputerUseMachineOption, "runnerId"> {
  readonly deviceId: DeviceId;
  readonly definitionId: "macos-app" | PhoneDisplayDefinitionId;
  readonly availability?: DeviceAvailability;
  readonly setup?: PhoneDisplayView["setup"];
}
export type DeviceComputerScope =
  | Exclude<ComputerUseScope, { kind: "display" }>
  | { readonly kind: "display"; readonly definitionId: PhoneDisplayDefinitionId };
export type DeviceComputerTarget = DeviceComputerScope & { readonly access: IntegrationAccess };
export type DeviceComputerResult =
  | Exclude<ComputerUseDispatchResult, { kind: "display" }>
  | (Omit<Extract<ComputerUseDispatchResult, { kind: "display" }>, "observation"> & {
      readonly observation: PhoneDisplayObservation | null;
    });
type Dispatch = Omit<Awaited<ReturnType<ComputerUseService["sendObserve"]>>, "settle"> & {
  settle(): Promise<DeviceComputerResult>;
};

export interface DeviceComputerUseGateway extends Pick<
  ComputerUseService,
  "stop" | "threadTitle" | "release"
> {
  eligibleInventory(owner: UserId): Promise<{
    readonly machines: readonly DeviceComputerOption[];
    readonly phones: readonly DeviceComputerOption[];
  }>;
  eligibleMachines(
    owner: UserId,
    definition: "macos-app" | PhoneDisplayDefinitionId,
  ): Promise<readonly DeviceComputerOption[]>;
  resolveApp(
    input: Omit<Parameters<ComputerUseService["resolveApp"]>[0], "runnerId"> & {
      readonly deviceId: DeviceId;
    },
  ): ReturnType<ComputerUseService["resolveApp"]>;
  installedApps(
    deviceId: DeviceId,
    owner: UserId,
    params: ComputerUseInstalledAppsParams,
  ): Promise<z.infer<typeof ComputerUseInstalledAppsResultSchema>>;
  installedApps(
    deviceId: DeviceId,
    owner: UserId,
    params: PhoneDisplayInstalledAppsParams,
    definition: PhoneDisplayDefinitionId,
  ): Promise<PhoneDisplayInstalledAppsResult>;
  holders(deviceId: DeviceId): Promise<ReturnType<ComputerUseService["holders"]>>;
  closeForConnection(deviceId: DeviceId, holding: ComputerUseHolding): Promise<void>;
  prepare(
    machine: {
      readonly deviceId: DeviceId;
      readonly deviceName: string;
      readonly ownerUserId: UserId;
    },
    context: Parameters<ComputerUseService["prepare"]>[1],
  ): ReturnType<ComputerUseService["prepare"]>;
  releaseSession(
    context: Parameters<ComputerUseService["releaseSession"]>[0],
    deviceId: DeviceId,
  ): Promise<boolean>;
  sendObserve(
    lease: Parameters<ComputerUseService["sendObserve"]>[0],
    target: DeviceComputerTarget,
    ...rest: Parameters<ComputerUseService["sendObserve"]> extends [unknown, unknown, ...infer Rest]
      ? Rest
      : never
  ): Promise<Dispatch>;
  sendAct(
    lease: Parameters<ComputerUseService["sendAct"]>[0],
    target: DeviceComputerTarget,
    ...rest: Parameters<ComputerUseService["sendAct"]> extends [unknown, unknown, ...infer Rest]
      ? Rest
      : never
  ): Promise<Dispatch>;
  sendWindowOperation(
    lease: Parameters<ComputerUseService["sendWindowOperation"]>[0],
    target: DeviceComputerTarget,
    ...rest: Parameters<ComputerUseService["sendWindowOperation"]> extends [
      unknown,
      unknown,
      ...infer Rest,
    ]
      ? Rest
      : never
  ): Promise<Dispatch>;
}
export interface DeviceComputerAppsPort {
  availability?(deviceId: DeviceId): Promise<DeviceAvailability | null>;
  withAdmission<T>(deviceId: DeviceId, action: () => Promise<T>): Promise<T>;
  appStatus(
    deviceId: DeviceId,
    definitionId: string,
  ): Promise<ReturnType<ComputerAppHub["appStatus"]>>;
  attached(deviceId: DeviceId): Promise<boolean>;
  reportsApp(
    deviceId: DeviceId,
    definitionId: string,
  ): Promise<ReturnType<ComputerAppHub["reportsApp"]>>;
  compatibilityReason(deviceId: DeviceId): Promise<string | null>;
  requireAgentAccess(deviceId: DeviceId): Promise<void>;
}
export type LegacyComputerUseGateway = Pick<
  ComputerUseService,
  | "closeForConnection"
  | "eligibleMachines"
  | "eligibleInventory"
  | "holders"
  | "installedApps"
  | "resolveApp"
  | "stop"
  | "threadTitle"
  | "prepare"
  | "release"
  | "releaseSession"
  | "sendAct"
  | "sendObserve"
  | "sendWindowOperation"
>;
export function selfComputerApps(
  store: Pick<IntegrationPlatformStore, "requireDeviceSelfRunnerId">,
  hub: Pick<
    ComputerAppHub,
    | "withRunnerAdmission"
    | "appStatus"
    | "attached"
    | "reportsApp"
    | "compatibilityReason"
    | "requireAgentAccess"
  >,
): DeviceComputerAppsPort {
  const self = (id: DeviceId) => store.requireDeviceSelfRunnerId(id);
  return {
    withAdmission: async (id, action) => hub.withRunnerAdmission(await self(id), action),
    appStatus: async (id, definition) => hub.appStatus(await self(id), definition),
    attached: async (id) => hub.attached(await self(id)),
    reportsApp: async (id, definition) => hub.reportsApp(await self(id), definition),
    compatibilityReason: async (id) => hub.compatibilityReason(await self(id)),
    requireAgentAccess: async (id) => hub.requireAgentAccess(await self(id)),
  };
}

export function selfComputerUse(
  store: Pick<IntegrationPlatformStore, "requireSelfDeviceId" | "requireDeviceSelfRunnerId">,
  service: LegacyComputerUseGateway,
): DeviceComputerUseGateway {
  const inventory = async (owner: UserId) => {
    const result = await service.eligibleInventory(owner);
    const project = (
      rows: readonly ComputerUseMachineOption[],
      definitionId: DeviceComputerOption["definitionId"],
    ) =>
      Promise.all(
        rows.map(async ({ runnerId, ...row }) => ({
          ...row,
          deviceId: await store.requireSelfDeviceId(runnerId),
          definitionId,
        })),
      );
    return {
      machines: await project(result.machines, "macos-app"),
      phones: await project(result.phones, androidPhoneDefinitionId),
    };
  };
  const target = (value: DeviceComputerTarget): ComputerUseTarget => {
    if (value.kind === "display" && value.definitionId !== androidPhoneDefinitionId)
      throw new OpensteerError({
        code: "forbidden",
        message: "This screen requires its assigned Device driver.",
      });
    return value.kind === "app" ? value : { ...value, definitionId: androidPhoneDefinitionId };
  };
  const dispatch = async (
    value: ReturnType<ComputerUseService["sendObserve"]>,
  ): Promise<Dispatch> => {
    const result = await value;
    return {
      ...result,
      settle: async () => {
        const answer = await result.settle();
        return answer.kind === "app"
          ? answer
          : {
              ...answer,
              observation: answer.observation
                ? PhoneDisplayObservationResultSchema.parse(
                    getPhoneDisplayCodec(androidPhoneDefinitionId).decodeResult("observe", {
                      observation: answer.observation,
                    }),
                  ).observation
                : null,
            };
      },
    };
  };
  async function installedApps(
    id: DeviceId,
    owner: UserId,
    params: ComputerUseInstalledAppsParams,
  ): Promise<z.infer<typeof ComputerUseInstalledAppsResultSchema>>;
  async function installedApps(
    id: DeviceId,
    owner: UserId,
    params: PhoneDisplayInstalledAppsParams,
    definition: PhoneDisplayDefinitionId,
  ): Promise<PhoneDisplayInstalledAppsResult>;
  async function installedApps(
    id: DeviceId,
    owner: UserId,
    params: ComputerUseInstalledAppsParams | PhoneDisplayInstalledAppsParams,
    definition?: PhoneDisplayDefinitionId,
  ): Promise<
    z.infer<typeof ComputerUseInstalledAppsResultSchema> | PhoneDisplayInstalledAppsResult
  > {
    const runner = await store.requireDeviceSelfRunnerId(id);
    if (definition && definition !== androidPhoneDefinitionId)
      throw new OpensteerError({
        code: "forbidden",
        message: "This screen requires its assigned Device driver.",
      });
    return definition
      ? PhoneDisplayInstalledAppsResultSchema.parse(
          getPhoneDisplayCodec(definition).decodeResult(
            "installed_apps",
            await service.installedApps(
              runner,
              owner,
              PhoneDisplayInstalledAppsParamsSchema.parse(params),
              definition,
            ),
          ),
        )
      : service.installedApps(runner, owner, ComputerUseInstalledAppsParamsSchema.parse(params));
  }
  return {
    eligibleInventory: inventory,
    eligibleMachines: async (owner, definition) => {
      const rows = await inventory(owner);
      return (definition === "macos-app" ? rows.machines : rows.phones).filter(
        (row) => row.definitionId === definition,
      );
    },
    resolveApp: async ({ deviceId, ...input }) =>
      service.resolveApp({ ...input, runnerId: await store.requireDeviceSelfRunnerId(deviceId) }),
    installedApps,
    holders: async (id) => service.holders(await store.requireDeviceSelfRunnerId(id)),
    closeForConnection: async (id, holding) => {
      const runner = await store.requireDeviceSelfRunnerId(id);
      service.closeForConnection(runner, holding);
    },
    stop: (id, owner) => service.stop(id, owner),
    threadTitle: (id, owner) => service.threadTitle(id, owner),
    prepare: async ({ deviceId, deviceName, ...machine }, context) =>
      service.prepare(
        {
          ...machine,
          runnerId: await store.requireDeviceSelfRunnerId(deviceId),
          runnerName: deviceName,
        },
        context,
      ),
    release: (lease) => service.release(lease),
    releaseSession: async (context, id) =>
      service.releaseSession(context, await store.requireDeviceSelfRunnerId(id)),
    sendObserve: (lease, value, ...rest) =>
      dispatch(service.sendObserve(lease, target(value), ...rest)),
    sendAct: (lease, value, ...rest) => dispatch(service.sendAct(lease, target(value), ...rest)),
    sendWindowOperation: (lease, value, ...rest) =>
      dispatch(service.sendWindowOperation(lease, target(value), ...rest)),
  };
}
