import { callMcpTool } from "../../host/src/mcp/call-tool.test-support.js";
import { createId } from "@opensteer/core";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { startPersonalRuntime } from "../../host/src/runtime/personal-startup.test-support.js";
/**
 * Chrome sign-ins v2, end to end, on real parts only: the built extension in a
 * disposable Chromium profile ("the user's everyday Chrome"), the in-process
 * Host on a disposable PostgreSQL database serving the built web app, the
 * Browser Runtime as its own process offered by the hosting Runner, and agents
 * calling the Host's MCP tools with the capability token dispatched to their Run.
 * The hosting Runner drives
 * a fixture engine through its real CLI protocol.
 *
 * Ways this journey can fail, each asserted below:
 *  1. The web page cannot find the extension, or the handoff to its connect tab
 *     loses the one-use link, or connecting never shows up in the Host.
 *  2. A sign-in reaches the Host but not the live browser: the destination
 *     server still sees the signed-out session after a reload.
 *  3. Stale site cookies survive the import (the anonymous pre-import cookie,
 *     or a cookie Chrome does not have), or in-scope cookies are dropped
 *     (parent-domain and sibling-subdomain host-only cookies).
 *  4. Owner sign-in does not remember the site for the Personal owner.
 *  5. An agent without a grant signs in with no Request; allowing does not
 *     fulfil it, sign the session in, or queue the agent's continuation.
 *  6. A standing grant still asks; a delegated Thread can ask for new authority.
 *  7. An allowed Request whose Chrome is offline fails instead of waiting, or
 *     does not complete by itself when that Chrome comes back.
 *  8. Stop sharing in Chrome is ignored; a first share does not notify.
 *  9. Revoking in Opensteer leaves the extension thinking it is connected, or
 *     a revoked Chrome still signs in; Disconnect in Chrome leaves the source.
 * 10. A cookie value reaches Host logs, Runtime logs, the database (Request
 *     rows and events included) or an agent's tool result; a viewer's
 *     `state.import` reaches the browser.
 *
 * The artifact directory (OPENSTEER_BROWSER_SOURCE_E2E_ARTIFACT_DIR) receives
 * `result.json` with each step's outcome and timing, and screenshots.
 */
import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  BrowserServerMessageSchema,
  decodeBrowserFrameEnvelope,
  hostApiVersionHeader,
  personalWebBuildId,
  type BrowserViewerSurface,
  type HostToRunnerMessage,
  HostToRunnerMessageSchema,
} from "@opensteer/protocol";
import {
  AgentBrowserSignInResultSchema,
  opensteerChromeExtensionId,
} from "@opensteer/protocol/browser-sources";
import { sql } from "kysely";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
  type ServerOptions,
} from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createDatabase } from "../../../packages/database/src/index.js";
import { writeWebDistributionManifest } from "../../../scripts/write-web-distribution-manifest.mjs";
import { testRpcData } from "../../host/src/server/test-host-api-request.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const journey = databaseUrl ? describe : describe.skip;
const artifactDirectory =
  process.env.OPENSTEER_BROWSER_SOURCE_E2E_ARTIFACT_DIR ??
  join(tmpdir(), "opensteer-browser-source-e2e");
const hostReleaseVersion = "0.0.0-chrome-sign-ins-e2e";
const hostedChromeArgs = [
  "--ignore-certificate-errors",
  "--host-resolver-rules=MAP *.test 127.0.0.1",
];

/** Every value that would let someone act as the user; none may leave the two browsers. */
const secrets = {
  alpha: secretFor("alpha"),
  alphaApp: secretFor("alpha-app"),
  alphaParent: secretFor("alpha-parent"),
  beta: secretFor("beta"),
  betaApp: secretFor("beta-app"),
  betaParent: secretFor("beta-parent"),
  gamma: secretFor("gamma"),
  gammaApp: secretFor("gamma-app"),
  gammaParent: secretFor("gamma-parent"),
} as const;
const siteSecrets = {
  alpha: { app: secrets.alphaApp, main: secrets.alpha, parent: secrets.alphaParent },
  beta: { app: secrets.betaApp, main: secrets.beta, parent: secrets.betaParent },
  gamma: { app: secrets.gammaApp, main: secrets.gamma, parent: secrets.gammaParent },
} as const;
type SiteName = keyof typeof siteSecrets;

interface StepRecord {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly error?: string;
}

