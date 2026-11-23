import { describe, expect, it } from "vitest";
import {
  after,
  afterSession,
  canTakeStart,
  firstFrameWaitMs,
  fits,
  frameVerdict,
  initialSessionCastState,
  initialTabCastState,
  nextStep,
  otherSizeWaitMs,
  pictureLimit,
  refusalReleased,
  sameCast,
  startFacts,
  wanted,
  type CastEvent,
  type CastFacts,
  type CastKey,
  type NavigationFact,
  type Refusal,
  type TabCastState,
  type TabFacts,
  type Told,
  type Trouble,
} from "./screencast-plan.js";

/*
 * The follow view's decision, over every combination of its small spaces: what is wanted, whether
 * a cast still fits it, whether the page can take a start, what a frame is, the one next step,
 * and the state each event leaves. Each step and each transition is checked against the facts
 * that may cause it, so one taken for any other reason fails here.
 */

const size = { height: 600, width: 800 };
const tab = (over: Partial<TabFacts> = {}): TabFacts => ({
  binding: "tab#1",
  capture: null,
  dialogOpen: false,
  document: "a",
  geometryRevision: 1,
  loading: false,
  native: false,
  navigation: null,
  size,
  sizesView: true,
  ...over,
});
const facts = (over: Partial<CastFacts> = {}, tabOver: Partial<TabFacts> = {}): CastFacts => ({
  captureRegions: false,
  closed: false,
  density: 2,
  streaming: true,
  tab: tab(tabOver),
  ...over,
});
const keyOf = (from: CastFacts): CastKey => {
  const want = wanted(from);
  if (want.kind !== "cast") throw new Error(`no cast is wanted: ${want.why}`);
  return want.key;
};
const refusal = (over: Partial<Refusal> = {}): Refusal => ({
  document: "a",
  finished: null,
  loading: false,
  pending: false,
  why: "x",
  ...over,
});

describe("what the follow view wants cast", () => {
  it("is nothing when closed, paused or without a tab, and holds what runs while the page cannot be pictured", () => {
    expect(wanted(facts({ closed: true })).kind).toBe("none");
    expect(wanted(facts({ streaming: false })).kind).toBe("none");
    expect(wanted({ ...facts(), tab: null }).kind).toBe("none");
    expect(wanted(facts({}, { dialogOpen: true }))).toEqual({
      kind: "hold",
      why: "a dialog is open",
    });
    expect(wanted(facts({}, { size: null })).kind).toBe("hold");
    expect(wanted(facts({}, { native: true, capture: null })).kind).toBe("hold");
    expect(
      wanted(
        facts(
          {},
          { native: true, capture: { height: 700, rasterScale: 1, revision: 1, width: 800 } },
        ),
      ).kind,
    ).toBe("hold");
  });

  it("casts the capture's region at the raster its density allows, or the page's size", () => {
    expect(keyOf(facts())).toMatchObject({
      captureRevision: null,
      expectedRaster: null,
      raster: { height: 1200, width: 1600 },
      region: size,
    });
    const capture = { height: 500, rasterScale: 1, revision: 3, width: 700 };
    expect(keyOf(facts({ density: 2 }, { capture, native: true }))).toMatchObject({
      captureRevision: 3,
      expectedRaster: { height: 500, width: 700 },
      raster: { height: 500, width: 700 },
      region: { height: 500, width: 700 },
    });
  });
});

