import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentGrant, ThreadAccessMode, ThreadId } from "@opensteer/core";
import type { ShellSessionId } from "@opensteer/protocol";
import { AgentConnectionStore } from "@opensteer/database";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { testReadyHarnessCatalog } from "@opensteer/database/test-support/store";
import {
  commandFace,
  commandResourceKey,
  commandRow,
  commandTable,
  type CommandResource,
  type CommandRow,
} from "@opensteer/protocol/command-table";
import { OpensteerError } from "@opensteer/core";
import { agentTools } from "@opensteer/agent-tools";
import { CommandService } from "@opensteer/orchestration";
import type { HostApiCommand } from "@opensteer/protocol";
import expectedRows from "../../../../packages/protocol/src/command-table.rows.json" with { type: "json" };
import { AdministrationService } from "../administration/administration-service.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { ThreadService } from "../threads/thread-service.js";
import { TriggerService } from "../triggers/trigger-service.js";
import { TabService } from "../tabs/tab-service.js";
import { startBrowserRuntime } from "../browser/browser-runtime.test-support.js";
import { agentCommandAdmission, agentCommandScope, dispatchCommand } from "./dispatch.js";
import type { CommandRegistry } from "./registry.js";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import {
  connectionCredentialPrefix,
  credentialHash,
} from "../mcp/connections/connection-authenticator.js";
import { mcpResourcePath } from "../mcp/connections/connection-oauth.js";
import { connectTargetMachine } from "../runtime/machine-access-protocol.test-support.js";
import {
  configurePersonalRemoteAccess,
  connectCallerMachine,
  dispatchCallerRun,
  enrollmentToken,
  rejectRunsExcept,
  startPrivateMachineHost,
  type CallerRun,
} from "../runtime/private-machine-host.test-support.js";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";

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
/** What the door answers, or why it could not read the command at all. */
type Door = "now" | "ask" | "not_found" | `invalid:${string}`;

/** Differences the door makes on purpose, each with why; anything else fails. */
const decided: Readonly<Record<string, string>> = {
  "trigger.cancel / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "trigger.status.set (archive) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "trigger.status.set (pause) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "trigger.update (name) / everything":
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
  "thread.execution.update / selected-covering":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "thread.rename / selected-covering":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "trigger.create / selected-covering":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "tab.open (guest) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "tab.open (profile) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "tab.close (the person's tab) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "thread.input.cancel / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "thread.input.cancel / selected-covering":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "thread.input.move / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "thread.input.move / selected-covering":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "thread.input.steer / selected-covering":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "thread.inputQueue.resume / selected-covering":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "tab.organize (into a new group) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "tab.group.update (rename) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "tab.open (profile) / own-full":
    "the test's browser runtime opens guest pages but not a profile's: the open was admitted and failed in the browser (\"The browser could not open this page\")",
  "tab.close (the person's tab) / own-supervised":
    "D3, accepted: a Supervised agent is asked about tabs it did not open; today's tab_close lets it close the person's tab",
  // Recorded before A5 removes the administration tools (lead, item 1).
  "harness.enabled.set (disable) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "harness.enabled.set (enable) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "harness.default.set / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "harness.model.configure / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "execution.preferences.remember (selection) / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "machine.access.session.stop / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "machine.revoke / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "browser.profile.rename / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "browser.history.remove / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "browser.history.clear / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "browser.site.remove / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
  "browser.profile.delete / everything":
    "differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2)",
};

/** Step-A commands no tool performs today, each with why; a scenario for one of them fails. */
const withoutTool: Readonly<Record<string, string>> = {
  "channel.connection.status.set":
    "the messaging bridge tools were removed at 5766f3613; a chat account is another connection (X13)",
  "viewer.quietTasks.update": "no tool sets quiet-task days; only the person's settings screen",
  "viewer.timeZone.update": "no tool sets the time zone; only the person's apps send it",
  "integration.grant.revoke":
    "no tool revokes a device grant: computer_apps lists, app_access_request asks for more",
  "integration.disconnect":
    "no tool disconnects a device app: computer_apps lists, app_access_request asks for more",
};
/**
 * Step-A commands a tool performs that the recording does not cover yet, each with its tool;
 * owed before this branch is trial-merged (the lead's item 2). The list only shrinks.
 */
const owed: Readonly<Record<string, string>> = {
  "node.stop": "opensteer_subagent_stop (a subagent)",
  "assignment.cancel": "opensteer_delegation_cancel",
  "request.respond": "opensteer_request_answer",
  "plugin.remove": "local_server_remove",
  "plugins.install": "opensteer_plugin_install",
  "plugins.version.activate": "opensteer_plugin_activate",
  "plugins.remove": "opensteer_plugin_remove",
  "plugins.schedule.configure": "opensteer_plugin_resource_update",
  "plugins.workflow.start": "opensteer_plugin_resource_update",
  "plugins.workflow.stop": "opensteer_plugin_resource_update",
  "plugins.webhook.remove": "opensteer_plugin_resource_update",
  "app.start": "app_start",
  "app.stop": "app_stop",
  "app.delete": "app_delete",
};

