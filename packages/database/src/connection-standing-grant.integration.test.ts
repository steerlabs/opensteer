import { createId } from "@opensteer/core";
import { expect } from "vitest";
import { readConnectionRowStanding, readLiveAgentConnectionRow } from "./resource-access.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("a connection's standing read gives only its effective grant (K6)", (test) => {
  test("a chat anyone may speak in holds nothing it may not, stored or read", async ({
    storeFixture: f,
  }) => {
    const chat = await f.createBridgeFixture("standing-grant", {
      senders: "anyone",
      conversation: { id: "C-standing-grant", name: "Open room" },
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const owner = chat.fixture.userId;
    const id = chat.bridge.id as string;
    // Its row cannot store more than such a chat may hold: the database refuses it.
    await expect(
      f.database
        .updateTable("agentConnections")
        .set({ grant: JSON.stringify({ scope: "everything" }) } as never)
        .where("id", "=", id)
        .execute(),
    ).rejects.toMatchObject({ constraint: "agent_connections_bridge" });
    // The one standing read gives the effective grant, parsed; a profile it never held is none.
    expect((await readConnectionRowStanding(f.database, owner, id)).row?.grant).toEqual({
      scope: "selected",
      tasks: true,
      resources: [],
    });
    await expect(
      readLiveAgentConnectionRow(f.database, owner, id, false, {
        grantTarget: { kind: "browser-profile", profileId: createId("browserProfile") },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