journey.sequential("Chrome sign-ins v2: everyday Chrome to a live hosted Browser Session", () => {
  const steps: StepRecord[] = [];
  const screenshots: string[] = [];
  const hostLogs: string[] = [];
  const runtimeLogs: string[] = [];
  const agentResults: unknown[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  let scratch = "";
  let completed = false;

  const restoreConsole = captureConsole(hostLogs);

  beforeAll(async () => {
    if (!databaseUrl) return;
    await rm(artifactDirectory, { force: true, recursive: true });
    await mkdir(artifactDirectory, { recursive: true });
    scratch = await mkdtemp(join(tmpdir(), "opensteer-chrome-sign-ins-e2e-"));
    execFileSync("pnpm", ["--filter", "@opensteer/browser-extension", "build"], {
      cwd: repositoryRoot,
      stdio: "pipe",
      timeout: 120_000,
    });
    execFileSync(
      "pnpm",
      [
        "--filter",
        "@opensteer/web",
        "exec",
        "vite",
        "build",
        "--outDir",
        join(scratch, "web"),
        "--emptyOutDir",
      ],
      { cwd: repositoryRoot, stdio: "pipe", timeout: 240_000 },
    );
    await writeWebDistributionManifest({
      buildId: personalWebBuildId,
      directory: join(scratch, "web"),
      hostVersion: hostReleaseVersion,
    });
  }, 360_000);

  afterEach(async () => {
    restoreConsole();
    const cleanupErrors: unknown[] = [];
    for (const cleanup of cleanups.reverse())
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    if (scratch) await rm(scratch, { force: true, recursive: true });
    await mkdir(artifactDirectory, { recursive: true });
    if (!completed) {
      // Redacted, so a failed run can be diagnosed from its artifact alone.
      await writeFile(join(artifactDirectory, "host.log"), redact(hostLogs.join("\n")));
      await writeFile(join(artifactDirectory, "browser-runtime.log"), redact(runtimeLogs.join("")));
    }
    await writeFile(
      join(artifactDirectory, "result.json"),
      `${JSON.stringify(
        {
          scenario: "chrome-sign-ins-v2-everyday-chrome-to-hosted-browser-session",
          completed,
          passed: steps.filter((step) => step.status === "passed").length,
          failed: steps.filter((step) => step.status === "failed").length,
          steps,
          screenshots: screenshots.map((path) => path.slice(artifactDirectory.length + 1)),
          parts: {
            everydayChrome: "Playwright Chromium, persistent disposable profile, built extension",
            host: "in-process createHostRuntime, disposable PostgreSQL, built web app served",
            browserRuntime:
              "apps/browser-runtime/src/main.ts through the hosting Runner’s local bridge",
            agent:
              "hosting Runner with a fixture CLI; tools called through the Host’s MCP endpoint",
          },
          sensitiveValues: "redacted",
        },
        null,
        2,
      )}\n`,
    );
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, "Browser source journey cleanup failed");
  }, 120_000);

  async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const value = await run();
      steps.push({
        durationMs: Date.now() - started,
        name,
        startedAt: new Date(started).toISOString(),
        status: "passed",
      });
      return value;
    } catch (error) {
      steps.push({
        durationMs: Date.now() - started,
        error: redact(error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        name,
        startedAt: new Date(started).toISOString(),
        status: "failed",
      });
      throw error;
    }
  }

  async function shoot(page: Page, name: string, selector?: string): Promise<void> {
    const path = join(artifactDirectory, `${name}.png`);
    // The artifact must show the page as a person sees it, brand mark included.
    await page.waitForFunction(() =>
      Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0),
    );
    if (selector) await page.locator(selector).screenshot({ animations: "disabled", path });
    else await page.screenshot({ animations: "disabled", fullPage: true, path });
    screenshots.push(path);
  }

  it("connects Chrome once and signs live Browser Sessions in for the owner and agents", async () => {
    if (!databaseUrl) return;

    // ---- Infrastructure: database, synthetic sites, Host, hosted runtime ----
    const database = await cloneTestDatabase("host", { serverUrl: databaseUrl });
    const hostDatabaseUrl = database.url;
    cleanups.push(() => database.drop());
    const site = await startSyntheticSites(scratch);
    cleanups.push(() => closeServer(site.server));
    const url = (host: string, path: string) => `https://${host}:${site.port}${path}`;

    const runCommands: RunExecute[] = [];
    const hostedRuntime = await startHostedBrowserRuntime({
      directory: join(scratch, "browser-runtime"),
      logs: runtimeLogs,
    });
    cleanups.push(() => stopProcess(hostedRuntime.child));
    const personal = await startPersonalRuntime({
      databaseUrl: hostDatabaseUrl,
      browser: hostedRuntime.bridge,
      agentHome: { computerId: createId("runner"), path: join(scratch, "home") },
      engineArguments: ["--scenario=interrupt"],
      maxConcurrentRuns: 4,
      hostLog: (line) => hostLogs.push(line),
      webDistribution: {
        directory: join(scratch, "web"),
        expectedHostVersion: hostReleaseVersion,
        manifestPath: join(scratch, "web", "opensteer-web.json"),
      },
      runnerWire: {
        filter(direction, frame) {
          const parsed = HostToRunnerMessageSchema.safeParse(frame);
          if (
            direction === "host" &&
            parsed.success &&
            parsed.data.type === "host.command" &&
            parsed.data.command.type === "run.execute"
          )
            runCommands.push({ ...parsed.data, command: parsed.data.command });
          return true;
        },
      },
    });
    cleanups.push(() => personal.close());
    const runtime = personal.host;
    const hostOrigin = personal.hostOrigin.origin;
    const owner = {
      cookie: personal.sessionCookie,
      cookies: personal.sessionCookie.split(";").map((pair) => {
        const separator = pair.indexOf("=");
        return { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1) };
      }),
    };
    const headers = {
      cookie: owner.cookie,
      origin: hostOrigin,
      [hostApiVersionHeader]: String(hostApiVersion),
    };
    const rpc = {
      command: async <Input extends { readonly type: string }>(input: Input) =>
        testRpcData(
          hostOrigin,
          "commands.dispatch",
          { idempotencyKey: randomUUID(), ...input } as never,
          { headers },
        ) as Promise<Record<string, unknown> & { readonly type: string }>,
      sources: () => testRpcData(hostOrigin, "browser.sources.get", {}, { headers }),
    };

    await step("the hosting computer offers its Browser Runtime", async () => {
      await waitFor(
        "the hosted runtime to be a Browser placement",
        async () => {
          const { browser } = await testRpcData(hostOrigin, "bootstrap.get", {}, { headers });
          return (
            browser.available &&
            browser.placements.some(
              (placement) =>
                placement.available && placement.runnerId === personal.agentHome.computerId,
            )
          );
        },
        60_000,
      );
    });

    // ---- 1. The everyday Chrome signs in to the synthetic sites ----
    const profileDirectory = join(scratch, "everyday-chrome");
    const extensionDirectory = join(scratch, "extension");
    await cp(join(repositoryRoot, "apps/browser-extension/dist"), extensionDirectory, {
      recursive: true,
    });
    let everyday = await launchEverydayChrome(profileDirectory, extensionDirectory);
    cleanups.push(() => everyday.context.close());
    const extensionUrl = (file: string) =>
      `chrome-extension://${opensteerChromeExtensionId}/${file}`;

    await step("everyday Chrome signs in to three synthetic sites", async () => {
      expect(new URL(everyday.worker.url()).host).toBe(opensteerChromeExtensionId);
      const page = await everyday.context.newPage();
      for (const name of ["alpha", "beta", "gamma"] as const) {
        await page.goto(url(`www.${name}.test`, "/login"));
        await page.getByText("Signed in", { exact: true }).waitFor();
        await page.goto(url(`app.${name}.test`, "/login"));
        await page.getByText("Signed in", { exact: true }).waitFor();
        await page.goto(url(`www.${name}.test`, "/account"));
        await page.getByText(`Signed in to ${name}.test`).waitFor();
      }
      await shoot(page, "01-everyday-chrome-signed-in");
      await page.close();
    });

    // ---- 2. Connect through the real web page and extension connect tab ----
    /** Connect Chrome the way a person does: the Host's page, then the extension's tab. */
    const connectThroughWeb = async (shots: { readonly page: string; readonly tab: string }) => {
      const pair = await rpc.command({ type: "browser.source.pair" });
      const pairing = pair.pairing as { invitation: string; destinations: { origin: string }[] };
      expect(pairing.destinations.map((destination) => destination.origin)).toEqual([hostOrigin]);
      const page = await everyday.context.newPage();
      await page.goto(`${hostOrigin}/connect/chrome#${pairing.invitation}`);
      await page
        .getByRole("heading", { name: /^Connect Chrome/ })
        .first()
        .waitFor();
      // The page takes the one-use code out of the address before rendering.
      expect(new URL(page.url()).hash).toBe("");
      const connect = page.getByRole("button", { name: "Connect Chrome" });
      await connect.waitFor({ timeout: 15_000 });
      await shoot(page, shots.page);
      const [connectTab] = await Promise.all([
        everyday.context.waitForEvent("page", { timeout: 15_000 }),
        connect.click(),
      ]);
      const confirm = connectTab.getByRole("button", { name: "Connect", exact: true });
      try {
        await connectTab.getByRole("heading", { name: /^Connect Chrome to / }).waitFor();
        await confirm.waitFor({ timeout: 15_000 });
      } catch (error) {
        await shoot(connectTab, `failed-${shots.tab}`).catch(() => undefined);
        const text = await connectTab
          .locator("body")
          .innerText()
          .catch(() => "");
        throw new Error(`${String(error)}\nConnect tab said: ${text.slice(0, 500)}`);
      }
      expect(connectTab.url().startsWith(extensionUrl("connect.html"))).toBe(true);
      expect(new URL(connectTab.url()).hash).toBe("");
      await connectTab.locator("#name").fill("Everyday Chrome");
      await shoot(connectTab, shots.tab);
      const closed = connectTab.waitForEvent("close", { timeout: 20_000 });
      await confirm.click();
      await closed;
      await page.close();
    };

    const connected = await step(
      "Connect Chrome from /connect/chrome through the extension",
      async () => {
        await connectThroughWeb({ page: "02-web-connect-chrome", tab: "03-extension-connect-tab" });
        const source = await waitForValue("the Host to list the connected Chrome", async () => {
          const state = await rpc.sources();
          return state.sources.find((candidate) => candidate.connected);
        });
        expect(source.name).toBe("Everyday Chrome");
        return source;
      },
    );
    const sourceId = connected.id;

    // ---- 3. Owner signs a live hosted Browser Session in ----
    const startSession = async () => {
      const started = await rpc.command({
        input: { fresh: true, reuseExisting: false },
        type: "browser.session.start",
      });
      return (started as unknown as { session: { id: string } }).session.id;
    };
    const sessionOne = await startSession();
    const viewerOne = await Viewer.open(hostOrigin, sessionOne, headers);
    cleanups.push(async () => viewerOne.close());

    /** Navigates the live session and returns what the synthetic server saw. */
    const visit = async (viewer: Viewer, host: string, path = "/account") => {
      // Consecutive visits can share a millisecond; timestamps cannot identify their requests.
      const requestIndex = site.requests.length;
      await viewer.navigate(url(host, path));
      return waitForValue(`the hosted browser to request ${host}${path}`, async () =>
        site.requests
          .slice(requestIndex)
          .find((request) => request.host === host && request.path === path),
      );
    };
    const signedIn = (request: SiteRequest, name: SiteName) =>
      request.cookies.get("__Host-e2e") === siteSecrets[name].main &&
      request.cookies.get("e2e-parent") === siteSecrets[name].parent;
    const hasAnonymous = (request: SiteRequest) =>
      [...request.cookies.values()].some((value) => value.startsWith("anon-"));

    await step("owner: live session is signed out of alpha.test before sign-in", async () => {
      const first = await visit(viewerOne, "www.alpha.test");
      expect(first.cookies.size).toBe(0);
      const second = await visit(viewerOne, "www.alpha.test");
      expect(second).not.toBe(first);
      expect(hasAnonymous(second)).toBe(true);
      expect(second.cookies.get("e2e-anon-only")).toMatch(/^anon-/u);
      expect(signedIn(second, "alpha")).toBe(false);
    });

    await step(
      "owner: browser.session.sign-in applies Chrome's alpha.test sign-in live",
      async () => {
        const result = await rpc.command({
          sessionId: sessionOne,
          sourceId: null,
          type: "browser.session.sign-in",
          url: url("www.alpha.test", "/account"),
        });
        expect(result.outcome).toEqual({
          profileName: null,
          site: "https://alpha.test",
          sourceName: "Everyday Chrome",
          status: "applied",
        });
        const reloaded = await visit(viewerOne, "www.alpha.test");
        expect(signedIn(reloaded, "alpha")).toBe(true);
        expect(hasAnonymous(reloaded)).toBe(false);
        expect(reloaded.cookies.has("e2e-anon-only")).toBe(false);
        const sibling = await visit(viewerOne, "app.alpha.test");
        expect(sibling.cookies.get("e2e-app")).toBe(secrets.alphaApp);
        expect(sibling.cookies.get("e2e-parent")).toBe(secrets.alphaParent);
        expect(hasAnonymous(sibling)).toBe(false);
        const shown = await visit(viewerOne, "www.alpha.test");
        await viewerOne.screenshot(
          shown.at,
          join(artifactDirectory, "04-hosted-session-signed-in"),
          screenshots,
        );
      },
    );

    await step("owner: the site is remembered for the Personal owner", async () => {
      const state = await rpc.sources();
      expect(state.sites).toContainEqual(
        expect.objectContaining({
          preferredSourceId: sourceId,
          site: "https://alpha.test",
        }),
      );
    });

    await step("extension: the first share of a site notified once", async () => {
      const notifications = await everyday.worker.evaluate(async () =>
        // The extension's own Chrome typings declare only what it calls.
        Object.keys(
          await (
            chrome.notifications as unknown as { getAll(): Promise<Record<string, boolean>> }
          ).getAll(),
        ),
      );
      expect(notifications).toEqual([`share\n${sourceId}\nhttps://alpha.test`]);
      const stored = await extensionConnections(everyday.worker);
      expect(Object.keys(stored[0]?.sharedSites ?? {})).toEqual(["https://alpha.test"]);
    });

    // ---- 4. Agents: Request, standing grant, delegated capability ----
    const thread = await rpc.command({
      environmentId: personal.environmentId,
      harnessInstanceId: personal.harnessInstanceId,
      modelSelection: { modelId: "gpt-5.6-sol", options: { effort: "low" }, providerId: "openai" },
      title: "Research with sign-ins",
      type: "thread.create",
    });
    const threadId = (thread as unknown as { thread: { id: string } }).thread.id;
    await rpc.command({
      content: [{ text: "Read the account pages.", type: "text" }],
      threadId,
      type: "thread.sendMessage",
    });
    const parentMessage = await waitForValue("the Personal Runner to accept its Run", async () => {
      const message = runCommands.find((row) => row.command.context.threadId === threadId);
      if (!message) return;
      const run = await runtime.store.database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", message.command.context.runId)
        .executeTakeFirst();
      return run?.status === "running" ? message : undefined;
    });
    const parentRun = { token: parentMessage.command.context.agentTools.token };
    const signIn = async (sessionId: string, target: string) => {
      const response = await callMcpTool(hostOrigin, parentRun.token, "sign_in", {
        reason: "The account page shows the user signed out.",
        sessionId,
        site: target,
      });
      if (response.isError) throw new Error(`sign_in failed: ${JSON.stringify(response.content)}`);
      const result = AgentBrowserSignInResultSchema.parse(response.structuredContent);
      agentResults.push(result);
      return result;
    };
    const signInRequests = () =>
      runtime.store.database
        .selectFrom("requests")
        .selectAll()
        .where("kind", "=", "browser.sign-in")
        .execute();

    const heldSignIn = signIn(sessionOne, url("www.beta.test", "/account"));
    void heldSignIn.catch(() => undefined);
    const pendingRequestId = await step(
      "agent: a site without a grant opens one sign-in Request",
      async () => {
        const request = await vi.waitFor(
          async () => {
            const rows = await signInRequests();
            expect(rows, "sign_in did not open its Request").toHaveLength(1);
            return runtime.store.requests.get(rows[0]!.id);
          },
          { timeout: 10_000 },
        );
        expect(request).toMatchObject({
          kind: "browser.sign-in",
          payload: { kind: "browser.sign-in", sessionId: sessionOne, site: "https://beta.test" },
          status: "pending",
          originatingThreadId: threadId,
          originatingRunId: parentMessage.command.context.runId,
        });
        return request!.id;
      },
    );

    await step("owner: Allow fulfils the Request, signs in and answers the held call", async () => {
      const response = await rpc.command({
        decision: { decision: "allow", sourceId },
        requestId: pendingRequestId,
        type: "browser.sign-in.respond",
      });
      expect(response.outcome).toMatchObject({ site: "https://beta.test", status: "applied" });
      expect(await runtime.store.requests.get(pendingRequestId)).toMatchObject({
        status: "fulfilled",
      });
      expect(await heldSignIn).toEqual({ status: "resolved", requestId: pendingRequestId });
      const reloaded = await visit(viewerOne, "www.beta.test");
      expect(signedIn(reloaded, "beta")).toBe(true);
      await waitFor("the held call to own delivery of the answer", async () => {
        const continuation = await runtime.store.database
          .selectFrom("requestContinuations")
          .select("status")
          .where("requestId", "=", pendingRequestId)
          .executeTakeFirst();
        return continuation?.status === "delivered";
      });
      expect((await rpc.sources()).sites).toContainEqual(
        expect.objectContaining({
          preferredSourceId: sourceId,
          site: "https://beta.test",
        }),
      );
    });

    const sessionTwo = await startSession();
    const viewerTwo = await Viewer.open(hostOrigin, sessionTwo, headers);
    cleanups.push(async () => viewerTwo.close());

    await step("agent: a standing grant signs a new session in with no Request", async () => {
      const before = (await signInRequests()).length;
      const result = await signIn(sessionTwo, "beta.test");
      expect(result).toEqual({
        profileName: null,
        site: "https://beta.test",
        sourceName: "Everyday Chrome",
        status: "applied",
      });
      expect((await signInRequests()).length).toBe(before);
      expect(signedIn(await visit(viewerTwo, "www.beta.test"), "beta")).toBe(true);
    });

    // ---- 5. Offline Chrome: the Request waits and drains by itself ----
    let heldOfflineSignIn: ReturnType<typeof signIn>;
    const drainedRequestId = await step(
      "agent: preferred Chrome offline leaves the Request pending",
      async () => {
        await everyday.context.close();
        await waitFor("the Host to see Chrome offline", async () =>
          (await rpc.sources()).sources.every((source) => !source.connected),
        );
        const before = await signInRequests();
        heldOfflineSignIn = signIn(sessionTwo, "https://www.alpha.test/");
        void heldOfflineSignIn.catch(() => undefined);
        const request = await vi.waitFor(
          async () => {
            const rows = (await signInRequests()).filter(
              (row) => !before.some(({ id }) => id === row.id),
            );
            expect(rows, "offline sign_in did not open its Request").toHaveLength(1);
            return rows[0]!;
          },
          { timeout: 10_000 },
        );
        expect(request).toMatchObject({ status: "pending" });
        return request.id;
      },
    );

    await step("reopening the same Chrome completes the Request by itself", async () => {
      everyday = await launchEverydayChrome(profileDirectory, extensionDirectory);
      await waitFor(
        "the Request to be fulfilled after Chrome reconnects",
        async () => (await runtime.store.requests.get(drainedRequestId))?.status === "fulfilled",
        30_000,
      ).catch(async (error: unknown) => {
        const inspection = await testRpcData(
          hostOrigin,
          "browser.sources.inspect",
          { url: "https://alpha.test" },
          { headers },
        ).catch((reason: unknown) => String(reason));
        const request = await runtime.store.requests.get(drainedRequestId);
        throw new Error(
          `${String(error)} sources=${JSON.stringify((await rpc.sources()).sources)} inspect=${JSON.stringify(inspection)} request=${request?.status} extension=${JSON.stringify((await extensionConnections(everyday.worker)).map((connection) => ({ ended: connection.ended, sourceId: connection.sourceId })))}`,
        );
      });
      expect(await heldOfflineSignIn!).toEqual({ status: "resolved", requestId: drainedRequestId });
      expect((await rpc.sources()).sources).toEqual([
        expect.objectContaining({ connected: true, id: sourceId }),
      ]);
      expect(signedIn(await visit(viewerTwo, "www.alpha.test"), "alpha")).toBe(true);
    });

    // ---- 6. Extension-side controls ----
    const popup = await everyday.context.newPage();
    await popup.setViewportSize({ height: 640, width: 360 });
    const openPopup = async () => {
      await popup.goto(extensionUrl("popup.html"));
      await popup.locator("#popup[aria-busy='false']").waitFor();
    };

    await step("extension: Stop sharing in the popup refuses the next sign-in", async () => {
      await openPopup();
      await popup.getByRole("button", { name: "Stop sharing alpha.test" }).waitFor();
      await shoot(popup, "05-popup-shared-sites", "body");
      await popup.getByRole("button", { name: "Stop sharing alpha.test" }).click();
      await popup.getByRole("button", { name: "Share alpha.test again" }).waitFor();
      await shoot(popup, "06-popup-stopped", "body");
      expect((await extensionConnections(everyday.worker))[0]?.stoppedSites).toEqual([
        "https://alpha.test",
      ]);
      const result = await rpc.command({
        sessionId: sessionOne,
        sourceId: null,
        type: "browser.session.sign-in",
        url: "https://alpha.test",
      });
      expect(result.outcome).toEqual({
        problem: "stopped",
        site: "https://alpha.test",
        sourceName: "Everyday Chrome",
        status: "problem",
      });
    });

    await step("web: Settings → Chrome shows the connected Chrome and allowed sites", async () => {
      await everyday.context.addCookies(
        owner.cookies.map((cookie) => ({
          name: cookie.name,
          url: hostOrigin,
          value: cookie.value,
        })),
      );
      const settings = await everyday.context.newPage();
      await settings.setViewportSize({ height: 900, width: 1_200 });
      await settings.goto(`${hostOrigin}/settings/chrome`);
      await settings.getByText("Everyday Chrome").first().waitFor({ timeout: 20_000 });
      await settings.getByText("alpha.test").first().waitFor();
      await settings.getByText("beta.test").first().waitFor();
      await shoot(settings, "07-web-settings-chrome");
      await settings.close();
    });

    // ---- 7. Revocation and Disconnect ----
    await step("owner revoke: the extension shows Disconnected by Opensteer", async () => {
      await rpc.command({ sourceId, type: "browser.source.revoke" });
      await waitFor(
        "the extension to record the ended connection",
        async () => (await extensionConnections(everyday.worker))[0]?.ended === true,
      );
      await openPopup();
      await popup.getByText("Disconnected by Opensteer").waitFor();
      await shoot(popup, "08-popup-disconnected-by-opensteer", "body");
      const result = await rpc.command({
        sessionId: sessionOne,
        sourceId: null,
        type: "browser.session.sign-in",
        url: "https://beta.test",
      });
      expect(result.outcome).toEqual({
        problem: "no-chrome",
        site: "https://beta.test",
        sourceName: null,
        status: "problem",
      });
    });

    await step("extension Disconnect: the Host drops the reconnected Chrome", async () => {
      await connectThroughWeb({
        page: "09-web-reconnect-chrome",
        tab: "10-extension-reconnect-tab",
      });
      const reconnected = await waitForValue("the reconnected Chrome", async () =>
        (await rpc.sources()).sources.find((source) => source.connected),
      );
      expect(reconnected.id).not.toBe(sourceId);
      await openPopup();
      await popup.getByRole("button", { name: "Disconnect", exact: true }).click();
      await popup.getByRole("group").getByRole("button", { name: "Disconnect" }).click();
      await popup.getByText("In Opensteer, open Settings → Chrome").waitFor();
      await waitFor(
        "the Host to drop the disconnected Chrome",
        async () => (await rpc.sources()).sources.length === 0,
      );
      const row = await runtime.store.database
        .selectFrom("browserSources")
        .select("revokedAt")
        .where("id", "=", reconnected.id)
        .executeTakeFirstOrThrow();
      expect(row.revokedAt).not.toBeNull();
    });

    // ---- 8. Security ----
    await step("a viewer cannot send state.import to the live browser", async () => {
      const forged = `forged-${randomUUID()}`;
      const refused = viewerOne.closed();
      viewerOne.send({
        cookies: [
          {
            domain: "www.alpha.test",
            expires: -1,
            hostOnly: true,
            httpOnly: true,
            name: "__Host-e2e",
            path: "/",
            sameSite: "Lax",
            secure: true,
            value: forged,
          },
        ],
        operationId: randomUUID(),
        site: "https://alpha.test",
        type: "state.import",
      });
      await refused;
      const viewer = await Viewer.open(hostOrigin, sessionOne, headers);
      cleanups.push(async () => viewer.close());
      const after = await visit(viewer, "www.alpha.test");
      expect(after.cookies.get("__Host-e2e")).toBe(secrets.alpha);
    });

    await step("no cookie value reached logs, the database or agent results", async () => {
      const database = createDatabase({ connectionString: hostDatabaseUrl });
      let databaseText = "";
      try {
        const tables = await sql<{ name: string }>`
          select table_name as name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
        `.execute(database);
        expect(tables.rows.length).toBeGreaterThan(10);
        for (const { name } of tables.rows) {
          const rows = await sql<{ row: string }>`
            select row_to_json(t)::text as row from ${sql.id(name)} as t
          `.execute(database);
          databaseText += rows.rows.map((row) => row.row).join("\n");
        }
      } finally {
        await database.destroy();
      }
      expect(databaseText).toContain("browser.sign-in");
      const haystacks = {
        agentResults: JSON.stringify(agentResults),
        database: databaseText,
        hostLogs: hostLogs.join("\n"),
        runtimeLogs: runtimeLogs.join("\n"),
      };
      expect(haystacks.hostLogs.length).toBeGreaterThan(0);
      for (const [place, text] of Object.entries(haystacks)) {
        for (const secret of Object.values(secrets)) {
          if (text.includes(secret)) throw new Error(`A cookie value appeared in ${place}.`);
        }
      }
    });

    completed = true;
  }, 600_000);
});