/** The door's answer as the tool would have it: now runs, ask puts it to the person. */
function corresponds(tool: Outcome, door: Door): boolean {
  if (door.startsWith("invalid:")) return false;
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
      modelSettings: true,
      // Two callers' own Runs, three busy tasks' and the Runs callers may not stop run at once.
      maxConcurrentRuns: 16,
      // Its engine steers a running turn, so a waiting message can be steered into one.
      steers: true,
      browser: {
        runtimeId: "browser-runtime-integration",
        wireVersion: 2,
        cdpBoundary: 1,
        sharedControl: 1,
        tabRestoreVersion: 1,
        surfaceState: 1,
      },
    });
    close.unshift(() => machine.close());
    // Every answer below is from a connected computer: if the Host ends its connection, the run
    // says when and why rather than recording what a computer that is gone would answer.
    let current = "setup";
    const machineClosed: string[] = [];
    machine.primary.socket.on("close", (code: number, reason: Buffer) =>
      machineClosed.push(`${code} ${reason.toString()} during ${current}`),
    );
    // The Runs the test starts are accepted as it starts them; every other Run the Home sends this
    // computer (a reminder that fired, a message's) is refused before admission, so none is left
    // unanswered to end the connection.
    const starting = new Set<string>();
    rejectRunsExcept(machine.primary, (threadId) => starting.has(threadId));
    const accepted = async (threadId: ThreadId, key: string) => {
      starting.add(threadId);
      try {
        return await dispatchCallerRun(host, machine, { key, title: key, threadId });
      } finally {
        starting.delete(threadId);
      }
    };
    // Its browser, as the hot-path test runs one: tabs open for real.
    const browserRuntime = await startBrowserRuntime(host.hostPort, "unused-existing-main", {
      primary: machine.primary,
      agentReady: true,
      targetedStreaming: true,
      personalTabs: true,
      surfaceState: true,
      uniqueTabs: true,
      tabCommands: true,
    });
    close.unshift(() => browserRuntime.close());
    await until(
      "the fixture computer's browser to connect to the Host",
      async () => host.runtime.browser.available,
      30_000,
    );
    await host.runtime.browser.initialize();
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
      accepted(await task(key, accessMode), key);
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
      return { id: record.id, token, client: await mcp(connectionUrl, token) };
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

    // A task with a Run in progress, per caller, where the person's messages wait their turn:
    // what the queue tools act on. The covered connection's is in its lineage.
    const busyTask = async (key: string, accessMode: ThreadAccessMode, origin?: string) => {
      const threadId = await task(key, accessMode);
      if (origin)
        await host.store.database
          .updateTable("threads")
          .set({ originConnectionId: origin })
          .where("id", "=", threadId)
          .execute();
      const run = await accepted(threadId, key);
      return { threadId, runId: run.runId };
    };
    const busyFull = await busyTask("parity-busy", "full-access");
    const busySupervised = await busyTask("parity-busy-supervised", "approval-required");
    const busyLineage = await busyTask("parity-busy-lineage", "full-access", covering.id);
    const busy: Record<Caller, { readonly threadId: ThreadId; readonly runId: string }> = {
      "own-full": busyFull,
      "own-supervised": busySupervised,
      everything: busyFull,
      "selected-covering": busyLineage,
      "selected-not": busyLineage,
    };

    /** The person's own command, as the apps send it. */
    const asPerson = (command: Record<string, unknown>) =>
      testRpcData(
        host.origin,
        "commands.dispatch",
        { idempotencyKey: randomUUID(), ...command } as never,
        { headers: host.ownerHeaders },
      );
    /** The person's message, waiting behind the busy task's Run. */
    const waiting = async (caller: Caller, text: string) => {
      const sent = (await asPerson({
        type: "thread.sendMessage",
        threadId: busy[caller].threadId,
        content: [{ type: "text", text }],
        delivery: "queue",
      })) as { message: { id: string }; run: unknown };
      return sent.message.id;
    };
    /** A Run each caller may stop, fresh for each: never the caller's own. */
    const stoppable = {} as Record<Caller, { threadId: ThreadId; runId: string }>;
    let stoppableCount = 0;
    const stoppableRun = async (caller: Caller) =>
      (stoppable[caller] = await busyTask(
        `parity-stoppable-${(stoppableCount += 1)}`,
        caller === "own-supervised" ? "approval-required" : "full-access",
        caller.startsWith("selected-") ? covering.id : undefined,
      ));
    /** The messages each caller's queue scenario acts on, made as its arguments are. */
    const queued = {} as Record<Caller, { first: string; second?: string }>;
    const callerNames = Object.keys(callers) as Caller[];
    const each = async <T>(make: (caller: Caller) => Promise<T>) => {
      const made = {} as Record<Caller, T>;
      for (const caller of callerNames) made[caller] = await make(caller);
      return made;
    };
    // What removing acts on is one thing per caller: a computer, a session on it and a profile.
    // Other computers connect only with remote access on.
    await configurePersonalRemoteAccess(host, {
      schemaVersion: 1,
      mode: "private",
      routeOrigin: "https://personal.tool-parity.test",
    });
    const targets = await each(async (caller) => {
      const name = `Parity target ${caller}`;
      const target = await connectTargetMachine(host, {
        name,
        token: await enrollmentToken(host, {
          allowedModules: ["shell"],
          idempotencyKey: `parity-target-${caller}`,
          name,
        }),
      });
      close.unshift(() => target.close());
      const sessionId = `shs_${randomUUID()}` as ShellSessionId;
      await host.store.reserveShellSession({
        callerMachineName: "Parity computer",
        callerRunnerId: machine.runnerId,
        policyRevision: 1,
        requestedBy: owner,
        runId: full.runId,
        runnerId: target.runnerId,
        sessionId,
        startedAt: new Date(),
        threadId: full.threadId,
        threadTitle: "parity-full",
      });
      return {
        deviceId: await host.store.requireSelfDeviceId(target.runnerId),
        sessionId,
      };
    });
    const profiles = await each(async (caller) =>
      host.store.createBrowserProfile({
        name: `Parity profile ${caller}`,
        ownerId: owner,
        homeRunnerId: machine.runnerId,
        idempotencyKey: `parity-profile-${caller}`,
      }),
    );
    /** A tab the person opened, one per caller: what the tab tools act on that is not theirs. */
    const personTabs = {} as Record<Caller, string>;
    const personTab = async (caller: Caller) => {
      const opened = (await asPerson({
        type: "tab.open",
        target: { kind: "page", guest: true, url: "about:blank" },
      })) as { tab: { tabId: string } };
      return (personTabs[caller] = opened.tab.tabId);
    };
    /** A tab group the person made, one per caller: what tab_group_update acts on. */
    const personGroups = {} as Record<Caller, string>;
    const personGroup = async (caller: Caller) => {
      const organized = (await asPerson({
        type: "tab.organize",
        tabIds: [await personTab(caller)],
        group: { name: `Person ${caller}`, color: "green" },
      })) as { tabs: { tabId: string; groupId?: string | null }[] };
      const grouped = organized.tabs.find((tab) => tab.tabId === personTabs[caller]);
      return (personGroups[caller] = grouped!.groupId!);
    };
    const harness = {
      environmentId: machine.environmentId,
      harnessInstanceId: machine.harnessInstanceId,
    };
    // An engine that runs nothing: one in use is not turned off or reconfigured, by anyone.
    const spareInstance = await host.store.createHarnessInstance({
      config: {},
      driverKind: "codex" as never,
      environmentId: machine.environmentId,
      name: "Spare account",
      sourceId: "openai",
      stateKind: "isolated",
    });
    const spare = { environmentId: machine.environmentId, harnessInstanceId: spareInstance.id };
    // Its catalog lists the model whose limits are set, as a refreshed one would; recorded again
    // before that scenario, since a Runner's new descriptor (its browser) re-reads engines.
    const catalogued = async () => {
      const ready = testReadyHarnessCatalog(spareInstance.id);
      const current = (await host.store.getHarnessInstance(spareInstance.id))!;
      await host.store.recordHarnessCatalogs({
        environmentId: machine.environmentId,
        catalogs: [
          {
            ...ready,
            driverKind: "codex" as never,
            models: ready.models.map((model) => ({ ...model, modelId: "gpt-5.6-sol" as never })),
          },
        ],
        expectedRevisions: new Map([[spareInstance.id, current.runtimeRevision]]),
      });
    };
    await catalogued();
    const modelChoice = {
      modelId: "gpt-5.6-sol",
      options: { effort: "low" },
      providerId: "openai",
    };

    /** One command an agent can send today, the tool that sends it, and the command it is. */
    interface Scenario {
      readonly name: string;
      readonly tool: string;
      readonly args: (caller: Caller) => Promise<Record<string, unknown>> | Record<string, unknown>;
      /** None for a read: the tool's answer is recorded for opensteer_state to be held to. */
      readonly command?: (caller: Caller) => Record<string, unknown>;
      /** The person puts things back before each caller, so each acts on the same state. */
      readonly before?: () => Promise<unknown>;
      readonly after?: () => Promise<unknown>;
    }
    const scenarios: Scenario[] = [
      {
        name: "thread.execution.update",
        tool: "opensteer_task_configure",
        // First: the other task has no Run yet (a sent message would start one, and an engine
        // does not change under an active Run).
        args: (c) => ({
          taskId: others[c],
          aiAccountId: machine.harnessInstanceId,
          modelSelection: modelChoice,
        }),
        command: (c) => ({
          type: "thread.execution.update",
          threadId: others[c],
          harnessInstanceId: machine.harnessInstanceId,
          modelSelection: modelChoice,
        }),
      },
      {
        name: "thread.input.cancel",
        tool: "opensteer_task_queue",
        args: async (c) => {
          queued[c] = { first: await waiting(c, `Cancel me ${c}`) };
          return { taskId: busy[c].threadId, action: "cancel", messageId: queued[c].first };
        },
        command: (c) => ({
          type: "thread.input.cancel",
          threadId: busy[c].threadId,
          messageId: queued[c]?.first,
        }),
      },
      {
        name: "thread.input.move",
        tool: "opensteer_task_queue",
        args: async (c) => {
          queued[c] = {
            first: await waiting(c, `Waiting first ${c}`),
            second: await waiting(c, `Moved ahead ${c}`),
          };
          return {
            taskId: busy[c].threadId,
            action: "move",
            messageId: queued[c].second,
            beforeMessageId: queued[c].first,
          };
        },
        command: (c) => ({
          type: "thread.input.move",
          threadId: busy[c].threadId,
          messageId: queued[c]?.second,
          beforeMessageId: queued[c]?.first,
        }),
      },
      {
        name: "thread.input.steer",
        tool: "opensteer_task_queue",
        args: async (c) => {
          queued[c] = { first: await waiting(c, `Steer with me ${c}`) };
          return {
            taskId: busy[c].threadId,
            action: "steer",
            messageId: queued[c].first,
            expectedRunId: busy[c].runId,
          };
        },
        command: (c) => ({
          type: "thread.input.steer",
          threadId: busy[c].threadId,
          messageId: queued[c]?.first,
          expectedRunId: busy[c].runId,
        }),
      },
      {
        name: "thread.inputQueue.resume",
        tool: "opensteer_task_resume",
        // The person paused the other task's queue (as stopping its Run does); nothing waits in
        // it, so resuming releases nothing.
        before: async () => {
          for (const threadId of new Set(Object.values(others)))
            await host.store.database
              .updateTable("threads")
              .set({ inputQueuePaused: true, inputQueuePausedBy: owner })
              .where("id", "=", threadId)
              .execute();
        },
        after: async () => {
          await host.store.database
            .updateTable("threads")
            .set({ inputQueuePaused: false, inputQueuePausedBy: null })
            .where("id", "in", [...new Set(Object.values(others))])
            .execute();
        },
        args: (c) => ({ taskId: others[c] }),
        command: (c) => ({ type: "thread.inputQueue.resume", threadId: others[c] }),
      },
      {
        name: "run.interrupt",
        tool: "opensteer_task_interrupt",
        args: async (c) => ({ taskId: (await stoppableRun(c)).threadId }),
        command: (c) => ({
          type: "run.interrupt",
          threadId: stoppable[c]?.threadId,
          runId: stoppable[c]?.runId,
        }),
      },
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
        // A task a tool creates stands alone, in the caller's engine and its mode.
        command: (c) => ({
          type: "thread.create",
          environmentId: machine.environmentId,
          harnessInstanceId: machine.harnessInstanceId,
          modelSelection: {
            modelId: "gpt-5.6-sol",
            options: { effort: "low" },
            providerId: "openai",
          },
          title: "Parity child",
          accessMode: c === "own-supervised" ? "approval-required" : "full-access",
        }),
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
        command: (c) => ({
          type: "trigger.create",
          input: {
            anchorThreadId: callers[c].task,
            name: "Parity reminder",
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
        }),
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
          input: {
            expectedRevisionId: automations["trigger.update (name)"]?.[c]?.revision,
            name: "Renamed reminder",
          },
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
          input: {
            expectedRevisionId: automations["trigger.update (program)"]?.[c]?.revision,
            program: {
              language: "javascript",
              source: "export default async () => 1",
              toolContractVersion: 5,
            },
          },
        }),
      },
      control("trigger.status.set (pause)", "pause", "trigger.status.set", { status: "paused" }),
      control("trigger.status.set (archive)", "archive", "trigger.status.set", {
        status: "archived",
      }),
      control("trigger.run", "run_now", "trigger.run"),
      control("trigger.cancel", "cancel_pending", "trigger.cancel"),
    );

    // Everything the administration tools A5 removes can do, while they still exist.
    const lowered = () =>
      asPerson({ type: "execution.preferences.remember", accessMode: "approval-required" });
    const enabled = (on: boolean) => () =>
      asPerson({ type: "harness.enabled.set", ...spare, enabled: on });
    scenarios.push(
      // Before the switch scenarios: turning an engine off and on again re-reads what it offers.
      {
        name: "harness.model.configure",
        tool: "opensteer_ai_account_update",
        // The person sets the same limits first, so the agent's call changes nothing new.
        before: async () => {
          // Model settings come from the connected computer's own descriptor (its OpenAI source
          // offers them), and the model from the engine's catalog, written again on each attempt.
          // A refusal while the computer is still connected is retried; once it is gone, the wait
          // says so at once.
          await until(
            "the spare engine to offer gpt-5.6-sol again, so the person's same limits apply",
            async () => {
              if (machineClosed.length)
                throw new Error(
                  `the fixture computer's connection closed: ${machineClosed.join("; ")}`,
                );
              return catalogued()
                .then(() =>
                  asPerson({
                    type: "harness.model.configure",
                    ...spare,
                    nativeModelId: "gpt-5.6-sol",
                    settings: { contextWindow: 100_000 },
                  }),
                )
                .then(() => true);
            },
            30_000,
          );
        },
        args: () => ({
          aiAccountId: spare.harnessInstanceId,
          action: "set_model_limits",
          modelLimits: { modelId: "gpt-5.6-sol", limits: { contextWindow: 100_000 } },
        }),
        command: () => ({
          type: "harness.model.configure",
          ...spare,
          nativeModelId: "gpt-5.6-sol",
          settings: { contextWindow: 100_000 },
        }),
      },
      {
        name: "harness.enabled.set (disable)",
        tool: "opensteer_ai_account_update",
        before: enabled(true),
        after: enabled(true),
        args: () => ({ aiAccountId: spare.harnessInstanceId, action: "disable" }),
        command: () => ({ type: "harness.enabled.set", ...spare, enabled: false }),
      },
      {
        name: "harness.enabled.set (enable)",
        tool: "opensteer_ai_account_update",
        before: enabled(false),
        after: enabled(true),
        args: () => ({ aiAccountId: spare.harnessInstanceId, action: "enable" }),
        command: () => ({ type: "harness.enabled.set", ...spare, enabled: true }),
      },
      {
        name: "harness.default.set",
        tool: "opensteer_ai_account_update",
        args: () => ({ aiAccountId: machine.harnessInstanceId, action: "set_default" }),
        command: () => ({ type: "harness.default.set", ...harness }),
      },
      {
        name: "execution.preferences.remember (raise)",
        tool: "opensteer_defaults_update",
        before: lowered,
        after: lowered,
        args: () => ({ accessMode: "full-access" }),
        command: () => ({ type: "execution.preferences.remember", accessMode: "full-access" }),
      },
      {
        name: "execution.preferences.remember (selection)",
        tool: "opensteer_defaults_update",
        before: lowered,
        args: () => ({
          selection: { aiAccountId: machine.harnessInstanceId, model: modelChoice },
        }),
        command: () => ({
          type: "execution.preferences.remember",
          selection: { ...harness, modelSelection: modelChoice },
        }),
      },
      { name: "defaults (read)", tool: "opensteer_defaults_read", args: () => ({}) },
      {
        name: "machine.access.session.stop",
        tool: "computer_remove",
        args: (c) => ({ target: "session", sessionId: targets[c].sessionId }),
        command: (c) => ({ type: "machine.access.session.stop", sessionId: targets[c].sessionId }),
      },
      {
        name: "machine.revoke",
        tool: "computer_remove",
        args: (c) => ({ target: "computer", computerId: targets[c].deviceId }),
        command: (c) => ({ type: "machine.revoke", machineId: targets[c].deviceId }),
      },
      {
        name: "browser.profile.rename",
        tool: "browser_profile_update",
        args: (c) => ({ profileId: profiles[c].id, name: "Renamed profile" }),
        command: (c) => ({
          type: "browser.profile.rename",
          profileId: profiles[c].id,
          name: "Renamed profile",
        }),
      },
      {
        name: "browser.history.remove",
        tool: "browser_profile_remove",
        args: (c) => ({
          target: "history_url",
          profileId: profiles[c].id,
          url: "https://parity.example/",
        }),
        command: (c) => ({
          type: "browser.history.remove",
          profileId: profiles[c].id,
          url: "https://parity.example/",
        }),
      },
      {
        name: "browser.history.clear",
        tool: "browser_profile_remove",
        args: (c) => ({ target: "history", profileId: profiles[c].id }),
        command: (c) => ({ type: "browser.history.clear", profileId: profiles[c].id }),
      },
      {
        name: "browser.site.remove",
        tool: "browser_profile_remove",
        args: () => ({ target: "site", site: "https://parity.example" }),
        command: () => ({ type: "browser.site.remove", site: "https://parity.example" }),
      },
      // Tabs (X12): the door is held to what today's tab tools do, page by page.
      {
        name: "tab.open (guest)",
        tool: "tab_open",
        args: () => ({ target: { kind: "page", guest: true, url: "about:blank" } }),
        command: () => ({
          type: "tab.open",
          target: { kind: "page", guest: true, url: "about:blank" },
        }),
      },
      {
        name: "tab.open (profile)",
        tool: "tab_open",
        args: (c) => ({
          target: { kind: "page", profileId: profiles[c].id, url: "about:blank" },
        }),
        command: (c) => ({
          type: "tab.open",
          target: { kind: "page", profileId: profiles[c].id, url: "about:blank" },
        }),
      },
      {
        name: "tab.close (the person's tab)",
        tool: "tab_close",
        args: async (c) => ({ tabIds: [await personTab(c)] }),
        command: (c) => ({ type: "tab.close", tabIds: [personTabs[c]] }),
      },
      {
        name: "tab.organize (into a new group)",
        tool: "tab_organize",
        args: async (c) => ({
          tabIds: [await personTab(c)],
          group: { name: `Parity ${c}`, color: "blue" },
        }),
        command: (c) => ({
          type: "tab.organize",
          tabIds: [personTabs[c]],
          group: { name: `Parity ${c}`, color: "blue" },
        }),
      },
      {
        name: "tab.group.update (rename)",
        tool: "tab_group_update",
        // A group the person made, one per caller: what the tool renames.
        args: async (c) => ({ groupId: await personGroup(c), name: "Renamed by parity" }),
        command: (c) => ({
          type: "tab.group.update",
          groupId: personGroups[c],
          name: "Renamed by parity",
        }),
      },
      {
        name: "browser.profile.delete",
        tool: "browser_profile_remove",
        args: (c) => ({ target: "profile", profileId: profiles[c].id }),
        command: (c) => ({ type: "browser.profile.delete", profileId: profiles[c].id }),
      },
    );

    /** What the door answers this caller for this command, as the tool's outcome reads. */
    // The door as an agent meets it once A5 connects it: the one admission, and handlers that
    // take agents (a stand-in that only says it ran). The command is the one the tool sent.
    const standIn = Object.fromEntries(
      Object.keys(commandTable).map((type) => [
        type,
        { accepts: "any", run: async () => ({ type }) },
      ]),
    ) as unknown as CommandRegistry;
    const agentDoor = {
      registry: standIn,
      admit: agentCommandAdmission(host.store.database),
      scope: agentCommandScope(host.store.database),
    };
    const run = (threadId: ThreadId, runId: string, mode: ThreadAccessMode, key: string) =>
      ({
        kind: "run",
        key,
        userId: owner,
        accessMode: mode,
        thread: { id: threadId },
        claims: { threadId, runId },
      }) as unknown as AgentCaller;
    const linked = (id: string, grant: AgentGrant, key: string) =>
      ({
        kind: "connection",
        key,
        userId: owner,
        connectionId: id,
        accessMode: "full-access",
        grant,
        grantRevision: 1,
      }) as unknown as AgentCaller;
    const agents: Record<Caller, AgentCaller> = {
      "own-full": run(full.threadId, full.runId, "full-access", callers["own-full"].key),
      "own-supervised": run(
        supervised.threadId,
        supervised.runId,
        "approval-required",
        callers["own-supervised"].key,
      ),
      everything: linked(everything.id, { scope: "everything" }, callers.everything.key),
      "selected-covering": linked(
        covering.id,
        { scope: "selected", tasks: true, resources: [] },
        callers["selected-covering"].key,
      ),
      "selected-not": linked(
        not.id,
        { scope: "selected", tasks: false, resources: [] },
        callers["selected-not"].key,
      ),
    };
    const doorAnswer = async (caller: Caller, command: Record<string, unknown>): Promise<Door> =>
      dispatchCommand(
        agents[caller],
        { idempotencyKey: randomUUID(), ...command } as unknown as HostApiCommand,
        agentDoor,
      ).then(
        (outcome): Door => (outcome.status === "done" ? "now" : "ask"),
        (error: unknown): Door =>
          error instanceof OpensteerError && error.code === "not_found"
            ? "not_found"
            : `invalid:${error instanceof OpensteerError ? error.code : "error"}: ${String(
                error instanceof Error ? error.message : error,
              ).slice(0, 200)}`,
      );

    // What a tool really sends, caught where it reaches the Home's services; the door answers
    // it there, before the tool's effect, so the effect cannot change the answer.
    let active:
      | {
          readonly caller: Caller;
          readonly type: string;
          captured?: Record<string, unknown>;
          door?: Door;
        }
      | undefined;
    const intercept = (
      on: object,
      method: string,
      toCommand: (args: readonly unknown[]) => Record<string, unknown> | undefined,
    ) => {
      const original = (on as Record<string, (...args: unknown[]) => unknown>)[method]!;
      vi.spyOn(on as Record<string, (...args: unknown[]) => unknown>, method).mockImplementation(
        async function (this: unknown, ...args: unknown[]) {
          const command = active && !active.captured ? toCommand(args) : undefined;
          if (active && command?.type === active.type) {
            active.captured = command;
            active.door = await doorAnswer(active.caller, command);
          }
          return original.apply(this, args);
        },
      );
    };
    close.push(async () => vi.restoreAllMocks());
    intercept(AdministrationService.prototype, "execute", ([, command]) => ({
      ...(command as Record<string, unknown>),
    }));
    // A Run's task tools and a connection's reach the Home's command service the same way.
    intercept(CommandService.prototype, "renameThread", ([input]) => {
      const i = input as { threadId: string; title: string };
      return { type: "thread.rename", threadId: i.threadId, title: i.title };
    });
    intercept(CommandService.prototype, "setThreadDone", ([input]) => {
      const i = input as { threadId: string; done: boolean };
      return { type: "thread.done.set", threadId: i.threadId, done: i.done };
    });
    intercept(CommandService.prototype, "createThread", ([input]) => {
      const i = input as Record<string, unknown>;
      return {
        type: "thread.create",
        ...Object.fromEntries(
          [
            "environmentId",
            "harnessInstanceId",
            "modelSelection",
            "title",
            "accessMode",
            "parentThreadId",
          ].flatMap((key) => (i[key] === undefined || i[key] === null ? [] : [[key, i[key]]])),
        ),
      };
    });
    intercept(ThreadService.prototype, "configure", ([, command]) => {
      const {
        idempotencyKey: _key,
        continuation: _continuation,
        ...rest
      } = command as Record<string, unknown>;
      return rest;
    });
    for (const method of ["cancel", "move", "steer", "resume", "interrupt"])
      intercept(ThreadService.prototype, method, ([, command]) => {
        const { idempotencyKey: _key, ...rest } = command as Record<string, unknown>;
        return rest;
      });
    intercept(ThreadService.prototype, "sendInput", ([, input]) => {
      const i = input as { threadId: string; content: unknown; policy: string };
      return {
        type: "thread.sendMessage",
        threadId: i.threadId,
        content: i.content,
        delivery: i.policy,
      };
    });
    intercept(TabService.prototype, "open", ([, target]) => ({ type: "tab.open", target }));
    intercept(TabService.prototype, "close", ([, tabIds]) => ({ type: "tab.close", tabIds }));
    intercept(TabService.prototype, "organize", ([, input]) => ({
      type: "tab.organize",
      ...(input as Record<string, unknown>),
    }));
    intercept(TabService.prototype, "updateGroup", ([, input]) => ({
      type: "tab.group.update",
      ...(input as Record<string, unknown>),
    }));
    intercept(TriggerService.prototype, "manage", ([, value]) => {
      const {
        operation,
        idempotencyKey: _key,
        ...rest
      } = value as Record<string, unknown> & {
        operation: string;
        triggerId?: string;
      };
      switch (operation) {
        case "create":
          return { type: "trigger.create", input: rest };
        case "update": {
          const { triggerId, ...input } = rest;
          return { type: "trigger.update", triggerId, input };
        }
        case "set_status":
          return { type: "trigger.status.set", ...rest };
        case "run":
          return { type: "trigger.run", ...rest };
        case "cancel":
          return { type: "trigger.cancel", ...rest };
        default:
          return undefined;
      }
    });

    // Only the person approves: a connection's token and a Run's tools token are not sessions,
    // so neither can send the approval through the person's command route.
    for (const bearer of [everything.token, full.toolsToken]) {
      const refused = await testRpcRequest(
        host.origin,
        "commands.dispatch",
        {
          type: "request.command.approve",
          idempotencyKey: randomUUID(),
          requestId: "req_00000000-0000-4000-8000-000000000001",
          expectedRevision: "1",
          command: {},
        } as never,
        { headers: { authorization: `Bearer ${bearer}` } },
      );
      expect(refused.status, "an agent's credential on the person's command route").toBe(401);
    }

    // Every step-A command has a scenario, or a reason no tool performs it, or is owed by name.
    const covered = new Set(
      scenarios.flatMap((scenario) => scenario.command?.("own-full").type ?? []),
    );
    const stepA = (
      expectedRows.rows as readonly {
        type: string;
        step: string;
        faces: readonly { step?: string }[];
      }[]
    )
      .filter((row) => row.step === "A" || row.faces.some((face) => face.step === "A"))
      .map((row) => row.type);
    expect(
      stepA.filter((type) => !covered.has(type) && !withoutTool[type] && !owed[type]),
      "step-A commands with no scenario, no reason and no owed entry",
    ).toEqual([]);
    expect(
      Object.keys({ ...withoutTool, ...owed }).filter((type) => covered.has(type)),
      "a reason or an owed entry for a command that has a scenario",
    ).toEqual([]);

    // After A5 removed a tool, what it did is the frozen record; the door is still held to it.
    const offeredNames = new Set<string>(agentTools.map(({ name }) => name));
    const frozen = existsSync(fixturePath)
      ? (JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, Record<Caller, Outcome>>)
      : {};
    const recorded: Record<string, Record<Caller, Outcome>> = {};
    const differences: string[] = [];
    const unfaithful: string[] = [];
    const sent: Record<string, Caller[]> = {};
    // Tabs first, while the browser has done nothing else.
    const ordered = [
      ...scenarios.filter((scenario) => scenario.tool.startsWith("tab_")),
      ...scenarios.filter((scenario) => !scenario.tool.startsWith("tab_")),
    ];
    for (const scenario of ordered) {
      recorded[scenario.name] = {} as Record<Caller, Outcome>;
      for (const caller of callerNames) {
        current = `${scenario.name} / ${caller}`;
        await scenario.before?.();
        const args = await scenario.args(caller);
        // The command as the scenario builds it, answered before the tool acts; where the tool
        // sends one, the door answers the tool's own command instead.
        const built = scenario.command?.(caller);
        const answered = built ? await doorAnswer(caller, built) : undefined;
        const gone = !offeredNames.has(scenario.tool);
        active = built && !gone ? { caller, type: built.type as string } : undefined;
        // A server offering this caller no tools at all has no tools/call: the tool is not there.
        const result = gone
          ? { isError: false, structuredContent: {} }
          : await callers[caller].client
              .callTool({ name: scenario.tool, arguments: args })
              .catch((error: unknown) => {
                if (error instanceof Error && "code" in error && error.code === -32601)
                  return { isError: true, structuredContent: { error: { code: "not_found" } } };
                throw error;
              });
        const caught = active;
        active = undefined;
        if (caught?.captured && built) {
          (sent[scenario.name] ??= []).push(caller);
          // The built command decides as the sent one does, so where no tool sends it the door
          // is still asked the same question.
          const row = commandRow(built.type as never) as unknown as CommandRow;
          const governs = (command: Record<string, unknown>) =>
            commandResourceKey((row.governs as (c: unknown) => CommandResource)(command));
          if (
            commandFace(built as never) !== commandFace(caught.captured as never) ||
            governs(built) !== governs(caught.captured)
          )
            unfaithful.push(
              `${scenario.name} / ${caller}: built ${JSON.stringify(built).slice(0, 200)}, sent ${JSON.stringify(caught.captured).slice(0, 200)}`,
            );
        }
        const door = caught?.door ?? answered;
        const error = (result.structuredContent as { error?: { code?: string } } | undefined)
          ?.error;
        // Asked: the tool handed back a Request for the person, not a pending occurrence or run.
        const content = (result.structuredContent ?? {}) as Record<string, unknown>;
        const pending = content.status === "pending" && typeof content.requestId === "string";
        // A tool this caller is not offered says so in MCP's own words.
        const notOffered = JSON.stringify((result as { content?: unknown }).content ?? "").includes(
          "-32602",
        );
        const frozenOutcome = gone ? frozen[scenario.name]?.[caller] : undefined;
        if (gone && !frozenOutcome) throw new Error(`${scenario.name}: removed with no record`);
        const tool: Outcome = frozenOutcome
          ? frozenOutcome
          : !result.isError
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
        const key = `${scenario.name} / ${caller}`;
        if (door && !corresponds(tool, door) !== Boolean(decided[key]))
          differences.push(
            decided[key]
              ? `${key}: named as a difference, but tool ${tool} and door ${door} agree`
              : `${key}: tool ${tool}, door ${door}`,
          );
      }
      await scenario.after?.();
    }
    if (process.env.OPENSTEER_TOOL_PARITY_TRACE === "1")
      console.error("PARITY SENT", JSON.stringify(sent));
    // Recorded once, then frozen: outside recording a missing record fails.
    if (process.env.OPENSTEER_RECORD_TOOL_PARITY === "1")
      writeFileSync(fixturePath, `${JSON.stringify(recorded, null, 1)}\n`);
    else {
      expect(existsSync(fixturePath), "the frozen recording").toBe(true);
      expect(recorded).toEqual(JSON.parse(readFileSync(fixturePath, "utf8")));
    }
    expect(machineClosed).toEqual([]);
    expect(unfaithful).toEqual([]);
    expect(differences).toEqual([]);
  } finally {
    for (const step of close) await step().catch(() => undefined);
    await database.drop?.();
  }
}, 180_000);

/**
 * Waits for one named thing, polling, within a stated bound. On timeout it says what it waited
 * for and the last answer it had, so a slow fixture never reads as a failure of the command.
 */
async function until(
  what: string,
  ready: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  let last: unknown = "not ready";
  try {
    await vi.waitFor(
      async () => {
        try {
          if (await ready()) return;
          last = "not ready";
        } catch (error) {
          last = error instanceof Error ? error.message : error;
        }
        throw new Error(`Not yet: ${what}`);
      },
      { timeout: timeoutMs, interval: 100 },
    );
  } catch {
    throw new Error(`Waited ${timeoutMs} ms for ${what}; the last answer was: ${String(last)}`);
  }
}
