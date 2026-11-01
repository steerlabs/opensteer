import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
import { idleLifecyclePhase } from "./electron-idle-lifecycle-smoke.js";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BaseWindow, contentTracing, webContents } from "electron";
import { z } from "zod";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { ElectronBrowserLauncher } from "../src/browser/electron-browser-launcher.js";

const smokeDownloads = smokeDesktopDownloads();

/** Run from the browser smoke, with its isolated profile and headless app. */
export async function idleCpuPhase(): Promise<void> {
  const directory = process.env.OPENSTEER_BROWSER_E2E_ARTIFACT_DIR;
  assert(directory, "OPENSTEER_BROWSER_E2E_ARTIFACT_DIR is required for idle CPU evidence.");
  await mkdir(directory, { recursive: true });
  const browser = await new ElectronBrowserLauncher({
    downloads: smokeDownloads,
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  }).launch({
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    partitionKey: "profile:bpr_00000000-0000-4000-8000-000000000044",
    sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000044"),
    storage: { kind: "legacy", snapshot: { cookies: [], origins: [] } },
  });
  const page = browser.context.pages()[0];
  assert(page);
  const platform = await page.cdp();
  const evaluate = async (expression: string) =>
    z
      .object({ result: z.object({ value: z.unknown() }) })
      .parse(await platform.send("Runtime.evaluate", { expression, returnByValue: true })).result
      .value;
  const phases: unknown[] = [];
  try {
    if (process.env.OPENSTEER_IDLE_VISIBILITY_ONLY === "1") {
      await idleLifecyclePhase(platform, directory);
      return;
    }
    await platform.send("Runtime.evaluate", {
      expression: `document.body.innerHTML = '<div style="width:600px;height:400px;background:blue"></div>'; globalThis.idleRaf = 0; function tick() { idleRaf++; document.body.firstChild.style.transform = 'translateX(' + (idleRaf % 40) + 'px)'; requestAnimationFrame(tick); } requestAnimationFrame(tick);`,
    });
    const target = await page.targetId();
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.debugger.isAttached());
    assert(contents);
    const measure = async (name: string, sampleMs: number) => {
      const demanded = name === "agent-demand";
      const deadline = performance.now() + 5_000;
      while (
        contents.backgroundThrottling === demanded ||
        (demanded && z.number().parse(await evaluate("idleRaf")) === 0)
      ) {
        assert(performance.now() < deadline, `${name} demand did not settle`);
        await delay(25);
      }
      const before = app.getAppMetrics();
      const rafBefore = z.number().parse(await evaluate("idleRaf"));
      const started = performance.now();
      await contentTracing.startRecording({
        included_categories: ["cc", "viz", "toplevel", "blink"],
      });
      await delay(sampleMs);
      const tracePath = await contentTracing.stopRecording(
        path.join(directory, `${name}-trace.json`),
      );
      const elapsedSeconds = (performance.now() - started) / 1_000;
      const after = app.getAppMetrics();
      const rafAfter = z.number().parse(await evaluate("idleRaf"));
      const trace = z
        .object({
          traceEvents: z.array(z.object({ pid: z.number(), name: z.string() }).passthrough()),
        })
        .parse(JSON.parse(await readFile(tracePath, "utf8")));
      const cpu = after.map((metric) => {
        const previous = before.find((entry) => entry.pid === metric.pid);
        const start = previous?.cpu.cumulativeCPUUsage;
        const end = metric.cpu.cumulativeCPUUsage;
        return {
          pid: metric.pid,
          type: metric.type,
          start,
          end,
          percentOneCore:
            start === undefined || end === undefined
              ? null
              : (100 * (end - start)) / elapsedSeconds,
          compositorEvents: trace.traceEvents.filter(
            (event) =>
              event.pid === metric.pid &&
              /DrawFrame|BeginFrame|Composite|DrawAndSwap/i.test(event.name),
          ).length,
        };
      });
      const result = {
        name,
        elapsedSeconds,
        rendererPid: contents.getOSProcessId(),
        rafBefore,
        rafAfter,
        rafDelta: rafAfter - rafBefore,
        visibility: await evaluate("document.visibilityState"),
        backgroundThrottling: contents.backgroundThrottling,
        windows: BaseWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          opacity: window.getOpacity(),
        })),
        cpu,
        tracePath,
      };
      phases.push(result);
      process.stdout.write(`${JSON.stringify({ event: "idle-cpu.phase", ...result })}\n`);
      return result;
    };
    // Only the released phase asserts CPU: eight seconds gives a 0.4 CPU-second
    // budget at 5% of one core. The other phases only need to observe animation.
    await measure("never-demanded", 1_000);
    const agent = await browser.cdp.attach(target);
    await agent.send("Runtime.evaluate", { expression: "document.body.dataset.agentUsed = 'yes'" });
    const active = await measure("agent-demand", 1_000);
    await agent.close();
    const released = await measure("agent-released", 8_000);
    await writeFile(
      path.join(directory, "electron-idle-cpu.json"),
      JSON.stringify({ versions: process.versions, phases }, null, 2) + "\n",
    );
    assert(active.rafDelta > 0, "The attached agent did not make the hidden page render.");
    if (process.env.OPENSTEER_IDLE_CPU_BASELINE !== "1") {
      assert.equal(released.rafDelta, 0, "The released hidden tab is still animating.");
      const cpu = released.cpu.find((metric) => metric.pid === released.rendererPid);
      assert(
        cpu && cpu.percentOneCore !== null && cpu.percentOneCore < 5,
        "The released tab is not idle.",
      );
    }
    if (process.env.OPENSTEER_IDLE_CPU_BASELINE !== "1")
      await idleLifecyclePhase(platform, directory);
  } finally {
    await browser.close();
  }
}
