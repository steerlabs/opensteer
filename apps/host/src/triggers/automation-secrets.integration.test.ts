import { generateKeyPairSync, randomUUID } from "node:crypto";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import {
  createId,
  type AuthenticatedSession,
  type RequestId,
  type ThreadAccessMode,
  type TriggerId,
  type UserId,
} from "@opensteer/core";
import {
  AgentConnectionStore,
  CommandRequestStore,
  TriggerStore,
  commandNotFoundMessage,
  personTaskReader,
} from "@opensteer/database";
import { describeStore, type StoreFixture } from "@opensteer/database/test-support/store";
import type { HostApiCommand, HostApiServerContext } from "@opensteer/protocol";
import {
  MAX_AUTOMATION_SECRET_VALUE_BYTES,
  MAX_AUTOMATION_SECRETS,
  MAX_AUTOMATION_SECRETS_TOTAL_BYTES,
} from "@opensteer/triggers";
import { sql } from "kysely";
import { expect, vi } from "vitest";
import type { AdministrationService } from "../administration/administration-service.js";
import { HostCommandDispatcher } from "../agents/dispatcher.js";
import { personActor } from "../commands/actor.js";
import { agentCommandRegistry } from "../commands/agent-door.js";
import { dispatchCommand, type CommandDoor } from "../commands/dispatch.js";
import { createCommandRegistry } from "../commands/registry.js";
import { CommandRequestService } from "../commands/requests.js";
import { SignedTokenService } from "../identity/host-keys.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import type { AdministrationToolHandlers } from "../mcp/handlers/administration.js";
import { CommandTools } from "../mcp/handlers/commands.js";
import { TriggerToolHandlers } from "../mcp/handlers/triggers.js";
import { AutomationSecrets } from "./automation-secrets.js";
import { createTriggerRpcHandlers } from "./trigger-routes.js";
import { TriggerService } from "./trigger-service.js";
import { WatchControlTokenService } from "./watch-capability.js";
import { WatchScriptService } from "./watch-script-service.js";

const script = {
  interpreter: null,
  text: "console.log(process.env.OPENSTEER_SECRET_API_TOKEN ?? 'missing')",
} as const;

const scheduleSource = {
  kind: "schedule" as const,
  schedule: { kind: "cron" as const, expression: "0 9 * * *", timezone: "UTC" },
};

