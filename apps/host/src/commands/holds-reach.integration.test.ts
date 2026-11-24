import { randomBytes, randomUUID } from "node:crypto";
import { createId, type AgentGrant, type ThreadAccessMode, type ThreadId } from "@opensteer/core";
import {
  AgentConnectionStore,
  beginAgentSession,
  commandHolds,
  type CommandHolder,
} from "@opensteer/database";
import { describeStore, testModelSelection } from "@opensteer/database/test-support/store";
import {
  commandGovernedKinds,
  commandTable,
  type CommandResource,
  type CommandRow,
  type CommandType,
} from "@opensteer/protocol/command-table";
import { sampleCommand } from "@opensteer/protocol/test-support/command-samples";
import type { HostApiCommand } from "@opensteer/protocol";
import { expect } from "vitest";
import {
  credentialHash,
  connectionCredentialPrefix,
} from "../mcp/connections/connection-authenticator.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { agentCommandAdmission, agentCommandScope, dispatchCommand } from "./dispatch.js";
import type { CommandRegistry } from "./registry.js";

/**
 * What a caller is shown is what it can send, by construction (G2): for every row of the table
 * and every kind of caller, a type it is listed has some well-formed input the door does not
 * answer not found, and a type it is not listed is not found for every input, well-formed or
 * not, in the same bytes, and never says what is wrong with it.
 */
