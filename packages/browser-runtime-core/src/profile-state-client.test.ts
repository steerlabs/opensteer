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
