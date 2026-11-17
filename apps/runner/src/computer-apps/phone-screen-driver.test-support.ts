import { vi } from "vitest";
import type { DeviceScreenDriverAssignment } from "@opensteer/protocol";
import type { PhoneScreenDriver, PhoneScreenDriverConnection } from "./phone-screen-driver.js";

export class FakePhoneScreenDriver implements PhoneScreenDriver {
  readonly connections: FakePhoneScreenConnection[] = [];
  readonly shutdown = vi.fn<PhoneScreenDriver["shutdown"]>();
  connect(options: Parameters<PhoneScreenDriver["connect"]>[0]): PhoneScreenDriverConnection {
    const connection = new FakePhoneScreenConnection(options);
    this.connections.push(connection);
    return connection;
  }
}

export class FakePhoneScreenConnection implements PhoneScreenDriverConnection {
  assignments: readonly DeviceScreenDriverAssignment[] = [];
  readonly options: Parameters<PhoneScreenDriver["connect"]>[0];
  constructor(options: Parameters<PhoneScreenDriver["connect"]>[0]) {
    this.options = options;
  }
  readonly replaceAssignments = vi.fn((assignments: readonly DeviceScreenDriverAssignment[]) => {
    this.assignments = assignments;
    for (const assignment of assignments) void this.emitStatus(assignment);
  });
  emitStatus(assignment: DeviceScreenDriverAssignment): Promise<void> {
    return this.options.emit({
      type: "runner.integrations.device-status",
      deviceId: assignment.deviceId,
      driverGeneration: assignment.generation,
      definitionId: "iphone-screen",
      operations: [],
      availability: { state: "ready", reason: null },
      navigationButtons: [],
      actions: [],
      wake: false,
      lock: null,
      displayVersion: null,
      ownerViewVersion: null,
      inputVersion: null,
      powerVersion: null,
    });
  }
  readonly observe = vi.fn<PhoneScreenDriverConnection["observe"]>();
  readonly act = vi.fn<PhoneScreenDriverConnection["act"]>();
  readonly close = vi.fn<PhoneScreenDriverConnection["close"]>(async () => ({}));
  readonly installedApps = vi.fn<PhoneScreenDriverConnection["installedApps"]>(async () => ({
    apps: [],
    total: 0,
  }));
  readonly ownerView = vi.fn<PhoneScreenDriverConnection["ownerView"]>();
  readonly display = vi.fn<PhoneScreenDriverConnection["display"]>();
  readonly cancel = vi.fn<PhoneScreenDriverConnection["cancel"]>();
  readonly stopRecorded = vi.fn<PhoneScreenDriverConnection["stopRecorded"]>();
  readonly detach = vi.fn<PhoneScreenDriverConnection["detach"]>();
}
