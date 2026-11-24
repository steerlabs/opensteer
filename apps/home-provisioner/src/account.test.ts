import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { accountClient } from "./account.js";

it("reports the network its pool hosts live in when it takes the lease", async () => {
  const bodies: unknown[] = [];
  const holder = randomUUID();
  const account = accountClient(
    new URL("https://account.example.test"),
    async () => "test-token",
    {
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ acquired: true });
      },
      timeoutMs: 2_000,
    },
    holder,
    "google",
    true,
    "10.128.0.0/20",
  );
  await account.acquire(new AbortController().signal);
  expect(bodies).toEqual([{ holder, poolConfigured: true, poolNetwork: "10.128.0.0/20" }]);
});
