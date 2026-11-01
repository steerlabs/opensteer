import { nativeRuntimeProfile } from "./native-profile.test-support.js";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  browserFrameFits,
  browserFrameLimits,
  defaultBrowserViewport,
  type CdpParameters,
} from "@opensteer/browser-core";
import { delay } from "@opensteer/shared/delay";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { BrowserRuntime, BrowserRuntimeServer } from "@opensteer/browser-runtime-core";
import {
  FakeSink,
  FakeTicketVerifier,
  testSessionFilesRoot,
  validClaims,
} from "@opensteer/browser-runtime-core/test-support";
import {
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  type BrowserClientMessage,
  type BrowserServerMessage,
  type BrowserSurfaceId,
} from "@opensteer/protocol";

import {
  TestChromiumLauncher as PlaywrightChromiumLauncher,
  browserTestSignal,
  cleanup,
  waitForBrowserMessages,
  waitForLedgerState,
} from "./browser-test-lifecycle.js";

import {
  asRecord,
  closeBackgroundTab,
  evaluationValue,
  executablePath,
  expectPictureRepaired,
  jpegSize,
  redBoxInFrame,
  rootCdpNavigate,
  runHarness,
  sameShape,
  sendAsAgent,
  serveFollowFixture,
  shownDialog,
  startFollowSession,
  startHarnessBridge,
  waitFor,
  waitForAsync,
  type PageSizeRequest,
  type PageState,
  type PictureBox,
  type PointerEntry,
  type TimedFrame,
} from "./chromium.test-support.js";
/**
 * A page is the size of the person's view, as a window is, and an agent may
 * lay its own size over it with standard CDP. Real Chromium, the session's
 * router, ledger and controller, as the Browser Runtime wires them; every
 * size write the ledger sends and every cast it starts is recorded, so the
 * report shows what was asked for next to what Chromium was told.
 */
