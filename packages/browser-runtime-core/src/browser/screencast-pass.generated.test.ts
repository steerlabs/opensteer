import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The guard against another round of the same fault: an event consumed, a path returning because
 * it believes another will act, and nothing left to do it. Random sequences of what the person
 * and the page do, and of what Chromium does (answers early and late, refusals, frames before and
 * after the answer, frames that do not fit, a renderer gone on the same session, a session lost),
 * against the real follow view. At every quiet point:
 * 1. a cast that is wanted has a picture delivered for it, or every wait names a fact true of the
 *    world, or a timer is armed for that tab: no wait may last for ever;
 * 2. at every quiet point (with no command held), the casts running in the stand-in are exactly
 *    the ones the state says are running, and no cast runs for a tab that is not wanted;
 * 3. every frame was acknowledged once, but the one held for a start still with Chromium;
 * 4. no start reached a page while the follow view knew it could not take one;
 * 5. the pass is not running, and never ran into its step limit;
 * 6. every picture delivered is of the cast running on its tab, and of the tab's document now;
 * 7. the starts Chromium took since a tab's last picture, or since the last thing that happened
 *    outside it (a person's act, a document, a tab closing beside it), stay within the bound: a
 *    restart or repair for a new fact is a change and does not count, so it cannot become a loop.
 *
 * Stand-in rules and the real ElectronDebuggerHub behaviour each mirrors (launcher tests in
 * apps/desktop/src/browser/electron-browser-launcher.test.ts):
 * - Commands execute in order on `chain`: mirrors `#serializeOwnership` ordering starts and stops
 *   ("does nothing for a closed channel's queued ask for the cast it already owns").
 * - `screencastEndedEvent` ends the cast and bumps `era`, failing any cast command held before it
 *   before that command can take effect: mirrors `#castsEnded` + `#interrupt` on detach/crash
 *   ("makes no channel an owner after a crash but one that asks again") and `#ownSessionGone` +
 *   `#failChannelCasts` on private-session detach ("tells the owner of a cast whose private session
 *   Chromium detached that it ended" and "fails a cast owner's queued stop and start when Chromium
 *   detaches its private session, without touching an agent's command").
 * - A frame emitted before a start's answer or right after it is delivered once and acked once:
 *   mirrors `#replay` and `#ackCast` ("hands a new cast's first frame to the owner that started it,
 *   and sends its ack" and "acks every frame Chromium sent once, from the owner that paces it, and
 *   never a replay").
 * - Refused starts and frames on dead sessions throw or drop without starting a cast: mirrors
 *   `#startCast` error cleanup ("acks a frame kept for a start that then fails").
 */

const { ScreencastController } = await import("./screencast-controller.js");
const { jpeg } = await import("../test-support/fakes.js");
const { BrowserPaintTimeoutError, screencastEndedEvent } = await import("./backend.js");
const { fits, screencastRaster, wanted } = await import("./screencast-plan.js");

type Size = { width: number; height: number };
type Id = "A" | "B";

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

/** The facts that bear on a refusal, and the showing they were seen in. */
type RefusalFacts = {
  readonly document: string;
  readonly epoch: number;
  readonly finished: number;
  readonly loading: boolean;
  readonly pending: boolean;
};

/** Chromium for one page session: it takes commands in order, as a session does. */
class Chromium {
  attached = true;
  dead = false;
  casting = false;
  /** Each cast Chromium started on this session, counted. */
  cast = 0;
  readonly lateAnswers: Array<() => void> = [];
  /** Each frame it sent to a listener, by its id, and how often it was acked. */
  readonly acks = new Map<number, number>();
  doubleAck = false;
  /** The facts when the follow view's last refused start was sent. */
  lastRefusal: RefusalFacts | null = null;
  /** Frames Chromium has painted and not yet sent: on their way. */
  framesDue = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Map<string, Set<(parameters: unknown) => void>>();
  /** How the next starts are answered and pictured. */
  answerLate = false;
  frameBefore = false;
  framesFit = true;
  /** It answers its starts and paints none of them (R10): a page still under load. */
  silent = false;
  /** It holds the answer to its stops, as it holds a start's (`lateAnswers`). */
  stopLate = false;
  /** It never answers its next stop, though the stop takes effect (S3). */
  stopHangs = false;
  /**
   * Bumped as the engine ends the session's casts: a command sent before fails, as the desktop
   * hub fails every command it holds right after it says so (`#interrupt`).
   */
  era = 0;
  private readonly world: World;
  private readonly id: Id;
  constructor(world: World, id: Id) {
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
  emit(event: string, parameters: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(parameters);
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
    const sentWith = method === "Page.startScreencast" ? this.world.refusalFacts(this.id) : null;
    const castTag = method === "Page.startScreencast" ? this.world.tabs[this.id].castTag : null;
    const knownRefused = sentWith !== null && sameRefusal(this.lastRefusal, sentWith);
    // A stop whose answer is lost: it takes effect, and the commands after it go on.
    if (method === "Page.stopScreencast" && this.stopHangs && !this.dead) {
      this.stopHangs = false;
      void this.chain.then(() => {
        this.casting = false;
      });
      return new Promise(() => undefined);
    }
    const era = this.era;
    const interrupted = () => {
      if (era !== this.era) throw new Error("Interrupted: the casts ended.");
    };
    const run = async () => {
      if (this.dead) throw new Error("Target closed.");
      interrupted();
      if (method === "Emulation.setVisibleSize" && this.world.tabs[this.id].failPrepare) {
        this.world.tabs[this.id].failPrepare = false;
        const tab = this.world.tabs[this.id];
        if (!tab.loading && !(this.world.port && tab.navigation.pending))
          tab.prepareFailuresOnCast += 1;
        throw new Error("Emulation.setVisibleSize failed");
      }
      if (method === "Page.stopScreencast") {
        this.casting = false;
        if (this.stopLate) await new Promise<void>((resolve) => this.lateAnswers.push(resolve));
        interrupted();
      }
      if (method !== "Page.startScreencast") return {};
      if (!this.attached) {
        if (knownRefused)
          this.world.violations.push(
            `${this.id} was sent a start again with nothing changed since its refusal`,
          );
        this.lastRefusal = sentWith;
        throw new Error("Not attached to an active page");
      }
      this.lastRefusal = null;
      this.world.startedOn(this.id, castTag!);
      this.cast += 1;
      const cast = this.cast;
      const before = this.frameBefore;
      // Each start's frame comes with its answer or once the answer is handled, as it falls; a
      // frame of a cast stopped before it was due is never sent.
      const afterHandled = this.world.chance(0.5);
      const due = (frameFit: boolean) => {
        this.framesDue -= 1;
        if (this.cast === cast && this.casting) this.frame(frameFit, true);
      };
      const schedule = (later: boolean, frameFit: boolean) => {
        this.framesDue += 1;
        (later ? setImmediate : queueMicrotask)(() => due(frameFit));
      };
      const fit = this.framesFit;
      // Chromium casts from when it takes the start; its answer may reach the follow view later.
      this.casting = true;
      // Chromium answers, and no frame of the start ever comes.
      if (this.silent) {
        if (this.answerLate) await new Promise<void>((resolve) => this.lateAnswers.push(resolve));
        interrupted();
        return {};
      }
      // The start's frame is of another size, before its answer or after: on the desktop its own
      // follows it, or the follow view repairs the view once the time it gives it is up.
      if (before) this.frame(fit, true);
      if (this.answerLate) await new Promise<void>((resolve) => this.lateAnswers.push(resolve));
      interrupted();
      // A frame of another size before the answer is what the page last drew: on a page sized
      // natively the start's own frame follows it (F30); on one sized by command it does not.
      // Chromium's frame for a start usually comes once its answer is handled; while the page is
      // held as each start's frame comes, it does, so that the frame is set aside.
      if (!before) schedule(this.world.tabs[this.id].flicker || afterHandled, fit);
      else if (!fit && this.world.engine === "desktop")
        (afterHandled ? setImmediate : queueMicrotask)(() => {
          if (this.cast === cast && this.casting) this.frame(true);
        });
      return {};
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }
  /** A frame of the page as it is now, or of another size; `forStart`, the start's own. */
  frame(fit: boolean, forStart = false) {
    if (this.dead) return;
    const tab = this.world.tabs[this.id];
    // The page held in a hold as each start's frame came: it is set aside.
    const flicker = forStart && tab.flicker && !tab.dialog;
    if (flicker) {
      tab.dialog = true;
      this.world.emit({ surfaceId: this.id, type: "dialog" });
    }
    const region = tab.capture
      ? { height: tab.capture.height, width: tab.capture.width }
      : tab.size;
    const raster = tab.capture
      ? screencastRaster(region, Math.min(this.world.density, tab.capture.rasterScale))
      : region;
    const shown = fit ? region : { height: region.height + 50, width: region.width + 100 };
    const id = ++this.world.frameCount;
    const listening = (this.listeners.get("Page.screencastFrame")?.size ?? 0) > 0;
    // A frame no one listens for any more is no one's to ack: the cast it belongs to was stopped.
    if (listening) this.acks.set(id, 0);
    if (fit) tab.unpainted = false;
    const picture = fit ? raster : { height: raster.height + 50, width: raster.width + 100 };
    // The frame carries which cast and document painted it, after the picture's own end.
    this.world.painted.set(id, {
      cast: this.cast,
      document: tab.documentId,
      session: this,
      tab: this.id,
    });
    const data = Buffer.concat([jpeg(picture.width, picture.height), Buffer.from(`#frame:${id}`)]);
    this.emit("Page.screencastFrame", {
      data: data.toString("base64"),
      metadata: { deviceHeight: shown.height, deviceWidth: shown.width },
      sessionId: id,
    });
    if (flicker) {
      tab.dialog = false;
      this.world.emit({ surfaceId: this.id, type: "dialog" });
    }
  }
}

function sameRefusal(left: RefusalFacts | null, right: RefusalFacts): boolean {
  return (
    left !== null &&
    left.document === right.document &&
    left.epoch === right.epoch &&
    left.finished === right.finished &&
    left.loading === right.loading &&
    left.pending === right.pending
  );
}

interface TabWorld {
  readonly id: Id;
  chromium: Chromium;
  documentId: string;
  geometryRevision: number;
  loading: boolean;
  size: Size;
  capture: { width: number; height: number; revision: number; rasterScale: number } | null;
  captureLetGo: boolean;
  dialog: boolean;
  navigation: { finished: number; pending: boolean; blankDocument: boolean };
  /** A document committed and has not painted yet: it paints once the page takes it. */
  unpainted: boolean;
  /** Each start's frame comes while the page is held (a dialog open over it). */
  flicker: boolean;
  stallPaint: boolean;
  /** The next start's preparation fails: its paint, or sizing its view, with an error (S2). */
  failPrepare: boolean;
  /** Its last paint wait timed out, and none since succeeded. */
  paintTimedOut: boolean;
  /** Each showing of the tab: turned to, streamed again, a new session. */
  epoch: number;
  /** Identifies one cast's budget (re-check 11, finding 6.2 / U5): outside events cannot bank starts. */
  castTag: number;
  /** Starts Chromium took for each `castTag` since the last picture. */
  readonly startsByTag: Map<number, number>;
  /** Starts accepted on the cast now wanted (U1: giving up needs more than pictureLimit attempts). */
  startsOnCast: number;
  /** Pre-send start failures on the cast now wanted (U1). */
  prepareFailuresOnCast: number;
  /** Misfit frames emitted on the cast now wanted (U1: a pictured cast can retry from a misfit). */
  misfitsOnCast: number;
  /** Stop timeouts recorded for this tab since its last picture/resume/session end (U1/U4). */
  stopTimeouts: number;
  readonly captureListeners: Set<() => void>;
  readonly navigationListeners: Set<() => void>;
}

class World {
  frameCount = 0;
  /** The run's own chance, for Chromium's choices. */
  chance: (p: number) => boolean = () => false;
  density: 1 | 2 = 2;
  active: Id = "A";
  streaming = false;
  readonly violations: string[] = [];
  /** The cast each mismatch error was said for, by tab. */
  readonly errorsFor = new Map<Id, string>();
  readonly painted = new Map<
    number,
    {
      readonly cast: number;
      readonly document: string;
      readonly session: Chromium;
      readonly tab: Id;
    }
  >();
  readonly delivered = new Set<number>();
  readonly ledgerListeners = new Set<(event: unknown) => void>();
  readonly tabs: Record<Id, TabWorld>;
  readonly engine: "desktop" | "linux";
  constructor(engine: "desktop" | "linux") {
    this.engine = engine;
    const tab = (id: Id, opening: boolean): TabWorld => ({
      captureLetGo: false,
      capture:
        engine === "desktop" ? { height: 600, rasterScale: 2, revision: 1, width: 800 } : null,
      captureListeners: new Set(),
      chromium: undefined as never,
      dialog: false,
      documentId: `${id}0`,
      epoch: 0,
      failPrepare: false,
      flicker: false,
      geometryRevision: 1,
      id,
      loading: opening,
      navigation: { blankDocument: opening, finished: opening ? 0 : 1, pending: opening },
      navigationListeners: new Set(),
      paintTimedOut: false,
      size: { height: 600, width: 800 },
      stallPaint: false,
      castTag: 0,
      misfitsOnCast: 0,
      prepareFailuresOnCast: 0,
      startsByTag: new Map(),
      startsOnCast: 0,
      stopTimeouts: 0,
      unpainted: opening,
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
  refusalFacts(id: Id): RefusalFacts {
    const tab = this.tabs[id];
    return {
      document: tab.documentId,
      epoch: tab.epoch,
      finished: this.port ? tab.navigation.finished : 0,
      loading: tab.loading,
      pending: this.port && tab.navigation.pending,
    };
  }
  /**
   * A refusal is released once a fact that bears on it is seen to differ, as the follow view
   * records a release when it sees one: a fact that changes back does not undo it.
   */
  releaseRefusals() {
    for (const id of ["A", "B"] as const) {
      const chromium = this.tabs[id].chromium;
      if (chromium.lastRefusal && !sameRefusal(chromium.lastRefusal, this.refusalFacts(id)))
        chromium.lastRefusal = null;
    }
  }
  startedOn(id: Id, castTag: number) {
    const tab = this.tabs[id];
    tab.startsByTag.set(castTag, (tab.startsByTag.get(castTag) ?? 0) + 1);
    tab.startsOnCast += 1;
    if (this.port && tab.navigation.pending && tab.navigation.blankDocument)
      this.violations.push(`a start reached ${id} before its first document committed`);
  }
  /** A new showing, or a new cast wanted: one cast's starts are allowed for this tag (no banking). */
  afresh(id: Id, resetsCast = true) {
    const tab = this.tabs[id];
    tab.castTag += 1;
    if (resetsCast) {
      tab.startsOnCast = 0;
      tab.prepareFailuresOnCast = 0;
      tab.misfitsOnCast = 0;
    }
  }
  /** Which cast the follow view should picture now on a tab, as a key. */
  castOf(id: Id) {
    const tab = this.tabs[id];
    return `${tab.size.width}x${tab.size.height} ${tab.capture?.revision ?? "-"} ${this.density} ${tab.documentId}`;
  }
  surface(id: Id) {
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
  binding(id: Id) {
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
        // The page drawn again: a Chromium that painted nothing may paint the next start.
        invalidateSurface: async () => {
          if (tab.chromium.silent && this.chance(0.5)) tab.chromium.silent = false;
        },
        settleRendering: async () => {
          // The desktop page moved to another window as its paint was awaited.
          if (tab.failPrepare && desktop) {
            tab.failPrepare = false;
            tab.prepareFailuresOnCast += 1;
            throw new Error("Electron browser page is closed.");
          }
          if (tab.stallPaint) {
            tab.stallPaint = false;
            tab.paintTimedOut = true;
            throw new BrowserPaintTimeoutError();
          }
          tab.paintTimedOut = false;
        },
      },
      surface: this.surface(id),
    };
  }
  ledger() {
    return {
      active: () => this.binding(this.active),
      binding: (id: Id) => this.binding(id),
      dialogOf: () => null,
      dialogOpen: (id: Id) => this.tabs[id].dialog,
      recordPageScale: () => undefined,
      subscribe: (listener: (event: unknown) => void) => {
        this.ledgerListeners.add(listener);
        return () => this.ledgerListeners.delete(listener);
      },
      use: <T>(_id: string, operation: () => Promise<T>) => operation(),
      viewportOf: (id: Id) => this.tabs[id].size,
      withGeometry: <T>(_id: string, operation: () => Promise<T>) => operation(),
    };
  }
  /** The viewers' end of the follow view: each picture delivered, judged as it is handed over. */
  frames() {
    return {
      close: () => undefined,
      enqueue: (frame: { data: Buffer; header: { surfaceId: string } }) => {
        const tag = /#frame:(\d+)$/u.exec(frame.data.toString("latin1"));
        const id = tag ? Number(tag[1]) : NaN;
        const painted = this.painted.get(id);
        const tab = this.tabs[frame.header.surfaceId as Id];
        if (!painted || !tab) {
          this.violations.push(`a picture was delivered that no Chromium painted`);
          return;
        }
        // A picture shown again under a dialog is the tab's last one; it was judged when first.
        if (this.delivered.has(id)) {
          if (painted.document !== tab.documentId)
            this.violations.push(`${tab.id} was shown again a picture of another document`);
          return;
        }
        this.delivered.add(id);
        if (painted.tab !== tab.id)
          this.violations.push(`${tab.id} was shown ${painted.tab}'s picture`);
        else if (painted.session !== tab.chromium || painted.cast !== tab.chromium.cast)
          this.violations.push(
            `${tab.id} was shown a picture of cast ${painted.cast}, not of cast ${tab.chromium.cast} that runs`,
          );
        else if (painted.document !== tab.documentId)
          this.violations.push(
            `${tab.id} was shown a picture of document ${painted.document}, not of ${tab.documentId}`,
          );
        tab.castTag += 1;
        tab.startsByTag.clear();
        tab.startsOnCast = 0;
        tab.prepareFailuresOnCast = 0;
        tab.misfitsOnCast = 0;
        tab.stopTimeouts = 0;
      },
    };
  }
  emit(event: unknown) {
    for (const listener of this.ledgerListeners) listener(event);
  }
  changed(id: Id) {
    this.emit({ change: "updated", surface: this.surface(id), type: "changed" });
  }
  captureChanged(id: Id) {
    for (const listener of this.tabs[id].captureListeners) listener();
  }
  navigated(id: Id) {
    for (const listener of this.tabs[id].navigationListeners) listener();
  }
  /** A document not painted yet paints once the page takes it: a running cast sends that frame. */
  paints(id: Id) {
    const tab = this.tabs[id];
    const chromium = tab.chromium;
    if (tab.unpainted && chromium.casting && chromium.attached)
      queueMicrotask(() => chromium.frame(true));
  }
  /** A new document committed: it has not painted. */
  committed(id: Id) {
    const tab = this.tabs[id];
    tab.documentId += "+";
    tab.geometryRevision += 1;
    tab.unpainted = true;
    this.afresh(id);
  }
  /** What is wanted cast now, from the world itself. */
  facts() {
    const tab = this.tabs[this.active];
    return {
      captureRegions: false,
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
  const snapshot = () =>
    world.emit({ surfaces: [world.surface("A"), world.surface("B")], type: "snapshot" });
  return [
    {
      name: "turn to the other tab",
      run: () => {
        world.active = other();
        inView().epoch += 1;
        world.afresh(world.active);
        snapshot();
      },
    },
    {
      name: "turn away and straight back",
      run: () => {
        const back = world.active;
        world.active = other();
        snapshot();
        world.active = back;
        snapshot();
      },
    },
    {
      name: "stream",
      run: () => {
        // Asking for the picture again asks the page afresh.
        if (!world.streaming) {
          inView().epoch += 1;
          inView().stopTimeouts = 0;
          world.afresh(world.active);
        }
        const before = world.streaming;
        world.streaming = true;
        // Answered once its start is: a start Chromium holds holds it, as it would a viewer's. A
        // start refused outside any navigation is the subscriber's to hear, and undoes it.
        void follow.setStreaming(true).catch(() => {
          world.streaming = before;
        });
      },
    },
    {
      name: "pause",
      // A pause waits for nothing Chromium holds: the follow view answers it at once.
      run: async () => {
        world.streaming = false;
        await follow.setStreaming(false).catch(() => undefined);
      },
    },
    {
      name: "change density",
      run: () => {
        world.density = world.density === 2 ? 1 : 2;
        world.afresh("A");
        world.afresh("B");
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
        world.afresh(tab.id);
        world.captureChanged(tab.id);
        world.emit({ surfaceId: tab.id, type: "resized" });
        world.changed(tab.id);
      },
    },
    {
      name: "a same-size document commits",
      run: () => {
        const tab = inView();
        if (tab.navigation.pending || !tab.chromium.attached) return;
        world.committed(tab.id);
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
        // On the desktop it may start before the page is told it loads (did-start-navigation
        // first); on Linux loading is the only sign of it, and Chrome reports it as it starts.
        tab.loading = !world.port || pick.chance(0.5);
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
        tab.loading = true;
        world.committed(tab.id);
        // Without a navigation port the commit is all the follow view hears; the page may or may
        // not take commands yet.
        if (!world.port && pick.chance(0.5)) tab.chromium.attached = true;
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
        if (!tab.loading) world.afresh(tab.id, false);
        world.navigated(tab.id);
        world.changed(tab.id);
        world.paints(tab.id);
      },
    },
    {
      name: "the navigation ends without a document (a download, a 204, an abort)",
      run: () => {
        const tab = inView();
        if (!tab.navigation.pending && !tab.loading) return;
        tab.chromium.attached = true;
        tab.loading = false;
        if (tab.navigation.pending) {
          tab.navigation = { ...tab.navigation, pending: false };
          world.navigated(tab.id);
        }
        // A cast given up while loading is tried afresh once loading ends without a new document.
        world.afresh(tab.id, false);
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
      name: "the page is held as each start's frame comes, or no longer",
      run: () => {
        inView().flicker = !inView().flicker;
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
        tab.chromium.silent = pick.chance(0.15);
      },
    },
    {
      name: "the engine ends the session's casts, then fails what it holds",
      run: () => {
        // The desktop hub, as a debugger detaches: it says so before it fails the commands it
        // holds (re-check 10, finding 1), and a command sent before never takes effect after.
        // Linux Chrome says nothing.
        if (world.engine !== "desktop") return;
        const tab = inView();
        const chromium = tab.chromium;
        tab.stopTimeouts = 0;
        world.afresh(tab.id, false);
        chromium.casting = false;
        chromium.era += 1;
        chromium.emit(screencastEndedEvent, {});
        for (const answer of chromium.lateAnswers.splice(0)) answer();
      },
    },
    {
      name: "Chromium holds its stops' answers, or no longer",
      run: () => {
        inView().chromium.stopLate = !inView().chromium.stopLate;
      },
    },
    {
      name: "Chromium never answers the next stop",
      run: () => {
        inView().chromium.stopHangs = true;
      },
    },
    {
      name: "the next start's preparation fails",
      run: () => {
        inView().failPrepare = true;
      },
    },
    {
      name: "a tab closes beside it",
      run: () => {
        // Another tab of the window closes: headless Chrome may show this one at the window's size
        // again. An event from outside: the starts it causes count from it (does not clear failed).
        world.afresh(world.active, false);
        world.emit({
          change: "closed",
          surface: { active: false, documentId: "C0", geometryRevision: 1, id: "C", url: "" },
          type: "changed",
        });
      },
    },
    {
      name: "a frame that does not fit",
      run: () => {
        const tab = inView();
        if (tab.chromium.casting) {
          tab.misfitsOnCast += 1;
          tab.chromium.frame(false);
        }
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
      name: "the renderer crashes on the same session and the page reloads",
      run: () => {
        const tab = inView();
        const chromium = tab.chromium;
        for (const answer of chromium.lateAnswers.splice(0)) answer();
        if (world.engine === "desktop") {
          // The hub ends the session's casts and says so on it, then fails what it still holds;
          // the page's navigation ends.
          tab.stopTimeouts = 0;
          chromium.casting = false;
          chromium.era += 1;
          chromium.emit(screencastEndedEvent, {});
          tab.navigation = { ...tab.navigation, pending: false };
          world.navigated(tab.id);
        }
        chromium.attached = true;
        tab.loading = false;
        world.committed(tab.id);
        // The reload is the page's navigation now, finished, on either engine.
        tab.navigation = {
          blankDocument: false,
          finished: tab.navigation.finished + 1,
          pending: false,
        };
        world.navigated(tab.id);
        world.changed(tab.id);
        // Linux Chrome keeps the session's cast across a renderer it replaced (unverified): the
        // reloaded document paints into it.
        world.paints(tab.id);
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
        tab.epoch += 1;
        tab.stopTimeouts = 0;
        world.afresh(tab.id);
        world.changed(tab.id);
      },
    },
  ];
}

async function turns(count: number) {
  for (let turn = 0; turn < count; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Internals {
  readonly passing: boolean;
  readonly stopTimers?: Map<object, unknown>;
  readonly bound: {
    readonly id: Id;
    readonly cdp: Chromium;
    readonly held: { readonly parameters?: unknown } | null;
    readonly waiting: string | null;
    readonly firstFrameTimer?: unknown;
    readonly paintTimer: unknown;
    readonly state: {
      readonly told: { state: string; key?: unknown };
      readonly shown: boolean;
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
  const chromium = tab.chromium;
  if (!bound || bound.id !== world.active || bound.cdp !== chromium)
    broken.push(`the tab in view, ${world.active}, is not the one bound`);
  const facts = world.facts();
  const want = wanted(facts as never);
  if (bound && bound.id === world.active && want.kind === "cast") {
    const told = bound.state.told;
    const pictured =
      told.state === "running" && fits(told.key as never, want.key) === "same" && bound.state.shown;
    const why = bound.waiting ?? "";
    const holding = chromium.lateAnswers.length > 0;
    // The plan gave the wait a time, and it is running for this tab: the wait ends with it.
    // Re-check 11, finding 6.1 (U5): a first-frame timer excuses only a running cast waiting on
    // its first frame (with Chromium casting when no answer is held).
    const timed =
      (bound.firstFrameTimer !== undefined &&
        bound.firstFrameTimer !== null &&
        told.state === "running" &&
        (holding || chromium.casting) &&
        (why === "its first frame" ||
          why === "its document's first frame, as it loads" ||
          why === "its own frame, after one of another size")) ||
      (why === "a stop is with Chromium" && internals.stopTimers?.has(chromium) === true);
    const named =
      timed ||
      // Chromium takes a session's commands in order: one it holds the answer to holds the next.
      ((why === "a start is with Chromium" ||
        why === "a start is being prepared" ||
        why === "a stop is with Chromium") &&
        holding) ||
      // A frame Chromium has painted is on its way.
      (why === "its first frame" && chromium.framesDue > 0) ||
      (why === "its first document has not committed" &&
        world.port &&
        tab.navigation.pending &&
        tab.navigation.blankDocument) ||
      // A refusal waits rightly while the page takes no command, or is about to say it can.
      (why.startsWith("refused") &&
        (!chromium.attached || tab.loading || (world.port && tab.navigation.pending))) ||
      (why === "the page did not paint" && tab.paintTimedOut && bound.paintTimer !== null) ||
      (why.startsWith("its cast was given up") &&
        world.errorsFor.get(tab.id) === world.castOf(tab.id) &&
        tab.startsOnCast + tab.prepareFailuresOnCast + tab.misfitsOnCast + tab.stopTimeouts >
          (world.engine === "desktop" ? 1 : 3));
    if (!pictured && !named)
      broken.push(
        `${world.active} is wanted cast and neither pictured nor waiting on a fact true of it (told ${told.state}, shown ${String(bound.state.shown)}, waiting "${why}")`,
      );
  }
  for (const id of ["A", "B"] as const) {
    const session = world.tabs[id].chromium;
    const wantedHere = id === world.active && want.kind !== "none";
    const stateRunning = bound?.cdp === session && bound.state.told.state === "running";
    if (!wantedHere && session.casting && session.lateAnswers.length === 0)
      broken.push(`a cast runs on ${id}, which is not wanted`);
    if (session.lateAnswers.length === 0 && session.casting !== stateRunning)
      broken.push(
        session.casting
          ? `a cast runs on ${id}, which the state does not know (told ${bound?.cdp === session ? bound.state.told.state : "unbound"})`
          : `the state says a cast runs on ${id}, but none runs in Chromium`,
      );
    if (session.doubleAck) broken.push(`a frame of ${id} was acked twice`);
    const unacked = [...session.acks].filter(([, count]) => count === 0).map(([frame]) => frame);
    const held = bound?.cdp === session ? bound.held : null;
    const heldFrame = (held?.parameters ?? held) as { sessionId?: number } | null;
    const heldId = heldFrame ? Number(heldFrame.sessionId) : null;
    const left = unacked.filter((frame) => frame !== heldId);
    if (left.length > 0) broken.push(`frames ${left.join(", ")} of ${id} were never acked`);
    // Re-check 11, finding 6.2 (U5): each cast tag gets at most 1 + pictureLimit starts with no
    // picture, so outside events while held cannot bank budget for one cast.
    const perCast = 1 + (world.engine === "desktop" ? 1 : 3);
    for (const [tag, count] of world.tabs[id].startsByTag) {
      if (count > perCast)
        broken.push(`${id} was started ${count} times on cast #${tag} with no picture`);
    }
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
  world.chance = pick.chance;
  const follow = new ScreencastController({
    frames: world.frames() as never,
    ledger: world.ledger() as never,
    onDialogChanged: () => undefined,
    onError: (error) => {
      if (error.reason === "browser-capture-mismatch")
        world.errorsFor.set(world.active, world.castOf(world.active));
    },
  });
  const pushDiagnostic = follow.diagnostics.push.bind(follow.diagnostics);
  follow.diagnostics.push = (...entries) => {
    for (const entry of entries) {
      const id = entry.surfaceId as string | undefined;
      if (entry.stage === "cast-stop-timeout" && (id === "A" || id === "B"))
        world.tabs[id].stopTimeouts += 1;
    }
    return pushDiagnostic(...entries);
  };
  // For reading one fault alone: the actions whose names this leaves out are never taken.
  const without = process.env.OPENSTEER_FOLLOW_GENERATED_WITHOUT;
  const list = actions(world, follow, pick).filter(
    (action) => !without || !new RegExp(without, "u").test(action.name),
  );
  const trace: string[] = [];
  await follow.start();
  world.streaming = true;
  await follow.setStreaming(true).catch(() => undefined);
  await turns(6);
  for (let step = 0; step < length; step += 1) {
    const action = pick.pick(list);
    trace.push(action.name);
    const ran = await Promise.race([
      Promise.resolve(action.run()).then(() => true),
      turns(200).then(() => false),
    ]);
    await turns(6);
    if (!ran) world.violations.push(`"${action.name}" did not return`);
    world.releaseRefusals();
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

  const seeds = Number(process.env.OPENSTEER_FOLLOW_GENERATED_SEEDS ?? 100);
  for (const engine of ["desktop", "linux"] as const)
    it(
      `keeps every invariant at every quiet point (${engine})`,
      // oxlint-disable-next-line opensteer/no-unit-test-timeout -- The seed count sets the work: a larger search is given time in proportion, so it needs no flag. 500 seeds took 23 ms a seed at a load of 40; each is given 60.
      { timeout: 5_000 + seeds * 60 },
      async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const only = process.env.OPENSTEER_FOLLOW_GENERATED_SEED;
        // A larger search runs in batches, each from its own first seed.
        const from = Number(process.env.OPENSTEER_FOLLOW_GENERATED_FROM ?? 1);
        const failures = [];
        for (let seed = from; seed < from + seeds; seed += 1) {
          const value = only ? Number(only) : seed * 7_919 + (engine === "desktop" ? 0 : 1);
          if (only && seed > from) break;
          const failure = await run(value, engine, 40);
          if (failure) {
            failures.push(failure);
            if (failures.length >= Number(process.env.OPENSTEER_FOLLOW_GENERATED_FAILURES ?? 3))
              break;
          }
        }
        expect(
          failures.map((failure) => ({ ...failure, trace: failure.trace.join(" → ") })),
        ).toEqual([]);
      },
    );
});
