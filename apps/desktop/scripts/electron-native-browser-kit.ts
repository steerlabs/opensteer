import { SessionCdpRouter, type CdpParameters } from "@opensteer/browser-core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { delay } from "@opensteer/shared/delay";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";

import path from "node:path";
import { promisify } from "node:util";
import { app, BaseWindow, webContents, type WebContents } from "electron";
import { z } from "zod";

import { createHttpHostApiClient } from "@opensteer/client/host";
import {
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  type BrowserServerMessage,
} from "@opensteer/protocol";
import {
  BrowserController,
  BrowserRuntime,
  SurfaceLedger,
  type NativePresentationSource,
  type PresentedSurface,
} from "@opensteer/browser-runtime-core";

import { ElectronHostNetwork } from "../src/app/electron-host-network.js";
import { type ElectronAppWindow } from "../src/app/electron-window.js";

import {
  DesktopHostTransport,
  type DesktopBrowserSocketObservation,
} from "../src/connections/host-transport.js";
import { DesktopBrowserPresentationManager } from "../src/browser/browser-presentation.js";
import { electronPagePresentation } from "../src/browser/electron-browser-launcher.js";

import { PersonalDeploymentSupervisor } from "../src/supervisor/personal-deployment-supervisor.js";

import { startLocalBrowserRuntime } from "../src/supervisor/local-browser-runtime.js";

import { NativeSmokeArtifacts, type NativeCaseId } from "./electron-native-browser-artifacts.js";

export interface NativeBrowserScenarioContext {
  /** Run-owned real Downloads and private staging folders, retained as evidence. */
  downloadsRoot: string;
  /** Production presentation authority. */
  manager: DesktopBrowserPresentationManager;
  /** Real renderer-to-Host transport. */
  transport: DesktopHostTransport;
  /** Reverify the selected connection through its partitioned discovery fetch. */
  reverifyConnection(): Promise<void>;
  /** Authenticated Personal Host API; mutations use commands.dispatch. */
  api: ReturnType<typeof createHttpHostApiClient>;
  /** Session created through the real Host. */
  sessionId: string;
  /** Unique loopback fixture origin. */
  origin: string;
  /** Observed setup failure when the independent blocked probes run. */
  nativeMountBlockReason?: string;
  /** Refuse the next control connection through its normal terminal close event. */
  refuseNextControl(code: 4002 | 4003): void;
  /** Hold incoming snapshots before main admission. */
  setHold(value: boolean): void;
  /** Deliver held original snapshot bytes in order. */
  releaseSnapshots(): void;
  /** Real Host loopback origin. */
  hostOrigin: string;
  /** Personal deployment identity. */
  deploymentId: string;
  /** Partitioned real network adapter. */
  network: ElectronHostNetwork;
  /** Supervisor, including stop/recovery operations. */
  supervisor: PersonalDeploymentSupervisor;
  /** Observed renderer realtime sockets, with no credentials or payload bodies. */
  realtimeState(): unknown;
  /** Browser socket lifetimes prove viewer holds are released on handoff. */
  viewerState(): readonly { id: string; path: string; state: string; surfaceId?: string }[];
  /** Close the renderer's realtime sockets as a transport failure; browser sockets stay open. */
  dropRealtime(): void;
  /** Live runtime bridge handles; credentials must never enter artifacts. */
  runtimeHandles: Awaited<ReturnType<typeof startLocalBrowserRuntime>>[];
}

