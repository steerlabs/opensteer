import { describe, expect, it } from "vitest";
import { MemorySecureStore } from "../platform/memory-secure-store.js";
import { createSecureRecordStore } from "../platform/secure-record-store.js";
import { createDeploymentCredentials } from "./deployment-credentials.js";
import { testDeploymentConnection } from "../../test-support/deployment-fixtures.js";
import { createPersonalSessionStore } from "./personal-session-store.js";

const now = () => new Date("2026-09-14T00:00:00.000Z");
const token = `${"A".repeat(43)}.${"B".repeat(43)}=`;

const credentials = (hostStatus: "signed-in" | "signed-out") => {
  const sessions = createPersonalSessionStore(
    createSecureRecordStore({ keyPrefix: "test", secureStore: new MemorySecureStore() }),
  );
  return {
    credentials: createDeploymentCredentials({
      now,
      oauth: {
        authorizationHeader: async () => (hostStatus === "signed-in" ? "Bearer host" : null),
        hostCredentialState: () => ({
          connection: testDeploymentConnection({}),
          detail: null,
          key: "key",
          status: hostStatus,
        }),
      },
      sessions,
    }),
    sessions,
  };
};

describe("createDeploymentCredentials", () => {
  it("presents a self-hosted Host its own OAuth bearer", async () => {
    const { credentials: held } = credentials("signed-in");
    const connection = testDeploymentConnection({});

    expect(await held.authorization(connection)).toBe("Bearer host");
    expect(await held.held(connection)).toBe(true);
  });

  it("holds nothing for a self-hosted Host this phone is signed out of", async () => {
    const { credentials: held } = credentials("signed-out");
    const connection = testDeploymentConnection({});

    expect(await held.authorization(connection)).toBeNull();
    expect(await held.held(connection)).toBe(false);
  });

  it("presents a personal computer its pairing session, never a bearer", async () => {
    const { credentials: held, sessions } = credentials("signed-in");
    const connection = testDeploymentConnection({ kind: "personal" });
    await sessions.save({
      absoluteExpiresAt: "2026-09-21T00:00:00.000Z",
      deploymentId: connection.authority.document.deploymentId,
      expiresAt: "2026-09-15T00:00:00.000Z",
      token,
    });

    expect(await held.authorization(connection)).toBe(`PersonalRemote ${token}`);
    expect(await held.held(connection)).toBe(true);
  });

  it("holds nothing for a personal computer that was never paired", async () => {
    const { credentials: held } = credentials("signed-in");
    const connection = testDeploymentConnection({ kind: "personal" });

    expect(await held.authorization(connection)).toBeNull();
    expect(await held.held(connection)).toBe(false);
  });
});
