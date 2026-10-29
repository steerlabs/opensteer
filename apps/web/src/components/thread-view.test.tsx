import {
  harnessUsageLimitFailureCode,
  ModelSelectionSchema,
  ProviderContinuationIdentitySchema,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { HarnessModelDescriptorSchema, type HarnessObservedConnection } from "@opensteer/protocol";
import type { ThreadPlacementOption, ThreadSummary, TranscriptEntry } from "@opensteer/client/host";
import { usageLimitRecovery } from "./thread-view.js";

const codexContinuation = ProviderContinuationIdentitySchema.parse({
  continuationKey: `runner:v1:${"a".repeat(43)}`,
  driverKind: "codex",
});
const foreignContinuation = ProviderContinuationIdentitySchema.parse({
  continuationKey: `runner:v1:${"b".repeat(43)}`,
  driverKind: "codex",
});
const solDescriptor = HarnessModelDescriptorSchema.parse({
  displayName: "GPT-5.6-Sol",
  isDefault: true,
  modelId: "gpt-5.6-sol",
  options: [],
  providerId: "openai",
});
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {},
  providerId: "openai",
});

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    doneAt: null,
    icon: null,
    color: null,
    accessMode: "auto",
    continuationIdentity: codexContinuation,
    createdAt: "2026-09-04T00:00:00.000Z",
    environmentId: "environment-main",
    harnessInstanceId: "harness-work",
    harnessLabel: "Codex Work",
    id: "thread-1",
    providerSessionId: null,
    inputQueuePaused: false,
    listed: true,
    modelLabel: "GPT-5.6 Sol",
    modelSelection,
    parentThreadId: null,
    pendingRequests: 0,
    role: "work",
    runnerLabel: "Main runner",
    status: "failed",
    title: "Ship the fix",
    unread: false,
    updatedAt: "2026-09-05T00:00:00.000Z",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

function placement(overrides: Partial<ThreadPlacementOption> = {}): ThreadPlacementOption {
  return {
    accessModes: [...ThreadAccessModeSchema.options],
    available: true,
    availability: "configured",
    continuationIdentity: codexContinuation,
    detail: "Ready",
    driverKind: "codex",
    accountName: "Codex Work",
    engineName: "Codex",
    defaultAccount: true,
    environmentId: "environment-main",
    environmentKind: "main",
    harnessAuthenticationAllowed: true,
    harnessInstanceId: "harness-work",
    models: [solDescriptor],
    modelSelection,
    observedConnections: [],
    setupAvailable: false,
    setupMethods: [],
    source: {
      fields: [],
      kind: "first-party",
      label: "OpenAI",
      quota: "windows",
      sourceId: "openai",
      stateKinds: ["ambient", "isolated"],
    },
    sourceId: "openai",
    whereLabel: "Main",
    ...overrides,
  };
}

function connection(
  accountLabel: string,
  usage?: HarnessObservedConnection["usage"],
): HarnessObservedConnection {
  return {
    accountLabel,
    connectionSlot: "primary",
    label: "Codex",
    status: "connected",
    ...(usage ? { usage } : {}),
  };
}

function failedRun(code: string): Extract<TranscriptEntry, { kind: "run" }> {
  return {
    createdAt: "2026-09-05T00:00:00.000Z",
    error: { code, message: "You've hit your usage limit.", retryable: false },
    id: "run:run-1",
    kind: "run",
    replyMessageId: null,
    runId: "run-1",
    status: "failed",
  };
}

const now = new Date("2026-09-05T00:00:00.000Z").getTime();

