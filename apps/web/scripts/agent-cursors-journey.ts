/**
 * Agents' cursors over a browser tab, end to end in a real browser: the
 * production web build against the mock Host, served the way a Host serves
 * it, driven in headless Chromium. The mock stops generating activity and the
 * journey sends the Host's place notices itself; Playwright's clock stands
 * still while it steps animation frames, so every trajectory is repeatable.
 *
 * Ways this journey can fail, each checked below:
 *  1. A first activity with no pointer shows no cursor, or shows it anywhere
 *     but the neutral spot (centred, 30% down the picture).
 *  2. A cursor vanishes with no new activity: it must still be shown after
 *     the clock passes the old 15 s acting window, and a minute.
 *  3. A new pointer jumps instead of gliding: no intermediate positions, the
 *     distance to the target grows, or a coordinate passes the target.
 *  4. A new target mid-glide jumps the cursor: it moves at the moment of the
 *     retarget, or one frame's step changes faster than the spring allows.
 *  5. A pointer-less activity (typing, a read) moves or hides the cursor, or
 *     brings its quiet label back.
 *  6. The label stays after ~2.6 s at rest, goes before it, or does not come
 *     back on the next move.
 *  7. A clear notice leaves the cursor, or removes it without fading.
 *  8. The same Run acting in another place leaves its cursor here.
 *  9. Two threads do not get two cursors in distinct colours with their own
 *     names ("Opensteer" for home), or a colour gives its white label less
 *     than 4.5:1.
 * 10. Reduced motion glides: any position between the old and new point.
 * 11. Near the picture's right and bottom edges the label does not flip, or
 *     leaves the picture.
 * 12. A resize glides the cursor or loses its place in the picture.
 * 13. Resting cursors keep a frame loop: `data-animating` is true at any
 *     sample over 2 s.
 * 14. A remount (another tab and back) glides in instead of showing the
 *     cursor at its last point.
 * 15. A first appearance at a known point glides there.
 * 16. An older arrival from another place, delivered after a newer one,
 *     moves the cursor back.
 * 17. Two Runs sharing a thread id, in two tabs, lose one of their cursors.
 * 18. A known point outside the captured region shows the cursor, or a point
 *     inside it lands anywhere but its re-normalised spot.
 * 19. A Run that ends leaves its cursor behind.
 * 20. A cursor that comes back within its fade stops short of its point, or
 *     stays unseen under reduced motion.
 * 21. The viewfinder, drawing a region larger than itself, puts a cursor
 *     anywhere but the picture point the main view does.
 * 22. The glass page glides or pops a first scene's cursors in. A raised
 *     layer and the glass each start a fresh GlassScene this way, so a
 *     switch between them must not move a cursor.
 * 23. The glass page jumps a cursor to a new point in the same geometry.
 * 24. A scene whose points were measured in new page geometry glides there
 *     instead of snapping, when the glass's size has not changed.
 * 25. The glass's size alone snaps a cursor: a resize mid-glide, or the
 *     scene after it in unchanged geometry.
 * 26. A glass scene that goes and comes back carries stale motion.
 * 27. A leaving glass cursor vanishes without fading, or outlives its scene.
 *
 * `result.json`, screenshots and the sampled trajectories go to
 * OPENSTEER_AGENT_CURSORS_E2E_ARTIFACT_DIR, or `opensteer-agent-cursors-e2e`
 * in the system temporary directory. Chromium is Playwright's
 * (`playwright-core install chromium`) unless OPENSTEER_CHROMIUM_EXECUTABLE
 * names another.
 */
import { homeCursorPaint, markColorPaint } from "@opensteer/client/host";
import type { MockHostClient } from "@opensteer/client/mock";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import {
  JourneyFailure,
  expectThat,
  finishJourney,
  journeyChecks,
  openMockWeb,
} from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_AGENT_CURSORS_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), "opensteer-agent-cursors-e2e"),
);
const middleLayer = ".browser-stage .cursor-layer--middle";
const browserViewfinder = ".viewfinder:not(.viewfinder--native)";
const viewfinderLayer = `${browserViewfinder} .cursor-layer--viewfinder`;
const glassLayer = ".glass-scene";
/** The motion module's spring, which bounds how fast a cursor's step may change. */
const omega = 17;
const frameMs = 16;

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
interface Point {
  readonly x: number;
  readonly y: number;
}
interface CursorView {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly on: boolean;
  readonly quiet: boolean;
  readonly leaving: boolean;
  readonly swap: boolean;
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly arrive: boolean;
  /** Set by the journey to tell one element from its replacement. */
  readonly mark: string | null;
  readonly name: string;
  readonly label: Rect;
  readonly labelOpacity: string;
  readonly color: string;
  readonly labelBackground: string;
  readonly labelColor: string;
}
interface LayerView {
  readonly now: number;
  readonly animating: string | null;
  readonly still: boolean;
  readonly picture: Rect;
  readonly cursors: readonly CursorView[];
}
interface RunRef {
  readonly id: string;
  readonly threadId: string;
}
interface TabRef {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
}

const { checks, check, abort } = journeyChecks();
const trajectories: Record<string, readonly unknown[]> = {};

await rm(artifactDirectory, { force: true, recursive: true });
await mkdir(artifactDirectory, { recursive: true });
const web = await openMockWeb("opensteer-agent-cursors-web");
const { browser, origin } = web;

