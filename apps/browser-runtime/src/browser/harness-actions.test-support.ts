import { createBrowserSessionId, BrowserSurfaceIdSchema } from "@opensteer/protocol";
import {
  BrowserAgentTabListQuerySchema,
  BrowserAgentTabListResultSchema,
  BrowserAgentTabUseInputSchema,
  BrowserAgentTabUseResultSchema,
  BrowserAgentTabOpenInputSchema,
  BrowserAgentTabOpenResultSchema,
  BrowserAgentTabCloseInputSchema,
  BrowserAgentTabCloseResultSchema,
  BrowserAgentTabOrganizeInputSchema,
  BrowserAgentTabOrganizeResultSchema,
  type BrowserAgentTabOpenResult,
  type BrowserAgentTab,
} from "@opensteer/protocol/browser-agent";
import {
  BrowserActionRequestSchema,
  BrowserActionResponseSchema,
} from "@opensteer/protocol/browser-actions";
import { SessionCdpRouter, type CdpParameters } from "@opensteer/browser-core";
import {
  BrowserController,
  HostSignIns,
  SessionFiles,
  SurfaceLedger,
} from "@opensteer/browser-runtime-core";
import { FakeSink, validClaims } from "@opensteer/browser-runtime-core/test-support";
import { serveHarnessActionsFixture } from "@opensteer/browser-runtime-core/test-support/harness-actions";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  HarnessRunError,
  harnessScript,
  runHarness,
  sendAsAgent,
  startHarnessBridge,
} from "./browser-harness.test-support.js";
import {
  TestChromiumLauncher,
  browserTestSignal,
  cleanup,
  findChromium,
  waitForBrowserState,
  withBrowserTestSignal,
} from "./browser-test-lifecycle.js";

const executablePath = findChromium();
const evidenceRoot =
  process.env.OPENSTEER_HARNESS_ACTIONS_EVIDENCE_DIR ?? join(tmpdir(), "opensteer-harness-actions");
const command = "pnpm test:browser -- apps/browser-runtime/src/browser/harness-actions";
const programAssertions = `
function assert(value, message) { if (!value) throw new Error('Contract assertion: '+message); }
async function fails(action, pattern) {
  try { await action(); } catch(error) {
    assert(pattern.test(String(error)), 'expected '+pattern+', received '+String(error));
    return {name:error.name,message:error.message,dialog:error.dialog};
  }
  throw new Error('Contract assertion: expected failure '+pattern);
}
`;

interface CommandTrace {
  method: string;
  parameters?: CdpParameters | undefined;
  sessionId?: string | undefined;
  at: number;
  finished?: number;
  error?: string;
}
type Kit = Awaited<ReturnType<typeof startActionJourney>>;