describe("whether a cast still fits what is wanted", () => {
  const base = facts();
  const told = keyOf(base);
  const variants: Array<[string, CastFacts, "same" | "new-document" | false]> = [
    ["the same facts", base, "same"],
    ["another size", facts({}, { size: { height: 600, width: 900 } }), false],
    ["another density", facts({ density: 1 }), false],
    ["new metrics at the same size", facts({}, { geometryRevision: 2 }), false],
    [
      "a new document at the same size",
      facts({}, { document: "b", geometryRevision: 2 }),
      "new-document",
    ],
    [
      "a new document at another size",
      facts({}, { document: "b", geometryRevision: 2, size: { height: 700, width: 800 } }),
      false,
    ],
    ["a page now sized another way", facts({}, { sizesView: false }), false],
    ["regions now shown with their own header", facts({ captureRegions: true }), false],
  ];
  for (const [name, now, expected] of variants)
    it(`is ${String(expected)} for ${name}`, () => expect(fits(told, keyOf(now))).toBe(expected));

  it("is false for another capture revision, the region the same", () => {
    const capture = { height: 600, rasterScale: 1, revision: 1, width: 800 };
    const before = keyOf(facts({}, { capture, native: true }));
    expect(
      fits(before, keyOf(facts({}, { capture: { ...capture, revision: 2 }, native: true }))),
    ).toBe(false);
  });

  it("is the same cast for one given up while only the metrics revision moved, not when the document did", () => {
    expect(sameCast(told, keyOf(facts({}, { geometryRevision: 5 })))).toBe(true);
    expect(sameCast(told, keyOf(facts({}, { document: "b", geometryRevision: 5 })))).toBe(false);
    expect(sameCast(told, keyOf(facts({}, { size: { height: 700, width: 800 } })))).toBe(false);
  });
});

describe("whether the page can take a start", () => {
  const navigations: Array<NavigationFact | null> = [null];
  for (const finished of [0, 1, 2])
    for (const pending of [false, true])
      for (const blankDocument of [false, true])
        navigations.push({ blankDocument, finished, pending });
  const refusals: Array<Refusal | null> = [null];
  for (const finished of [null, 0, 1])
    for (const loading of [false, true])
      for (const pending of [false, true])
        for (const document of ["a", "b"])
          refusals.push(refusal({ document, finished, loading, pending }));

  it("refuses exactly while the first document is to commit, or until a fact a refusal recorded differs", () => {
    let cases = 0;
    for (const navigation of navigations)
      for (const recorded of refusals)
        for (const loading of [false, true])
          for (const document of ["a", "b"]) {
            cases += 1;
            const now = tab({ document, loading, navigation });
            const gate = navigation?.pending === true && navigation.blankDocument;
            // S5: released as soon as any fact it recorded differs, loading either way.
            const released =
              recorded === null ||
              (navigation?.finished ?? null) !== recorded.finished ||
              (navigation?.pending ?? false) !== recorded.pending ||
              loading !== recorded.loading ||
              document !== recorded.document;
            if (recorded) expect(refusalReleased(now, recorded)).toBe(released);
            const result = canTakeStart(now, recorded);
            expect(result.ok, JSON.stringify({ document, loading, navigation, recorded })).toBe(
              !gate && released,
            );
            if (!result.ok) expect(result.why.length).toBeGreaterThan(0);
          }
    expect(cases).toBe(navigations.length * refusals.length * 4);
  });

  // Re-check 10, finding 6 (S5): on Linux a start refused before the page said it loads, then a
  // load that began and ended on the same document, never let the refusal go.
  it("releases a refusal sent before loading began as loading begins, and one sent while it loaded as it ends", () => {
    expect(refusalReleased(tab({ loading: true }), refusal({ loading: false }))).toBe(true);
    expect(refusalReleased(tab({ loading: false }), refusal({ loading: true }))).toBe(true);
  });

  it("keeps a refusal with nothing pending, nothing loading and no navigation until the document changes", () => {
    const recorded = refusal();
    expect(refusalReleased(tab(), recorded)).toBe(false);
    expect(refusalReleased(tab({ geometryRevision: 9 }), recorded)).toBe(false);
    expect(refusalReleased(tab({ document: "b" }), recorded)).toBe(true);
  });
});

