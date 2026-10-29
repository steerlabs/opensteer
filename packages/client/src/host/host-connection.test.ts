import { describe, expect, it } from "vitest";
import { canRespondToRequests, describeHostConnection } from "./host-connection.js";

describe("describeHostConnection", () => {
  it("asks for a sign-in ahead of any network state", () => {
    expect(
      describeHostConnection({
        network: "unknown",
        connection: "offline",
        session: "authentication-required",
      }),
    ).toEqual({ action: "sign-in", label: "Signed out", tone: "amber" });
  });

  it("offers a retry only when being offline is the whole problem", () => {
    expect(
      describeHostConnection({
        network: "unknown",
        connection: "offline",
        session: "authenticated",
      }).action,
    ).toBe("retry");
    expect(
      describeHostConnection({
        network: "unknown",
        connection: "connecting",
        session: "authenticated",
      }).action,
    ).toBe("none");
  });
});

describe("canRespondToRequests", () => {
  it("requires both an authenticated synchronized Host and a usable network", () => {
    for (const network of ["online", "unknown", "offline"] as const) {
      for (const connection of ["connected", "connecting", "offline"] as const) {
        for (const session of ["authenticated", "checking", "authentication-required"] as const) {
          const snapshot = { network, connection, session };
          expect(canRespondToRequests(snapshot)).toBe(
            network !== "offline" && connection === "connected" && session === "authenticated",
          );
          if (network === "offline" && session !== "authentication-required") {
            expect(describeHostConnection(snapshot)).toMatchObject({
              label: "Offline",
              action: "none",
            });
          }
        }
      }
    }
  });
});
