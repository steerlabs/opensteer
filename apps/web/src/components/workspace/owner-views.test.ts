import { describe, expect, it } from "vitest";
import { computerReasonWords } from "@opensteer/client/integrations";
import { ownerViewRecovery } from "./owner-views.js";

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
