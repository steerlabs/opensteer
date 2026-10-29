import { ModelIdSchema, ModelProviderIdSchema } from "@opensteer/core";
import type { HarnessObservedConnection, HarnessObservedUsageScope } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  currentConnectionUsage,
  describeConnectionAccount,
  describeConnectionUsage,
} from "./connection-usage.js";

const now = new Date("2026-09-05T00:00:00.000Z").getTime();

function modelScope(providerId: string, modelId: string): HarnessObservedUsageScope {
  return {
    kind: "model",
    modelId: ModelIdSchema.parse(modelId),
    providerId: ModelProviderIdSchema.parse(providerId),
  };
}

function connection(overrides: Partial<HarnessObservedConnection> = {}): HarnessObservedConnection {
  return {
    accountLabel: "work@example.test",
    connectionSlot: "primary",
    label: "Codex",
    status: "connected",
    ...overrides,
  };
}

describe("connection usage", () => {
  it("describes the most constraining window with its reset", () => {
    const described = describeConnectionUsage(
      connection({
        usage: {
          limitReached: false,
          observedAt: "2026-09-05T00:00:00.000Z",
          windows: [
            { label: "5h", resetsAt: null, usedPercent: 12 },
            { label: "weekly", resetsAt: "2026-09-07T02:43:12.000Z", usedPercent: 38.6 },
          ],
        },
      }),
      now,
    );

    expect(described).toBe("Weekly 39% used · resets Mon 2:43 AM");
  });

  it("says a limit is reached instead of quoting a percentage", () => {
    const described = describeConnectionUsage(
      connection({
        usage: {
          limitReached: true,
          observedAt: "2026-09-05T00:00:00.000Z",
          windows: [{ label: "weekly", resetsAt: "2026-09-07T02:43:12.000Z", usedPercent: 100 }],
        },
      }),
      now,
    );

    expect(described).toBe("Limit reached · resets Mon 2:43 AM");
  });

  it("dates a reset that is further out than a weekday can name", () => {
    const described = describeConnectionUsage(
      connection({
        usage: {
          limitReached: false,
          observedAt: "2026-09-05T00:00:00.000Z",
          windows: [{ label: "30d", resetsAt: "2026-10-01T09:00:00.000Z", usedPercent: 4 }],
        },
      }),
      now,
    );

    expect(described).toBe("30d 4% used · resets Oct 1 9:00 AM");
  });

  it("reads unknown rather than zero when the Runner reported no usage", () => {
    expect(currentConnectionUsage(connection(), now)).toBeNull();
    expect(describeConnectionUsage(connection(), now)).toBeNull();
    expect(
      describeConnectionUsage(
        connection({
          usage: { limitReached: false, observedAt: "2026-09-05T00:00:00.000Z", windows: [] },
        }),
        now,
      ),
    ).toBeNull();
  });

  it("omits an unparseable reset rather than the whole line", () => {
    expect(
      describeConnectionUsage(
        connection({
          usage: {
            limitReached: false,
            observedAt: "2026-09-05T00:00:00.000Z",
            windows: [{ label: "weekly", resetsAt: "not-a-date", usedPercent: 20 }],
          },
        }),
        now,
      ),
    ).toBe("Weekly 20% used");
  });

  it("drops a window the clock has already carried past its reset", () => {
    const stale = connection({
      usage: {
        limitReached: false,
        observedAt: "2026-09-05T00:00:00.000Z",
        windows: [
          { label: "5h", resetsAt: "2026-09-05T04:00:00.000Z", usedPercent: 92 },
          { label: "weekly", resetsAt: "2026-09-09T00:00:00.000Z", usedPercent: 30 },
        ],
      },
    });

    expect(currentConnectionUsage(stale, now)?.constrainingWindow?.label).toBe("5h");
    expect(currentConnectionUsage(stale, now)?.windows).toHaveLength(2);
    // Four hours later the 5h window has handed its capacity back, so the
    // reading about it stops being knowledge and the weekly one takes over.
    const later = new Date("2026-09-05T05:00:00.000Z").getTime();
    expect(currentConnectionUsage(stale, later)?.constrainingWindow?.label).toBe("weekly");
    expect(describeConnectionUsage(stale, later)).toBe("Weekly 30% used · resets Wed 12:00 AM");
  });

  it("counts only the windows that could constrain the model in hand", () => {
    const metered = connection({
      usage: {
        limitReached: false,
        observedAt: "2026-09-05T00:00:00.000Z",
        windows: [
          { label: "5h", resetsAt: null, usedPercent: 10 },
          {
            label: "weekly",
            resetsAt: null,
            scope: modelScope("anthropic", "claude-opus-5"),
            usedPercent: 96,
          },
        ],
      },
    });

    // Working on the metered model, its own window is what is left.
    expect(
      describeConnectionUsage(metered, now, { modelId: "claude-opus-5", providerId: "anthropic" }),
    ).toBe("Weekly 96% used");
    // Working on anything else, that window describes capacity this work never
    // spends, so the account-wide reading stands alone.
    expect(
      describeConnectionUsage(metered, now, {
        modelId: "claude-sonnet-5",
        providerId: "anthropic",
      }),
    ).toBe("5h 10% used");
    // A reader with no model in hand is listing the account, not a route.
    expect(describeConnectionUsage(metered, now)).toBe("Weekly 96% used");
  });

  it("keeps an account-wide limit when every window is about another model", () => {
    const spentElsewhere = connection({
      usage: {
        limitReached: true,
        observedAt: "2026-09-05T00:00:00.000Z",
        windows: [
          {
            label: "weekly",
            resetsAt: "2026-09-09T00:00:00.000Z",
            scope: modelScope("anthropic", "claude-opus-5"),
            usedPercent: 100,
          },
        ],
      },
    });

    // Nothing remains to age the limit by, so the provider's word stands.
    expect(
      describeConnectionUsage(spentElsewhere, now, {
        modelId: "claude-sonnet-5",
        providerId: "anthropic",
      }),
    ).toBe("Limit reached");
    expect(
      describeConnectionUsage(spentElsewhere, now, {
        modelId: "claude-opus-5",
        providerId: "anthropic",
      }),
    ).toBe("Limit reached · resets Wed 12:00 AM");
  });

  it("treats an explicit account scope exactly as an absent one", () => {
    const wide = connection({
      usage: {
        limitReached: false,
        observedAt: "2026-09-05T00:00:00.000Z",
        windows: [{ label: "5h", resetsAt: null, scope: { kind: "account" }, usedPercent: 40 }],
      },
    });

    expect(describeConnectionUsage(wide, now, { modelId: "gpt-5.2", providerId: "openai" })).toBe(
      "5h 40% used",
    );
  });

  it("stops claiming a limit once every window it could describe has reset", () => {
    const spent = connection({
      usage: {
        limitReached: true,
        observedAt: "2026-09-05T00:00:00.000Z",
        windows: [{ label: "5h", resetsAt: "2026-09-05T04:00:00.000Z", usedPercent: 100 }],
      },
    });

    expect(currentConnectionUsage(spent, now)?.limitReached).toBe(true);
    expect(describeConnectionUsage(spent, now)).toBe("Limit reached · resets Sat 4:00 AM");
    const later = new Date("2026-09-05T04:00:00.000Z").getTime();
    expect(currentConnectionUsage(spent, later)).toBeNull();
    expect(describeConnectionUsage(spent, later)).toBeNull();
  });

  it("keeps a limit whose window never said when it comes back", () => {
    const spent = connection({
      usage: {
        limitReached: true,
        observedAt: "2026-09-05T00:00:00.000Z",
        windows: [{ label: "weekly", resetsAt: null, usedPercent: 100 }],
      },
    });

    expect(describeConnectionUsage(spent, now + 30 * 24 * 60 * 60 * 1_000)).toBe("Limit reached");
  });

  it("lets a limit stated without any window stand until the next inspection", () => {
    const capped = connection({
      usage: { limitReached: true, observedAt: "2026-09-05T00:00:00.000Z", windows: [] },
    });

    expect(describeConnectionUsage(capped, now)).toBe("Limit reached");
    expect(currentConnectionUsage(capped, now)?.constrainingWindow).toBeNull();
    // A reading with windows that have all reset is different: it said when
    // the capacity would come back, and that moment has passed.
    const reset = connection({
      usage: {
        limitReached: true,
        observedAt: "2026-09-05T00:00:00.000Z",
        windows: [{ label: "5h", resetsAt: "2026-09-04T23:00:00.000Z", usedPercent: 100 }],
      },
    });
    expect(describeConnectionUsage(reset, now)).toBeNull();
  });

  it("names the connected account and folds usage into one line", () => {
    expect(
      describeConnectionAccount(
        [
          connection({ status: "authentication-required", accountLabel: "stale@example.test" }),
          connection({
            usage: {
              limitReached: false,
              observedAt: "2026-09-05T00:00:00.000Z",
              windows: [{ label: "weekly", resetsAt: null, usedPercent: 39 }],
            },
          }),
        ],
        now,
      ),
    ).toBe("work@example.test · Weekly 39% used");
    expect(describeConnectionAccount([], now)).toBeNull();
    expect(
      describeConnectionAccount(
        [connection({ accountLabel: undefined, status: "unavailable" })],
        now,
      ),
    ).toBeNull();
  });
});
