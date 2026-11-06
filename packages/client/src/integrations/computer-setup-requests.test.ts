import { expect, it, vi } from "vitest";
import type { ComputerAppSetupSummary } from "@opensteer/integration-core";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { respondComputerAppApproval } from "./computer-app-approval.js";
import { computerSetupRequests } from "./computer-setup-requests.js";

it("shares revisions, refreshes open views on reconnect, retries failures and invalidates answers", async () => {
  const approval = {
    id: "csr_server",
    kind: "server",
    threadId: "thr_a",
  } as ComputerAppSetupSummary;
  let snapshot = {
    user: { id: "user_a" },
    machineRevision: 1,
    connection: "connected",
  } as HostSnapshot;
  const listeners = new Set<() => void>();
  const list = vi.fn(async () => ({ ok: true as const, data: { requests: [approval] } }));
  const host = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    rpc: { "integration.computer.setup.list": list },
    dispatch: vi.fn(async () => ({ type: "integration.computer.setup.respond" })),
  } as unknown as HostClient;
  const update = (patch: Partial<HostSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const cache = computerSetupRequests(host);
  const changed = vi.fn();
  const detach = cache.subscribe(changed);
  expect(computerSetupRequests(host)).toBe(cache);
  const first = cache.read();
  expect(cache.read()).toBe(first);
  expect(await first).toEqual([approval]);
  await cache.read();
  expect(list).toHaveBeenCalledTimes(1);
  update({}); // Streaming snapshot updates share the completed read.
  await cache.read();
  expect(list).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledTimes(1);

  update({ machineRevision: 2 });
  await cache.read();
  expect(list).toHaveBeenCalledTimes(2);
  list.mockResolvedValueOnce({ ok: true, data: { requests: [] } });
  update({ connection: "offline" });
  update({ connection: "connecting" });
  update({ connection: "connected" });
  await cache.read();
  expect(list).toHaveBeenCalledTimes(3);
  expect(cache.getSnapshot()).toEqual([]);

  list.mockRejectedValueOnce(new Error("offline"));
  update({ machineRevision: 3 });
  await expect(cache.read()).rejects.toThrow("offline");
  expect(await cache.read()).toEqual([approval]);
  expect(list).toHaveBeenCalledTimes(5);

  list.mockResolvedValueOnce({ ok: true, data: { requests: [] } });
  await respondComputerAppApproval(host, approval.id, "deny");
  await cache.read();
  expect(list).toHaveBeenCalledTimes(6);
  expect(cache.getSnapshot()).toEqual([]);
  detach();
  update({ connection: "offline" });
  update({ connection: "connected" });
  expect(list).toHaveBeenCalledTimes(6);
  await cache.read();
  expect(list).toHaveBeenCalledTimes(7);
});
