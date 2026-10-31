import { createHash, randomUUID } from "node:crypto";
import {
  encodeBrowserProfileSnapshot,
  type BrowserProfileSnapshot,
} from "@opensteer/browser-profile/snapshot";
import { LocalProfileBindingSchema } from "@opensteer/protocol";
import {
  HttpProfileInitializationClient,
  type LocalProfileIdentity,
} from "./profile-initialization-client.js";
import { browserProfileCheckpointHeader } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { HttpBrowserProfileStateClient } from "./profile-state-client.js";
import { validProfileClaims } from "./test-support/fakes.js";

describe("HttpBrowserProfileStateClient", () => {
  it("loads and commits through the exact ticket-bound Host endpoint", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ revision: 3, snapshot: { cookies: [], origins: [] } }))
      .mockResolvedValueOnce(Response.json({ revision: 4 }));
    const client = new HttpBrowserProfileStateClient({ fetch });
    const claims = validProfileClaims();

    await expect(client.load(claims)).resolves.toEqual({
      revision: 3,
      snapshot: { cookies: [], origins: [] },
    });
    await expect(client.commit(claims, 3, { cookies: [], origins: [] })).resolves.toBe(4);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL(claims.identity.profileStateUrl),
      expect.objectContaining({
        headers: { authorization: `Bearer ${claims.identity.profileLeaseToken}` },
        method: "GET",
        redirect: "error",
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL(claims.identity.profileStateUrl),
      expect.objectContaining({
        body: JSON.stringify({
          expectedRevision: 3,
          snapshot: { cookies: [], origins: [] },
        }),
        headers: {
          authorization: `Bearer ${claims.identity.profileLeaseToken}`,
          "content-type": "application/json",
        },
        method: "PUT",
        redirect: "error",
      }),
    );
  });

  it("marks periodic commits without changing the strict request body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ revision: 2 }));
    const client = new HttpBrowserProfileStateClient({ fetch });
    await client.commit(validProfileClaims(), 1, { cookies: [], origins: [] }, true);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({ [browserProfileCheckpointHeader]: "periodic" }),
        body: JSON.stringify({ expectedRevision: 1, snapshot: { cookies: [], origins: [] } }),
      }),
    );
  });

  it("rejects insecure remote state endpoints and invalid Host responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new HttpBrowserProfileStateClient({ fetch });
    const claims = validProfileClaims({ profileStateUrl: "http://host.test/profile-state" });

    await expect(client.load(claims)).rejects.toThrow(/secure HTTP endpoint/i);
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(client.load(validProfileClaims())).rejects.toThrow(/valid JSON/i);
  });

  it("allows cleartext state traffic only to the configured private Host origin", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ revision: 0, snapshot: { cookies: [], origins: [] } }));
    const client = new HttpBrowserProfileStateClient({
      fetch,
      trustedHttpOrigin: "http://host:4310",
    });

    await expect(
      client.load(
        validProfileClaims({
          profileStateUrl: "http://host:4310/v1/browser-profile-state/profile/session",
        }),
      ),
    ).resolves.toMatchObject({ revision: 0 });
    await expect(
      client.load(
        validProfileClaims({
          profileStateUrl: "http://other-private:4310/v1/browser-profile-state/profile/session",
        }),
      ),
    ).rejects.toThrow(/secure HTTP endpoint/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("native profile initialization HTTP", () => {
  it("uses only the scoped seed/completion endpoint and verifies the frozen bytes", async () => {
    const { client, identity, snapshot, fetch } = initializationFixture();
    fetch.mockResolvedValueOnce(
      Response.json({ binding: identity.binding, seed: identity.initialization!.seed, snapshot }),
    );
    fetch.mockResolvedValueOnce(Response.json({ state: "local", binding: identity.binding }));
    expect(await client.load(identity)).toEqual(snapshot);
    await client.complete(identity);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL(identity.initialization!.initializationUrl),
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: { authorization: `Bearer ${identity.initialization!.initializationToken}` },
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL(identity.initialization!.initializationUrl),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ binding: identity.binding, seed: identity.initialization!.seed }),
      }),
    );
  });
  it.each(["binding", "revision", "digest"] as const)(
    "refuses a different %s in the frozen seed",
    async (field) => {
      const { client, identity, snapshot, fetch } = initializationFixture();
      const response = { binding: identity.binding, seed: identity.initialization!.seed, snapshot };
      if (field === "binding") response.binding = { ...response.binding, bindingId: randomUUID() };
      if (field === "revision") response.seed = { ...response.seed, revision: 1 };
      if (field === "digest")
        response.snapshot = {
          cookies: [],
          origins: [{ origin: "https://other.test", localStorage: [] }],
        };
      fetch.mockResolvedValueOnce(Response.json(response));
      await expect(client.load(identity)).rejects.toMatchObject({
        reason: "profile-initialization.seed-mismatch",
      });
    },
  );
  it("requires initialization authority and a secure endpoint", async () => {
    const { client, identity, fetch } = initializationFixture();
    await expect(client.load({ kind: "profile-local", binding: identity.binding })).rejects.toThrow(
      /authorize/,
    );
    await expect(
      client.load({
        ...identity,
        initialization: {
          ...identity.initialization!,
          initializationUrl: "http://remote.test/seed",
        },
      }),
    ).rejects.toThrow(/secure HTTP/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function initializationFixture() {
  const snapshot: BrowserProfileSnapshot = { cookies: [], origins: [] };
  const identity: LocalProfileIdentity = {
    kind: "profile-local",
    binding: LocalProfileBindingSchema.parse({
      version: 1,
      deploymentId: `dep_${randomUUID()}`,
      runnerId: `rnr_${randomUUID()}`,
      profileId: `bpr_${randomUUID()}`,
      bindingId: randomUUID(),
      storageInstanceId: randomUUID(),
      engine: "chromium",
    }),
    initialization: {
      seed: {
        revision: 0,
        digest: createHash("sha256").update(encodeBrowserProfileSnapshot(snapshot)).digest("hex"),
      },
      initializationUrl: "https://host.test/scoped-initialization",
      initializationToken: "a".repeat(43),
    },
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  return { client: new HttpProfileInitializationClient({ fetch }), identity, snapshot, fetch };
}