const native = facts(
  {},
  {
    capture: { height: 600, rasterScale: 2, revision: 1, width: 800 },
    native: true,
    sizesView: false,
  },
);
const base = facts();
const key = keyOf(base);
const otherKey = keyOf(facts({}, { size: { height: 700, width: 900 } }));
const tolds: Told[] = [
  { state: "none" },
  { state: "preparing" },
  { at: startFacts(base.tab!), key, state: "sent" },
  { key, state: "running" },
  { key: otherKey, state: "running" },
];
const wants: Array<[string, CastFacts]> = [
  ["cast", base],
  ["paused", facts({ streaming: false })],
  ["closed", facts({ closed: true })],
  ["dialog", facts({}, { dialogOpen: true })],
  [
    "first document pending",
    facts({}, { navigation: { blankDocument: true, finished: 0, pending: true } }),
  ],
  ["native", native],
];
const states: TabCastState[] = [];
const troubles: Array<Trouble | null> = [null, "other-size", "no-picture", "set-aside", "misfit"];
for (const told of tolds)
  for (const shown of [false, true])
    for (const trouble of troubles)
      for (const redraw of [false, true])
        // A retry and a change are one to the next step: both wait for the page to be drawn.
        for (const repairing of [null, "retry"] as const)
          for (const unpictured of [0, 1, 2, 3])
            for (const paint of [null, { captureRevision: null, geometryRevision: 1, size }])
              for (const recorded of [null, refusal()])
                for (const failed of [null, { key, why: "no picture arrived" }])
                  states.push({
                    ...initialTabCastState(),
                    failed,
                    paint,
                    redraw,
                    refusal: recorded,
                    repairing,
                    shown,
                    told,
                    trouble,
                    unpictured,
                  });

