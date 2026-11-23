import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The guard against another round of the same fault: an event consumed, a path returning because
 * it believes another will act, and nothing left to do it. Random sequences of what the person
 * and the page do, and of what Chromium does (answers early and late, refusals, frames before and
 * after the answer, frames that do not fit, a page that loses its session), against the real
 * follow view. At every quiet point:
 * - a cast that is wanted has a picture shown for it, or the follow view waits on a fact it names
 *   and that is true of the page;
 * - no cast runs, or is being started, for a tab that is not wanted;
 * - every frame was acknowledged once, but the one held for a start still with Chromium;
 * - no start reached a page the follow view knew could not take one;
 * - the pass is not running, and never ran into its step limit.
 */

const { ScreencastController } = await import("./screencast-controller.js");
const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
const { jpeg } = await import("../test-support/fakes.js");
const { BrowserPaintTimeoutError } = await import("./backend.js");
const { fits, screencastRaster, wanted } = await import("./screencast-plan.js");

type Size = { width: number; height: number };

function random(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    chance: (p: number) => next() < p,
    pick: <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!,
  };
}

/** Chromium for one page session: it takes commands in order, as a session does. */
class Chromium {
  attached = true;
  dead = false;
  casting = false;
  /** Starts it answered, and refused. */
  readonly starts: Array<{ readonly refused: boolean }> = [];
  readonly lateAnswers: Array<() => void> = [];
  /** Each frame it sent, by its id, and how often it was acked. */
  readonly acks = new Map<number, number>();
  doubleAck = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Map<string, Set<(parameters: unknown) => void>>();
  /** How the next starts are answered and pictured. */
  answerLate = false;
  frameBefore = false;
  framesFit = true;
  private readonly world: World;
  private readonly id: "A" | "B";
  constructor(world: World, id: "A" | "B") {
    this.world = world;
    this.id = id;
  }
  on(event: string, listener: (parameters: unknown) => void) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
  }
  off(event: string, listener: (parameters: unknown) => void) {
    this.listeners.get(event)?.delete(listener);
  }
  retainRendering() {
    return () => undefined;
  }
  send(method: string, parameters?: Record<string, unknown>): Promise<unknown> {
    if (method === "Page.screencastFrameAck") {
      const frame = Number(parameters?.sessionId);
      const count = (this.acks.get(frame) ?? 0) + 1;
      if (count > 1) this.doubleAck = true;
      this.acks.set(frame, count);
      return Promise.resolve({});
    }
    // What stood when the follow view sent it: a session takes commands in order, later.
    const refusedWhenSent = method === "Page.startScreencast" && this.world.tabs[this.id].refused;
    const run = async () => {
      if (this.dead) throw new Error("Target closed.");
      if (method === "Page.stopScreencast") this.casting = false;
      if (method !== "Page.startScreencast") return {};
      if (!this.attached) {
        this.starts.push({ refused: true });
        this.world.refusedOn(this.id, refusedWhenSent);
        throw new Error("Not attached to an active page");
      }
      this.world.startedOn(this.id);
      this.starts.push({ refused: false });
      const before = this.frameBefore;
      const fit = this.framesFit;
      if (before) this.frame(fit);
      if (this.answerLate) await new Promise<void>((resolve) => this.lateAnswers.push(resolve));
      this.casting = true;
      // A frame of another size before the answer is what the page last drew: on a page sized
      // natively the start's own frame follows it (F30); on one sized by command it does not.
      if (!before) queueMicrotask(() => this.frame(fit));
      else if (!fit && this.world.engine === "desktop") queueMicrotask(() => this.frame(true));
      return {};
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }
  /** A frame of the page as it is now, or of another size. */
  frame(fit: boolean) {
    if (this.dead) return;
    const tab = this.world.tabs[this.id];
    const region = tab.capture
      ? { height: tab.capture.height, width: tab.capture.width }
      : tab.size;
    const raster = tab.capture
      ? screencastRaster(region, Math.min(this.world.density, tab.capture.rasterScale))
      : region;
    const shown = fit ? region : { height: region.height + 50, width: region.width + 100 };
    const id = ++this.world.frameCount;
    const listeners = this.listeners.get("Page.screencastFrame");
    // A frame no one listens for any more is no one's to ack: the cast it belongs to was stopped.
    if (listeners?.size) this.acks.set(id, 0);
    const picture = fit ? raster : { height: raster.height + 50, width: raster.width + 100 };
    const parameters = {
      data: jpeg(picture.width, picture.height).toString("base64"),
      metadata: { deviceHeight: shown.height, deviceWidth: shown.width },
      sessionId: id,
    };
    for (const listener of this.listeners.get("Page.screencastFrame") ?? []) listener(parameters);
  }
}

