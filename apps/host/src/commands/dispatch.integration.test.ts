import { randomUUID } from "node:crypto";
import { createId, type AgentGrant, type UserId } from "@opensteer/core";
import { AgentConnectionStore, admitCommand, commandSubject } from "@opensteer/database";
import { describeStore } from "@opensteer/database/test-support/store";
import type { HostApiCommand } from "@opensteer/protocol";
import { commandTable, type CommandType } from "@opensteer/protocol/command-table";
import { expect, vi } from "vitest";
import type { AgentCaller } from "../mcp/agent-caller.js";
import {
  agentCommandAdmission,
  dispatchCommand,
  isCommandAuthority,
  type CommandAuthority,
} from "./dispatch.js";
import type { CommandRegistry } from "./registry.js";

const types = Object.keys(commandTable) as CommandType[];

/** Enough of each command for its face and what it governs to be read. */
function sample(type: CommandType, threadId: string): HostApiCommand {
  return {
    type,
    idempotencyKey: randomUUID(),
    threadId,
    profileId: createId("browserProfile"),
    machineId: createId("device"),
    harnessInstanceId: createId("harnessInstance"),
    environmentId: createId("environment"),
    connectionId: `ic_${randomUUID()}`,
    requestId: createId("request"),
    triggerId: createId("trigger"),
    pluginId: "plugin",
    sessionId: "session",
    tabIds: ["tab_missing"],
    groupId: "group_missing",
    status: "paused",
    enabled: false,
    done: true,
    name: "Name",
    input: { anchorThreadId: threadId, threadId, runnerId: "run_x", connectionId: "ic_x" },
    target: { kind: "new", name: "iPhone" },
    decision: { kind: "decline", decision: "decline" },
    intent: { action: "rotate" },
    action: "decline",
  } as unknown as HostApiCommand;
}

function spyRegistry() {
  const calls: CommandType[] = [];
  const registry = Object.fromEntries(
    types.map((type) => [
      type,
      {
        accepts: "person",
        run: vi.fn(async () => {
          calls.push(type);
          return { type } as never;
        }),
      },
    ]),
  ) as unknown as CommandRegistry;
  return { registry, calls };
}

describeStore("the door with the Home's own admission", (it) => {
  it("never runs a person's handler for any agent, and answers exactly what admitCommand does", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture(`door-${randomUUID().slice(0, 8)}`);
    const { database } = storeFixture;
    const connections = new AgentConnectionStore(database);
    const connect = async (grant: AgentGrant) => {
      const connection = await connections.create({
        userId: f.userId,
        label: "Agent",
        clientName: "Agent",
        accessMode: "full-access",
        resource: "http://localhost/mcp",
        expiresAt: new Date(Date.now() + 60_000),
        grant,
      });
      await connections.activate(connection.id, `hash-${randomUUID()}`);
      return connection;
    };
    await database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.threadId)
      .execute();
    await database
      .updateTable("runs")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.run.id)
      .execute();
    const everything = await connect({ scope: "everything" });
    const selected = await connect({ scope: "selected", tasks: true, resources: [] });
    const occurrence = await storeFixture.startTriggerOccurrence(f, `door-${randomUUID()}`);
    const caller = (key: string, kind: AgentCaller["kind"]): AgentCaller =>
      ({ kind, key, userId: f.userId as UserId, accessMode: "full-access" }) as AgentCaller;
    const callers = [
      caller(`run:${f.run.id}`, "run"),
      caller(`trigger:${occurrence.event.id}`, "program"),
      caller(`connection:${everything.id}`, "connection"),
      caller(`connection:${selected.id}`, "connection"),
    ];
    const { registry, calls } = spyRegistry();
    const door = { registry, admit: agentCommandAdmission(database) };
    // Each caller's commands at once: the Home's pool runs them side by side.
    for (const agent of callers)
      await Promise.all(
        types.map(async (type) => {
          const command = sample(type, f.threadId);
          const { answer } = await admitCommand(database, {
            ownerUserId: f.userId,
            subject: commandSubject(agent.key),
            command: command as never,
          });
          const outcome = dispatchCommand(agent, command, door);
          if (answer === "not_found")
            await expect(outcome, `${agent.key} ${type}`).rejects.toMatchObject({
              code: "not_found",
              message: "That item is unavailable.",
            });
          else
            await expect(outcome, `${agent.key} ${type}`).resolves.toMatchObject({ status: "ask" });
        }),
      );
    expect(calls).toEqual([]);
  });

  it("runs a handler written for agents with an authority the store admits again", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture(`door-any-${randomUUID().slice(0, 8)}`);
    const { database } = storeFixture;
    await database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.threadId)
      .execute();
    await database
      .updateTable("runs")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.run.id)
      .execute();
    const { registry } = spyRegistry();
    const seen: CommandAuthority[] = [];
    const any = {
      accepts: "any" as const,
      run: async (_actor: unknown, command: HostApiCommand, on: { authority: unknown }) => {
        if (isCommandAuthority(on.authority)) seen.push(on.authority);
        return { type: command.type } as never;
      },
    };
    const door = {
      registry: { ...registry, "machine.rename": any } as unknown as CommandRegistry,
      admit: agentCommandAdmission(database),
    };
    const run = {
      kind: "run",
      key: `run:${f.run.id}`,
      userId: f.userId,
      accessMode: "full-access",
    } as unknown as AgentCaller;
    const command = sample("machine.rename", f.threadId);
    await expect(dispatchCommand(run, command, door)).resolves.toEqual({
      status: "done",
      output: { type: "machine.rename" },
    });
    expect(seen).toHaveLength(1);
    // The identity it carries is admitted again where the store commits, inside its transaction.
    await database.transaction().execute(async (transaction) => {
      await seen[0]!.identity.admit!(transaction);
    });
    await database
      .updateTable("runs")
      .set({ status: "completed", completedAt: new Date() })
      .where("id", "=", f.run.id)
      .execute();
    await expect(
      database.transaction().execute((transaction) => seen[0]!.identity.admit!(transaction)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
