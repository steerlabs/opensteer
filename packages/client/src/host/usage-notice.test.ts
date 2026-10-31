import { harnessUsageLimitFailureCode, ModelSelectionSchema } from "@opensteer/core";
import type { HarnessObservedConnection } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "./client.js";
import type { ThreadPlacementOption } from "./thread-placement.js";
import {
  createUsageNoticeDismissals,
  usageLimitNotice,
  usageLimitNoticeText,
  type UsageLimitNoticeInput,
} from "./usage-notice.js";

const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {},
  providerId: "openai",
});
const selection = { environmentId: "main", harnessInstanceId: "codex-work", modelSelection };
const scope = { deploymentId: "deployment-1", userId: "user-1" };
const now = new Date("2026-09-05T00:00:00.000Z").getTime();
// Local time, so the reset reads the same in every zone the suite runs in.
const weeklyReset = new Date(2026, 8, 7, 2, 43, 12).toISOString();

function placement(connections: readonly HarnessObservedConnection[]): ThreadPlacementOption {
  return {
    environmentId: "main",
    engineName: "Codex",
    harnessInstanceId: "codex-work",
    accountName: "Codex Work",
    observedConnections: connections,
  } as ThreadPlacementOption;
}

function connection(usage?: HarnessObservedConnection["usage"]): HarnessObservedConnection {
  return {
    accountLabel: "work@example.test",
    connectionSlot: "primary",
    label: "Codex",
    status: "connected",
    ...(usage ? { usage } : {}),
  };
}

const spent = placement([
  connection({
    limitReached: true,
    observedAt: "2026-09-04T23:00:00.000Z",
    windows: [{ label: "weekly", resetsAt: weeklyReset, usedPercent: 100 }],
  }),
]);

function run(status: "completed" | "failed", runId: string, code?: string): TranscriptEntry {
  return {
    createdAt: "2026-09-05T00:00:00.000Z",
    error: code ? { code, message: "You've hit your usage limit.", retryable: false } : null,
    id: `run:${runId}`,
    kind: "run",
    replyMessageId: null,
    runId,
    status,
  };
}

function notice(input: Partial<UsageLimitNoticeInput>) {
  return usageLimitNotice({ now, placements: [spent], scope, selection, ...input });
}

