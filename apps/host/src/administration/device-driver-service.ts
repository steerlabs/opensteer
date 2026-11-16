import {
  OpensteerError,
  type AuthSessionId,
  type DeviceId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore, DeviceRemovalEffects } from "@opensteer/database";
import { requirePersonalOwner } from "@opensteer/database";
import type { IphoneScreenAttachCommand, IphoneScreenDetachCommand } from "@opensteer/protocol";
import { deviceMembershipTurn } from "./device-removal.js";

export interface DeviceDriverManagementPort {
  screenDriver(
    runnerId: RunnerId,
  ): { readonly connectionGeneration: number; readonly screenDrivers: 1 } | null;
  withAdmission<T>(deviceId: DeviceId, action: () => Promise<T>): Promise<T>;
  bindingsChanged(deviceId: DeviceId): Promise<void>;
  removed(effects: DeviceRemovalEffects): Promise<void>;
  disableAgentAccess(deviceId: DeviceId): Promise<void>;
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
    return deviceMembershipTurn(this.store, async () => {
      const change = async () => {
        const result =
          command.type === "iphone.screen.attach"
            ? await this.#attach(actor, command)
            : await this.store.detachIphoneScreen({ ...actor, ...command });
        await this.port.bindingsChanged(result.deviceId);
        return { type: command.type, ...result };
      };
      const deviceId =
        command.type === "iphone.screen.detach"
          ? command.deviceId
          : command.target.kind === "existing"
            ? command.target.deviceId
            : null;
      return deviceId ? this.port.withAdmission(deviceId, change) : change();
    });
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
