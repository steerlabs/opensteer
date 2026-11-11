import { expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { unwrapRpcResult } from "../host/index.js";
import { completePluginConsent, type PluginAddConsent } from "./plugin-add-consent.js";

it("retains the exact account command across an uncertain commit", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    await client.load();
    const target = { kind: "service", definitionId: "google-gmail" } as const;
    const detail = unwrapRpcResult(await client.rpc["plugins.detail.get"]({ target }));
    const account = detail.accounts[0]!;
    let consent: PluginAddConsent = {
      target,

      access: "read",
      idempotencyKey: "returned-account",
      command: null,
    };
    const dispatch = client.dispatch.bind(client);
    const spy = vi.spyOn(client, "dispatch").mockImplementationOnce(async (command) => {
      await dispatch(command);
      throw new Error("Lost response");
    });
    await expect(
      completePluginConsent(client, consent, account.connectionId, (next) => {
        consent = next;
      }),
    ).rejects.toThrow("Lost response");
    await completePluginConsent(client, consent, account.connectionId, (next) => {
      consent = next;
    });
    await expect(
      completePluginConsent(client, consent, "different-connection", () => undefined),
    ).rejects.toThrow("different connection");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0]).toEqual(spy.mock.calls[0]![0]);
  } finally {
    client.dispose();
  }
});
