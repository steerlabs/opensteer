import { it, expect, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { PersonalRemoteAccessClient, removeHostSession } from "./personal-remote-access.js";
import { unwrapRpcResult } from "./host-session-client.js";

it("shows persisted pending administration in the shared client and stops observation on disposal", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  const resource = new PersonalRemoteAccessClient(host);
  const stop = resource.start();
  try {
    await vi.waitFor(() => expect(resource.getSnapshot().status).not.toBeNull(), { timeout: 1000 });
    await resource.request({ action: "configure", mode: "off", privateOrigin: null });
    await vi.waitFor(
      () =>
        expect(resource.getSnapshot().status?.operation).toMatchObject({
          state: "pending",
          detail: "Waiting for the Opensteer desktop app to run on this computer.",
        }),
      { timeout: 1000 },
    );
    const own = unwrapRpcResult(await host.rpc["sessions.list"]({})).sessions.find(
      (session) => session.current,
    )!;
    await removeHostSession(host, own.id);
    expect(unwrapRpcResult(await host.rpc["sessions.list"]({})).sessions).toEqual([]);
  } finally {
    stop();
    host.dispose();
  }
});

it("keeps newer observed progress when an older command acknowledgement arrives later", async () => {
  const mock = new MockHostClient({ latencyMs: 0 });
  const base = unwrapRpcResult(await mock.rpc["personal.remoteAccess.get"]({}));
  type Status = typeof base;
  let deliver: ((status: Status) => void) | undefined;
  let acknowledge!: (result: import("@opensteer/protocol").HostApiCommandOutput) => void;
  const id = crypto.randomUUID();
  const operation = {
    id,
    executionId: id,
    intent: { action: "configure" as const, mode: "off" as const, privateOrigin: null },
    state: "pending" as const,
    detail: null,
  };
  const client = {
    rpc: {
      "personal.remoteAccess.get": async (
        input: { after?: number },
        options: { signal: AbortSignal },
      ) => {
        if (input.after === undefined) return { ok: true, data: base };
        return new Promise((resolve, reject) => {
          deliver = (status) => resolve({ ok: true, data: status });
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        });
      },
    },
    dispatch: () =>
      new Promise<import("@opensteer/protocol").HostApiCommandOutput>((resolve) => {
        acknowledge = resolve;
      }),
  } as unknown as Pick<import("./client.js").HostClient, "rpc" | "dispatch">;
  const resource = new PersonalRemoteAccessClient(client);
  const stop = resource.start();
  try {
    await vi.waitFor(() => expect(deliver).toBeTypeOf("function"), { timeout: 1000 });
    const request = resource.request(operation.intent);
    deliver!({
      ...base,
      revision: base.revision + 2,
      operation: { ...operation, state: "succeeded" },
    });
    await vi.waitFor(
      () => expect(resource.getSnapshot().status?.operation?.state).toBe("succeeded"),
      { timeout: 1000 },
    );
    acknowledge({ type: "personal.remoteAccess.request", operation });
    await request;
    expect(resource.getSnapshot().status?.operation?.state).toBe("succeeded");
  } finally {
    stop();
    mock.dispose();
  }
});
