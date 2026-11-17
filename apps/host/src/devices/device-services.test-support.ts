import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AesGcmSecretVault } from "@opensteer/access/host";
import { deviceDefinitions } from "@opensteer/integration-catalog/devices";
import type { RunnerId, UserId } from "@opensteer/core";
import type { CallableIntegrationTool, IntegrationPlatformStore } from "@opensteer/database";
import type { ToolCaller } from "../agents/tool-caller.js";
import { LocalServerRegistry } from "../local-servers/local-server-registry.js";
import { LocalServerService } from "../local-servers/local-server-service.js";
import { AccessRequests } from "./access-requests.js";
import { DeviceService } from "./device-service.js";

type DeviceOptions = ConstructorParameters<typeof DeviceService>[0];
type LocalServerOptions = ConstructorParameters<typeof LocalServerService>[0];

/** Everything the device and local-server services take, as a test builds them together. */
export type DeviceServicesTestOptions = Omit<
  DeviceOptions,
  "computerApps" | "definitions" | "localServers" | "store"
> &
  Pick<LocalServerOptions, "personal"> & {
    readonly computerApps: DeviceOptions["computerApps"] & LocalServerOptions["computerApps"];
    readonly dataDirectory: string;
    readonly definitions?: DeviceOptions["definitions"];
    readonly isRunnerConnected: (runnerId: RunnerId) => boolean;
    readonly secretVault: Pick<AesGcmSecretVault, "open" | "seal">;
    readonly store: IntegrationPlatformStore;
  };

/** The device and local-server services as the Host wires them, with one call path for tests. */
export interface DeviceServicesTestHarness {
  readonly listDiscoveryInventory: DeviceService["listDiscoveryInventory"];
  readonly listCallableTools: DeviceService["listCallableTools"];
  readonly installCatalogDefinition: DeviceService["installDefinition"];
  readonly uninstallIntegration: LocalServerRegistry["uninstall"];
  readonly installAgentPlugin: LocalServerRegistry["installPackage"];
  readonly access: AccessRequests;
  readonly devices: DeviceService;
  readonly localServers: LocalServerService;
  readonly registry: LocalServerRegistry;
  readonly store: IntegrationPlatformStore;
  callTool(
    callable: CallableIntegrationTool,
    args: Readonly<Record<string, unknown>>,
    caller: ToolCaller,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>>;
  close(): Promise<void>;
}

export function createDeviceServices(
  options: DeviceServicesTestOptions,
): DeviceServicesTestHarness {
  const definitions = options.definitions ?? deviceDefinitions;
  const onSettingsChanged =
    options.onSettingsChanged ??
    (async (_input: { installationId?: string; ownerUserId?: UserId }) => undefined);
  const localServers = new LocalServerService({
    computerApps: options.computerApps,
    dataDirectory: options.dataDirectory,
    isRunnerConnected: options.isRunnerConnected,
    onConnectionsChanged: options.onConnectionsChanged,
    onSettingsChanged,
    ...(options.personal === undefined ? {} : { personal: options.personal }),
    secretVault: options.secretVault,
    store: options.store,
  });
  const devices = new DeviceService({ ...options, definitions, localServers, onSettingsChanged });
  const access = new AccessRequests({
    definitions,
    devices,
    onDeploymentEvent: options.onDeploymentEvent,
    store: options.store,
  });
  const registry = new LocalServerRegistry({
    store: options.store,
    dataDirectory: options.dataDirectory,
    devices,
    localServers,
    files: async () => {
      throw new Error("Agent home files are not part of this test");
    },
    onConnectionsChanged: options.onConnectionsChanged,
    onDeploymentEvent: options.onDeploymentEvent,
    onRequestsChanged: options.onRequestsChanged,
    onSettingsChanged,
  });
  return {
    access,
    devices,
    localServers,
    registry,
    store: options.store,
    listDiscoveryInventory: (input) => devices.listDiscoveryInventory(input),
    listCallableTools: (input) => devices.listCallableTools(input),
    installCatalogDefinition: (input) => devices.installDefinition(input),
    uninstallIntegration: (input) => registry.uninstall(input),
    installAgentPlugin: (input) => registry.installPackage(input),
    callTool: (callable, args, caller, signal) =>
      callable.server.transport.type === "computer"
        ? devices.callTool(callable, args, caller, signal)
        : localServers.callTool(callable, args, caller, signal),
    close: async () => {
      await devices.close();
      await localServers.close();
    },
  };
}