describe("real Chromium pages follow the person's view", () => {
  const followReport: Record<string, unknown> = {};

  afterAll(async () => {
    const directory =
      process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-browser-follow-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "chromium-follow-view.json"),
      `${JSON.stringify(
        {
          engine: "chromium",
          executablePath,
          generatedAt: new Date().toISOString(),
          defaultBrowserViewport,
          browserFrameLimits,
          ...followReport,
        },
        null,
        2,
      )}\n`,
    );
  });

  it("starts each page at the size the person's view last followed and writes nothing that changes nothing", async () => {
    const session = await startFollowSession();
    const root = session.rootSurfaceId;
    await session.controller.handle({ type: "stream.subscribe" });

    // The session starts at the panel's default page area, so opening
    // the panel at the default window resizes nothing.
    const startSize = await session.pageState(root);
    expect(startSize).toMatchObject(defaultBrowserViewport);
    await session.frameAt(root, defaultBrowserViewport);
    const writesAtStart = session.metricsWrites(root).length;
    const castsAtStart = session.screencastStarts(root).length;
    await session.follow(root, defaultBrowserViewport);
    const defaultFollowWrote = session.metricsWrites(root).length - writesAtStart;
    expect(defaultFollowWrote).toBe(0);
    expect(session.screencastStarts(root)).toHaveLength(castsAtStart);

    // The person's view follows: the page takes the size and is pictured at it.
    await session.follow(root, { width: 1_000, height: 700 });
    expect(await session.pageState(root)).toMatchObject({
      width: 1_000,
      height: 700,
    });
    const followed = await session.frameAt(root, {
      width: 1_000,
      height: 700,
    });
    expect(session.metricsWrites(root).at(-1)).toEqual({
      deviceScaleFactor: 1,
      height: 700,
      mobile: false,
      screenHeight: 1_080,
      screenWidth: 1_920,
      width: 1_000,
    });

    // The same size again, and again after the viewer reconnects,
    // reaches no page and restarts no cast.
    const writesBeforeRepeat = session.metricsWrites(root).length;
    const castsBeforeRepeat = session.screencastStarts(root).length;
    await session.follow(root, { width: 1_000, height: 700 });
    await session.follow(root, { width: 1_000, height: 700 });
    const castsAfterRepeat = session.screencastStarts(root).length;
    await session.controller.handle({ type: "stream.unsubscribe" });
    await session.controller.handle({ type: "stream.subscribe" });
    await session.follow(root, { width: 1_000, height: 700 });
    const repeatWrites = session.metricsWrites(root).length - writesBeforeRepeat;
    expect(repeatWrites).toBe(0);
    expect(castsAfterRepeat).toBe(castsBeforeRepeat);

    // A phone's Fit and its new tab size the page they name, never where
    // the session's next pages start.
    await session.fit(root, { width: 390, height: 700 });
    expect(await session.pageState(root)).toMatchObject({
      width: 390,
      height: 700,
    });
    await session.controller.handle({
      type: "surface.open",
      viewport: { width: 390, height: 700 },
    });
    const phoneTab = session.ledger.active();
    if (!phoneTab || phoneTab.surface.id === root) throw new Error("Missing the phone's tab");
    const phoneTabSize = await session.pageState(phoneTab.surface.id);
    expect(phoneTabSize).toMatchObject({ width: 390, height: 700 });

    // A tab the agent opens, and one the person opens without a size,
    // start at the size the person's view last followed.
    // As Browser Harness's newTab() does: a blank tab, then the address.
    const created = asRecord(await session.agent("Target.createTarget", { url: "about:blank" }));
    const createdTargetId = String(created.targetId);
    const createdSurfaceId = session.ledger.surfaceIdForTarget(createdTargetId);
    if (!createdSurfaceId) throw new Error("The agent's tab is not one of the session's pages.");
    const createdAttach = asRecord(
      await session.agent("Target.attachToTarget", {
        flatten: true,
        targetId: createdTargetId,
      }),
    );
    await session.agent(
      "Page.navigate",
      { url: `${session.origin}/plain` },
      String(createdAttach.sessionId),
    );
    await session.loaded(createdSurfaceId);
    const agentTab = await session.pageState(createdSurfaceId);
    const agentTabLoad = await session.read(createdSurfaceId, "window.loadSize");
    expect(agentTab).toMatchObject({ width: 1_000, height: 700 });
    expect(agentTabLoad).toEqual({ width: 1_000, height: 700 });
    expect(session.metricsWrites(createdSurfaceId)).toHaveLength(1);
    // An agent may name the address at creation: the tab still lays out
    // at the followed size from its first script on, and never reflows.
    const createdWithUrl = asRecord(
      await session.agent("Target.createTarget", {
        url: `${session.origin}/plain?created`,
      }),
    );
    const createdWithUrlSurface = session.ledger.surfaceIdForTarget(
      String(createdWithUrl.targetId),
    );
    if (!createdWithUrlSurface) throw new Error("The agent's second tab is not the session's.");
    await session.loaded(createdWithUrlSurface);
    const agentTabCreatedWithUrl = {
      load: await session.read(createdWithUrlSurface, "window.loadSize"),
      resizes: await session.read(createdWithUrlSurface, "window.resizes"),
      now: await session.pageState(createdWithUrlSurface),
    };
    expect(agentTabCreatedWithUrl.load).toEqual({
      width: 1_000,
      height: 700,
    });
    expect(agentTabCreatedWithUrl.resizes).toEqual([]);
    expect(session.metricsWrites(createdWithUrlSurface)).toHaveLength(1);
    // An address CDP may not open is refused as before, and opens no tab.
    const pagesBeforeRefusal = session.ledger.snapshot().length;
    const unsafeTab = await session.agent("Target.createTarget", { url: "file:///etc/hosts" }).then(
      () => null,
      (error: unknown) => error as Error & { code?: string },
    );
    expect(unsafeTab?.code).toBe("forbidden");
    expect(unsafeTab?.message).toBe(
      "CDP navigation is limited to HTTP and HTTPS URLs without embedded credentials.",
    );
    expect(session.ledger.snapshot()).toHaveLength(pagesBeforeRefusal);
    await session.controller.handle({
      type: "surface.open",
      url: `${session.origin}/plain`,
    });
    const unsizedTab = session.ledger.active();
    if (!unsizedTab || unsizedTab.surface.id === phoneTab.surface.id) {
      throw new Error("Missing the person's unsized tab");
    }
    await session.loaded(unsizedTab.surface.id);
    const unsizedTabSize = await session.pageState(unsizedTab.surface.id);
    expect(unsizedTabSize).toMatchObject({ width: 1_000, height: 700 });

    // A popup starts at the size its opener shows, an agent's size
    // over the opener included.
    const rootAttach = asRecord(
      await session.agent("Target.attachToTarget", {
        flatten: true,
        targetId: session.rootTargetId,
      }),
    );
    const rootSession = String(rootAttach.sessionId);
    await session.agent("Page.navigate", { url: `${session.origin}/plain` }, rootSession);
    await session.loaded(root);
    const popupFromFit = await session.openPopup(rootSession);
    expect(await session.pageState(popupFromFit)).toMatchObject({
      width: 390,
      height: 700,
    });
    await session.agent(
      "Emulation.setDeviceMetricsOverride",
      { deviceScaleFactor: 1, height: 400, mobile: false, width: 600 },
      rootSession,
    );
    const popupFromAgentSize = await session.openPopup(rootSession);
    const popupFromAgentSizeState = await session.pageState(popupFromAgentSize);
    expect(popupFromAgentSizeState).toMatchObject({
      width: 600,
      height: 400,
    });
    expect(session.errors()).toEqual([]);

    followReport.startingSizes = {
      sessionStart: startSize,
      followOfDefaultWrote: defaultFollowWrote,
      followed: {
        requested: { width: 1_000, height: 700 },
        frame: followed.header,
      },
      repeatedFollow: {
        metricsWrites: repeatWrites,
        castRestarts: castsAfterRepeat - castsBeforeRepeat,
      },
      phoneFitThenPhoneTab: phoneTabSize,
      agentTabAfterPhoneFit: {
        size: agentTab,
        loadSize: agentTabLoad,
        metricsWrites: session.metricsWrites(createdSurfaceId),
      },
      agentTabCreatedWithUrl,
      unsafeTabRefused: {
        code: unsafeTab?.code,
        message: unsafeTab?.message,
      },
      personTabWithoutSize: unsizedTabSize,
      popupOfFittedOpener: await session.pageState(popupFromFit),
      popupOfOpenerUnderAgentSize: popupFromAgentSizeState,
      passed: true,
    };
  }, 60_000);

  it("keeps an agent's own size over the person's and returns to the person's current size", async () => {
    const session = await startFollowSession({ path: "/mobile" });
    const root = session.rootSurfaceId;
    const attach = asRecord(
      await session.agent("Target.attachToTarget", {
        flatten: true,
        targetId: session.rootTargetId,
      }),
    );
    const page = String(attach.sessionId);
    const cases: Record<string, unknown>[] = [];
    const metrics = async (
      label: string,
      requested: CdpParameters | null,
      expected: Partial<PageState>,
    ) => {
      if (requested) {
        await session.agent("Emulation.setDeviceMetricsOverride", requested, page);
      } else {
        await session.agent("Emulation.clearDeviceMetricsOverride", {}, page);
      }
      const state = await session.pageState(root);
      cases.push({
        label,
        requested,
        applied: session.metricsWrites(root).at(-1),
        state,
      });
      expect(state, label).toMatchObject(expected);
    };
    const follow = async (label: string, size: PageSizeRequest, expected: Partial<PageState>) => {
      await session.follow(root, size);
      const state = await session.pageState(root);
      cases.push({
        label,
        followed: size,
        applied: session.metricsWrites(root).at(-1),
        state,
      });
      expect(state, label).toMatchObject(expected);
    };

    // The tab says whether an agent's size stands over it, in the ledger
    // and in the latest list the viewer received.
    const sizedByAgentLog: Record<string, unknown>[] = [];
    const expectSizedByAgent = async (label: string, expected: boolean) => {
      const listed = () => {
        const latest = session.sink.messages
          .filter((message) => message.type === "browser.surfaces.changed")
          .at(-1);
        return latest?.type === "browser.surfaces.changed"
          ? latest.surfaces.find((surface) => surface.id === root)?.sizedByAgent
          : undefined;
      };
      await waitFor(() => listed() === expected);
      const inLedger = session.ledger.snapshot().find((surface) => surface.id === root);
      expect(inLedger?.sizedByAgent, label).toBe(expected);
      sizedByAgentLog.push({
        label,
        ledger: inLedger?.sizedByAgent,
        listed: listed(),
      });
    };
    expect(session.ledger.snapshot().find((surface) => surface.id === root)).toMatchObject({
      sizedByAgent: false,
    });

    await session.follow(root, { width: 1_000, height: 700 });
    // Positive dimensions are the agent's and survive the panel.
    await metrics(
      "fixed size",
      { deviceScaleFactor: 1, height: 400, mobile: false, width: 600 },
      { width: 600, height: 400 },
    );
    await expectSizedByAgent("agent sized the page", true);
    await follow(
      "panel resized under a fixed size",
      { width: 900, height: 650 },
      {
        width: 600,
        height: 400,
      },
    );
    await expectSizedByAgent("the panel never takes the agent's size away", true);
    // A clear returns to the person's size now, not the one it covered.
    await metrics("clear", null, { width: 900, height: 650, dpr: 1 });
    await expectSizedByAgent("agent cleared its size", false);
    // A zero dimension keeps following the panel.
    await metrics(
      "width 0",
      { deviceScaleFactor: 1, height: 500, mobile: false, width: 0 },
      { width: 900, height: 500 },
    );
    await expectSizedByAgent("a partly following size is still the agent's", true);
    await follow(
      "panel resized under width 0",
      { width: 980, height: 660 },
      {
        width: 980,
        height: 500,
      },
    );
    await metrics(
      "height 0",
      { deviceScaleFactor: 1, height: 0, mobile: false, width: 640 },
      { width: 640, height: 660 },
    );
    await follow(
      "panel resized under height 0",
      { width: 960, height: 640 },
      {
        width: 640,
        height: 640,
      },
    );
    await metrics(
      "both 0",
      { deviceScaleFactor: 1, height: 0, mobile: false, width: 0 },
      { width: 960, height: 640 },
    );
    await follow(
      "panel resized under both 0",
      { width: 1_000, height: 700 },
      {
        width: 1_000,
        height: 700,
      },
    );
    await metrics(
      "deviceScaleFactor 0",
      { deviceScaleFactor: 0, height: 400, mobile: false, width: 600 },
      { width: 600, height: 400, dpr: 1 },
    );
    expect(session.metricsWrites(root).at(-1)).toMatchObject({
      deviceScaleFactor: 1,
    });
    // A phone layout keeps its scale and screen while following the panel.
    await metrics(
      "mobile, screen and scale, following the panel",
      {
        deviceScaleFactor: 2,
        height: 0,
        mobile: true,
        screenHeight: 800,
        screenWidth: 500,
        width: 0,
      },
      {
        width: 1_000,
        height: 700,
        dpr: 2,
        screenWidth: 500,
        screenHeight: 800,
      },
    );
    await follow(
      "panel resized under a phone layout",
      { width: 900, height: 650 },
      {
        width: 900,
        height: 650,
        dpr: 2,
        screenWidth: 500,
        screenHeight: 800,
      },
    );
    await metrics(
      "phone at a fixed size",
      {
        deviceScaleFactor: 3,
        height: 844,
        mobile: true,
        screenHeight: 844,
        screenWidth: 390,
        width: 390,
      },
      {
        width: 390,
        height: 844,
        dpr: 3,
        screenWidth: 390,
        screenHeight: 844,
      },
    );
    await follow(
      "panel resized under a fixed phone",
      { width: 1_000, height: 700 },
      {
        width: 390,
        height: 844,
        dpr: 3,
        screenWidth: 390,
      },
    );
    // A new request replaces the last one whole: nothing of the phone stays.
    await metrics(
      "replaced whole",
      { deviceScaleFactor: 1, height: 0, mobile: false, width: 0 },
      { width: 1_000, height: 700, dpr: 1 },
    );
    const replaced = session.metricsWrites(root).at(-1);
    // A request that names no screen keeps the person's.
    expect(replaced).toMatchObject({ mobile: false, screenHeight: 1_080, screenWidth: 1_920 });

    // dontSetVisibleSize would lay a page out at a size no one sees.
    const writesBeforeRefusal = session.metricsWrites(root).length;
    const refusal = await session
      .agent(
        "Emulation.setDeviceMetricsOverride",
        {
          deviceScaleFactor: 1,
          dontSetVisibleSize: true,
          height: 300,
          mobile: false,
          width: 300,
        },
        page,
      )
      .then(
        () => null,
        (error: unknown) => error as Error & { code?: string },
      );
    expect(refusal?.message).toBe(
      "dontSetVisibleSize is not supported: Opensteer shows the size a page is laid out at.",
    );
    expect(refusal?.code).toBe("bad_message");
    expect(session.metricsWrites(root)).toHaveLength(writesBeforeRefusal);
    expect(await session.pageState(root)).toMatchObject({
      width: 1_000,
      height: 700,
    });

    // Zero dimensions never follow a panel past the frame bound; the
    // agent's size stays put, and a request that would cross it is refused.
    await metrics(
      "scale 2 following the panel",
      { deviceScaleFactor: 2, height: 0, mobile: false, width: 0 },
      { width: 1_000, height: 700, dpr: 2 },
    );
    const writesBeforeHugePanel = session.metricsWrites(root).length;
    await follow(
      "panel past the frame bound at scale 2",
      { width: 3_800, height: 2_100 },
      {
        width: 1_000,
        height: 700,
        dpr: 2,
      },
    );
    expect(session.metricsWrites(root)).toHaveLength(writesBeforeHugePanel);
    const tooLarge = await session
      .agent(
        "Emulation.setDeviceMetricsOverride",
        { deviceScaleFactor: 3, height: 0, mobile: false, width: 0 },
        page,
      )
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
    expect(tooLarge?.message).toBe("CDP device metrics exceed the bounded browser frame size.");

    // The person's Fit takes the page back from an agent that left it small.
    await metrics(
      "agent leaves the page small",
      { deviceScaleFactor: 1, height: 200, mobile: false, width: 320 },
      { width: 320, height: 200 },
    );
    await session.fit(root, { width: 1_000, height: 700 });
    const afterFit = await session.pageState(root);
    expect(afterFit).toMatchObject({ width: 1_000, height: 700, dpr: 1 });
    await expectSizedByAgent("the person's fit removed the agent's size", false);
    await follow(
      "panel resized after the Fit",
      { width: 900, height: 650 },
      {
        width: 900,
        height: 650,
      },
    );
    expect(session.errors()).toEqual([]);
    followReport.agentSizes = {
      sizedByAgent: sizedByAgentLog,
      cases,
      refusal: refusal?.message,
      tooLarge: tooLarge?.message,
      afterFit,
      passed: true,
    };
  }, 60_000);

  it("never ends a held press or restarts the stream for a size write that changes nothing", async () => {
    const session = await startFollowSession({ path: "/press" });
    const root = session.rootSurfaceId;
    await session.controller.handle({ type: "stream.subscribe" });
    await session.follow(root, { width: 900, height: 650 });
    await session.frameAt(root, { width: 900, height: 650 });
    const shown = { width: 900, height: 650 };
    const pointer = (action: "down" | "move" | "up", at: PageSizeRequest, x = 0.5, y = 0.5) =>
      session.controller.handle({
        action,
        button: action === "move" ? "none" : "left",
        ...(action === "move" ? {} : { clickCount: 1 }),
        surfaceId: root,
        type: "input.pointer",
        viewportHeight: at.height,
        viewportWidth: at.width,
        x,
        y,
      });
    const casts = () => session.screencastStarts(root).length;
    const pressLog = async () => (await session.read(root, "window.pointerLog")) as PointerEntry[];
    await session.read(root, "window.pointerLog = []");

    // The same size while the person holds the button: the press survives.
    const castsBefore = casts();
    await pointer("down", shown);
    await session.follow(root, shown);
    await pointer("move", shown, 0.6, 0.6);
    const heldThroughNoOp = (await pressLog()).at(-1);
    expect(heldThroughNoOp).toMatchObject({ type: "mousemove", buttons: 1 });
    await pointer("up", shown, 0.6, 0.6);
    expect((await pressLog()).filter((entry) => entry.type === "mouseup")).toHaveLength(1);
    expect(casts()).toBe(castsBefore);

    // The panel resizes under the agent's fixed size: the page shows the
    // same thing, so the press survives and the cast keeps running.
    const attach = asRecord(
      await session.agent("Target.attachToTarget", {
        flatten: true,
        targetId: session.rootTargetId,
      }),
    );
    const page = String(attach.sessionId);
    await session.agent(
      "Emulation.setDeviceMetricsOverride",
      { deviceScaleFactor: 1, height: 500, mobile: false, width: 700 },
      page,
    );
    const agentShown = { width: 700, height: 500 };
    await session.frameAt(root, agentShown);
    await session.read(root, "window.pointerLog = []");
    const castsUnderAgent = casts();
    const writesUnderAgent = session.metricsWrites(root).length;
    await pointer("down", agentShown);
    await session.follow(root, { width: 1_000, height: 700 });
    await pointer("move", agentShown, 0.6, 0.6);
    const heldUnderAgentSize = (await pressLog()).at(-1);
    expect(heldUnderAgentSize).toMatchObject({
      type: "mousemove",
      buttons: 1,
    });
    await pointer("up", agentShown, 0.6, 0.6);
    expect(casts()).toBe(castsUnderAgent);
    expect(session.metricsWrites(root)).toHaveLength(writesUnderAgent);
    // The agent's clear returns to the size the panel has now.
    await session.agent("Emulation.clearDeviceMetricsOverride", {}, page);
    expect(await session.pageState(root)).toMatchObject({
      width: 1_000,
      height: 700,
    });
    await session.frameAt(root, { width: 1_000, height: 700 });

    // The control: a write that changes the page does end the press first.
    await session.read(root, "window.pointerLog = []");
    const now = { width: 1_000, height: 700 };
    await pointer("down", now);
    await session.follow(root, { width: 950, height: 650 });
    await pointer("move", { width: 950, height: 650 }, 0.6, 0.6);
    const changedLog = await pressLog();
    expect(
      changedLog.filter((entry) => entry.type !== "mousemove").map((entry) => entry.type),
    ).toEqual(["mousedown", "mouseup"]);
    expect(changedLog.at(-1)).toMatchObject({
      type: "mousemove",
      buttons: 0,
    });
    expect(session.errors()).toEqual([]);
    followReport.heldPress = {
      heldThroughNoOpFollow: heldThroughNoOp,
      heldThroughFollowUnderAgentSize: heldUnderAgentSize,
      castRestartsForNoOps: 0,
      changingFollowReleasedFirst: changedLog,
      passed: true,
    };
  }, 60_000);

  it("applies a dragged size in order, coalescing only sizes still waiting", async () => {
    const session = await startFollowSession({ path: "/press" });
    const root = session.rootSurfaceId;
    await session.controller.handle({ type: "stream.subscribe" });
    await session.frameAt(root, defaultBrowserViewport);

    // A burst far past the 128-command queue, sent without waiting.
    const writesBeforeBurst = session.metricsWrites(root).length;
    const burst: Promise<void>[] = [];
    for (let step = 0; step < 300; step += 1) {
      const width = step === 299 ? 1_000 : 600 + (step % 380);
      burst.push(session.follow(root, { width, height: 700 }));
    }
    await Promise.all(burst);
    const burstWrites = session.metricsWrites(root).length - writesBeforeBurst;
    expect(burstWrites).toBeLessThanOrEqual(3);
    expect(await session.pageState(root)).toMatchObject({
      width: 1_000,
      height: 700,
    });
    await session.frameAt(root, { width: 1_000, height: 700 });
    expect(session.errors()).toEqual([]);

    // A click between two sizes lands at the size before it, then the
    // later sizes apply; none moves across it.
    await session.read(root, "window.pointerLog = []");
    const between = { width: 820, height: 610 };
    const ordered = [
      session.follow(root, { width: 800, height: 600 }),
      session.follow(root, between),
      session.controller.handle({
        action: "down",
        button: "left",
        clickCount: 1,
        surfaceId: root,
        type: "input.pointer",
        viewportHeight: between.height,
        viewportWidth: between.width,
        x: 0.5,
        y: 0.5,
      }),
      session.controller.handle({
        action: "up",
        button: "left",
        clickCount: 1,
        surfaceId: root,
        type: "input.pointer",
        viewportHeight: between.height,
        viewportWidth: between.width,
        x: 0.5,
        y: 0.5,
      }),
      session.follow(root, { width: 840, height: 620 }),
      session.follow(root, { width: 860, height: 630 }),
    ];
    await Promise.all(ordered);
    const clicks = ((await session.read(root, "window.pointerLog")) as PointerEntry[]).filter(
      (entry) => entry.type === "mousedown",
    );
    expect(clicks).toEqual([expect.objectContaining({ width: 820, height: 610, x: 410, y: 305 })]);
    expect(await session.pageState(root)).toMatchObject({
      width: 860,
      height: 630,
    });

    // A sustained drag keeps pictures coming, and the last size is
    // pictured soon after the drag ends.
    const dragSizes = Array.from({ length: 40 }, (_, index) => ({
      width: 600 + index * 10 + (index === 39 ? 10 : 0),
      height: 700,
    }));
    const dragFramesStart = session.frames.length;
    const dragStarted = performance.now();
    const dragging: Promise<void>[] = [];
    let lastFollowSent = dragStarted;
    for (const size of dragSizes) {
      lastFollowSent = performance.now();
      dragging.push(session.follow(root, size));
      await delay(50, browserTestSignal());
    }
    const dragEnded = performance.now();
    // A press aimed at a picture from the start of the drag is refused.
    await session.read(root, "window.pointerLog = []");
    await session.controller.handle({
      action: "down",
      button: "left",
      clickCount: 1,
      surfaceId: root,
      type: "input.pointer",
      viewportHeight: dragSizes[0]!.height,
      viewportWidth: dragSizes[0]!.width,
      x: 0.5,
      y: 0.5,
    });
    await Promise.all(dragging);
    const finalSize = dragSizes.at(-1)!;
    const finalFrame = await session.frameAt(root, finalSize, lastFollowSent);
    const finalFrameMs = Math.round(finalFrame.at - lastFollowSent);
    const dragFrames = session.frames
      .slice(dragFramesStart)
      .filter((frame) => frame.at >= dragStarted && frame.at <= dragEnded);
    const stalePress = ((await session.read(root, "window.pointerLog")) as PointerEntry[]).filter(
      (entry) => entry.type === "mousedown",
    );
    expect(dragFrames.length).toBeGreaterThan(0);
    // No picture from before a resize is labeled with the size after it.
    expect(dragFrames.filter((frame) => !sameShape(frame.header))).toEqual([]);
    expect(finalFrameMs).toBeLessThan(2_000);
    expect(stalePress).toEqual([]);
    expect(await session.pageState(root)).toMatchObject(finalSize);
    expect(session.errors()).toEqual([]);
    followReport.drag = {
      burst: { follows: 300, metricsWrites: burstWrites, queueErrors: 0 },
      clickBetweenSizes: clicks,
      sustained: {
        follows: dragSizes.length,
        durationMs: Math.round(dragEnded - dragStarted),
        framesDuringDrag: dragFrames.length,
        frameTimesMs: dragFrames.map((frame) => Math.round(frame.at - dragStarted)),
        frameSizesDuringDrag: dragFrames.map(
          (frame) =>
            `${frame.header.viewportWidth}x${frame.header.viewportHeight} raster ${frame.header.rasterWidth}x${frame.header.rasterHeight}`,
        ),
        // A picture whose shape is not its page's: pixels from before a
        // resize, labeled with the size after it.
        framesWithAnotherShape: dragFrames.filter((frame) => !sameShape(frame.header)).length,
        metricsWrites: session
          .metricsWrites(root)
          .slice(-dragSizes.length)
          .map((metrics) => `${String(metrics.width)}x${String(metrics.height)}`),
        finalSize,
        finalFrameAfterLastFollowMs: finalFrameMs,
      },
      staleFramePressRefused: stalePress.length === 0,
      passed: true,
    };
  }, 60_000);

  it("tells the agent once that the person resized a page, apart from their input", async () => {
    const session = await startFollowSession();
    const root = session.rootSurfaceId;
    const targetId = session.rootTargetId;
    const attach = asRecord(
      await session.agent("Target.attachToTarget", {
        flatten: true,
        targetId,
      }),
    );
    const page = String(attach.sessionId);
    await session.agent("Page.navigate", { url: `${session.origin}/plain` }, page);
    await session.loaded(root);
    const info = async () =>
      asRecord(asRecord(await session.agent("Target.getTargetInfo", { targetId })).targetInfo);

    await session.follow(root, { width: 1_000, height: 700 });
    const afterFollow = await info();
    expect(afterFollow.pageResize).toMatchObject({
      width: 1_000,
      height: 700,
      sinceLastAgentCommand: true,
    });
    expect(afterFollow).not.toHaveProperty("userActivity");

    // A click, then a resize: each is reported, neither masks the other.
    for (const action of ["down", "up"] as const) {
      await session.controller.handle({
        action,
        button: "left",
        clickCount: 1,
        surfaceId: root,
        type: "input.pointer",
        viewportHeight: 700,
        viewportWidth: 1_000,
        x: 0.25,
        y: 0.25,
      });
    }
    await session.follow(root, { width: 900, height: 650 });
    const afterClickAndResize = await info();
    expect(afterClickAndResize).toMatchObject({
      pageResize: { width: 900, height: 650, sinceLastAgentCommand: true },
      userActivity: {
        kind: "click",
        x: 250,
        y: 175,
        sinceLastAgentCommand: true,
      },
    });

    // Only the person's view counts as a resize: an agent's size, a write
    // that changes nothing, and the agent's clear record none.
    await session.agent("Runtime.evaluate", { expression: "1" }, page);
    const seen = asRecord((await info()).pageResize);
    expect(seen.sinceLastAgentCommand).toBe(false);
    await session.agent(
      "Emulation.setDeviceMetricsOverride",
      { deviceScaleFactor: 1, height: 500, mobile: false, width: 700 },
      page,
    );
    await session.follow(root, { width: 1_000, height: 700 });
    await session.agent("Emulation.clearDeviceMetricsOverride", {}, page);
    expect(await session.pageState(root)).toMatchObject({
      width: 1_000,
      height: 700,
    });
    const afterAgentWork = asRecord((await info()).pageResize);
    expect(afterAgentWork).toMatchObject({
      at: seen.at,
      width: 900,
      height: 650,
    });

    // A popup the page opens after a resize, with no click since the
    // agent's command, stays behind the person's view.
    await session.agent(
      "Runtime.evaluate",
      {
        expression: `setTimeout(() => window.open(${JSON.stringify(`${session.origin}/plain?late`)}, "_blank"), 400); true`,
      },
      page,
    );
    await session.follow(root, { width: 980, height: 660 });
    await waitFor(() => session.ledger.snapshot().some((surface) => surface.openerId != null));
    await delay(200, browserTestSignal());
    const popupStayedBehind = session.ledger.active()?.surface.id === root;
    expect(popupStayedBehind).toBe(true);

    // Browser Harness says it once.
    const bridge = await startHarnessBridge(
      (method, parameters, sessionId) => session.agent(method, parameters, sessionId),
      session.sink,
    );
    cleanup.push(() => bridge.close());
    const program = "console.log(JSON.stringify(await pageInfo()))";
    const told = await runHarness(bridge.url, session.claims.sessionId, targetId, program);
    expect(told.stderr).toMatch(
      /^\[opensteer\] The person resized this page to 980×660 \d+s ago\. Look at the page again before continuing\.\n$/u,
    );
    expect(JSON.parse(told.stdout)).toMatchObject({
      pageResize: { width: 980, height: 660, sinceLastAgentCommand: true },
    });
    const toldAgain = await runHarness(bridge.url, session.claims.sessionId, targetId, program);
    expect(toldAgain.stderr).toBe("");

    // A fit that takes away the agent's size is a change the agent hears of,
    // even when the page keeps its size.
    await session.agent(
      "Emulation.setDeviceMetricsOverride",
      { deviceScaleFactor: 1, height: 660, mobile: false, width: 980 },
      page,
    );
    await session.fit(root, { width: 980, height: 660 });
    expect(await session.pageState(root)).toMatchObject({
      width: 980,
      height: 660,
    });
    const afterFit = asRecord((await info()).pageResize);
    expect(afterFit).toMatchObject({
      agentSizeRemoved: true,
      height: 660,
      sinceLastAgentCommand: true,
      width: 980,
    });
    const toldFit = await runHarness(bridge.url, session.claims.sessionId, targetId, program);
    expect(toldFit.stderr).toMatch(
      /^\[opensteer\] The person fit this page to their view \(980×660\) \d+s ago, removing the size an agent set\. Look at the page again before continuing\.\n$/u,
    );
    const toldFitAgain = await runHarness(bridge.url, session.claims.sessionId, targetId, program);
    expect(toldFitAgain.stderr).toBe("");
    // A fit with no agent size over the page, at the size it shows, is no news.
    await session.fit(root, { width: 980, height: 660 });
    const quietFit = asRecord((await info()).pageResize);
    expect(quietFit.at).toBe(afterFit.at);
    expect(session.errors()).toEqual([]);
    followReport.resizeNotice = {
      fitRemovingAgentSize: {
        pageResize: afterFit,
        harnessLine: toldFit.stderr.trim(),
      },
      sameSizeFitWithoutAgentSize: quietFit,
      afterFollow: afterFollow.pageResize,
      afterClickAndResize: {
        pageResize: afterClickAndResize.pageResize,
        userActivity: afterClickAndResize.userActivity,
      },
      afterAgentSizeNoOpAndClear: afterAgentWork,
      popupAfterResizeStayedBehind: popupStayedBehind,
      harnessLine: told.stderr.trim(),
      harnessLineRepeated: toldAgain.stderr !== "",
      passed: true,
    };
  }, 60_000);

  it("pictures a page at its whole size, scrollbar included, at up to twice its pixels", async () => {
    const session = await startFollowSession({ path: "/scrollbar" });
    const root = session.rootSurfaceId;
    await session.controller.handle({ type: "stream.subscribe" });

    // A styled scrollbar takes width from the layout, not from the page.
    await session.follow(root, { width: 900, height: 650 });
    const scrollbarFrame = await session.frameAt(root, {
      width: 900,
      height: 650,
    });
    const layout = await session.pageState(root);
    const edge = asRecord(
      await session.read(
        root,
        "(() => { const r = document.getElementById('edge').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()",
      ),
    );
    await session.read(root, "window.pointerLog = []");
    const edgeX = (Number(edge.left) + Number(edge.right)) / 2;
    const edgeY = (Number(edge.top) + Number(edge.bottom)) / 2;
    for (const action of ["down", "up"] as const) {
      await session.controller.handle({
        action,
        button: "left",
        clickCount: 1,
        surfaceId: root,
        type: "input.pointer",
        viewportHeight: scrollbarFrame.header.viewportHeight,
        viewportWidth: scrollbarFrame.header.viewportWidth,
        x: edgeX / scrollbarFrame.header.viewportWidth,
        y: edgeY / scrollbarFrame.header.viewportHeight,
      });
    }
    const edgeClick = ((await session.read(root, "window.pointerLog")) as PointerEntry[]).find(
      (entry) => entry.type === "mousedown",
    );
    expect(edgeClick?.target).toBe("edge");
    const framesBefore = session.frames.length;
    await session.read(root, "document.getElementById('state').textContent = 'repainted'");
    await waitFor(() => session.frames.length > framesBefore);
    expect(session.frames.at(-1)?.header).toMatchObject({
      viewportWidth: 900,
      viewportHeight: 650,
    });

    // The cast asks for twice the page's pixels, never past the bound.
    const rasters: Record<string, unknown>[] = [];
    for (const size of [
      { width: 1_280, height: 800 },
      { width: 1_600, height: 1_000 },
      { width: 3_800, height: 2_100 },
    ]) {
      const since = performance.now();
      await session.follow(root, size);
      const frame = await session.frameAt(root, size, since);
      const cap = session.screencastStarts(root).at(-1);
      const decoded = jpegSize(frame.data);
      const capWidth = Number(cap?.maxWidth);
      const capHeight = Number(cap?.maxHeight);
      expect(capWidth).toBeLessThanOrEqual(size.width * 2);
      expect(capHeight).toBeLessThanOrEqual(size.height * 2);
      expect(capWidth).toBeGreaterThanOrEqual(size.width);
      expect(capHeight).toBeGreaterThanOrEqual(size.height);
      expect(browserFrameFits(capWidth, capHeight)).toBe(true);
      if (browserFrameFits(size.width * 2, size.height * 2)) {
        expect({ capWidth, capHeight }).toEqual({
          capWidth: size.width * 2,
          capHeight: size.height * 2,
        });
      }
      expect(decoded).toEqual({
        width: frame.header.rasterWidth,
        height: frame.header.rasterHeight,
      });
      expect(decoded.width).toBeLessThanOrEqual(capWidth);
      expect(decoded.height).toBeLessThanOrEqual(capHeight);
      expect(browserFrameFits(decoded.width, decoded.height)).toBe(true);
      rasters.push({
        page: size,
        cap: { width: capWidth, height: capHeight },
        raster: decoded,
      });
    }

    // A tall page an agent sizes is pictured shrunk into the frame bound;
    // the picture's rounding never makes it look like another size.
    const attach = asRecord(
      await session.agent("Target.attachToTarget", {
        flatten: true,
        targetId: session.rootTargetId,
      }),
    );
    const page = String(attach.sessionId);
    const tall = { width: 390, height: 4_300 };
    const tallPictures: Record<string, unknown>[] = [];
    for (const deviceScaleFactor of [1, 2]) {
      const since = performance.now();
      await session.agent(
        "Emulation.setDeviceMetricsOverride",
        { ...tall, deviceScaleFactor, mobile: false },
        page,
      );
      const frame = await session.frameAt(root, tall, since);
      const cap = session.screencastStarts(root).at(-1);
      const decoded = jpegSize(frame.data);
      expect(decoded.width).toBeLessThanOrEqual(Number(cap?.maxWidth));
      expect(decoded.height).toBeLessThanOrEqual(Number(cap?.maxHeight));
      expect(sameShape(frame.header)).toBe(true);
      tallPictures.push({
        deviceScaleFactor,
        page: tall,
        cap: { width: cap?.maxWidth, height: cap?.maxHeight },
        raster: decoded,
        shrunk: decoded.width < tall.width * deviceScaleFactor,
      });
    }
    expect(tallPictures.at(-1)).toMatchObject({ shrunk: true });
    await session.agent("Emulation.clearDeviceMetricsOverride", {}, page);
    expect(session.errors()).toEqual([]);
    followReport.pictures = {
      tallAgentSizedPage: tallPictures,
      styledScrollbar: {
        layout,
        scrollbarShown: layout.clientWidth < layout.width,
        frameHeader: scrollbarFrame.header,
        edgeButton: edge,
        edgeClick,
      },
      rasters,
      passed: true,
    };
  }, 60_000);

  it("drops a command's answer once the viewer's socket closed, rejecting nothing unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    cleanup.push(async () => {
      process.off("unhandledRejection", onUnhandled);
    });
    const verifier = new FakeTicketVerifier();
    for (const [ticket, index] of [
      ["ticket-direct", 1],
      ["ticket-socket", 2],
      ["ticket-after", 3],
    ] as const) {
      verifier.setClaims(
        ticket,
        validClaims({
          sessionId: BrowserSessionIdSchema.parse(
            `bsn_00000000-0000-4000-8000-00000000030${index}`,
          ),
        }),
      );
    }
    const runtime = new BrowserRuntime({
      launcher: new PlaywrightChromiumLauncher({
        chromiumSandbox: false,
        executablePath,
        headless: true,
      }),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
    });
    const server = new BrowserRuntimeServer({ port: 0, runtime });
    cleanup.push(() => server.close());
    const address = await server.start();
    const lateAnswer = (sessionId: string, requestId: string): BrowserClientMessage => ({
      command: {
        method: "Runtime.evaluate",
        parameters: {
          awaitPromise: true,
          expression: "new Promise((resolve) => setTimeout(() => resolve(1), 500))",
        },
        sessionId,
      },
      requestId,
      type: "cdp.command",
    });

    // The attachment's own promise rejects when a command's answer cannot
    // leave a closed socket: the case the server must swallow.
    let open = true;
    const sink = new FakeSink();
    sink.sendServerImplementation = async () => {
      if (!open) throw new Error("The viewer's socket closed.");
    };
    const direct = await runtime.attach("ticket-direct", sink);
    const directAgent = (method: string, parameters?: CdpParameters, sessionId?: string) =>
      sendAsAgent(
        (message) => direct.handle(JSON.stringify(message)),
        sink.messages,
        method,
        parameters,
        sessionId,
      );
    const directRoot = String(asRecord(await directAgent("Target.getTargets")).rootTargetId);
    const directPage = String(
      asRecord(
        await directAgent("Target.attachToTarget", {
          flatten: true,
          targetId: directRoot,
        }),
      ).sessionId,
    );
    const pending = direct.handle(JSON.stringify(lateAnswer(directPage, randomUUID())));
    open = false;
    void direct.close().catch(() => undefined);
    const attachmentRejected = await pending.then(
      () => false,
      () => true,
    );
    expect(attachmentRejected).toBe(true);

    // Through the server's socket the same close rejects nothing unhandled.
    const socket = new WebSocket(`ws://${address.host}:${address.port}/v1/browser`, {
      headers: { authorization: "Bearer ticket-socket" },
    });
    const received: BrowserServerMessage[] = [];
    socket.on("message", (raw, isBinary) => {
      if (!isBinary) received.push(JSON.parse(raw.toString()) as BrowserServerMessage);
    });
    await waitFor(() => received.some((message) => message.type === "browser.snapshot"));
    const socketAgent = async (method: string, parameters?: CdpParameters, sessionId?: string) => {
      const requestId = randomUUID();
      socket.send(
        JSON.stringify({
          command: {
            method,
            ...(parameters ? { parameters } : {}),
            ...(sessionId ? { sessionId } : {}),
          },
          requestId,
          type: "cdp.command",
        }),
      );
      await waitFor(() =>
        received.some(
          (message) =>
            (message.type === "cdp.result" || message.type === "cdp.error") &&
            message.requestId === requestId,
        ),
      );
      const reply = received.find(
        (message) =>
          (message.type === "cdp.result" || message.type === "cdp.error") &&
          message.requestId === requestId,
      );
      if (reply?.type !== "cdp.result") throw new Error(`${method} failed.`);
      return reply.result;
    };
    const socketRoot = String(asRecord(await socketAgent("Target.getTargets")).rootTargetId);
    const socketPage = String(
      asRecord(
        await socketAgent("Target.attachToTarget", {
          flatten: true,
          targetId: socketRoot,
        }),
      ).sessionId,
    );
    for (let index = 0; index < 4; index += 1) {
      socket.send(JSON.stringify(lateAnswer(socketPage, randomUUID())));
    }
    socket.terminate();
    await delay(1_500, browserTestSignal());
    expect(unhandled).toEqual([]);

    // The runtime keeps serving.
    const afterSink = new FakeSink();
    const after = await runtime.attach("ticket-after", afterSink);
    const afterInventory = asRecord(
      await sendAsAgent(
        (message) => after.handle(JSON.stringify(message)),
        afterSink.messages,
        "Target.getTargets",
      ),
    );
    expect(typeof afterInventory.rootTargetId).toBe("string");
    await after.close();
    followReport.closedSocket = {
      attachmentRejectsWhenAnswerCannotLeave: attachmentRejected,
      unhandledRejectionsThroughServer: unhandled.length,
      runtimeServedAfterwards: true,
      passed: true,
    };
  }, 60_000);

  it("ignores a size the view sends for a tab that just closed", async () => {
    const session = await startFollowSession();
    const root = session.rootSurfaceId;
    await session.controller.handle({ type: "stream.subscribe" });

    // The view keeps sending its size for a tab it just closed.
    await session.controller.handle({
      type: "surface.open",
      url: `${session.origin}/plain`,
    });
    const closing = session.ledger.active();
    if (!closing || closing.surface.id === root) throw new Error("Missing the tab to close");
    await Promise.all([
      session.follow(closing.surface.id, { width: 900, height: 650 }),
      session.controller.handle({
        surfaceId: closing.surface.id,
        type: "surface.close",
      }),
      session.follow(closing.surface.id, { width: 880, height: 640 }),
      session.follow(closing.surface.id, { width: 860, height: 630 }),
    ]);
    await session.follow(closing.surface.id, { width: 840, height: 620 });
    const agentClosed = asRecord(
      await session.agent("Target.createTarget", {
        url: `${session.origin}/plain`,
      }),
    );
    const agentClosedSurface = session.ledger.surfaceIdForTarget(String(agentClosed.targetId));
    if (!agentClosedSurface) throw new Error("Missing the agent's tab");
    await session.agent("Target.closeTarget", {
      targetId: agentClosed.targetId,
    });
    await session.follow(agentClosedSurface, { width: 820, height: 610 });
    await delay(200, browserTestSignal());
    expect(session.errors()).toEqual([]);
    expect(session.ledger.snapshot().map((surface) => surface.id)).not.toContain(
      closing.surface.id,
    );
    followReport.closedTabs = {
      followsForClosedTabs: 5,
      browserErrors: 0,
      passed: true,
    };
  }, 60_000);

  it("keeps the person's view free while Chromium holds an agent's size write under a dialog", async () => {
    const session = await startFollowSession({ path: "/plain" });
    const personTab = session.rootSurfaceId;
    const messages = session.sink.messages;
    const settles = (operation: Promise<unknown>) =>
      withTimeout(
        operation.then(() => true),
        5_000,
        { timeoutError: () => new Error("timed out") },
      ).catch(() => false);
    /** The first picture of a page at `size` since `since`, or null after five seconds. */
    const pictureWithin = async (
      surfaceId: BrowserSurfaceId,
      size: PageSizeRequest,
      since: number,
    ): Promise<TimedFrame | null> => {
      const matches = (frame: TimedFrame) =>
        frame.at >= since &&
        frame.header.surfaceId === surfaceId &&
        frame.header.viewportWidth === size.width &&
        frame.header.viewportHeight === size.height &&
        sameShape(frame.header);
      await waitFor(() => session.frames.some(matches), 5_000).catch(() => undefined);
      return session.frames.find(matches) ?? null;
    };
    const shown = (frame: TimedFrame | null, since: number) =>
      frame
        ? {
            afterMs: Math.round(frame.at - since),
            raster: `${frame.header.rasterWidth}x${frame.header.rasterHeight}`,
            viewport: `${frame.header.viewportWidth}x${frame.header.viewportHeight}`,
          }
        : null;
    const dialogShownWithin = (from: number, surfaceId: BrowserSurfaceId, since: number) =>
      waitFor(
        () =>
          messages
            .slice(from)
            .some(
              (message) =>
                message.type === "browser.dialog.changed" &&
                message.dialog?.surfaceId === surfaceId,
            ),
        5_000,
      ).then(
        () => Math.round(performance.now() - since),
        () => null,
      );
    await session.controller.handle({ type: "stream.subscribe" });
    await session.follow(personTab, { width: 900, height: 640 });

    // The agent works in a tab of its own, out of the person's view. The
    // fixture opens a real dialog; Chromium holds the size command until it is answered.
    const created = asRecord(
      await session.agent("Target.createTarget", {
        url: `${session.origin}/plain`,
      }),
    );
    const agentTab = session.ledger.surfaceIdForTarget(String(created.targetId));
    if (!agentTab) throw new Error("Missing the agent's tab");
    const agentSession = String(
      asRecord(
        await session.agent("Target.attachToTarget", {
          flatten: true,
          targetId: created.targetId,
        }),
      ).sessionId,
    );
    await session.loaded(agentTab);
    const agentRead = async (expression: string) =>
      evaluationValue(
        await session.agent(
          "Runtime.evaluate",
          { awaitPromise: true, expression, returnByValue: true },
          agentSession,
        ),
      );
    await agentRead(`(() => {
        const button = document.createElement("button");
        button.id = "delete";
        button.textContent = "Delete listing";
        window.workedFrom = performance.timeOrigin + performance.now();
        button.addEventListener("click", () => {
          window.answer = confirm("Delete this listing?");
        });
        document.body.append(button);
      })()`);
    let dialogOpenedAt: number | null = null;
    const stopWatching = session.ledger.subscribe((event) => {
      if (
        event.type === "dialog" &&
        event.surfaceId === agentTab &&
        dialogOpenedAt === null &&
        session.ledger.dialogOpen(agentTab)
      ) {
        dialogOpenedAt = performance.now();
      }
    });
    const viewerFollows: Array<Promise<void>> = [];
    cleanup.push(async () => {
      stopWatching();
      const open = session.ledger.dialogOf(agentTab);
      if (open) await session.ledger.answerDialog(open.id, false, undefined).catch(() => undefined);
      await settles(Promise.all(viewerFollows));
    });
    const binding = session.ledger.binding(agentTab)!;
    const send = binding.cdp.send.bind(binding.cdp);
    const metricsEntered = Promise.withResolvers<void>();
    const releaseMetrics = Promise.withResolvers<void>();
    let gated = false;
    const intercepted = vi
      .spyOn(binding.cdp, "send")
      .mockImplementation(
        async <Result>(method: string, parameters?: CdpParameters): Promise<Result> => {
          if (method === "Emulation.setDeviceMetricsOverride" && !gated) {
            gated = true;
            metricsEntered.resolve();
            await withTimeout(releaseMetrics.promise, 5_000, {
              timeoutError: () => new Error("Fixture did not release the admitted size command"),
            });
          }
          return send<Result>(method, parameters);
        },
      );
    cleanup.push(async () => {
      releaseMetrics.resolve();
      intercepted.mockRestore();
    });
    const agentSize = { height: 500, width: 600 };
    const writeSentAt = performance.now();
    const writeSentEpoch = performance.timeOrigin + performance.now();
    let writeSettledAt: number | null = null;
    const agentWrite = session
      .agent(
        "Emulation.setDeviceMetricsOverride",
        { ...agentSize, deviceScaleFactor: 1, mobile: false },
        agentSession,
      )
      .then(
        () => {
          writeSettledAt = performance.now();
          return null;
        },
        (error: unknown) => {
          writeSettledAt = performance.now();
          return error instanceof Error ? error.message : String(error);
        },
      );

    await withTimeout(metricsEntered.promise, 5_000, {
      timeoutError: () => new Error("Size command did not reach the engine boundary"),
    });
    // Admit the size write before the dialog, then deliver it to the actual
    // engine after the modal event. No renderer stress or wall-clock race.
    const asking = send("Runtime.evaluate", {
      expression: "document.getElementById('delete').click()",
      awaitPromise: true,
      returnByValue: true,
    });
    void asking.catch(() => undefined);
    await vi.waitFor(() => expect(dialogOpenedAt).not.toBeNull(), { timeout: 5_000 });
    releaseMetrics.resolve();

    // The person drags their own tab's panel edge.
    const dragSince = performance.now();
    const drag = [
      { height: 630, width: 880 },
      { height: 620, width: 860 },
      { height: 610, width: 840 },
      { height: 600, width: 820 },
    ];
    const dragging: Array<Promise<void>> = [];
    for (const size of drag) {
      const followed = session.follow(personTab, size);
      dragging.push(followed);
      expect(await settles(followed)).toBe(true);
    }
    const dragSettled = await settles(Promise.all(dragging));
    const dragSettledMs = Math.round(performance.now() - dragSince);
    const panel = drag.at(-1)!;
    const dragPicture = await pictureWithin(personTab, panel, dragSince);
    const dragLayout = await session.pageState(personTab);

    // They turn to the agent's tab and see its dialog, then turn back
    // without answering, pause and resume.
    const turnFrom = messages.length;
    const turnSince = performance.now();
    const turned = await settles(
      session.controller.handle({
        surfaceId: agentTab,
        type: "surface.activate",
      }),
    );
    viewerFollows.push(session.follow(agentTab, panel));
    const dialogShownMs = await dialogShownWithin(turnFrom, agentTab, turnSince);
    const backFrom = messages.length;
    const backSince = performance.now();
    const turnedBack = await settles(
      session.controller.handle({
        surfaceId: personTab,
        type: "surface.activate",
      }),
    );
    viewerFollows.push(session.follow(personTab, panel));
    const backPicture = await pictureWithin(personTab, panel, backSince);
    const dialogHidden = messages
      .slice(backFrom)
      .some((message) => message.type === "browser.dialog.changed" && message.dialog === null);
    const paused = await settles(session.controller.handle({ type: "stream.unsubscribe" }));
    const resumeSince = performance.now();
    const resumed = await settles(session.controller.handle({ type: "stream.subscribe" }));
    const resumedPicture = await pictureWithin(personTab, panel, resumeSince);

    // They turn to the agent's tab again and answer; the agent's held
    // write completes and the tab's picture returns at the agent's size.
    const againFrom = messages.length;
    const againSince = performance.now();
    const turnedAgain = await settles(
      session.controller.handle({
        surfaceId: agentTab,
        type: "surface.activate",
      }),
    );
    viewerFollows.push(session.follow(agentTab, panel));
    const dialogShownAgainMs = await dialogShownWithin(againFrom, agentTab, againSince);
    const writeHeldUntilAnswer = writeSettledAt === null;
    const answerSince = performance.now();
    const answered = await settles(
      session.controller.handle({
        accept: true,
        dialogId: shownDialog(messages).id,
        type: "dialog.respond",
      }),
    );
    await withTimeout(asking, 5_000, {
      timeoutError: () => new Error("Dialog click did not finish after its answer"),
    });
    const writeOutcome = await withTimeout(agentWrite, 5_000, {
      timeoutError: () => new Error("timed out"),
    }).catch(() => "unanswered within 5s");
    const agentPicture = await pictureWithin(agentTab, agentSize, answerSince);
    const followsSettled = await settles(Promise.all(viewerFollows));
    const page = asRecord(
      await agentRead(
        "({ answer: window.answer, workedFrom: window.workedFrom, width: innerWidth, height: innerHeight })",
      ),
    );
    const outcome = {
      agentWrite: {
        sentAfterSiteBeganWorkingMs: writeSentEpoch - Number(page.workedFrom),
        dialogOpenedAfterWriteMs:
          dialogOpenedAt === null ? null : Math.round(dialogOpenedAt - writeSentAt),
        heldUntilAnswer: writeHeldUntilAnswer,
        completedAfterAnswerMs:
          writeSettledAt === null ? null : Math.round(writeSettledAt - answerSince),
        refusal: writeOutcome,
      },
      personDrag: {
        settledWithin5s: dragSettled,
        settledMs: dragSettledMs,
        picture: shown(dragPicture, dragSince),
        layout: dragLayout,
      },
      turnToAgentTab: { settledWithin5s: turned, dialogShownMs },
      turnBackWithoutAnswering: {
        settledWithin5s: turnedBack,
        picture: shown(backPicture, backSince),
        dialogHidden,
        pauseSettledWithin5s: paused,
        resumeSettledWithin5s: resumed,
        resumedPicture: shown(resumedPicture, resumeSince),
      },
      turnToAgentTabAgain: {
        settledWithin5s: turnedAgain,
        dialogShownMs: dialogShownAgainMs,
      },
      answer: {
        settledWithin5s: answered,
        answer: page.answer,
        agentTabPicture: shown(agentPicture, answerSince),
        agentTabLayout: { height: page.height, width: page.width },
      },
      viewerFollowsSettledWithin5s: followsSettled,
      errors: session.errors(),
    };
    followReport.dialogHoldsAgentWrite = outcome;
    expect(outcome.agentWrite).toMatchObject({
      heldUntilAnswer: true,
      refusal: null,
    });
    expect(outcome.agentWrite.sentAfterSiteBeganWorkingMs).toBeGreaterThan(0);
    expect(outcome.agentWrite.dialogOpenedAfterWriteMs).not.toBeNull();
    expect(outcome.personDrag).toMatchObject({
      layout: { height: panel.height, width: panel.width },
      settledWithin5s: true,
    });
    expect(dragPicture).not.toBeNull();
    expect(outcome.turnToAgentTab.settledWithin5s).toBe(true);
    expect(dialogShownMs).not.toBeNull();
    expect(outcome.turnBackWithoutAnswering).toMatchObject({
      dialogHidden: true,
      pauseSettledWithin5s: true,
      resumeSettledWithin5s: true,
      settledWithin5s: true,
    });
    expect(backPicture).not.toBeNull();
    expect(resumedPicture).not.toBeNull();
    expect(outcome.turnToAgentTabAgain.settledWithin5s).toBe(true);
    expect(dialogShownAgainMs).not.toBeNull();
    expect(outcome.answer).toMatchObject({
      agentTabLayout: agentSize,
      answer: true,
      settledWithin5s: true,
    });
    expect(agentPicture).not.toBeNull();
    expect(followsSettled).toBe(true);
    expect(outcome.errors).toEqual([]);
  }, 90_000);

  it("answers only the dialog an answer names, once, whichever page is in view", async () => {
    const directory =
      process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-browser-follow-e2e");
    await mkdir(directory, { recursive: true });
    const session = await startFollowSession({ path: "/plain" });
    const messages = session.sink.messages;
    const tabA = session.rootSurfaceId;
    await session.controller.handle({ type: "stream.subscribe" });
    await session.controller.handle({
      type: "surface.open",
      url: `${session.origin}/plain`,
    });
    const tabB = session.ledger.active()?.surface.id;
    if (!tabB || tabB === tabA) throw new Error("The person's second tab did not open.");
    await session.loaded(tabB);
    cleanup.push(async () => {
      for (const surfaceId of [tabA, tabB]) {
        const open = session.ledger.dialogOf(surfaceId);
        if (open)
          await session.ledger.answerDialog(open.id, false, undefined).catch(() => undefined);
      }
    });
    const dialogShown = (from: number, surfaceId: BrowserSurfaceId) =>
      waitFor(() =>
        messages
          .slice(from)
          .some(
            (message) =>
              message.type === "browser.dialog.changed" && message.dialog?.surfaceId === surfaceId,
          ),
      );
    // A page under a dialog answers nothing else, so its answer is read once it closed.
    const answerOf = (surfaceId: BrowserSurfaceId) =>
      session.ledger.dialogOpen(surfaceId)
        ? Promise.resolve("dialog still open")
        : session.read(surfaceId, "window.answer ?? null");
    const answerWith = async (dialogId: string, accept: boolean) => {
      const from = messages.length;
      const settledWithin5s = await withTimeout(
        session.controller.handle({ accept, dialogId, type: "dialog.respond" }).then(() => true),
        5_000,
        { timeoutError: () => new Error("timed out") },
      ).catch(() => false);
      const sent = messages.slice(from);
      return {
        settledWithin5s,
        errors: sent.flatMap((message) =>
          message.type === "browser.error" ? [message.error] : [],
        ),
        shown: sent.flatMap((message) =>
          message.type === "browser.dialog.changed" ? [message.dialog?.id ?? null] : [],
        ),
      };
    };

    // The person sees A's dialog on A, then B asks out of view and they
    // turn to B and see B's.
    await session.controller.handle({
      surfaceId: tabA,
      type: "surface.activate",
    });
    const fromA = messages.length;
    await session.read(
      tabA,
      "setTimeout(() => { window.answer = confirm('Allow action A?'); }, 0); true",
    );
    await dialogShown(fromA, tabA);
    const dialogA = shownDialog(messages);
    await session.read(
      tabB,
      "setTimeout(() => { window.answer = confirm('Allow destructive action B?'); }, 0); true",
    );
    await waitFor(() => session.ledger.dialogOf(tabB) !== null);
    const fromB = messages.length;
    await session.controller.handle({
      surfaceId: tabB,
      type: "surface.activate",
    });
    await dialogShown(fromB, tabB);
    const dialogB = shownDialog(messages);

    // The answer they gave A's dialog arrives only now, with B in view.
    const late = await answerWith(dialogA.id, true);
    await waitForAsync(async () => (await answerOf(tabA)) !== null).catch(() => undefined);
    const lateAnswerForA = {
      ...late,
      answerA: await answerOf(tabA),
      dialogA: session.ledger.dialogOf(tabA),
      dialogB: session.ledger.dialogOf(tabB),
      inView: session.ledger.active()?.surface.id === tabB ? "B" : "another page",
    };
    // Sent again, it finds no dialog and reaches no other.
    const repeated = await answerWith(dialogA.id, false);
    const repeatedAnswerForA = {
      ...repeated,
      answerA: await answerOf(tabA),
      dialogB: session.ledger.dialogOf(tabB),
    };
    // B's own answer answers B, and B's picture returns.
    const answeredAt = performance.now();
    const own = await answerWith(dialogB.id, false);
    await waitForAsync(async () => (await answerOf(tabB)) !== null).catch(() => undefined);
    const sizeB = session.ledger.viewportOf(tabB);
    const pictureB = sizeB
      ? await session.frameAt(tabB, sizeB, answeredAt).catch(() => null)
      : null;
    if (pictureB) {
      await writeFile(join(directory, "chromium-stale-dialog-b-answered.jpeg"), pictureB.data);
    }
    const outcome = {
      dialogs: { a: dialogA, b: dialogB },
      lateAnswerForA,
      repeatedAnswerForA,
      answerForB: {
        ...own,
        answerB: await answerOf(tabB),
        dialogB: session.ledger.dialogOf(tabB),
        picture: pictureB?.header ?? null,
      },
      errors: session.errors(),
    };
    followReport.staleDialogAnswers = outcome;
    await writeFile(
      join(directory, "chromium-stale-dialog-answers.json"),
      `${JSON.stringify({ executablePath, ...outcome }, null, 2)}\n`,
    );
    expect(dialogA.id).not.toBe(dialogB.id);
    expect(outcome.lateAnswerForA).toEqual({
      answerA: true,
      dialogA: null,
      dialogB,
      errors: [],
      inView: "B",
      settledWithin5s: true,
      shown: [],
    });
    expect(outcome.repeatedAnswerForA).toMatchObject({
      answerA: true,
      dialogB,
      errors: [{ code: "conflict", message: "There is no active browser dialog." }],
      settledWithin5s: true,
      shown: [],
    });
    expect(outcome.answerForB).toMatchObject({
      answerB: false,
      dialogB: null,
      errors: [],
      settledWithin5s: true,
      shown: [null],
    });
    expect(pictureB).not.toBeNull();
    expect(outcome.errors).toHaveLength(1);
  }, 30_000);

  it("lands the person's click where an agent's phone layout pictures a button, zoomed out or not", async () => {
    const directory = join(
      process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
        join(tmpdir(), "opensteer-browser-follow-e2e"),
      "phone-layout-input",
    );
    await mkdir(directory, { recursive: true });
    const session = await startFollowSession({ path: "/plain" });
    const root = session.rootSurfaceId;
    const binding = session.ledger.binding(root)!;
    const agentSession = String(
      asRecord(
        await session.agent("Target.attachToTarget", {
          flatten: true,
          targetId: session.rootTargetId,
        }),
      ).sessionId,
    );
    const latest = { pageScaleFactor: null as unknown };
    const onFrame = (value: unknown) => {
      latest.pageScaleFactor = asRecord(asRecord(value).metadata).pageScaleFactor;
    };
    binding.cdp.on("Page.screencastFrame", onFrame);
    cleanup.push(async () => binding.cdp.off("Page.screencastFrame", onFrame));
    await session.controller.handle({ type: "stream.subscribe" });
    const phone = { height: 844, width: 390 };
    const atPhoneSize = (since: number) => (frame: TimedFrame) =>
      frame.at >= since &&
      frame.header.surfaceId === root &&
      frame.header.viewportWidth === phone.width &&
      frame.header.viewportHeight === phone.height &&
      sameShape(frame.header);
    const results = [];
    for (const scenario of [
      // No viewport tag: a phone lays the page out 980px wide, zoomed out to fit.
      {
        deviceScaleFactor: 1,
        left: 490,
        name: "no-viewport-tag-1x",
        path: "/plain",
        top: 490,
      },
      {
        deviceScaleFactor: 3,
        left: 490,
        name: "no-viewport-tag-3x",
        path: "/plain",
        top: 490,
      },
      // width=device-width: laid out at the phone's own width, unzoomed.
      {
        deviceScaleFactor: 1,
        left: 150,
        name: "device-width-1x",
        path: "/mobile",
        top: 300,
      },
      {
        deviceScaleFactor: 3,
        left: 150,
        name: "device-width-3x",
        path: "/mobile",
        top: 300,
      },
    ] as const) {
      const url = `${session.origin}${scenario.path}?${scenario.name}`;
      await rootCdpNavigate(session.ledger, root, url);
      await waitForAsync(async () => {
        const state = asRecord(
          await session.read(root, "({ ready: document.readyState, href: location.href })"),
        );
        return state.ready === "complete" && state.href === url;
      });
      const metricsAt = performance.now();
      await session.agent(
        "Emulation.setDeviceMetricsOverride",
        {
          ...phone,
          deviceScaleFactor: scenario.deviceScaleFactor,
          mobile: true,
        },
        agentSession,
      );
      await waitFor(() => session.frames.some(atPhoneSize(metricsAt)), 5_000);
      const placedAt = performance.now();
      await session.read(
        root,
        `(() => {
            const button = document.createElement("button");
            button.id = "target";
            button.style.cssText = "position:absolute;left:${scenario.left}px;top:${scenario.top}px;width:100px;height:100px;margin:0;padding:0;border:0;background:rgb(255,0,0)";
            window.clicks = [];
            button.addEventListener("click", (event) => clicks.push({ trusted: event.isTrusted, x: event.clientX, y: event.clientY }));
            document.body.append(button);
            window.pointerLog = [];
          })()`,
      );
      // The person aims where the picture shows the button.
      const seen: { box: PictureBox | null; frame: TimedFrame | null } = {
        box: null,
        frame: null,
      };
      await waitForAsync(async () => {
        const frame = session.frames.findLast(atPhoneSize(placedAt));
        if (!frame || frame === seen.frame) return false;
        seen.frame = frame;
        seen.box = await redBoxInFrame((expression) => session.read(root, expression), frame);
        return seen.box !== null;
      }, 5_000).catch(() => undefined);
      const { box, frame } = seen;
      if (!box || !frame) throw new Error(`The button was never pictured in ${scenario.name}.`);
      await writeFile(join(directory, `chromium-${scenario.name}.jpeg`), frame.data);
      const aim = {
        x: (box.left + box.right) / 2 / box.width,
        y: (box.top + box.bottom) / 2 / box.height,
      };
      for (const action of ["down", "up"] as const) {
        await session.controller.handle({
          action,
          button: "left",
          clickCount: 1,
          surfaceId: root,
          type: "input.pointer",
          viewportHeight: phone.height,
          viewportWidth: phone.width,
          x: aim.x,
          y: aim.y,
        });
      }
      await waitForAsync(
        async () => Number(await session.read(root, "window.clicks.length")) > 0,
        2_000,
      ).catch(() => undefined);
      const page = asRecord(
        await session.read(
          root,
          "({ clicks: window.clicks, presses: pointerLog.filter((entry) => entry.type === 'mousedown'), width: innerWidth, height: innerHeight, scale: visualViewport.scale, rect: document.getElementById('target').getBoundingClientRect().toJSON() })",
        ),
      );
      results.push({
        scenario,
        header: frame.header,
        pictureBox: box,
        aim,
        pageScaleFactor: latest.pageScaleFactor,
        page,
        errors: session.errors(),
      });
      await session.agent("Emulation.clearDeviceMetricsOverride", {}, agentSession);
    }
    followReport.phoneLayoutInput = results;
    await writeFile(
      join(directory, "chromium-phone-layout-input.json"),
      `${JSON.stringify({ executablePath, results }, null, 2)}\n`,
    );
    for (const result of results) {
      const { left, name, path, top } = result.scenario;
      const zoomedOut = path === "/plain";
      expect(result.page, name).toMatchObject({
        clicks: [{ trusted: true }],
        presses: [{ target: "target" }],
        width: zoomedOut ? 980 : phone.width,
      });
      const [click] = result.page.clicks as Array<{ x: number; y: number }>;
      expect(click!.x, name).toBeGreaterThanOrEqual(left);
      expect(click!.x, name).toBeLessThanOrEqual(left + 100);
      expect(click!.y, name).toBeGreaterThanOrEqual(top);
      expect(click!.y, name).toBeLessThanOrEqual(top + 100);
      if (zoomedOut) expect(Number(result.page.scale), name).toBeLessThan(0.5);
      else expect(result.page.scale, name).toBe(1);
      expect(result.errors, name).toEqual([]);
    }
  }, 60_000);

  it("keeps the root picture at its followed size when a background tab closes", async () => {
    const outcome = await closeBackgroundTab("background-close", { stalePictures: false });
    followReport.backgroundTabClose = [
      ...((followReport.backgroundTabClose as unknown[] | undefined) ?? []),
      outcome,
    ];
    expectPictureRepaired(outcome);
  }, 30_000);

  it("repairs the root picture again for each stale picture that arrives after a background tab closes", async () => {
    const outcome = await closeBackgroundTab("background-close-stale", { stalePictures: true });
    followReport.backgroundTabCloseStale = outcome;
    expectPictureRepaired(outcome);
    const handedOver = outcome.frames.filter((frame) => frame.source === "fixture");
    expect(handedOver).toHaveLength(5);
    expect(handedOver.every((frame) => !frame.fitsPage)).toBe(true);
    // The burst during the first repair asks for one more repair, however
    // many pictures it holds; each later picture asks for one more again,
    // and Chromium's own pictures follow from the last.
    expect(outcome.restarts.length).toBeGreaterThanOrEqual(4);
    expect(outcome.restarts.slice(1, 4).map((restart) => restart.causes)).toEqual([
      handedOver.slice(0, 3).map((frame) => frame.index),
      [handedOver[3]!.index],
      [handedOver[4]!.index],
    ]);
  }, 30_000);

  it("pictures a tab whose dialog waits as soon as the list showing it again goes out", async () => {
    const directory = join(
      process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
        join(tmpdir(), "opensteer-browser-follow-e2e"),
      "waiting-tab-return",
    );
    await mkdir(directory, { recursive: true });
    const session = await startFollowSession({ path: "/plain" });
    const tabA = session.rootSurfaceId;
    // When each message reached the viewer, to order it against the frames.
    const timed: Array<{ readonly at: number; readonly message: BrowserServerMessage }> = [];
    session.sink.sendServerImplementation = async (message) => {
      timed.push({ at: performance.now(), message });
    };
    const size = { width: 900, height: 640 };
    await session.follow(tabA, size);
    await session.controller.handle({ type: "stream.subscribe" });
    await session.frameAt(tabA, size);
    await session.controller.handle({ type: "surface.open", url: `${session.origin}/plain` });
    const tabB = session.ledger.active()?.surface.id;
    if (!tabB || tabB === tabA) throw new Error("The person's second tab did not open.");
    await session.loaded(tabB);
    const sizeB = session.ledger.viewportOf(tabB)!;
    const pictureOf = (surfaceId: BrowserSurfaceId, at: PageSizeRequest, since: number) =>
      session.frames.find(
        (frame) =>
          frame.at >= since &&
          frame.header.surfaceId === surfaceId &&
          frame.header.viewportWidth === at.width &&
          frame.header.viewportHeight === at.height &&
          sameShape(frame.header),
      ) ?? null;

    // A asks while the person reads it; they turn to B and back without answering.
    const shownAt = performance.now();
    await session.controller.handle({ surfaceId: tabA, type: "surface.activate" });
    await waitFor(() => pictureOf(tabA, size, shownAt) !== null);
    await session.read(
      tabA,
      "setTimeout(() => { window.answer = confirm('Keep waiting?'); document.getElementById('state').textContent = 'answered ' + window.answer; }, 0); true",
    );
    await waitFor(() => session.ledger.dialogOf(tabA) !== null);
    const dialog = session.ledger.dialogOf(tabA)!;
    const awayAt = performance.now();
    await session.controller.handle({ surfaceId: tabB, type: "surface.activate" });
    await waitFor(() => pictureOf(tabB, sizeB, awayAt) !== null);
    const returnedAt = performance.now();
    const pictureReceived = Promise.withResolvers<void>();
    const recordFrame = session.sink.sendFrameImplementation;
    session.sink.sendFrameImplementation = async (frame) => {
      await recordFrame?.(frame);
      const list = listShowingA();
      if (list && pictureOf(tabA, size, list.at)) pictureReceived.resolve();
    };
    // A viewer takes a picture only of the page the latest list shows, so
    // A's picture counts once the list showing A went out.
    const listShowingA = () =>
      timed.find(
        ({ at, message }) =>
          at >= returnedAt &&
          message.type === "browser.surfaces.changed" &&
          message.surfaces.some((surface) => surface.active && surface.id === tabA),
      );
    await session.controller.handle({ surfaceId: tabA, type: "surface.activate" });
    await pictureReceived.promise;
    const list = listShowingA();
    const retained = list ? pictureOf(tabA, size, list.at) : null;
    const dialogOpenAtPicture = session.ledger.dialogOpen(tabA);
    const picturesBeforeList = session.frames
      .filter(
        (frame) =>
          frame.at >= returnedAt &&
          frame.header.surfaceId === tabA &&
          (list === undefined || frame.at < list.at),
      )
      .map((frame) => ({
        afterReturnMs: Math.round(frame.at - returnedAt),
        header: frame.header,
      }));
    const reshown = timed.find(
      ({ at, message }) =>
        at >= returnedAt &&
        message.type === "browser.dialog.changed" &&
        message.dialog?.surfaceId === tabA,
    );
    if (retained) await writeFile(join(directory, "chromium-retained.jpeg"), retained.data);

    // Answered, the page draws again.
    const answeredAt = performance.now();
    await session.controller.handle({
      accept: true,
      dialogId: shownDialog(session.sink.messages).id,
      type: "dialog.respond",
    });
    await waitFor(
      () =>
        session.frames.some(
          (frame) =>
            frame.at >= answeredAt &&
            frame.header.surfaceId === tabA &&
            retained !== null &&
            !frame.data.equals(retained.data),
        ),
      5_000,
    ).catch(() => undefined);
    const live =
      session.frames.find(
        (frame) =>
          frame.at >= answeredAt &&
          frame.header.surfaceId === tabA &&
          retained !== null &&
          !frame.data.equals(retained.data),
      ) ?? null;
    if (live) await writeFile(join(directory, "chromium-live-after-answer.jpeg"), live.data);
    const outcome = {
      size,
      dialog,
      retained: retained
        ? {
            afterReturnMs: Math.round(retained.at - returnedAt),
            header: retained.header,
            decoded: jpegSize(retained.data),
            afterListMs: list ? Math.round(retained.at - list.at) : null,
          }
        : null,
      picturesBeforeList,
      dialogOpenAtPicture,
      reshownDialog:
        reshown?.message.type === "browser.dialog.changed" ? reshown.message.dialog : null,
      order: [
        ...timed
          .filter(({ at, message }) => at >= returnedAt && message.type !== "cdp.event")
          .map(({ at, message }) => ({ at, entry: message.type })),
        ...session.frames
          .filter((frame) => frame.at >= returnedAt && frame.header.surfaceId === tabA)
          .map((frame) => ({ at: frame.at, entry: `frame A #${frame.header.frameId}` })),
      ]
        .filter(({ at }) => at <= answeredAt)
        .sort((left, right) => left.at - right.at)
        .map(({ at, entry }) => `${Math.round(at - returnedAt)}ms ${entry}`),
      live: live ? { afterAnswerMs: Math.round(live.at - answeredAt), header: live.header } : null,
      page: await session.read(
        tabA,
        "({ answer: window.answer, state: document.getElementById('state').textContent })",
      ),
      errors: session.errors(),
    };
    followReport.waitingTabReturn = outcome;
    await writeFile(
      join(directory, "chromium-waiting-tab-return.json"),
      `${JSON.stringify({ executablePath, ...outcome }, null, 2)}\n`,
    );
    expect(outcome.retained, JSON.stringify(outcome.order)).not.toBeNull();
    expect(outcome.picturesBeforeList, JSON.stringify(outcome.order)).toEqual([]);
    expect(outcome.retained!.header).toMatchObject({
      surfaceId: tabA,
      viewportHeight: size.height,
      viewportWidth: size.width,
    });
    expect(outcome.retained!.decoded).toEqual({
      height: outcome.retained!.header.rasterHeight,
      width: outcome.retained!.header.rasterWidth,
    });
    expect(outcome.dialogOpenAtPicture).toBe(true);
    expect(outcome.reshownDialog).toEqual(dialog);
    expect(outcome.live).not.toBeNull();
    expect(outcome.live!.header).toMatchObject({
      surfaceId: tabA,
      viewportHeight: size.height,
      viewportWidth: size.width,
    });
    expect(outcome.page).toEqual({ answer: true, state: "answered true" });
    expect(outcome.errors).toEqual([]);
  }, 30_000);

  it("opens a session's first page at its ticket's size and keeps sessions of one profile apart", async () => {
    const site = await serveFollowFixture();
    cleanup.push(() => site.close());
    const profile = await nativeRuntimeProfile();
    cleanup.push(profile.close);
    const verifier = new FakeTicketVerifier();
    const sized = BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000201");
    const unsized = BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000202");
    verifier.setClaims(
      "ticket-sized",
      validClaims({
        identity: profile.identity,
        sessionId: sized,
        viewport: { width: 1_111, height: 777 },
      }),
    );
    verifier.setClaims(
      "ticket-unsized",
      validClaims({ identity: profile.identity, sessionId: unsized }),
    );
    const runtime = new BrowserRuntime({
      localProfiles: profile.localProfiles,
      launcher: new PlaywrightChromiumLauncher({
        chromiumSandbox: false,
        executablePath,
        headless: true,
      }),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
    });
    cleanup.push(() => runtime.shutdown());
    const open = async (ticket: string) => {
      const sink = new FakeSink();
      const attachment = await runtime.attach(ticket, sink);
      const deliver = (message: BrowserClientMessage) => attachment.handle(JSON.stringify(message));
      const agent = (method: string, parameters?: CdpParameters, sessionId?: string) =>
        sendAsAgent(deliver, sink.messages, method, parameters, sessionId);
      const inventory = asRecord(await agent("Target.getTargets"));
      const rootTargetId = String(inventory.rootTargetId);
      const attached = asRecord(
        await agent("Target.attachToTarget", {
          flatten: true,
          targetId: rootTargetId,
        }),
      );
      const page = String(attached.sessionId);
      const evaluate = async (expression: string) =>
        evaluationValue(await agent("Runtime.evaluate", { expression, returnByValue: true }, page));
      await agent("Page.navigate", { url: `${site.origin}/plain` }, page);
      await waitForAsync(async () => (await evaluate("document.readyState")) === "complete");
      return {
        agent,
        deliver,
        evaluate,
        rootSurfaceId: BrowserSurfaceIdSchema.parse(attached.surfaceId),
        sink,
      };
    };
    const first = await open("ticket-sized");
    const second = await open("ticket-unsized");
    // The first navigation laid the page out at the ticket's size.
    const sizedLoad = await first.evaluate("window.loadSize");
    expect(sizedLoad).toEqual({ width: 1_111, height: 777 });
    const unsizedLoad = await second.evaluate("window.loadSize");
    expect(unsizedLoad).toEqual(defaultBrowserViewport);
    await first.deliver({ type: "stream.subscribe" });
    await waitFor(() => first.sink.frames.length > 0);
    const firstFrame = first.sink.frames[0]!.header;
    expect(firstFrame).toMatchObject({
      viewportWidth: 1_111,
      viewportHeight: 777,
    });

    // Two sessions of one profile share a browser, never a size.
    await first.deliver({
      height: 700,
      surfaceId: first.rootSurfaceId,
      type: "viewport.follow",
      width: 1_000,
    });
    expect(await first.evaluate("({ width: innerWidth, height: innerHeight })")).toEqual({
      width: 1_000,
      height: 700,
    });
    const secondAfter = await second.evaluate("({ width: innerWidth, height: innerHeight })");
    expect(secondAfter).toEqual(defaultBrowserViewport);
    const tabSize = async (session: Awaited<ReturnType<typeof open>>) => {
      const created = asRecord(await session.agent("Target.createTarget", { url: "about:blank" }));
      const attached = asRecord(
        await session.agent("Target.attachToTarget", {
          flatten: true,
          targetId: created.targetId,
        }),
      );
      return evaluationValue(
        await session.agent(
          "Runtime.evaluate",
          {
            expression: "({ width: innerWidth, height: innerHeight })",
            returnByValue: true,
          },
          String(attached.sessionId),
        ),
      );
    };
    const firstTab = await tabSize(first);
    const secondTab = await tabSize(second);
    expect(firstTab).toEqual({ width: 1_000, height: 700 });
    expect(secondTab).toEqual(defaultBrowserViewport);
    expect(runtime.health()).toMatchObject({
      profileHostCount: 1,
      sessionCount: 2,
    });
    for (const session of [first, second]) {
      expect(session.sink.messages.filter((message) => message.type === "browser.error")).toEqual(
        [],
      );
    }
    followReport.ticketAndProfileSessions = {
      ticketViewport: {
        requested: { width: 1_111, height: 777 },
        firstLoad: sizedLoad,
        firstFrame,
      },
      withoutTicketViewport: { firstLoad: unsizedLoad },
      sharedProfileHost: {
        followedInFirst: { width: 1_000, height: 700 },
        secondPageAfter: secondAfter,
        firstSessionAgentTab: firstTab,
        secondSessionAgentTab: secondTab,
      },
      passed: true,
    };
  }, 60_000);

  it("resumes the root picture at its followed size after an agent or person closes the active tab", async () => {
    const directory = join(
      process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
        join(tmpdir(), "opensteer-browser-follow-e2e"),
      "headless-close",
    );
    await mkdir(directory, { recursive: true });
    const session = await startFollowSession({ path: "/press" });
    const root = session.rootSurfaceId;
    const size = { width: 1_000, height: 700 };
    const binding = session.ledger.binding(root)!;
    const attached = asRecord(
      await session.agent("Target.attachToTarget", {
        flatten: true,
        targetId: session.rootTargetId,
      }),
    );
    await session.read(
      root,
      `document.getElementById("pad").style.cssText = "position:fixed;inset:0;background:repeating-linear-gradient(45deg,#e8f2ff,#e8f2ff 40px,#cfe2fa 40px,#cfe2fa 80px)";
         document.getElementById("pad").textContent = "Root page — 1000 × 700"`,
    );
    await session.controller.handle({ type: "stream.subscribe" });
    const results = [];
    for (const creator of ["agent", "person", "window.open", "target=_blank"] as const) {
      for (const closer of ["agent", "person"] as const) {
        const label = `${creator}-${closer}`;
        const rawFrames: unknown[] = [];
        const onFrame = (value: unknown) => {
          const frame = asRecord(value);
          rawFrames.push({
            at: performance.now(),
            metadata: frame.metadata,
            raster: jpegSize(Buffer.from(String(frame.data), "base64")),
          });
        };
        binding.cdp.on("Page.screencastFrame", onFrame);
        await session.follow(root, size);
        const before = await session.frameAt(root, size);
        await writeFile(join(directory, `${label}-before.jpeg`), before.data);
        const existing = new Set(session.ledger.snapshot().map((surface) => surface.id));
        if (creator === "agent") {
          await session.agent("Target.createTarget", {
            url: `${session.origin}/plain`,
          });
        } else if (creator === "person") {
          await session.controller.handle({
            type: "surface.open",
            url: `${session.origin}/plain`,
          });
        } else if (creator === "window.open") {
          await session.openPopup(String(attached.sessionId));
        } else {
          await session.read(
            root,
            `(() => {
                const link = document.createElement("a");
                link.href = "/plain";
                link.target = "_blank";
                link.rel = "opener";
                document.body.append(link);
                link.click();
                link.remove();
              })()`,
          );
        }
        await waitFor(() => session.ledger.snapshot().some((surface) => !existing.has(surface.id)));
        const tab = session.ledger.snapshot().find((surface) => !existing.has(surface.id))!.id;
        const targetId = session.ledger.binding(tab)!.targetId;
        await session.loaded(tab);
        await session.controller.handle({
          type: "surface.activate",
          surfaceId: tab,
        });
        await session.frameAt(tab, size);
        // The surviving page must recover its own size, including when
        // a person-created tab or popup was shown at a different size.
        const tabSize = creator === "agent" ? size : { width: 900, height: 600 };
        await session.follow(tab, tabSize);
        await session.frameAt(tab, tabSize);
        const windows = await Promise.all(
          [session.rootTargetId, targetId].map((targetId) =>
            binding.cdp.send("Browser.getWindowForTarget", { targetId }),
          ),
        );
        const rootWrites = session.metricsWrites(root).length;
        const closingAt = performance.now();
        if (closer === "agent") {
          await session.agent("Target.closeTarget", { targetId });
        } else {
          await session.controller.handle({
            type: "surface.close",
            surfaceId: tab,
          });
        }
        const matches = (frame: TimedFrame) =>
          frame.at >= closingAt &&
          frame.header.surfaceId === root &&
          frame.header.viewportWidth === size.width &&
          frame.header.viewportHeight === size.height;
        // The root draws nothing until the click below, so only the runtime
        // can picture it again here; no time limit is needed to show that.
        await waitFor(() => session.frames.some(matches)).catch(() => undefined);
        const resumed = session.frames.find(matches);
        if (resumed) await writeFile(join(directory, `${label}-after.jpeg`), resumed.data);
        const pointersBefore = (await session.read(root, "window.pointerLog.length")) as number;
        if (resumed) {
          for (const action of ["down", "up"] as const) {
            await session.controller.handle({
              action,
              button: "left",
              clickCount: 1,
              surfaceId: root,
              type: "input.pointer",
              viewportHeight: size.height,
              viewportWidth: size.width,
              x: 0.5,
              y: 0.5,
            });
          }
        }
        results.push({
          creator,
          closer,
          closedTabSize: tabSize,
          windows,
          layout: await session.pageState(root),
          layoutMetrics: await binding.cdp.send("Page.getLayoutMetrics"),
          rawFrames,
          resumed: resumed?.header ?? null,
          resumeMs: resumed ? resumed.at - closingAt : null,
          layoutWritesAfterClose: session.metricsWrites(root).length - rootWrites,
          pointerEvents:
            ((await session.read(root, "window.pointerLog.length")) as number) - pointersBefore,
          errors: session.errors(),
        });
        binding.cdp.off("Page.screencastFrame", onFrame);
      }
    }
    await writeFile(
      join(directory, "chromium-headless-close.json"),
      `${JSON.stringify({ executablePath, results }, null, 2)}\n`,
    );
    followReport.headlessClose = results;
    for (const result of results) {
      expect(result.errors).toEqual([]);
      expect(
        result.resumed,
        `${result.creator}: ${result.closer} close must restore the root picture`,
      ).toMatchObject({
        rasterWidth: 1_000,
        rasterHeight: 700,
        viewportWidth: 1_000,
        viewportHeight: 700,
      });
      expect(result.layout).toMatchObject({ width: 1_000, height: 700 });
      expect(result.layoutWritesAfterClose).toBe(0);
      expect(result.pointerEvents).toBe(2);
    }
  }, 60_000);

  /** A button filling the page's top-left corner that asks before it acts and keeps each answer. */
  const confirmButton = `(() => {
    const button = document.createElement("button");
    button.id = "delete";
    button.textContent = "Delete listing";
    button.style = "position:fixed;left:0;top:0;width:200px;height:200px";
    window.answers = [];
    button.addEventListener("click", () => window.answers.push(confirm("Delete this listing?")));
    document.body.append(button);
  })()`;

  it("refuses a stale agent dialog answer and detaches a pending evaluation", async () => {
    const session = await startFollowSession({ path: "/plain" });
    const targetId = session.rootTargetId;
    const page = String(
      asRecord(await session.agent("Target.attachToTarget", { targetId, flatten: true })).sessionId,
    );
    await session.agent("Page.enable", {}, page);
    const evaluating = session.agent(
      "Runtime.evaluate",
      { expression: 'confirm("A"); window.answerB = confirm("B")' },
      page,
    );
    await waitFor(() => session.ledger.dialogOf(session.rootSurfaceId)?.message === "A");
    const observed = asRecord(
      asRecord(await session.agent("Target.getTargetInfo", { targetId })).targetInfo,
    ).dialog;
    const first = session.ledger.dialogOf(session.rootSurfaceId)!;
    let replaced = false;
    const bridge = await startHarnessBridge(async (method, parameters, sessionId) => {
      const result = await session.agent(method, parameters, sessionId);
      if (method === "Target.getTargetInfo" && !replaced) {
        replaced = true;
        await session.controller.handle({
          type: "dialog.respond",
          dialogId: first.id,
          accept: false,
        });
        await waitFor(() => session.ledger.dialogOf(session.rootSurfaceId)?.message === "B");
      }
      return result;
    }, session.sink);
    cleanup.push(() => bridge.close());
    // The info read returns A; the person's answer and B's opening happen
    // before Harness sends its id-less answer. Harness must preserve A's ID.
    const harnessStale = await runHarness(
      bridge.url,
      session.claims.sessionId,
      targetId,
      'await currentTab(); await cdp("Page.handleJavaScriptDialog", { accept: true });',
    ).then(
      () => "answered",
      (error: unknown) => String(error),
    );
    const stale = await session
      .agent("Page.handleJavaScriptDialog", { dialogId: first.id, accept: true }, page)
      .then(
        () => "answered",
        (error: unknown) => String(error),
      );
    const second = session.ledger.dialogOf(session.rootSurfaceId);
    // Standard CDP retains Chrome's current-dialog semantics.
    await session.agent("Page.handleJavaScriptDialog", { accept: false }, page);
    await evaluating;
    const answerB = await session.read(session.rootSurfaceId, "window.answerB");
    const pending = session
      .agent("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true }, page)
      .then(
        () => "answered",
        (error: unknown) => String(error),
      );
    await delay(50, browserTestSignal());
    await withTimeout(session.agent("Target.detachFromTarget", { sessionId: page }), 2_000, {
      timeoutError: () => new Error("Detach waited for evaluation"),
    });
    const ended = await pending;
    const events = session.sink.messages.flatMap((message) =>
      message.type === "cdp.event" && message.event.method === "Page.javascriptDialogOpening"
        ? [message.event.parameters]
        : [],
    );
    const report = { observed, first, second, stale, harnessStale, answerB, ended, events };
    const directory =
      process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-browser-follow-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "chromium-agent-dialog-identity-and-detach.json"),
      JSON.stringify(report, null, 2),
    );
    expect(observed).toMatchObject({ id: first.id });
    expect(events[0]).toMatchObject({ dialogId: first.id });
    expect(stale).toContain("There is no active browser dialog.");
    expect(harnessStale).toContain("There is no active browser dialog.");
    expect(second?.message).toBe("B");
    expect(answerB).toBe(false);
    expect(ended).toContain("The CDP session ended before the page answered.");
  }, 30_000);

  it("lets an agent see and answer the dialog its click opened, in the same run or a later one, once", async () => {
    const directory =
      process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-browser-follow-e2e");
    await mkdir(directory, { recursive: true });
    const session = await startFollowSession({ path: "/plain" });
    const root = session.rootSurfaceId;
    const targetId = session.rootTargetId;
    const messages = session.sink.messages;
    await session.controller.handle({ type: "stream.subscribe" });
    cleanup.push(async () => {
      const open = session.ledger.dialogOf(root);
      if (open) await session.ledger.answerDialog(open.id, false, undefined).catch(() => undefined);
    });
    const page = String(
      asRecord(await session.agent("Target.attachToTarget", { flatten: true, targetId })).sessionId,
    );
    await session.agent("Runtime.evaluate", { expression: confirmButton }, page);
    const dialogOpened = () => waitFor(() => session.ledger.dialogOf(root) !== null, 5_000);
    const answers = () => session.read(root, "window.answers");
    /** The agent's click, as Browser Harness clickAt sends it; the release waits for the dialog. */
    const agentClick = async () => {
      const values = { button: "left", clickCount: 1, x: 50, y: 50 };
      await session.agent("Input.dispatchMouseEvent", { ...values, type: "mousePressed" }, page);
      return session.agent("Input.dispatchMouseEvent", { ...values, type: "mouseReleased" }, page);
    };
    const timed = async (operation: Promise<unknown>) => {
      const since = performance.now();
      const outcome = await withTimeout(
        operation.then(() => null),
        5_000,
        { timeoutError: () => new Error("unanswered within 5s") },
      ).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
      return { error: outcome, ms: Math.round(performance.now() - since) };
    };
    const viewerSaw = (from: number) =>
      messages
        .slice(from)
        .flatMap((message) =>
          message.type === "browser.dialog.changed"
            ? [message.dialog ? `${message.dialog.type}: ${message.dialog.message}` : "closed"]
            : [],
        );
    const line =
      '[opensteer] This page shows a confirm dialog ("Delete this listing?"); the page answers no other command until the dialog is answered with Page.handleJavaScriptDialog.';

    // In the run whose click opened it, as Puppeteer's page.on("dialog") answers.
    await session.agent("Page.enable", {}, page);
    const sameRunFrom = messages.length;
    const released = agentClick();
    await waitFor(() =>
      messages
        .slice(sameRunFrom)
        .some(
          (message) =>
            message.type === "cdp.event" &&
            message.event.sessionId === page &&
            message.event.method === "Page.javascriptDialogOpening",
        ),
    );
    const sameRunAnswer = await timed(
      session.agent("Page.handleJavaScriptDialog", { accept: true }, page),
    );
    const sameRunRelease = await timed(released);
    await session.agent("Page.disable", {}, page);
    const sameRun = {
      answer: sameRunAnswer,
      clickReleaseAnswered: sameRunRelease,
      answers: await answers(),
      viewerSaw: viewerSaw(sameRunFrom),
    };

    // A run whose click Chromium holds hears why when it gives up; a later
    // run sees the dialog on attach and answers it with standard CDP.
    const bridge = await startHarnessBridge(
      (method, parameters, sessionId) => session.agent(method, parameters, sessionId),
      session.sink,
    );
    cleanup.push(() => bridge.close());
    const harness = (program: string) =>
      runHarness(bridge.url, session.claims.sessionId, targetId, program).then(
        (output) => ({ ...output, exitCode: 0 }),
        (error: unknown) => ({
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
          stdout: "",
        }),
      );
    const laterFrom = messages.length;
    const clickRunSince = performance.now();
    const clickRun = await harness(`try {
  await clickAt(50, 50);
} catch (error) {
  if (error.name !== "DialogOpenedError" || !error.dialog?.id) throw new Error("Expected DialogOpenedError with dialog identity: " + String(error));
  console.error(error.name);
  throw error;
}
console.log("clicked");`);
    const clickRunMs = Math.round(performance.now() - clickRunSince);
    const shownMeanwhile = session.ledger.dialogOf(root);
    const answerRunSince = performance.now();
    const answerRun = await harness(`const tab = await currentTab();
console.log(JSON.stringify(tab));
await cdp("Page.handleJavaScriptDialog", { accept: true });
console.log(JSON.stringify(await js("window.answers")));`);
    const answerRunMs = Math.round(performance.now() - answerRunSince);
    const laterRuns = {
      clickRun: { ...clickRun, ms: clickRunMs },
      dialogWhileHeld: shownMeanwhile,
      answerRun: {
        ...answerRun,
        ms: answerRunMs,
        stdout: answerRun.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((entry) => JSON.parse(entry) as unknown),
      },
      viewerSaw: viewerSaw(laterFrom),
    };

    // The person and an agent answer the same dialog at once: it is answered once.
    const races: Record<string, unknown>[] = [];
    for (const first of ["person", "agent"] as const) {
      const from = messages.length;
      const releasing = agentClick().catch(() => undefined);
      await dialogOpened();
      const dialog = session.ledger.dialogOf(root)!;
      const person = () =>
        session.controller.handle({ accept: false, dialogId: dialog.id, type: "dialog.respond" });
      const agentAnswer = () =>
        session.agent("Page.handleJavaScriptDialog", { accept: true }, page).then(
          () => "answered",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      let agentOutcome: unknown;
      if (first === "person") {
        const personAnswered = person();
        agentOutcome = await agentAnswer();
        await personAnswered;
      } else {
        const agentAnswered = agentAnswer();
        await person();
        agentOutcome = await agentAnswered;
      }
      const releaseAnswered = await timed(releasing);
      races.push({
        first,
        agent: agentOutcome,
        personErrors: messages
          .slice(from)
          .flatMap((message) => (message.type === "browser.error" ? [message.error.message] : [])),
        clickReleaseAnswered: releaseAnswered,
        answers: await answers(),
        viewerSaw: viewerSaw(from),
      });
    }

    const report = { sameRun, laterRuns, races };
    await writeFile(
      join(directory, "chromium-agent-dialogs.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    followReport.agentDialogs = report;

    expect(sameRun).toMatchObject({
      answer: { error: null },
      clickReleaseAnswered: { error: null },
      answers: [true],
      viewerSaw: ["confirm: Delete this listing?", "closed"],
    });
    expect(sameRun.answer.ms).toBeLessThan(1_000);
    expect(clickRun.exitCode).toBe(1);
    expect(clickRun.stderr).toContain(`${line}\n`);
    expect(clickRun.stderr).toContain("DialogOpenedError");
    expect(clickRunMs).toBeLessThan(5_000);
    expect(shownMeanwhile).toMatchObject({ message: "Delete this listing?", type: "confirm" });
    expect(answerRun.exitCode).toBe(0);
    expect(answerRun.stderr).toBe(`${line}\n`);
    expect(laterRuns.answerRun.stdout).toEqual([
      expect.objectContaining({
        dialog: { id: expect.any(String), message: "Delete this listing?", type: "confirm" },
        targetId,
      }),
      [true, true],
    ]);
    expect(answerRunMs).toBeLessThan(5_000);
    expect(laterRuns.viewerSaw).toEqual(["confirm: Delete this listing?", "closed"]);
    expect(races).toEqual([
      expect.objectContaining({
        first: "person",
        agent: "No dialog is showing.",
        personErrors: [],
        answers: [true, true, false],
        viewerSaw: ["confirm: Delete this listing?", "closed"],
      }),
      expect.objectContaining({
        first: "agent",
        agent: "answered",
        personErrors: ["There is no active browser dialog."],
        answers: [true, true, false, true],
        viewerSaw: ["confirm: Delete this listing?", "closed"],
      }),
    ]);
    for (const race of races) expect(race.clickReleaseAnswered).toMatchObject({ error: null });
  }, 120_000);

  it("keeps every tab usable while a page's dialog waits, and closes a page that shows one", async () => {
    const directory =
      process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-browser-follow-e2e");
    await mkdir(directory, { recursive: true });
    const session = await startFollowSession({ path: "/plain" });
    const messages = session.sink.messages;
    const first = session.rootSurfaceId;
    cleanup.push(async () => {
      for (const surface of session.ledger.snapshot()) {
        const open = session.ledger.dialogOf(surface.id);
        if (open)
          await session.ledger.answerDialog(open.id, false, undefined).catch(() => undefined);
      }
    });
    const settledWithin = async (operation: Promise<unknown>) => {
      const since = performance.now();
      const settled = await withTimeout(
        operation.then(() => true),
        5_000,
        { timeoutError: () => new Error("timed out") },
      ).catch(() => false);
      return { ms: Math.round(performance.now() - since), settled };
    };
    const panel = { height: 700, width: 1_000 };
    await session.controller.handle({ type: "stream.subscribe" });
    await session.follow(first, panel);
    await session.controller.handle({
      type: "surface.open",
      url: `${session.origin}/plain?second`,
    });
    const second = session.ledger.active()?.surface.id;
    if (!second || second === first) throw new Error("The person's second tab did not open.");
    await session.loaded(second);
    // The person aims at the first tab's picture.
    const shownSince = performance.now();
    await session.controller.handle({ surfaceId: first, type: "surface.activate" });
    await session.follow(first, panel);
    await session.read(first, confirmButton);
    await session.frameAt(first, panel, shownSince);
    const press = (action: "down" | "up") =>
      session.controller.handle({
        action,
        button: "left",
        clickCount: 1,
        surfaceId: first,
        type: "input.pointer",
        viewportHeight: panel.height,
        viewportWidth: panel.width,
        x: 0.05,
        y: 0.05,
      });
    /** The person's click on the button; its release waits for the dialog it opens. */
    const personClick = async () => {
      await press("down");
      const releasing = press("up");
      await waitFor(() => session.ledger.dialogOf(first) !== null, 5_000);
      return { releasing };
    };

    // The person's click opens the dialog; they turn to another tab, size
    // it and open a third while the dialog waits on the first.
    const clickFrom = messages.length;
    const { releasing } = await personClick();
    const dialog = session.ledger.dialogOf(first)!;
    await waitFor(() =>
      messages
        .slice(clickFrom)
        .some(
          (message) =>
            message.type === "browser.dialog.changed" && message.dialog?.id === dialog.id,
        ),
    );
    const turnSince = performance.now();
    const turned = await settledWithin(
      session.controller.handle({ surfaceId: second, type: "surface.activate" }),
    );
    const secondSize = { height: 640, width: 900 };
    const sized = await settledWithin(session.follow(second, secondSize));
    const secondPicture = await session.frameAt(second, secondSize, turnSince);
    const opened = await settledWithin(
      session.controller.handle({ type: "surface.open", url: `${session.origin}/plain?third` }),
    );
    const third = session.ledger.active()?.surface.id;
    const stillWaiting = session.ledger.dialogOf(first)?.id === dialog.id;

    // Back on the first tab the same dialog waits; answering it lets the click finish.
    const backFrom = messages.length;
    const back = await settledWithin(
      session.controller.handle({ surfaceId: first, type: "surface.activate" }),
    );
    await waitFor(() =>
      messages
        .slice(backFrom)
        .some(
          (message) =>
            message.type === "browser.dialog.changed" && message.dialog?.id === dialog.id,
        ),
    );
    const answerSince = performance.now();
    const answered = await settledWithin(
      session.controller.handle({ accept: true, dialogId: dialog.id, type: "dialog.respond" }),
    );
    const clickFinished = await settledWithin(releasing);
    const answers = await session.read(first, "window.answers");
    // A page under a dialog is pictured once the dialog closes, and input
    // reaches only a page the view pictures: the person clicks on that picture.
    await session.frameAt(first, panel, answerSince);

    // The person closes the tab whose page shows a dialog; the tab left shows.
    const closingClick = (await personClick()).releasing.catch(() => undefined);
    const closeFrom = messages.length;
    const closeSince = performance.now();
    const closed = await settledWithin(
      session.controller.handle({ surfaceId: first, type: "surface.close" }),
    );
    const remaining = session.ledger.active()?.surface.id;
    const remainingSize = remaining ? session.ledger.viewportOf(remaining) : null;
    const remainingPicture =
      remaining && remainingSize
        ? await session.frameAt(remaining, remainingSize, closeSince)
        : null;
    await closingClick;
    const afterClose = {
      closed,
      firstGone: !session.ledger.snapshot().some((surface) => surface.id === first),
      remaining,
      remainingPictureMs: remainingPicture ? Math.round(remainingPicture.at - closeSince) : null,
      viewerDialog: messages
        .slice(closeFrom)
        .flatMap((message) =>
          message.type === "browser.dialog.changed" ? [message.dialog?.id ?? null] : [],
        ),
      errors: messages
        .slice(closeFrom)
        .flatMap((message) => (message.type === "browser.error" ? [message.error.message] : [])),
    };

    // An agent closes its own tab while its click there waits under a dialog.
    const created = asRecord(
      await session.agent("Target.createTarget", { url: `${session.origin}/plain?agent` }),
    );
    const agentTab = session.ledger.surfaceIdForTarget(String(created.targetId));
    if (!agentTab) throw new Error("Missing the agent's tab");
    const agentPage = String(
      asRecord(
        await session.agent("Target.attachToTarget", {
          flatten: true,
          targetId: created.targetId,
        }),
      ).sessionId,
    );
    await session.loaded(agentTab);
    await session.agent("Runtime.evaluate", { expression: confirmButton }, agentPage);
    const values = { button: "left", clickCount: 1, x: 50, y: 50 };
    await session.agent("Input.dispatchMouseEvent", { ...values, type: "mousePressed" }, agentPage);
    const agentRelease = session
      .agent("Input.dispatchMouseEvent", { ...values, type: "mouseReleased" }, agentPage)
      .then(
        () => "answered",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    await waitFor(() => session.ledger.dialogOf(agentTab) !== null, 5_000);
    const agentClosed = await settledWithin(
      session.agent("Target.closeTarget", { targetId: created.targetId }),
    );
    const agentReleaseOutcome = await withTimeout(agentRelease, 5_000, {
      timeoutError: () => new Error("unanswered within 5s"),
    }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    const agentClose = {
      closed: agentClosed,
      tabGone: !session.ledger.snapshot().some((surface) => surface.id === agentTab),
      clickRelease: agentReleaseOutcome,
      activeStayed: session.ledger.active()?.surface.id === remaining,
    };

    const report = {
      dialog: { id: dialog.id, message: dialog.message, type: dialog.type },
      whileWaiting: {
        turnToSecond: turned,
        sizeSecond: sized,
        secondPictureMs: Math.round(secondPicture.at - turnSince),
        openThird: opened,
        thirdOpened: third !== undefined && third !== first && third !== second,
        sameDialogStillWaiting: stillWaiting,
      },
      back: { turnBack: back, answered, clickFinished, answers },
      afterClose,
      agentClose,
      errors: session
        .errors()
        .map((message) =>
          message.type === "browser.error" ? message.error.message : message.type,
        ),
    };
    await writeFile(
      join(directory, "chromium-tab-modal-dialogs.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    followReport.tabModalDialogs = report;

    expect(turned.settled).toBe(true);
    expect(turned.ms).toBeLessThan(500);
    expect(report.whileWaiting).toMatchObject({
      sizeSecond: { settled: true },
      openThird: { settled: true },
      thirdOpened: true,
      sameDialogStillWaiting: true,
    });
    expect(report.back).toMatchObject({
      turnBack: { settled: true },
      answered: { settled: true },
      clickFinished: { settled: true },
      answers: [true],
    });
    expect(afterClose).toMatchObject({
      closed: { settled: true },
      firstGone: true,
      errors: [],
    });
    expect(afterClose.closed.ms).toBeLessThan(1_000);
    expect(afterClose.remainingPictureMs).not.toBeNull();
    expect(agentClose).toMatchObject({
      closed: { settled: true },
      tabGone: true,
      activeStayed: true,
    });
    expect(agentClose.closed.ms).toBeLessThan(1_000);
    expect(agentClose.clickRelease).not.toBe("answered");
    expect(agentClose.clickRelease).not.toBe("unanswered within 5s");
    expect(report.errors).toEqual([]);
  }, 90_000);

  it("registers popups with an immediate inline dialog before renderer initialization", async () => {
    const session = await startFollowSession({ path: "/plain" });
    const size = { width: 930, height: 670 };
    await session.follow(session.rootSurfaceId, size);
    await session.controller.handle({ type: "stream.subscribe" });
    const site = createServer((request, response) => {
      const type = request.url === "/alert" ? "alert" : "confirm";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Inline ${type}</title>
<script>window.answer = ${type}("Immediate ${type}"); window.finished = true;</script>
<body style="background:#aee">Answered ${type}</body>`);
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    cleanup.push(async () => {
      site.closeAllConnections();
      site.close();
      await once(site, "close");
    });
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("Missing dialog fixture address");
    const directory =
      process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-browser-follow-e2e");
    await mkdir(directory, { recursive: true });
    const outcomes: Record<string, unknown>[] = [];
    try {
      for (const type of ["confirm", "alert"] as const) {
        const url = `http://127.0.0.1:${address.port}/${type}`;
        const from = session.sink.messages.length;
        const openedAt = performance.now();
        session.ledger.recordHumanActivity(session.rootSurfaceId, {
          kind: "click",
        });
        let popup: BrowserSurfaceId | undefined;
        const registered = waitForLedgerState(session.ledger, () => {
          popup = session.ledger
            .snapshot()
            .find((surface) => surface.openerId != null && surface.url === url)?.id;
          return popup !== undefined && session.ledger.dialogOf(popup) !== null;
        });
        const announced = waitForBrowserMessages(session.sink, () => {
          const dialog = popup ? session.ledger.dialogOf(popup) : null;
          const messages = session.sink.messages.slice(from);
          return (
            dialog !== null &&
            messages.some(
              (message) =>
                message.type === "browser.surfaces.changed" &&
                message.surfaces.some((surface) => surface.id === popup),
            ) &&
            messages.some(
              (message) =>
                message.type === "browser.dialog.changed" && message.dialog?.id === dialog.id,
            )
          );
        });
        const opening = session.read(
          session.rootSurfaceId,
          `window.open(${JSON.stringify(url)}, "_blank") !== null`,
        );
        await registered;
        expect(session.ledger.active()?.surface.id).toBe(session.rootSurfaceId);
        await session.controller.handle({ type: "surface.activate", surfaceId: popup! });
        await announced;
        const dialog = session.ledger.dialogOf(popup!);
        expect(dialog).toMatchObject({
          surfaceId: popup,
          type,
          message: `Immediate ${type}`,
        });
        const visibleWithinMs = performance.now() - openedAt;
        const sizeBeforeAnswer = session.ledger.viewportOf(popup!);
        if (session.metricsWrites(popup!).length === 0) expect(sizeBeforeAnswer).toBeNull();
        expect(session.ledger.active()?.surface.id).toBe(popup);
        const answeredAt = performance.now();
        await withTimeout(
          session.controller.handle({
            type: "dialog.respond",
            dialogId: dialog!.id,
            accept: true,
          }),
          2_000,
          {
            timeoutError: () => new Error("The inline dialog could not be answered"),
          },
        );
        await opening;
        await waitForAsync(
          async () => (await session.read(popup!, "document.readyState")) === "complete",
        );
        await waitFor(() => session.ledger.viewportOf(popup!)?.width === size.width);
        const state = await session.pageState(popup!);
        expect(state).toMatchObject(size);
        const answer = await session.read(
          popup!,
          "({ finished: window.finished, answer: window.answer ?? null })",
        );
        expect(answer).toEqual({
          finished: true,
          answer: type === "confirm" ? true : null,
        });
        const frame = await session.frameAt(popup!, size, answeredAt);
        await writeFile(join(directory, `chromium-inline-${type}.jpeg`), frame.data);
        outcomes.push({
          type,
          dialog,
          visibleWithinMs,
          sizeBeforeAnswer,
          state,
          answer,
          frame: frame.header,
          messages: session.sink.messages
            .slice(from)
            .filter(
              (message) =>
                message.type === "browser.surfaces.changed" ||
                message.type === "browser.dialog.changed",
            ),
          metrics: session.metricsWrites(popup!),
          errors: session.errors(),
        });
        await session.controller.handle({
          type: "surface.close",
          surfaceId: popup!,
        });
        await session.controller.handle({
          type: "surface.activate",
          surfaceId: session.rootSurfaceId,
        });
      }
      expect(session.errors()).toEqual([]);
    } finally {
      followReport.inlinePopupDialogs = outcomes;
      await writeFile(
        join(directory, "chromium-inline-popup-dialogs.json"),
        `${JSON.stringify({ executablePath, outcomes, surfaces: session.ledger.snapshot(), errors: session.errors() }, null, 2)}\n`,
      );
    }
  }, 30_000);
});
