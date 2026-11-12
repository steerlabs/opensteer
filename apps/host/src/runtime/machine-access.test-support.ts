import type { RunnerId, TaskFolder, UserId } from "@opensteer/core";
import type { HostApiClient } from "@opensteer/protocol";
import type { HostConfig } from "@opensteer/config";
import type { PersonalHostRuntime } from "./runtime.js";

export interface MachineAccessHost {
  readonly api: HostApiClient;
  readonly ownerId: UserId;
  readonly hostingComputerId: RunnerId;
  readonly agentHome: TaskFolder;
  readonly origin: URL;
  readonly remoteAccess: boolean;
  readonly runtime: PersonalHostRuntime;
  readonly store: PersonalHostRuntime["store"];
  readonly config: HostConfig;
  readonly ownerHeaders: Readonly<Record<string, string>>;
  readonly hostPort: number;
  close(): Promise<void>;
}
export interface MachineAccessFixtureOptions {
  readonly databaseUrl: string;
  readonly agentHome: TaskFolder;
  readonly remoteAccess?: boolean;
  readonly startPersonal?: (input: {
    readonly databaseUrl: string;
    readonly agentHome: TaskFolder;
    readonly remoteAccess: boolean;
  }) => Promise<MachineAccessHost>;
}
export async function startMachineAccessHost(
  options: MachineAccessFixtureOptions,
): Promise<MachineAccessHost> {
  const start =
    options.startPersonal ??
    (await import("./personal-machine.test-support.js")).startPersonalMachineHost;
  return start({
    databaseUrl: options.databaseUrl,
    agentHome: options.agentHome,
    remoteAccess: options.remoteAccess ?? false,
  });
}
export interface MachineAccessScenario {
  readonly host: MachineAccessHost;
  readonly targetComputerId: RunnerId;
  close(): Promise<void>;
}
export async function startMachineAccessScenario(
  options: MachineAccessFixtureOptions & {
    readonly enrollTarget?: (host: MachineAccessHost) => Promise<RunnerId>;
  },
): Promise<MachineAccessScenario> {
  if (options.remoteAccess !== true)
    throw new Error(
      "A second computer requires explicit remoteAccess:true in the personal fixture",
    );
  if (!options.enrollTarget)
    throw new Error("The machine fixture needs lane I's target enrollment implementation");
  const host = await startMachineAccessHost(options);
  try {
    return { host, targetComputerId: await options.enrollTarget(host), close: () => host.close() };
  } catch (error) {
    await host.close();
    throw error;
  }
}