interface TabWorld {
  readonly id: "A" | "B";
  chromium: Chromium;
  documentId: string;
  geometryRevision: number;
  loading: boolean;
  size: Size;
  capture: { width: number; height: number; revision: number; rasterScale: number } | null;
  captureLetGo: boolean;
  dialog: boolean;
  navigation: { finished: number; pending: boolean; blankDocument: boolean };
  /** A start was refused and nothing that bears on it changed since. */
  refused: boolean;
  stallPaint: boolean;
  readonly captureListeners: Set<() => void>;
  readonly navigationListeners: Set<() => void>;
}

class World {
  frameCount = 0;
  density: 1 | 2 = 2;
  active: "A" | "B" = "A";
  streaming = false;
  readonly violations: string[] = [];
  readonly errors: string[] = [];
  readonly ledgerListeners = new Set<(event: unknown) => void>();
  readonly tabs: Record<"A" | "B", TabWorld>;
  readonly engine: "desktop" | "linux";
  constructor(engine: "desktop" | "linux") {
    this.engine = engine;
    const tab = (id: "A" | "B", opening: boolean): TabWorld => ({
      captureLetGo: false,
      capture:
        engine === "desktop" ? { height: 600, rasterScale: 2, revision: 1, width: 800 } : null,
      captureListeners: new Set(),
      chromium: undefined as never,
      dialog: false,
      documentId: `${id}0`,
      geometryRevision: 1,
      id,
      loading: opening,
      navigation: { blankDocument: opening, finished: opening ? 0 : 1, pending: opening },
      navigationListeners: new Set(),
      refused: false,
      size: { height: 600, width: 800 },
      stallPaint: false,
    });
    // B is a tab the person opened with an address, its first document still to commit.
    this.tabs = { A: tab("A", false), B: tab("B", true) };
    this.tabs.A.chromium = new Chromium(this, "A");
    this.tabs.B.chromium = new Chromium(this, "B");
    this.tabs.B.chromium.attached = false;
  }
  get port() {
    return this.engine === "desktop";
  }
  /**
   * A start the page refused. One sent while an earlier refusal stood, with nothing that bears on
   * it changed since, is one too many: the follow view knew the page could not take it.
   */
  refusedOn(id: "A" | "B", refusedWhenSent: boolean) {
    if (refusedWhenSent)
      this.violations.push(`${id} was sent a start again with nothing changed since its refusal`);
    this.tabs[id].refused = true;
  }
  startedOn(id: "A" | "B") {
    const tab = this.tabs[id];
    // The page took a start: no refusal stands.
    tab.refused = false;
    if (this.port && tab.navigation.pending && tab.navigation.blankDocument)
      this.violations.push(`a start reached ${id} before its first document committed`);
  }
  surface(id: "A" | "B") {
    const tab = this.tabs[id];
    return {
      active: this.active === id,
      documentId: tab.documentId,
      geometryRevision: tab.geometryRevision,
      id,
      loading: tab.loading,
      url: `https://site.test/${tab.documentId}`,
    };
  }
  binding(id: "A" | "B") {
    const tab = this.tabs[id];
    const desktop = this.engine === "desktop";
    return {
      cdp: tab.chromium,
      page: {
        ...(desktop
          ? {
              applyGeometry: async () => undefined,
              capture: {
                read: () => (tab.captureLetGo ? null : tab.capture),
                subscribe: (listener: () => void) => {
                  tab.captureListeners.add(listener);
                  return () => tab.captureListeners.delete(listener);
                },
              },
              navigations: {
                read: () => ({ ...tab.navigation }),
                subscribe: (listener: () => void) => {
                  tab.navigationListeners.add(listener);
                  return () => tab.navigationListeners.delete(listener);
                },
              },
            }
          : {}),
        invalidateSurface: async () => undefined,
        settleRendering: async () => {
          if (tab.stallPaint) {
            tab.stallPaint = false;
            throw new BrowserPaintTimeoutError();
          }
        },
      },
      surface: this.surface(id),
    };
  }
  ledger() {
    return {
      active: () => this.binding(this.active),
      binding: (id: "A" | "B") => this.binding(id),
      dialogOf: () => null,
      dialogOpen: (id: "A" | "B") => this.tabs[id].dialog,
      recordPageScale: () => undefined,
      subscribe: (listener: (event: unknown) => void) => {
        this.ledgerListeners.add(listener);
        return () => this.ledgerListeners.delete(listener);
      },
      use: <T>(_id: string, operation: () => Promise<T>) => operation(),
      viewportOf: (id: "A" | "B") => this.tabs[id].size,
      withGeometry: <T>(_id: string, operation: () => Promise<T>) => operation(),
    };
  }
  emit(event: unknown) {
    for (const listener of this.ledgerListeners) listener(event);
  }
  changed(id: "A" | "B") {
    this.emit({ change: "updated", surface: this.surface(id), type: "changed" });
  }
  captureChanged(id: "A" | "B") {
    for (const listener of this.tabs[id].captureListeners) listener();
  }
  navigated(id: "A" | "B") {
    for (const listener of this.tabs[id].navigationListeners) listener();
  }
  /** A new document paints once the page takes it: a running cast sends that frame. */
  paints(id: "A" | "B") {
    const chromium = this.tabs[id].chromium;
    if (chromium.casting && chromium.attached) queueMicrotask(() => chromium.frame(true));
  }
  /** What is wanted cast now, from the world itself. */
  facts() {
    const tab = this.tabs[this.active];
    return {
      closed: false,
      density: this.density,
      streaming: this.streaming,
      tab: {
        binding: "",
        capture: tab.captureLetGo ? null : tab.capture,
        dialogOpen: tab.dialog,
        document: tab.documentId,
        geometryRevision: tab.geometryRevision,
        loading: tab.loading,
        native: this.engine === "desktop",
        navigation: this.port ? tab.navigation : null,
        size: tab.size,
        sizesView: this.engine === "linux",
      },
    };
  }
}