describeStore("automation secrets through the one door", (it) => {
  async function setup(storeFixture: StoreFixture, mode: ThreadAccessMode = "full-access") {
    const f = await storeFixture.startRunFixture(`secrets-${randomUUID().slice(0, 8)}`);
    const { database, store } = storeFixture;
    await database
      .updateTable("runners")
      .set({
        kind: "main",
        capabilities: sql`(select jsonb_agg(distinct value) from jsonb_array_elements_text(capabilities || '["automation-script-v1"]'::jsonb))`,
      } as never)
      .where("id", "=", f.runnerId)
      .execute();
    for (const [table, id] of [
      ["threads", f.threadId],
      ["runs", f.run.id],
    ] as const) {
      await database
        .updateTable(table)
        .set({ accessMode: mode })
        .where("id", "=", id as never)
        .execute();
    }
    const vault = new AesGcmSecretVault(
      new StaticEncryptionKeyProvider(new Map([[1, Buffer.alloc(32, 0x57)]]), 1),
    );
    const automationSecrets = new AutomationSecrets(vault);
    const triggerStore = new TriggerStore(database);
    const watchChanged = vi.fn();
    const events: string[] = [];
    const triggers = new TriggerService({
      onChanged: () => {
        events.push("host.triggers-changed");
      },
      onOccurrenceQueued: vi.fn(),
      onWatchChanged: watchChanged,
      publicUrl: new URL("https://secrets.opensteer.test"),
      runnerStore: store,
      secrets: automationSecrets,
      store: triggerStore,
      threads: store,
    } as never);
    const commandRequests = new CommandRequestService({
      store: new CommandRequestStore(database, store.requests),
      database,
      requests: store.requests,
      homeKind: "mac",
    });
    const handlers = new TriggerToolHandlers(triggers, store, {
      requests: () => commandRequests,
    });
    const commandTools = new CommandTools({
      database,
      registry: agentCommandRegistry({} as AdministrationService, handlers),
      requests: () => commandRequests,
      administration: {} as AdministrationToolHandlers,
    });
    const sessionId = `ses_${randomUUID()}`;
    await database
      .insertInto("authSessions")
      .values({
        id: sessionId as never,
        userId: f.userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 60 * 60_000),
        absoluteExpiresAt: new Date(Date.now() + 60 * 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSeenAt: new Date(),
        deviceLabel: "Owner Mac",
        ipAddress: null,
        userAgent: null,
      })
      .execute();
    const session = { id: sessionId, user: { id: f.userId } } as unknown as AuthenticatedSession;
    const context = { session } as unknown as HostApiServerContext;
    const personDoor: CommandDoor = {
      registry: createCommandRegistry({
        triggers,
        devices: {} as never,
        channels: {} as never,
        browserSources: {} as never,
        handleCoreCommand: async () => {
          throw new Error("unexpected core command");
        },
        approveCommand: async (actor, command, ctx) => ({
          type: command.type,
          outcome: await commandRequests.approve(
            actor,
            {
              requestId: command.requestId,
              expectedRevision: command.expectedRevision,
              command: command.command,
              idempotencyKey: command.idempotencyKey,
            },
            (person, approved) => dispatchCommand(person, approved, personDoor, ctx),
            (proposal) => personActor(ctx, proposal),
          ),
        }),
      }),
    };
    const rpc = createTriggerRpcHandlers(triggers);
    const runCaller = {
      kind: "run",
      key: `run:${f.run.id}`,
      userId: f.userId as UserId,
      accessMode: mode,
      claims: { runId: f.run.id, threadId: f.threadId },
      thread: { id: f.threadId, accessMode: mode },
    } as unknown as AgentCaller;

    const personDispatch = (command: Record<string, unknown>) =>
      dispatchCommand(
        personActor(context),
        { idempotencyKey: `person-${randomUUID()}`, ...command } as unknown as HostApiCommand,
        personDoor,
        context,
      );

    return {
      f,
      database,
      store,
      triggerStore,
      triggers,
      automationSecrets,
      commandRequests,
      commandTools,
      handlers,
      runCaller,
      context,
      personDispatch,
      rpc,
      watchChanged,
      events,
    };
  }

  it("sets, replaces, lists names, and removes secrets through the door for person and Full-access agent", async ({
    storeFixture,
  }) => {
    const { f, personDispatch, rpc, commandTools, handlers, runCaller } = await setup(
      storeFixture,
      "full-access",
    );

    const created = (await personDispatch({
      type: "trigger.create",
      input: { anchorThreadId: f.threadId, name: "Secret job", script, source: scheduleSource },
    })) as { readonly trigger: { readonly id: TriggerId } };
    const triggerId = created.trigger.id;

    // Person sets two secrets through the door; only sorted names come back.
    const setOut = await personDispatch({
      type: "trigger.secrets.set",
      triggerId,
      set: { WEBHOOK_SECRET: "whsec_v1", API_TOKEN: "tok_v1" },
    });
    expect(setOut).toEqual({
      type: "trigger.secrets.set",
      secretNames: ["API_TOKEN", "WEBHOOK_SECRET"],
    });

    // triggers.get and opensteer_automation_read return names only, never values.
    let unauthedDetail: unknown = null;
    try {
      unauthedDetail = await rpc["triggers.get"]({ triggerId }, {} as never);
    } catch {
      unauthedDetail = null;
    }
    expect(unauthedDetail).toBeNull();
    const personDetail = await rpc["triggers.get"]({ triggerId }, {
      session: { id: "s", user: { id: f.userId } },
    } as never);
    expect(personDetail.ok).toBe(true);
    if (personDetail.ok) {
      expect((personDetail.data as { secretNames?: readonly string[] }).secretNames).toEqual([
        "API_TOKEN",
        "WEBHOOK_SECRET",
      ]);
      expect(JSON.stringify(personDetail.data)).not.toContain("tok_v1");
      expect(JSON.stringify(personDetail.data)).not.toContain("whsec_v1");
    }

    const agentRead = (await handlers.read({
      caller: runCaller,
      input: { automationId: triggerId, occurrenceLimit: 5 },
      operationKey: "read-1",
    })) as { readonly secretNames?: readonly string[] };
    expect(agentRead.secretNames).toEqual(["API_TOKEN", "WEBHOOK_SECRET"]);
    expect(JSON.stringify(agentRead)).not.toContain("tok_v1");

    // Full-access agent replaces one and removes one via opensteer_command.
    const agentSet = await commandTools.opensteer_command({
      caller: runCaller,
      input: {
        command: {
          type: "trigger.secrets.set",
          triggerId,
          set: { API_TOKEN: "tok_v2", EXTRA: "extra_v1" },
          remove: ["WEBHOOK_SECRET"],
        },
      },
      operationKey: "agent-set-1",
    });
    expect(agentSet).toEqual({
      status: "done",
      result: {
        type: "trigger.secrets.set",
        secretNames: ["API_TOKEN", "EXTRA"],
      },
    });
    expect(JSON.stringify(agentSet)).not.toContain("tok_v2");
    expect(JSON.stringify(agentSet)).not.toContain("extra_v1");

    // Removing all clears secrets cleanly.
    const cleared = await personDispatch({
      type: "trigger.secrets.set",
      triggerId,
      remove: ["API_TOKEN", "EXTRA"],
    });
    expect(cleared).toEqual({
      type: "trigger.secrets.set",
      secretNames: [],
    });
  });

  it("delivers set/replaced secrets to both a fired script and a watch script, and stops delivering removed ones", async ({
    storeFixture,
  }) => {
    const { f, store, triggerStore, automationSecrets, personDispatch, watchChanged } = await setup(
      storeFixture,
      "full-access",
    );

    // 1. Fired script (schedule run -> dispatcher sends secrets to Runner command context)
    const sched = (await personDispatch({
      type: "trigger.create",
      input: { anchorThreadId: f.threadId, name: "Fired secret", script, source: scheduleSource },
    })) as { readonly trigger: { readonly id: TriggerId } };

    await personDispatch({
      type: "trigger.secrets.set",
      triggerId: sched.trigger.id,
      set: { API_TOKEN: "fired-secret-v1" },
    });

    const sentCommands: unknown[] = [];
    const dispatcher = new HostCommandDispatcher({
      automationSecrets,
      browser: { hasBrowserProfiles: async () => false } as never,
      catalogs: {} as never,
      executionLeaseMs: 60_000,
      onTriggerChanged: () => undefined,
      publicUrl: new URL("https://secrets.opensteer.test"),
      runToolTokens: { issue: () => "tok" } as never,
      runners: {
        identityForEnvironment: () => ({
          bootId: "boot_1",
          capabilities: ["agent-tools-plan-v1", "automation-script-v1", "execution-plane-v2"],
          connectionGeneration: 1,
          connectionId: "conn_runner_1",
          environmentIds: [f.environmentId],
          runnerId: f.runnerId,
        }),
        dispatch: async (command: unknown) => {
          sentCommands.push(command);
        },
      } as never,
      store,
      triggerControlTokens: { issue: () => "cap-tok" } as never,
      triggers: triggerStore,
    } as never);

    const fireAndComplete = async () => {
      const run = (await personDispatch({
        type: "trigger.run",
        triggerId: sched.trigger.id,
      })) as { readonly occurrence: { readonly commandId: string; readonly id: string } };
      const claimed = await store.claimCommand(run.occurrence.commandId as never, "secrets-test");
      if (!claimed) throw new Error("Expected claimed command for trigger run");
      await dispatcher.dispatch(claimed.command, new AbortController().signal);
      const sent = sentCommands.at(-1) as {
        readonly type: string;
        readonly context: {
          readonly executionGeneration: number;
          readonly secrets?: Readonly<Record<string, string>>;
        };
      };
      await triggerStore.completeExecution({
        executionGeneration: sent.context.executionGeneration,
        output: {
          completedAt: new Date().toISOString(),
          error: null,
          exitCode: 0,
          occurrenceId: run.occurrence.id as never,
          result: { ok: true },
          status: "succeeded",
          stderr: "",
          stdout: "ok\n",
        },
        runnerBootId: "boot_1",
        runnerId: f.runnerId,
      });
      return sent;
    };

    const firstSent = await fireAndComplete();
    expect(firstSent).toMatchObject({
      type: "trigger.execute",
      context: { secrets: { API_TOKEN: "fired-secret-v1" } },
    });

    // Replace and fire again -> updated value arrives.
    await personDispatch({
      type: "trigger.secrets.set",
      triggerId: sched.trigger.id,
      set: { API_TOKEN: "fired-secret-v2" },
    });
    const secondSent = await fireAndComplete();
    expect(secondSent).toMatchObject({
      type: "trigger.execute",
      context: { secrets: { API_TOKEN: "fired-secret-v2" } },
    });

    // Remove and fire again -> secrets omitted from Runner context.
    await personDispatch({
      type: "trigger.secrets.set",
      triggerId: sched.trigger.id,
      remove: ["API_TOKEN"],
    });
    const thirdSent = await fireAndComplete();
    expect(thirdSent.context.secrets).toBeUndefined();

    // 2. Watch script (WatchScriptService opens secrets and secret update restarts/re-revisions watch)
    const watch = (await personDispatch({
      type: "trigger.create",
      input: {
        anchorThreadId: f.threadId,
        name: "Watch secret",
        script,
        source: { kind: "watch" },
      },
    })) as { readonly trigger: { readonly id: TriggerId; readonly currentRevisionId: string } };

    watchChanged.mockClear();
    await personDispatch({
      type: "trigger.secrets.set",
      triggerId: watch.trigger.id,
      set: { WATCH_TOKEN: "watch-secret-v1" },
    });
    expect(watchChanged).toHaveBeenCalledWith(watch.trigger.id);

    const afterWatchSet = await triggerStore.getForOwner(
      watch.trigger.id,
      f.userId,
      5,
      personTaskReader,
    );
    expect(afterWatchSet?.activation?.desired).toBe("active");
    expect(afterWatchSet?.revision.id).not.toBe(watch.trigger.currentRevisionId);

    const reconciled1 = await triggerStore.reconcileWatchesForRunner({
      environmentId: f.environmentId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: "boot_1",
      runnerConnectionGeneration: 1,
      runnerId: f.runnerId,
    });
    const activeWatch1 = reconciled1.activations.find(
      ({ activation }) => activation.triggerId === watch.trigger.id,
    );
    expect(activeWatch1).toBeDefined();

    const watchTokens = new WatchControlTokenService({
      store: triggerStore,
      tokens: new SignedTokenService(generateKeyPairSync("ed25519"), {
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
      }),
    });
    const watchScripts = new WatchScriptService({
      secrets: automationSecrets,
      store: triggerStore,
      tokens: watchTokens,
    });
    const issued1 = watchTokens.issue({
      activationId: activeWatch1!.activation.id,
      anchorThreadId: f.threadId,
      createdBy: f.userId,
      environmentId: f.environmentId,
      executionGeneration: activeWatch1!.activation.executionGeneration,
      revisionId: activeWatch1!.activation.revisionId,
      triggerId: watch.trigger.id,
    });
    const watchPayload = await watchScripts.get(issued1.token, activeWatch1!.activation.revisionId);
    expect(watchPayload.secrets).toEqual({ WATCH_TOKEN: "watch-secret-v1" });

    // Remove watch secret -> WatchScriptService returns empty secrets on the new activation.
    await personDispatch({
      type: "trigger.secrets.set",
      triggerId: watch.trigger.id,
      remove: ["WATCH_TOKEN"],
    });
    const reconciled2 = await triggerStore.reconcileWatchesForRunner({
      environmentId: f.environmentId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: "boot_1",
      runnerConnectionGeneration: 1,
      runnerId: f.runnerId,
    });
    const activeWatch2 = reconciled2.activations.find(
      ({ activation }) => activation.triggerId === watch.trigger.id,
    );
    expect(activeWatch2).toBeDefined();
    expect(activeWatch2!.activation.revisionId).not.toBe(activeWatch1!.activation.revisionId);
    const issued2 = watchTokens.issue({
      activationId: activeWatch2!.activation.id,
      anchorThreadId: f.threadId,
      createdBy: f.userId,
      environmentId: f.environmentId,
      executionGeneration: activeWatch2!.activation.executionGeneration,
      revisionId: activeWatch2!.activation.revisionId,
      triggerId: watch.trigger.id,
    });
    const watchPayloadAfterRemove = await watchScripts.get(
      issued2.token,
      activeWatch2!.activation.revisionId,
    );
    expect(watchPayloadAfterRemove.secrets).toEqual({});
  });

  it("enforces secret bounds, name validation, and case-insensitive uniqueness", async ({
    storeFixture,
  }) => {
    const { f, personDispatch } = await setup(storeFixture, "full-access");
    const created = (await personDispatch({
      type: "trigger.create",
      input: { anchorThreadId: f.threadId, name: "Bounds job", script, source: scheduleSource },
    })) as { readonly trigger: { readonly id: TriggerId } };
    const triggerId = created.trigger.id;

    // Empty patch refused
    await expect(personDispatch({ type: "trigger.secrets.set", triggerId })).rejects.toMatchObject({
      code: "bad_request",
    });

    // > MAX_AUTOMATION_SECRETS refused
    const tooMany: Record<string, string> = {};
    for (let index = 0; index <= MAX_AUTOMATION_SECRETS; index += 1) {
      tooMany[`KEY_${index}`] = "v";
    }
    await expect(
      personDispatch({ type: "trigger.secrets.set", triggerId, set: tooMany }),
    ).rejects.toMatchObject({ code: "bad_request" });

    // Single value > MAX_AUTOMATION_SECRET_VALUE_BYTES refused
    await expect(
      personDispatch({
        type: "trigger.secrets.set",
        triggerId,
        set: { BIG: "x".repeat(MAX_AUTOMATION_SECRET_VALUE_BYTES + 1) },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });

    // Combined > MAX_AUTOMATION_SECRETS_TOTAL_BYTES refused
    const half = "y".repeat(Math.floor(MAX_AUTOMATION_SECRETS_TOTAL_BYTES / 2) + 1);
    await expect(
      personDispatch({
        type: "trigger.secrets.set",
        triggerId,
        set: { PART_A: half, PART_B: half },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });

    // Case-insensitive conflict refused
    await personDispatch({
      type: "trigger.secrets.set",
      triggerId,
      set: { Api_Key: "one" },
    });
    await expect(
      personDispatch({
        type: "trigger.secrets.set",
        triggerId,
        set: { api_key: "two" },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("returns identical not_found for out-of-grant vs nonexistent automation (rule 5)", async ({
    storeFixture,
  }) => {
    const { f, database, personDispatch, commandTools } = await setup(storeFixture, "full-access");
    const created = (await personDispatch({
      type: "trigger.create",
      input: { anchorThreadId: f.threadId, name: "Owner job", script, source: scheduleSource },
    })) as { readonly trigger: { readonly id: TriggerId } };

    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      clientName: "Selected Agent",
      label: "Selected Agent",
      accessMode: "full-access",
      grant: { scope: "selected", tasks: true, resources: [] },
      resource: "https://secrets.opensteer.test/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const selectedCaller = {
      kind: "connection",
      key: `connection:${connection.id}`,
      userId: f.userId,
      accessMode: "full-access",
      connectionId: connection.id,
      grant: connection.grant,
      grantRevision: connection.grantRevision,
    } as unknown as AgentCaller;

    const foreignErr = await commandTools
      .opensteer_command({
        caller: selectedCaller,
        input: {
          command: {
            type: "trigger.secrets.set",
            triggerId: created.trigger.id,
            set: { API_TOKEN: "should-not-leak" },
          },
        },
        operationKey: "out-of-grant-foreign",
      })
      .catch((error: unknown) => error);
    const missingErr = await commandTools
      .opensteer_command({
        caller: selectedCaller,
        input: {
          command: {
            type: "trigger.secrets.set",
            triggerId: createId("trigger"),
            set: { API_TOKEN: "should-not-leak" },
          },
        },
        operationKey: "out-of-grant-missing",
      })
      .catch((error: unknown) => error);

    expect(foreignErr).toMatchObject({ code: "not_found", message: commandNotFoundMessage });
    expect(missingErr).toMatchObject({ code: "not_found", message: commandNotFoundMessage });
    expect((foreignErr as Error).message).toBe((missingErr as Error).message);
  });

  it("never leaks a secret marker value in any response, Request, approval, error, event, or log", async ({
    storeFixture,
  }) => {
    const marker = "OPENSTEER_SECRET_LEAK_MARKER_9f3a7c1d";
    const { f, database, personDispatch, rpc, commandTools, handlers, runCaller, events } =
      await setup(storeFixture, "approval-required");

    const created = (await personDispatch({
      type: "trigger.create",
      input: { anchorThreadId: f.threadId, name: "No-leak job", script, source: scheduleSource },
    })) as { readonly trigger: { readonly id: TriggerId } };
    const triggerId = created.trigger.id;

    const captured: string[] = [];
    const record = (value: unknown) => {
      captured.push(typeof value === "string" ? value : JSON.stringify(value));
    };

    // 1. Person sets marker via door.
    record(
      await personDispatch({
        type: "trigger.secrets.set",
        triggerId,
        set: { MARKER_KEY: marker },
      }),
    );

    // 2. Person and agent reads.
    record(
      await rpc["triggers.get"]({ triggerId }, {
        session: { id: "s", user: { id: f.userId } },
      } as never),
    );
    record(
      await handlers.read({
        caller: runCaller,
        input: { automationId: triggerId, occurrenceLimit: 10 },
        operationKey: "read-marker",
      }),
    );

    // 3. Supervised agent trying to pass `set` gets refused before Request creation, with no value in error.
    const supErr = await commandTools
      .opensteer_command({
        caller: runCaller,
        input: {
          command: {
            type: "trigger.secrets.set",
            triggerId,
            set: { MARKER_KEY: marker },
          },
        },
        operationKey: "sup-with-secret",
      })
      .catch((error: unknown) => error);
    expect(supErr).toMatchObject({ code: "bad_request" });
    record((supErr as Error).message);

    // 4. Supervised agent proposes without `set` -> Request opens -> person approves supplying marker.
    const proposed = (await commandTools.opensteer_command({
      caller: runCaller,
      input: {
        command: {
          type: "trigger.secrets.set",
          triggerId,
        },
      },
      operationKey: "sup-ask-secrets",
    })) as { readonly status: string; readonly requestId: RequestId };
    expect(proposed).toMatchObject({ status: "pending", requestId: expect.any(String) });
    record(proposed);

    const reqRow = await database
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", proposed.requestId)
      .executeTakeFirstOrThrow();
    record(reqRow);

    const approval = await personDispatch({
      type: "request.command.approve",
      requestId: proposed.requestId,
      expectedRevision: String(reqRow.revision),
      command: {
        type: "trigger.secrets.set",
        triggerId,
        set: { APPROVED_KEY: marker },
      },
    });
    record(approval);

    const reqAfterApproval = await database
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", proposed.requestId)
      .executeTakeFirstOrThrow();
    record(reqAfterApproval);

    // 5. Invalid value (contains NUL byte alongside marker) error never echoes the marker.
    const badValErr = await personDispatch({
      type: "trigger.secrets.set",
      triggerId,
      set: { BAD: `${marker}\0tail` },
    }).catch((error: unknown) => error);
    expect(badValErr).toMatchObject({ code: "bad_request" });
    record((badValErr as Error).message);

    // 6. Inspect commands, command_attempts, and events.
    const commandRows = await database.selectFrom("commands").selectAll().execute();
    const attemptRows = await database.selectFrom("commandAttempts").selectAll().execute();
    record(commandRows);
    record(attemptRows);
    record(events);

    for (const blob of captured) {
      expect(blob).not.toContain(marker);
    }

    // Confirm the marker actually was sealed (encrypted) and NOT plaintext in triggers.encrypted_secrets.
    const triggerRow = await database
      .selectFrom("triggers")
      .select("encryptedSecrets")
      .where("id", "=", triggerId)
      .executeTakeFirstOrThrow();
    expect(triggerRow.encryptedSecrets).not.toBeNull();
    expect(triggerRow.encryptedSecrets!.toString("utf8")).not.toContain(marker);
  });
});
