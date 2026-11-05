import { describe, expect, it } from "vitest";
import { canRespondToRequests, describeHostConnection, showsHostLive } from "./host-connection.js";

describe("describeHostConnection", () => {
  it("asks for a sign-in ahead of any network state", () => {
    expect(
      describeHostConnection({
        network: "unknown",
        connection: "offline",
        connectionInterrupted: true,
        session: "authentication-required",
      }),
    ).toEqual({ action: "sign-in", label: "Signed out", tone: "amber" });
  });

  it("offers a retry only for a Host it cannot reach, never a device with no network", () => {
    for (const connection of ["offline", "connecting"] as const) {
      expect(
        describeHostConnection({
          network: "unknown",
          connection,
          connectionInterrupted: true,
          session: "authenticated",
        }).action,
      ).toBe("retry");
    }
    expect(
      describeHostConnection({
        network: "offline",
        connection: "offline",
        connectionInterrupted: true,
        session: "authenticated",
      }).action,
    ).toBe("none");
  });

  it("says nothing about a signed-in connection until the interruption has lasted", () => {
    const snapshot = {
      network: "offline",
      connection: "connecting",
      session: "authenticated",
    } as const;
    expect(describeHostConnection({ ...snapshot, connectionInterrupted: false }).label).toBe(
      "Connected",
    );
    expect(showsHostLive({ ...snapshot, connectionInterrupted: false })).toBe(true);
    expect(showsHostLive({ ...snapshot, connectionInterrupted: true })).toBe(false);
    expect(describeHostConnection({ ...snapshot, connectionInterrupted: true }).label).toBe(
      "Offline",
    );
    expect(
      describeHostConnection({ ...snapshot, connectionInterrupted: false, session: "checking" })
        .label,
    ).toBe("Offline");
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
            expect(
              describeHostConnection({ ...snapshot, connectionInterrupted: true }),
            ).toMatchObject({
              label: "Offline",
              action: "none",
            });
          }
        }
      }
    }
  });
});