describe("the next step", () => {
  it("binds the tab in view first, and is idle with nothing bound", () => {
    expect(nextStep(base, null, null)).toEqual({ kind: "bind" });
    expect(nextStep(base, "other#1", initialTabCastState())).toEqual({ kind: "bind" });
    expect(nextStep(facts({ closed: true }), "tab#1", initialTabCastState())).toEqual({
      kind: "bind",
    });
    expect(nextStep({ ...base, tab: null }, null, null)).toEqual({ kind: "idle" });
  });

  it("takes each step only when the facts call for it", () => {
    let cases = 0;
    for (const [name, now] of wants)
      for (const state of states) {
        cases += 1;
        const step = nextStep(now, now.closed ? null : "tab#1", now.closed ? null : state);
        const at = JSON.stringify({ name, state, step });
        const want = wanted(now);
        const told = state.told;
        const fit =
          told.state === "running" && want.kind === "cast" ? fits(told.key, want.key) : null;
        const limit = pictureLimit(now.tab!.native);
        switch (step.kind) {
          case "bind":
          case "idle":
            if (want.kind === "cast")
              expect(
                told.state === "running" && fit === "same" && state.shown && !state.redraw,
                at,
              ).toBe(true);
            if (want.kind === "none") expect(told.state === "none" || now.closed, at).toBe(true);
            break;
          case "stop":
            expect(want.kind === "none" && told.state !== "none", at).toBe(true);
            break;
          case "start": {
            expect(want.kind === "cast" && told.state === "none" && !state.repairing, at).toBe(
              true,
            );
            expect(canTakeStart(now.tab!, state.refusal).ok, at).toBe(true);
            if (want.kind === "cast" && state.failed)
              expect(sameCast(state.failed.key, want.key), at).toBe(false);
            // A paint wait holds only the picture it timed out for.
            expect(
              state.paint === null ||
                want.kind !== "cast" ||
                state.paint.geometryRevision !== want.key.geometryRevision ||
                state.paint.captureRevision !== want.key.captureRevision,
              at,
            ).toBe(true);
            break;
          }
          case "restart":
            // A restart for another cast is a change; one for a frame set aside, a retry.
            expect(told.state === "running", at).toBe(true);
            if (step.retry)
              expect(
                fit === "same" && state.trouble === "set-aside" && state.unpictured < limit,
                at,
              ).toBe(true);
            else expect(fit, at).toBe(false);
            break;
          case "restamp":
            expect(fit, at).toBe("new-document");
            break;
          case "repair":
            expect(told.state === "running" && fit === "same", at).toBe(true);
            // A repair a closed tab asked for is a change; one for a frame that did not fit, or
            // for no picture in its time, a retry.
            if (step.retry)
              expect(
                !state.redraw &&
                  (state.trouble === "misfit" || state.trouble === "no-picture") &&
                  state.unpictured < limit,
                at,
              ).toBe(true);
            else expect(state.redraw, at).toBe(true);
            break;
          case "fail":
            expect(told.state === "running" && fit === "same" && !state.shown, at).toBe(true);
            expect(["misfit", "set-aside", "no-picture"], at).toContain(state.trouble);
            expect(state.unpictured >= limit, at).toBe(true);
            // It says what came of the cast: no picture, when none came in its time.
            if (state.trouble === "no-picture") expect(step.why, at).toBe("no picture arrived");
            break;
          case "wait":
            // A wait is for a named fact, or the plan gives it a time: a running cast waiting for
            // its first frame, or its own after one of another size, always has one (R10).
            expect(step.why.length, at).toBeGreaterThan(0);
            if (step.why === "its first frame") {
              expect(state.trouble === null && !state.redraw && !state.shown, at).toBe(true);
              expect(step.timer, at).toBe(firstFrameWaitMs * 2 ** Math.min(state.unpictured, 2));
            } else if (step.why === "its own frame, after one of another size") {
              expect(state.trouble, at).toBe("other-size");
              expect(step.timer, at).toBe(otherSizeWaitMs);
            } else expect(step.timer, at).toBeUndefined();
            if (want.kind === "none") throw new Error(`waits while nothing is wanted: ${at}`);
            break;
        }
      }
    expect(cases).toBe(wants.length * states.length);
  });

  it("sends no start while one is prepared or with Chromium, or while the session's stop is", () => {
    const stopping = { generation: 0, stops: 1 };
    for (const [, now] of wants)
      for (const state of states) {
        expect(nextStep(now, "tab#1", state, stopping).kind).not.toMatch(
          /^(start|restart|repair)$/u,
        );
        if (["preparing", "sent"].includes(state.told.state) || state.repairing)
          expect(nextStep(now, "tab#1", state).kind).not.toMatch(/^(start|restart|repair)$/u);
      }
  });

  it("reaches the bound for frames set aside, and gives up then (finding 1)", () => {
    const running: TabCastState = {
      ...initialTabCastState(),
      lastKey: key,
      told: { key, state: "running" },
    };
    let state: TabCastState = { ...running, trouble: "set-aside" };
    const seen: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const step = nextStep(base, "tab#1", state);
      seen.push(step.kind);
      if (step.kind === "fail") break;
      expect(step.kind).toBe("restart");
      // The restart, its start for the same cast, its answer, and its frame set aside again.
      state = after(state, { kind: "stopped", retry: true }, base);
      state = after(state, { at: startFacts(base.tab!), key, kind: "sent" }, base);
      state = after(state, { kind: "answered" }, base);
      state = after(state, { kind: "frame", verdict: "set-aside" }, base);
    }
    expect(seen).toEqual(["restart", "restart", "restart", "fail"]);
  });
});