type Action = { readonly name: string; readonly run: () => Promise<void> | void };

function actions(
  world: World,
  follow: InstanceType<typeof ScreencastController>,
  pick: ReturnType<typeof random>,
): Action[] {
  const inView = () => world.tabs[world.active];
  const other = () => (world.active === "A" ? "B" : "A");
  const list: Action[] = [
    {
      name: "turn to the other tab",
      run: () => {
        world.active = other();
        world.tabs[world.active].refused = false;
        world.emit({ surfaces: [world.surface("A"), world.surface("B")], type: "snapshot" });
      },
    },
    {
      name: "turn away and straight back",
      run: () => {
        const back = world.active;
        world.active = other();
        world.emit({ surfaces: [world.surface("A"), world.surface("B")], type: "snapshot" });
        world.active = back;
        world.emit({ surfaces: [world.surface("A"), world.surface("B")], type: "snapshot" });
      },
    },
    {
      name: "stream",
      run: async () => {
        // Asking for the picture again asks the page afresh.
        if (!world.streaming) world.tabs[world.active].refused = false;
        world.streaming = true;
        // Answered once its start is: a start Chromium holds holds it, as it would a viewer's.
        void follow.setStreaming(true).catch(() => undefined);
      },
    },
    {
      name: "pause",
      run: async () => {
        world.streaming = false;
        void follow.setStreaming(false).catch(() => undefined);
      },
    },
    {
      name: "change density",
      run: async () => {
        world.density = world.density === 2 ? 1 : 2;
        void follow.setRasterDemand(world.density).catch(() => undefined);
      },
    },
    {
      name: "resize the tab in view",
      run: () => {
        const tab = inView();
        tab.size =
          tab.size.width === 800 ? { height: 700, width: 900 } : { height: 600, width: 800 };
        tab.geometryRevision += 1;
        if (tab.capture)
          tab.capture = { ...tab.capture, ...tab.size, revision: tab.capture.revision + 1 };
        world.captureChanged(tab.id);
        world.emit({ surfaceId: tab.id, type: "resized" });
        world.changed(tab.id);
      },
    },
    {
      name: "a same-size document commits",
      run: () => {
        const tab = inView();
        if (tab.navigation.pending) return;
        tab.documentId += "+";
        tab.geometryRevision += 1;
        world.changed(tab.id);
        world.paints(tab.id);
      },
    },
    {
      name: "the capture is let go and comes back the same",
      run: () => {
        const tab = inView();
        if (!tab.capture) return;
        tab.captureLetGo = true;
        world.captureChanged(tab.id);
        tab.captureLetGo = false;
        world.captureChanged(tab.id);
      },
    },
    {
      name: "the capture is let go, or comes back",
      run: () => {
        const tab = inView();
        if (!tab.capture) return;
        tab.captureLetGo = !tab.captureLetGo;
        world.captureChanged(tab.id);
      },
    },
    {
      name: "a navigation starts",
      run: () => {
        const tab = inView();
        tab.loading = true;
        tab.navigation = { ...tab.navigation, pending: true };
        // Chromium takes no command for the page from its commit until the browser side's end of
        // the navigation; here, harder, from its start.
        tab.chromium.attached = false;
        world.navigated(tab.id);
        world.changed(tab.id);
      },
    },
    {
      name: "the navigation's document commits",
      run: () => {
        const tab = inView();
        if (!tab.navigation.pending && !tab.loading) return;
        tab.documentId += "n";
        tab.geometryRevision += 1;
        // Without a navigation port the commit is all the follow view hears; the page may or may
        // not take commands yet.
        if (!world.port && pick.chance(0.5)) {
          tab.chromium.attached = true;
          tab.refused = false;
        }
        if (!world.port) tab.refused = false;
        world.changed(tab.id);
        world.paints(tab.id);
      },
    },
    {
      name: "the navigation finishes",
      run: () => {
        const tab = inView();
        if (!tab.navigation.pending) return;
        tab.chromium.attached = true;
        tab.navigation = {
          blankDocument: false,
          finished: tab.navigation.finished + 1,
          pending: false,
        };
        // Only a page with a navigation port tells the follow view of this.
        if (world.port) tab.refused = false;
        world.navigated(tab.id);
        world.changed(tab.id);
        world.paints(tab.id);
      },
    },
    {
      name: "loading stops",
      run: () => {
        const tab = inView();
        if (!tab.loading) return;
        tab.loading = false;
        tab.chromium.attached = true;
        if (tab.navigation.pending) {
          tab.navigation = { ...tab.navigation, pending: false };
          world.navigated(tab.id);
        }
        tab.refused = false;
        world.changed(tab.id);
        world.paints(tab.id);
      },
    },
    {
      name: "a dialog opens, or is answered",
      run: () => {
        const tab = inView();
        tab.dialog = !tab.dialog;
        world.emit({ surfaceId: tab.id, type: "dialog" });
      },
    },
    {
      name: "Chromium answers the starts it holds",
      run: () => {
        for (const tab of [world.tabs.A, world.tabs.B])
          for (const answer of tab.chromium.lateAnswers.splice(0)) answer();
      },
    },
    {
      name: "Chromium changes how it answers and pictures starts",
      run: () => {
        const tab = inView();
        tab.chromium.answerLate = pick.chance(0.3);
        tab.chromium.frameBefore = pick.chance(0.5);
        tab.chromium.framesFit = pick.chance(0.8);
      },
    },
    {
      name: "a frame that does not fit",
      run: () => {
        const tab = inView();
        if (tab.chromium.casting) tab.chromium.frame(false);
      },
    },
    {
      name: "the next paint times out",
      run: () => {
        inView().stallPaint = true;
      },
    },
    {
      name: "the paint backoff ends",
      run: async () => {
        await vi.advanceTimersByTimeAsync(16_000);
      },
    },
    {
      name: "the page loses its session and gets a new one",
      run: () => {
        const tab = inView();
        tab.chromium.dead = true;
        for (const answer of tab.chromium.lateAnswers.splice(0)) answer();
        const next = new Chromium(world, tab.id);
        next.attached = !tab.navigation.pending;
        tab.chromium = next;
        tab.refused = false;
        world.changed(tab.id);
      },
    },
  ];
  return list;
}

