import { describe, expect, it } from "vitest";
import { mockIphoneScreenDevice } from "../mock/mock-screen-devices.js";
import { newOwnerViewReadiness, computerReasonWords } from "./computer-reasons.js";
import { phoneScreenStatus } from "./phone-screen.js";

describe("a Mac-driven phone's status", () => {
  it("tells a disconnected driver from an unplugged phone and an offline Mac", () => {
    const detached = mockIphoneScreenDevice("detached");
    const ready = mockIphoneScreenDevice("ready");
    const unplugged = {
      ...ready,
      phoneDisplay: {
        ...ready.phoneDisplay!,
        control: { state: "unavailable" as const, reason: { kind: "not-connected" as const } },
      },
    };
    expect(
      [detached, unplugged, mockIphoneScreenDevice("driver-offline"), ready].map((machine) => {
        const status = phoneScreenStatus(machine)!;
        return [status.label, status.needsSetup];
      }),
    ).toEqual([
      ["Not connected", true],
      ["Not plugged in or not on the same Wi‑Fi", false],
      ["Alex’s MacBook Pro is offline", false],
      ["Ready", false],
    ]);
  });

  it("tells the person that screen control returns when the driving Mac wakes", () => {
    const phone = mockIphoneScreenDevice("driver-offline");
    expect(
      phoneScreenStatus({
        ...phone,
        phoneDisplay: {
          ...phone.phoneDisplay!,
          control: { state: "unavailable", reason: { kind: "driver-asleep" } },
        },
      }),
    ).toEqual({
      label: "Alex’s MacBook Pro is asleep",
      fix: "Screen control comes back when Alex’s MacBook Pro wakes.",
      tone: "waiting",
      needsSetup: false,
    });
  });

  it("says nothing for a phone no Mac drives", () => {
    const ready = mockIphoneScreenDevice("ready");
    expect(
      phoneScreenStatus({
        ...ready,
        phoneDisplay: { ...ready.phoneDisplay!, setup: { location: "android-usb" } },
      }),
    ).toBeNull();
  });

  it("distinguishes Local Network permission from Xcode/developer tools setup", () => {
    const ready = mockIphoneScreenDevice("ready");
    const withReason = (kind: "permission-required" | "setup-required") =>
      phoneScreenStatus({
        ...ready,
        phoneDisplay: {
          ...ready.phoneDisplay!,
          control: { state: "unavailable" as const, reason: { kind } },
        },
      })!;
    expect(withReason("permission-required")).toMatchObject({
      label: "Needs Local Network access",
      needsSetup: true,
    });
    expect(withReason("permission-required").fix).toContain("Local Network");
    expect(withReason("setup-required")).toMatchObject({
      label: "Needs setup",
      needsSetup: true,
    });
    expect(withReason("setup-required").fix).toContain("Xcode");
    expect(withReason("setup-required").fix).toContain("USB");
  });
});

it("does not prescribe an on-phone update for an unsupported iPhone view", () => {
  expect(
    computerReasonWords("unsupported", {
      machine: "Work iPhone",
      target: "Work iPhone",
      phone: true,
    }),
  ).toBe("Live view isn’t available for Work iPhone yet.");
});

it("keeps owner viewing independent of the agent Apps switch", () => {
  expect(newOwnerViewReadiness(mockIphoneScreenDevice("apps-off"), true)).toBeNull();
});