describeStore("what a caller is shown is what it can send (G2)", (test) => {
  test("listed means some input is not not found; not listed means the same not found for every input", async ({
    storeFixture: f,
  }) => {
    const database = f.database;
    const fixture = await f.startRunFixture("holds-reach");
    const owner = fixture.userId;
    const types = Object.keys(commandTable) as CommandType[];
    const samples = new Map(types.map((type) => [type, sampleCommand(type)]));
    const governed = (type: CommandType, command: unknown): CommandResource | null => {
      try {
        return (commandTable[type] as CommandRow).governs(command as never);
      } catch {
        return null;
      }
    };

    // The ids a grant names without a row behind them: what the samples name, so a selected
    // grant holding one of each family holds exactly the things its sample commands govern.
    const sampleIds = (kind: string) =>
      [
        ...new Set(
          types.flatMap((type) => {
            const resource = governed(type, samples.get(type)!.command);
            return resource?.kind === kind && resource.id !== null ? [resource.id] : [];
          }),
        ),
      ] as string[];
    // A profile of the person's (a row: no browser is needed to be granted one).
    const profile = { id: createId("browserProfile") };
    await database
      .insertInto("browserProfiles")
      .values({
        id: profile.id as never,
        ownerId: owner,
        name: "Holds and reach",
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    // A tab, a browser session and a tab group of that profile, and a device setup, on the
    // fixture computer: things only reached through their rows.
    const deviceId = await f.store.requireSelfDeviceId(fixture.runnerId);
    const now = new Date();
    const tab = `tab-${randomUUID()}`;
    await database
      .insertInto("personalTabs")
      .values({
        id: tab as never,
        ownerId: owner,
        kind: "page" as never,
        computerId: deviceId,
        title: "A tab",
        url: "https://example.test/",
        profileId: profile.id as never,
        profileName: "Holds and reach",
        appId: null,
        windowId: null,
        windowApp: null,
        pageBinding: null,
        favicon: null,
        iconRef: null,
        openerTabId: null,
        openedBy: JSON.stringify({ kind: "person" }) as never,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        closedPosition: null,
      })
      .execute();
    const browserSession = `bss-${randomUUID()}`;
    await database
      .insertInto("browserSessions")
      .values({
        id: browserSession as never,
        tabGroupId: browserSession as never,
        opener: null,
        origin: "person",
        profileId: profile.id as never,
        placementKey: "holds-reach",
        runnerId: fixture.runnerId,
        runtimeId: "holds-reach",
        state: "ready",
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      })
      .execute();
    const tabGroup = `tgp_${randomUUID()}`;
    await database.deleteFrom("tabLayouts").where("ownerId", "=", owner).execute();
    await database
      .insertInto("tabLayouts")
      .values({
        ownerId: owner,
        items: JSON.stringify([
          // Its one tab is in the profile: a group is reached only when every tab in it is.
          { kind: "group", group: { groupId: tabGroup, name: "A group", tabIds: [tab] } },
        ]) as never,
      })
      .execute();
    const deployment = await database
      .selectFrom("deployments")
      .select("id")
      .executeTakeFirstOrThrow();
    const deviceSetup = randomUUID();
    await database
      .insertInto("computerAppSetupRequests")
      .values({
        id: deviceSetup,
        kind: "app",
        policyAppApproval: null,
        threadId: null,
        reason: null,
        threadTitle: null,
        deploymentId: deployment.id,
        ownerUserId: owner,
        runnerId: deviceId,
        definitionId: "holds-reach",
        definitionDigest: "holds-reach",
        access: "read",
        createdAt: now,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      })
      .execute();
    const eachFamily: AgentGrant = {
      scope: "selected",
      tasks: true,
      resources: [
        { kind: "browser-profile", profileId: profile.id },
        ...sampleIds("chrome").map((sourceId) => ({ kind: "chrome-tabs" as const, sourceId })),
        ...sampleIds("plugin").map((pluginId) => ({
          kind: "plugin" as const,
          target: { kind: "installed" as const, pluginId },
          access: "read-write" as const,
        })),
        ...sampleIds("local-server").map((serverId) => ({
          kind: "plugin" as const,
          target: { kind: "local-server" as const, serverId },
          access: "read-write" as const,
        })),
      ],
    } as AgentGrant;

    const connections = new AgentConnectionStore(database);
    const connect = async (label: string, grant: AgentGrant, anyone = false) => {
      const record = await connections.create({
        userId: owner,
        label,
        clientName: label,
        accessMode: "full-access",
        resource: "https://home.test/mcp",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        grant,
      });
      await connections.activate(
        record.id,
        credentialHash(`${connectionCredentialPrefix}${randomBytes(32).toString("base64url")}`),
      );
      if (anyone)
        await database
          .updateTable("agentConnections")
          .set({ bridgeSenders: "anyone" } as never)
          .where("id", "=", record.id)
          .execute();
      // Its direct session: what it does in that task is its own work (G2d).
      const { session } = await beginAgentSession(database, {
        userId: owner,
        agentConnectionId: record.id,
      });
      return {
        id: record.id,
        session,
        caller: {
          kind: "connection",
          key: `connection:${record.id}`,
          userId: owner,
          connectionId: record.id,
          accessMode: "full-access",
          grant,
          grantRevision: 1,
        } as unknown as AgentCaller,
      };
    };

    /** A task in a connection's lineage, with a Run of its own to delegate from. */
    const lineageTask = async (connectionId: string | null, suffix: string) => {
      const task = await f.startRunFixture(suffix);
      if (connectionId)
        await database
          .updateTable("threads")
          .set({ originConnectionId: connectionId })
          .where("id", "=", task.threadId)
          .execute();
      if (connectionId)
        await database
          .updateTable("runs")
          .set({ connectionId })
          .where("id", "=", task.run.id)
          .execute();
      return task;
    };
    const request = async (threadId: ThreadId, sessionId: string | null, runId: string) => {
      const id = createId("request");
      await database
        .insertInto("requests")
        .values({
          id,
          kind: "harness.input",
          mode: "durable",
          status: "pending",
          originatingThreadId: threadId,
          originatingRunId: sessionId ? null : (runId as never),
          originatingOccurrenceId: null,
          ...(sessionId ? { originatingAgentSessionId: sessionId as never } : {}),
          callId: `holds-reach-${id}`,
          requestedBy: owner,
          requiredActor: "requester",
          presentation: { kind: "choice", title: "A question", detail: "", options: [] } as never,
          payload: { kind: "harness.input" } as never,
          response: null,
          cancellationReason: null,
          resolvedAt: null,
          resolvedBy: null,
          createdAt: new Date(),
        })
        .execute();
      return id;
    };
    const delegation = async (task: Awaited<ReturnType<typeof lineageTask>>, title: string) => {
      const made = await f.store.delegateThread({
        accessMode: task.thread.accessMode,
        createdBy: owner,
        environmentId: task.environmentId,
        harnessInstanceId: task.harnessInstance.id,
        idempotencyKey: `holds-reach-${title}`,
        modelSelection: testModelSelection,
        origin: { kind: "run", parentRunId: task.run.id, parentThreadId: task.threadId },
        task: [{ type: "text", text: title }],
        title,
      } as never);
      const row = await database
        .selectFrom("delegations")
        .select("id")
        .where("childThreadId", "=", (made as { thread: { id: ThreadId } }).thread.id)
        .executeTakeFirstOrThrow();
      return row.id as string;
    };
    const automation = async (threadId: ThreadId, connectionId: string | null, name: string) => {
      const created = await f.triggers.create({
        actorThreadId: null,
        anchorThreadId: threadId,
        createdBy: owner,
        idempotencyKey: `holds-reach-${name}`,
        name,
        script: {
          interpreter: null,
          text: "console.log('ok')",
        },
        source: {
          kind: "schedule",
          schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
        },
      } as never);
      const id = (created as { trigger: { id: string } }).trigger.id;
      if (connectionId)
        await database
          .updateTable("triggers")
          .set({ originConnectionId: connectionId } as never)
          .where("id", "=", id as never)
          .execute();
      return id;
    };

    // The callers: the table's four columns and more.
    const everything = await connect("Everything", { scope: "everything" });
    // A chat anyone may speak in, holding tasks and one of the plugins the samples name.
    const anyoneGrant = {
      scope: "selected",
      tasks: true,
      resources: sampleIds("plugin").map((pluginId) => ({
        kind: "plugin" as const,
        target: { kind: "installed" as const, pluginId },
        access: "read-write" as const,
      })),
    } as AgentGrant;
    const chat = await f.createBridgeFixture("holds-reach", {
      senders: "anyone",
      conversation: { id: "C-holds-reach", name: "Team room" },
      // What such a chat may hold: tasks and the plugins the person chose (everything it may not).
      grant: anyoneGrant,
    });
    const anyone = {
      id: chat.bridge.id as string,
      session: await beginAgentSession(database, {
        userId: owner,
        agentConnectionId: chat.bridge.id,
      })
        .then(({ session }) => session)
        .catch(() => null),
      caller: {
        kind: "connection",
        key: `connection:${chat.bridge.id}`,
        userId: owner,
        connectionId: chat.bridge.id,
        accessMode: "full-access",
        grant: anyoneGrant,
        grantRevision: 1,
      } as unknown as AgentCaller,
    };

    const each = await connect("Selected, one of each family", eachFamily);
    const empty = await connect("Selected, holding nothing", {
      scope: "selected",
      tasks: false,
      resources: [],
    });
    const ownRun = (mode: ThreadAccessMode) =>
      ({
        kind: "run",
        key: `run:${fixture.run.id}`,
        userId: owner,
        accessMode: mode,
        thread: { id: fixture.threadId },
        claims: { threadId: fixture.threadId, runId: fixture.run.id },
      }) as unknown as AgentCaller;

    // What each caller reaches, by kind: one thing of it that is its own.
    const reached = async (
      connection: {
        readonly id: string;
        readonly session: { readonly id: string; readonly threadId: ThreadId } | null;
      } | null,
      tasks: boolean,
      suffix: string,
    ) => {
      const task = await lineageTask(connection?.id ?? null, `holds-reach-${suffix}`);
      const taskId = tasks || !connection ? task.threadId : connection.session!.threadId;
      return {
        task: taskId,
        request: await request(
          taskId,
          tasks || !connection ? null : connection.session!.id,
          task.run.id,
        ),
        // Without Tasks it may not delegate; it is not shown the delegation commands.
        assignment: await delegation(task, `Delegated ${suffix}`).catch(() => ""),
        // A chat anyone may message may have none; it is not shown the automation commands.
        automation: await automation(
          task.threadId,
          connection?.id ?? null,
          `Automation ${suffix}`,
        ).catch(() => ""),
        "agent-session": connection?.session?.id ?? everything.session.id,
        connection: connection?.id ?? everything.id,
        "browser-profile": profile.id as string,
        "agent-session-task": connection?.session?.threadId ?? everything.session.threadId,
        tabs: tab,
        "browser-session": browserSession,
        "tab-group": tabGroup,
        "device-setup": deviceSetup,
      } as Record<string, string>;
    };
    const callers: readonly (readonly [string, AgentCaller, Record<string, string>])[] = [
      ["everything", everything.caller, await reached(everything, true, "everything")],
      [
        "selected, a chat anyone may speak in",
        anyone.caller,
        await reached(anyone, true, "anyone"),
      ],
      ["selected, one of each", each.caller, await reached(each, true, "each")],
      ["selected, empty", empty.caller, await reached(empty, false, "empty")],
      ...(["approval-required", "auto", "full-access"] as const).map(
        (mode) => [`your own, ${mode}`, ownRun(mode), {}] as const,
      ),
    ];
    const own = await reached(null, true, "own");
    for (const entry of callers.slice(4)) Object.assign(entry[2], own);

    const registry = Object.fromEntries(
      types.map((type) => [type, { accepts: "any", run: async () => ({ type }) }]),
    ) as unknown as CommandRegistry;
    const door = {
      registry,
      admit: agentCommandAdmission(database),
      scope: agentCommandScope(database),
    };
    const outcome = (caller: AgentCaller, command: unknown) =>
      dispatchCommand(
        caller,
        { idempotencyKey: randomUUID(), ...(command as object) } as HostApiCommand,
        door,
      ).then(
        (result) => ({ code: result.status, message: "" }),
        (error: { code?: string; message?: string }) => ({
          code: error.code ?? "error",
          message: error.message ?? "",
        }),
      );
    /** The sample retargeted at the caller's own thing of the kind it governs, ids swapped. */
    const retargeted = (type: CommandType, things: Record<string, string>) => {
      const sample = samples.get(type)!.command;
      const resource = governed(type, sample);
      let text = JSON.stringify(sample);
      const swap = (from: string | null | undefined, to: string | undefined) => {
        if (from && to) text = text.split(JSON.stringify(from)).join(JSON.stringify(to));
      };
      if (resource) {
        swap(resource.id, things[resource.kind]);
        for (const id of resource.ids ?? []) swap(id, things[resource.kind]);
        swap(
          resource.task,
          resource.kind === "agent-session" ? things["agent-session-task"] : things.task,
        );
      }
      return JSON.parse(text) as Record<string, unknown>;
    };

    // The same command in the caller's own profile, where the sample names a Guest page.
    const inProfile: Partial<Record<CommandType, Record<string, unknown>>> = {
      "tab.open": {
        type: "tab.open",
        target: { kind: "page", url: "about:blank", profileId: profile.id },
      },
      "browser.session.start": {
        type: "browser.session.start",
        input: { profileId: profile.id, reuseExisting: false, fresh: true },
      },
    };
    const wrong: string[] = [];
    for (const [name, caller, things] of callers) {
      const holder = (await agentCommandScope(database)(caller)) as CommandHolder | "gone";
      expect(holder, name).not.toBe("gone");
      for (const type of types) {
        const listed = commandHolds(type, holder as CommandHolder);
        if (listed) {
          // Some well-formed input: its sample on the caller's own thing, or in its profile.
          let answer = { code: "not_found", message: "" };
          for (const input of [retargeted(type, things), inProfile[type]]) {
            if (!input) continue;
            answer = await outcome(caller, input);
            if (answer.code !== "not_found") break;
          }
          if (answer.code === "not_found")
            wrong.push(`${name} / ${type}: listed, and its own input is not found`);
        } else {
          const wellFormed = await outcome(caller, samples.get(type)!.command);
          const malformed = await outcome(caller, { type });
          if (
            wellFormed.code !== "not_found" ||
            malformed.code !== "not_found" ||
            wellFormed.message !== malformed.message
          )
            wrong.push(
              `${name} / ${type}: not listed, yet ${wellFormed.code} (${wellFormed.message.slice(0, 80)}) and ${malformed.code}`,
            );
        }
      }
    }
    expect(wrong).toEqual([]);

    // A chat anyone may speak in holds no automation command (K3): a stranger's message never ends
    // in a standing automation. Not shown, not found when sent, and refused where it is admitted
    // (the readmission at the effect asks the same admission).
    const [, anyoneCaller, anyoneThings] = callers.find(([name]) => name.includes("anyone"))!;
    const anyoneHolder = (await agentCommandScope(database)(anyoneCaller)) as CommandHolder;
    const automations = types.filter(
      (type) => (commandTable[type] as CommandRow).family === "automations",
    );
    expect(automations).toEqual([
      "trigger.create",
      "trigger.update",
      "trigger.status.set",
      "trigger.run",
      "trigger.cancel",
    ]);
    const anyoneWrong: string[] = [];
    for (const type of automations) {
      const command = {
        idempotencyKey: randomUUID(),
        ...retargeted(type, anyoneThings),
      } as HostApiCommand;
      if (commandHolds(type, anyoneHolder)) anyoneWrong.push(`${type}: shown`);
      const sent = await outcome(anyoneCaller, command);
      if (sent.code !== "not_found") anyoneWrong.push(`${type}: sent, ${sent.code}`);
      const admitted = await door.admit(anyoneCaller, command);
      if (admitted.answer !== "not_found")
        anyoneWrong.push(`${type}: admitted, ${admitted.answer}`);
    }
    expect(anyoneWrong).toEqual([]);

    // A selected grant without Tasks reaches Requests and a session only through its own active
    // direct session: with none yet, it is shown none of their commands.
    const sessionKinds = types.filter((type) =>
      commandGovernedKinds(type).some((kind) => kind === "request" || kind === "agent-session"),
    );
    const lone = await connect("No session yet", {
      scope: "selected",
      tasks: false,
      resources: [{ kind: "browser-profile", profileId: profile.id }],
    } as AgentGrant);
    await database
      .updateTable("agentSessions")
      .set({ status: "ended", endedAt: new Date(), endReason: "stopped" } as never)
      .where("id", "=", lone.session.id)
      .execute();
    const loneHolder = (await agentCommandScope(database)(lone.caller)) as CommandHolder;
    expect(sessionKinds.filter((type) => commandHolds(type, loneHolder))).toEqual([]);
    for (const type of sessionKinds)
      expect((await outcome(lone.caller, samples.get(type)!.command)).code, type).toBe("not_found");
  }, 120_000);
});
