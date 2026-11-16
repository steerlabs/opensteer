import {
  OpensteerError,
  type AuthSessionId,
  type DeviceId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { requirePersonalOwner } from "@opensteer/database";
import type { IphoneScreenAttachCommand, IphoneScreenDetachCommand } from "@opensteer/protocol";

export interface DeviceDriverManagementPort {
  screenDriver(
    runnerId: RunnerId,
  ): { readonly connectionGeneration: number; readonly screenDrivers: 1 } | null;
  change<T>(
    input: { readonly deviceIds: readonly DeviceId[]; readonly runnerIds: readonly RunnerId[] },
    commit: () => Promise<T>,
  ): Promise<T>;
}

export class DeviceDriverService {
  readonly store: OpensteerStore;
  readonly port: DeviceDriverManagementPort;
  constructor(store: OpensteerStore, port: DeviceDriverManagementPort) {
    this.store = store;
    this.port = port;
  }

  async execute(
    actor: { readonly userId: UserId; readonly sessionId: AuthSessionId },
    command: IphoneScreenAttachCommand | IphoneScreenDetachCommand,
  ) {
    await requirePersonalOwner(this.store.database, actor.userId);
    const change = async () => {
      const result =
        command.type === "iphone.screen.attach"
          ? await this.#attach(actor, command)
          : await this.store.detachIphoneScreen({ ...actor, ...command });
      return { type: command.type, ...result };
    };
    const deviceId =
      command.type === "iphone.screen.detach"
        ? command.deviceId
        : command.target.kind === "existing"
          ? command.target.deviceId
          : null;
    return this.port.change(
      {
        deviceIds: deviceId ? [deviceId] : [],
        runnerIds: command.type === "iphone.screen.attach" ? [command.driverRunnerId] : [],
      },
      change,
    );
  }

  #attach(
    actor: { readonly userId: UserId; readonly sessionId: AuthSessionId },
    command: IphoneScreenAttachCommand,
  ) {
    const driver = this.port.screenDriver(command.driverRunnerId);
    if (!driver)
      throw new OpensteerError({
        code: "conflict",
        message:
          "Open Opensteer on the Mac connected to this iPhone and update it to support screen drivers.",
      });
    return this.store.attachIphoneScreen({
      ...actor,
      idempotencyKey: command.idempotencyKey,
      driverRunnerId: command.driverRunnerId,
      driverConnectionGeneration: driver.connectionGeneration,
      negotiatedScreenDrivers: driver.screenDrivers,
      target: command.target,
    });
  }
}
