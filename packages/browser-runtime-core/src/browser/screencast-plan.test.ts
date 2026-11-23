import { describe, expect, it } from "vitest";
import {
  after,
  canTakeStart,
  fits,
  frameVerdict,
  initialTabCastState,
  nextStep,
  pictureLimit,
  refusalReleased,
  sameCast,
  wanted,
  type CastEvent,
  type CastFacts,
  type CastKey,
  type NavigationFact,
  type Refusal,
  type TabCastState,
  type TabFacts,
  type Told,
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

  it("refuses exactly while the first document is to commit, or until a fact a refusal recorded settles", () => {
    let cases = 0;
    for (const navigation of navigations)
      for (const recorded of refusals)
        for (const loading of [false, true])
          for (const document of ["a", "b"]) {
            cases += 1;
            const now = tab({ document, loading, navigation });
            const gate = navigation?.pending === true && navigation.blankDocument;
            const released =
              recorded === null ||
              (navigation !== null && navigation.finished > (recorded.finished ?? -1)) ||
              (recorded.pending && navigation?.pending !== true) ||
              (recorded.loading && !loading) ||
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
  { key, state: "sent" },
  { key, state: "running" },
  { key: otherKey, state: "running" },
  { state: "stopping" },
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
for (const told of tolds)
  for (const shown of [false, true])
    for (const setAside of [false, true])
      for (const misfit of [false, true])
        for (const redraw of [false, true])
          for (const repairing of [false, true])
            for (const otherSize of [false, true])
              for (const unpictured of [0, 1, 3])
                for (const paint of [null, { captureRevision: null, geometryRevision: 1, size }])
                  for (const recorded of [null, refusal()])
                    for (const failedFor of [null, key])
                      states.push({
                        ...initialTabCastState(false),
                        failedFor,
                        misfit,
                        otherSize,
                        paint,
                        redraw,
                        refusal: recorded,
                        repairing,
                        setAside,
                        shown,
                        told,
                        unpictured,
                      });

describe("the next step", () => {
  it("binds the tab in view first, and is idle with nothing bound", () => {
    expect(nextStep(base, null, null)).toEqual({ kind: "bind" });
    expect(nextStep(base, "other#1", initialTabCastState(false))).toEqual({ kind: "bind" });
    expect(nextStep(facts({ closed: true }), "tab#1", initialTabCastState(false))).toEqual({
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
            if (want.kind === "none")
              expect(told.state === "none" || told.state === "stopping" || now.closed, at).toBe(
                true,
              );
            break;
          case "stop":
            expect(
              want.kind === "none" && told.state !== "none" && told.state !== "stopping",
              at,
            ).toBe(true);
            break;
          case "start": {
            expect(want.kind === "cast" && told.state === "none" && !state.repairing, at).toBe(
              true,
            );
            expect(canTakeStart(now.tab!, state.refusal).ok, at).toBe(true);
            if (want.kind === "cast" && state.failedFor)
              expect(sameCast(state.failedFor, want.key), at).toBe(false);
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
            expect(
              told.state === "running" &&
                (fit === false || (state.setAside && state.unpictured < limit)),
              at,
            ).toBe(true);
            break;
          case "restamp":
            expect(fit, at).toBe("new-document");
            break;
          case "repair":
            expect(told.state === "running" && fit === "same", at).toBe(true);
            expect(state.redraw || (state.misfit && state.unpictured < limit), at).toBe(true);
            break;
          case "fail":
            expect(told.state === "running" && fit === "same" && !state.shown, at).toBe(true);
            expect(state.misfit || state.setAside, at).toBe(true);
            expect(state.unpictured >= limit, at).toBe(true);
            break;
          case "wait":
            // A wait is for a named fact; a running cast whose frame was set aside or did not fit
            // never waits for its first frame.
            expect(step.why.length, at).toBeGreaterThan(0);
            if (step.why === "its first frame")
              expect(
                !state.setAside && !state.misfit && !state.redraw && !state.otherSize,
                at,
              ).toBe(true);
            if (want.kind === "none") throw new Error(`waits while nothing is wanted: ${at}`);
            break;
        }
      }
    expect(cases).toBe(wants.length * states.length);
  });

  it("sends no start while one is prepared or with Chromium, or while the session's stop is", () => {
    for (const [, now] of wants)
      for (const state of states)
        if (["preparing", "sent", "stopping"].includes(state.told.state) || state.repairing)
          expect(nextStep(now, "tab#1", state).kind).not.toMatch(/^(start|restart|repair)$/u);
  });

  it("reaches the bound for frames set aside, and gives up then (finding 1)", () => {
    const running: TabCastState = {
      ...initialTabCastState(false),
      lastKey: key,
      told: { key, state: "running" },
    };
    let state: TabCastState = { ...running, setAside: true };
    const seen: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const step = nextStep(base, "tab#1", state);
      seen.push(step.kind);
      if (step.kind === "fail") break;
      expect(step.kind).toBe("restart");
      // The restart, its start for the same cast, its answer, and its frame set aside again.
      state = after(state, { kind: "stopped", restart: true }, base);
      state = after(state, { kind: "stop-answered", remaining: 0 }, base);
      state = after(state, { key, kind: "sent" }, base);
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
  const sent: TabCastState = { ...initialTabCastState(false), told: { key, state: "sent" } };
  const running: TabCastState = { ...initialTabCastState(false), told: { key, state: "running" } };

  it("is held with its start when it pictures what the start asked for, and of another size otherwise", () => {
    expect(frameVerdict(sent, measured(), base)).toBe("held");
    expect(frameVerdict(sent, measured({ height: 650, width: 900 }), base)).toBe(
      "misfit-with-start",
    );
    const sentNative: TabCastState = {
      ...sent,
      told: { key: keyOf(native), state: "sent" },
    };
    expect(frameVerdict(sentNative, measured({ height: 650, width: 900 }), native)).toBe(
      "other-size-with-start",
    );
  });

  it("is shown, set aside, a misfit or dropped once its cast runs", () => {
    expect(frameVerdict(running, measured(), base)).toBe("show");
    expect(frameVerdict(running, measured(), facts({}, { dialogOpen: true }))).toBe("set-aside");
    expect(frameVerdict(running, measured(), facts({ density: 1 }))).toBe("set-aside");
    expect(frameVerdict(running, measured({ height: 650, width: 900 }), base)).toBe("misfit");
    expect(frameVerdict(running, measured(size, { height: 600, width: 1600 }), base)).toBe(
      "misfit",
    );
    expect(frameVerdict({ ...running, told: { state: "stopping" } }, measured(), base)).toBe(
      "dropped",
    );
  });

  it("is the old document's when it came before the follow view saw the new one, and the new one's after", () => {
    const committed = facts({}, { document: "b", geometryRevision: 2 });
    expect(frameVerdict(running, { ...measured(), document: "a" }, committed)).toBe("dropped");
    expect(frameVerdict(running, { ...measured(), document: "b" }, committed)).toBe("restamp-show");
  });
});

describe("the state after each event", () => {
  const events: CastEvent[] = [
    { kind: "observed" },
    { kind: "start-begun" },
    { key, kind: "sent" },
    { key: otherKey, kind: "sent" },
    { kind: "answered" },
    { kind: "refused", refusal: refusal() },
    { kind: "not-sent" },
    { kind: "paint-timed-out", paint: { captureRevision: null, geometryRevision: 1, size } },
    { kind: "paint-backoff-ended" },
    { kind: "stopped", restart: false },
    { kind: "stopped", restart: true },
    { failedFor: key, kind: "stopped", restart: false },
    { byFrame: true, kind: "repair-begun" },
    { byFrame: false, kind: "repair-begun" },
    { kind: "repair-drawn" },
    { kind: "stop-answered", remaining: 0 },
    { kind: "stop-answered", remaining: 1 },
    { kind: "casts-ended" },
    { kind: "frame", verdict: "show" },
    { kind: "frame", verdict: "set-aside" },
    { kind: "frame", verdict: "misfit" },
    { kind: "frame", verdict: "other-size-with-start" },
    { kind: "own-frame-timer" },
    { kind: "resumed" },
    { kind: "tab-closed-beside", native: false },
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
            refused: ["none"],
            "repair-begun": ["stopping", "none"],
            sent: ["sent"],
            "start-begun": ["preparing"],
            "stop-answered": told === "stopping" ? ["none"] : [],
            stopped: ["stopping", "none"],
          };
          expect(allowed[event.kind] ?? [], at).toContain(to);
          // A stop leaves a sent or running cast stopping, never nothing: its frames are dropped
          // until the stop's answer.
          if (event.kind === "stopped" && (told === "sent" || told === "running"))
            expect(to, at).toBe("stopping");
        }
    expect(cases).toBeGreaterThan(10_000);
  });

  it("counts every restart and frame-caused repair with no picture, and counts afresh for another cast or a resume", () => {
    const running: TabCastState = {
      ...initialTabCastState(false),
      lastKey: key,
      told: { key, state: "running" },
    };
    expect(after(running, { kind: "stopped", restart: true }, base).unpictured).toBe(1);
    expect(
      after({ ...running, shown: true }, { kind: "stopped", restart: true }, base).unpictured,
    ).toBe(0);
    expect(after(running, { byFrame: true, kind: "repair-begun" }, base).unpictured).toBe(1);
    expect(after(running, { byFrame: false, kind: "repair-begun" }, base).unpictured).toBe(0);
    const counted = { ...running, unpictured: 2 };
    expect(after(counted, { key, kind: "sent" }, base).unpictured).toBe(2);
    expect(after(counted, { key: otherKey, kind: "sent" }, base).unpictured).toBe(0);
    expect(after(counted, { kind: "resumed" }, base).unpictured).toBe(0);
  });

  it("tries a cast given up again, counted afresh, when its size, capture, raster or document changes", () => {
    const failed: TabCastState = {
      ...initialTabCastState(false),
      failedFor: key,
      unpictured: 3,
    };
    expect(after(failed, { kind: "observed" }, facts({}, { geometryRevision: 9 })).failedFor).toBe(
      key,
    );
    const navigated = after(
      failed,
      { kind: "observed" },
      facts({}, { document: "b", geometryRevision: 2 }),
    );
    expect(navigated).toMatchObject({ failedFor: null, unpictured: 0 });
  });

  it("gives a start's own frame its time only while the page can draw", () => {
    const awaiting: TabCastState = {
      ...initialTabCastState(false),
      otherSize: true,
      told: { key, state: "running" },
    };
    expect(after(awaiting, { kind: "own-frame-timer" }, base)).toMatchObject({
      misfit: true,
      otherSize: false,
    });
    expect(after(awaiting, { kind: "own-frame-timer" }, facts({}, { dialogOpen: true }))).toBe(
      awaiting,
    );
  });

  it("finds a session's stop still with Chromium when the tab is bound again", () => {
    expect(initialTabCastState(true).told).toEqual({ state: "stopping" });
    expect(nextStep(base, "tab#1", initialTabCastState(true))).toEqual({
      kind: "wait",
      why: "a stop is with Chromium",
    });
  });
});
