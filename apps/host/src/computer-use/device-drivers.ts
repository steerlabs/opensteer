import {
  OpensteerError,
  DeviceIdSchema,
  isPhoneDisplayDefinitionId,
  iphoneScreenDefinitionId,
  type DeviceId,
  type DeviceDriverIdentity,
} from "@opensteer/core";
import type { DeviceDriverRecord } from "@opensteer/database";
import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import type { RunnerAuxiliaryFrameFence } from "@opensteer/protocol";

export interface DeviceDriverRoute extends DeviceDriverIdentity {
  readonly auxiliaryFence: RunnerAuxiliaryFrameFence;
}
interface DeviceTarget {
  readonly id: DeviceId;
  readonly removedAt: Date | null;
  readonly platform: string | null;
  readonly kind: string;
  readonly name?: string;
}
interface Options {
  readonly store: {
    getDevice(deviceId: DeviceId): Promise<DeviceTarget | null>;
    listDeviceDrivers(input?: {
      deviceId?: DeviceId;
      includeDetached?: boolean;
    }): Promise<readonly DeviceDriverRecord[]>;
  };
  readonly invalidated?: (binding: DeviceDriverIdentity) => void;
}

/** Durable placement only; live transport and approval remain separate authorities. */
export class DeviceDriverResolver {
  readonly #options: Options;
  readonly #bindings = new Map<DeviceId, readonly DeviceDriverIdentity[]>();
  readonly #devices = new Map<DeviceId, DeviceTarget>();
  #screenDrivers: readonly DeviceDriverRecord[] = [];
  readonly #turns = new KeyedMutationQueue();
  readonly #refresh = new MutationQueue();
  #closed = false;

  constructor(options: Options) {
    this.#options = options;
  }

  withAdmission<T>(deviceId: DeviceId, action: () => Promise<T>): Promise<T> {
    return this.#turns.run(deviceId, action);
  }

  withAdmissions<T>(ids: readonly DeviceId[], action: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(ids)].sort();
    const enter = (index: number): Promise<T> =>
      index === sorted.length
        ? action()
        : this.withAdmission(sorted[index]!, () => enter(index + 1));
    return enter(0);
  }

  refresh(): Promise<void> {
    return this.#refresh.run(async () => {
      const drivers = await this.#options.store.listDeviceDrivers({ includeDetached: true });
      const ids = [...new Set(drivers.map((driver) => driver.deviceId))];
      const devices = await Promise.all(ids.map((id) => this.#options.store.getDevice(id)));
      if (this.#closed) return;
      this.#screenDrivers = drivers.filter((driver) => driver.role === "screen");
      const next = new Map<DeviceId, DeviceDriverIdentity[]>();
      this.#devices.clear();
      for (const device of devices)
        if (device && !device.removedAt) this.#devices.set(device.id, device);
      for (const driver of drivers) {
        if (driver.detachedAt || !this.#devices.has(driver.deviceId)) continue;
        const entries = next.get(driver.deviceId) ?? [];
        entries.push({
          deviceId: driver.deviceId,
          role: driver.role,
          runnerId: driver.runnerId,
          generation: driver.generation,
        });
        next.set(driver.deviceId, entries);
      }
      const previous = [...this.#bindings.values()].flat();
      this.#bindings.clear();
      for (const [id, bindings] of next) this.#bindings.set(id, bindings);
      for (const binding of previous)
        if (!this.current(binding)) this.#options.invalidated?.(binding);
    });
  }

  refreshDevice(deviceId: DeviceId): Promise<void> {
    return this.#refresh.run(async () => {
      const [device, drivers] = await Promise.all([
        this.#options.store.getDevice(deviceId),
        this.#options.store.listDeviceDrivers({ deviceId }),
      ]);
      if (this.#closed) return;
      const previous = this.#bindings.get(deviceId) ?? [];
      const next =
        device && !device.removedAt
          ? drivers
              .filter((driver) => driver.deviceId === deviceId && !driver.detachedAt)
              .map(({ detachedAt: _detachedAt, ...binding }) => binding)
          : [];
      if (device && !device.removedAt) this.#devices.set(deviceId, device);
      else this.#devices.delete(deviceId);
      this.#bindings.set(deviceId, next);
      for (const binding of previous)
        if (!this.current(binding)) this.#options.invalidated?.(binding);
    });
  }

  binding(deviceId: DeviceId, definitionId?: string): DeviceDriverIdentity {
    const device = this.#devices.get(deviceId);
    const role =
      definitionId === iphoneScreenDefinitionId ||
      (definitionId === undefined &&
        !this.#bindings.get(deviceId)?.some((binding) => binding.role === "self"))
        ? "screen"
        : "self";
    const binding = this.#bindings.get(deviceId)?.find((binding) => binding.role === role);
    if (
      this.#closed ||
      !device ||
      !binding ||
      (role === "screen" && (device.platform !== "ios" || device.kind !== "phone")) ||
      (isPhoneDisplayDefinitionId(definitionId) && role === "self" && device.platform !== "android")
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "This Device has no driver for that capability.",
      });
    return binding;
  }

  async resolve(deviceId: DeviceId, definitionId?: string): Promise<DeviceDriverIdentity> {
    await this.refreshDevice(deviceId);
    return this.binding(deviceId, definitionId);
  }

  current(binding: DeviceDriverIdentity): boolean {
    return (
      !this.#closed &&
      !!this.#bindings
        .get(binding.deviceId)
        ?.some(
          (other) =>
            other.role === binding.role &&
            other.runnerId === binding.runnerId &&
            other.generation === binding.generation,
        )
    );
  }

  name(deviceId: DeviceId): string {
    return this.#devices.get(deviceId)?.name ?? "Phone";
  }

  bindings(): readonly DeviceDriverIdentity[] {
    return [...this.#bindings.values()].flat();
  }
  retainedScreenDeviceIds(runnerId: DeviceDriverIdentity["runnerId"]): DeviceId[] {
    return [
      ...new Set(
        this.#screenDrivers
          .filter((driver) => driver.runnerId === runnerId && this.#devices.has(driver.deviceId))
          .map((driver) => driver.deviceId),
      ),
    ];
  }
  close(): void {
    this.#closed = true;
    this.#bindings.clear();
    this.#devices.clear();
  }
}

export type DeviceComputerConnection =
  | import("@opensteer/integration-core").DeviceIntegrationConnectionSummary
  | import("@opensteer/integration-core").IntegrationConnectionSummary;
export function computerConnectionDeviceId(connection: DeviceComputerConnection): DeviceId | null {
  const computer = connection.computer;
  if (!computer) return null;
  return "deviceId" in computer ? computer.deviceId : DeviceIdSchema.parse(computer.runnerId);
}
export interface DeviceDisplayAuthorization {
  readonly deviceId: DeviceId;
  readonly route?: DeviceDriverRoute | undefined;
}

export function deviceDriverWelcomeFeatures(
  stream: Pick<import("@opensteer/orchestration").RunnerAuxiliaryStream, "fence" | "identity">,
): { readonly screenDrivers?: 1 } {
  const module = stream.identity.modules.integrations;
  return stream.fence.module === "integrations" &&
    module?.platform === "darwin" &&
    module.screenDrivers === 1
    ? { screenDrivers: 1 }
    : {};
}

export function sameDeviceDriver(
  left: DeviceDriverIdentity | undefined,
  right: DeviceDriverIdentity,
): boolean {
  return (
    left?.deviceId === right.deviceId &&
    left.role === right.role &&
    left.runnerId === right.runnerId &&
    left.generation === right.generation
  );
}
