import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentGrant, ThreadAccessMode, ThreadId } from "@opensteer/core";
import { AgentConnectionStore, admitCommand, commandSubject } from "@opensteer/database";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { commandFaceStep, commandRow, type CommandRow } from "@opensteer/protocol/command-table";
import { sql } from "kysely";
import { expect, it } from "vitest";
import {
  connectionCredentialPrefix,
  credentialHash,
} from "../mcp/connections/connection-authenticator.js";
import { mcpResourcePath } from "../mcp/connections/connection-oauth.js";
import {
  connectCallerMachine,
  dispatchCallerRun,
  startPrivateMachineHost,
  type CallerRun,
} from "../runtime/private-machine-host.test-support.js";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import { testRpcData } from "../server/test-host-api-request.js";

/**
 * Parity with today's tools, recorded, then frozen (D0a). For each command an agent can send
 * today through a tool, the real tool, as it ships, is called by each kind of caller, and what
 * happened is recorded: allowed, refused (with its code) or asked. The door's answer for the same
 * command and caller must correspond, or the difference is named below for the lead to approve.
 * Run with OPENSTEER_RECORD_TOOL_PARITY=1 to write the fixture; after the tools are gone the
 * fixture is the record the door is held to.
 */
const fixturePath = new URL("./tool-parity.fixture.json", import.meta.url);

type Caller = "own-full" | "own-supervised" | "everything" | "selected-covering" | "selected-not";
type Outcome = "allowed" | "asked" | "not_found" | `refused:${string}`;
type Door = "now" | "ask" | "not_found";

/** Differences the door makes on purpose, each with why; anything else fails. */
const decided: Readonly<Record<string, string>> = {
  "trigger.cancel / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "trigger.run / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "trigger.status.set (archive) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "trigger.status.set (pause) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "trigger.update (name) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "trigger.update (program) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "execution.preferences.remember (lower) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "harness.rename / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "machine.rename / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "thread.done.set / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "thread.done.set / selected-covering":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "thread.rename / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "thread.rename / selected-covering":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "trigger.create / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "trigger.create / selected-covering":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
};

/** The door's answer as the tool would have it: now runs, ask puts it to the person. */
function corresponds(tool: Outcome, door: Door): boolean {
  if (tool === "allowed") return door === "now";
  if (tool === "not_found") return door === "not_found";
  // A tool this caller is not offered is not there for it: the door may also say not found.
  if (tool === "refused:not_offered") return door === "ask" || door === "not_found";
  // Where a tool refused or asked, the door asks: no command is refused for being an agent's.
  return door === "ask";
}

