import { expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import { describeStore } from "./store.integration.test-support.js";
import {
  prepareProjectAdmission,
  createProjectIdentityFixture,
} from "./project-work.test-support.js";
import { mutateAccess } from "./access-store.js";
import { ProjectWorkStore } from "./project-work-store.js";

describeStore("Project home chat", (it) => {
  it("keeps an unconfigured provisioning Project chatless", async ({ storeFixture }) => {
    const project = await createProjectIdentityFixture(storeFixture, "unconfigured-provisioning");
    await storeFixture.database
      .updateTable("workspaces")
      .set({ status: "provisioning" })
      .where("id", "=", project.workspace.id)
      .execute();
    const store = new ProjectWorkStore(storeFixture.database, {
      runnerIsConnected: () => true,
      runnerIsAttached: () => true,
    });
    expect(
      await store.ensureHomeChat({
        workspaceId: project.workspace.id,
        createdBy: project.userId,
        settingsRevision: null,
        inheritsMain: false,
      }),
    ).toEqual({ state: "not-configured", homeThreadId: null, events: [] });
    expect(
      await storeFixture.database
        .selectFrom("threads")
        .select("id")
        .where("workspaceId", "=", project.workspace.id)
        .execute(),
    ).toEqual([]);
  });

  it("creates nothing without valid Project settings and refuses a stale settings revision", async ({
    storeFixture,
  }) => {
    const { store, database, project } = await prepareProjectAdmission(storeFixture);
    const input = {
      workspaceId: project.workspace.id,
      createdBy: project.userId,
      settingsRevision: 2,
      inheritsMain: false as const,
    };
    await expect(store.ensureHomeChat(input)).rejects.toMatchObject({
      reason: "settings-revision-changed",
    });
    expect((await storeFixture.store.getWorkspace(project.workspace.id))?.homeThreadId).toBeNull();
    const disconnected = new ProjectWorkStore(database, {
      runnerIsConnected: () => false,
      runnerIsAttached: () => false,
    });
    expect(await disconnected.ensureHomeChat({ ...input, settingsRevision: 1 })).toEqual({
      state: "not-configured",
      homeThreadId: null,
      events: [],
    });
    await database
      .deleteFrom("projectRuntimeSettings")
      .where("workspaceId", "=", project.workspace.id)
      .execute();
    expect(await store.ensureHomeChat({ ...input, settingsRevision: null })).toEqual({
      state: "not-configured",
      homeThreadId: null,
      events: [],
    });
    expect(
      await database
        .selectFrom("threads")
        .select("id")
        .where("workspaceId", "=", project.workspace.id)
        .where("role", "=", "conversation")
        .execute(),
    ).toEqual([]);
  });

  it("serializes two acting managers on the Project and returns the one winning home chat", async ({
    storeFixture,
  }) => {
    const { store, database, project } = await prepareProjectAdmission(storeFixture);
    const manager = await storeFixture.store.createUser("Another manager");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "=", manager)
      .execute();
    await mutateAccess(database, {
      actor: { userId: project.userId },
      expectedRevision: 1,
      commandIdentity: createId("command"),
      changes: [
        {
          kind: "grant",
          id: randomUUID(),
          subject: { kind: "person", userId: manager },
          target: { kind: "project", workspaceId: project.workspace.id },
          level: "manage",
        },
      ],
    });
    const input = {
      workspaceId: project.workspace.id,
      settingsRevision: 1,
      inheritsMain: false as const,
    };
    const results = await Promise.all(
      [project.userId, manager].map((createdBy) => store.ensureHomeChat({ ...input, createdBy })),
    );
    const [first, second] = results;
    if (!first || !second) throw new Error("Both manager transactions did not return");
    const { events: firstEvents, ...firstState } = first;
    const { events: secondEvents, ...secondState } = second;
    expect(firstState).toEqual(secondState);
    expect([...firstEvents, ...secondEvents]).toMatchObject([
      { type: "thread.created", data: { thread: { id: firstState.homeThreadId } } },
    ]);
    const homes = await database
      .selectFrom("threads")
      .selectAll()
      .where("workspaceId", "=", project.workspace.id)
      .where("role", "=", "conversation")
      .execute();
    expect(homes).toHaveLength(1);
    expect([project.userId, manager]).toContain(homes[0]?.createdBy);
    expect(firstState).toEqual({ state: "ready", homeThreadId: homes[0]?.id });
    expect(await store.ensureHomeChat({ ...input, createdBy: manager })).toEqual({
      ...firstState,
      events: [],
    });
    expect((await storeFixture.store.getWorkspace(project.workspace.id))?.homeThreadId).toBe(
      homes[0]?.id,
    );
  });
});
