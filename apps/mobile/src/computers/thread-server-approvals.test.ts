import { describe, expect, it, vi } from "vitest";
import { readSetupRequests, type threadServerApprovals } from "./thread-server-approvals.js";

type Request = Parameters<typeof threadServerApprovals>[0][number];
const request = (overrides: Partial<Request>) =>
  ({ id: "csr_1", kind: "server", threadId: "thr_a", ...overrides }) as Request;

function host(results: readonly (Request[] | Error)[]) {
  const list = vi.fn(async () => {
    const next = results[list.mock.calls.length - 1];
    if (next instanceof Error)
      return { ok: false as const, error: { code: "unavailable", message: next.message } };
    return { ok: true as const, data: { requests: next ?? [] } };
  });
  return { list, client: { rpc: { "integration.computer.setup.list": list } } as never };
}

/*
 * Every open Thread asks for its pending plugin-server approvals. Reading the
 * list once per Thread open would cost a round trip on each tap over cellular;
 * a failed read that stuck would hide approvals until the next machine change.
 */
describe("pending plugin-server approvals in a Thread", () => {
  it("reads once per machine revision and asks again after a failure", async () => {
    const pending = request({ id: "csr_server" });
    const { client, list } = host([new Error("offline"), [pending], [pending]]);
    await expect(readSetupRequests(client, 1)).rejects.toThrow();
    expect(await readSetupRequests(client, 1)).toEqual([pending]);
    expect(await readSetupRequests(client, 1)).toEqual([pending]);
    expect(list).toHaveBeenCalledTimes(2);
    await readSetupRequests(client, 2);
    expect(list).toHaveBeenCalledTimes(3);
  });
});