it("records what today's tools let each caller do, and the door answers the same", async () => {
  const database = await cloneTestDatabase("host");
  const close: (() => Promise<unknown>)[] = [];
  try {
    const host = await startPrivateMachineHost(database.url, { logger: false });
    close.unshift(() => host.close());
    const machine = await connectCallerMachine(host, {
      name: "Parity computer",
      token: host.hostingRunnerEnrollmentToken,
    });
    close.unshift(() => machine.close());
    const owner = host.ownerId;
    // The fixture computer runs automation programs (tool contract version 5), as a released one does.
    await host.store.database
      .updateTable("runners")
      .set({
        capabilities: sql`(select jsonb_agg(distinct value) from jsonb_array_elements_text(capabilities || '["trigger-program-v5"]'::jsonb))`,
      } as never)
      .where("id", "=", machine.runnerId)
      .execute();
    const task = async (title: string, accessMode: ThreadAccessMode = "full-access") => {
      const created = await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          environmentId: machine.environmentId,
          harnessInstanceId: machine.harnessInstanceId,
          idempotencyKey: randomUUID(),
          modelSelection: {
            modelId: "gpt-5.6-sol",
            options: { effort: "low" },
            providerId: "openai",
          },
          title,
          accessMode,
          type: "thread.create",
        } as never,
        { headers: host.ownerHeaders },
      );
      return (created as { thread: { id: ThreadId } }).thread.id;
    };
    const runIn = async (accessMode: ThreadAccessMode, key: string): Promise<CallerRun> =>
      dispatchCallerRun(host, machine, {
        key,
        title: key,
        threadId: await task(key, accessMode),
      });
    const mcp = async (url: URL, bearer: string) => {
      const client = new Client({ name: "tool-parity", version: "1" });
      close.unshift(() => client.close());
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: `Bearer ${bearer}` } },
        }) as unknown as Transport,
      );
      return client;
    };
    const runUrl = new URL(hostInternalRoutePaths.mcp, host.origin);
    const connectionUrl = new URL(mcpResourcePath, host.origin);
    const connections = new AgentConnectionStore(host.store.database);
    const connect = async (grant: AgentGrant) => {
      const record = await connections.create({
        userId: owner,
        label: "Parity agent",
        clientName: "Parity agent",
        accessMode: "full-access",
        resource: connectionUrl.href,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        grant,
      });
      const token = `${connectionCredentialPrefix}${randomBytes(32).toString("base64url")}`;
      await connections.activate(record.id, credentialHash(token));
      return { id: record.id, client: await mcp(connectionUrl, token) };
    };

    const full = await runIn("full-access", "parity-full");
    const supervised = await runIn("approval-required", "parity-supervised");
    const everything = await connect({ scope: "everything" });
    const covering = await connect({ scope: "selected", tasks: true, resources: [] });
    const not = await connect({ scope: "selected", tasks: false, resources: [] });
    // The task each connection's work is in: its own lineage's.
    const lineage = await task("Covered task");
    await host.store.database
      .updateTable("threads")
      .set({ originConnectionId: covering.id })
      .where("id", "=", lineage)
      .execute();
    const callers: Record<
      Caller,
      { readonly key: string; readonly client: Client; readonly task: ThreadId }
    > = {
      "own-full": {
        key: `run:${full.runId}`,
        client: await mcp(runUrl, full.toolsToken),
        task: full.threadId,
      },
      "own-supervised": {
        key: `run:${supervised.runId}`,
        client: await mcp(runUrl, supervised.toolsToken),
        task: supervised.threadId,
      },
      everything: {
        key: `connection:${everything.id}`,
        client: everything.client,
        task: await task("Person's task"),
      },
      "selected-covering": {
        key: `connection:${covering.id}`,
        client: covering.client,
        task: lineage,
      },
      "selected-not": { key: `connection:${not.id}`, client: not.client, task: lineage },
    };
    const deviceId = await host.store.requireSelfDeviceId(machine.runnerId);
    const others: Record<Caller, ThreadId> = {
      "own-full": await task("Another task"),
      "own-supervised": await task("Another task", "approval-required"),
      everything: callers.everything.task,
      "selected-covering": lineage,
      "selected-not": lineage,
    };

    /** One command an agent can send today, the tool that sends it, and the command it is. */
    interface Scenario {
      readonly name: string;
      readonly tool: string;
      readonly args: (caller: Caller) => Promise<Record<string, unknown>> | Record<string, unknown>;
      readonly command: (caller: Caller) => Record<string, unknown>;
    }
    const scenarios: Scenario[] = [
      {
        name: "thread.rename",
        tool: "opensteer_task_update",
        args: (c) => ({ taskId: callers[c].task, title: "Renamed by parity" }),
        command: (c) => ({
          type: "thread.rename",
          threadId: callers[c].task,
          title: "Renamed by parity",
        }),
      },
      {
        name: "thread.sendMessage",
        tool: "opensteer_task_send",
        // Another task: an agent does not message its own active task.
        args: (c) => ({ taskId: others[c], message: "A note", delivery: "queue" }),
        command: (c) => ({
          type: "thread.sendMessage",
          threadId: others[c],
          content: [{ type: "text", text: "A note" }],
          delivery: "queue",
        }),
      },
      {
        name: "thread.create",
        tool: "opensteer_task_create",
        args: () => ({
          mode: "async",
          timeoutMs: 1_000,
          message: "Start this",
          title: "Parity child",
        }),
        command: () => ({ type: "thread.create", input: {}, title: "Parity child" }),
      },
      {
        name: "execution.preferences.remember (lower)",
        tool: "opensteer_defaults_update",
        args: () => ({ accessMode: "approval-required" }),
        command: () => ({
          type: "execution.preferences.remember",
          accessMode: "approval-required",
        }),
      },
      {
        name: "harness.rename",
        tool: "opensteer_ai_account_update",
        args: () => ({
          aiAccountId: machine.harnessInstanceId,
          action: "rename",
          name: "Parity account",
        }),
        command: () => ({
          type: "harness.rename",
          environmentId: machine.environmentId,
          harnessInstanceId: machine.harnessInstanceId,
          name: "Parity account",
        }),
      },
      {
        name: "machine.rename",
        tool: "computer_update",
        args: () => ({ computerId: deviceId, name: "Parity computer" }),
        command: () => ({ type: "machine.rename", machineId: deviceId, name: "Parity computer" }),
      },
      {
        name: "trigger.create",
        tool: "opensteer_automation_create",
        args: (c) => ({
          taskId: callers[c].task,
          name: "Parity reminder",
          program: {
            language: "javascript",
            source: "export default async () => null",
            toolContractVersion: 5,
          },
          source: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
        }),
        command: (c) => ({ type: "trigger.create", input: { anchorThreadId: callers[c].task } }),
      },
      {
        name: "thread.done.set",
        tool: "opensteer_task_update",
        args: (c) => ({ taskId: callers[c].task, done: true }),
        command: (c) => ({ type: "thread.done.set", threadId: callers[c].task, done: true }),
      },
    ];

    /** An automation the person made on a task: what each caller's automation tools act on. */
    const automation = async (threadId: ThreadId) => {
      const created = await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "trigger.create",
          idempotencyKey: randomUUID(),
          input: {
            anchorThreadId: threadId,
            name: "Person's reminder",
            program: {
              language: "javascript",
              source: "export default async () => null",
              toolContractVersion: 5,
            },
            source: {
              kind: "schedule",
              schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
            },
          },
        } as never,
        { headers: host.ownerHeaders },
      );
      const trigger = (created as { trigger: { id: string; currentRevisionId: string } }).trigger;
      return { id: trigger.id, revision: trigger.currentRevisionId };
    };
    const automations = {} as Record<string, Record<Caller, { id: string; revision: string }>>;
    const automationFor = async (scenario: string, caller: Caller) => {
      automations[scenario] ??= {} as Record<Caller, { id: string; revision: string }>;
      return (automations[scenario][caller] ??= await automation(callers[caller].task));
    };
    const control = (
      name: string,
      action: string,
      type: string,
      extra: Record<string, unknown> = {},
    ): Scenario => ({
      name,
      tool: "opensteer_automation_control",
      args: async (c) => ({ automationId: (await automationFor(name, c)).id, action }),
      command: (c) => ({ type, triggerId: automations[name]?.[c]?.id ?? "trg_missing", ...extra }),
    });
    scenarios.push(
      {
        name: "trigger.update (name)",
        tool: "opensteer_automation_update",
        args: async (c) => {
          const made = await automationFor("trigger.update (name)", c);
          return {
            automationId: made.id,
            expectedRevisionId: made.revision,
            name: "Renamed reminder",
          };
        },
        command: (c) => ({
          type: "trigger.update",
          triggerId: automations["trigger.update (name)"]?.[c]?.id,
          input: { name: "Renamed reminder" },
        }),
      },
      {
        name: "trigger.update (program)",
        tool: "opensteer_automation_update",
        args: async (c) => {
          const made = await automationFor("trigger.update (program)", c);
          return {
            automationId: made.id,
            expectedRevisionId: made.revision,
            program: {
              language: "javascript",
              source: "export default async () => 1",
              toolContractVersion: 5,
            },
          };
        },
        command: (c) => ({
          type: "trigger.update",
          triggerId: automations["trigger.update (program)"]?.[c]?.id,
          input: { program: {} },
        }),
      },
      control("trigger.status.set (pause)", "pause", "trigger.status.set", { status: "paused" }),
      control("trigger.status.set (archive)", "archive", "trigger.status.set", {
        status: "archived",
      }),
      control("trigger.run", "run_now", "trigger.run"),
      control("trigger.cancel", "cancel_pending", "trigger.cancel"),
    );

    const recorded: Record<string, Record<Caller, Outcome>> = {};
    const differences: string[] = [];
    for (const scenario of scenarios) {
      recorded[scenario.name] = {} as Record<Caller, Outcome>;
      for (const caller of Object.keys(callers) as Caller[]) {
        // The thing it acts on first, then what the door answers, so the tool's effect cannot change it.
        const args = await scenario.args(caller);
        const command = { idempotencyKey: randomUUID(), ...scenario.command(caller) } as {
          readonly type: string;
          readonly idempotencyKey: string;
        };
        const admission = await admitCommand(host.store.database, {
          ownerUserId: owner,
          subject: commandSubject(callers[caller].key),
          command: command as never,
        });
        const row = commandRow(command.type as never) as unknown as CommandRow;
        const connection = caller !== "own-full" && caller !== "own-supervised";
        const door: Door =
          admission.answer === "now" &&
          admission.face !== undefined &&
          commandFaceStep(row, admission.face, {
            connection,
            selected: caller.startsWith("selected"),
          }) === "A"
            ? "now"
            : admission.answer === "now"
              ? "ask"
              : admission.answer;
        // A server offering this caller no tools at all has no tools/call: the tool is not there.
        const result = await callers[caller].client
          .callTool({ name: scenario.tool, arguments: args })
          .catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === -32601)
              return { isError: true, structuredContent: { error: { code: "not_found" } } };
            throw error;
          });
        const error = (result.structuredContent as { error?: { code?: string } } | undefined)
          ?.error;
        // Asked: the tool handed back a Request for the person, not a pending occurrence or run.
        const content = (result.structuredContent ?? {}) as Record<string, unknown>;
        const pending = content.status === "pending" && typeof content.requestId === "string";
        // A tool this caller is not offered says so in MCP's own words.
        const notOffered = JSON.stringify((result as { content?: unknown }).content ?? "").includes(
          "-32602",
        );
        const tool: Outcome = !result.isError
          ? pending
            ? "asked"
            : "allowed"
          : notOffered
            ? "refused:not_offered"
            : error?.code === "not_found"
              ? "not_found"
              : `refused:${error?.code ?? "unknown"}`;
        recorded[scenario.name]![caller] = tool;
        if (process.env.OPENSTEER_TOOL_PARITY_TRACE === "1" && result.isError)
          console.error("PARITY", scenario.name, caller, JSON.stringify(result).slice(0, 600));
        const label = `${scenario.name} / ${caller}: tool ${tool}, door ${door}`;
        if (!corresponds(tool, door) && !decided[`${scenario.name} / ${caller}`])
          differences.push(label);
      }
    }
    if (process.env.OPENSTEER_RECORD_TOOL_PARITY === "1" || !existsSync(fixturePath))
      writeFileSync(fixturePath, `${JSON.stringify(recorded, null, 1)}\n`);
    else expect(recorded).toEqual(JSON.parse(readFileSync(fixturePath, "utf8")));
    expect(differences).toEqual([]);
  } finally {
    for (const step of close) await step().catch(() => undefined);
    await database.drop?.();
  }
}, 180_000);
