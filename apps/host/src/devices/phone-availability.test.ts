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
          computerId: "dev_travel",
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
        heldByAnotherRun: false,
      }).blocked?.next,
    ).toContain("Work Mac");
  });
  it.each([
    ["driver-offline", "computer_offline"],
    ["not-connected", "unavailable"],
    ["driver-update-required", "update_required"],
    ["trust-required", "permission_required"],
    ["developer-mode-required", "permission_required"],
    ["setup-required", "permission_required"],
    ["permission-required", "permission_required"],
    ["locked", "permission_required"],
    ["protected", "permission_required"],
    ["access-off", "permission_required"],
    ["paused", "paused"],
    ["helper-unavailable", "unavailable"],
    ["connecting", "unavailable"],
    ["unreported", "unavailable"],
    ["runtime-failed", "unavailable"],
    ["unsupported", "unavailable"],
  ] as const)(
    "maps iPhone %s to the shared %s blocker before granted or pending access",
    (kind, code) => {
      const facts = {
        phone: {
          computerId: "dev_travel",
          name: "Travel iPhone",
          state: "unavailable",
          definitionId: "iphone-screen" as const,
          availability: { state: "unavailable" as const, reason: { kind } },
          setup: {
            location: "driver-mac" as const,
            driverRunnerId: "rnr_mac" as import("@opensteer/core").RunnerId,
            driverRunnerName: "Work Mac",
          },
        },
        connection: { access: "read-write" as const },
        callable: true,
        canAct: true,
        pendingPhoneAccess: true,
        pendingPersonalGrant: true,
        heldByAnotherRun: true,
      };
      const result = phoneDiscovery(facts);
      expect(result).toEqual({
        blocked: {
          code,
          message: expect.stringContaining("Travel iPhone"),
          next: expect.any(String),
        },
      });
      expect(result.blocked?.next.length).toBeGreaterThan(0);
      if (
        [
          "not-connected",
          "driver-offline",
          "driver-update-required",
          "trust-required",
          "developer-mode-required",
          "setup-required",
          "permission-required",
          "helper-unavailable",
          "connecting",
          "unreported",
          "runtime-failed",
          "unsupported",
        ].includes(kind)
      )
        expect(result.blocked?.next).toContain("Work Mac");
      if (kind === "access-off")
        expect(result.blocked?.next).toContain(
          'computer_access_request {computerId:"dev_travel", access:"apps"',
        );
      expect(phoneDiscovery({ ...facts, blockedByOwner: true }).blocked?.code).toBe(
        "blocked_by_owner",
      );
    },
  );
  it("turns device approval readiness into the exact task access request", () => {
    expect(
      phoneDiscovery({
        phone: {
          computerId: "dev_travel",
          name: "Travel iPhone",
          state: "unavailable",
          definitionId: "iphone-screen",
          availability: { state: "unavailable", reason: { kind: "approval-required" } },
        },
        connection: null,
        callable: false,
        pendingPhoneAccess: false,
        pendingPersonalGrant: false,
        heldByAnotherRun: false,
      }),
    ).toEqual({
      blocked: {
        code: "access_required",
        message: "Travel iPhone needs access for this task.",
        next: 'Request access with app_access_request {computerId:"dev_travel", access:"read-write", reason:"<why you need it>"}; the owner can approve from any Opensteer app.',
      },
    });
  });
});
