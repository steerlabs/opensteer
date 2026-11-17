import { describe, expect, it } from "vitest";
import { phoneAvailabilityDetail } from "../computer-apps/computer-app-availability.js";
import { phoneDiscovery } from "./computer-use-discovery.js";

describe("phone display availability", () => {
  it("keeps a locked or detached iPhone distinct from its online Mac", () => {
    expect(
      phoneAvailabilityDetail({
        attached: true,
        runnerConnected: true,
        phone: "Travel iPhone",
        status: null,
        availability: { state: "unavailable", reason: { kind: "locked" } },
        definitionId: "iphone-screen",
      }),
    ).toContain("unlock Travel iPhone");
    expect(
      phoneDiscovery({
        phone: {
          name: "Travel iPhone",
          state: "unavailable",
          definitionId: "iphone-screen",
          availability: { state: "unavailable", reason: { kind: "not-connected" } },
          setup: {
            location: "driver-mac",
            driverRunnerId:
              "rnr_00000000-0000-4000-8000-000000000001" as import("@opensteer/core").RunnerId,
            driverRunnerName: "Work Mac",
          },
        },
        connection: null,
        callable: false,
        canAct: false,
        pendingPhoneAccess: false,
        pendingPersonalGrant: false,
        heldByAnotherRun: null,
      }).nextAction,
    ).toContain("Work Mac");
  });
});
