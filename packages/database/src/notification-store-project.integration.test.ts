import { AgentEventSchema, createId } from "@opensteer/core";
import { expect } from "vitest";
import { ProjectNotificationStore, type NotificationPublication } from "./notification-store.js";
import { projectRequestFixture } from "./project-request.test-support.js";
import { describeStore } from "./store.integration.test-support.js";
import { jsonValue } from "./store-primitives.js";

describeStore("Project outcome notifications", (it) => {
  it("notifies current managers of unattended results and rechecks eligibility before delivery", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const fixture = await projectRequestFixture(storeFixture, "outcome", "unattended");
    const managers = await Promise.all([
      store.createUser("Manager A"),
      store.createUser("Manager B"),
    ]);
    const member = await store.createUser("Member");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "in", [...managers, member])
      .execute();
    await database
      .insertInto("workspaceMemberships")
      .values(
        [...managers, member].map((userId) => ({
          id: createId("workspaceMembership"),
          workspaceId: fixture.workspace.id,
          userId,
          role: userId === member ? ("collaborator" as const) : ("owner" as const),
          state: "active" as const,
          generation: 1,
        })),
      )
      .execute();
    await database
      .updateTable("workspaceMemberships")
      .set({ role: "collaborator" })
      .where("workspaceId", "=", fixture.workspace.id)
      .where("userId", "=", fixture.userId)
      .execute();
    const notifications = new ProjectNotificationStore(database);
    const base = {
      eventId: createId("event"),
      createdAt: new Date().toISOString(),
      sequence: "1",
      environmentId: fixture.environmentId,
      workspaceId: fixture.workspace.id,
      threadId: fixture.thread.id,
      runId: fixture.run.id,
    };
    const input = await database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", fixture.run.seedInputId)
      .executeTakeFirstOrThrow();
    const attribution = {
      startedAt: fixture.run.createdAt,
      personWaiting: false,
      startedBy: input.author,
    };
    const failed = AgentEventSchema.parse({
      ...base,
      type: "run.failed",
      data: {
        ...attribution,
        status: "failed",
        code: "runner_execution_error",
        message: "Failed",
        retryable: false,
      },
    });
    const failures = await notifications.decide(failed);
    expect(failures.map((entry) => entry.userId).sort()).toEqual([...managers].sort());
    const messageId = createId("message");
    await database
      .insertInto("messages")
      .values({
        ...input,
        id: messageId,
        kind: "assistant",
        sequence: "2",
        author: jsonValue({
          kind: "agent",
          displayName: "Agent",
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          workspaceId: fixture.workspace.id,
          workspaceName: fixture.workspace.name,
        }),
        content: jsonValue([{ type: "text", text: "Work finished" }]),
      })
      .execute();
    const completed = AgentEventSchema.parse({
      ...base,
      eventId: createId("event"),
      type: "run.completed",
      data: { ...attribution, status: "completed", replyMessageId: messageId },
    });
    const replies = await notifications.decide(completed);
    expect(replies.map((entry) => entry.userId).sort()).toEqual([...managers].sort());
    expect(replies.every((entry) => entry.view.body === "Work finished")).toBe(true);
    const reply = replies.find((entry) => entry.userId === managers[0])!;
    const publication: NotificationPublication = {
      ...reply.view,
      userId: reply.userId,
      eventId: completed.eventId,
      sequence: completed.sequence,
      occurredAt: new Date(completed.createdAt),
      expiresAt: new Date(Date.now() + 60000),
    };
    expect(await notifications.publicationSkipReason(publication)).toBeNull();
    await database
      .updateTable("workspaceMemberships")
      .set({ role: "collaborator" })
      .where("workspaceId", "=", fixture.workspace.id)
      .where("userId", "=", managers[0]!)
      .execute();
    expect(await notifications.publicationSkipReason(publication)).toBe(
      "Project Request audience is no longer eligible",
    );
    expect((await notifications.decide(failed)).map((entry) => entry.userId)).toEqual([
      managers[1],
    ]);
    await database
      .insertInto("agentNotificationMutes")
      .values({ workspaceId: fixture.workspace.id, userId: managers[1]!, muted: true })
      .execute();
    expect(await notifications.decide(failed)).toEqual([]);
    expect(await notifications.decide(completed)).toEqual([]);
    await database
      .updateTable("workspaceMemberships")
      .set({ role: "collaborator" })
      .where("workspaceId", "=", fixture.workspace.id)
      .where("userId", "=", managers[1]!)
      .execute();
    expect(await notifications.decide(failed)).toEqual([]);
    expect(await notifications.decide(completed)).toEqual([]);
  });
});
