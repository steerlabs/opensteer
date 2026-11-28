import { TriggerToolHandlers } from "../mcp/handlers/triggers.js";
import { opensteer_automation_control } from "@opensteer/agent-tools/tools";
import type { AgentCaller, RunCaller } from "../mcp/agent-caller.js";
import { idempotencyKey, operationId } from "../mcp/operations.js";
import { createId } from "@opensteer/core";
import { commandSubject, type TriggerStore } from "@opensteer/database";
import { TriggerRevisionSchema, TriggerSchema } from "@opensteer/triggers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TriggerScheduleLoop, TriggerService } from "./trigger-service.js";
describe("TriggerService", () => {
  afterEach(() => vi.useRealTimers());
  it("carries MCP retry identity into manual Trigger admission", async () => {
    const enqueueManual = vi.fn(async () => ({
      event: {
        trigger: {},
      },
    }));
    const service = new TriggerService({
      store: {
        enqueueManual,
      },
      onOccurrenceQueued: vi.fn(),
    } as unknown as ConstructorParameters<typeof TriggerService>[0]);
    const caller = {
      kind: "run",
      key: "run:manual",
      userId: createId("user"),
      thread: {
        id: createId("thread"),
      },
    } as RunCaller;
    const handlers = new TriggerToolHandlers(
      service,
      { triggerOrigins: async () => new Map() },
      {
        door: (_caller, registry) => ({
          registry,
          scope: async () => ({ scope: null, grant: null, mode: "full-access" }),
          admit: async (caller: AgentCaller) => ({
            answer: "now",
            face: 0,
            execution: { subject: commandSubject(caller.key) } as never,
          }),
          secretDigestKey: Buffer.alloc(32, 0x33),
        }),
      },
    );
    const input = opensteer_automation_control.input.parse({
      action: "run_now",
      automationId: createId("trigger"),
      payload: {
        task: "once",
      },
    });
    await handlers.write({
      caller,
      input,
      operationKey: "manual-once",
    });
    expect(enqueueManual).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: idempotencyKey(
          caller,
          operationId(caller, "manual-once", "opensteer_automation_control"),
          "trigger.write",
        ),
      }),
    );
  });
  it("refuses v3 before persisting when the anchor computer has no v3 advertisement", async () => {
    const create = vi.fn(async () => ({
      trigger: {
        kind: "watch",
      },
    }));
    const ownerId = createId("user");
    const anchorThreadId = createId("thread");
    const service = new TriggerService({
      threads: {
        readTask: async () => ({
          environmentId: createId("environment"),
        }),
      } as never,
      runnerStore: {
        getEnvironment: async () => ({
          runnerId: createId("runner"),
        }),
        runnerCapabilities: async () => [],
      } as never,
      onOccurrenceQueued: vi.fn(),
      publicUrl: new URL("https://host.test"),
      store: {
        create,
      } as unknown as TriggerStore,
    });
    await expect(
      service.create(
        {
          ownerId,
          anchorThreadId,
          idempotencyKey: "v3",
          name: "Unsupported",
          source: {
            kind: "watch",
          },
          script: {
            interpreter: null,
            text: "console.log('watch')",
          },
        },
        null,
      ),
    ).rejects.toMatchObject({
      message: "Update this computer to run script automations.",
    });
    expect(create).not.toHaveBeenCalled();
  });
  it("returns a reproducible webhook capability without storing the plaintext secret", async () => {
    const ownerId = createId("user");
    const anchorThreadId = createId("thread");
    const triggerId = createId("trigger");
    const revisionId = createId("triggerRevision");
    const create = vi.fn(async (input: Parameters<TriggerStore["create"]>[0]) => ({
      revision: TriggerRevisionSchema.parse({
        createdAt: new Date().toISOString(),
        createdBy: ownerId,
        id: revisionId,
        ordinal: 1,
        script: input.script,
        source: input.source,
        triggerId,
      }),
      trigger: TriggerSchema.parse({
        anchorThreadId,
        createdAt: new Date().toISOString(),
        createdBy: ownerId,
        currentRevisionId: revisionId,
        id: triggerId,
        kind: "webhook",
        name: input.name,
        nextFireAt: null,
        pauseReason: null,
        status: "active",
        updatedAt: new Date().toISOString(),
        webhookRouteKey: input.webhookRouteKey,
      }),
      wasDuplicate: false,
    }));
    const service = new TriggerService({
      threads: {
        readTask: async () => ({ environmentId: createId("environment") }) as never,
      },
      runnerStore: {
        getEnvironment: async () => ({ runnerId: createId("runner") }) as never,
        runnerCapabilities: async () => ["automation-script-v1"],
      },
      onOccurrenceQueued: vi.fn(),
      publicUrl: new URL("https://opensteer.example/base/"),
      store: {
        create,
      } as unknown as TriggerStore,
    });
    const result = await service.create(
      {
        anchorThreadId,
        idempotencyKey: "create-webhook",
        name: "Build events",
        ownerId,
        script: {
          interpreter: null,
          text: "console.log('ok')",
        },
        source: {
          kind: "webhook",
        },
      },
      null,
    );
    expect(result).toMatchObject({
      trigger: {
        id: triggerId,
        webhookRouteKey: expect.stringMatching(/^whk_.{43}$/u),
      },
      webhook: {
        scope: "public",
        url: expect.stringMatching(/^https:\/\/opensteer\.example\/hooks\/v1\/whk_/u),
      },
    });
    if (!("webhook" in result)) throw new Error("Expected webhook creation result");
    expect("secret" in result.webhook).toBe(false);
    const persisted = create.mock.calls[0]?.[0];
    expect("webhookSecretHash" in (persisted ?? {})).toBe(false);
  });
  it("resolves dynamic remoteOrigin as public and loopback canonicalOrigin as local", async () => {
    let liveRemote: string | null = null;
    const service = new TriggerService({
      onOccurrenceQueued: vi.fn(),
      publicUrl: new URL("http://127.0.0.1:4310"),
      remoteOrigin: async () => liveRemote,
      runnerStore: {} as never,
      store: {} as unknown as TriggerStore,
      threads: {} as never,
    });

    const local = await service.resolveWebhookAddress("whk_12345678901234567890123456789012");
    expect(local).toEqual({
      scope: "local",
      url: "http://127.0.0.1:4310/hooks/v1/whk_12345678901234567890123456789012",
    });

    liveRemote = "https://home.opensteer.example";
    const remote = await service.resolveWebhookAddress("whk_12345678901234567890123456789012");
    expect(remote).toEqual({
      scope: "public",
      url: "https://home.opensteer.example/hooks/v1/whk_12345678901234567890123456789012",
    });
  });
  it("accepts a webhook by key-in-path and wakes the dispatcher after commit (T7)", async () => {
    const occurrence = {
      id: createId("triggerOccurrence"),
    };
    const onOccurrenceQueued = vi.fn();
    const enqueueWebhook = vi.fn(async () => ({
      occurrence,
      wasDuplicate: false,
    }));
    const service = new TriggerService({
      threads: {
        readTask: async () => ({ environmentId: createId("environment") }) as never,
      },
      runnerStore: {
        getEnvironment: async () => ({ runnerId: createId("runner") }) as never,
        runnerCapabilities: async () => ["automation-script-v1"],
      },
      onOccurrenceQueued,
      publicUrl: new URL("https://opensteer.example"),
      store: {
        enqueueWebhook,
      } as unknown as TriggerStore,
    });
    const rawBody = Buffer.from('{"ref":"main"}', "utf8");
    await expect(
      service.acceptWebhook({
        headers: {
          "x-github-event": "push",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        method: "POST",
        path: "/hooks/v1",
        payload: null,
        query: { env: "prod" },
        rawBody,
        routeKey: "whk_12345678901234567890123456789012",
      }),
    ).resolves.toEqual({
      occurrence,
      wasDuplicate: false,
    });
    expect(enqueueWebhook).toHaveBeenCalledTimes(1);
    expect(onOccurrenceQueued).toHaveBeenCalledTimes(1);
  });
  it("interrupts running firings when pausing an automation (Y12)", async () => {
    const ownerId = createId("user");
    const triggerId = createId("trigger");
    const occurrenceId = createId("triggerOccurrence");
    const environmentId = createId("environment");
    const runnerId = createId("runner");
    const onInterruptFiring = vi.fn();
    const setStatusWithEffects = vi.fn(async () => ({
      canceledOccurrenceIds: [],
      runningFirings: [
        {
          environmentId,
          executionGeneration: 2,
          occurrenceId,
          runnerBootId: "boot-pause-1",
          runnerId,
        },
      ],
      trigger: {
        id: triggerId,
        kind: "schedule",
        status: "paused",
      },
    }));
    const service = new TriggerService({
      onInterruptFiring,
      onOccurrenceQueued: vi.fn(),
      publicUrl: new URL("https://opensteer.example"),
      runnerStore: {} as never,
      store: { setStatusWithEffects } as unknown as TriggerStore,
      threads: {} as never,
    });
    const paused = await service.setStatus(ownerId, { status: "paused", triggerId }, null);
    expect(paused.status).toBe("paused");
    expect(onInterruptFiring).toHaveBeenCalledWith({
      environmentId,
      executionGeneration: 2,
      occurrenceId,
      runnerBootId: "boot-pause-1",
      runnerId,
    });
  });
  it("returns current webhook address in get/list state and redacts url for agents lacking run authority (AA9)", async () => {
    const ownerId = createId("user");
    const triggerId = createId("trigger");
    const routeKey = "whk_secret_route_key_0123456789abcdef0123456";
    const triggerRow = {
      id: triggerId,
      kind: "webhook" as const,
      name: "Deploy hook",
      webhookRouteKey: routeKey,
    };
    const service = new TriggerService({
      onOccurrenceQueued: vi.fn(),
      publicUrl: new URL("http://127.0.0.1:4310"),
      remoteOrigin: async () => "https://home.opensteer.example",
      runnerStore: {} as never,
      store: {
        getForOwner: vi.fn(async () => ({ trigger: triggerRow })),
        listForOwner: vi.fn(async () => [triggerRow]),
      } as unknown as TriggerStore,
      threads: {} as never,
    });

    const personGet = (await service.get(ownerId, triggerId, 10, { kind: "person" })) as {
      readonly trigger: typeof triggerRow;
      readonly webhook?: { readonly scope: string; readonly url: string | null } | null;
    };
    expect(personGet.webhook).toEqual({
      scope: "public",
      url: `https://home.opensteer.example/hooks/v1/${routeKey}`,
    });

    const personList = (await service.list(ownerId, {
      reader: { kind: "person" },
    })) as ReadonlyArray<
      typeof triggerRow & {
        readonly webhook?: { readonly scope: string; readonly url: string | null } | null;
      }
    >;
    expect(personList[0]?.webhook).toEqual({
      scope: "public",
      url: `https://home.opensteer.example/hooks/v1/${routeKey}`,
    });

    let liveMode: "ask" | "full-access" = "ask";
    const handlers = new TriggerToolHandlers(
      service,
      { triggerOrigins: async () => new Map() },
      {
        door: (_caller, registry) => ({
          registry,
          scope: async () => ({
            scope: null,
            grant: null,
            mode: liveMode === "full-access" ? "full-access" : "approval-required",
          }),
          admit: async (caller, cmd) =>
            cmd.type === "trigger.run" && liveMode !== "full-access"
              ? { answer: "ask", face: 0, reason: "mode", execution: null }
              : {
                  answer: "now",
                  face: 0,
                  execution: { subject: commandSubject(caller.key) } as never,
                },
          secretDigestKey: Buffer.alloc(32, 0x33),
        }),
      },
    );
    const askCaller = {
      accessMode: "ask",
      kind: "run",
      key: "run:ask",
      userId: ownerId,
      thread: { id: createId("thread") },
    } as unknown as RunCaller;
    const askResult = (await handlers.read({
      caller: askCaller,
      input: { automationId: triggerId, occurrenceLimit: 10 },
      operationKey: "read-ask",
    })) as {
      readonly trigger?: { readonly webhookRouteKey?: string | null };
      readonly webhook?: { readonly scope: string; readonly url: string | null } | null;
    };
    expect(askResult.trigger?.webhookRouteKey).toBeNull();
    expect(askResult.webhook).toEqual({ scope: "public", url: null });

    const askListResult = (await handlers.read({
      caller: askCaller,
      input: { limit: 10 },
      operationKey: "list-ask",
    })) as {
      readonly triggers?: ReadonlyArray<{
        readonly webhookRouteKey?: string | null;
        readonly webhook?: { readonly scope: string; readonly url: string | null } | null;
      }>;
    };
    expect(askListResult.triggers?.[0]?.webhookRouteKey).toBeNull();
    expect(askListResult.triggers?.[0]?.webhook).toEqual({ scope: "public", url: null });

    liveMode = "full-access";
    const fullCaller = { ...askCaller, accessMode: "full-access" } as RunCaller;
    const fullResult = (await handlers.read({
      caller: fullCaller,
      input: { automationId: triggerId, occurrenceLimit: 10 },
      operationKey: "read-full",
    })) as {
      readonly trigger?: { readonly webhookRouteKey?: string | null };
      readonly webhook?: { readonly scope: string; readonly url: string | null } | null;
    };
    expect(fullResult.trigger?.webhookRouteKey).toBe(routeKey);
    expect(fullResult.webhook).toEqual({
      scope: "public",
      url: `https://home.opensteer.example/hooks/v1/${routeKey}`,
    });
  });

  it("redacts a connected agent's webhook address from your own full-access agent Run (AB7)", async () => {
    const ownerId = createId("user");
    const triggerId = createId("trigger");
    const foreignConnectionId = "acn_foreign_lineage_test";
    const routeKey = "whk_foreign_lineage_key_0123456789abcdef0123";
    const triggerRow = {
      id: triggerId,
      kind: "webhook" as const,
      name: "Connected agent hook",
      webhookRouteKey: routeKey,
    };
    const service = new TriggerService({
      onOccurrenceQueued: vi.fn(),
      publicUrl: new URL("https://home.opensteer.example"),
      runnerStore: {} as never,
      store: {
        getForOwner: vi.fn(async () => ({ trigger: triggerRow })),
        listForOwner: vi.fn(async () => [triggerRow]),
      } as unknown as TriggerStore,
      threads: {} as never,
    });
    const handlers = new TriggerToolHandlers(
      service,
      { triggerOrigins: async () => new Map([[triggerId, foreignConnectionId]]) },
      {
        door: (_caller, registry) => ({
          registry,
          scope: async () => ({ scope: null, grant: null, mode: "full-access" }),
          admit: async (caller: AgentCaller) => ({
            answer: "now",
            face: 0,
            execution: { subject: commandSubject(caller.key) } as never,
          }),
          secretDigestKey: Buffer.alloc(32, 0x33),
        }),
      },
    );
    const personalFullCaller = {
      accessMode: "full-access",
      kind: "run",
      key: "run:personal-full",
      userId: ownerId,
      thread: { id: createId("thread") },
    } as unknown as RunCaller;

    const readResult = (await handlers.read({
      caller: personalFullCaller,
      input: { automationId: triggerId, occurrenceLimit: 10 },
      operationKey: "read-foreign-webhook",
    })) as {
      readonly trigger?: { readonly webhookRouteKey?: string | null };
      readonly webhook?: { readonly scope: string; readonly url: string | null } | null;
    };
    expect(readResult.trigger?.webhookRouteKey).toBeNull();
    expect(readResult.webhook).toEqual({ scope: "public", url: null });

    const listResult = (await handlers.read({
      caller: personalFullCaller,
      input: { limit: 10 },
      operationKey: "list-foreign-webhook",
    })) as {
      readonly triggers?: ReadonlyArray<{
        readonly webhookRouteKey?: string | null;
        readonly webhook?: { readonly scope: string; readonly url: string | null } | null;
      }>;
    };
    expect(listResult.triggers?.[0]?.webhookRouteKey).toBeNull();
    expect(listResult.triggers?.[0]?.webhook).toEqual({ scope: "public", url: null });
  });

  it("redacts webhook url when live admitExecution mode is lowered after sign-in (AA14.2)", async () => {
    const ownerId = createId("user");
    const triggerId = createId("trigger");
    const revisionId = createId("triggerRevision");
    const routeKey = "whk_live_mode_check_123456789012345678901234";
    const now = new Date().toISOString();
    const triggerRow = TriggerSchema.parse({
      anchorThreadId: createId("thread"),
      createdAt: now,
      createdBy: ownerId,
      currentRevisionId: revisionId,
      id: triggerId,
      kind: "webhook",
      name: "Live mode webhook",
      nextFireAt: null,
      pauseReason: null,
      status: "active",
      updatedAt: now,
      webhookRouteKey: routeKey,
    });
    const service = new TriggerService({
      onOccurrenceQueued: vi.fn(),
      publicUrl: new URL("https://home.opensteer.example"),
      runnerStore: {} as never,
      store: {
        getForOwner: async () => ({
          activation: null,
          anchorThreadTitle: "Task",
          createdByThreadTitle: null,
          downstreamRuns: [],
          downstreamRunsTruncated: false,
          occurrences: [],
          revision: TriggerRevisionSchema.parse({
            createdAt: now,
            createdBy: ownerId,
            id: revisionId,
            ordinal: 1,
            script: { interpreter: null, text: "console.log('ok')" },
            source: { kind: "webhook" },
            triggerId,
          }),
          trigger: triggerRow,
        }),
      } as unknown as TriggerStore,
      threads: {} as never,
    });
    const admit = vi.fn(async (caller: { key: string }, cmd: { type: string }) =>
      cmd.type === "trigger.run"
        ? ({ answer: "ask", face: 0, reason: "mode", execution: null } as const)
        : ({
            answer: "now",
            face: 0,
            execution: { subject: commandSubject(caller.key) } as never,
          } as const),
    );
    const handlers = new TriggerToolHandlers(
      service,
      { triggerOrigins: async () => new Map() },
      {
        door: (_caller, registry) => ({
          registry,
          scope: async () => ({ scope: null, grant: null, mode: "auto" }),
          admit,
          secretDigestKey: Buffer.alloc(32, 0x33),
        }),
      },
    );
    const staleFullCaller = {
      accessMode: "full-access",
      kind: "run",
      key: "run:stale-full",
      userId: ownerId,
      thread: { id: triggerRow.anchorThreadId },
    } as unknown as RunCaller;
    const result = (await handlers.read({
      caller: staleFullCaller,
      input: { automationId: triggerId, occurrenceLimit: 10 },
      operationKey: "read-stale-full",
    })) as {
      readonly trigger?: { readonly webhookRouteKey?: string | null };
      readonly webhook?: { readonly scope: string; readonly url: string | null } | null;
    };
    expect(admit).toHaveBeenCalledWith(
      staleFullCaller,
      expect.objectContaining({ type: "trigger.run", triggerId }),
    );
    expect(result.trigger?.webhookRouteKey).toBeNull();
    expect(result.webhook).toEqual({ scope: "public", url: null });
  });
  it("sets, replaces, lists names, and removes secrets via TriggerService while keeping rotateWebhookKey absent", async () => {
    expect("rotateWebhookKey" in TriggerService.prototype).toBe(false);
    let storedEnvelope: Buffer | null = null;
    const onChanged = vi.fn();
    const onWatchChanged = vi.fn();
    const { AesGcmSecretVault, StaticEncryptionKeyProvider } =
      await import("@opensteer/access/host");
    const { AutomationSecrets } = await import("./automation-secrets.js");
    const secrets = new AutomationSecrets(
      new AesGcmSecretVault(
        new StaticEncryptionKeyProvider(new Map([[1, Buffer.alloc(32, 0x33)]]), 1),
      ),
    );
    const triggerId = createId("trigger");
    const anchorThreadId = createId("thread");
    const userId = createId("user");
    const now = new Date().toISOString();
    const triggerRecord = {
      anchorThreadId,
      createdAt: now,
      createdBy: userId,
      createdByThreadId: null,
      currentRevisionId: createId("triggerRevision"),
      id: triggerId,
      kind: "watch" as const,
      lastFiredAt: null,
      name: "Secret watch",
      nextFireAt: null,
      pauseReason: null,
      pausedBy: null,
      status: "active" as const,
      systemRole: null,
      updatedAt: now,
      webhookRouteKey: null,
    };
    const service = new TriggerService({
      onChanged,
      onOccurrenceQueued: vi.fn(),
      onWatchChanged,
      publicUrl: new URL("https://host.opensteer.test"),
      runnerStore: {} as never,
      secrets,
      store: {
        getEncryptedSecrets: vi.fn(async () => storedEnvelope),
        getForOwner: vi.fn(async () => ({
          activation: null,
          anchorThread: null,
          anchorThreadTitle: "Task",
          createdByThreadTitle: null,
          downstreamRuns: [],
          downstreamRunsTruncated: false,
          occurrences: [],
          revision: {
            createdAt: now,
            createdBy: userId,
            createdByThreadId: null,
            id: triggerRecord.currentRevisionId,
            ordinal: 1,
            script: { interpreter: null, text: "console.log(1)" },
            source: { kind: "watch" as const },
            triggerId,
          },
          trigger: triggerRecord,
        })),
        updateEncryptedSecrets: vi.fn(
          async (input: {
            transform: (current: Buffer | null) => Promise<{
              changed: boolean;
              names: readonly string[];
              result: readonly string[];
              sealed: { envelope: Buffer; keyVersion: number } | null;
            }>;
          }) => {
            const { changed, result, sealed } = await input.transform(storedEnvelope);
            storedEnvelope = sealed?.envelope ?? null;
            return { changed, replayed: false, result, trigger: triggerRecord };
          },
        ),
      } as never,
      threads: {} as never,
    } as never);

    const setRes = await (
      service as unknown as {
        setSecrets: (
          owner: unknown,
          input: unknown,
          actorThreadId: null,
        ) => Promise<{ secretNames: readonly string[] }>;
      }
    ).setSecrets(userId, { triggerId, set: { Z_KEY: "val-z", A_KEY: "val-a" } }, null);
    expect(setRes.secretNames).toEqual(["A_KEY", "Z_KEY"]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onWatchChanged).toHaveBeenCalledWith(triggerId);

    const detail = (await service.get(userId, triggerId, 10, { kind: "person" })) as {
      secretNames?: readonly string[];
    };
    expect(detail.secretNames).toEqual(["A_KEY", "Z_KEY"]);
    expect(JSON.stringify(detail)).not.toContain("val-a");
    expect(JSON.stringify(detail)).not.toContain("val-z");
  });
  it("fires schedules at their deadline or a wake, wakes dispatch only for new occurrences, and never polls", async () => {
    vi.useFakeTimers();
    const onChanged = vi.fn();
    const onOccurrenceQueued = vi.fn();
    const claimDueSchedules = vi
      .fn()
      .mockResolvedValueOnce({
        occurrences: [
          {
            event: {
              trigger: {},
            },
            id: createId("triggerOccurrence"),
          },
        ],
        changed: true,
        failures: [],
        runningFirings: [],
      })
      .mockResolvedValue({
        occurrences: [],
        changed: false,
        failures: [],
        runningFirings: [],
      });
    // The next schedule is a minute out, and then none is armed.
    const nextScheduleAt = vi
      .fn<() => Promise<Date | null>>()
      .mockImplementationOnce(async () => new Date(Date.now() + 60_000))
      .mockResolvedValue(null);
    const loop = new TriggerScheduleLoop({
      onChanged,
      onError: vi.fn(),
      onOccurrenceQueued,
      store: {
        claimDueSchedules,
        nextScheduleAt,
      } as Pick<TriggerStore, "claimDueSchedules" | "nextScheduleAt">,
    });
    const passAt = Date.now();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimDueSchedules).toHaveBeenCalledTimes(1);
    // Claimed at the pass's own time, the one its deadline is judged against.
    expect(claimDueSchedules.mock.calls[0]?.[0]).toEqual(new Date(passAt));
    expect(onOccurrenceQueued).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls).toEqual([[]]);
    // No polling before the deadline.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(claimDueSchedules).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claimDueSchedules).toHaveBeenCalledTimes(2);
    expect(onOccurrenceQueued).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // Nothing armed: idle until a commit moves a schedule.
    expect(vi.getTimerCount()).toBe(0);
    loop.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimDueSchedules).toHaveBeenCalledTimes(3);
    await loop.close();
  });
  it("interrupts running firings paused by authority loss during claimDueSchedules (AA10)", async () => {
    vi.useFakeTimers();
    const firing = {
      commandId: createId("command"),
      environmentId: createId("environment"),
      executionGeneration: 1,
      occurrenceId: createId("triggerOccurrence"),
      runnerBootId: "boot-auth-loss",
      runnerId: createId("runner"),
    };
    const onInterruptFiring = vi.fn();
    const claimDueSchedules = vi.fn(async () => ({
      changed: true,
      failures: [],
      occurrences: [],
      runningFirings: [firing],
    }));
    const loop = new TriggerScheduleLoop({
      onChanged: vi.fn(),
      onError: vi.fn(),
      onInterruptFiring,
      onOccurrenceQueued: vi.fn(),
      store: {
        claimDueSchedules,
        nextScheduleAt: async () => null,
      } as unknown as Pick<TriggerStore, "claimDueSchedules" | "nextScheduleAt">,
    } as ConstructorParameters<typeof TriggerScheduleLoop>[0]);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onInterruptFiring).toHaveBeenCalledWith(firing);
    await loop.close();
  });
});

