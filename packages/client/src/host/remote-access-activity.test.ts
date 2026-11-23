import { describe, expect, it } from "vitest";
import { remoteAccessActivitySentence } from "./remote-access-activity.js";

describe("Remote access taken away, in Activity's words", () => {
  it("says the Mac app cleaned up when it did, and the person only when they asked", () => {
    expect(
      remoteAccessActivitySentence(
        { action: "remote-access.connect-off", metadata: { by: "app-cleanup" } },
        "Studio Mac",
      ),
    ).toBe("Opensteer on Studio Mac turned Remote access off while cleaning up");
    expect(
      remoteAccessActivitySentence(
        { action: "remote-access.connect-removed", metadata: { by: "app-cleanup" } },
        "Studio Mac",
      ),
    ).toBe("Opensteer on Studio Mac removed Remote access while cleaning up");
    expect(
      remoteAccessActivitySentence(
        { action: "remote-access.connect-off", metadata: { by: "person" } },
        "Studio Mac",
      ),
    ).toBe("You turned Remote access off on Studio Mac");
    // A record that does not say who acted is never put to the person as theirs.
    expect(
      remoteAccessActivitySentence({ action: "remote-access.connect-off", metadata: {} }, "Mac"),
    ).not.toMatch(/^You/u);
  });
});