const palette = Object.fromEntries(
  Object.entries({
    home: homeCursorPaint,
    ...Object.fromEntries(
      Object.entries(markColorPaint).map(([name, paint]) => [name, paint.cursor]),
    ),
  }).map(([name, hex]) => [name, { hex, contrast: contrast(hex) }]),
);
try {
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    reducedMotion: "no-preference",
    viewport: { height: 900, width: 1280 },
  });
  // Nothing leaves the machine: anything outside the app answers here.
  await context.route(
    (url) => url.origin !== origin,
    (route) => route.fulfill({ body: "", contentType: "text/plain", status: 204 }),
  );
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(`${origin}/`);
  await page.locator(".side-tab").first().waitFor();
  // The mock records the pages a reply used as it runs: let it run until a reply shows one.
  // A reply's picture holds a place for a moment before cutting to the next, so wait for
  // the page, not an app it touched first.
  const viewfinderShown = await page
    .locator(browserViewfinder)
    .first()
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  const fixture = await page.evaluate(() => {
    const mock = Reflect.get(window, "opensteerMock") as MockHostClient;
    mock.scriptPlaces();
    const snapshot = mock.getSnapshot();
    return {
      homeThreadId: snapshot.homeThreadId,
      runs: snapshot.runQueue
        .filter((run) => run.status === "running" || run.status === "waiting")
        .map(({ id, status, threadId }) => ({ id, status, threadId })),
      tabs: snapshot.browserSessions.flatMap((session) =>
        session.tabs.map((tab) => ({ id: tab.id, sessionId: session.id, title: tab.title })),
      ),
      marks: Object.fromEntries(
        snapshot.threads.map((thread) => [thread.id, { icon: thread.icon, color: thread.color }]),
      ),
      titles: Object.fromEntries(snapshot.threads.map((thread) => [thread.id, thread.title])),
    };
  });
  const tab = (title: string): TabRef => {
    const found = fixture.tabs.find((candidate) => candidate.title === title);
    if (!found) throw new Error(`The mock has no "${title}" tab.`);
    return found;
  };
  const here = tab("Launch brief");
  const there = tab("Coffee shortlist");
  const homeRun = fixture.runs.find((run) => run.threadId === fixture.homeThreadId);
  const main = fixture.runs.find(
    (run) => run.status === "running" && run.threadId !== fixture.homeThreadId,
  );
  // An unlisted delegated Run carries its ancestor's thread id; any other live Run stands in.
  const delegated = fixture.runs.find(
    (run) => run !== main && run !== homeRun && run.status === "waiting",
  );
  if (!homeRun || !main || !delegated) throw new Error("The mock has too few live Runs.");
  const mainTitle = fixture.titles[main.threadId] ?? "";
  const keyOf = (target: TabRef) => `browser:${target.sessionId}:${target.id}`;

  let seq = 0;
  let order = 0;
  /** A Host place notice, labelled with the page's current geometry as the runtime labels it. */
  const activity = async (
    run: RunRef,
    target: TabRef,
    pointer: Point | null,
    options: { readonly order?: number; readonly threadId?: string; readonly home?: boolean } = {},
  ) => {
    const geometryRevision = await page.evaluate(
      ({ sessionId, surfaceId }) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).browserWatchFrame(
          sessionId,
          surfaceId,
        )?.header.geometryRevision ?? 1,
      { sessionId: target.sessionId, surfaceId: target.id },
    );
    const at = Date.now();
    return {
      type: "host.place-activity",
      activity: {
        place: { kind: "browser", sessionId: target.sessionId, surfaceId: target.id },
        threadId: options.threadId ?? run.threadId,
        home: options.home ?? false,
        runId: run.id,
        generation: 1,
        seq: ++seq,
        order: options.order ?? ++order,
        at,
        expiresAt: at + 15_000,
        pointer,
        geometryRevision,
      },
    };
  };
  const cleared = (run: RunRef, target: TabRef) => ({
    type: "host.place-activity-cleared",
    place: { kind: "browser", sessionId: target.sessionId, surfaceId: target.id },
    runId: run.id,
    generation: 1,
    seq: ++seq,
  });
  const apply = async (notice: unknown) => {
    await page.evaluate((value) => {
      (Reflect.get(window, "opensteerMock") as MockHostClient).scriptPlaces().apply(value);
    }, notice);
    await settle(page);
  };
  const pictureHeader = (target: TabRef) =>
    page.evaluate(
      ({ sessionId, surfaceId }) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).browserWatchFrame(
          sessionId,
          surfaceId,
        )!.header,
      { sessionId: target.sessionId, surfaceId: target.id },
    );
  const cropPicture = (target: TabRef, region: { width: number; height: number } | null) =>
    page.evaluate(
      ({ sessionId, surfaceId, value }) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient)
          .scriptPlaces()
          .crop(sessionId, surfaceId, value),
      { sessionId: target.sessionId, surfaceId: target.id, value: region },
    );
  const storeRuns = (target: TabRef) =>
    page.evaluate(
      (key) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient)
          .placeActivity(key)
          .map((record) => record.runId as string),
      keyOf(target),
    );
  const show = async (target: TabRef) => {
    await page
      .locator(`.side-tab[data-place-key="${keyOf(target)}"] .side-tab__main`)
      .dispatchEvent("click");
    await settle(page);
  };
  /** Steps the stopped clock one frame at a time and reads the layer after each. */
  const frames = (count: number, on: Page = page, layer = middleLayer) =>
    stepFrames(count, on, layer);
  const untilRest = async (limit = 180, on: Page = page, layer = middleLayer) => {
    const samples: LayerView[] = [];
    for (let index = 0; index < limit; index++) {
      const [sample] = await stepFrames(1, on, layer);
      samples.push(sample!);
      if (sample!.animating === "false") return samples;
    }
    throw new JourneyFailure("the cursors never came to rest", { samples: samples.slice(-5) });
  };
  const shot = (name: string) => page.screenshot({ path: path.join(artifactDirectory, name) });

  await page.locator(`.side-tab[data-place-key="${keyOf(here)}"] .side-tab__main`).click();
  await page.locator(middleLayer).waitFor();
  await page.waitForFunction(
    ({ sessionId, surfaceId }) =>
      (Reflect.get(window, "opensteerMock") as MockHostClient).browserWatchFrame(
        sessionId,
        surfaceId,
      ) !== null &&
      (document.querySelector(".browser-stage canvas")?.getBoundingClientRect().width ?? 0) > 0,
    { sessionId: here.sessionId, surfaceId: here.id },
  );
  await page.waitForTimeout(500);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);

  await check(
    "1 · a first activity with no pointer shows the cursor at the neutral spot",
    async () => {
      await apply(await activity(main, here, null));
      const samples = [await readLayer(page), ...(await frames(10))];
      const first = samples[0]!;
      const expected = at(first.picture, { x: 0.5, y: 0.3 });
      const positions = samples.map((sample) => cursorOf(sample, main.threadId));
      const observed = { expected, first: positions[0], picture: first.picture };
      expectThat(
        observed,
        positions.every((cursor) => cursor?.on && near(cursor, expected)),
        "the cursor is not shown at the neutral spot",
      );
      expectThat(
        observed,
        samples.every((sample) => sample.animating === "false"),
        "a first appearance glided",
      );
      await shot("1-neutral-spot.png");
      return observed;
    },
  );

  const glideTarget = { x: 0.8, y: 0.75 };
  await check("3 · a new pointer glides there without overshoot", async () => {
    const start = cursorOf(await readLayer(page), main.threadId)!;
    await apply(await activity(main, here, glideTarget));
    const samples = await untilRest();
    const picture = samples.at(-1)!.picture;
    const target = at(picture, glideTarget);
    const track = samples.map((sample) => cursorOf(sample, main.threadId)!);
    trajectories.glide = track.map(({ x, y }, index) => ({ t: samples[index]!.now, x, y }));
    const distances = track.map((point) => distance(point, target));
    const intermediate = track.filter(
      (point) => distance(point, start) > 1 && distance(point, target) > 1,
    ).length;
    const observed = { distances, intermediate, start, target, frames: track.length };
    expectThat(observed, intermediate >= 8, "the cursor jumped instead of gliding");
    expectThat(
      observed,
      distances.every((value, index) => index === 0 || value <= distances[index - 1]! + 0.01),
      "the distance to the target grew",
    );
    expectThat(
      observed,
      track.every(
        (point) =>
          point.x >= Math.min(start.x, target.x) - 0.01 &&
          point.x <= Math.max(start.x, target.x) + 0.01 &&
          point.y >= Math.min(start.y, target.y) - 0.01 &&
          point.y <= Math.max(start.y, target.y) + 0.01,
      ),
      "the cursor overshot its target",
    );
    expectThat(observed, near(track.at(-1)!, target), "the cursor did not end at its target");
    expectThat(
      observed,
      track.every((cursor) => !cursor.quiet),
      "the name was quiet while the cursor moved",
    );
    return observed;
  });

  await check("6 · the name goes quiet after ~2.6 s at rest", async () => {
    await page.clock.runFor(2_450);
    const before = cursorOf(await readLayer(page), main.threadId)!;
    await page.clock.runFor(200);
    const after = cursorOf(await readLayer(page), main.threadId)!;
    await page.waitForTimeout(400);
    const faded = cursorOf(await readLayer(page), main.threadId)!;
    const observed = { before, after, faded };
    expectThat(observed, !before.quiet, "the name went quiet before 2.6 s");
    expectThat(observed, after.quiet, "the name was still up after 2.6 s");
    expectThat(observed, faded.labelOpacity === "0", "the quiet name is still visible");
    await shot("6-name-quiet.png");
    return observed;
  });

  await check("5 · a pointer-less activity neither moves nor hides the cursor", async () => {
    const before = cursorOf(await readLayer(page), main.threadId)!;
    await apply(await activity(main, here, null));
    const samples = await frames(20);
    const track = samples.map((sample) => cursorOf(sample, main.threadId)!);
    const observed = { before, after: track.at(-1) };
    expectThat(
      observed,
      track.every((cursor) => cursor.on && near(cursor, before) && cursor.quiet),
      "the cursor moved, hid or spoke for an activity without a pointer",
    );
    expectThat(
      observed,
      samples.every((sample) => sample.animating === "false"),
      "the layer animated for an activity without a pointer",
    );
    return observed;
  });

  await check("2 · the cursor stays past the old 15 s window and a minute", async () => {
    await page.clock.fastForward(16_000);
    const afterWindow = cursorOf(await readLayer(page), main.threadId);
    await page.clock.fastForward(45_000);
    const afterMinute = cursorOf(await readLayer(page), main.threadId);
    const observed = { afterMinute, afterWindow, store: await storeRuns(here) };
    expectThat(
      observed,
      !!afterWindow?.on && !!afterMinute?.on && observed.store.includes(main.id),
      "the cursor vanished without new activity",
    );
    await shot("2-present-after-61s.png");
    return observed;
  });

  await check(
    "6 · 4 · the name returns on the next move, and a retarget mid-glide bends the path",
    async () => {
      await apply(await activity(main, here, { x: 0.3, y: 0.6 }));
      const moved = cursorOf(await readLayer(page), main.threadId)!;
      const before = await frames(7);
      const last = cursorOf(before.at(-1)!, main.threadId)!;
      await apply(await activity(main, here, { x: 0.75, y: 0.2 }));
      const atRetarget = cursorOf(await readLayer(page), main.threadId)!;
      await shot("4-mid-glide.png");
      const after = await untilRest();
      const samples = [...before, ...after];
      const track = samples.map((sample) => cursorOf(sample, main.threadId)!);
      const target = at(after.at(-1)!.picture, { x: 0.75, y: 0.2 });
      trajectories.retarget = track.map(({ x, y }, index) => ({
        t: samples[index]!.now,
        x,
        y,
        retargeted: index >= before.length,
      }));
      // A spring changes a frame's step by at most (2ω|v| + ω²|offset|)·dt²: anything more is a jump.
      const jumps = track.slice(2).flatMap((point, index) => {
        const previous = track[index + 1]!;
        const older = track[index]!;
        const step = { x: point.x - previous.x, y: point.y - previous.y };
        const prior = { x: previous.x - older.x, y: previous.y - older.y };
        const goal =
          index + 1 >= before.length - 1 ? target : at(before[0]!.picture, { x: 0.3, y: 0.6 });
        const dt = frameMs / 1000;
        const bound =
          2 * omega * dt * Math.hypot(prior.x, prior.y) +
          omega * omega * dt * dt * distance(previous, goal) +
          1;
        const change = Math.hypot(step.x - prior.x, step.y - prior.y);
        return change > bound ? [{ index: index + 2, change, bound }] : [];
      });
      // A restarted spring would set off toward the new target; a bent path keeps its way first.
      const priorStep = {
        x: last.x - track[before.length - 2]!.x,
        y: last.y - track[before.length - 2]!.y,
      };
      const nextStep = { x: track[before.length]!.x - last.x, y: track[before.length]!.y - last.y };
      const momentum = priorStep.x * nextStep.x + priorStep.y * nextStep.y;
      const observed = { atRetarget, jumps, last, momentum, moved, nextStep, priorStep, target };
      expectThat(observed, !moved.quiet, "the name did not return on the next move");
      expectThat(observed, near(atRetarget, last), "the cursor moved when its target changed");
      expectThat(observed, jumps.length === 0, "a frame's step changed faster than the spring");
      expectThat(observed, momentum > 0, "a retarget restarted the glide instead of bending it");
      expectThat(observed, near(track.at(-1)!, target), "the cursor did not reach its new target");
      return observed;
    },
  );

  await check("13 · resting cursors run no frame loop for 2 s", async () => {
    const samples: LayerView[] = [];
    for (let index = 0; index < 20; index++) {
      await page.clock.runFor(100);
      samples.push(await readLayer(page));
    }
    const positions = samples.map((sample) => cursorOf(sample, main.threadId)!);
    const observed = { animating: samples.map((sample) => sample.animating) };
    expectThat(
      observed,
      samples.every((sample) => sample.animating === "false"),
      "a resting layer kept its loop",
    );
    expectThat(
      observed,
      positions.every((cursor) => near(cursor, positions[0]!)),
      "a resting cursor moved",
    );
    return observed;
  });

  await check("11 · near the right and bottom edges the name flips and stays inside", async () => {
    await apply(await activity(main, here, { x: 0.985, y: 0.97 }));
    const samples = await untilRest();
    const last = samples.at(-1)!;
    const cursor = cursorOf(last, main.threadId)!;
    const label = cursor.label;
    const picture = last.picture;
    const observed = { cursor, picture };
    expectThat(observed, cursor.flipX && cursor.flipY, "the name did not flip at the edges");
    expectThat(
      observed,
      label.left >= picture.left - 0.5 &&
        label.top >= picture.top - 0.5 &&
        label.left + label.width <= picture.left + picture.width + 0.5 &&
        label.top + label.height <= picture.top + picture.height + 0.5,
      "the name left the picture",
    );
    await shot("11-edge-flip.png");
    return observed;
  });

  await check(
    "15 · 9 · a second thread appears at its known point, in its own colour and name",
    async () => {
      const homePoint = { x: 0.25, y: 0.35 };
      await apply(await activity(homeRun, here, homePoint, { home: true }));
      const samples = [await readLayer(page), ...(await frames(10))];
      const target = at(samples[0]!.picture, homePoint);
      const track = samples.map((sample) => cursorOf(sample, homeRun.threadId));
      const last = samples.at(-1)!;
      const home = cursorOf(last, homeRun.threadId)!;
      const agent = cursorOf(last, main.threadId)!;
      const expectedColours = {
        agent: markColorPaint[fixture.marks[main.threadId]!.color!].cursor,
        home: homeCursorPaint,
      };
      const observed = {
        agent,
        contrast: { agent: contrast(agent.labelBackground), home: contrast(home.labelBackground) },
        expectedColours,
        home,
        target,
      };
      expectThat(
        observed,
        track.every((cursor) => cursor?.on && near(cursor, target)) &&
          samples.every((sample) => sample.animating === "false"),
        "a first appearance at a known point glided",
      );
      expectThat(
        observed,
        last.cursors.length === 2 && home.name === "Opensteer" && agent.name === mainTitle,
        "the two cursors do not carry their own names",
      );
      expectThat(
        observed,
        sameColour(agent.color, expectedColours.agent) &&
          sameColour(agent.labelBackground, expectedColours.agent) &&
          sameColour(home.color, expectedColours.home) &&
          sameColour(home.labelBackground, expectedColours.home) &&
          !sameColour(agent.color, home.color),
        "the cursors are not drawn in their own distinct colours",
      );
      expectThat(
        observed,
        sameColour(agent.labelColor, "#ffffff") &&
          sameColour(home.labelColor, "#ffffff") &&
          observed.contrast.agent >= 4.5 &&
          observed.contrast.home >= 4.5 &&
          Object.values(palette).every(({ contrast }) => contrast >= 4.5),
        "a cursor colour gives its white name less than 4.5:1",
      );
      await shot("9-two-cursors.png");
      await page.screenshot({
        clip: {
          x: last.picture.left + (await layerOrigin(page)).x,
          y: last.picture.top + (await layerOrigin(page)).y,
          width: Math.min(560, last.picture.width),
          height: Math.min(360, last.picture.height),
        },
        path: path.join(artifactDirectory, "9-cursor-closeup.png"),
      });
      return observed;
    },
  );

  await check("14 · a remount shows each cursor at its last point without gliding", async () => {
    const before = await readLayer(page);
    const layer = page.locator(middleLayer);
    await layer.evaluate((element) => {
      element.dataset.journeyLayer = "before";
    });
    await show(there);
    await frames(20);
    const away = await page.locator(".side-tab.is-active").getAttribute("data-place-key");
    await show(here);
    const samples = await frames(60);
    const remounted = (await layer.getAttribute("data-journey-layer")) === null;
    trajectories.remount = samples.map((sample) => ({
      t: sample.now,
      cursors: sample.cursors.map(({ id, on, x, y }) => ({ id, on, x, y })),
    }));
    const shown = samples.filter((sample) => sample.cursors.some((cursor) => cursor.on));
    const observed = {
      away,
      before: before.cursors.map(({ id, x, y }) => ({ id, x, y })),
      remounted,
      shownFrames: shown.length,
    };
    expectThat(
      observed,
      away === keyOf(there) && remounted,
      "the page was not left and drawn again",
    );
    expectThat(observed, shown.length > 30, "the cursors did not come back with the page");
    expectThat(
      observed,
      shown.every((sample) =>
        before.cursors.every((cursor) => {
          const now = cursorOf(sample, cursor.id);
          return !!now?.on && near(now, cursor);
        }),
      ),
      "a cursor came back anywhere but its last point",
    );
    expectThat(
      observed,
      samples.every((sample) => sample.animating !== "true"),
      "a remounted cursor glided",
    );
    return observed;
  });

  await check("12 · a resize redraws the cursor in place without gliding", async () => {
    const before = await readLayer(page);
    const fraction = (sample: LayerView, id: string) => {
      const cursor = cursorOf(sample, id)!;
      return {
        x: (cursor.x - sample.picture.left) / sample.picture.width,
        y: (cursor.y - sample.picture.top) / sample.picture.height,
      };
    };
    const expected = fraction(before, main.threadId);
    await page.setViewportSize({ height: 780, width: 1060 });
    const samples = [await readLayer(page), ...(await frames(40))];
    trajectories.resize = samples.map((sample) => ({
      t: sample.now,
      picture: sample.picture,
      fraction: fraction(sample, main.threadId),
    }));
    const last = samples.at(-1)!;
    const observed = { before: before.picture, after: last.picture, expected };
    expectThat(
      observed,
      last.picture.width !== before.picture.width,
      "the picture did not change size",
    );
    expectThat(
      observed,
      samples.every((sample) => {
        const now = fraction(sample, main.threadId);
        return Math.abs(now.x - expected.x) < 0.002 && Math.abs(now.y - expected.y) < 0.002;
      }),
      "the cursor left its place in the picture",
    );
    expectThat(
      observed,
      samples.every((sample) => sample.animating !== "true"),
      "a resize glided the cursor",
    );
    return observed;
  });

  await check("10 · reduced motion swaps the cursor without gliding", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await stillness(page, true);
    const start = cursorOf(await readLayer(page), main.threadId)!;
    await apply(await activity(main, here, { x: 0.2, y: 0.2 }));
    const samples = [await readLayer(page), ...(await frames(15))];
    const track = samples.map((sample) => cursorOf(sample, main.threadId)!);
    const target = at(samples.at(-1)!.picture, { x: 0.2, y: 0.2 });
    trajectories.reducedMotion = track.map(({ swap, x, y }, index) => ({
      t: samples[index]!.now,
      swap,
      x,
      y,
    }));
    const observed = {
      still: samples[0]!.still,
      swapped: track.some((cursor) => cursor.swap),
      target,
    };
    expectThat(observed, observed.still, "the layer does not know motion is reduced");
    expectThat(
      observed,
      track.every((cursor) => near(cursor, start) || near(cursor, target)),
      "a reduced-motion cursor passed through intermediate positions",
    );
    expectThat(
      observed,
      observed.swapped && near(track.at(-1)!, target) && !track.at(-1)!.swap,
      "the cursor did not swap to its new point",
    );
    expectThat(
      observed,
      samples.every((sample) => sample.animating !== "true"),
      "a reduced-motion layer ran a frame loop",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await stillness(page, false);
    return observed;
  });

  await check("7 · a clear notice fades the cursor out and removes it", async () => {
    await apply(cleared(homeRun, here));
    const fading = cursorOf(await readLayer(page), homeRun.threadId);
    await page.clock.runFor(100);
    const during = cursorOf(await readLayer(page), homeRun.threadId);
    await page.clock.runFor(120);
    await settle(page);
    const after = cursorOf(await readLayer(page), homeRun.threadId);
    const observed = { after, during, fading };
    expectThat(observed, !!fading?.leaving && !!during?.leaving, "the cursor did not fade out");
    expectThat(observed, after === undefined, "the faded cursor was not removed");
    return observed;
  });

  await check("8 · the same Run acting in another place leaves this one", async () => {
    await apply(await activity(main, there, { x: 0.5, y: 0.5 }));
    await page.clock.runFor(220);
    await settle(page);
    const observed = {
      here: await storeRuns(here),
      there: await storeRuns(there),
      cursor: cursorOf(await readLayer(page), main.threadId) ?? null,
    };
    expectThat(
      observed,
      observed.cursor === null &&
        !observed.here.includes(main.id) &&
        observed.there.includes(main.id),
      "the Run's cursor stayed in the place it left",
    );
    return observed;
  });

  await check(
    "16 · an older arrival from the place a Run left does not bring it back",
    async () => {
      const newest = order;
      await apply(await activity(main, here, { x: 0.4, y: 0.4 }, { order: newest - 1 }));
      const samples = await frames(10);
      const observed = {
        cursors: samples.at(-1)!.cursors.map(({ id }) => id),
        here: await storeRuns(here),
        there: await storeRuns(there),
      };
      expectThat(
        observed,
        samples.every((sample) => cursorOf(sample, main.threadId) === undefined) &&
          !observed.here.includes(main.id) &&
          observed.there.includes(main.id),
        "a stale arrival moved the Run back",
      );
      await apply(await activity(main, here, { x: 0.4, y: 0.4 }));
      const back = cursorOf(await readLayer(page), main.threadId);
      const result = {
        ...observed,
        back,
        hereAfter: await storeRuns(here),
        thereAfter: await storeRuns(there),
      };
      expectThat(
        result,
        !!back?.on && result.hereAfter.includes(main.id) && !result.thereAfter.includes(main.id),
        "a newer arrival did not move the Run back here",
      );
      return result;
    },
  );

  await check("17 · two Runs that share a thread id keep a cursor in each tab", async () => {
    await apply(await activity(delegated, there, { x: 0.6, y: 0.4 }, { threadId: main.threadId }));
    const hereView = await readLayer(page);
    const observed = {
      here: await storeRuns(here),
      hereCursor: cursorOf(hereView, main.threadId) ?? null,
      there: await storeRuns(there),
    };
    expectThat(
      observed,
      observed.here.includes(main.id) &&
        observed.there.includes(delegated.id) &&
        !!observed.hereCursor?.on,
      "one of the two Runs lost its record or cursor",
    );
    await show(there);
    let thereCursor: CursorView | undefined;
    for (let index = 0; index < 60 && !thereCursor?.on; index++)
      thereCursor = cursorOf((await frames(1))[0]!, main.threadId);
    await shot("17-shared-thread-other-tab.png");
    await show(here);
    await frames(30);
    const result = { ...observed, thereCursor: thereCursor ?? null };
    expectThat(result, !!thereCursor?.on, "the other tab does not show its Run's cursor");
    return result;
  });

  await check("18 · a point outside the captured region hides the cursor", async () => {
    const view = await page.evaluate(
      ({ sessionId, surfaceId }) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).browserWatchFrame(
          sessionId,
          surfaceId,
        )!.header,
      { sessionId: here.sessionId, surfaceId: here.id },
    );
    const crop = (region: { width: number; height: number } | null) =>
      page.evaluate(
        ({ sessionId, surfaceId, value }) =>
          (Reflect.get(window, "opensteerMock") as MockHostClient)
            .scriptPlaces()
            .crop(sessionId, surfaceId, value),
        { sessionId: here.sessionId, surfaceId: here.id, value: region },
      );
    await crop({ width: Math.round(view.viewportWidth * 0.6), height: view.viewportHeight });
    await frames(10);
    await apply(await activity(main, here, { x: 0.8, y: 0.5 }));
    const hidden = cursorOf((await frames(3)).at(-1)!, main.threadId);
    await shot("18-outside-region-hidden.png");
    await apply(await activity(main, here, { x: 0.3, y: 0.5 }));
    const inside = await readLayer(page);
    const region = Math.round(view.viewportWidth * 0.6) / view.viewportWidth;
    const expected = at(inside.picture, { x: 0.3 / region, y: 0.5 });
    const shown = cursorOf(inside, main.threadId);
    await crop(null);
    await frames(10);
    const observed = { expected, hidden, picture: inside.picture, shown };
    expectThat(observed, hidden !== undefined && !hidden.on, "a point outside the region showed");
    expectThat(
      observed,
      !!shown?.on && near(shown, expected),
      "a point inside the region is not at its re-normalised spot",
    );
    return observed;
  });

  await check("20 · a cursor that comes back within its fade finishes its glide", async () => {
    const target = { x: 0.7, y: 0.3 };
    await apply(await activity(main, here, target));
    await frames(5);
    await apply(cleared(main, here));
    const fading = cursorOf(await readLayer(page), main.threadId) ?? null;
    await frames(3);
    await apply(await activity(main, here, target));
    const samples = await untilRest();
    const last = samples.at(-1)!;
    const cursor = cursorOf(last, main.threadId) ?? null;
    const observed = { cursor, expected: at(last.picture, target), fading, frames: samples.length };
    expectThat(observed, !!fading?.leaving, "the cleared cursor did not start to fade");
    expectThat(
      observed,
      !!cursor?.on && !cursor.leaving && near(cursor, observed.expected),
      "the returning cursor stopped short of its target",
    );
    return observed;
  });

  await check(
    "20 · under reduced motion a cursor that comes back within its fade still lands",
    async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await stillness(page, true);
      try {
        const target = { x: 0.4, y: 0.65 };
        await apply(await activity(main, here, target));
        const swapping = cursorOf(await readLayer(page), main.threadId) ?? null;
        await apply(cleared(main, here));
        await page.clock.runFor(2 * frameMs);
        await apply(await activity(main, here, target));
        await page.clock.runFor(150);
        const view = await readLayer(page);
        const cursor = cursorOf(view, main.threadId) ?? null;
        const observed = { cursor, expected: at(view.picture, target), swapping };
        expectThat(observed, !!swapping?.swap, "the cursor did not start its swap");
        expectThat(
          observed,
          !!cursor?.on && !cursor.swap && !cursor.leaving && near(cursor, observed.expected),
          "the returning cursor stayed unseen or short of its point",
        );
        return observed;
      } finally {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await stillness(page, false);
      }
    },
  );

  await check("19 · a Run that ends takes its cursor with it", async () => {
    await page.evaluate((threadId) => {
      void (Reflect.get(window, "opensteerMock") as MockHostClient).stopRun(threadId);
    }, main.threadId);
    let cursor = cursorOf(await readLayer(page), main.threadId);
    for (let index = 0; index < 120 && cursor; index++) {
      await page.clock.runFor(frameMs);
      await settle(page);
      cursor = cursorOf(await readLayer(page), main.threadId);
    }
    const observed = {
      cursor: cursor ?? null,
      here: await storeRuns(here),
      there: await storeRuns(there),
    };
    expectThat(
      observed,
      observed.cursor === null && !observed.here.includes(main.id),
      "the ended Run's cursor stayed",
    );
    expectThat(
      observed,
      observed.there.includes(delegated.id),
      "another Run of the same thread lost its cursor",
    );
    return observed;
  });
  await check(
    "21 · the viewfinder draws a cursor on the picture point the main view does",
    async () => {
      const viewfinders = await page.locator(browserViewfinder).count();
      const key = viewfinders
        ? await page.locator(browserViewfinder).first().getAttribute("data-place-key")
        : null;
      const pictured = fixture.tabs.find((candidate) => keyOf(candidate) === key);
      if (!pictured) {
        await shot("21-no-viewfinder.png");
        throw new JourneyFailure("no reply shows a page's picture", {
          key,
          slots: await page.locator(".viewfinder-slot").count(),
          turns: await page.locator(".turn").count(),
          viewfinders,
          viewfinderShown,
        });
      }
      // A region narrower than the viewfinder is drawn larger than itself there.
      const region = { width: 200, height: 150 };
      await cropPicture(pictured, region);
      await show(pictured);
      await frames(20);
      await page.evaluate(() =>
        document
          .querySelector(".viewfinder:not(.viewfinder--native)")
          ?.scrollIntoView({ block: "center" }),
      );
      const header = await pictureHeader(pictured);
      const pointer = { x: 0.1, y: 0.1 };
      await apply(await activity(homeRun, pictured, pointer, { home: true }));
      let middle: LayerView | undefined;
      let finder: LayerView | undefined;
      for (let index = 0; index < 120; index++) {
        await page.clock.runFor(frameMs);
        middle = await readLayer(page);
        finder = (await page.locator(viewfinderLayer).count())
          ? await readLayer(page, viewfinderLayer)
          : undefined;
        if (
          cursorOf(middle, homeRun.threadId)?.on &&
          finder &&
          cursorOf(finder, homeRun.threadId)?.on
        )
          break;
      }
      const expected = {
        x: (pointer.x * header.viewportWidth) / region.width,
        y: (pointer.y * header.viewportHeight) / region.height,
      };
      const inMiddle = middle && cursorOf(middle, homeRun.threadId);
      const inFinder = finder && cursorOf(finder, homeRun.threadId);
      const observed = {
        expected,
        finder: inFinder ?? null,
        finderPicture: finder?.picture ?? null,
        middle: inMiddle ?? null,
        middlePicture: middle?.picture ?? null,
      };
      const box = await page.evaluate(() => {
        const rect = document
          .querySelector(".viewfinder:not(.viewfinder--native)")
          ?.getBoundingClientRect();
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      });
      if (box)
        await page.screenshot({
          clip: box,
          path: path.join(artifactDirectory, "21-viewfinder.png"),
        });
      await cropPicture(pictured, null);
      await frames(10);
      expectThat(
        observed,
        !!inMiddle?.on && near(inMiddle, at(middle!.picture, expected)),
        "the main view's cursor is off its picture point",
      );
      expectThat(
        observed,
        !!inFinder?.on &&
          finder!.picture.width > region.width &&
          near(inFinder, at(finder!.picture, expected)),
        "the viewfinder's cursor is off the picture point the main view draws",
      );
      return observed;
    },
  );

  const glass = await context.newPage();
  await glass.setViewportSize({ height: 500, width: 800 });
  // The glass page's bridge, as its preload would expose it: the journey hands it scenes.
  await glass.addInitScript({
    content:
      "window.opensteerGlass={onScene(listener){window.journeyGlassScene=listener;return()=>{window.journeyGlassScene=undefined}}};",
  });
  await glass.clock.install();
  await glass.goto(`${origin}/glass.html`);
  await glass.waitForFunction(() => typeof Reflect.get(window, "journeyGlassScene") === "function");
  await glass.clock.pauseAt((await glass.evaluate(() => Date.now())) + 1_000);
  const glassCursor = (
    run: RunRef,
    x: number,
    y: number,
    options: { readonly home?: boolean; readonly leaving?: boolean } = {},
  ) => ({
    icon: options.home ? null : (fixture.marks[run.threadId]?.icon ?? null),
    color: options.home ? null : (fixture.marks[run.threadId]?.color ?? null),
    home: options.home ?? false,
    leaving: options.leaving ?? false,
    threadId: run.threadId,
    title: options.home ? "Opensteer" : mainTitle,
    x,
    y,
  });
  /** A scene as NativeAgentCursors sends it, its points measured in `geometryRevision`. */
  const sendScene = async (
    cursors: readonly ReturnType<typeof glassCursor>[] | null,
    geometryRevision = 1,
  ) => {
    await glass.evaluate(
      (scene) => (Reflect.get(window, "journeyGlassScene") as (value: unknown) => void)(scene),
      cursors && {
        croppedBottom: false,
        croppedRight: false,
        cursors,
        geometryRevision,
        reducedMotion: false,
      },
    );
    await settle(glass);
  };
  const markGlassCursor = (run: RunRef) =>
    glass.evaluate((id) => {
      const element = document.querySelector<HTMLElement>(
        `.glass-scene .acur[data-thread-id="${id}"]`,
      );
      if (element) element.dataset.journey = "kept";
    }, run.threadId);
  const homeAt = glassCursor(homeRun, 400, 260, { home: true });

  await check(
    "22 · a first glass scene draws its cursors at their points, without gliding or arriving",
    async () => {
      await sendScene([glassCursor(main, 120, 90), homeAt]);
      const samples = [await readLayer(glass, glassLayer), ...(await frames(6, glass, glassLayer))];
      const observed = { first: samples[0]!.cursors };
      expectThat(
        observed,
        samples.every(
          (sample) =>
            sample.animating === "false" &&
            sample.cursors.length === 2 &&
            sample.cursors.every((cursor) => cursor.on && !cursor.arrive) &&
            near(cursorOf(sample, main.threadId)!, { x: 120, y: 90 }) &&
            near(cursorOf(sample, homeRun.threadId)!, homeAt),
        ),
        "a fresh glass did not start from its scene's points",
      );
      await glass.screenshot({ path: path.join(artifactDirectory, "22-glass.png") });
      return observed;
    },
  );

  await check("23 · a glass cursor glides to a new point in the same geometry", async () => {
    await sendScene([glassCursor(main, 300, 200), homeAt]);
    const samples = await untilRest(180, glass, glassLayer);
    const track = samples.map((sample) => cursorOf(sample, main.threadId)!);
    trajectories.glass = track.map(({ x, y }, index) => ({ t: samples[index]!.now, x, y }));
    const intermediate = track.filter(
      (point) => distance(point, { x: 120, y: 90 }) > 1 && distance(point, { x: 300, y: 200 }) > 1,
    ).length;
    const observed = { frames: track.length, intermediate };
    expectThat(observed, intermediate >= 8, "the glass cursor jumped instead of gliding");
    expectThat(observed, near(track.at(-1)!, { x: 300, y: 200 }), "it did not reach its point");
    return observed;
  });

  await check(
    "24 · a glass scene in new page geometry snaps its cursors, with no change of size",
    async () => {
      await markGlassCursor(main);
      const before = await readLayer(glass, glassLayer);
      await sendScene([glassCursor(main, 337.5, 224), homeAt], 2);
      const samples = [
        await readLayer(glass, glassLayer),
        ...(await frames(10, glass, glassLayer)),
      ];
      const snapped = samples.map((sample) => cursorOf(sample, main.threadId)!);
      await sendScene([glassCursor(main, 520, 330), homeAt], 2);
      const moving = cursorOf((await frames(3, glass, glassLayer)).at(-1)!, main.threadId)!;
      await untilRest(180, glass, glassLayer);
      const observed = {
        moving,
        sizeBefore: before.picture,
        sizeAfter: samples[0]!.picture,
        snapped: snapped[0],
      };
      expectThat(
        observed,
        before.picture.width === samples[0]!.picture.width &&
          before.picture.height === samples[0]!.picture.height,
        "the glass changed size",
      );
      expectThat(
        observed,
        snapped.every((cursor) => cursor.mark === "kept" && near(cursor, { x: 337.5, y: 224 })) &&
          samples.every((sample) => sample.animating !== "true"),
        "a scene in new geometry glided instead of snapping",
      );
      expectThat(
        observed,
        distance(moving, { x: 337.5, y: 224 }) > 1 && distance(moving, { x: 520, y: 330 }) > 1,
        "a move in that geometry did not glide",
      );
      return observed;
    },
  );

  await check(
    "25 · a glass resize, and the scene after it, glide when the geometry is unchanged",
    async () => {
      await sendScene([glassCursor(main, 120, 90), homeAt], 2);
      const midGlide = cursorOf((await frames(4, glass, glassLayer)).at(-1)!, main.threadId)!;
      const resized = glass.evaluate(
        () =>
          new Promise<void>((resolve) =>
            window.addEventListener("resize", () => resolve(), { once: true }),
          ),
      );
      await glass.setViewportSize({ height: 560, width: 900 });
      await resized;
      await settle(glass);
      const afterResize = await readLayer(glass, glassLayer);
      const held = cursorOf(afterResize, main.threadId)!;
      await sendScene([glassCursor(main, 600, 400), homeAt], 2);
      const next = cursorOf((await frames(3, glass, glassLayer)).at(-1)!, main.threadId)!;
      await untilRest(180, glass, glassLayer);
      const observed = { held, midGlide, next, size: afterResize.picture };
      expectThat(
        observed,
        afterResize.picture.width === 900 &&
          distance(midGlide, { x: 120, y: 90 }) > 1 &&
          near(held, midGlide) &&
          afterResize.animating === "true",
        "a resize alone snapped a gliding cursor",
      );
      expectThat(
        observed,
        distance(next, held) > 1 && distance(next, { x: 600, y: 400 }) > 1,
        "the scene after a resize, in unchanged geometry, snapped",
      );
      return observed;
    },
  );

  await check("26 · a glass scene that goes and comes back starts afresh", async () => {
    await markGlassCursor(main);
    await sendScene(null);
    const gone = await glass.locator(glassLayer).count();
    await sendScene([glassCursor(main, 520, 330), homeAt], 2);
    const samples = [await readLayer(glass, glassLayer), ...(await frames(6, glass, glassLayer))];
    const track = samples.map((sample) => cursorOf(sample, main.threadId)!);
    const observed = { first: track[0], gone };
    expectThat(observed, gone === 0, "the glass kept its scene while it had none");
    expectThat(
      observed,
      track.every(
        (cursor) =>
          cursor.mark === null && cursor.on && !cursor.arrive && near(cursor, { x: 520, y: 330 }),
      ) && samples.every((sample) => sample.animating === "false"),
      "the glass came back with stale motion instead of afresh",
    );
    return observed;
  });

  await check("27 · a leaving glass cursor fades, and goes when the scene drops it", async () => {
    await sendScene([glassCursor(main, 520, 330, { leaving: true }), homeAt], 2);
    await glass.clock.runFor(400);
    const fading = cursorOf(await readLayer(glass, glassLayer), main.threadId) ?? null;
    await sendScene([homeAt], 2);
    const after = cursorOf(await readLayer(glass, glassLayer), main.threadId) ?? null;
    const observed = { after, fading };
    expectThat(observed, !!fading?.leaving, "the leaving cursor did not fade");
    expectThat(observed, after === null, "the cursor stayed after the scene dropped it");
    return observed;
  });
  await check(
    "28 · the isolated glass redraws an edited symbol and colour from its scene",
    async () => {
      await sendScene([glassCursor(main, 120, 90)], 2);
      const glyph = glass.locator(`.acur[data-thread-id="${main.threadId}"] .workspace-icon-glyph`);
      const before = await glyph.innerHTML();
      await sendScene([{ ...glassCursor(main, 120, 90), icon: "hotel", color: "purple" }], 2);
      const after = await glyph.innerHTML();
      const cursor = cursorOf(await readLayer(glass, glassLayer), main.threadId)!;
      const observed = { before, after, cursor };
      expectThat(
        observed,
        before !== after &&
          sameColour(cursor.color, markColorPaint.purple.cursor) &&
          cursor.name === mainTitle,
        "the glass retained an old symbol, colour or title",
      );
      await glass.screenshot({ path: path.join(artifactDirectory, "glass-task-mark.png") });
      return observed;
    },
  );
  await glass.close();
  await context.close();
} catch (error) {
  abort(error);
} finally {
  await web.close();
}