// ---- Synthetic sites ----

interface SiteRequest {
  readonly at: number;
  readonly host: string;
  readonly path: string;
  readonly cookies: ReadonlyMap<string, string>;
}

/**
 * One HTTPS server answering for `www.` and `app.` under alpha, beta and gamma
 * `.test`. `/login` signs in exactly as a real site would: a `__Host-` session
 * cookie on www, a parent-domain cookie, and a host-only cookie on the sibling
 * `app.` subdomain, persistent like "remember me" so a Chrome restart keeps
 * them. `/account` reports the request's own cookies; a first signed-out visit
 * gets anonymous cookies, including one Chrome never has.
 */
async function startSyntheticSites(directory: string): Promise<{
  readonly port: number;
  readonly requests: SiteRequest[];
  readonly server: HttpsServer;
}> {
  const keyPath = join(directory, "site.key");
  const certPath = join(directory, "site.crt");
  const names = Object.keys(siteSecrets) as SiteName[];
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=alpha.test",
      "-addext",
      `subjectAltName=${names.map((name) => `DNS:${name}.test,DNS:*.${name}.test`).join(",")}`,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "pipe" },
  );
  const requests: SiteRequest[] = [];
  const options: ServerOptions = { cert: await readFile(certPath), key: await readFile(keyPath) };
  const server = createHttpsServer(options, (request, response) => {
    const host = (request.headers.host ?? "").replace(/:\d+$/u, "").toLowerCase();
    const path = (request.url ?? "/").split("?", 1)[0] ?? "/";
    const cookies = parseCookies(request);
    const name = names.find((candidate) => host.endsWith(`${candidate}.test`));
    if (!name || path === "/favicon.ico") {
      response.writeHead(404).end();
      return;
    }
    requests.push({ at: Date.now(), cookies, host, path });
    const secret = siteSecrets[name];
    const page = (title: string, body: string) =>
      `<!doctype html><title>${title}</title><body style="font:24px system-ui;padding:40px"><h1>${body}</h1><p>${host}</p></body>`;
    if (path === "/login") {
      const setCookie = host.startsWith("app.")
        ? [`e2e-app=${secret.app}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`]
        : [
            `__Host-e2e=${secret.main}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
            `e2e-parent=${secret.parent}; Domain=${name}.test; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
          ];
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": setCookie,
      });
      response.end(page("Signed in", "Signed in"));
      return;
    }
    const signedIn = cookies.get("__Host-e2e") === secret.main;
    const anonymous = `anon-${randomUUID()}`;
    response.writeHead(signedIn ? 200 : 401, {
      "content-type": "text/html; charset=utf-8",
      ...(cookies.size === 0 && host.startsWith("www.")
        ? {
            "set-cookie": [
              `__Host-e2e=${anonymous}; Secure; HttpOnly; SameSite=Lax; Path=/`,
              `e2e-parent=${anonymous}; Domain=${name}.test; Secure; SameSite=Lax; Path=/`,
              `e2e-anon-only=${anonymous}; Domain=${name}.test; Secure; SameSite=Lax; Path=/`,
            ],
          }
        : {}),
    });
    response.end(
      signedIn
        ? page("Signed in", `Signed in to ${name}.test as the E2E user`)
        : page("Signed out", `Signed out of ${name}.test`),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic sites did not bind.");
  return { port: address.port, requests, server };
}

