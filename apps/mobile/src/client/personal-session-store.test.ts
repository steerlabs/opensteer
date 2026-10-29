import { AuthSessionIdSchema, DeploymentIdSchema, UserIdSchema } from "@opensteer/core";
import type { AuthenticatedSession } from "@opensteer/core";
import type { SessionExchangeResponse } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { MemorySecureStore } from "../platform/memory-secure-store.js";
import { createSecureRecordStore } from "../platform/secure-record-store.js";
import {
  createPersonalSessionStore,
  personalSessionFrom,
  type PersonalRemoteSession,
} from "./personal-session-store.js";

const deploymentId = DeploymentIdSchema.parse("dep_0192f4a1-1111-4000-8000-000000000001");
const token = `${"A".repeat(43)}.${"B".repeat(43)}=`;

const authenticatedSession: AuthenticatedSession = {
  absoluteExpiresAt: "2026-09-21T00:00:00.000Z",
  createdAt: "2026-09-14T00:00:00.000Z",
  expiresAt: "2026-09-15T00:00:00.000Z",
  id: AuthSessionIdSchema.parse("ses_0192f4a1-4444-4000-8000-000000000004"),
  user: {
    disabledAt: null,
    displayName: "Alex",
    email: "person@example.com",
    emailVerified: true,
    id: UserIdSchema.parse("usr_0192f4a1-5555-4000-8000-000000000005"),
    image: null,
    instanceRole: "administrator",
  },
};

const session = (expiresAt: string): PersonalRemoteSession => ({
  absoluteExpiresAt: "2026-09-21T00:00:00.000Z",
  deploymentId,
  expiresAt,
  token,
});

const store = () => {
  const secureStore = new MemorySecureStore();
  return {
    secureStore,
    sessions: createPersonalSessionStore(
      createSecureRecordStore({ keyPrefix: "opensteer.auth", secureStore }),
    ),
  };
};

describe("createPersonalSessionStore", () => {
  it("presents a live session under the PersonalRemote scheme, never Bearer", async () => {
    const { sessions } = store();
    await sessions.save(session("2026-09-15T00:00:00.000Z"));

    expect(await sessions.authorization(deploymentId, new Date("2026-09-14T00:00:00Z"))).toBe(
      `PersonalRemote ${token}`,
    );
  });

  it("presents nothing once the session has expired", async () => {
    const { sessions } = store();
    await sessions.save(session("2026-09-14T00:00:00.000Z"));

    expect(await sessions.authorization(deploymentId, new Date("2026-09-14T00:00:01Z"))).toBeNull();
  });

  it("keeps the credential out of the deployment catalog's namespace", async () => {
    const { secureStore, sessions } = store();
    await sessions.save(session("2026-09-15T00:00:00.000Z"));

    expect(secureStore.keys).toEqual([
      `opensteer.auth.personal.${deploymentId}`,
      `opensteer.auth.personal.${deploymentId}.g0.0`,
    ]);
  });

  it("treats a record from another release as a session to establish again", async () => {
    const { secureStore, sessions } = store();
    await sessions.save(session("2026-09-15T00:00:00.000Z"));
    secureStore.put(`opensteer.auth.personal.${deploymentId}.g0.0`, '{"token":"short"}');

    expect(await sessions.load(deploymentId)).toBeNull();
  });
});

describe("personalSessionFrom", () => {
  it("refuses a cookie the phone has nowhere to keep", () => {
    const response: SessionExchangeResponse = {
      credentialDelivery: "cookie",
      schemaVersion: 2,
      session: authenticatedSession,
    };

    expect(() => personalSessionFrom(deploymentId, response)).toThrow(/cannot hold/u);
  });
});
