import { describe, expect, it } from "vitest";
import { describeRunnerDevice, type RunnerDeviceProbe } from "./device.js";

const probe = (machine: string | null, container = false, chassis: string | null = null) =>
  ({
    insideContainer: async () => container,
    linuxChassisType: async () => chassis,
    macMachineName: async () => machine,
  }) satisfies RunnerDeviceProbe;

describe("the device a Runner reports", () => {
  it("says a Mac running the Opensteer app is that app's, whatever its shape, a VM included", async () => {
    // A Mac in a virtual machine is still a Mac: it has no shape of its own to draw.
    await expect(
      describeRunnerDevice({
        app: "opensteer",
        platform: "darwin",
        probe: probe("Apple Virtual Machine 1"),
        runnerKind: "local",
      }),
    ).resolves.toEqual({ app: "opensteer", form: null, platform: "macos" });
    await expect(
      describeRunnerDevice({
        app: "opensteer",
        platform: "darwin",
        probe: probe("Mac mini"),
        runnerKind: "local",
      }),
    ).resolves.toEqual({ app: "opensteer", form: "compact", platform: "macos" });
  });

  it("keeps a Runner started on its own, a Cloud Computer and a Linux server as they were", async () => {
    await expect(
      describeRunnerDevice({
        platform: "darwin",
        probe: probe("MacBook Pro"),
        runnerKind: "local",
      }),
    ).resolves.toEqual({ form: "laptop", platform: "macos" });
    await expect(
      describeRunnerDevice({
        platform: "darwin",
        probe: probe("Apple Virtual Machine 1"),
        runnerKind: "managed",
      }),
    ).resolves.toEqual({ form: "server", platform: "macos" });
    await expect(
      describeRunnerDevice({ platform: "linux", probe: probe(null, true), runnerKind: "local" }),
    ).resolves.toEqual({ form: "server", platform: "linux" });
  });
});
