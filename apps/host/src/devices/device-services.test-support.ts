import type { AesGcmSecretVault } from "@opensteer/access/host";
import { integrationDefinitions } from "@opensteer/integration-catalog";
import type { AgentEvent, RunnerId, UserId } from "@opensteer/core";
import { DeviceService } from "../devices/device-service.js";
import { LocalServerService } from "../local-servers/local-server-service.js";
import { IntegrationPlatformService } from "./integration-platform-service.js";

type ServiceOptions = ConstructorParameters<typeof IntegrationPlatformService>[0];
type DeviceOptions = ConstructorParameters<typeof DeviceService>[0];
type LocalServerOptions = ConstructorParameters<typeof LocalServerService>[0];

/** Everything the three services take, as a test builds them together. */
export type IntegrationPlatformTestOptions = Omit<
  ServiceOptions,
  "devices" | "localServers" | "definitions"
> &
  Omit<
    DeviceOptions,
    "computerApps" | "definitions" | "localServers" | "providerAuthorizations" | "store"
  > &
  Pick<LocalServerOptions, "longRequestHold" | "personal"> & {
    readonly computerApps: DeviceOptions["computerApps"] & LocalServerOptions["computerApps"];
    readonly definitions?: ServiceOptions["definitions"];
    readonly isRunnerConnected: (runnerId: RunnerId) => boolean;
    readonly secretVault: Pick<AesGcmSecretVault, "open" | "seal">;
  };

/** Service integrations with the device and local-server services they reach, as the Host wires them. */
export type IntegrationPlatformTestHarness = IntegrationPlatformService & {
  readonly devices: DeviceService;
  readonly localServers: LocalServerService;
  close(): Promise<void>;
};

export function createIntegrationPlatform(
  options: IntegrationPlatformTestOptions,
): IntegrationPlatformTestHarness {
  const definitions = options.definitions ?? integrationDefinitions;
  const onSettingsChanged =
    options.onSettingsChanged ??
    (async (_input: { installationId?: string; ownerUserId?: UserId }) => undefined);
  const publishRequestEvents = (events: readonly AgentEvent[]) => {
    for (const event of events) options.onDeploymentEvent(event);
    if (events.length > 0) options.onRequestsChanged();
  };
  const localServers = new LocalServerService({
    computerApps: options.computerApps,
    dataDirectory: options.dataDirectory,
    isRunnerConnected: options.isRunnerConnected,
    ...(options.longRequestHold ? { longRequestHold: options.longRequestHold } : {}),
    onConnectionsChanged: options.onConnectionsChanged,
    onSettingsChanged,
    ...(options.personal === undefined ? {} : { personal: options.personal }),
    publishRequestEvents,
    secretVault: options.secretVault,
    store: options.store,
  });
  const devices = new DeviceService({
    ...options,
    definitions,
    localServers,
    onSettingsChanged,
    providerAuthorizations: (ownerUserId) =>
      options.authorizationSource.providerAuthorizations(ownerUserId),
  });
  const platform = new IntegrationPlatformService({
    ...options,
    definitions,
    devices,
    localServers,
    onSettingsChanged,
  });
  return Object.assign(platform, {
    devices,
    localServers,
    close: async () => {
      await devices.close();
      await localServers.close();
    },
  });
}