function parseCookies(request: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0)
      cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

// ---- Everyday Chrome ----

async function launchEverydayChrome(
  profileDirectory: string,
  extensionDirectory: string,
): Promise<{ readonly context: BrowserContext; readonly worker: Worker }> {
  const context = await chromium.launchPersistentContext(profileDirectory, {
    args: [
      ...hostedChromeArgs,
      // Keep extension workers scheduled on loaded Macs: https://crbug.com/549552319.
      ...(process.platform === "darwin"
        ? ["--enable-features=CDPScreenshotNewSurface,ExtensionServiceWorkerVoter"]
        : []),
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
    // This fixture exercises extension background networking, including Chrome startup.
    ignoreDefaultArgs: ["--disable-background-networking"],
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { height: 760, width: 1_000 },
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
    return { context, worker };
  } catch (error) {
    await context.close();
    throw error;
  }
}

type ExtensionConnection = {
  readonly ended?: true;
  readonly sharedSites: Record<string, unknown>;
  readonly sourceId: string;
  readonly stoppedSites: readonly string[];
};

async function extensionConnections(worker: Worker): Promise<ExtensionConnection[]> {
  const stored = await worker.evaluate(() => chrome.storage.local.get("connections"));
  return (stored.connections ?? []) as ExtensionConnection[];
}

// ---- Hosted Browser Runtime ----

// The hosting Runner offers this loopback bridge; Chromium uses only synthetic sites.
async function startHostedBrowserRuntime(input: {
  readonly directory: string;
  readonly logs: string[];
}): Promise<{
  child: ChildProcess;
  bridge: { bridgeToken: string; runtimeId: string; url: URL };
}> {
  await mkdir(join(input.directory, "profiles"), { recursive: true });
  await mkdir(join(input.directory, "data"), { recursive: true });
  const wrapper = join(input.directory, "chromium");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(chromium.executablePath())} ${hostedChromeArgs
      .map((argument) => `'${argument}'`)
      .join(" ")} "$@"\n`,
  );
  await chmod(wrapper, 0o755);
  const bridgeToken = randomBytes(32).toString("base64url");
  const runtimeId = "hosted-browsers-e2e";
  const child = spawn(
    join(repositoryRoot, "apps/browser-runtime/node_modules/.bin/tsx"),
    ["src/main.ts"],
    {
      cwd: join(repositoryRoot, "apps/browser-runtime"),
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        OPENSTEER_BROWSER_BRIDGE_TOKEN: bridgeToken,
        OPENSTEER_BROWSER_HEADLESS: "true",
        OPENSTEER_BROWSER_PORT: "0",
        OPENSTEER_BROWSER_PROFILE_ROOT: join(input.directory, "profiles"),
        OPENSTEER_BROWSER_RUNTIME_DATA_DIR: join(input.directory, "data"),
        OPENSTEER_BROWSER_RUNTIME_ID: runtimeId,
        OPENSTEER_BROWSER_RUNTIME_NAME: "Hosted browsers",
        OPENSTEER_CHROMIUM_EXECUTABLE: wrapper,
        OPENSTEER_MODE: "development",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => input.logs.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => input.logs.push(chunk.toString("utf8")));
  try {
    await waitFor(
      "the Browser Runtime to start",
      async () => {
        if (child.exitCode !== null) {
          throw new Error(`Browser Runtime exited: ${redact(input.logs.join("")).slice(-2_000)}`);
        }
        return input.logs.join("").includes("browser-runtime.ready");
      },
      60_000,
    );
    const ready = input.logs
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; port: number })
      .find((line) => line.event === "browser-runtime.ready");
    if (!ready) throw new Error("Browser Runtime omitted its bridge address");
    return {
      child,
      bridge: { bridgeToken, runtimeId, url: new URL(`http://127.0.0.1:${ready.port}`) },
    };
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await once(child, "exit").catch(() => undefined);
  clearTimeout(timer);
}