describe("usageLimitNotice", () => {
  it("says which engine is out and when it resets, without the account in the line", () => {
    const shown = notice({});
    expect(shown).toMatchObject({ accountTitle: "work@example.test", engineName: "Codex" });
    expect(usageLimitNoticeText(shown!)).toBe("Codex usage limit · Resets Mon 2:43 AM");
    // A Runner that reported no account label leaves the profile's own name.
    const anonymous = { ...spent, observedConnections: [] };
    const refused = [run("failed", "run-1", harnessUsageLimitFailureCode)];
    expect(notice({ entries: refused, placements: [anonymous] })?.accountTitle).toBe("Codex Work");
  });

  it("keys one quota episode for one person on one Deployment", () => {
    const key = notice({})!.key;
    expect(notice({ scope: { ...scope, userId: "user-2" } })!.key).not.toBe(key);
    expect(notice({ scope: { ...scope, deploymentId: "deployment-2" } })!.key).not.toBe(key);
    // The same window read again is the same episode; the next window is not.
    const reread = placement([
      connection({
        limitReached: true,
        observedAt: "2026-09-05T00:00:00.000Z",
        windows: [{ label: "weekly", resetsAt: weeklyReset, usedPercent: 100 }],
      }),
    ]);
    expect(notice({ placements: [reread] })!.key).toBe(key);
    const nextWeek = placement([
      connection({
        limitReached: true,
        observedAt: "2026-09-08T00:00:00.000Z",
        windows: [
          {
            label: "weekly",
            resetsAt: new Date(2026, 8, 14, 2, 43, 12).toISOString(),
            usedPercent: 100,
          },
        ],
      }),
    ]);
    expect(notice({ placements: [nextWeek] })!.key).not.toBe(key);
    const anotherLogin = {
      ...spent,
      observedConnections: spent.observedConnections.map((account) => ({
        ...account,
        accountLabel: "another@example.test",
      })),
    };
    expect(notice({ placements: [anotherLogin] })!.key).not.toBe(key);
  });

  it("lifts once the window resets, and stays silent for another account or model", () => {
    expect(notice({ now: new Date(weeklyReset).getTime() })).toBeNull();
    const failed = run("failed", "run-1", harnessUsageLimitFailureCode);
    expect(notice({ entries: [failed], now: new Date(weeklyReset).getTime() })).toBeNull();
    const resetTime = new Date(weeklyReset).getTime();
    const freshFailure = { ...failed, createdAt: new Date(resetTime + 1_000).toISOString() };
    expect(notice({ entries: [freshFailure], now: resetTime + 2_000 })?.key).toContain("run:run-1");
    const endedFailure = { ...failed, endedAt: new Date(resetTime - 1_000).toISOString() };
    const recovered = placement([
      connection({
        limitReached: false,
        observedAt: new Date(resetTime + 1_000).toISOString(),
        windows: [
          {
            label: "weekly",
            resetsAt: new Date(resetTime + 604_800_000).toISOString(),
            usedPercent: 1,
          },
        ],
      }),
    ]);
    expect(
      notice({ entries: [endedFailure], placements: [recovered], now: resetTime + 2_000 }),
    ).toBeNull();
    const staleHealthy = placement([
      connection({
        ...recovered.observedConnections[0]!.usage!,
        observedAt: new Date(resetTime - 2_000).toISOString(),
      }),
    ]);
    expect(
      notice({ entries: [endedFailure], placements: [staleHealthy], now: resetTime + 2_000 })?.key,
    ).toContain("run:run-1");
    const changed: TranscriptEntry = {
      kind: "selection",
      id: "selection-2",
      runId: null,
      createdAt: "2026-09-05T01:00:00.000Z",
      harnessInstanceId: "codex-work",
      modelSelection,
      providerSessionId: null,
    };
    expect(
      notice({ entries: [failed, changed], placements: [placement([connection()])] }),
    ).toBeNull();
    expect(notice({ selection: { ...selection, harnessInstanceId: "other" } })).toBeNull();
    expect(notice({ selection: null })).toBeNull();
    expect(notice({ placements: [placement([connection()])] })).toBeNull();
  });

  it("follows a Thread's latest Run refused for capacity, until a later Run", () => {
    const quiet = placement([connection()]);
    const refused = notice({
      entries: [run("failed", "run-1", harnessUsageLimitFailureCode)],
      placements: [quiet],
    });
    expect(refused?.key).toBe("deployment-1/user-1/main/codex-work/work@example.test/run:run-1");
    expect(refused && usageLimitNoticeText(refused)).toBe("Codex usage limit reached");
    for (const entries of [
      [run("failed", "run-1", "codex_harness_error")],
      [run("failed", "run-1", harnessUsageLimitFailureCode), run("completed", "run-2")],
      [],
    ])
      expect(notice({ entries, placements: [quiet] })).toBeNull();
    // The reading's episode wins, so dismissing before a refused send holds after it.
    expect(notice({ entries: [run("failed", "run-1", harnessUsageLimitFailureCode)] })!.key).toBe(
      notice({})!.key,
    );
  });
});

describe("createUsageNoticeDismissals", () => {
  it("hides nothing it cannot yet vouch for, then remembers dismissals in storage", async () => {
    let stored: readonly string[] = ["old"];
    let answer: (keys: readonly string[]) => void = () => undefined;
    const dismissals = createUsageNoticeDismissals({
      read: () => new Promise((resolve) => (answer = resolve)),
      write: (keys) => {
        stored = keys;
      },
    });
    let changes = 0;
    dismissals.subscribe(() => (changes += 1));
    expect(dismissals.getSnapshot()).toBeNull();
    answer(stored);
    await Promise.resolve();
    expect([...dismissals.getSnapshot()!]).toEqual(["old"]);
    dismissals.dismiss("episode");
    expect(dismissals.getSnapshot()!.has("episode")).toBe(true);
    expect(stored).toEqual(["old", "episode"]);
    expect(changes).toBe(2);
    const reopened = createUsageNoticeDismissals({ read: () => stored, write: () => undefined });
    expect(reopened.getSnapshot()!.has("episode")).toBe(true);
  });

  it("keeps a bounded history and survives storage that fails", () => {
    let stored: readonly string[] = [];
    const dismissals = createUsageNoticeDismissals({
      read: () => [],
      write: (keys) => {
        stored = keys;
      },
    });
    for (let index = 0; index < 40; index += 1) dismissals.dismiss(`episode-${index}`);
    expect(stored).toHaveLength(32);
    expect(stored.at(-1)).toBe("episode-39");

    const broken = createUsageNoticeDismissals({
      read: () => {
        throw new Error("unreadable");
      },
      write: () => {
        throw new Error("unwritable");
      },
    });
    broken.dismiss("episode");
    expect(broken.getSnapshot()!.has("episode")).toBe(true);
  });
});
