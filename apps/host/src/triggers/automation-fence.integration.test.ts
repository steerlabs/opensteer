import { AgentConnectionStore, TriggerStore } from "@opensteer/database";
import { describeStore } from "@opensteer/database/test-support/store";
import { expect } from "vitest";
import { connection, serveMcp } from "../mcp/connection-caller.test-support.js";

const program = {
  language: "javascript",
  source: "export default async () => null",
  toolContractVersion: 5,
} as const;

describeStore(
  "an automation change takes the connection as it is inside the store's fence",
  (it) => {
    const cases = [
      ["the connection's mode was lowered", { accessMode: "approval-required" as const }],
      [
        "the connection was narrowed to selected",
        { grant: { scope: "selected" as const, tasks: true, resources: [] } },
      ],
    ] as const;
    for (const [name, change] of cases)
      it(`refuses to define an automation on the person's task once ${name} after the MCP check`, async ({
        storeFixture,
      }) => {
        const f = await storeFixture.startRunFixture("automation-fence");
        const { database, store } = storeFixture;
        const url = await serveMcp(storeFixture);
        const agent = await connection(store, url, {
          userId: f.userId,
          accessMode: "full-access",
          grant: { scope: "everything" },
        });
        await database
          .updateTable("threads")
          .set({ accessMode: "full-access" })
          .where("id", "=", f.threadId)
          .execute();
        const create = (key: string) =>
          new TriggerStore(database).create({
            actorThreadId: null,
            // What the MCP layer admitted the caller under, before the change committed.
            actorAccessMode: "full-access",
            actorConnectionId: agent.id,
            anchorThreadId: f.threadId,
            createdBy: f.userId,
            idempotencyKey: key,
            name: `Automation ${key}`,
            program,
            source: {
              kind: "schedule",
              schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
            },
          });
        // Before the change the same call defines it.
        expect((await create("before")).trigger.id).toBeTruthy();
        await new AgentConnectionStore(database).update(f.userId, {
          connectionId: agent.id,
          expectedRevision: 1,
          ...change,
        });
        await expect(create("after")).rejects.toMatchObject({ code: "forbidden" });
        expect(
          await database
            .selectFrom("triggers")
            .select("name")
            .where("originConnectionId", "=", agent.id)
            .execute(),
        ).toEqual([{ name: "Automation before" }]);
      });
  },
);
