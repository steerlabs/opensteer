import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { MockHostClient } from "../../packages/client/src/mock/mock-host-client.js";

it("matches screen attach authority, name validation, and live Mac requirements", async () => {
  const client = new MockHostClient({ latencyMs: 0, iphoneScreen: "ready" });
  try {
    const phone = client
      .getSnapshot()
      .machines.find((m) => m.phoneDisplay?.definitionId === "iphone-screen")!;
    const runnerId = phone.phoneDisplay!.driver!.runnerId;
    const attach = (name: string) =>
      client.attachIphoneScreen({ driverRunnerId: runnerId, target: { kind: "new", name } });
    await expect(
      client.attachIphoneScreen({
        driverRunnerId: createId("runner"),
        target: { kind: "new", name: "Phone" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      client.attachIphoneScreen({
        driverRunnerId: runnerId,
        target: { kind: "existing", deviceId: createId("device"), expectedGeneration: 1 },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    for (const name of ["  ", "x".repeat(121)]) await expect(attach(name)).rejects.toThrow();
    const added = await attach("  Trimmed  ");
    expect(client.getSnapshot().machines.find((m) => m.id === added.deviceId)?.name).toBe(
      "Trimmed",
    );
    const mac = client.getSnapshot().machines.find((m) => m.id === runnerId)!;
    Reflect.set(mac, "status", "offline");
    await expect(attach("Offline")).rejects.toMatchObject({ code: "conflict" });
    Reflect.set(mac, "status", "online");
    Reflect.set(mac.modules, "integrations", {
      checkedAt: null,
      detail: null,
      readiness: "unsupported",
    });
    await expect(attach("Unsupported")).rejects.toMatchObject({ code: "conflict" });
  } finally {
    client.dispose();
  }
});