// ---- Viewer: the owner's live view of a Browser Session ----

class Viewer {
  readonly #socket: WebSocket;
  readonly #frames: { at: number; bytes: Uint8Array; encoding: string }[] = [];
  readonly #closed: Promise<void>;
  #surface: BrowserViewerSurface | null = null;

  private constructor(socket: WebSocket, surfaceId: string) {
    this.#socket = socket;
    this.#closed = new Promise((done) => socket.once("close", () => done()));
    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        const message = BrowserServerMessageSchema.parse(JSON.parse(data.toString()));
        if (message.type === "browser.surface" && message.surfaceId === surfaceId)
          this.#surface = message.surface;
        return;
      }
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      try {
        const frame = decodeBrowserFrameEnvelope(new Uint8Array(bytes));
        this.#frames.push({ at: Date.now(), bytes: frame.data, encoding: frame.header.encoding });
        if (this.#frames.length > 4) this.#frames.shift();
        if (frame.header.watchToken)
          this.send({ type: "stream.ack", token: frame.header.watchToken });
      } catch {
        // Only complete frames are kept for screenshots.
      }
    });
  }

  static async open(
    origin: string,
    sessionId: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<Viewer> {
    const socket = new WebSocket(
      `${origin.replace(/^http/u, "ws")}/v1/browser-sessions/${sessionId}/connect`,
      { headers: { ...headers } },
    );
    const snapshot = new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("No browser snapshot arrived.")), 60_000);
      socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === "browser.snapshot") {
          clearTimeout(timer);
          done();
        }
      });
      socket.once("close", (code: number) => {
        clearTimeout(timer);
        fail(new Error(`Browser viewer closed with ${code}`));
      });
    });
    await once(socket, "open");
    await snapshot;
    const { browser } = await testRpcData(origin, "bootstrap.get", {}, { headers });
    const group = browser.groups.rows.find((row) => row.sessionId === sessionId);
    const surfaceId = browser.tabs.find((tabs) => tabs.groupId === group?.id)?.rows[0]?.id;
    if (!surfaceId) throw new Error("The browser has no target surface.");
    const viewer = new Viewer(socket, surfaceId);
    viewer.send({ type: "stream.subscribe", surfaceId });
    await vi.waitFor(() => expect(viewer.#surface).not.toBeNull(), { timeout: 10_000 });
    return viewer;
  }

  send(message: Record<string, unknown>): void {
    this.#socket.send(JSON.stringify(message));
  }

  async navigate(url: string): Promise<void> {
    const previous = this.#surface;
    if (!previous) throw new Error("The viewer has no target surface.");
    this.send({ type: "navigation.go", surfaceId: previous.id, url });
    // A request reaching the server does not prove Chromium accepted its Set-Cookie.
    await vi.waitFor(
      () => {
        const surface = this.#surface;
        expect(surface?.url, `the browser to commit ${url}`).toBe(url);
        expect(surface?.documentId, `a new document for ${url}`).not.toBe(previous.documentId);
        expect(surface?.loading, `the browser to finish loading ${url}`).not.toBe(true);
      },
      { timeout: 20_000 },
    );
  }

  closed(): Promise<void> {
    return this.#closed;
  }

  /** A picture streamed after the observed navigation committed. */
  async screenshot(since: number, basePath: string, screenshots: string[]): Promise<void> {
    const frame = await waitForValue(
      `a streamed frame of the page (${this.#frames.length} frames kept)`,
      async () => this.#frames.findLast((candidate) => candidate.at >= since),
    );
    const path = `${basePath}.${frame.encoding === "jpeg" ? "jpg" : frame.encoding}`;
    await writeFile(path, frame.bytes);
    screenshots.push(path);
  }

  close(): void {
    this.#socket.close();
  }
}