async function turns(count: number) {
  for (let turn = 0; turn < count; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

async function settle() {
  for (let round = 0; round < 6; round += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Internals {
  readonly passing: boolean;
  readonly bound: {
    readonly id: "A" | "B";
    readonly cdp: Chromium;
    readonly held: unknown;
    readonly waiting: string | null;
    readonly state: {
      readonly told: { state: string; key?: unknown };
      readonly shown: boolean;
      readonly refusal: unknown;
    };
  } | null;
}

/** The invariants at a quiet point; each one broken is said in words. */
function check(world: World, follow: InstanceType<typeof ScreencastController>): string[] {
  const broken: string[] = [];
  const internals = follow as unknown as Internals;
  if (internals.passing) broken.push("the pass is still running at a quiet point");
  if (follow.diagnostics.some((entry) => entry.stage === "pass-limit"))
    broken.push("the pass ran into its step limit");
  const bound = internals.bound;
  const tab = world.tabs[world.active];
  if (!bound || bound.id !== world.active || bound.cdp !== tab.chromium)
    broken.push(`the tab in view, ${world.active}, is not the one bound`);
  const facts = world.facts();
  const want = wanted(facts as never);
  if (bound && bound.id === world.active && want.kind === "cast") {
    const told = bound.state.told;
    const pictured =
      told.state === "running" && fits(told.key as never, want.key) === "same" && bound.state.shown;
    const why = bound.waiting ?? "";
    const named =
      (why === "a start is with Chromium" && tab.chromium.lateAnswers.length > 0) ||
      // Chromium takes a session's commands in order: one it holds the answer to holds the next.
      (why === "a start is being prepared" && tab.chromium.lateAnswers.length > 0) ||
      (why === "its document's first frame, as it loads" &&
        (tab.loading || tab.navigation.pending)) ||
      (why === "its first document has not committed" &&
        world.port &&
        tab.navigation.pending &&
        tab.navigation.blankDocument) ||
      // A refusal waits rightly while nothing released it, or while the page again takes none.
      (why.startsWith("refused") && (tab.refused || !tab.chromium.attached)) ||
      (why === "the page did not paint" && vi.getTimerCount() > 0) ||
      (why === "its own frame, after one of another size" && vi.getTimerCount() > 0) ||
      (why === "its frames never fit this page" && world.errors.length > 0);
    if (!pictured && !named)
      broken.push(
        `${world.active} is wanted cast and neither pictured nor waiting on a fact true of it (told ${told.state}, shown ${String(bound.state.shown)}, waiting "${why}")`,
      );
  }
  for (const id of ["A", "B"] as const) {
    const chromium = world.tabs[id].chromium;
    const wantedHere = id === world.active && want.kind !== "none";
    if (!wantedHere && chromium.casting && chromium.lateAnswers.length === 0)
      broken.push(`a cast runs on ${id}, which is not wanted`);
    if (chromium.doubleAck) broken.push(`a frame of ${id} was acked twice`);
    const unacked = [...chromium.acks].filter(([, count]) => count === 0).map(([frame]) => frame);
    const held = bound?.cdp === chromium ? bound.held : null;
    const heldId = held ? Number((held as { sessionId: number }).sessionId) : null;
    const left = unacked.filter((frame) => frame !== heldId);
    if (left.length > 0) broken.push(`frames ${left.join(", ")} of ${id} were never acked`);
  }
  return broken;
}

/** Chromium answers what it holds, so nothing of the run is left waiting. */
async function closing(world: World, follow: InstanceType<typeof ScreencastController>) {
  for (const tab of [world.tabs.A, world.tabs.B])
    for (const answer of tab.chromium.lateAnswers.splice(0)) answer();
  await follow.close();
}

async function run(seed: number, engine: "desktop" | "linux", length: number) {
  const pick = random(seed);
  const world = new World(engine);
  const follow = new ScreencastController({
    frames: new LatestFrameStream({ sendFrame: async () => undefined }),
    ledger: world.ledger() as never,
    onDialogChanged: () => undefined,
    onError: (error) => world.errors.push(error.message),
  });
  const list = actions(world, follow, pick);
  const trace: string[] = [];
  await follow.start();
  world.streaming = true;
  await follow.setStreaming(true).catch(() => undefined);
  await settle();
  for (let step = 0; step < length; step += 1) {
    const action = pick.pick(list);
    trace.push(action.name);
    const ran = await Promise.race([
      Promise.resolve(action.run()).then(() => true),
      turns(200).then(() => false),
    ]);
    await settle();
    if (!ran) world.violations.push(`"${action.name}" did not return`);
    const broken = [...world.violations.splice(0), ...check(world, follow)];
    if (broken.length > 0) {
      // The follow view's own record, for reading one seed (OPENSTEER_FOLLOW_GENERATED_SEED).
      const record = follow.diagnostics
        .slice(-30)
        .map((entry) => `${entry.surfaceId ?? "-"} ${entry.stage} ${entry.reason ?? ""}`);
      await closing(world, follow);
      return { broken, record, seed, trace };
    }
  }
  await closing(world, follow);
  return null;
}

describe("the follow view, under random sequences of what the person, the page and Chromium do", () => {
  afterEach(() => vi.useRealTimers());

  for (const engine of ["desktop", "linux"] as const)
    it(`keeps every invariant at every quiet point (${engine})`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const seeds = Number(process.env.OPENSTEER_FOLLOW_GENERATED_SEEDS ?? 100);
      const only = process.env.OPENSTEER_FOLLOW_GENERATED_SEED;
      const failures = [];
      for (let seed = 1; seed <= seeds; seed += 1) {
        const value = only ? Number(only) : seed * 7_919 + (engine === "desktop" ? 0 : 1);
        if (only && seed > 1) break;
        const failure = await run(value, engine, 40);
        if (failure) {
          failures.push(failure);
          if (failures.length >= 3) break;
        }
      }
      expect(failures.map((failure) => ({ ...failure, trace: failure.trace.join(" → ") }))).toEqual(
        [],
      );
    });
});
