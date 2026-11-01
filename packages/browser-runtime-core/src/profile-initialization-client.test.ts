import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { encodeBrowserProfileSnapshot } from "@opensteer/browser-profile/snapshot";
import { LocalProfileBindingSchema } from "@opensteer/protocol";
import { HttpProfileInitializationClient } from "./profile-initialization-client.js";

it("GETs and POSTs the exact initialization endpoint with its bearer capability on an admitted HTTP origin", async () => {
  const binding = LocalProfileBindingSchema.parse({
    version: 1,
    deploymentId: "dep_00000000-0000-4000-8000-000000000001",
    runnerId: "rnr_00000000-0000-4000-8000-000000000001",
    profileId: "bpr_00000000-0000-4000-8000-000000000001",
    storageInstanceId: "00000000-0000-4000-8000-000000000001",
    bindingId: "00000000-0000-4000-8000-000000000002",
    engine: "chromium",
  });
  const snapshot = { cookies: [], origins: [] };
  const seed = {
    revision: 0,
    digest: createHash("sha256").update(encodeBrowserProfileSnapshot(snapshot)).digest("hex"),
  };
  const initializationUrl = `http://host.internal:3000/v1/browser-profile-initialization/${binding.profileId}`;
  const identity = {
    kind: "profile-local" as const,
    binding,
    initialization: { seed, initializationUrl, initializationToken: "a".repeat(43) },
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ binding, seed, snapshot }))
    .mockResolvedValueOnce(Response.json({ state: "local", binding }));
  const client = new HttpProfileInitializationClient({
    fetch,
    trustedHttpOrigin: "http://host.internal:3000",
  });
  expect(await client.load(identity)).toEqual(snapshot);
  await client.complete(identity);
  expect(
    fetch.mock.calls.map(([url, init]) => [
      String(url),
      init?.method,
      new Headers(init?.headers).get("authorization"),
    ]),
  ).toEqual([
    [initializationUrl, "GET", `Bearer ${identity.initialization.initializationToken}`],
    [initializationUrl, "POST", `Bearer ${identity.initialization.initializationToken}`],
  ]);
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({ binding, seed });
  await expect(new HttpProfileInitializationClient({ fetch }).load(identity)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
});