// ---- Agents: a scripted Runner and the Host's MCP tools ----

type RunExecute = Extract<HostToRunnerMessage, { type: "host.command" }> & {
  readonly command: Extract<
    Extract<HostToRunnerMessage, { type: "host.command" }>["command"],
    { type: "run.execute" }
  >;
};

// ---- Utilities ----

function secretFor(label: string): string {
  return `${label}-secret-${randomBytes(18).toString("base64url")}`;
}

function redact(text: string): string {
  let result = text;
  for (const secret of Object.values(secrets)) result = result.replaceAll(secret, "[redacted]");
  return result;
}

/** Keeps the in-process Host's console output for the secret scan, still printing it. */
function captureConsole(sink: string[]): () => void {
  const methods = ["debug", "error", "info", "log", "warn"] as const;
  const originals = methods.map((method) => [method, console[method]] as const);
  for (const [method, original] of originals) {
    console[method] = (...values: unknown[]) => {
      sink.push(
        values
          .map((value) =>
            value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : String(value),
          )
          .join(" "),
      );
      original.apply(
        console,
        values.map((value) => (typeof value === "string" ? redact(value) : value)),
      );
    };
  }
  return () => {
    for (const [method, original] of originals) console[method] = original;
  };
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await predicate(), `Timed out waiting for ${label}.`).toBe(true);
    },
    { timeout: timeoutMs },
  );
}

async function waitForValue<Value>(
  label: string,
  produce: () => Promise<Value | undefined>,
  timeoutMs = 20_000,
): Promise<Value> {
  let value: Value | undefined;
  await waitFor(
    label,
    async () => {
      value = await produce();
      return value !== undefined;
    },
    timeoutMs,
  );
  return value as Value;
}

function closeServer(server: HttpsServer): Promise<void> {
  server.closeAllConnections();
  return new Promise((done) => server.close(() => done()));
}
