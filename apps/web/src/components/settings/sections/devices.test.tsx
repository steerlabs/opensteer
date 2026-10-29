import { describe, expect, it, vi } from "vitest";
import { unwrapRpcResult } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { revokeCurrentSession } from "./devices.js";

describe("device disconnection", () => {
  it("revokes the current Host session instead of invoking cookie-only sign-out", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const before = unwrapRpcResult(await client.rpc["sessions.list"]({}));
    const current = before.sessions.find((session) => session.current);
    const dispatch = vi.spyOn(client, "dispatch");

    await revokeCurrentSession(client);

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: current?.id, type: "session.revoke" }),
    );
    expect(unwrapRpcResult(await client.rpc["sessions.list"]({})).sessions).toEqual([]);
  });

  it("does not report success when the authenticated session is no longer listed", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    await revokeCurrentSession(client);

    await expect(revokeCurrentSession(client)).rejects.toThrow(
      "This device no longer has an active session.",
    );
  });
});