describe("usageLimitRecovery", () => {
  const spent = placement({
    observedConnections: [
      connection("work@example.test", {
        limitReached: true,
        observedAt: "2026-09-05T00:00:00.000Z",
        windows: [
          {
            label: "weekly",
            resetsAt: new Date(2026, 8, 7, 2, 43, 12).toISOString(),
            usedPercent: 100,
          },
        ],
      }),
    ],
  });
  const spare = placement({
    accountName: "Codex Personal",
    engineName: "Codex",
    defaultAccount: true,
    harnessInstanceId: "harness-spare",
    observedConnections: [connection("personal@example.test")],
  });

  it("offers a compatible account on the same work location", () => {
    const recovery = usageLimitRecovery(
      [failedRun(harnessUsageLimitFailureCode)],
      [spent, spare],
      thread(),
      now,
    );

    expect(recovery?.accountLabel).toBe("work@example.test");
    expect(recovery?.alternative?.harnessInstanceId).toBe("harness-spare");
    expect(recovery?.alternativeAccountLabel).toBe("personal@example.test");
  });

  it("stays silent for any other failure code", () => {
    expect(
      usageLimitRecovery([failedRun("codex_harness_error")], [spent, spare], thread(), now),
    ).toBeNull();
    expect(
      usageLimitRecovery(
        [{ ...failedRun(harnessUsageLimitFailureCode), status: "completed" }],
        [spent, spare],
        thread(),
        now,
      ),
    ).toBeNull();
    expect(usageLimitRecovery([], [spent, spare], thread(), now)).toBeNull();
  });

  it("refuses an account whose provider session this Thread cannot continue", () => {
    const foreign = placement({
      continuationIdentity: foreignContinuation,
      harnessInstanceId: "harness-foreign",
      observedConnections: [connection("other@example.test")],
    });
    const unavailable = placement({
      available: false,
      harnessInstanceId: "harness-off",
      observedConnections: [connection("off@example.test")],
    });
    const elsewhere = placement({
      environmentId: "environment-cloud",
      harnessInstanceId: "harness-cloud",
      observedConnections: [connection("cloud@example.test")],
    });

    const recovery = usageLimitRecovery(
      [failedRun(harnessUsageLimitFailureCode)],
      [spent, foreign, unavailable, elsewhere],
      thread(),
      now,
    );

    expect(recovery?.alternative).toBeNull();
    expect(recovery?.alternativeAccountLabel).toBeNull();
    expect(recovery?.resetsAt).toBe("Mon 2:43 AM");
  });

  it("refuses an account that is itself out of capacity", () => {
    const alsoSpent = placement({
      accountName: "Codex Personal",
      engineName: "Codex",
      defaultAccount: true,
      harnessInstanceId: "harness-spare",
      observedConnections: [
        connection("personal@example.test", {
          limitReached: true,
          observedAt: "2026-09-05T00:00:00.000Z",
          windows: [{ label: "5h", resetsAt: "2026-09-05T04:00:00.000Z", usedPercent: 100 }],
        }),
      ],
    });

    expect(
      usageLimitRecovery(
        [failedRun(harnessUsageLimitFailureCode)],
        [spent, alsoSpent],
        thread(),
        now,
      )?.alternative,
    ).toBeNull();
    // Once that account's own window has reset, the refusal it reported is no
    // longer knowledge and the account becomes a real way forward again.
    expect(
      usageLimitRecovery(
        [failedRun(harnessUsageLimitFailureCode)],
        [spent, alsoSpent],
        thread(),
        new Date("2026-09-05T04:00:00.000Z").getTime(),
      )?.alternative?.harnessInstanceId,
    ).toBe("harness-spare");
  });

  it("refuses an account of another source, and one that lacks the model", () => {
    const otherSource = placement({
      accountName: "OpenRouter",
      harnessInstanceId: "harness-openrouter",
      observedConnections: [connection("router@example.test")],
      source: {
        fields: [{ id: "baseUrl", kind: "url", label: "Base URL" }],
        kind: "compatible-endpoint",
        label: "OpenAI-compatible endpoint",
        quota: "none",
        sourceId: "openai-compatible",
        stateKinds: ["isolated"],
      },
      sourceId: "openai-compatible",
    });
    const lacksModel = placement({
      accountName: "Codex Personal",
      harnessInstanceId: "harness-spare",
      models: [],
      observedConnections: [connection("personal@example.test")],
    });

    for (const candidate of [otherSource, lacksModel]) {
      expect(
        usageLimitRecovery(
          [failedRun(harnessUsageLimitFailureCode)],
          [spent, candidate],
          thread(),
          now,
        )?.alternative,
      ).toBeNull();
    }
  });

  it("names the profile when the Runner reported no account label", () => {
    const anonymous = placement({ observedConnections: [] });

    expect(
      usageLimitRecovery([failedRun(harnessUsageLimitFailureCode)], [anonymous], thread(), now)
        ?.accountLabel,
    ).toBe("Codex Work");
  });
});
