import { OpensteerError, TabIdSchema } from "@opensteer/core";
import { createBrowserSessionId } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tabDatabaseFixture } from "../tabs/tab-service.integration.test-support.js";

const integration = describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL);
integration("reopen tab admission", () => {
  it("rolls back refused admission and replays concurrent reopen with the same tab identity", async () => {
    const f = await tabDatabaseFixture();
    const tabId = TabIdSchema.parse(`tab_${randomUUID()}`);
    const sessionId = createBrowserSessionId();
    await f.store.createBrowserSession({
      id: sessionId,
      ownerId: f.ownerId,
      runnerId: f.runnerId,
      origin: "agent",
      placementKey: "reopen",
      profileId: null,
      runtimeId: "test",
    });
    await f.tabs.open(
      {
        id: tabId,
        ownerId: f.ownerId,
        computerId: f.runnerId,
        kind: "page",
        title: "Saved",
        url: "https://saved.test/path#hash",
        openedBy: "person",
        pageBinding: { lineageId: sessionId, sessionId, surfaceId: tabId },
      },
      "open",
    );
    await f.tabs.close(f.ownerId, [tabId], "close");
    const closed = await f.tabs.get(f.ownerId, tabId, true);
    await expect(
      f.tabs.reopen(f.ownerId, tabId, "refused", async () => {
        throw new OpensteerError({ code: "not_found", message: "Tab unavailable" });
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await f.tabs.get(f.ownerId, tabId, true)).toEqual(closed);
    const [a, b] = await Promise.all([
      f.tabs.reopen(f.ownerId, tabId, "reopen"),
      f.tabs.reopen(f.ownerId, tabId, "reopen"),
    ]);
    expect(a).toEqual(b);
    expect(a.tabIds).toEqual([tabId]);
    expect(await f.tabs.get(f.ownerId, tabId)).toMatchObject({
      id: tabId,
      generation: 3,
      title: "Saved",
      pageBinding: { sessionId },
    });
    expect((await f.tabs.snapshot(f.ownerId)).rows).toHaveLength(1);
    await expect(f.tabs.reopen(f.ownerId, undefined, "nothing-closed")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
