import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { sql } from "kysely";
import { test } from "vitest";
import type { Page } from "playwright-core";
import { startPrivateMachineHost } from "../../apps/host/src/runtime/private-machine-host.test-support.js";
import { cloneTestDatabase } from "../../packages/database/src/test-database.test-support.js";
import type { SwitchTarget } from "./browser-probe.js";
import { createSwitchFixture, researchReports } from "./fixture.js";
import { buildSwitchWeb, fixtureWebVersion, openSwitchBrowser, trackTransport } from "./web.js";

const settleMs = 250;

function settle(page: Page) {
  // oxlint-disable-next-line opensteer/no-real-time-wait-in-tests -- the fixed observation window measures follow-up RPCs and updates
  return page.evaluate((ms) => new Promise<void>((done) => setTimeout(done, ms)), settleMs);
}
const warmSwitches = 10;
const inactiveRepetitions = 3;
const researchSwitches = 5;
const viewport = { width: 1440, height: 1000 };

const taskLink = (page: Page, threadId: string) =>
  page.locator(`.side-task[data-thread-id="${threadId}"] .side-task__main`);

async function ready(page: Page, threadId: string, messageId: string) {
  await page.waitForFunction(
    ({ thread, message }) =>
      window.taskSwitchProbe?.live(thread, message) &&
      document
        .querySelector(`[role="log"] [data-message-id="${CSS.escape(message)}"]`)
        ?.textContent?.trim(),
    { thread: threadId, message: messageId },
    { timeout: 10_000 },
  );
}