export async function startActionJourney(id: string, report: Record<string, unknown>) {
  const site = await serveHarnessActionsFixture();
  cleanup.push(() => site.close());
  const claims = { ...validClaims(), sessionId: createBrowserSessionId() };
  const browser = await new TestChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  }).launch({
    initialViewport: { width: 1000, height: 700, devicePixelRatio: 1 },
    partitionKey: `session:${claims.sessionId}`,
    sessionId: claims.sessionId,
    storage: { kind: "guest" },
  });
  const root = browser.context.pages()[0]!;
  const targetId = await root.targetId();
  const router = new SessionCdpRouter(browser.cdp);
  cleanup.push(() => router.close());
  const files = new SessionFiles(join(tmpdir(), `opensteer-actions-${randomUUID()}`));
  cleanup.push(() => files.dispose());
  const ledger = new SurfaceLedger(browser.context, {
    claimTarget: (target) => router.claimTarget(claims.sessionId, target),
    rootPages: [root],
    initialViewport: { width: 1000, height: 700, devicePixelRatio: 1 },
  });
  router.registerSession(
    claims.sessionId,
    targetId,
    (target) => ledger.resolveTarget(target),
    files.root,
  );
  await ledger.start();
  cleanup.push(() => ledger.close());
  const sink = new FakeSink();
  const controller = new BrowserController({
    cdpRouter: router,
    claims,
    files,
    ledger,
    sink,
    replaceSiteCookies: (site, cookies, signal) =>
      browser.replaceSiteCookies(site, cookies, signal),
    signIns: new HostSignIns({ authority: undefined, runtimeId: "actions-test" }),
  });
  await controller.start();
  cleanup.push(() => controller.close());
  const surfaceId = ledger.surfaceIdForTarget(targetId)!;
  cleanup.push(async () => {
    for (const surface of ledger.snapshot()) {
      const dialog = ledger.dialogOf(surface.id);
      if (dialog) await ledger.answerDialog(dialog.id, false, undefined);
    }
  });
  const platform = ledger.binding(surfaceId)!.cdp;
  const read = async <T = unknown>(expression: string): Promise<T> => {
    const result = await withBrowserTestSignal(
      ledger
        .binding(surfaceId)!
        .cdp.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }),
    );
    if (result.exceptionDetails)
      throw new Error(`Oracle evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  };
  const navigate = async (url: string) => {
    await platform.send("Page.navigate", { url });
    await waitForBrowserState(() =>
      read<boolean>(
        `location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && !!window.fixture?.ready`,
      ),
    );
  };
  await navigate(site.url(id));
  if (id === "05" || id === "engine")
    await waitForBrowserState(() =>
      read<boolean>(
        `!!window.fixture.react && !!document.querySelector('${id === "05" ? "#controlled" : "#zip"}')`,
      ),
    );
  const trace: CommandTrace[] = [];
  const hooks: {
    before?: (method: string, parameters?: CdpParameters, sessionId?: string) => Promise<void>;
    /** Runs after the browser answered, before the reply reaches the harness. */
    after?: (method: string, parameters?: CdpParameters) => Promise<void>;
  } = {};
  const bridge = await startHarnessBridge(async (method, parameters, sessionId) => {
    const entry: CommandTrace = { method, parameters, sessionId, at: performance.now() };
    trace.push(entry);
    try {
      await hooks.before?.(method, parameters, sessionId);
      const result = await sendAsAgent(
        (message) => controller.handle(message),
        sink.messages,
        method,
        parameters,
        sessionId,
      );
      await hooks.after?.(method, parameters);
      return result;
    } catch (error) {
      entry.error = String(error);
      throw error;
    } finally {
      entry.finished = performance.now();
    }
  }, sink);
  cleanup.push(() => bridge.close());
  const runs: Record<string, unknown>[] = [];
  Object.assign(report, {
    browser: await browser.cdp.send("Browser.getVersion"),
    fixtureSha256: site.sha256,
    executablePlatform: process.platform,
    chromiumExecutable: executablePath,
    trace,
    runs,
    requests: site.requests,
  });
  const run = async (
    program: string,
    options: {
      inventory?: boolean;
      tab?: string;
      timeoutMs?: number;
      onStderrLine?: (line: string) => void;
    } = {},
  ) => {
    const record: Record<string, unknown> = {
      program,
      args: options.inventory ? [] : ["--tab", targetId],
    };
    runs.push(record);
    try {
      const result = await runHarness(
        bridge.url,
        claims.sessionId,
        options.inventory ? undefined : (options.tab ?? targetId),
        programAssertions + program,
        {
          timeoutMs: options.timeoutMs ?? 15_000,
          ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
        },
      );
      Object.assign(record, result);
      return result;
    } catch (error) {
      Object.assign(
        record,
        error instanceof HarnessRunError ? error.output : { error: String(error) },
      );
      throw error;
    }
  };
  const state = () =>
    read<Record<string, unknown>>(`({ ...fixture,
    url:location.href,visibility:document.visibilityState,active:document.activeElement?.id,
    inputs:Object.fromEntries([...document.querySelectorAll('input,textarea')].map(e=>[e.id,{value:e.value,checked:e.checked}])),
    shadowValue:document.querySelector('#shadow-host')?.shadowRoot?.querySelector('input')?.value,
    editor:document.querySelector('#editor')?.textContent,
    selected:[...document.querySelectorAll('select')].map(e=>({id:e.id,values:[...e.selectedOptions].map(o=>o.value)})),
    results:document.querySelector('#results')?.textContent,
    activations:Number(sessionStorage.getItem('activations')||0)
  })`);
  return {
    site,
    claims,
    browser,
    root,
    targetId,
    router,
    ledger,
    controller,
    sink,
    surfaceId,
    get platform() {
      return ledger.binding(surfaceId)!.cdp;
    },
    read,
    navigate,
    trace,
    hooks,
    run,
    state,
  };
}

export function acceptance(
  id: string,
  title: string,
  body: (kit: Kit, report: Record<string, unknown>) => Promise<void>,
  fixtureId = id,
) {
  it(`A${id} ${title}`, async () => {
    const directory = join(evidenceRoot, id);
    await mkdir(directory, { recursive: true });
    const moduleHashes = Object.fromEntries(
      await Promise.all(
        (await readdir(dirname(harnessScript)))
          .filter((name) => name.endsWith(".mjs"))
          .map(async (name) => [
            name,
            createHash("sha256")
              .update(await readFile(join(dirname(harnessScript), name)))
              .digest("hex"),
          ]),
      ),
    );
    const report: Record<string, unknown> = {
      case: id,
      title,
      contract: "design.md v2 Acceptance 1–20",
      startedAt: new Date().toISOString(),
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      executable: harnessScript,
      executableSha256: moduleHashes["browser-harness.mjs"],
      moduleHashes,
      rerunCommand: `OPENSTEER_HARNESS_ACTIONS_EVIDENCE_DIR=${JSON.stringify(evidenceRoot)} ${command} -t ${JSON.stringify(`A${id} `)}`,
    };
    let kit: Kit | undefined;
    let journeyFailure: unknown;
    try {
      kit = await startActionJourney(fixtureId, report);
      await body(kit, report);
      report.passed = true;
    } catch (error) {
      report.passed = false;
      report.failure =
        error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
      journeyFailure = error;
    } finally {
      if (kit && !browserTestSignal().aborted) {
        report.dialogs = kit.sink.messages.filter(
          (message) => message.type === "browser.dialog.changed" || message.type === "cdp.event",
        );
        // Dialogs block evaluation/capture. Answer only this journey's observed identities first.
        for (let i = 0; i < 4; i++) {
          const dialog = kit.ledger.dialogOf(kit.surfaceId);
          if (!dialog) break;
          await kit.ledger.answerDialog(dialog.id, false, undefined).catch((error) => {
            report.dialogCleanupError = String(error);
          });
        }
        try {
          report.finalState = await kit.state();
          const screenshot = await kit.platform.send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
          });
          await writeFile(join(directory, "page.png"), Buffer.from(screenshot.data, "base64"));
          report.screenshot = join(directory, "page.png");
        } catch (error) {
          report.oracleError = String(error);
          if (report.passed) {
            journeyFailure = error;
            report.passed = false;
            report.failure = { message: `Required page evidence failed: ${String(error)}` };
          }
        }
      }
      report.finishedAt = new Date().toISOString();
      await writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n");
    }
    if (journeyFailure) throw journeyFailure;
  }, 60_000);
}

/**
 * Waits for every command the bridge received to settle. A harness that leaves
 * early (the defects these cases catch) must not cut the evidence short.
 */
export async function traceSettled(kit: Kit, timeoutMs = 10_000): Promise<void> {
  const until = performance.now() + timeoutMs;
  while (kit.trace.some((e) => e.finished === undefined) && performance.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Every agent object group was released exactly once, successfully, before the
 * detach of the session that owned it (matched by session, not by time).
 */
export function expectGroupsReleasedBeforeDetach(kit: Kit): string[] {
  const groups = new Map<string, { sessionId: string | undefined; group: string }>();
  for (const e of kit.trace)
    if (
      typeof e.parameters?.objectGroup === "string" &&
      e.parameters.objectGroup.startsWith("opensteer-op-")
    )
      groups.set(JSON.stringify([e.sessionId, e.parameters.objectGroup]), {
        sessionId: e.sessionId,
        group: e.parameters.objectGroup,
      });
  expect(groups.size).toBeGreaterThan(0);
  for (const [key, { sessionId, group }] of groups) {
    const releases = kit.trace.filter(
      (e) =>
        e.method === "Runtime.releaseObjectGroup" &&
        e.sessionId === sessionId &&
        e.parameters?.objectGroup === group,
    );
    expect(releases, key).toHaveLength(1);
    const detach = kit.trace.find(
      (e) => e.method === "Target.detachFromTarget" && e.parameters?.sessionId === sessionId,
    );
    expect(detach, key).toBeDefined();
    expect(releases[0]!.error, key).toBeUndefined();
    expect(releases[0]!.finished, key).toBeDefined();
    expect(releases[0]!.finished!, key).toBeLessThanOrEqual(detach!.at);
  }
  return [...groups.keys()];
}

export async function startTabJourney() {
  const first = await startActionJourney("20", {});
  const second = await startActionJourney("20", {});
  const kits = [first, second];
  const calls: Array<{ path: string; input: Record<string, unknown> }> = [];
  const opens = new Map<string, BrowserAgentTabOpenResult>();
  let uncertainOpen = false;
  const phoneId = BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`);
  const phoneSession = createBrowserSessionId();
  const phoneBinding = {
    surfaceId: phoneId,
    documentId: "phone-doc",
    geometryRevision: 1,
    title: "Phone",
    url: "https://phone.test/",
    state: "live",
  };
  const bridge = await startHarnessBridge(
    async (method, parameters, sessionId, browserSessionId) => {
      const kit = kits.find((candidate) => candidate.claims.sessionId === browserSessionId);
      if (!kit) throw new Error("Wrong browser binding");
      await kit.hooks.before?.(method, parameters, sessionId);
      const result = await sendAsAgent(
        (message) => kit.controller.handle(message),
        kit.sink.messages,
        method,
        parameters,
        sessionId,
      );
      await kit.hooks.after?.(method, parameters);
      return result;
    },
    undefined,
    {
      agent: async (path, input, query) => {
        calls.push({ path, input });
        const rows: BrowserAgentTab[] = kits.flatMap((kit) =>
          kit.ledger.snapshot().map((tab) => ({
            tabId: tab.id,
            title: tab.title,
            url: tab.url,
            profile: null,
            computer: "Test computer",
            state: tab.state === "suspended" ? "asleep" : "open",
            usedByThisTask: true,
            usedByOtherTask: false,
            groupId: null,
          })),
        );
        rows.push({
          tabId: phoneId,
          title: "Phone",
          url: phoneBinding.url,
          profile: null,
          computer: "Phone",
          state: "open",
          usedByThisTask: false,
          usedByOtherTask: false,
          groupId: null,
        });
        if (path === "tabs") {
          const parsed = BrowserAgentTabListQuerySchema.parse(Object.fromEntries(query));
          const filtered = rows.filter(
            (tab) =>
              (!parsed.query || `${tab.title} ${tab.url}`.includes(parsed.query)) &&
              (!parsed.state || tab.state === parsed.state),
          );
          const offset = Number(parsed.cursor ?? 0);
          return BrowserAgentTabListResultSchema.parse({
            tabs: filtered.slice(offset, offset + parsed.limit),
            total: filtered.length,
            nextCursor:
              offset + parsed.limit < filtered.length ? String(offset + parsed.limit) : null,
          });
        }
        if (path === "tabs/use") {
          const { tabId } = BrowserAgentTabUseInputSchema.parse(input);
          if (tabId === phoneId)
            return BrowserAgentTabUseResultSchema.parse({
              tabId,
              sessionId: phoneSession,
              backend: "actions",
              reloaded: false,
            });
          const kit = kits.find((candidate) =>
            candidate.ledger.snapshot().some((tab) => tab.id === tabId),
          );
          if (!kit) throw new Error("Tab unavailable");
          return BrowserAgentTabUseResultSchema.parse({
            tabId,
            sessionId: kit.claims.sessionId,
            backend: "cdp",
            reloaded: false,
          });
        }
        if (path === "tabs/open") {
          const parsed = BrowserAgentTabOpenInputSchema.parse(input);
          let result = opens.get(parsed.operationKey);
          if (!result) {
            const kit = second;
            await kit.controller.handle({
              type: "surface.open",
              ...(parsed.url === "about:blank" ? {} : { url: parsed.url! }),
            });
            result = BrowserAgentTabOpenResultSchema.parse({
              tabId: kit.ledger.active()!.surface.id,
              sessionId: kit.claims.sessionId,
              backend: "cdp",
            });
            opens.set(parsed.operationKey, result);
          }
          if (uncertainOpen) {
            uncertainOpen = false;
            // The Host's own uncertain-open refusal: a conflict naming its reason.
            return Response.json(
              {
                error: {
                  code: "conflict",
                  message:
                    "Opening did not confirm its outcome. Retry this request to recover its original page.",
                  reason: "browser-tab-open-outcome-unknown",
                  retryable: false,
                },
              },
              { status: 409 },
            );
          }
          return result;
        }
        if (path === "tabs/close") {
          const { tabIds } = BrowserAgentTabCloseInputSchema.parse(input);
          for (const tabId of tabIds) {
            const kit = kits.find((candidate) =>
              candidate.ledger.snapshot().some((tab) => tab.id === tabId),
            )!;
            await kit.ledger.closeSurface(tabId);
          }
          return BrowserAgentTabCloseResultSchema.parse({ closed: tabIds, failed: [] });
        }
        if (path === "tabs/organize") {
          const parsed = BrowserAgentTabOrganizeInputSchema.parse(input);
          return BrowserAgentTabOrganizeResultSchema.parse({ action: parsed.action });
        }
        throw new Error(`Unknown agent route ${path}`);
      },
      actions: async (raw) => {
        const message = BrowserActionRequestSchema.parse(raw);
        const type = message.action.type;
        const response = BrowserActionResponseSchema.parse({
          id: message.id,
          result:
            type === "session.tabs"
              ? { type, tabs: [phoneBinding], nextCursor: null }
              : type === "surface.attach"
                ? { type, binding: phoneBinding }
                : type === "page.info"
                  ? {
                      type,
                      binding: phoneBinding,
                      loading: false,
                      navigationFailed: false,
                      sizedByAgent: false,
                      dialog: null,
                    }
                  : type === "dom.query"
                    ? { type, value: "Phone text" }
                    : { type, outcome: "acted", trusted: false },
        });
        if (!("result" in response)) throw new Error("Action fixture returned an error");
        return response.result;
      },
    },
  );
  cleanup.push(() => bridge.close());
  return {
    first,
    second,
    calls,
    opens,
    phoneId,
    uncertainOpen: () => {
      uncertainOpen = true;
    },
    run: (program: string, tab?: string) =>
      runHarness(bridge.url, first.claims.sessionId, tab, programAssertions + program),
  };
}
