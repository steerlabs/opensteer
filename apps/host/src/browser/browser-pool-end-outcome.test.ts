// V4: the end step never throws a plain error. Every answer and every refusal an end request can
// meet is one of four outcomes, and what the step throws for them is the loop's unknown or its
// pending, both asked again later each time.
import type {
  BrowserPoolEndAnswer,
  BrowserPoolRuntimeFence,
  BrowserPoolRuntimeState,
} from "@opensteer/browser-runtime-core";
import { BrowserRuntimeError } from "@opensteer/browser-runtime-core";
import { expect, it } from "vitest";
import { browserPoolEndFailure, browserPoolEndOutcome } from "./browser-pool-coordinator.js";
import { BrowserPoolUnanswered } from "./browser-pool-controller.js";

const fence: BrowserPoolRuntimeFence = { slot: "slot", term: 1, instance: "i-1", epoch: 1 };
const other: BrowserPoolRuntimeFence = { ...fence, epoch: 2 };

function state(
  phase: BrowserPoolRuntimeState["phase"],
  at: BrowserPoolRuntimeFence | null = fence,
): BrowserPoolRuntimeState {
  return {
    fence: at,
    revision: 1,
    phase,
    intent: null,
    cancelled: false,
    retired: null,
    blockers: [],
  } as unknown as BrowserPoolRuntimeState;
}

const answers: readonly (readonly [string, BrowserPoolEndAnswer, string])[] = [
  ["ended by the running runtime", { outcome: "ended", state: state("running") }, "ended"],
  ["not yet from the running runtime", { outcome: "not-yet", state: state("running") }, "pending"],
  ["unknown from the running runtime", { outcome: "unknown", state: state("running") }, "pending"],
  ["ended under another fence", { outcome: "ended", state: state("running", other) }, "recover"],
  [
    "ended by a runtime with no fence",
    { outcome: "ended", state: state("running", null) },
    "recover",
  ],
  ["ended by a retiring runtime", { outcome: "ended", state: state("retiring") }, "recover"],
  ["not yet from an adopting runtime", { outcome: "not-yet", state: state("adopting") }, "recover"],
  [
    "not yet from an uninstalled runtime",
    { outcome: "not-yet", state: state("uninstalled") },
    "recover",
  ],
];

it.each(answers)("takes an answer %s as %s", async (_name, answer, expected) => {
  const outcome = await browserPoolEndOutcome({
    answer,
    refusal: undefined,
    fence,
    runtimeState: () => Promise.reject(new Error("An answer needs no read of the state.")),
  });
  expect(outcome).toBe(expected);
});

const relayRefused = Object.assign(new Error("parked"), { name: "PoolRelayRefused" });
const forbidden = new BrowserRuntimeError(
  "forbidden",
  "This ticket does not end a browser session.",
);
const refusals: readonly (readonly [
  string,
  unknown,
  () => Promise<BrowserPoolRuntimeState | null>,
  string,
])[] = [
  ["a relay that refused", relayRefused, () => Promise.reject(new Error("not read")), "unknown"],
  [
    "a call past its bound",
    new BrowserPoolUnanswered("The pooled runtime did not answer in time."),
    () => Promise.reject(new Error("not read")),
    "unknown",
  ],
  [
    "a network failure",
    Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
    () => Promise.reject(new Error("not read")),
    "unknown",
  ],
  ["a refusal by the running runtime", forbidden, async () => state("running"), "unknown"],
  [
    "a refusal by a runtime under another fence",
    forbidden,
    async () => state("running", other),
    "recover",
  ],
  [
    "a refusal by a runtime that is not running",
    forbidden,
    async () => state("retired"),
    "recover",
  ],
  ["a refusal by a runtime with no state", forbidden, async () => null, "recover"],
  [
    "a refusal whose state cannot be read",
    forbidden,
    () => Promise.reject(new Error("The runtime's state could not be read.")),
    "unknown",
  ],
  [
    "a plain error from the running runtime",
    new Error("boom"),
    async () => state("running"),
    "unknown",
  ],
];

it.each(refusals)("takes %s as %s", async (_name, refusal, runtimeState, expected) => {
  expect(await browserPoolEndOutcome({ answer: undefined, refusal, fence, runtimeState })).toBe(
    expected,
  );
});

it("throws only the loop's unknown or its pending, never a plain error", () => {
  expect(browserPoolEndFailure(0, undefined)).toBeUndefined();
  expect(browserPoolEndFailure(1, undefined)?.constructor.name).toBe("BrowserPoolPending");
  expect(browserPoolEndFailure(0, relayRefused)).toBe(relayRefused);
  expect(browserPoolEndFailure(2, relayRefused)).toBe(relayRefused);
  // A refusal the runtime gave is kept as the cause of the unknown it becomes.
  expect(browserPoolEndFailure(0, forbidden)).toBeInstanceOf(BrowserPoolUnanswered);
  expect((browserPoolEndFailure(0, forbidden) as Error).cause).toBe(forbidden);
  expect(browserPoolEndFailure(0, new Error("boom"))).toBeInstanceOf(BrowserPoolUnanswered);
  expect(browserPoolEndFailure(3, new Error("boom"))).toBeInstanceOf(BrowserPoolUnanswered);
});
