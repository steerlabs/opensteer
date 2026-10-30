import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { SessionCdpRouter, type CdpParameters } from "@opensteer/browser-core";
import {
  BrowserController,
  HostSignIns,
  SessionFiles,
  SurfaceLedger,
} from "@opensteer/browser-runtime-core";
import { FakeSink, validClaims } from "@opensteer/browser-runtime-core/test-support";
import { serveHarnessActionsFixture } from "@opensteer/browser-runtime-core/test-support/harness-actions";
import {
  TestChromiumLauncher,
  browserTestSignal,
  cleanup,
  findChromium,
  waitForBrowserState,
  withBrowserTestSignal,
} from "./browser-test-lifecycle.js";
import {
  harnessScript,
  HarnessRunError,
  runHarness,
  sendAsAgent,
  startHarnessBridge,
} from "./browser-harness.test-support.js";

const executablePath = findChromium();
const evidenceRoot =
  process.env.OPENSTEER_HARNESS_ACTIONS_EVIDENCE_DIR ?? join(tmpdir(), "opensteer-harness-actions");
const command = "pnpm exec vitest run apps/browser-runtime/src/browser/harness-actions*.test.ts";
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

async function startActionJourney(id: string, report: Record<string, unknown>) {
  const site = await serveHarnessActionsFixture();
  cleanup.push(() => site.close());
  const claims = validClaims();
  const browser = await new TestChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  }).launch({
    initialViewport: { width: 1000, height: 700, devicePixelRatio: 1 },
    partitionKey: `session:${claims.sessionId}`,
    sessionId: claims.sessionId,
    snapshot: { cookies: [], origins: [] },
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
    exportSnapshot: () => browser.exportSnapshot(),
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
      platform.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
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
      timeoutMs?: number;
      onStderrLine?: (line: string) => void;
    } = {},
  ) => {
    const record: Record<string, unknown> = {
      program,
      args: ["--session", claims.sessionId, ...(options.inventory ? [] : ["--tab", targetId])],
    };
    runs.push(record);
    try {
      const result = await runHarness(
        bridge.url,
        claims.sessionId,
        options.inventory ? undefined : targetId,
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
    platform,
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