describe("what a frame is", () => {
  const measured = (geometry = size, raster = { height: 1200, width: 1600 }) => ({
    document: "a",
    geometry,
    raster,
  });
  const sent: TabCastState = {
    ...initialTabCastState(),
    told: { at: startFacts(base.tab!), key, state: "sent" },
  };
  const none = initialSessionCastState;
  const running: TabCastState = { ...initialTabCastState(), told: { key, state: "running" } };

  it("is held with its start when it pictures what the start asked for, and of another size otherwise", () => {
    expect(frameVerdict(sent, none, measured(), base)).toBe("held");
    expect(frameVerdict(sent, none, measured({ height: 650, width: 900 }), base)).toBe(
      "misfit-with-start",
    );
    const sentNative: TabCastState = {
      ...sent,
      told: { at: startFacts(native.tab!), key: keyOf(native), state: "sent" },
    };
    expect(frameVerdict(sentNative, none, measured({ height: 650, width: 900 }), native)).toBe(
      "other-size-with-start",
    );
  });

  it("is shown, set aside, a misfit or dropped once its cast runs", () => {
    expect(frameVerdict(running, none, measured(), base)).toBe("show");
    expect(frameVerdict(running, none, measured(), facts({}, { dialogOpen: true }))).toBe(
      "set-aside",
    );
    expect(frameVerdict(running, none, measured(), facts({ density: 1 }))).toBe("set-aside");
    expect(frameVerdict(running, none, measured({ height: 650, width: 900 }), base)).toBe("misfit");
    expect(frameVerdict(running, none, measured(size, { height: 600, width: 1600 }), base)).toBe(
      "misfit",
    );
    expect(frameVerdict({ ...running, told: { state: "none" } }, none, measured(), base)).toBe(
      "dropped",
    );
  });

  // Re-check 10, S1 and S6: whether a frame is no one's is the plan's to say, from the session's
  // stops and whether anything is streamed.
  it("is dropped on a session whose stop is with Chromium, and while nothing is streamed", () => {
    const stopping = { generation: 0, stops: 1 };
    for (const state of [sent, running])
      for (const now of [base, facts({ streaming: false })])
        expect(frameVerdict(state, stopping, measured(), now)).toBe("dropped");
    expect(frameVerdict(sent, none, measured(), facts({ streaming: false }))).toBe("dropped");
    expect(
      frameVerdict(sent, none, measured({ height: 650, width: 900 }), facts({ streaming: false })),
    ).toBe("dropped");
  });

  it("is the old document's when it came before the follow view saw the new one, and the new one's after", () => {
    const committed = facts({}, { document: "b", geometryRevision: 2 });
    expect(frameVerdict(running, none, { ...measured(), document: "a" }, committed)).toBe(
      "dropped",
    );
    expect(frameVerdict(running, none, { ...measured(), document: "b" }, committed)).toBe(
      "restamp-show",
    );
  });
});

