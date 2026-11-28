import { describe, expect, it } from "vitest";
import { desktopConnectFailure, desktopConnectFallback } from "./desktop-connect-failure.js";

describe("adding an Opensteer by address on desktop", () => {
  it("says the Home's own reason when a person can act on it", () => {
    expect(
      desktopConnectFailure(
        new Error(
          "Error invoking remote method 'opensteer.desktop.access.connect-private': Error: This Opensteer has no owner yet. Open the setup link from your server to claim it.",
        ),
      ),
    ).toBe("This Opensteer has no owner yet. Open the setup link from your server to claim it.");
    expect(desktopConnectFailure(new Error("That address needs https."))).toBe(
      "That address needs https.",
    );
  });

  it("keeps the general sentence for anything else", () => {
    expect(
      desktopConnectFailure(
        new Error("Error invoking remote method 'x': TypeError: fetch failed at socket 10.0.0.4"),
      ),
    ).toBe(desktopConnectFallback);
    expect(desktopConnectFailure("nope")).toBe(desktopConnectFallback);
  });
});
