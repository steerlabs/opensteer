import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
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
  AgentToolActivityStore,
  CommandRequestStore,
  OpensteerStore,
  TriggerStore,
  commandNotFoundMessage,
  createDatabase,
  migrateToLatest,
  migrationProvider,
  personTaskReader,
} from "@opensteer/database";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { describeStore, type StoreFixture } from "@opensteer/database/test-support/store";
import type { HostApiCommand, HostApiServerContext } from "@opensteer/protocol";
import { agentToolHostRoutePath } from "@opensteer/protocol/agent-tool-relay";
import {
  MAX_AUTOMATION_SECRET_VALUE_BYTES,
  MAX_AUTOMATION_SECRETS,
  MAX_AUTOMATION_SECRETS_TOTAL_BYTES,
} from "@opensteer/triggers";
import Fastify from "fastify";
import { sql } from "kysely";
import { describe, expect, it as standaloneIt, vi } from "vitest";
import type { AdministrationService } from "../administration/administration-service.js";
import { HostCommandDispatcher } from "../agents/dispatcher.js";
import { personActor } from "../commands/actor.js";
import { agentCommandRegistry } from "../commands/agent-door.js";
import { dispatchCommand, type CommandDoor } from "../commands/dispatch.js";
import { createCommandRegistry } from "../commands/registry.js";
import { CommandRequestService } from "../commands/requests.js";
import { deriveCommandSecretDigestKey } from "../commands/secret-digest.js";
import { SignedTokenService } from "../identity/host-keys.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { registerAgentToolRoute } from "../mcp/agent-tool-route.js";
import type { AdministrationToolHandlers } from "../mcp/handlers/administration.js";
import { CommandTools } from "../mcp/handlers/commands.js";
import { TriggerToolHandlers } from "../mcp/handlers/triggers.js";
import { OpensteerMcpService } from "../mcp/opensteer-mcp-service.js";
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
      secretDigestKey: Buffer.alloc(32, 0x33),
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
              idempotencyKey: command.idempotencyKey,
            },
            (person, approved) => dispatchCommand(person, approved, personDoor, ctx),
            (proposal) => personActor(ctx, proposal),
          ),
        }),
        secretDigestKey: Buffer.alloc(32, 0x33),
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
    await connections.activate(connection.id, `hash-selected-${randomUUID()}`);
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

  it("requires approval for Supervised remove (B1), lets everything connection remove via door without store gate (B2), and carries names/editor/O2 risk on ask without card approval (B3, O2, S2)", async ({
    storeFixture,
  }) => {
    const { f, database, personDispatch, commandRequests, commandTools, handlers } = await setup(
      storeFixture,
      "approval-required",
    );
    const created = (await personDispatch({
      type: "trigger.create",
      input: { anchorThreadId: f.threadId, name: "Guarded job", script, source: scheduleSource },
    })) as { readonly trigger: { readonly id: TriggerId; readonly currentRevisionId: string } };
    const triggerId = created.trigger.id;

    await personDispatch({
      type: "trigger.secrets.set",
      triggerId,
      set: { STRIPE_KEY: "sk_live_1", SECOND_KEY: "sec_2" },
    });

    const supCaller = {
      kind: "run",
      key: `run:${f.run.id}`,
      userId: f.userId as UserId,
      accessMode: "approval-required",
      claims: { runId: f.run.id, threadId: f.threadId },
      thread: { id: f.threadId, accessMode: "approval-required" },
    } as unknown as AgentCaller;

    // B1: Supervised agent cannot silently delete a secret — must ask (destroy face).
    const supRemove = (await commandTools.opensteer_command({
      caller: supCaller,
      input: {
        command: { type: "trigger.secrets.set", triggerId, remove: ["STRIPE_KEY"] },
        reason: "Clean up old Stripe key",
      },
      operationKey: "b1-sup-remove",
    })) as { readonly status: string; readonly requestId?: RequestId };
    expect(supRemove).toMatchObject({ status: "pending", requestId: expect.any(String) });
    const afterSupRemove = (await handlers.read({
      caller: supCaller,
      input: { automationId: triggerId, occurrenceLimit: 5 },
      operationKey: "b1-check-still-there",
    })) as { readonly secretNames?: readonly string[] };
    expect(afterSupRemove.secretNames).toEqual(["SECOND_KEY", "STRIPE_KEY"]);
    // Withdraw the remove ask so the same proposer can next propose `names` on this automation.
    await commandRequests.withdraw({
      ownerUserId: f.userId,
      requestId: supRemove.requestId!,
      proposerKey: `task:${f.threadId}` as never,
    });

    // S2: opensteer_commands omits `set` for Supervised callers, keeps `names` and `remove`.
    const supSchema = await commandTools.opensteer_commands({
      caller: supCaller,
      input: { type: "trigger.secrets.set" },
      operationKey: "s2-sup-schema",
    });
    expect(JSON.stringify(supSchema.input)).not.toContain('"set"');
    expect(JSON.stringify(supSchema.input)).toContain('"names"');
    expect(JSON.stringify(supSchema.input)).toContain('"remove"');

    // B3 + O2: Asking agent proposes with `names` (no values) and reason -> Request carries names,
    // editor opening Secrets section, and O2 words saying whether proposer can change the script.
    const supAsk = (await commandTools.opensteer_command({
      caller: supCaller,
      input: {
        command: { type: "trigger.secrets.set", triggerId, names: ["NEW_TOKEN"] },
        reason: "Need a token for the API call",
      },
      operationKey: "b3-sup-ask",
    })) as { readonly status: string; readonly requestId: RequestId };
    expect(supAsk).toMatchObject({ status: "pending", requestId: expect.any(String) });
    const askRow = await database
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", supAsk.requestId)
      .executeTakeFirstOrThrow();
    const askPart = askRow.command as unknown as {
      readonly command: Record<string, unknown>;
      readonly editor: { readonly screen: string } | null;
      readonly gives: string | null;
      readonly secretPaths: readonly string[];
      readonly agentReason: string | null;
    };
    expect(askPart.command).toMatchObject({
      type: "trigger.secrets.set",
      triggerId,
      names: ["NEW_TOKEN"],
    });
    expect(askPart.editor).toEqual({ screen: "automation-secrets" });
    expect(askPart.agentReason).toBe("Need a token for the API call");
    expect(askPart.gives).toContain("OPENSTEER_SECRET_NEW_TOKEN");
    expect(askPart.gives).toContain("cannot change that script without asking you");
    await commandRequests.withdraw({
      ownerUserId: f.userId,
      requestId: supAsk.requestId,
      proposerKey: `task:${f.threadId}` as never,
    });

    // Names-only ask refuses duplicates and case variants by the same rule as writes.
    await expect(
      commandTools.opensteer_command({
        caller: supCaller,
        input: { command: { type: "trigger.secrets.set", triggerId, names: ["DUP", "DUP"] } },
        operationKey: "b3-dup-names",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      commandTools.opensteer_command({
        caller: supCaller,
        input: { command: { type: "trigger.secrets.set", triggerId, names: ["TOK", "tok"] } },
        operationKey: "b3-case-names",
      }),
    ).rejects.toMatchObject({ code: "bad_request", reason: "automation-secret-case-conflict" });

    // Names-only ask for an already-existing secret indicates it asks for replacement.
    const replaceAsk = (await commandTools.opensteer_command({
      caller: supCaller,
      input: {
        command: { type: "trigger.secrets.set", triggerId, names: ["STRIPE_KEY"] },
        reason: "Rotate Stripe key",
      },
      operationKey: "b3-replace-existing-name",
    })) as { readonly status: string; readonly requestId: RequestId };
    expect(replaceAsk).toMatchObject({ status: "pending", requestId: expect.any(String) });
    const replaceRow = await database
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", replaceAsk.requestId)
      .executeTakeFirstOrThrow();
    const replacePart = replaceRow.command as unknown as { readonly gives: string | null };
    expect(replacePart.gives).toContain("Replace existing OPENSTEER_SECRET_STRIPE_KEY");
    await commandRequests.withdraw({
      ownerUserId: f.userId,
      requestId: replaceAsk.requestId,
      proposerKey: `task:${f.threadId}` as never,
    });

    // B3: Proposing with neither names nor remove nor set is refused before opening a blank Request.
    await expect(
      commandTools.opensteer_command({
        caller: supCaller,
        input: { command: { type: "trigger.secrets.set", triggerId } },
        operationKey: "b3-empty-ask",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });

    // O2: Proposing a script edit on an automation with secrets says how many secrets it receives.
    const scriptAsk = (await commandTools.opensteer_command({
      caller: supCaller,
      input: {
        command: {
          type: "trigger.update",
          triggerId,
          input: {
            expectedRevisionId: created.trigger.currentRevisionId,
            script: { interpreter: null, text: "console.log('updated')" },
          },
        },
        reason: "Update the check logic",
      },
      operationKey: "o2-script-update",
    })) as { readonly status: string; readonly requestId: RequestId };
    expect(scriptAsk).toMatchObject({ status: "pending", requestId: expect.any(String) });
    const scriptRow = await database
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", scriptAsk.requestId)
      .executeTakeFirstOrThrow();
    const scriptPart = scriptRow.command as unknown as { readonly gives: string | null };
    expect(scriptPart.gives).toContain("2 secrets");
    expect(scriptPart.gives).not.toContain("STRIPE_KEY");

    // O2: When a Full-access own agent proposes `names`, `gives` warns it CAN change the script!
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
    const fullCaller = {
      ...supCaller,
      accessMode: "full-access",
      thread: { id: f.threadId, accessMode: "full-access" },
    } as unknown as AgentCaller;
    const fullAsk = (await commandTools.opensteer_command({
      caller: fullCaller,
      input: {
        command: { type: "trigger.secrets.set", triggerId, names: ["BANK_KEY"] },
        reason: "Please enter bank key",
      },
      operationKey: "o2-full-ask-names",
    })) as { readonly status: string; readonly requestId: RequestId };
    expect(fullAsk).toMatchObject({ status: "pending", requestId: expect.any(String) });
    const fullAskRow = await database
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", fullAsk.requestId)
      .executeTakeFirstOrThrow();
    const fullAskPart = fullAskRow.command as unknown as { readonly gives: string | null };
    expect(fullAskPart.gives).toContain("can change the script that will read");

    // B2: `everything` connection at Full access on the person's automation (not its origin):
    // store must NOT throw `forbidden` when the door admits `remove` (`destroy`, Full access -> now).
    const connections = new AgentConnectionStore(database);
    const everythingConn = await connections.create({
      userId: f.userId,
      clientName: "Everything Agent",
      label: "Everything Agent",
      accessMode: "full-access",
      grant: { scope: "everything" },
      resource: "https://secrets.opensteer.test/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await connections.activate(everythingConn.id, `hash-everything-${randomUUID()}`);
    const everythingCaller = {
      kind: "connection",
      key: `connection:${everythingConn.id}`,
      userId: f.userId,
      accessMode: "full-access",
      connectionId: everythingConn.id,
      grant: everythingConn.grant,
      grantRevision: everythingConn.grantRevision,
    } as unknown as AgentCaller;

    const connRemove = await commandTools.opensteer_command({
      caller: everythingCaller,
      input: {
        command: { type: "trigger.secrets.set", triggerId, remove: ["STRIPE_KEY"] },
      },
      operationKey: "b2-everything-remove",
    });
    expect(connRemove).toEqual({
      status: "done",
      result: { type: "trigger.secrets.set", secretNames: ["SECOND_KEY"] },
    });

    // `everything` connection trying `set` on the person's automation asks (lineage: true) -> Leave set out.
    await expect(
      commandTools.opensteer_command({
        caller: everythingCaller,
        input: {
          command: { type: "trigger.secrets.set", triggerId, set: { FOREIGN_KEY: "nope" } },
        },
        operationKey: "b2-everything-set-refused",
      }),
    ).rejects.toMatchObject({ code: "bad_request", message: /Leave set out/u });
  });

  it("refuses idempotency key reuse with a different secret value (S3), skips no-op watch restarts and checks authority (S4), and reads/removes secrets even if ciphertext cannot be opened (S6)", async ({
    storeFixture,
  }) => {
    const { f, database, personDispatch, rpc, commandTools, runCaller, watchChanged } = await setup(
      storeFixture,
      "full-access",
    );

    const watch = (await personDispatch({
      type: "trigger.create",
      input: {
        anchorThreadId: f.threadId,
        name: "Idempotent watch",
        script,
        source: { kind: "watch" },
      },
    })) as { readonly trigger: { readonly id: TriggerId; readonly currentRevisionId: string } };
    const triggerId = watch.trigger.id;

    // S3 (agent): same operationKey with same value replays; different value -> conflict!
    const firstAgent = await commandTools.opensteer_command({
      caller: runCaller,
      input: {
        command: { type: "trigger.secrets.set", triggerId, set: { KEY_A: "val_1" } },
      },
      operationKey: "s3-agent-key",
    });
    expect(firstAgent).toEqual({
      status: "done",
      result: { type: "trigger.secrets.set", secretNames: ["KEY_A"] },
    });
    const replayAgent = await commandTools.opensteer_command({
      caller: runCaller,
      input: {
        command: { type: "trigger.secrets.set", triggerId, set: { KEY_A: "val_1" } },
      },
      operationKey: "s3-agent-key",
    });
    expect(replayAgent).toEqual(firstAgent);
    await expect(
      commandTools.opensteer_command({
        caller: runCaller,
        input: {
          command: { type: "trigger.secrets.set", triggerId, set: { KEY_A: "val_2" } },
        },
        operationKey: "s3-agent-key",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // S3 (person): same idempotencyKey with different value -> conflict!
    const personKey = `person-s3-${randomUUID()}`;
    await personDispatch({
      idempotencyKey: personKey,
      type: "trigger.secrets.set",
      triggerId,
      set: { KEY_B: "p_1" },
    });
    await expect(
      personDispatch({
        idempotencyKey: personKey,
        type: "trigger.secrets.set",
        triggerId,
        set: { KEY_B: "p_2" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // S4: No-op remove (missing key) and no-op set (identical value) do NOT bump revision or restart watch.
    const revBeforeNoop = (
      await database
        .selectFrom("triggers")
        .select("currentRevisionId")
        .where("id", "=", triggerId)
        .executeTakeFirstOrThrow()
    ).currentRevisionId;
    watchChanged.mockClear();
    await personDispatch({
      type: "trigger.secrets.set",
      triggerId,
      remove: ["DOES_NOT_EXIST"],
    });
    await personDispatch({
      type: "trigger.secrets.set",
      triggerId,
      set: { KEY_A: "val_1" },
    });
    const revAfterNoop = (
      await database
        .selectFrom("triggers")
        .select("currentRevisionId")
        .where("id", "=", triggerId)
        .executeTakeFirstOrThrow()
    ).currentRevisionId;
    expect(revAfterNoop).toBe(revBeforeNoop);
    expect(watchChanged).not.toHaveBeenCalled();

    // Watch missed wake-up recovery: if a watch restart commits in PostgreSQL but its post-commit
    // wake-up callback fails, retrying with the same idempotencyKey recovers the wake-up without
    // re-applying the secret mutation or bumping the revision again.
    const missedWakeKey = `missed-wake-${randomUUID()}`;
    watchChanged.mockImplementationOnce(() => {
      throw new Error("simulated missed watch wake-up");
    });
    await expect(
      personDispatch({
        idempotencyKey: missedWakeKey,
        type: "trigger.secrets.set",
        triggerId,
        set: { KEY_B: "p_1_wake" },
      }),
    ).rejects.toThrow("simulated missed watch wake-up");
    const revAfterMissedWake = (
      await database
        .selectFrom("triggers")
        .select("currentRevisionId")
        .where("id", "=", triggerId)
        .executeTakeFirstOrThrow()
    ).currentRevisionId;
    expect(revAfterMissedWake).not.toBe(revAfterNoop);
    watchChanged.mockClear();

    const recovered = await personDispatch({
      idempotencyKey: missedWakeKey,
      type: "trigger.secrets.set",
      triggerId,
      set: { KEY_B: "p_1_wake" },
    });
    expect(recovered).toEqual({
      type: "trigger.secrets.set",
      secretNames: ["KEY_A", "KEY_B"],
    });
    const revAfterReplayWake = (
      await database
        .selectFrom("triggers")
        .select("currentRevisionId")
        .where("id", "=", triggerId)
        .executeTakeFirstOrThrow()
    ).currentRevisionId;
    expect(revAfterReplayWake).toBe(revAfterMissedWake);
    expect(watchChanged).toHaveBeenCalledWith(triggerId);

    // R6: Corrupt encrypted_secrets (simulating wrong credentialKey) -> triggers.get STILL opens
    // without throwing, selective remove/set is REFUSED and preserves the ciphertext intact,
    // and ONLY explicit `clearAll: true` clears the unreadable envelope.
    const corruptBytes = Buffer.from("corrupted-ciphertext-wrong-key");
    await database
      .updateTable("triggers")
      .set({ encryptedSecrets: corruptBytes })
      .where("id", "=", triggerId)
      .execute();

    const detailWhenCorrupt = await rpc["triggers.get"]({ triggerId }, {
      session: { id: "s", user: { id: f.userId } },
    } as never);
    expect(detailWhenCorrupt.ok).toBe(true);
    if (detailWhenCorrupt.ok) {
      expect((detailWhenCorrupt.data as { secretNames?: readonly string[] }).secretNames).toEqual([
        "KEY_A",
        "KEY_B",
      ]);
    }
    await expect(
      personDispatch({
        type: "trigger.secrets.set",
        triggerId,
        remove: ["KEY_A"],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "automation-secrets-unreadable",
    });
    // Ciphertext is preserved untouched until the person explicitly confirms clearAll.
    const preservedRow = await database
      .selectFrom("triggers")
      .select(["encryptedSecrets", "secretNames"])
      .where("id", "=", triggerId)
      .executeTakeFirstOrThrow();
    expect(preservedRow.encryptedSecrets).toEqual(corruptBytes);
    expect(preservedRow.secretNames).toEqual(["KEY_A", "KEY_B"]);

    const cleared = await personDispatch({
      type: "trigger.secrets.set",
      triggerId,
      clearAll: true,
    });
    expect(cleared).toEqual({
      type: "trigger.secrets.set",
      secretNames: [],
    });

    // R6: Re-add KEY_A, revoke runner execution authority on the active watch:
    // adding new secrets is still refused (cannot restart), while removing KEY_A succeeds,
    // stops the watch activation, and starts NO replacement activation.
    await personDispatch({
      type: "trigger.secrets.set",
      triggerId,
      set: { KEY_A: "val_before_revoke" },
    });
    await database
      .updateTable("runners")
      .set({ revokedAt: new Date() })
      .where("id", "=", f.runnerId)
      .execute();
    await expect(
      personDispatch({
        type: "trigger.secrets.set",
        triggerId,
        set: { BLOCKED: "val" },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: /execution authority is no longer active/u,
    });

    const removedWhileRevoked = await personDispatch({
      type: "trigger.secrets.set",
      triggerId,
      remove: ["KEY_A"],
    });
    expect(removedWhileRevoked).toEqual({
      type: "trigger.secrets.set",
      secretNames: [],
    });
    const activeActivationsAfterRemove = await database
      .selectFrom("triggerWatchActivations")
      .select(["id", "desired"])
      .where("triggerId", "=", triggerId)
      .where("desired", "=", "active")
      .execute();
    expect(activeActivationsAfterRemove).toEqual([]);

    // R6: Archived automation refuses `set`, while allowing `remove` and `clearAll` so stored
    // secrets can still be deleted after archiving.
    await database
      .updateTable("runners")
      .set({ revokedAt: null })
      .where("id", "=", f.runnerId)
      .execute();
    const archCreated = (await personDispatch({
      type: "trigger.create",
      input: {
        anchorThreadId: f.threadId,
        name: "Archived secret job",
        script,
        source: scheduleSource,
      },
    })) as { readonly trigger: { readonly id: TriggerId } };
    await personDispatch({
      type: "trigger.secrets.set",
      triggerId: archCreated.trigger.id,
      set: { ONE: "v1", TWO: "v2" },
    });
    await personDispatch({
      type: "trigger.status.set",
      triggerId: archCreated.trigger.id,
      status: "archived",
    });
    await expect(
      personDispatch({
        type: "trigger.secrets.set",
        triggerId: archCreated.trigger.id,
        set: { THREE: "v3" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await personDispatch({
        type: "trigger.secrets.set",
        triggerId: archCreated.trigger.id,
        remove: ["ONE"],
      }),
    ).toEqual({ type: "trigger.secrets.set", secretNames: ["TWO"] });
    expect(
      await personDispatch({
        type: "trigger.secrets.set",
        triggerId: archCreated.trigger.id,
        clearAll: true,
      }),
    ).toEqual({ type: "trigger.secrets.set", secretNames: [] });
  });

  it("never leaks a secret marker value in any response, Request, error, event, DB table, or Host log (S8)", async ({
    storeFixture,
  }) => {
    const personMarker = "OPENSTEER_SECRET_PERSON_MARKER_9f3a7c1d";
    const agentMarker = "OPENSTEER_SECRET_AGENT_MARKER_4e8b2d0a";
    const { f, database, personDispatch, rpc, commandTools, handlers, runCaller, events } =
      await setup(storeFixture, "full-access");

    const created = (await personDispatch({
      type: "trigger.create",
      input: { anchorThreadId: f.threadId, name: "No-leak job", script, source: scheduleSource },
    })) as { readonly trigger: { readonly id: TriggerId } };
    const triggerId = created.trigger.id;

    const captured: string[] = [];
    const record = (value: unknown) => {
      captured.push(typeof value === "string" ? value : JSON.stringify(value));
    };
    const logSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );

    try {
      // 1. Person sets marker via door.
      record(
        await personDispatch({
          type: "trigger.secrets.set",
          triggerId,
          set: { PERSON_KEY: personMarker },
        }),
      );

      // 2. Full-access agent sets its own marker via run-now opensteer_command (S8).
      record(
        await commandTools.opensteer_command({
          caller: runCaller,
          input: {
            command: {
              type: "trigger.secrets.set",
              triggerId,
              set: { AGENT_KEY: agentMarker },
            },
          },
          operationKey: "s8-agent-run-now",
        }),
      );

      // 3. Person and agent reads.
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

      // 4. Lower thread to Supervised; agent trying to pass `set` is refused without echoing marker.
      await database
        .updateTable("threads")
        .set({ accessMode: "approval-required" })
        .where("id", "=", f.threadId)
        .execute();
      await database
        .updateTable("runs")
        .set({ accessMode: "approval-required" })
        .where("id", "=", f.run.id)
        .execute();
      const supCaller = {
        ...runCaller,
        accessMode: "approval-required",
        thread: { id: f.threadId, accessMode: "approval-required" },
      } as unknown as AgentCaller;

      const supErr = await commandTools
        .opensteer_command({
          caller: supCaller,
          input: {
            command: {
              type: "trigger.secrets.set",
              triggerId,
              set: { AGENT_KEY: agentMarker },
            },
          },
          operationKey: "sup-with-secret",
        })
        .catch((error: unknown) => error);
      expect(supErr).toMatchObject({ code: "bad_request" });
      record((supErr as Error).message);

      // 5. Supervised agent proposes with `names` (no values) -> Request holds names only.
      const proposed = (await commandTools.opensteer_command({
        caller: supCaller,
        input: {
          command: {
            type: "trigger.secrets.set",
            triggerId,
            names: ["EXTRA_SECRET"],
          },
          reason: "Need extra secret",
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

      // 6. Invalid value (contains NUL byte alongside marker) error never echoes either marker.
      const badValErr = await personDispatch({
        type: "trigger.secrets.set",
        triggerId,
        set: { BAD: `${personMarker}\0tail` },
      }).catch((error: unknown) => error);
      expect(badValErr).toMatchObject({ code: "bad_request" });
      record((badValErr as Error).message);

      // 7. Inspect commands, command_attempts, and events.
      const commandRows = await database.selectFrom("commands").selectAll().execute();
      const attemptRows = await database.selectFrom("commandAttempts").selectAll().execute();
      record(commandRows);
      record(attemptRows);
      record(events);

      for (const blob of captured) {
        expect(blob).not.toContain(personMarker);
        expect(blob).not.toContain(agentMarker);
      }

      // Confirm markers are sealed (encrypted) and NOT plaintext in triggers.encrypted_secrets.
      const triggerRow = await database
        .selectFrom("triggers")
        .select(["encryptedSecrets", "secretNames" as never])
        .where("id", "=", triggerId)
        .executeTakeFirstOrThrow();
      expect(triggerRow.encryptedSecrets).not.toBeNull();
      expect(triggerRow.encryptedSecrets!.toString("utf8")).not.toContain(personMarker);
      expect(triggerRow.encryptedSecrets!.toString("utf8")).not.toContain(agentMarker);
    } finally {
      for (const spy of logSpies) spy.mockRestore();
    }
  });

  it("redacts secret values in real PostgreSQL tool_calls (relay admitted, relay refused, and Runner tool.started) and uses private Host-keyed ledger HMACs (R1, R2)", async ({
    storeFixture,
  }) => {
    const {
      automationSecrets,
      commandTools,
      database,
      f,
      personDispatch,
      store,
      triggerStore,
      triggers,
    } = await setup(storeFixture, "full-access");
    const created = await triggers.create(
      {
        anchorThreadId: f.threadId,
        idempotencyKey: "r1-r2-create",
        name: "R1 R2 test",
        ownerId: f.userId,
        script,
        source: scheduleSource,
      },
      null,
    );
    const triggerId = created.trigger.id;
    const digestKey = deriveCommandSecretDigestKey(Buffer.alloc(32, 0x57));
    const admittedMarker = `pg-relay-admitted-${randomUUID()}`;
    const refusedMarker = `pg-relay-refused-${randomUUID()}`;
    const runnerMarker = `pg-runner-started-${randomUUID()}`;
    const personPin = "0421";

    // Build real relay route backed by PostgreSQL AgentToolActivityStore.
    const initialRunRow = await database
      .selectFrom("runs")
      .select(["bindingGeneration", "status"])
      .where("id", "=", f.run.id)
      .executeTakeFirstOrThrow();
    const activity = new AgentToolActivityStore(database);
    const app = Fastify();
    const makeRunCaller = (accessMode: ThreadAccessMode) =>
      ({
        kind: "run",
        key: `run:${f.run.id}`,
        userId: f.userId as UserId,
        accessMode,
        claims: {
          runId: f.run.id,
          threadId: f.threadId,
          environmentId: f.environmentId,
          bindingGeneration: initialRunRow.bindingGeneration ?? 1,
        },
        thread: {
          id: f.threadId,
          environmentId: f.environmentId,
          accessMode,
          purpose: "task",
        },
      }) as unknown as AgentCaller;
    let currentCaller: AgentCaller = makeRunCaller("full-access");
    const callers = {
      authenticate: async (token: string) => {
        if (token !== "run-token") throw new Error("Unauthorized");
        return currentCaller;
      },
    };
    const mcpService = new OpensteerMcpService({
      callers,
      handlers: {
        opensteer_command: (call) => commandTools.opensteer_command(call),
      },
      store,
      publicUrl: new URL("https://secrets.opensteer.test"),
    });
    registerAgentToolRoute(app, {
      callers,
      service: mcpService,
      activity,
      realtime: { observeScopes: () => () => true },
      secretDigestKey: digestKey,
    });

    try {
      const replayCallId = randomUUID();
      // 1. Admitted Full-access Run call through the REAL relay route.
      const okRes = await app.inject({
        method: "POST",
        url: agentToolHostRoutePath,
        headers: { authorization: "Bearer run-token" },
        payload: {
          callId: replayCallId,
          name: "opensteer_command",
          input: {
            command: {
              type: "trigger.secrets.set",
              triggerId,
              set: { RELAY_OK: admittedMarker },
            },
          },
        },
      });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json()).toMatchObject({
        structuredContent: {
          status: "done",
          result: { type: "trigger.secrets.set", secretNames: ["RELAY_OK"] },
        },
      });
      expect(okRes.body).not.toContain(admittedMarker);

      // Value actually reached the door and was sealed for execution.
      const sealedAfterRelay = await triggerStore.getEncryptedSecrets(f.userId, triggerId);
      expect(await automationSecrets.values(triggerId, sealedAfterRelay)).toEqual({
        RELAY_OK: admittedMarker,
      });

      // Replaying the SAME callId with a DIFFERENT secret value is rejected via private argumentDigest.
      const conflictRes = await app.inject({
        method: "POST",
        url: agentToolHostRoutePath,
        headers: { authorization: "Bearer run-token" },
        payload: {
          callId: replayCallId,
          name: "opensteer_command",
          input: {
            command: {
              type: "trigger.secrets.set",
              triggerId,
              set: { RELAY_OK: `${admittedMarker}-different` },
            },
          },
        },
      });
      expect(conflictRes.json()).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "conflict" } },
      });

      // 2. Refused Supervised Run call through the REAL relay route.
      await database
        .updateTable("threads")
        .set({ accessMode: "approval-required" })
        .where("id", "=", f.threadId)
        .execute();
      await database
        .updateTable("runs")
        .set({ accessMode: "approval-required" })
        .where("id", "=", f.run.id)
        .execute();
      currentCaller = makeRunCaller("approval-required");
      const refusedRes = await app.inject({
        method: "POST",
        url: agentToolHostRoutePath,
        headers: { authorization: "Bearer run-token" },
        payload: {
          callId: randomUUID(),
          name: "opensteer_command",
          input: {
            command: {
              type: "trigger.secrets.set",
              triggerId,
              set: { RELAY_BAD: refusedMarker },
            },
          },
        },
      });
      expect(refusedRes.statusCode).toBe(200);
      expect(refusedRes.json()).toMatchObject({ isError: true });
      expect(refusedRes.body).not.toContain(refusedMarker);

      // 3. Runner-reported `tool.started` event through runner-event-store.ts.
      const runRow = await database
        .selectFrom("runs")
        .select(["bindingGeneration", "nextRunnerOrdinal"])
        .where("id", "=", f.run.id)
        .executeTakeFirstOrThrow();
      const attemptRow = await database
        .selectFrom("runAttempts")
        .select(["runnerId", "runnerBootId"])
        .where("runId", "=", f.run.id)
        .where("status", "=", "current")
        .executeTakeFirstOrThrow();
      let nextOrdinal = runRow.nextRunnerOrdinal;
      const commitToolStarted = async (
        args: unknown,
        tool: { readonly namespace: string; readonly name: string } = {
          namespace: "opensteer",
          name: "opensteer_command",
        },
        callId = `runner-call-${randomUUID()}`,
      ) => {
        await store.commitRunnerEvent({
          environmentId: f.environmentId,
          runnerId: attemptRow.runnerId ?? f.runnerId,
          runnerBootId: attemptRow.runnerBootId ?? "boot_r1",
          event: {
            type: "tool.started",
            runId: f.run.id,
            threadId: f.threadId,
            environmentId: f.environmentId,
            bindingGeneration: runRow.bindingGeneration ?? 1,
            ordinal: nextOrdinal++,
            emittedAt: new Date().toISOString(),
            data: {
              callId,
              tool,
              arguments: args,
            },
          },
        });
      };
      await commitToolStarted({
        command: {
          type: "trigger.secrets.set",
          triggerId,
          set: { RUNNER_KEY: runnerMarker },
        },
      });

      // M1 variants through real relay route + real Runner event store + PostgreSQL all-table scan:
      const m1Prefix = `M1_AUDIT_${randomUUID().slice(0, 8)}`;
      const codexPadMarker = `${m1Prefix}_CODEXPAD`;
      const strCmdMarker = `${m1Prefix}_STRCMD`;
      const truncCmdMarker = `${m1Prefix}_TRUNCCMD`;
      const misKeyMarker = `${m1Prefix}_MISKEY`;
      const nestedMarker = `${m1Prefix}_NESTED`;
      const typoTypeMarker = `${m1Prefix}_TYPOTYPE`;
      const missingTypeMarker = `${m1Prefix}_MISSINGTYPE`;
      const bomMarker = `${m1Prefix}_BOM`;
      const nbspMarker = `${m1Prefix}_NBSP`;
      const arrStrMarker = `${m1Prefix}_ARRSTR`;
      const dblEncMarker = `${m1Prefix}_DBLENC`;
      const topArrMarker = `${m1Prefix}_TOPARR`;
      const deepMarker = `${m1Prefix}_DEEP`;
      const setFirstMarker = `${m1Prefix}_SETFIRST`;
      const knownNonSecretCreateMarker = `${m1Prefix}_R_KNOWNNONSECRET_CREATE`;
      const knownNonSecretUpdateMarker = `${m1Prefix}_R_KNOWNNONSECRET_UPDATE`;
      const foreignIdentityMarker = `${m1Prefix}_X_FOREIGNIDENTITY`;

      // Variant 1 (codexPad): oversized >64 KiB arguments that `createToolArguments` turns into
      // JSON text (`withParametersAsText`) if formatted before redaction.
      const { createToolArguments } = await import("@opensteer/core");
      const codexOversized = createToolArguments({
        command: {
          type: "trigger.secrets.set",
          triggerId,
          set: { PAD: codexPadMarker },
          pad: Array.from({ length: 5_000 }, (_, i) => `padding-entry-${i}`),
        },
      });
      expect(typeof (codexOversized as { readonly command?: unknown }).command).toBe("string");
      await commitToolStarted(codexOversized);

      // Variant 2 (strCmd): `command` sent as a JSON string, plus truncated JSON naming the type.
      await commitToolStarted({
        command: JSON.stringify({
          type: "trigger.secrets.set",
          triggerId,
          set: { STR: strCmdMarker },
        }),
      });
      await commitToolStarted({
        command: `{"type":"trigger.secrets.set","triggerId":"${triggerId}","set":{"TRUNC":"${truncCmdMarker}"`,
      });

      // Variant 3 (misKey + nestedInput): agent-chosen/misspelled keys through the REAL relay route.
      const misKeyRes = await app.inject({
        method: "POST",
        url: agentToolHostRoutePath,
        headers: { authorization: "Bearer run-token" },
        payload: {
          callId: randomUUID(),
          name: "opensteer_command",
          input: {
            command: {
              type: "trigger.secrets.set",
              triggerId,
              Set: { LOWER: misKeyMarker },
              sett: { TYPO: misKeyMarker },
              input: { set: { NESTED: nestedMarker } },
            },
          },
        },
      });
      expect(misKeyRes.statusCode).toBe(200);
      expect(misKeyRes.body).not.toContain(misKeyMarker);
      expect(misKeyRes.body).not.toContain(nestedMarker);

      // Variant 4 (TYPOTYPE through the REAL relay route + MISSINGTYPE through Runner event store).
      const typoTypeRes = await app.inject({
        method: "POST",
        url: agentToolHostRoutePath,
        headers: { authorization: "Bearer run-token" },
        payload: {
          callId: randomUUID(),
          name: "opensteer_command",
          input: {
            command: {
              type: "trigger.secret.set",
              triggerId,
              set: { TYPO: typoTypeMarker },
            },
          },
        },
      });
      expect(typoTypeRes.statusCode).toBe(200);
      expect(typoTypeRes.body).not.toContain(typoTypeMarker);
      await commitToolStarted({ command: { set: { MISSING: missingTypeMarker } } });

      // Variant 5 (item-4 Runner evasions: BOM, NBSP, array string, double encoding, top-level array
      // string, depth > 6 wrapper, truncated JSON with `set` before `type`).
      await commitToolStarted({
        command: `\uFEFF{"type":"trigger.secrets.set","triggerId":"${triggerId}","set":{"K":"${bomMarker}"}}`,
      });
      await commitToolStarted({
        command: `\u00A0{"type":"trigger.secrets.set","triggerId":"${triggerId}","set":{"K":"${nbspMarker}"}}`,
      });
      await commitToolStarted({
        command: `[{"type":"trigger.secrets.set","triggerId":"${triggerId}","set":{"K":"${arrStrMarker}"}}]`,
      });
      await commitToolStarted({
        command: JSON.stringify(
          JSON.stringify({ type: "trigger.secrets.set", triggerId, set: { K: dblEncMarker } }),
        ),
      });
      await commitToolStarted(
        `[{"command":{"type":"trigger.secrets.set","triggerId":"${triggerId}","set":{"K":"${topArrMarker}"}}}]`,
      );
      await commitToolStarted({
        command: {
          a: {
            b: {
              c: {
                d: {
                  e: { f: { g: { type: "trigger.secrets.set", set: { K: deepMarker } } } },
                },
              },
            },
          },
        },
      });
      await commitToolStarted({
        command: `{"set":{"K":"${setFirstMarker}"},"triggerId":"${triggerId}","ty`,
      });

      // Variant 6 (R6-1: known non-secret types carrying undeclared secret keys through REAL relay
      // route + Runner event store; R6-2: foreign/unrecognised tool identity backstop through Runner).
      const knownCreateRes = await app.inject({
        method: "POST",
        url: agentToolHostRoutePath,
        headers: { authorization: "Bearer run-token" },
        payload: {
          callId: randomUUID(),
          name: "opensteer_command",
          input: {
            command: {
              type: "trigger.create",
              secrets: { TOP: knownNonSecretCreateMarker },
              input: {
                anchorThreadId: f.threadId,
                name: "Bad create",
                secrets: { NESTED: knownNonSecretCreateMarker },
              },
            },
          },
        },
      });
      expect(knownCreateRes.statusCode).toBe(200);
      expect(knownCreateRes.body).not.toContain(knownNonSecretCreateMarker);

      const knownUpdateRes = await app.inject({
        method: "POST",
        url: agentToolHostRoutePath,
        headers: { authorization: "Bearer run-token" },
        payload: {
          callId: randomUUID(),
          name: "opensteer_command",
          input: {
            command: {
              type: "trigger.update",
              triggerId,
              set: { TOP: knownNonSecretUpdateMarker },
              input: {
                expectedRevisionId: created.revision.id,
                secrets: { NESTED: knownNonSecretUpdateMarker },
              },
            },
          },
        },
      });
      expect(knownUpdateRes.statusCode).toBe(200);
      expect(knownUpdateRes.body).not.toContain(knownNonSecretUpdateMarker);

      await commitToolStarted(
        {
          command: {
            type: "trigger.secrets.set",
            triggerId,
            set: { FOREIGN: foreignIdentityMarker },
          },
        },
        { namespace: "mcp:plugin-opensteer-opensteer", name: "opensteer_command" },
      );

      // Ordinary non-command tools (Edit + Bash with `{` and `\uXXXX`) stay byte-identical in PostgreSQL.
      const editCallId = `ordinary-edit-${randomUUID()}`;
      const bashCallId = `ordinary-bash-${randomUUID()}`;
      const editArgs = {
        file_path: "/repo/a.ts",
        old_string: '{\n  const dash = "\\u2014";\n  return dash;\n}',
      };
      const bashArgs = { command: '{ printf "\\u00e9"; echo done; } > out.txt' };
      await commitToolStarted(editArgs, { namespace: "claude", name: "Edit" }, editCallId);
      await commitToolStarted(bashArgs, { namespace: "claude", name: "Bash" }, bashCallId);

      // Scan ALL base tables in PostgreSQL (text + hex for bytea): zero plaintext markers anywhere.
      const allMarkers = [
        admittedMarker,
        refusedMarker,
        runnerMarker,
        codexPadMarker,
        strCmdMarker,
        truncCmdMarker,
        misKeyMarker,
        nestedMarker,
        typoTypeMarker,
        missingTypeMarker,
        bomMarker,
        nbspMarker,
        arrStrMarker,
        dblEncMarker,
        topArrMarker,
        deepMarker,
        setFirstMarker,
        knownNonSecretCreateMarker,
        knownNonSecretUpdateMarker,
        foreignIdentityMarker,
      ];
      const baseTables = await sql<{ tableSchema: string; tableName: string }>`
        select table_schema, table_name
        from information_schema.tables
        where table_type = 'BASE TABLE'
          and table_schema not in ('pg_catalog', 'information_schema')
      `.execute(database);
      expect(baseTables.rows.length).toBeGreaterThan(50);
      const patterns = allMarkers.flatMap((marker) => [
        `%${marker}%`,
        `%${Buffer.from(marker, "utf8").toString("hex")}%`,
      ]);
      const hits: string[] = [];
      for (const { tableSchema, tableName } of baseTables.rows) {
        const quoted = sql.raw(`"${tableSchema}"."${tableName}"`);
        const found = await sql<{ hit: string }>`
          select x::text as hit from ${quoted} x
          where x::text like any(${patterns})
          limit 20
        `.execute(database);
        for (const row of found.rows) {
          for (const marker of allMarkers) {
            const hex = Buffer.from(marker, "utf8").toString("hex");
            if (row.hit.includes(marker) || row.hit.includes(hex)) {
              hits.push(`${tableSchema}.${tableName}: ${marker}`);
            }
          }
        }
      }
      expect([...new Set(hits)]).toEqual([]);

      // Verify ordinary non-command Edit and Bash calls were stored byte-identical.
      const toolCallRows = await database.selectFrom("toolCalls").selectAll().execute();
      expect(toolCallRows.find((row) => row.callId === editCallId)?.arguments).toEqual(editArgs);
      expect(toolCallRows.find((row) => row.callId === bashCallId)?.arguments).toEqual(bashArgs);
      expect(toolCallRows.length).toBeGreaterThanOrEqual(7);
      expect(
        toolCallRows.filter(
          (row) =>
            row.tool?.name === "opensteer_command" &&
            typeof row.arguments === "object" &&
            row.arguments !== null &&
            typeof (row.arguments as { command?: unknown }).command === "object" &&
            (row.arguments as { command?: { set?: unknown } }).command?.set === "[redacted]",
        ).length,
      ).toBeGreaterThanOrEqual(3);

      // 4. R2: Person command ledger digest cannot be matched offline with requestedBy:idempotencyKey.
      await personDispatch({
        type: "trigger.secrets.set",
        triggerId,
        idempotencyKey: "person-r2-pin",
        set: { PIN: personPin },
      });
      const personCmd = await database
        .selectFrom("commands")
        .select(["requestedBy", "idempotencyKey", "payload"])
        .where("idempotencyKey", "=", "person-r2-pin")
        .executeTakeFirstOrThrow();
      const storedPinDigest = (
        (
          personCmd.payload as {
            readonly request?: { readonly __secretDigests?: Record<string, string> };
          }
        ).request?.__secretDigests ?? {}
      ).set;
      expect(storedPinDigest).toMatch(/^[0-9a-f]{64}$/u);
      const offlineGuess = createHmac(
        "sha256",
        `${personCmd.requestedBy}:${personCmd.idempotencyKey}`,
      )
        .update(JSON.stringify({ PIN: personPin }))
        .digest("hex");
      expect(storedPinDigest).not.toBe(offlineGuess);
    } finally {
      await app.close();
    }
  });
});

describe("0119_automation_secret_names upgrade from an already-applied 0113 database", () => {
  standaloneIt(
    "preserves a pre-0119 trigger holding sealed secrets, backfills secret_names on first read, and supports replace and remove",
    async () => {
      const clone = await cloneTestDatabase("host");
      const database = createDatabase({ connectionString: clone.url });
      try {
        await sql`drop schema public cascade; create schema public`.execute(database);
        const all = await migrationProvider().getMigrations();
        expect(Object.keys(all)).toContain("0119_automation_secret_names");

        // Migrate ONLY up to before 0119 — simulating a real database where 0113 already ran.
        await migrateToLatest(database, {
          async getMigrations() {
            return Object.fromEntries(
              Object.entries(all).filter(([key]) => key < "0119_automation_secret_names"),
            );
          },
        });

        // 0113 on the head does NOT create triggers.secret_names.
        const beforeCol = await sql<{ columnName: string }>`
          select column_name as "columnName"
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'triggers'
            and column_name = 'secret_names'
        `.execute(database);
        expect(beforeCol.rows).toEqual([]);

        const home = await seedPersonalFixture(database, "/tmp/secrets-0119-upgrade-fixture");
        const threadId = createId("thread");
        const harnessId = createId("harnessInstance");
        const triggerId = createId("trigger");
        const revisionId = `trv_${randomUUID()}`;
        const {
          rows: [principal],
        } = await sql<{ id: string }>`
          select id from principals where user_id = ${home.userId}
        `.execute(database);

        await sql`insert into harness_instances
          (id, environment_id, driver_kind, name, config, runtime_revision, state_kind, enabled, is_default, source_id)
          values (${harnessId}, ${home.environmentId}, 'codex', 'Codex', '{}', 1, 'ready', true, true, 'native')
        `.execute(database);
        await sql`insert into threads
          (id, lineage_root_thread_id, purpose, listed, title, icon_source, color, environment_id,
           harness_instance_id, model_selection, created_by, created_by_principal_id)
          values (${threadId}, ${threadId}, 'task', true, 'Pre-0119 secrets', 'default', 'blue',
                  ${home.environmentId}, ${harnessId},
                  '{"providerId":"openai","modelId":"fixture","options":{}}'::jsonb,
                  ${home.userId}, ${principal!.id})
        `.execute(database);

        const secrets = new AutomationSecrets(
          new AesGcmSecretVault(
            new StaticEncryptionKeyProvider(new Map([[1, Buffer.alloc(32, 0x6b)]]), 1),
          ),
        );
        const sealed = await secrets.applyWithMeta(triggerId, null, {
          set: { KEEP_ME: "keep-v1", LEGACY_TOKEN: "tok-v1" },
        });
        expect(sealed.sealed).not.toBeNull();

        await database.transaction().execute(async (tx) => {
          await sql`insert into triggers
            (id, anchor_thread_id, created_by, idempotency_key, request_fingerprint, name, kind, status,
             current_revision_id, encrypted_secrets, secrets_key_version)
            values (${triggerId}, ${threadId}, ${home.userId}, 'pre-0119-trg', 'fp-pre-0119',
                    'Existing secret automation', 'schedule', 'active', ${revisionId},
                    ${sealed.sealed!.envelope}, ${sealed.sealed!.keyVersion})
          `.execute(tx);
          await sql`insert into trigger_revisions(id, trigger_id, ordinal, source, script, created_by)
            values (${revisionId}, ${triggerId}, 1,
                    ${JSON.stringify(scheduleSource)}::jsonb,
                    ${JSON.stringify(script)}::jsonb,
                    ${home.userId})
          `.execute(tx);
        });

        // Apply 0119 onto the database that already ran 0113 with rows, and verify replay is safe.
        await migrateToLatest(database);
        await all["0119_automation_secret_names"]!.up(database);

        const afterRow = (
          await sql<{ encryptedSecrets: Buffer | null; secretNames: unknown }>`
            select encrypted_secrets as "encryptedSecrets", secret_names as "secretNames"
            from triggers
            where id = ${triggerId}
          `.execute(database)
        ).rows[0];
        expect(afterRow?.encryptedSecrets).not.toBeNull();
        expect(afterRow?.secretNames).toBeNull();

        const store = new OpensteerStore(database);
        const triggerStore = new TriggerStore(database);
        const triggerService = new TriggerService({
          onOccurrenceQueued: () => {},
          publicUrl: new URL("http://127.0.0.1:8788"),
          runnerStore: store,
          secrets,
          store: triggerStore,
          threads: store,
        });

        // First read decrypts once and backfills triggers.secret_names in PostgreSQL.
        const firstRead = await triggerService.get(home.userId, triggerId, 10, personTaskReader);
        expect(firstRead.secretNames).toEqual(["KEEP_ME", "LEGACY_TOKEN"]);

        const backfilledRow = (
          await sql<{ secretNames: unknown }>`
            select secret_names as "secretNames" from triggers where id = ${triggerId}
          `.execute(database)
        ).rows[0];
        expect(backfilledRow?.secretNames).toEqual(["KEEP_ME", "LEGACY_TOKEN"]);

        // Subsequent reads use the backfilled column without needing to decrypt values.
        const wrongKeyService = new TriggerService({
          onOccurrenceQueued: () => {},
          publicUrl: new URL("http://127.0.0.1:8788"),
          runnerStore: store,
          secrets: new AutomationSecrets(
            new AesGcmSecretVault(
              new StaticEncryptionKeyProvider(new Map([[1, Buffer.alloc(32, 0x77)]]), 1),
            ),
          ),
          store: triggerStore,
          threads: store,
        });
        expect(
          (await wrongKeyService.get(home.userId, triggerId, 10, personTaskReader)).secretNames,
        ).toEqual(["KEEP_ME", "LEGACY_TOKEN"]);

        // Replace LEGACY_TOKEN and remove KEEP_ME through the command door.
        const sessionId = `ses_${randomUUID()}`;
        await database
          .insertInto("authSessions")
          .values({
            id: sessionId as never,
            userId: home.userId,
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
        const session = {
          id: sessionId,
          user: { id: home.userId },
        } as unknown as AuthenticatedSession;
        const context = { session } as unknown as HostApiServerContext;
        const personDoor: CommandDoor = {
          registry: createCommandRegistry({
            triggers: triggerService,
            devices: {} as never,
            channels: {} as never,
            browserSources: {} as never,
            handleCoreCommand: async () => {
              throw new Error("unexpected core command");
            },
            approveCommand: async () => {
              throw new Error("unexpected approve command");
            },
            secretDigestKey: Buffer.alloc(32, 0x33),
          }),
        };

        const updated = await dispatchCommand(
          personActor(context),
          {
            idempotencyKey: "upgrade-replace-remove",
            remove: ["KEEP_ME"],
            set: { LEGACY_TOKEN: "tok-v2" },
            triggerId,
            type: "trigger.secrets.set",
          },
          personDoor,
          context,
        );
        expect(updated).toEqual({
          secretNames: ["LEGACY_TOKEN"],
          type: "trigger.secrets.set",
        });

        expect(
          (await triggerService.get(home.userId, triggerId, 10, personTaskReader)).secretNames,
        ).toEqual(["LEGACY_TOKEN"]);
        const finalEnvelope = await triggerStore.getEncryptedSecrets(home.userId, triggerId);
        expect(await secrets.values(triggerId, finalEnvelope)).toEqual({
          LEGACY_TOKEN: "tok-v2",
        });
      } finally {
        await database.destroy();
        await clone.drop();
      }
    },
  );
});