async function select(
  page: Page,
  transport: ReturnType<typeof trackTransport>,
  target: SwitchTarget,
) {
  await page.evaluate((input) => window.taskSwitchProbe.arm(input), target);
  transport.reset();
  await taskLink(page, target.threadId).click();
  try {
    await page.waitForFunction(
      () => {
        const value = window.taskSwitchProbe.read();
        return value?.firstPaintMs != null && value.synchronizedMs != null;
      },
      null,
      { timeout: 8_000 },
    );
  } catch (error) {
    const observed = await page.evaluate(() => window.taskSwitchProbe.read());
    const wire =
      observed?.clickAt == null
        ? null
        : await transport.read(observed.clickAt, Number.POSITIVE_INFINITY, target.threadId);
    throw new Error(
      `Selection did not paint and synchronize: ${JSON.stringify({ observed, wire })}`,
      {
        cause: error,
      },
    );
  }
  await settle(page);
  const { clickAt, endAt, ...browser } = await page.evaluate(() => window.taskSwitchProbe.finish());
  if (clickAt === null) throw new Error("The sidebar click was not measured.");
  return {
    ...browser,
    observedMs: endAt - clickAt,
    ...(await transport.read(clickAt, endAt, target.threadId)),
  };
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (p: number) =>
    sorted.length === 0 ? null : Number(sorted[Math.ceil(p * sorted.length) - 1]!.toFixed(1));
  return { count: values.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

const recordedSwitch = (
  target: "A" | "B",
  activityCommits: number,
  toolCalls: number,
  sample: Awaited<ReturnType<typeof select>>,
) => ({ target, activityCommits, toolCalls, ...sample });
type Sample = ReturnType<typeof recordedSwitch>;

function summarize(samples: readonly Sample[]) {
  const sum = (read: (sample: Sample) => number) => distribution(samples.map(read));
  return {
    firstPaintMs: sum((sample) => sample.firstPaintMs!),
    latestPaintMs: distribution(
      samples.flatMap(({ latestPaintMs }) => (latestPaintMs === null ? [] : [latestPaintMs])),
    ),
    synchronizedMs: sum((sample) => sample.synchronizedMs!),
    transcriptNotificationsThroughSync: sum((sample) => sample.transcriptNotificationsThroughSync),
    transcriptNotifications: sum((sample) => sample.transcriptNotifications),
    hostNotifications: sum((sample) => sample.hostNotifications),
    reactMarkdownParses: samples.every((sample) => sample.reactMarkdownParses !== null)
      ? sum((sample) => sample.reactMarkdownParses!)
      : null,
    detailChangeFramesThroughFirstSync: distribution(
      samples.flatMap(({ detailChangesThroughFirstSync }) =>
        detailChangesThroughFirstSync === null ? [] : [detailChangesThroughFirstSync],
      ),
    ),
    detailChangeFrames: sum(
      (sample) => sample.websocket["received selected host.changes"]?.count ?? 0,
    ),
    detailSnapshotFrames: sum(
      (sample) => sample.websocket["received selected host.snapshot"]?.count ?? 0,
    ),
    detailPayloadBytes: sum((sample) =>
      Object.entries(sample.websocket).reduce(
        (total, [key, frame]) =>
          key.startsWith("received selected ") ? total + frame.payloadBytes : total,
        0,
      ),
    ),
    longTasks: sum((sample) => sample.longTasks.length),
    longTaskMs: sum((sample) =>
      sample.longTasks.reduce((total, task) => total + task.durationMs, 0),
    ),
    rpcRequests: sum((sample) =>
      Object.values(sample.rpc).reduce((total, rpc) => total + rpc.requests, 0),
    ),
    rpcResponseBodyBytes: sum((sample) =>
      Object.values(sample.rpc).reduce((total, rpc) => total + rpc.responseBodyBytes, 0),
    ),
  };
}

test("switches between tasks on a Personal Host", async () => {
  const started = performance.now();
  const loadAverageBefore = loadavg();
  const directory = await mkdtemp(join(tmpdir(), "opensteer-task-switch-"));
  let database: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
  let host: Awaited<ReturnType<typeof startPrivateMachineHost>> | undefined;
  let browser: Awaited<ReturnType<typeof openSwitchBrowser>> | undefined;
  try {
    const assets = join(directory, "web");
    await buildSwitchWeb(assets);
    database = await cloneTestDatabase("host");
    host = await startPrivateMachineHost(database.url, {
      logger: false,
      webDistribution: {
        directory: assets,
        expectedHostVersion: fixtureWebVersion,
        manifestPath: join(assets, "opensteer-web.json"),
      },
    });
    const fixture = await createSwitchFixture(host);
    const { a, b } = fixture;
    let currentB = b.messageId;
    let lastReportIds: readonly string[] = [];
    browser = await openSwitchBrowser();
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    const origin = host.origin;
    await context.addCookies(
      host.ownerHeaders.cookie!.split("; ").map((pair) => {
        const separator = pair.indexOf("=");
        return {
          name: pair.slice(0, separator),
          value: pair.slice(separator + 1),
          url: origin.origin,
        };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const transport = trackTransport(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const startupNetwork: string[] = [];
    const onResponse = (response: import("playwright-core").Response) => {
      const { pathname } = new URL(response.url());
      if (!pathname.startsWith("/assets/")) startupNetwork.push(`${response.status()} ${pathname}`);
    };
    page.on("response", onResponse);
    page.on("websocket", (socket) =>
      socket.on("socketerror", (error) => startupNetwork.push(error)),
    );
    await page.goto(new URL(`/tasks/${a.threadId}`, origin).href);
    try {
      await ready(page, a.threadId, a.messageId);
    } catch (error) {
      const state = await page.evaluate(() => ({
        connection: window.taskSwitchProbe?.connection(),
        text: document.body.innerText.slice(0, 600),
        messageIds: Array.from(document.querySelectorAll("[data-message-id]"), (row) =>
          row.getAttribute("data-message-id"),
        ),
      }));
      throw new Error(
        `Initial transcript did not open: ${JSON.stringify({ ...state, pageErrors, startupNetwork })}`,
        {
          cause: error,
        },
      );
    }
    page.off("response", onResponse);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await taskLink(page, b.threadId).click();
    await ready(page, b.threadId, b.messageId);
    // Let initial app reads and font work settle before starting the warm samples.
    await settle(page);

    const warm: Sample[] = [];
    for (let index = 0; index < warmSwitches; index++) {
      const target = index % 2 === 0 ? a : b;
      warm.push(
        recordedSwitch(
          target === a ? "A" : "B",
          0,
          0,
          await select(page, transport, {
            threadId: target.threadId,
            title: target.title,
            latestMessageId: target.messageId,
          }),
        ),
      );
    }

    const openA = async (prepareLatest = false) => {
      // Clear a retained historical anchor before measuring a newest-window snapshot.
      if (prepareLatest) {
        const opened = await page.evaluate(
          (id) => window.taskSwitchProbe.openLatestWindow(id),
          b.threadId,
        );
        if (!opened) throw new Error("Could not prepare the latest transcript window.");
      }
      // The optional control can disappear during layout when the tail is already visible.
      await page.evaluate(() =>
        document.querySelector<HTMLButtonElement>(".transcript__jump")?.click(),
      );
      await taskLink(page, a.threadId).click();
      await ready(page, a.threadId, a.messageId);
      await settle(page);
    };
    const inactive = async (commits: 100 | 1000, withReports = false) => {
      const samples: Sample[] = [];
      for (let index = 1; index <= inactiveRepetitions; index++) {
        await openA(commits === 1000);
        const label = `${commits}-${index}`;
        const reportBodies = withReports ? researchReports(label) : [];
        const { toolCalls, messageId, reportIds } = await fixture.accrue(
          commits,
          reportBodies,
          label,
        );
        currentB = messageId;
        lastReportIds = reportIds;
        samples.push(
          recordedSwitch(
            "B",
            commits,
            toolCalls,
            await select(page, transport, {
              threadId: b.threadId,
              title: b.title,
              latestMessageId: currentB,
            }),
          ),
        );
      }
      return samples;
    };
    const replay = await inactive(100);
    const snapshot = await inactive(1000);
    const researchSnapshot = await inactive(1000, true);
    const researchWindow = await page.evaluate(
      ({ threadId, reportIds }) => window.taskSwitchProbe.describeWindow(threadId, reportIds),
      { threadId: b.threadId, reportIds: lastReportIds },
    );
    if (!researchWindow.hasReports || researchWindow.toolEntries === 0)
      throw new Error(
        `The research window is missing seeded content: ${JSON.stringify(researchWindow)}`,
      );
    const research: Sample[] = [];
    for (let index = 0; index < researchSwitches; index++) {
      await openA();
      research.push(
        recordedSwitch(
          "B",
          0,
          0,
          await select(page, transport, {
            threadId: b.threadId,
            title: b.title,
            latestMessageId: currentB,
          }),
        ),
      );
    }
    if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join("; ")}`);

    const version = await sql<{
      version: string;
    }>`select current_setting('server_version') as version`.execute(host.store.database);
    const scenarios = {
      warm,
      inactive100: replay,
      inactive1000: snapshot,
      inactive1000WithReports: researchSnapshot,
      warmWithReports: research,
    };
    const results = {
      version: 1,
      referenceOnly: true,
      productSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      capturedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      machine: {
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
        platform: platform(),
        release: release(),
        arch: arch(),
        node: process.version,
        chromium: browser.version(),
        postgres: version.rows[0]?.version,
        loadAverageBefore,
        loadAverageAfter: loadavg(),
      },
      settings: {
        viewport,
        settleMs,
        reportBytes: researchReports("1000-1").map((report) => Buffer.byteLength(report)),
        researchWindow,
      },
      scenarios: Object.fromEntries(
        Object.entries(scenarios).map(([name, samples]) => [
          name,
          { summary: summarize(samples), samples },
        ]),
      ),
    };
    const output = resolve(process.env.OPENSTEER_TASK_SWITCH_RESULTS ?? "task-switch-results.json");
    await writeFile(output, JSON.stringify(results, null, 2) + "\n");
    process.stdout.write(`Task-switch results written to ${output}\n`);
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await host?.close();
      } finally {
        try {
          await database?.drop();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
});
