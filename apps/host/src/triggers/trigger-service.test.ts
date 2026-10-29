import { createHash } from "node:crypto";
import { createId } from "@opensteer/core";
import type { TriggerStore } from "@opensteer/database";
import { TriggerRevisionSchema, TriggerSchema } from "@opensteer/triggers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TriggerScheduleLoop, TriggerService } from "./trigger-service.js";

describe("TriggerService", () => {
  afterEach(() => vi.useRealTimers());

  it("refuses v3 before persisting when the anchor computer has no v3 advertisement", async () => {
    const create = vi.fn(async () => ({ trigger: { kind: "watch" } }));
    const ownerId = createId("user");
    const anchorThreadId = createId("thread");
    const service = new TriggerService({
      homeThread: async () => null,
      threads: {
        getThreadForOwner: async () => ({ environmentId: createId("environment") }),
      } as never,
      runnerStore: {
        getEnvironment: async () => ({ runnerId: createId("runner") }),
        runnerCapabilities: async () => [],
      } as never,
      onOccurrenceQueued: vi.fn(),
      publicUrl: new URL("https://host.test"),
      store: { create } as unknown as TriggerStore,
      tokens: { deriveSecret: () => "unused" },
    });
    await expect(
      service.create(
        {
          ownerId,
          anchorThreadId,
          idempotencyKey: "v3",
          name: "Unsupported",
          source: { kind: "watch" },
          program: {
            language: "javascript",
            source: "export default () => null",
            toolContractVersion: 3,
          },
        },
        null,
      ),
    ).rejects.toMatchObject({
      message:
        "This computer's Runner cannot run Trigger program version 3. Use version 2 or update that computer.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a reproducible webhook capability without storing the plaintext secret", async () => {
    const ownerId = createId("user");
    const anchorThreadId = createId("thread");
    const triggerId = createId("trigger");
    const revisionId = createId("triggerRevision");
    const workspaceId = createId("workspace");
    const create = vi.fn(async (input: Parameters<TriggerStore["create"]>[0]) => ({
      revision: TriggerRevisionSchema.parse({
        createdAt: new Date().toISOString(),
        createdBy: ownerId,
        id: revisionId,
        ordinal: 1,
        program: input.program,
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
        workspaceId,
      }),
      wasDuplicate: false,
    }));
    const service = new TriggerService({
      homeThread: async () => null,
      threads: { getThreadForOwner: async () => null },
      runnerStore: { getEnvironment: vi.fn(), runnerCapabilities: vi.fn() },
      onOccurrenceQueued: vi.fn(),
      publicUrl: new URL("https://opensteer.example/base/"),
      store: { create } as unknown as TriggerStore,
      tokens: { deriveSecret: (_purpose, routeKey) => `derived_${routeKey}` },
    });

    const result = await service.create(
      {
        anchorThreadId,
        idempotencyKey: "create-webhook",
        name: "Build events",
        ownerId,
        program: {
          toolContractVersion: 2,
          language: "typescript",
          source: "export default async () => null",
        },
        source: { kind: "webhook" },
      },
      null,
    );

    expect(result).toMatchObject({
      trigger: { id: triggerId, webhookRouteKey: expect.stringMatching(/^wh_.{32}$/u) },
      webhook: {
        secret: expect.stringMatching(/^oswh_derived_wh_/u),
        url: expect.stringMatching(/^https:\/\/opensteer\.example\/hooks\/v1\/wh_/u),
      },
    });
    if (!("webhook" in result)) throw new Error("Expected webhook creation result");
    const persisted = create.mock.calls[0]?.[0];
    expect(persisted?.webhookSecretHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(persisted?.webhookSecretHash).not.toContain(result.webhook.secret);
  });

  it("authenticates a webhook before enqueueing it and wakes the dispatcher after commit", async () => {
    const secret = "oswh_a_valid_webhook_secret_value";
    const occurrence = { id: createId("triggerOccurrence") };
    const onOccurrenceQueued = vi.fn();
    const enqueueWebhook = vi.fn(async () => ({ occurrence, wasDuplicate: false }));
    const webhookRoute = vi.fn(async () => ({
      secretHash: createHash("sha256").update(secret).digest("hex"),
      trigger: {},
    }));
    const service = new TriggerService({
      homeThread: async () => null,
      threads: { getThreadForOwner: async () => null },
      runnerStore: { getEnvironment: vi.fn(), runnerCapabilities: vi.fn() },
      onOccurrenceQueued,
      publicUrl: new URL("https://opensteer.example"),
      store: { enqueueWebhook, webhookRoute } as unknown as TriggerStore,
      tokens: { deriveSecret: () => "unused" },
    });

    await expect(
      service.acceptWebhook({
        headers: {},
        method: "POST",
        payload: null,
        routeKey: "wh_12345678901234567890123456789012",
        secret: "wrong-secret",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(enqueueWebhook).not.toHaveBeenCalled();

    await expect(
      service.acceptWebhook({
        deliveryId: "delivery-1",
        headers: { "x-github-event": "push" },
        method: "POST",
        payload: { ref: "main" },
        routeKey: "wh_12345678901234567890123456789012",
        secret,
      }),
    ).resolves.toEqual({ occurrence, wasDuplicate: false });
    expect(enqueueWebhook).toHaveBeenCalledTimes(1);
    expect(onOccurrenceQueued).toHaveBeenCalledTimes(1);
  });

  it("wakes dispatch only when the schedule transaction creates occurrences", async () => {
    vi.useFakeTimers();
    const onChanged = vi.fn();
    const onOccurrenceQueued = vi.fn();
    const queuedWorkspaceId = createId("workspace");
    const pausedWorkspaceId = createId("workspace");
    const claimDueSchedules = vi
      .fn()
      .mockResolvedValueOnce({
        occurrences: [
          {
            event: { trigger: { workspaceId: queuedWorkspaceId } },
            id: createId("triggerOccurrence"),
          },
        ],
        workspaceIds: [queuedWorkspaceId, pausedWorkspaceId],
      })
      .mockResolvedValue({ occurrences: [], workspaceIds: [] });
    const loop = new TriggerScheduleLoop({
      onChanged,
      onError: vi.fn(),
      onOccurrenceQueued,
      store: { claimDueSchedules } as Pick<TriggerStore, "claimDueSchedules">,
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimDueSchedules).toHaveBeenCalledTimes(1);
    expect(onOccurrenceQueued).toHaveBeenCalledTimes(1);
    // A due Trigger that was paused or moved on without an Occurrence still
    // changed; its Workspace is told once, and a queued one is not told twice.
    expect(onChanged.mock.calls).toEqual([[pausedWorkspaceId]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claimDueSchedules).toHaveBeenCalledTimes(2);
    expect(onOccurrenceQueued).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await loop.close();
  });
});
