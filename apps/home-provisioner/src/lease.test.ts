import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { accountClient } from "./account.js";
import { RemoteRequestError } from "./http.js";
import { holdLease } from "./main.js";

const held = () => new RemoteRequestError("Account", 409);

it("waits inside the process while another provisioner holds the lease, and says when it begins and ends", async () => {
  const lines: string[] = [];
  let refusals = 2;
  const acquire = vi.fn(async () => {
    if (refusals-- > 0) throw held();
  });
  const slept: number[] = [];
  const signal = new AbortController().signal;
  await holdLease({
    account: { acquire },
    signal,
    retryMs: 5_000,
    log: (line) => lines.push(String(line.event)),
    sleep: async (ms) => void slept.push(ms),
  });
  expect(acquire).toHaveBeenCalledTimes(3);
  expect(slept).toEqual([5_000, 5_000]);
  expect(lines).toEqual(["home-provisioner.lease.waiting", "home-provisioner.lease.acquired"]);
});

it("stops waiting when it is told to stop, and passes on any other refusal", async () => {
  const stop = new AbortController();
  const acquire = vi.fn(async () => {
    throw held();
  });
  const waited = holdLease({
    account: { acquire },
    signal: stop.signal,
    retryMs: 5_000,
    log: () => undefined,
    sleep: async () => void stop.abort(),
  });
  await expect(waited).resolves.toBe(false);
  // Account refusing the provisioner itself is not a wait.
  await expect(
    holdLease({
      account: {
        acquire: async () => {
          throw new RemoteRequestError("Account", 403);
        },
      },
      signal: new AbortController().signal,
      retryMs: 5_000,
      log: () => undefined,
      sleep: async () => undefined,
    }),
  ).rejects.toThrow(RemoteRequestError);
});

it("gives its lease back, as its own holder, when it stops", async () => {
  const requests: { method: string | undefined; holder: string | null }[] = [];
  const holder = randomUUID();
  const account = accountClient(
    new URL("https://account.example.test"),
    async () => "test-token",
    {
      fetch: async (_input, init) => {
        requests.push({
          method: init?.method,
          holder: new Headers(init?.headers).get("x-opensteer-provisioner-lease"),
        });
        return Response.json({ released: true });
      },
      timeoutMs: 2_000,
    },
    holder,
  );
  expect(await account.release?.(new AbortController().signal)).toBe(true);
  expect(requests).toEqual([{ method: "DELETE", holder }]);
});