/** Shared real-stack helpers. Each invocation owns all mutable state and resources. */
export function createNativeBrowserE2EKit(options: {
  run: string;
  inputHelper: string;
  artifacts: NativeSmokeArtifacts;
}) {
  const { run, inputHelper, artifacts } = options;
  const root = path.join(run, "stack");
  const runFile = promisify(execFile);
  const cleanup: (() => void | Promise<void>)[] = [];
  const afterCleanup: (() => void | Promise<void>)[] = [];
  const runtimeSources = new Set<NativePresentationSource>();
  const pages = new Map<string, PresentedSurface>();
  const rawOutstanding = new Map<number, Set<number>>();
  const dialogPages = new Set<number>();
  const authorityEvents: DesktopBrowserSocketObservation[] = [];
  const geometry: unknown[] = [];
  const ownedChildren: { component: string; pid: number; exited: boolean }[] = [];
  const ownedPids = new Set<number>();
  const consoleErrors: string[] = [];
  let latestTarget: { presentationId: string; revision: number } | null = null;
  const presentationEvents: unknown[] = [];
  const workspaceCommands: unknown[] = [];
  const incomingMessages: BrowserServerMessage[] = [];
  const outgoing: {
    owner: number;
    type: string;
    surfaceId?: string | undefined;
    frames?: boolean | undefined;
    captureRegion?: true | undefined;
  }[] = [];
  let shell: ElectronAppWindow | null = null;
  let currentCase: NativeCaseId = artifacts.selected.values().next().value ?? "M01";
  let captured = 0;
  let mouseDelivery: "OS PID-targeted mouse" | "renderer-targeted mouse stand-in" =
    "renderer-targeted mouse stand-in";
  const deferredMouseChecks: (() => Promise<void>)[] = [];
  async function evaluateApp(expression: string): Promise<unknown> {
    assert(shell && !shell.webContents.isDestroyed());
    return shell.webContents.executeJavaScript(expression);
  }
  async function body(): Promise<string> {
    return z.string().parse(await evaluateApp("document.body.innerText"));
  }
  async function clickApp(selector: string): Promise<void> {
    assert(shell);
    await shell.webContents.executeJavaScript(
      `(() => {const el=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.checkVisibility()&&!e.disabled&&!e.closest('[inert],[aria-hidden="true"]'));if(!el)throw Error('Missing app control');el.scrollIntoView({block:'nearest',inline:'nearest'})})()`,
    );
    let previous: { x: number; y: number } | null = null;
    await until(async () => {
      try {
        const point = await elementPoint(shell!.webContents, selector);
        const stable = previous?.x === point.x && previous.y === point.y;
        previous = point;
        return stable;
      } catch {
        previous = null;
        return false;
      }
    }, `stable visible hit-tested app control ${selector}`);
    const point = await elementPoint(shell.webContents, selector);
    artifacts.event("input.appMouseStandIn", { selector, point });
    mouse(shell.webContents, point);
    await delay(100);
  }
  async function elementPoint(
    contents: WebContents,
    selector: string,
  ): Promise<{ x: number; y: number }> {
    const point = z.object({ x: z.number(), y: z.number() }).parse(
      await contents.executeJavaScript(
        `(() => {
          for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
          if (!el.checkVisibility() || el.disabled) continue;
          const r = el.getBoundingClientRect();
          const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
          const hit = document.elementFromPoint(x, y);
          if (r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight ||
              el.closest('[inert],[aria-hidden="true"]') || !hit || !(hit === el || el.contains(hit)))
            continue;
          return {x, y};
          }
          throw Error('Control is offscreen, inert or fails hit-testing: ' + ${JSON.stringify(selector)});
        })()`,
      ),
    );
    const zoom = contents.getZoomFactor();
    if (shell && contents === shell.webContents) {
      const bounds = shell.getContentBounds();
      assert(
        point.x * zoom >= 0 &&
          point.y * zoom >= 0 &&
          point.x * zoom < bounds.width &&
          point.y * zoom < bounds.height,
        `App point outside visible window content: ${JSON.stringify({ point, zoom, bounds })}`,
      );
    }
    if (shell && contents !== shell.webContents) {
      const surface = [...pages.values()].find(
        (surface) => electronPagePresentation(surface.page)?.view.webContents === contents,
      );
      const native = surface && electronPagePresentation(surface.page);
      if (native && shell.contentView.children.includes(native.view)) {
        const bounds = native.view.getBounds();
        assert(
          point.x * zoom < bounds.width && point.y * zoom < bounds.height,
          `Page control outside visible cropped native view: ${JSON.stringify({ selector, point, bounds, zoom })}`,
        );
      }
    }
    return point;
  }

  function mouse(
    contents: WebContents,
    point: { x: number; y: number },
    button: "left" | "right" = "left",
  ): void {
    contents.sendInputEvent({ type: "mouseDown", button, clickCount: 1, ...point });
    contents.sendInputEvent({ type: "mouseUp", button, clickCount: 1, ...point });
  }
  async function key(code: number, flags = 0): Promise<void> {
    const result = z.object({ posted: z.literal(true), cursorUnchanged: z.literal(true) }).parse(
      JSON.parse(
        (
          await runFile(inputHelper, ["key", String(process.pid), String(code), String(flags)], {
            timeout: 5_000,
          })
        ).stdout,
      ),
    );
    artifacts.event("input.osKey", { codeClass: "fixture/shortcut", flags, result });
    await delay(100);
  }
  async function inputReady(): Promise<void> {
    const result = z
      .object({
        ready: z.literal(true),
        cursorStable: z.literal(true),
        stableSamples: z.number().min(5),
        pid: z.literal(process.pid),
      })
      .parse(
        JSON.parse(
          (await runFile(inputHelper, ["input-ready", String(process.pid)], { timeout: 5000 }))
            .stdout,
        ),
      );
    artifacts.event("input.exclusivePrecondition", result);
  }
  function windowInventory(): unknown {
    return BaseWindow.getAllWindows().map((window) => ({
      id: window.id,
      visible: window.isVisible(),
      focused: window.isFocused(),
      bounds: window.getBounds(),
      contentBounds: window.getContentBounds(),
      children: window.contentView.children.map((view) => ({
        bounds: view.getBounds(),
        contents: "webContents" in view ? (view as Electron.WebContentsView).webContents.id : null,
      })),
    }));
  }
  function activeSurface(): PresentedSurface {
    assert(shell);
    for (const surface of pages.values()) {
      const native = electronPagePresentation(surface.page);
      if (native && shell.contentView.children.includes(native.view)) return surface;
    }
    throw new Error("No native page child in the production app window");
  }
  function pageContents(): WebContents {
    const native = electronPagePresentation(activeSurface().page);
    assert(native);
    return native.view.webContents;
  }
  async function snapshot(id: NativeCaseId, name: string): Promise<string> {
    assert(shell);
    const directory = path.join(run, "cases", id);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${name}.png`);
    const capture = await captureOsWindow(file);
    const bytes = await readFile(file);
    assert(bytes.length > 1000, "Owned-window capture is empty");
    captured++;
    artifacts.event("capture.osWindow", {
      file: path.relative(run, file),
      source: shell.getMediaSourceId(),
      method: `parent CoreGraphics screencapture (${capture.method})`,
      parentPid: capture.parentPid,
      pid: process.pid,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await rects(id, name);
    return path.relative(run, file);
  }
  async function rects(id: NativeCaseId, name: string): Promise<unknown> {
    const surface = (() => {
      try {
        return activeSurface();
      } catch {
        return null;
      }
    })();
    const contents = surface ? electronPagePresentation(surface.page)?.view.webContents : null;
    const data = {
      name,
      windows: windowInventory(),
      appZoom: shell?.webContents.getZoomFactor(),
      stage: await evaluateApp(
        `(() => { const r=document.querySelector('.browser-stage')?.getBoundingClientRect(); return r? {x:r.x,y:r.y,width:r.width,height:r.height}:null; })()`,
      ),
      page:
        contents && contents.isLoadingMainFrame()
          ? {
              pendingNavigation: true,
              contents: contents.id,
              bounds: electronPagePresentation(surface!.page)?.view.getBounds(),
            }
          : contents && dialogPages.has(contents.id)
            ? {
                pausedByDialog: true,
                bounds: electronPagePresentation(surface!.page)?.view.getBounds(),
              }
            : contents && !contents.isDestroyed()
              ? await withTimeout(
                  contents.executeJavaScript(
                    "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,screen:{width:screen.width,height:screen.height},timeOrigin:performance.timeOrigin,fullscreen:!!document.fullscreenElement})",
                  ),
                  1000,
                  { timeoutError: () => new Error("Page rect metadata blocked by navigation") },
                )
              : null,
      geometry: surface?.geometry(),
      focused: webContents.getFocusedWebContents()?.id,
      presentationAuthority: authorityEvents,
      mouseDelivery,
    };
    artifacts.json(`cases/${id}/${name}-rects.json`, data);
    return data;
  }
  async function rendererState(label: string): Promise<unknown> {
    let renderer: unknown;
    try {
      renderer = await withTimeout(
        evaluateApp(`(async () => {
        const root = document.getElementById('root');
        const key = root && Object.keys(root).find(key => key.startsWith('__reactContainer$'));
        const pending = key ? [root[key]] : [];
        const seen = new Set(); let client = null;
        while (pending.length && seen.size < 20000) {
          const fiber = pending.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
          if (fiber.memoizedProps?.hostClient) { client = fiber.memoizedProps.hostClient; break; }
          pending.push(fiber.child, fiber.sibling, fiber.alternate);
        }
        const snapshot = client?.getSnapshot();
        const selected = document.querySelector('.side-tab.is-active')?.getAttribute('data-place-key');
        const [, selectedSession, selectedSurface] = selected?.split(':') ?? [];
        const session = snapshot?.browserSessions.find(s => s.id === selectedSession);
        const viewer = selectedSession && selectedSurface ? client?.browserViewerState(selectedSession,selectedSurface) : null;
        return {stageText: document.querySelector('.browser-stage')?.textContent,
          selectedSession: session ? {state: session.state, tabCatalog: session.tabCatalog} : null,
          viewer: viewer ? {status:viewer.status,admitted:viewer.admitted,error:viewer.error,admissionId:viewer.admissionId} : null,
          visibility: document.visibilityState, documentFocused: document.hasFocus(),
          localVisible: await window.opensteerDesktop?.getLocalVisibility(), online: navigator.onLine,
          selected: document.querySelector('.side-tab.is-active')?.getAttribute('data-place-key'),
          sidebar: document.querySelector('#app-sidebar')?.getAttribute('aria-hidden'),
          panelVisible: !!document.querySelector('.browser-stage'),
          client: snapshot ? {connection: snapshot.connection, network: snapshot.network,
            session: snapshot.session, browserSessions: snapshot.browserSessions.map(s => s.id)} : {unavailable: 'React HostClient not found'}};
      })()`),
        1500,
        { timeoutError: () => new Error("Renderer/client diagnostic read deadline") },
      );
    } catch (error) {
      renderer = { error: errorText(error) };
    }
    let nativeForeground: unknown;
    if (currentCase === "A03" || currentCase === "L02") {
      try {
        nativeForeground = z
          .object({ frontmostPid: z.number() })
          .parse(JSON.parse((await runFile(inputHelper, ["status"], { timeout: 1500 })).stdout));
      } catch (error) {
        nativeForeground = { error: errorText(error) };
      }
    }
    const state = {
      nativeForeground,
      realtime: scenarioContext?.realtimeState(),
      label,
      at: Date.now(),
      renderer,
      focusedWindow: shell?.isFocused(),
      visible: shell?.isVisible(),
      minimized: shell?.isMinimized(),
      focusedContents: webContents.getFocusedWebContents()?.id,
      authority: authorityEvents.slice(-8),
    };
    artifacts.event("wait.state", state);
    return state;
  }
  async function foregroundApp(): Promise<void> {
    assert(shell && !shell.isDestroyed());
    await rendererState("before foreground");
    shell.restore();
    shell.show();
    app.focus({ steal: true });
    shell.focus();
    await until(async () => shell?.isFocused() === true, "owned window foreground for catalog");
  }
  async function openSidebar(): Promise<void> {
    if (await evaluateApp("!!document.querySelector('.settings-navigation__back')"))
      await clickApp(".settings-navigation__back");
    if (
      await evaluateApp(`(() => {
      const sidebar = document.querySelector('#app-sidebar');
      if (!sidebar || sidebar.inert || sidebar.getAttribute('aria-hidden') === 'true') return false;
      const r = sidebar.getBoundingClientRect(); return r.width > 0 && r.x >= 0 && r.right <= innerWidth;
    })()`)
    )
      return;
    for (const selector of ['[aria-label^="Open sidebar"]', '[aria-label^="Show sidebar"]']) {
      if (await evaluateApp(`!!document.querySelector(${JSON.stringify(selector)})`)) {
        await clickApp(selector);
        break;
      }
    }
    await until(
      async () =>
        (await evaluateApp(`(() => {
      const el = document.querySelector('#app-sidebar');
      return !!el && !el.inert && el.getAttribute('aria-hidden') !== 'true';
    })()`)) === true,
      "sidebar open and interactive",
    );
  }
  function liveGeometry(sessionId: string, surfaceId: string) {
    const session = BrowserSessionIdSchema.parse(sessionId);
    const source = [...runtimeSources].find((source) => source.hasSession(session));
    const observer = source?.presentSurface(session, BrowserSurfaceIdSchema.parse(surfaceId));
    if (!observer) return null;
    try {
      return observer.geometry();
    } finally {
      observer.release();
    }
  }
  async function hostCapabilities() {
    assert(scenarioContext);
    const selected = await scenarioContext.transport.current();
    assert(
      selected.connection.capabilities,
      "Harness viewers require the actual verified attachment capabilities",
    );
    return selected.connection.capabilities;
  }
  async function selectBrowserTab(sessionId: string, surfaceId: string): Promise<void> {
    if (!process.argv.includes("--no-serial")) await foregroundApp();
    await openSidebar();
    const selector = `[data-place-key="browser:${sessionId}:${surfaceId}"] .side-tab__main`;
    await until(
      async () =>
        (await evaluateApp(`!!document.querySelector(${JSON.stringify(selector)})`)) === true,
      `catalog selection ${sessionId}/${surfaceId}`,
      20000,
    );
    const drawerWasOpen =
      (await evaluateApp(
        "document.querySelector('#app-sidebar')?.classList.contains('sidebar--open')",
      )) === true;
    await clickApp(selector);
    if (drawerWasOpen)
      await until(
        async () =>
          (await evaluateApp(`!document.querySelector('.sidebar-scrim') && !document.getAnimations().some(a =>
        a.playState === 'running' && a.effect?.target instanceof Element && a.effect.target.closest('#app-sidebar'))`)) ===
            true &&
          (shell?.contentView.children.at(-1) !== shell?.appView ||
            (await evaluateApp("!!document.querySelector('.dialog,.popover')")) === true),
        "responsive drawer exit and native sibling handoff",
      );
    await until(
      async () =>
        (await evaluateApp(
          `document.querySelector(${JSON.stringify(selector)})?.closest('.side-tab')?.classList.contains('is-active')`,
        )) === true,
      `selected sidebar target ${sessionId}/${surfaceId}`,
    );
    if (await evaluateApp(`!!document.querySelector('[aria-label="Show computer"]')`))
      await clickApp('[aria-label="Show computer"]');
    await until(
      async () =>
        authorityEvents.some(
          (event, index) =>
            event.type === "admitted" &&
            event.mode === "control" &&
            event.sessionId === sessionId &&
            event.ownerId === shell?.webContents.id &&
            !authorityEvents
              .slice(index + 1)
              .some(
                (later) => later.connectionId === event.connectionId && later.type === "closed",
              ),
        ),
      `selected tab control admission ${sessionId}/${surfaceId}`,
    );
    artifacts.event("selection.admitted", { sessionId, surfaceId });
  }
  async function selectNativePage(sessionId: string, surfaceId: string): Promise<void> {
    await selectBrowserTab(sessionId, surfaceId);
    const dialog = runtimeState(sessionId).ledger.dialogOf(BrowserSurfaceIdSchema.parse(surfaceId));
    if (dialog) {
      // A dialog can block the first compositor frame. Its real sheet must be
      // answerable before any paint/placement readiness wait (spec §11).
      await until(
        async () =>
          (await evaluateApp(
            `(() => {const sheet=document.querySelector('.browser-page-dialog');return !!sheet && sheet.textContent.includes(${JSON.stringify(dialog.message)}) && !!sheet.querySelector('button[type="submit"]:not(:disabled)')})()`,
          )) === true,
        `selected dialog sheet ${sessionId}/${surfaceId}`,
      );
      artifacts.event("selection.dialogReady", { sessionId, surfaceId, dialogId: dialog.id });
      return;
    }
    await until(async () => {
      try {
        const surface = activeSurface();
        if (surface.sessionId !== sessionId || surface.surfaceId !== surfaceId || !latestTarget)
          return false;
        const placed = presentationEvents.findLast((event) => {
          const result = z
            .object({
              type: z.literal("placed"),
              sessionId: z.string(),
              surfaceId: z.string(),
              presentationId: z.string(),
              revision: z.number(),
            })
            .safeParse(event);
          return (
            result.success &&
            result.data.sessionId === sessionId &&
            result.data.surfaceId === surfaceId &&
            result.data.presentationId === latestTarget?.presentationId &&
            result.data.revision === latestTarget?.revision
          );
        });
        if (
          !placed ||
          presentationEvents.slice(presentationEvents.indexOf(placed) + 1).some((event) => {
            const ended = z
              .object({ type: z.literal("ended"), presentationId: z.string() })
              .safeParse(event);
            return ended.success && ended.data.presentationId === latestTarget?.presentationId;
          })
        )
          return false;
        const committed = z
          .object({
            geometryRevision: z.number(),
            bounds: z.object({
              x: z.number(),
              y: z.number(),
              width: z.number(),
              height: z.number(),
            }),
          })
          .parse(placed);
        const view = electronPagePresentation(surface.page)?.view;
        return (
          !!view &&
          !!shell?.contentView.children.includes(view) &&
          surface.geometry()?.geometryRevision === committed.geometryRevision &&
          (["x", "y", "width", "height"] as const).every(
            (axis) => view.getBounds()[axis] === committed.bounds[axis],
          )
        );
      } catch {
        return false;
      }
    }, `admitted native mount ${sessionId}/${surfaceId}`);
    artifacts.event("selection.verified", {
      sessionId,
      surfaceId,
      target: latestTarget,
      windows: windowInventory(),
    });
  }

  async function until(
    condition: () => Promise<boolean>,
    label: string,
    timeout = 10_000,
  ): Promise<void> {
    const started = performance.now();
    const deadline = started + timeout;
    const timeoutError = () => new Error(`Timed out: ${label} after ${timeout}ms`);
    const bounded = <T>(operation: Promise<T>) =>
      withTimeout(operation, Math.max(1, deadline - performance.now()), { timeoutError });
    const states: unknown[] = [];
    artifacts.event("wait.started", { label, timeout });
    try {
      states.push(await bounded(rendererState(`wait begin: ${label}`)));
      let recordedAt = performance.now();
      while (performance.now() < deadline) {
        if (await bounded(condition())) {
          artifacts.event("wait.finished", { label, elapsedMs: performance.now() - started });
          return;
        }
        if (performance.now() - recordedAt >= 1000) {
          states.push(await bounded(rendererState(`wait pending: ${label}`)));
          recordedAt = performance.now();
        }
        await bounded(delay(Math.min(50, Math.max(0, deadline - performance.now()))));
      }
      throw timeoutError();
    } catch (error) {
      artifacts.json(`cases/${currentCase}/wait-${randomUUID()}.json`, {
        label,
        states,
        elapsedMs: performance.now() - started,
        error: errorText(error),
      });
      throw error;
    }
  }

  function errorText(error: unknown): string {
    if (!(error instanceof Error)) {
      if (error && typeof error === "object")
        return JSON.stringify(error, Object.getOwnPropertyNames(error));
      return String(error);
    }
    if (error instanceof AggregateError)
      return `${error.stack ?? error.message}\n${error.errors.map(errorText).join("\n")}`;
    const child = z
      .object({
        code: z.union([z.number(), z.string()]).nullable().optional(),
        signal: z.string().nullable().optional(),
        killed: z.boolean().optional(),
        stdout: z.string().optional(),
        stderr: z.string().optional(),
      })
      .parse(error);
    return `${error.stack ?? error.message}${Object.keys(child).length ? `\n${JSON.stringify(child)}` : ""}${error.cause && error.cause !== error ? `\nCaused by: ${errorText(error.cause)}` : ""}`;
  }

  function target(): { presentationId: string; revision: number } {
    assert(latestTarget, "No production presentation identity");
    return latestTarget;
  }
  async function presentationCall(method: string, input: unknown): Promise<unknown> {
    return evaluateApp(
      `window.opensteerDesktop.browserPresentation[${JSON.stringify(method)}](${JSON.stringify(input)})`,
    );
  }
  async function focusPage(): Promise<void> {
    await foregroundApp();
    await presentationCall("focusPage", target());
    await delay(70);
  }
  function assertAppFront(): void {
    assert(shell);
    assert.equal(shell.contentView.children.at(-1), shell.appView);
  }
  function assertPageFront(): void {
    assert(shell);
    assert.equal(
      shell.contentView.children.at(-1),
      electronPagePresentation(activeSurface().page)?.view,
    );
  }
  function ownGlass(): BaseWindow {
    assert(shell);
    const child = BaseWindow.getAllWindows().find((window) => window.getParentWindow() === shell);
    assert(child);
    return child;
  }
  function glassContents(): WebContents {
    const view = ownGlass().contentView.children.find((view) => "webContents" in view);
    assert(view && "webContents" in view, "Production glass renderer unavailable");
    return (view as Electron.WebContentsView).webContents;
  }
  async function pageMouse(
    selector: string,
    probe = false,
    button: "left" | "right" = "left",
  ): Promise<void> {
    assert(shell);
    const contents = pageContents();
    const point = await elementPoint(contents, selector);
    if (probe || mouseDelivery === "OS PID-targeted mouse") {
      const before = z.number().parse(await contents.executeJavaScript("fixture.clicks"));
      const messagesBefore = incomingMessages.length;
      const bounds = electronPagePresentation(activeSurface().page)!.view.getBounds();
      const screenBounds = shell.getContentBounds();
      const wid = shell.getMediaSourceId().split(":")[1]!;
      try {
        const output = JSON.parse(
          (
            await runFile(
              inputHelper,
              [
                "mouse",
                String(process.pid),
                wid,
                String(screenBounds.x + bounds.x + point.x),
                String(screenBounds.y + bounds.y + point.y),
                button,
              ],
              { timeout: 5000 },
            )
          ).stdout,
        ) as unknown;
        artifacts.event("input.osMouse", { output, point });
        await delay(200);
        if (
          incomingMessages
            .slice(messagesBefore)
            .some(
              (message) =>
                message.type === "browser.dialog.changed" &&
                message.dialog?.surfaceId === activeSurface().surfaceId,
            )
        ) {
          // Chromium holds evaluations while this click's dialog is open. Keep
          // the same delivery assertion, but read its counter after the answer.
          deferredMouseChecks.push(async () => {
            const after = z.number().parse(await contents.executeJavaScript("fixture.clicks"));
            assert(after > before, "OS mouse did not reach the page");
            artifacts.event("input.osMouseVerifiedAfterDialog", { before, after });
          });
          mouseDelivery = "OS PID-targeted mouse";
          return;
        }
        const after = z.number().parse(await contents.executeJavaScript("fixture.clicks"));
        if (after > before) {
          mouseDelivery = "OS PID-targeted mouse";
          return;
        }
      } catch (error) {
        artifacts.event("input.osMouseUnavailable", { error: errorText(error) });
      }
      mouseDelivery = "renderer-targeted mouse stand-in";
    }
    artifacts.event("input.pageMouseStandIn", { selector, point, button });
    mouse(contents, point, button);
    await delay(100);
  }
  async function clickTextButton(label: string): Promise<void> {
    assert(shell);
    let previous = "";
    await until(async () => {
      const bounds = JSON.stringify(
        await evaluateApp(
          `(() => {const el=Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(label)}&&el.getBoundingClientRect().width>0);return el?.getBoundingClientRect().toJSON();})()`,
        ),
      );
      const stable = bounds !== undefined && bounds === previous;
      previous = bounds;
      return stable;
    }, `stable ${label} button`);
    const buttonMarker = randomUUID();
    const selector = z.string().parse(
      await evaluateApp(`(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const el = buttons.find(el => el.textContent.trim() === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0);
      if (!el) throw Error('Missing button');
      el.setAttribute('data-native-harness-button', ${JSON.stringify(buttonMarker)});
      return '[data-native-harness-button="' + ${JSON.stringify(buttonMarker)} + '"]';
    })()`),
    );
    const point = await elementPoint(shell.webContents, selector);
    await evaluateApp(
      `document.querySelector(${JSON.stringify(selector)}).removeAttribute('data-native-harness-button')`,
    );
    mouse(shell.webContents, point);
    await delay(150);
  }
  async function geometryFacts(strict = true): Promise<{
    stage: { x: number; y: number; width: number; height: number };
    bounds: Electron.Rectangle;
    viewport: unknown;
    geometry: unknown;
  }> {
    assert(shell);
    const surface = activeSurface();
    const native = electronPagePresentation(surface.page);
    assert(native);
    const stage = z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .parse(
        await evaluateApp(
          "(() => {const r=document.querySelector('.browser-stage').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()",
        ),
      );
    const bounds = native.view.getBounds();
    const applied = surface.geometry();
    assert(applied);
    const scale = shell.webContents.getZoomFactor();
    const ledger = applied.geometry;
    const size = z
      .object({ width: z.number(), height: z.number() })
      .parse(ledger.agent ?? ledger.person);
    const width = Math.min(Math.round(stage.width * scale), size.width),
      height = Math.min(Math.round(stage.height * scale), size.height);
    const expected = {
      x: Math.round(stage.x * scale + (stage.width * scale - width) / 2),
      y: Math.round(stage.y * scale),
      width: Math.round(width),
      height: Math.round(height),
    };
    const viewport: unknown = native.view.webContents.isLoadingMainFrame()
      ? { pendingNavigation: true, contents: native.view.webContents.id }
      : await withTimeout(
          native.view.webContents.executeJavaScript(
            "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,screenWidth:screen.width,scale:visualViewport.scale})",
          ),
          1000,
          { timeoutError: () => new Error("Page geometry metadata blocked by navigation") },
        );
    if (strict) {
      for (const axis of ["x", "y", "width", "height"] as const)
        assert(
          Math.abs(bounds[axis] - expected[axis]) <= 1,
          `Placement ${axis}: ${JSON.stringify({ bounds, expected, stage, ledger, scale })}`,
        );
      assert.equal(bounds.width, expected.width, "View width must equal min(stage, ledger layout)");
      assert.equal(
        bounds.height,
        expected.height,
        "View height must equal min(stage, ledger layout)",
      );
      const parsed = z.object({ width: z.number(), height: z.number() }).parse(viewport);
      assert.equal(parsed.width, size.width);
      assert.equal(parsed.height, size.height);
    }
    if (strict) {
      const capture = surface.page.capture?.read();
      assert(capture, "Native capture interpretation is still pending");
      assert(capture.revision > 0);
      assert.deepEqual(
        { width: capture.width, height: capture.height },
        { width: bounds.width, height: bounds.height },
      );
    }
    return { stage, bounds, viewport, geometry: applied };
  }
  async function resizeStage(width: number, height: number): Promise<void> {
    assert(shell);
    await focusPage();
    await until(async () => {
      try {
        const actual = await geometryFacts();
        const zoom = shell!.webContents.getZoomFactor();
        if (
          Math.abs(actual.stage.width * zoom - width) <= 1 &&
          Math.abs(actual.stage.height * zoom - height) <= 1
        )
          return true;
        const content = shell!.getContentBounds();
        shell!.setContentSize(
          Math.round(content.width + width - actual.stage.width * zoom),
          Math.round(content.height + height - actual.stage.height * zoom),
        );
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
      }
      return false;
    }, `native stage ${width}×${height}`);
  }

  const captureReply = z.object({
    type: z.literal("native-window-capture-result"),
    requestId: z.uuid(),
    result: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        method: z.enum(["owned-composite", "window", "screen-region"]),
        window: z.unknown(),
        attempts: z.array(z.unknown()),
        parentPid: z.number().int().positive(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({ message: z.string() }).passthrough(),
        attempts: z.array(z.unknown()),
        parentPid: z.number().int().positive(),
      }),
    ]),
  });
  async function captureOsWindow(file: string) {
    const requestId = randomUUID();
    let parentResult: z.infer<typeof captureReply>["result"] | undefined;
    try {
      assert(shell && !shell.isDestroyed(), "Capture requires the owned app window");
      assert(
        process.send && process.connected,
        "OS capture requires the smoke Node parent IPC channel",
      );
      const windowId = z
        .number()
        .int()
        .positive()
        .parse(Number(shell.getMediaSourceId().split(":")[1]));
      const result = await new Promise<z.infer<typeof captureReply>["result"]>(
        (resolve, reject) => {
          const finish = (error?: Error, value?: z.infer<typeof captureReply>["result"]) => {
            clearTimeout(deadline);
            process.off("message", receive);
            process.off("disconnect", disconnected);
            if (error) reject(error);
            else if (value) resolve(value);
          };
          const receive = (message: unknown) => {
            const identity = z.object({ requestId: z.literal(requestId) }).safeParse(message);
            if (!identity.success) return;
            const reply = captureReply.safeParse(message);
            if (!reply.success)
              finish(new Error(`Invalid OS capture reply: ${reply.error.message}`));
            else finish(undefined, reply.data.result);
          };
          const disconnected = () => finish(new Error("OS capture parent disconnected"));
          const deadline = setTimeout(
            () => finish(new Error("OS capture parent timed out after 35 seconds")),
            35_000,
          );
          process.on("message", receive);
          process.once("disconnect", disconnected);
          try {
            process.send!(
              { type: "native-window-capture", requestId, windowId, pid: process.pid, file },
              (error: Error | null) => {
                if (error) finish(error);
              },
            );
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );
      parentResult = result;
      artifacts.event("capture.parentReply", {
        requestId,
        file: path.relative(run, file),
        ...result,
      });
      assert(result.ok, result.ok ? "" : `Parent OS capture failed: ${result.error.message}`);
      return result;
    } catch (error) {
      const evidence = {
        requestId,
        file: path.relative(run, file),
        error: errorText(error),
        parentEvidence: `logs/window-captures/${requestId}.json`,
        parentResult,
      };
      artifacts.json(`${path.relative(run, file).slice(0, -4)}-capture-error.json`, evidence);
      artifacts.event("capture.failure", evidence);
      throw error;
    }
  }
  function fixtureHtml(): string {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native fixture</title><style>
html,body{margin:0;background:#124c78;color:white;font:16px system-ui}body{min-height:2400px;background-image:linear-gradient(#ffffff18 1px,transparent 1px),linear-gradient(90deg,#ffffff18 1px,transparent 1px);background-size:50px 50px}header{height:36px;background:#00b873}button,input,textarea,select{font:16px system-ui;margin:8px;padding:8px}#marker{position:fixed;bottom:0;right:0;width:32px;height:32px;background:#ff00ff}#counter{display:inline-block;min-width:100px}canvas{image-rendering:pixelated}
</style><header><b id="identity"></b> <span id="counter"></span></header><textarea id="text">alpha beta</textarea><div contenteditable id="editable">alpha beta</div><button id="click">Click</button><select id="select"><option>A</option><option>B</option></select><button id="popup">Popup</button><button id="fullscreen">Fullscreen</button><button id="alert">Alert</button><button id="confirm">Confirm</button><button id="prompt">Prompt</button><a id="link" href="/q">Local link</a><img src="/image.svg" id="image"><p>needle</p><p>needle</p><p>needle</p><div id="marker"></div><script>
const name=location.pathname.slice(1)||'p';document.title='Native fixture '+name;identity.textContent=name.toUpperCase();if(name==='q')document.body.style.backgroundColor='#663087';
window.fixture={clicks:0,keys:0,resize:[],raf:0,result:null,events:[]};
addEventListener('mousedown',e=>{fixture.clicks++;fixture.events.push({type:'mouseDown',x:e.clientX,y:e.clientY,button:e.button})});
addEventListener('keydown',e=>{fixture.keys++;fixture.events.push({type:'keyDown'})});addEventListener('resize',()=>fixture.resize.push({width:innerWidth,height:innerHeight}));
function tick(){fixture.raf++;counter.textContent=String(fixture.raf);requestAnimationFrame(tick)}requestAnimationFrame(tick);
popup.onclick=()=>open('/q','_blank');fullscreen.onclick=()=>document.documentElement.requestFullscreen();document.getElementById('alert').onclick=()=>{alert('fixture alert');fixture.result='alert answered'};document.getElementById('confirm').onclick=()=>{fixture.result=confirm('fixture confirm')};document.getElementById('prompt').onclick=()=>{try{fixture.result=prompt('fixture prompt')}catch(e){fixture.result=e.message}};
</script>`;
  }

  let scenarioContext: NativeBrowserScenarioContext | null = null;
  let initialIdentity: {
    surface: PresentedSurface;
    contents: WebContents;
    timeOrigin: unknown;
  } | null = null;
  async function agentCdp(surface = activeSurface()) {
    const router = runtimeState(surface.sessionId).host.router;
    const sessionId = surface.sessionId;
    const attached = z.object({ sessionId: z.string() }).parse(
      await router.send(sessionId, {
        method: "Target.attachToTarget",
        parameters: { targetId: await surface.page.targetId(), flatten: true },
      }),
    );
    artifacts.event("agent.channel", {
      surfaceId: surface.surfaceId,
      route: "session-scoped-router",
      hostRouted: false,
    });
    cleanup.push(async function closeAgentChannel() {
      await router.send(sessionId, {
        method: "Target.detachFromTarget",
        parameters: { sessionId: attached.sessionId },
      });
    });
    return {
      send: (method: string, parameters?: CdpParameters) =>
        router.send(sessionId, {
          method,
          ...(parameters ? { parameters } : {}),
          sessionId: attached.sessionId,
        }),
    };
  }
  // Runtime internals are discovered once here because production deliberately
  // exposes no IPC that grants a test an agent attachment or controller.
  function runtimeControllers() {
    return [...runtimeSources]
      .filter((source): source is BrowserRuntime => source instanceof BrowserRuntime)
      .flatMap((runtime) =>
        [
          ...z
            .map(z.string(), z.object({ controller: z.instanceof(BrowserController) }))
            .parse(Reflect.get(runtime, "sessions"))
            .values(),
        ].map((state) => state.controller),
      );
  }
  function runtimeState(sessionId = context().sessionId) {
    const runtime = [...runtimeSources].find(
      (source) =>
        source instanceof BrowserRuntime &&
        source.hasSession(BrowserSessionIdSchema.parse(sessionId)),
    );
    assert(runtime, "Live Personal BrowserRuntime unavailable");
    const sessions = z
      .map(
        z.string(),
        z.object({
          controller: z.instanceof(BrowserController),
          ledger: z.instanceof(SurfaceLedger),
          host: z.object({ router: z.instanceof(SessionCdpRouter) }),
        }),
      )
      .parse(Reflect.get(runtime, "sessions"));
    const state = sessions.get(sessionId);
    assert(state, "Real session controller unavailable");
    return state;
  }
  function context() {
    assert(scenarioContext);
    return scenarioContext;
  }
  const kitApi = {
    /** Deterministic loopback fixture bytes; page state is controlled through pageContents(). */
    fixtureHtml,
    /** Per-case JSON and append-only sanitized main trace. */
    artifacts,
    /** Unique private artifact directory. */
    run,
    /** Unique private Personal stack and profile root. */
    root,
    /** PID-guarded native input executable in this run. */
    inputHelper,
    /** Bounded external commands; target only owned processes/windows. */
    runFile,
    /** LIFO teardown registrations for resources owned by this run. */
    cleanup,
    /** Final witnesses after owned page destruction, before cleanup inventory/quit. */
    afterCleanup,
    /** Actual registered runtime presentation sources. */
    runtimeSources,
    /** Observed real presented surfaces, keyed by surface ID. */
    pages,
    /** Underlying debugger Input command IDs pending per webContents. */
    rawOutstanding,
    /** Page IDs paused by real JavaScript dialogs. */
    dialogPages,
    /** Ordered actual Host socket admission/revocation observations. */
    authorityEvents,
    /** Observed geometry event history. */
    geometry,
    /** Personal service child exit witnesses. */
    ownedChildren,
    /** Process descendants owned by this harness. */
    ownedPids,
    /** Production renderer/preload errors. */
    consoleErrors,
    /** Production bridge presentation notifications. */
    presentationEvents,
    workspaceCommands,
    /** Parsed real Host browser messages. */
    incomingMessages,
    /** Actual renderer-to-Host message metadata. */
    outgoing,
    /** Delivery assertions deferred until a real dialog is answered. */
    deferredMouseChecks,
    /** Read or exercise the production app renderer. */
    evaluateApp,
    /** Visible production app text. */
    body,
    /** Click measured app UI; explicitly a renderer mouse stand-in. */
    clickApp,
    /** Measure the centre of a real DOM element. */
    elementPoint,
    /** Paired renderer-targeted mouse stand-in; bypasses native hit-testing. */
    mouse,
    /** Paired PID-targeted OS key events; never global input. */
    key,
    /** Actual owned Electron windows and child order. */
    windowInventory,
    /** Resolve the actual native child currently mounted. */
    activeSurface,
    /** Actual mounted page webContents. */
    pageContents,
    /** Own-window OS PNG plus contemporaneous rect measurements; no page fallback. */
    snapshot,
    /** Write stage, page, authority, focus and window measurements. */
    rects,
    /** Predicate readiness with a bounded deadline. */
    until,
    /** Preserve structured child errors without swallowing them. */
    errorText,
    /** Latest real presentation identity and revision. */
    target,
    /** Call production presentation IPC through the sandboxed preload. */
    presentationCall,
    /** Activate only this owned app and focus its page through IPC. */
    focusPage,
    /** Assert app view is the top native sibling. */
    assertAppFront,
    /** Assert mounted page is the top native sibling. */
    assertPageFront,
    /** Resolve the actual owned production glass window. */
    ownGlass,
    /** Attempt PID-targeted OS delivery; label renderer stand-in when required. */
    pageMouse,
    /** Click a measured production button once its bounds are stable. */
    clickTextButton,
    /** Measure real stage/ledger/view/viewport and optionally assert geometry. */
    geometryFacts,
    /** Converge native window size on measured production stage dimensions. */
    resizeStage,
    /** Open the real runtime hub agent channel; trace labels it non-Host-routed. */
    agentCdp,
    /** Existing live controller/ledger; read-only discovery never creates authority. */
    runtimeState,
    /** Actual runtime controllers, including the independent remote viewers. */
    runtimeControllers,

    /** Foreground the owned window before catalog-dependent waits. */
    foregroundApp,
    /** Record renderer visibility, native focus and live client snapshot without secrets. */
    rendererState,
    /** Open either responsive sidebar control and wait for interaction. */
    openSidebar,
    /** Hit-tested UI selection followed by selected-row, admission and mount checks. */
    selectNativePage,
    /** Verify exclusive foreground ownership and settled cursor before native key sampling. */
    inputReady,
    /** Hit-tested catalog selection and live control admission; paint gates are asserted by their owning oracle. */
    selectBrowserTab,
    /** Real verified attachment capabilities for independently constructed Host clients. */
    hostCapabilities,
    /** Read current ledger geometry through an independent short-lived runtime handle, even while unmounted. */
    liveGeometry,
    /** Resolve the actual glass WebContentsView, rather than treating its BaseWindow as a BrowserWindow. */
    glassContents,
    /** Current owned production app window; bootstrap alone replaces it. */
    get shell() {
      return shell;
    },
    set shell(value: ElectronAppWindow | null) {
      shell = value;
    },
    /** Real presentation notification identity; never fabricate admission. */
    set latestTarget(value: { presentationId: string; revision: number } | null) {
      latestTarget = value;
    },
    /** Case currently executing, for fatal evidence attribution. */
    get currentCase() {
      return currentCase;
    },
    /** Successful OS capture count. */
    get captured() {
      return captured;
    },
    /** Measured mouse delivery class, never inferred from a successful post. */
    get mouseDelivery() {
      return mouseDelivery;
    },
    /** Attach the real stack after bootstrap. */
    setContext(value: NativeBrowserScenarioContext) {
      scenarioContext = value;
    },
    /** Real Host, runtime, fixture and admission gate handles. */
    get context(): NativeBrowserScenarioContext {
      assert(scenarioContext);
      return scenarioContext;
    },
    /** Preserve the original pre-scenario page identity. */
    async rememberInitialIdentity() {
      const surface = activeSurface();
      const contents = pageContents();
      initialIdentity = {
        surface,
        contents,
        timeOrigin: (await contents.executeJavaScript("performance.timeOrigin")) as unknown,
      };
    },
    /** Initial mounted surface/webContents/timeOrigin, before destructive probes. */
    get initial() {
      assert(initialIdentity);
      return initialIdentity;
    },
  };
  return kitApi;
}
export type NativeBrowserE2EKit = ReturnType<typeof createNativeBrowserE2EKit>;