describe("the state after each event", () => {
  const events: CastEvent[] = [
    { kind: "observed" },
    { kind: "start-begun" },
    { at: startFacts(base.tab!), key, kind: "sent" },
    { at: startFacts(base.tab!), key: otherKey, kind: "sent" },
    { kind: "answered" },
    { kind: "start-failed", why: "x" },
    { kind: "not-sent" },
    { kind: "paint-timed-out" },
    { kind: "paint-backoff-ended" },
    { kind: "stopped", retry: false },
    { kind: "stopped", retry: true },
    { givenUp: "no picture arrived", kind: "stopped", retry: false },
    { kind: "repair-begun", retry: true },
    { kind: "repair-begun", retry: false },
    { kind: "repair-drawn" },
    { kind: "stop-timed-out" },
    { kind: "casts-ended" },
    { kind: "frame", verdict: "show" },
    { kind: "frame", verdict: "set-aside" },
    { kind: "frame", verdict: "misfit" },
    { kind: "frame", verdict: "other-size-with-start" },
    { kind: "first-frame-timeout" },
    { kind: "resumed" },
    { kind: "tab-closed-beside" },
    { document: "b", geometryRevision: 2, kind: "restamped" },
  ];

  it("changes what was told only as each event says", () => {
    let cases = 0;
    for (const [name, now] of wants)
      for (const state of states.filter((_, index) => index % 7 === 0))
        for (const event of events) {
          cases += 1;
          const next = after(state, event, now);
          const at = JSON.stringify({ event, name, state: state.told.state });
          const told = state.told.state;
          const changed = next.told.state !== told;
          if (!changed) continue;
          const to = next.told.state;
          const allowed: Record<string, readonly string[]> = {
            answered: told === "sent" ? ["running"] : [],
            "casts-ended": ["none"],
            "not-sent": told === "preparing" ? ["none"] : [],
            "paint-timed-out": told === "preparing" ? ["none"] : [],
            "repair-begun": ["none"],
            sent: ["sent"],
            "start-begun": ["preparing"],
            "start-failed": told === "preparing" || told === "sent" ? ["none"] : [],
            stopped: ["none"],
          };
          expect(allowed[event.kind] ?? [], at).toContain(to);
        }
    expect(cases).toBeGreaterThan(10_000);
  });

  it("counts every retry with no picture, a repair once it is drawn, and counts afresh for another cast or a resume", () => {
    const running: TabCastState = {
      ...initialTabCastState(),
      lastKey: key,
      told: { key, state: "running" },
    };
    expect(after(running, { kind: "stopped", retry: true }, base).unpictured).toBe(1);
    expect(after(running, { kind: "stopped", retry: false }, base).unpictured).toBe(0);
    expect(
      after({ ...running, shown: true }, { kind: "stopped", retry: true }, base).unpictured,
    ).toBe(0);
    // R10: a repair counts once the page is drawn again, not as it is asked for; R2: one a closed
    // tab asked for is a change and never counts.
    const retried = after(running, { kind: "repair-begun", retry: true }, base);
    expect(retried.unpictured).toBe(0);
    expect(after(retried, { kind: "repair-drawn" }, base).unpictured).toBe(1);
    const changed = after(running, { kind: "repair-begun", retry: false }, base);
    expect(after(changed, { kind: "repair-drawn" }, base).unpictured).toBe(0);
    const counted = { ...running, unpictured: 2 };
    const at = startFacts(base.tab!);
    expect(after(counted, { at, key, kind: "sent" }, base).unpictured).toBe(2);
    expect(after(counted, { at, key: otherKey, kind: "sent" }, base).unpictured).toBe(0);
    expect(after(counted, { kind: "resumed" }, base).unpictured).toBe(0);
  });

  it("tries a cast given up again, counted afresh, when its size, capture, raster or document changes", () => {
    const failed: TabCastState = {
      ...initialTabCastState(),
      failed: { key, why: "no picture arrived" },
      unpictured: 3,
    };
    expect(
      after(failed, { kind: "observed" }, facts({}, { geometryRevision: 9 })).failed?.key,
    ).toBe(key);
    const navigated = after(
      failed,
      { kind: "observed" },
      facts({}, { document: "b", geometryRevision: 2 }),
    );
    expect(navigated).toMatchObject({ failed: null, unpictured: 0 });
  });

  it("gives a running cast's first picture its time only while the plan still gives one (R10)", () => {
    const running: TabCastState = {
      ...initialTabCastState(),
      lastKey: key,
      told: { key, state: "running" },
    };
    const otherSize: TabCastState = { ...running, trouble: "other-size" };
    for (const awaiting of [running, otherSize]) {
      expect(after(awaiting, { kind: "first-frame-timeout" }, base).trouble).toBe("no-picture");
      // Not under a hold, not once pictured, not for a pause.
      expect(
        after(awaiting, { kind: "first-frame-timeout" }, facts({}, { dialogOpen: true })),
      ).toBe(awaiting);
      expect(after(awaiting, { kind: "first-frame-timeout" }, facts({ streaming: false }))).toBe(
        awaiting,
      );
      const shown = { ...awaiting, shown: true };
      expect(after(shown, { kind: "first-frame-timeout" }, base)).toBe(shown);
    }
    // Not while its document loads, which sends its first frame as it paints: the start's own
    // frame after one of another size is given its time all the same, as before.
    expect(after(running, { kind: "first-frame-timeout" }, facts({}, { loading: true }))).toBe(
      running,
    );
    // Three seconds, then six, then twelve as it is retried; given up at the bound, saying so.
    const steps = [0, 1, 2, 3].map((unpictured) =>
      nextStep(base, "tab#1", { ...running, unpictured }),
    );
    expect(steps.slice(0, 3).map((step) => (step.kind === "wait" ? step.timer : null))).toEqual([
      3_000, 6_000, 12_000,
    ]);
    expect(nextStep(base, "tab#1", { ...running, trouble: "no-picture", unpictured: 3 })).toEqual({
      kind: "fail",
      why: "no picture arrived",
    });
    expect(nextStep(base, "tab#1", { ...running, trouble: "no-picture" })).toEqual({
      kind: "repair",
      retry: true,
      why: "no picture arrived",
    });
  });

  it("finds a session's stop still with Chromium when the tab is bound again", () => {
    expect(nextStep(base, "tab#1", initialTabCastState(), { generation: 0, stops: 1 })).toEqual({
      kind: "wait",
      why: "a stop is with Chromium",
    });
  });

  // Re-check 10, S2 (finding 2): a start that failed before it reached Chromium is no refusal.
  it("counts a start that failed before it was sent as an attempt, and gives up at the bound", () => {
    const preparing: TabCastState = { ...initialTabCastState(), told: { state: "preparing" } };
    let state = preparing;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      state = after(state, { kind: "start-failed", why: "Electron browser page is closed." }, base);
      expect(state).toMatchObject({ refusal: null, told: { state: "none" }, unpictured: attempt });
      if (attempt < 3) {
        expect(state.failed).toBeNull();
        expect(nextStep(base, "tab#1", state).kind).toBe("start");
        state = after(state, { kind: "start-begun" }, base);
      }
    }
    expect(state.failed?.why).toBe(
      "its start could not be made (Electron browser page is closed.)",
    );
    expect(nextStep(base, "tab#1", state).kind).toBe("wait");
    // A start Chromium refused is a refusal, of the facts when it was sent.
    const sentAt = startFacts(tab({ loading: true }));
    const sent: TabCastState = {
      ...initialTabCastState(),
      told: { at: sentAt, key, state: "sent" },
    };
    expect(after(sent, { kind: "start-failed", why: "no" }, base)).toMatchObject({
      refusal: { ...sentAt, why: "no" },
      unpictured: 0,
    });
  });

  // Re-check 10, S6: a cast at its bound is given up, even when a closed tab asks for a repair.
  it("gives up a cast at its bound before a repair a closed tab asks for", () => {
    const running: TabCastState = {
      ...initialTabCastState(),
      lastKey: key,
      redraw: true,
      told: { key, state: "running" },
      trouble: "misfit",
      unpictured: 3,
    };
    expect(nextStep(base, "tab#1", running).kind).toBe("fail");
    expect(nextStep(base, "tab#1", { ...running, unpictured: 2 })).toEqual({
      kind: "repair",
      retry: false,
      why: "a tab closed",
    });
  });

  // Re-check 10, S1 and S3: the session's stops, written by one pure function.
  it("settles a session's stops when the engine ends its casts or a stop's time is up, and ignores a late answer", () => {
    let session = initialSessionCastState;
    session = afterSession(session, { kind: "stop-sent" });
    session = afterSession(session, { kind: "stop-sent" });
    expect(session).toEqual({ generation: 0, stops: 2 });
    expect(afterSession(session, { generation: 0, kind: "stop-answered" }).stops).toBe(1);
    const ended = afterSession(session, { kind: "casts-ended" });
    expect(ended).toEqual({ generation: 1, stops: 0 });
    // The ended generation's answers change nothing, and never go below none.
    expect(afterSession(ended, { generation: 0, kind: "stop-answered" })).toBe(ended);
    const timedOut = afterSession(session, { generation: 0, kind: "stop-timed-out" });
    expect(timedOut).toEqual({ generation: 1, stops: 0 });
    expect(afterSession(timedOut, { generation: 0, kind: "stop-timed-out" })).toBe(timedOut);
    const again = afterSession(timedOut, { kind: "stop-sent" });
    expect(afterSession(again, { generation: 0, kind: "stop-answered" })).toBe(again);
    // The tab's next start after a stop given up on counts as an attempt.
    expect(after(initialTabCastState(), { kind: "stop-timed-out" }, base).unpictured).toBe(1);
  });
});
