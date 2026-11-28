import { describe, expect, it } from "vitest";
import { computerReasonWords } from "@opensteer/client/integrations";
import { ownerViewReadiness, ownerViewRecovery } from "./owner-views.js";

describe("a window view whose window is gone from the Mac's memory", () => {
  // After Opensteer restarts on the Mac, the window a tab named is no longer known
  // there: opening it again asks for the same lost window and can only fail again.
  it("offers choosing the window again, never opening the lost one again", () => {
    expect(ownerViewRecovery("window-identity-lost", false)).toBe("choose-window");
    expect(ownerViewRecovery("window-closed", false)).toBe("open-again");
    expect(ownerViewRecovery("expired", false)).toBe("open-again");
    // A phone has no windows to choose.
    expect(ownerViewRecovery("window-identity-lost", true)).toBe("open-again");
  });

  it("says why, and what to do", () => {
    expect(
      computerReasonWords("window-identity-lost", {
        machine: "Studio Mac",
        target: "Safari",
        phone: false,
      }),
    ).toBe("Studio Mac no longer knows which Safari window this was. Choose the window again.");
  });
});

describe("a view this page has asked for", () => {
  // A Mac the snapshot has not said can show windows (its status has not carried the
  // owner-view version yet), with an app listed, reads "unsupported" as a computer.
  const mac = {
    id: "mac",
    status: "online",
    kind: "computer",
    apps: [{ definitionId: "macos-app", operations: [] }],
    computerUse: { state: "ready", ownerViews: [] },
  } as unknown as Parameters<typeof ownerViewReadiness>[0];
  const view = (
    state: "opening" | "ready" | "unavailable",
    unavailableReason: string | null = null,
  ) => ({ state, unavailableReason }) as unknown as Parameters<typeof ownerViewReadiness>[1];

  it("says it is opening while its open is on its way, never that the Mac cannot show it", () => {
    expect(ownerViewReadiness(mac, view("opening"), false)).toBe("opening");
  });

  it("says the Mac did not answer when its open went unanswered, and offers opening it again", () => {
    expect(ownerViewReadiness(mac, view("unavailable", "no-answer"), false)).toBe("no-answer");
    expect(ownerViewRecovery("no-answer", false)).toBe("open-again");
    expect(
      computerReasonWords("no-answer", { machine: "Studio Mac", target: "Safari", phone: false }),
    ).toBe("Studio Mac didn’t answer in time. Open Safari again.");
  });

  it("still says what the computer lacks for a view that is showing", () => {
    expect(ownerViewReadiness(mac, view("ready"), false)).toBe("unsupported");
  });
});
