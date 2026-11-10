import { describeStore } from "@opensteer/database/test-support/store";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { sql } from "kysely";
import { expect } from "vitest";

describeStore("connected-agent team incarnations", (it) => {
  it("requires admission and a Project and never revives obsolete credentials", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.createRunFixture("connection-incarnation", null, "project");
    const database = storeFixture.database;
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    const store = new AgentConnectionStore(database);
    const input = {
      userId: fixture.userId,
      label: "Agent",
      clientName: "test",
      accessMode: "approval-required" as const,
      reach: { kind: "workspace" as const, workspaceId: fixture.workspace.id },
      resource: "https://team.test/mcp",
      expiresAt: new Date(Date.now() + 60_000),
    };
    await expect(store.create(input)).rejects.toMatchObject({ code: "unauthorized" });
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "=", fixture.userId)
      .execute();
    await expect(store.create({ ...input, reach: { kind: "user" } })).rejects.toMatchObject({
      code: "unauthorized",
    });
    const first = await store.create(input);
    expect(await store.activate(first.id, "a".repeat(64))).toBe(true);
    expect(await store.authenticate("a".repeat(64))).toMatchObject({ id: first.id });
    await database
      .updateTable("workspaceMemberships")
      .set({ generation: sql`generation + 1` })
      .where("workspaceId", "=", fixture.workspace.id)
      .where("userId", "=", fixture.userId)
      .execute();
    expect(await store.authenticate("a".repeat(64))).toBeNull();
    const second = await store.create(input);
    await store.activate(second.id, "b".repeat(64));
    expect(await store.authenticate("b".repeat(64))).toMatchObject({ id: second.id });
    await database
      .updateTable("users")
      .set({ authorityGeneration: sql`authority_generation + 1`, memberState: "removed" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(await store.authenticate("b".repeat(64))).toBeNull();
    await database
      .updateTable("users")
      .set({ authorityGeneration: sql`authority_generation + 1`, memberState: "active" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(await store.authenticate("b".repeat(64))).toBeNull();
    const third = await store.create(input);
    await store.activate(third.id, "c".repeat(64));
    await database
      .updateTable("agentConnections")
      .set({ memberGeneration: null })
      .where("id", "=", third.id)
      .execute();
    expect(await store.authenticate("c".repeat(64))).toBeNull();
  });
});
