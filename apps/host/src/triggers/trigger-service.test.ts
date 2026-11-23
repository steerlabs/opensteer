import { TriggerToolHandlers } from "../mcp/handlers/triggers.js";
import { opensteer_automation_control } from "@opensteer/agent-tools/tools";
import type { RunCaller } from "../mcp/agent-caller.js";
import { idempotencyKey, operationId } from "../mcp/operations.js";
import { createId } from "@opensteer/core";
import type { TriggerStore } from "@opensteer/database";
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
    const handlers = new TriggerToolHandlers(service, { triggerOrigins: async () => new Map() });
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
      tokens: {
        deriveSecret: () => "unused",
      },
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
        consecutiveFailures: 0,
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
      tokens: {
        deriveSecret: (_purpose, routeKey) => `derived_${routeKey}`,
      },
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
        secret: expect.stringMatching(/^oswh_derived_whk_/u),
        url: expect.stringMatching(/^https:\/\/opensteer\.example\/hooks\/v1\/whk_/u),
      },
    });
    if (!("webhook" in result)) throw new Error("Expected webhook creation result");
    const persisted = create.mock.calls[0]?.[0];
    expect(persisted?.webhookSecretHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(persisted?.webhookSecretHash).not.toContain(result.webhook.secret);
  });
  it("resolves dynamic remoteOrigin as public and loopback canonicalOrigin as local, and rotates keys", async () => {
    const ownerId = createId("user");
    const triggerId = createId("trigger");
    let liveRemote: string | null = null;
    const rotateWebhookKey = vi.fn(async (input: { readonly webhookRouteKey: string }) =>
      TriggerSchema.parse({
        anchorThreadId: createId("thread"),
        consecutiveFailures: 0,
        createdAt: new Date().toISOString(),
        createdBy: ownerId,
        currentRevisionId: createId("triggerRevision"),
        id: triggerId,
        kind: "webhook",
        name: "Hook",
        nextFireAt: null,
        pauseReason: null,
        status: "active",
        updatedAt: new Date().toISOString(),
        webhookRouteKey: input.webhookRouteKey,
      }),
    );
    const service = new TriggerService({
      onOccurrenceQueued: vi.fn(),
      publicUrl: new URL("http://127.0.0.1:4310"),
      remoteOrigin: async () => liveRemote,
      runnerStore: {} as never,
      store: { rotateWebhookKey } as unknown as TriggerStore,
      threads: {} as never,
      tokens: { deriveSecret: (_p, key) => `derived_${key}` },
    });

    const local = await service.resolveWebhookAddress("whk_12345678901234567890123456789012");
    expect(local).toEqual({
      scope: "local",
      url: "http://127.0.0.1:4310/hooks/v1/whk_12345678901234567890123456789012",
    });

    liveRemote = "https://home.opensteer.example";
    const rotated = await service.rotateWebhookKey(ownerId, triggerId, null);
    expect(rotated.webhook.scope).toBe("public");
    expect(rotated.webhook.url).toMatch(/^https:\/\/home\.opensteer\.example\/hooks\/v1\/whk_/u);
    expect(rotateWebhookKey).toHaveBeenCalledTimes(1);
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
      tokens: {
        deriveSecret: () => "unused",
      },
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
      tokens: { deriveSecret: () => "unused" },
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
  it("hides webhookRouteKey from agents lacking run authority (Y3)", async () => {
    const triggerId = createId("trigger");
    const routeKey = "whk_secret_route_key_0123456789abcdef0123456";
    const service = {
      manage: vi.fn(async () => ({
        trigger: { id: triggerId, name: "Deploy hook", webhookRouteKey: routeKey },
      })),
    };
    const handlers = new TriggerToolHandlers(service, { triggerOrigins: async () => new Map() });
    const askCaller = {
      accessMode: "ask",
      kind: "run",
      key: "run:ask",
      userId: createId("user"),
      thread: { id: createId("thread") },
    } as unknown as RunCaller;
    const askResult = await handlers.read({
      caller: askCaller,
      input: { automationId: triggerId, occurrenceLimit: 10 },
      operationKey: "read-ask",
    });
    expect(askResult.trigger?.webhookRouteKey).toBeNull();

    const fullCaller = { ...askCaller, accessMode: "full-access" } as RunCaller;
    const fullResult = await handlers.read({
      caller: fullCaller,
      input: { automationId: triggerId, occurrenceLimit: 10 },
      operationKey: "read-full",
    });
    expect(fullResult.trigger?.webhookRouteKey).toBe(routeKey);
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
      })
      .mockResolvedValue({
        occurrences: [],
        changed: false,
        failures: [],
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
      const claimDueSchedules = vi.fn(async () => ({ occurrences: [], changed, failures: [] }));
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