await writeFile(
  path.join(artifactDirectory, "trajectories.json"),
  `${JSON.stringify(trajectories, null, 2)}\n`,
);
await finishJourney(artifactDirectory, checks, { palette });

/** React renders on its scheduler's message turns: a few turns let it commit. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let turn = 0; turn < 3; turn++)
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      });
  });
}

/** A media query change arrives with the browser's next rendering step, not on React's turns. */
async function stillness(page: Page, still: boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readLayer(page)).still === still) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new JourneyFailure("the layer never learned the motion preference", { still });
}

/** Steps the stopped clock one frame at a time and reads the layer after each. */
async function stepFrames(count: number, page: Page, layer: string): Promise<LayerView[]> {
  const samples: LayerView[] = [];
  for (let index = 0; index < count; index++) {
    await page.clock.runFor(frameMs);
    samples.push(await readLayer(page, layer));
  }
  return samples;
}

/** A cursor layer, over its picture's canvas or, for the glass, over the whole window. */
async function readLayer(page: Page, selector = middleLayer): Promise<LayerView> {
  // No named functions in here: the script runner would wrap them in helpers the page lacks.
  return page.evaluate((query) => {
    const layer = document.querySelector<HTMLElement>(query);
    if (!layer) throw new Error(`The page has no cursor layer ${query}.`);
    const canvas = layer.parentElement?.querySelector("canvas");
    const origin = layer.getBoundingClientRect();
    const picture = (canvas ?? layer).getBoundingClientRect();
    return {
      now: performance.now(),
      animating: layer.dataset.animating ?? null,
      still: layer.classList.contains("cursor-layer--still"),
      picture: {
        left: picture.left - origin.left,
        top: picture.top - origin.top,
        width: picture.width,
        height: picture.height,
      },
      cursors: [...layer.querySelectorAll<HTMLElement>(".acur")].map((element) => {
        const matrix = new DOMMatrix(element.style.transform || "none");
        const label = element.querySelector<HTMLElement>(".acur__name")!;
        const box = label.getBoundingClientRect();
        const classes = element.classList;
        return {
          id: element.dataset.threadId ?? "",
          x: matrix.m41,
          y: matrix.m42,
          on: classes.contains("acur--on"),
          quiet: classes.contains("acur--quiet"),
          leaving: classes.contains("acur--leaving"),
          swap: classes.contains("acur--swap"),
          flipX: classes.contains("acur--flip-x"),
          flipY: classes.contains("acur--flip-y"),
          arrive: classes.contains("acur--arrive"),
          mark: element.dataset.journey ?? null,
          name: label.textContent ?? "",
          label: {
            left: box.left - origin.left,
            top: box.top - origin.top,
            width: box.width,
            height: box.height,
          },
          labelOpacity: getComputedStyle(label).opacity,
          color: getComputedStyle(element).color,
          labelBackground: getComputedStyle(label).backgroundColor,
          labelColor: getComputedStyle(label).color,
        };
      }),
    };
  }, selector);
}