describe("TriggerScheduleLoop exits", () => {
  it.each([
    ["claimed and moved on: re-armed at the next time", true, 60_000, 60_000],
    ["nothing due: armed at the next time", false, 60_000, 60_000],
    ["no schedule armed: disarmed", false, null, null],
    ["due but not claimable: backs off, no spin", false, -1, 5_000],
  ] as const)("%s", async (_, changed, nextIn, armedIn) => {
    vi.useFakeTimers();
    try {
      const claimDueSchedules = vi.fn(async () => ({
        occurrences: [],
        changed,
        failures: [],
        runningFirings: [],
      }));
      const nextScheduleAt = vi.fn(async () =>
        nextIn === null ? null : new Date(Date.now() + nextIn),
      );
      const loop = new TriggerScheduleLoop({
        onChanged: vi.fn(),
        onError: vi.fn(),
        onOccurrenceQueued: vi.fn(),
        store: { claimDueSchedules, nextScheduleAt } as Pick<
          TriggerStore,
          "claimDueSchedules" | "nextScheduleAt"
        >,
      });
      loop.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(claimDueSchedules).toHaveBeenCalledTimes(1);
      if (armedIn === null) expect(vi.getTimerCount()).toBe(0);
      else {
        await vi.advanceTimersByTimeAsync(armedIn - 1);
        expect(claimDueSchedules).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(claimDueSchedules).toHaveBeenCalledTimes(2);
      }
      await loop.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
