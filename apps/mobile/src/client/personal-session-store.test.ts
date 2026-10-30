import { createId, AuthSessionIdSchema, DeploymentIdSchema, UserIdSchema } from "@opensteer/core";
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

describe("Personal saved-view login lifetime", () => {
  it("allocates new IDs for replacements and deletes the key before changing the session", async () => {
    const records = createSecureRecordStore({
      keyPrefix: "test",
      secureStore: new MemorySecureStore(),
    });
    const id = createId("deployment"),
      changes: string[] = [];
    const store = createPersonalSessionStore(records, {
      beforeChange: async () => {
        changes.push((await records.read(`personal.${id}`)) ?? "absent");
      },
    });
    const session = {
      deploymentId: id,
      absoluteExpiresAt: "2027-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
      token: "a".repeat(43) + "." + "b".repeat(43) + "=",
    };
    await store.save(session);
    const first = (await store.load(id))!.viewLoginId;
    expect(first).toEqual(expect.any(String));
    expect(changes).toEqual(["absent"]);
    await store.save(session);
    expect((await store.load(id))!.viewLoginId).not.toBe(first);
    expect(changes[1]).toContain(first);
    await store.clear(id);
    expect(await store.load(id)).toBeNull();
  });
  it("initializes legacy records only after current bootstrap and cannot resurrect a cleared record", async () => {
    const records = createSecureRecordStore({
      keyPrefix: "test",
      secureStore: new MemorySecureStore(),
    });
    const id = createId("deployment");
    await records.write(
      `personal.${id}`,
      JSON.stringify({
        deploymentId: id,
        absoluteExpiresAt: "2027-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
        token: "a".repeat(43) + "." + "b".repeat(43) + "=",
      }),
    );
    const store = createPersonalSessionStore(records);
    await store.initializeViewLoginId!(id, () => false);
    expect((await store.load(id))!.viewLoginId).toBeUndefined();
    await Promise.all([store.clear(id), store.initializeViewLoginId!(id, () => false)]);
    expect(await store.load(id)).toBeNull();
  });
});