async function layerOrigin(page: Page): Promise<Point> {
  return page.evaluate(() => {
    const rect = document
      .querySelector(".browser-stage .cursor-layer--middle")!
      .getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
}

function cursorOf(view: LayerView, id: string): CursorView | undefined {
  return view.cursors.find((cursor) => cursor.id === id);
}

function at(picture: Rect, point: Point): Point {
  return { x: picture.left + point.x * picture.width, y: picture.top + point.y * picture.height };
}

/**
 * The same point: a picture's rectangle is laid out in 1/64 px units and a
 * cursor is written to 1/100 px, so they agree to within those two roundings.
 */
function near(a: Point, b: Point): boolean {
  const tolerance = 2 / 64 + 0.01;
  return Math.abs(a.x - b.x) < tolerance && Math.abs(a.y - b.y) < tolerance;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function channels(colour: string): readonly number[] {
  const hex = /^#([0-9a-f]{6})$/iu.exec(colour)?.[1];
  if (hex) return [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(colour);
  if (!rgb) throw new Error(`Unreadable colour ${colour}`);
  return rgb.slice(1, 4).map(Number);
}

function sameColour(a: string, b: string): boolean {
  const [x, y] = [channels(a), channels(b)];
  return x.every((value, index) => value === y[index]);
}

/** WCAG contrast of white text on this colour. */
function contrast(colour: string): number {
  const [r, g, b] = channels(colour).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * r! + 0.7152 * g! + 0.0722 * b! + 0.05);
}
