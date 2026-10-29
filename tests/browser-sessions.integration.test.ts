import { ManualClock } from "@opensteer/shared/test-support/clock";
import {
  ignoreForeignTestRequest,
  probeTestServer,
} from "@opensteer/shared/test-support/serverProbes";
import {
  run,
  executablePath,
  addCleanup,
  deployment,
  browserAvailable,
  browserHarness,
  browserCleanupArtifactDirectory,
  startBrowser,
  killChromium,
  grantedProfile,
  profileRevision,
  waitFor,
} from "./browser-deployment.test-support.js";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { testRpcRequest, injectRpcRequest } from "../apps/host/src/server/test-host-api-request.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createId,
  ModelSelectionSchema,
  UserIdSchema,
  type WorkspaceId,
} from "../packages/core/src/index.js";
import {
  type LaunchedBrowser,
  readImageDimensions,
} from "../packages/browser-runtime-core/src/index.js";
import {
  createBrowserSessionId,
  BrowserServerMessageSchema,
  BrowserSessionIdSchema,
  decodeBrowserFrameEnvelope,
  type BrowserServerMessage,
  type BrowserTabOpenResult,
} from "../packages/protocol/src/browser.js";
import {
  HttpHostClient,
  type WebSocketClient,
} from "../packages/client/src/host/host-session-client.js";
import type { BrowserSessionSummary } from "../packages/client/src/host/client.js";
import { hostApi } from "../packages/protocol/src/host-api.js";
import { placeList } from "../packages/client/src/host/places.js";
import { runPages } from "../packages/client/src/host/surfaces.js";
import { WebSocket } from "../apps/host/src/browser/browser-watch-e2e.test-support.js";
import {
  nextJson,
  startBrowserRuntime,
} from "../apps/host/src/browser/browser-runtime.test-support.js";
import { type VerticalStack } from "../apps/host/src/agents/vertical-stack.test-support.js";

/**
 * The browser as an agent sees it, through a whole deployment: a real Host and
 * PostgreSQL, a real Runner with its CDP relay, the shipped Browser Harness,
 * and real Chromium relayed over the Runner's browser bridge. A scripted
 * engine plays the agent, using only what the tools and the skill give it.
 *
 * It opens two sessions and drives them by ID side by side, uploads the photo
 * attached to the chat through a file input and a file chooser, and reads the
 * message every mistake produces. On a granted profile it learns access is
 * already there, signs a site in, and the profile keeps that sign-in across a
 * browser crash because it was saved while in use. The run writes a JSON
 * report to the system temporary directory.
 */
const browserServiceMain = fileURLToPath(
  new URL("../apps/browser-runtime/src/main.ts", import.meta.url),
);

run("Browser Sessions through a whole deployment", () => {
  it("admits automatic page references after delayed forms and document changes", async () => {
    const candidates: Record<string, unknown>[] = [];
    const outcomes: Record<string, unknown>[] = [];
    let passed = false;
    try {
      const browser = await startBrowser();
      addCleanup("automatic context Browser Runtime", () => browser.close());
      const stack = await deployment(browser, undefined, { scenario: "conversation" });
      await browserAvailable(stack);
      const rendered = new Set<string>();
      let releaseLogin = false;
      const pendingForms = new Set<ServerResponse>();
      const frameSite = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><input autocomplete="cc-number"><script>
          parent.postMessage("card-rendered", "*");</script>`);
      });
      frameSite.listen(0, "127.0.0.1");
      addCleanup("automatic context frame fixture", async () => {
        frameSite.closeAllConnections();
        await new Promise<void>((resolve) => frameSite.close(() => resolve()));
      });
      await once(frameSite, "listening");
      const frameOrigin = `http://127.0.0.1:${(frameSite.address() as { port: number }).port}`;
      const site = createServer((request, response) => {
        const url = new URL(request.url!, "http://fixture");
        if (url.pathname === "/rendered") {
          rendered.add(url.searchParams.get("page")!);
          response.end("ok");
          return;
        }
        if (url.pathname === "/release-login") {
          if (releaseLogin) response.end("ok");
          else {
            pendingForms.add(response);
            response.once("close", () => pendingForms.delete(response));
          }
          return;
        }
        const title = `Automatic context ${url.pathname}`;
        const body =
          url.pathname === "/login"
            ? `<script>setTimeout(async () => {
                await fetch("/release-login");
                const input = document.createElement("input");
                input.type = "password";
                document.body.append(input);
                await fetch("/rendered?page=login");
              }, 500);</script>`
            : url.pathname === "/pay"
              ? `<script>addEventListener("message", (event) => {
                  if (event.origin === ${JSON.stringify(frameOrigin)} && event.data === "card-rendered")
                    fetch("/rendered?page=pay");
                });</script><iframe src="${frameOrigin}/card"></iframe>`
              : url.pathname === "/otp"
                ? `<input autocomplete="one-time-code"><script>fetch("/rendered?page=otp");</script>`
                : "<p>No fields</p>";
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>${title}</title><body>${body}</body>`);
      });
      site.listen(0, "127.0.0.1");
      addCleanup("automatic context fixture", async () => {
        site.closeAllConnections();
        await new Promise<void>((resolve) => site.close(() => resolve()));
      });
      await once(site, "listening");
      const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
      const sessionId = BrowserSessionIdSchema.parse(
        await startPersonBrowser(stack, {
          initialUrl: `${origin}/login`,
          viewport: { width: 1000, height: 700 },
        }),
      );
      const client = new HttpHostClient({
        baseUrl: stack.hostOrigin,
        refreshIntervalMs: 0,
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("cookie", stack.sessionCookie);
          headers.set("origin", stack.hostOrigin.origin);
          return fetch(input, { ...init, headers });
        },
        webSocketFactory: () => {
          throw new Error("Reading page context must not open a viewer.");
        },
      });
      addCleanup("automatic context Host client", async () => client.dispose());
      const inventory = await stack.api["browser.tabs.get"]({ sessionId });
      if (!inventory.ok) throw new Error(JSON.stringify(inventory));
      const tabId = inventory.data.tabs[0]!.id;
      const read = async (label: string, pageId: string) => {
        const candidate = await client.readBrowserContextCandidate(sessionId, pageId);
        candidates.push({ label, candidate });
        expect(candidate.documentId).toBeTruthy();
        return candidate;
      };
      // A page's title is its own document's, published once the page names it.
      // Exact reads wait for that publication; the untitled read before it is
      // covered by the runtime's gated tests.
      const published = (pageId: string, title: string) =>
        waitFor(async () => {
          const catalog = await stack.api["browser.tabs.get"]({ sessionId });
          return (
            catalog.ok && catalog.data.tabs.some((tab) => tab.id === pageId && tab.title === title)
          );
        }, 10_000);
      await published(tabId, "Automatic context /login");
      const login = await read("before delayed password", tabId);
      expect(login).toMatchObject({ title: "Automatic context /login", url: `${origin}/login` });
      expect(rendered.has("login")).toBe(false);
      // Hold the form response until the composer read, making the load/send race repeatable.
      releaseLogin = true;
      for (const response of pendingForms) response.end("ok");
      await waitFor(async () => rendered.has("login"), 10_000);
      const send = async (
        label: string,
        candidate: typeof login,
        pageId: string,
        auto: boolean,
      ) => {
        const threadId = await stack.createThread({
          title: label,
          workspaceId: stack.mainWorkspaceId,
          modelSelection: ModelSelectionSchema.parse({
            modelId: "gpt-5.6-sol",
            providerId: "openai",
            options: {},
          }),
        });
        const command = {
          type: "thread.sendMessage" as const,
          threadId,
          idempotencyKey: randomUUID(),
          content: [
            { type: "text" as const, text: `Inspect the included page: ${label}.` },
            {
              type: "browser-page" as const,
              auto,
              documentId: candidate.documentId,
              sessionId,
              tabId: pageId,
              title: candidate.title,
              url: candidate.url,
            },
          ],
        };
        const dispatch = async () => {
          const response = await testRpcRequest(stack.hostOrigin, "commands.dispatch", command, {
            headers: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
            signal: AbortSignal.timeout(30_000),
          });
          const body: unknown = await response.json();
          outcomes.push({ label, status: response.status, body });
          expect(response.status, JSON.stringify(body)).toBe(200);
          const envelope = z
            .object({ ok: z.literal(true), data: hostApi["commands.dispatch"].success })
            .parse(body);
          if (envelope.data.type !== "thread.sendMessage" || !envelope.data.run)
            throw new Error(JSON.stringify(body));
          return envelope.data;
        };
        const result = await dispatch();
        expect(result.wasDuplicate).toBe(false);
        await waitFor(async () => {
          const run = await stack.host.store.database
            .selectFrom("runs")
            .select("status")
            .where("id", "=", result.run!.id)
            .executeTakeFirst();
          return run?.status === "completed";
        }, 30_000);
        const snapshot = await stack.host.store.workspaceSnapshot(stack.mainWorkspaceId);
        expect(
          snapshot.messages.find((message) => message.id === result.message.id)?.content,
        ).toEqual(command.content);
        const answer = snapshot.messages
          .filter((message) => message.runId === result.run!.id && message.kind === "assistant")
          .flatMap((message) => message.content)
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        expect(answer).toContain(
          `The person included this browser page: ${JSON.stringify(candidate.title)} ${JSON.stringify(candidate.url)}`,
        );
        expect(answer).toContain(`Browser Session ${sessionId}, page ${JSON.stringify(pageId)}`);
        outcomes.push({
          label,
          messageId: result.message.id,
          runId: result.run!.id,
          engineInputEcho: answer,
        });
        return { command, result, dispatch };
      };
      const automatic = await send("delayed password first send", login, tabId, true);
      const view = await openBrowserView(stack, sessionId, "control");
      addCleanup("automatic context reload viewer", async () => view.socket.terminate());
      view.socket.send(JSON.stringify({ type: "navigation.reload" }));
      await waitFor(
        async () => (await read("after reload", tabId)).documentId !== login.documentId,
        10_000,
      );
      await send("stale document after reload", login, tabId, true);
      for (const page of ["pay", "otp"] as const) {
        const opened = await client.openBrowserTab(sessionId, { url: `${origin}/${page}` });
        await waitFor(async () => rendered.has(page), 10_000);
        await published(opened.tabId, `Automatic context /${page}`);
        const candidate = await read(page, opened.tabId);
        expect(candidate).toMatchObject({
          title: `Automatic context /${page}`,
          url: `${origin}/${page}`,
        });
        await send(`automatic ${page}`, candidate, opened.tabId, true);
      }
      const plain = await client.openBrowserTab(sessionId, { url: `${origin}/plain` });
      await published(plain.tabId, "Automatic context /plain");
      await send("explicit plain", await read("plain", plain.tabId), plain.tabId, false);
      const retry = await automatic.dispatch();
      expect(retry.wasDuplicate).toBe(true);
      expect(retry.message.id).toBe(automatic.result.message.id);
      expect(retry.run?.id).toBe(automatic.result.run!.id);
      const snapshot = await stack.host.store.workspaceSnapshot(stack.mainWorkspaceId);
      expect(
        snapshot.messages.filter(
          (message) => message.threadId === automatic.command.threadId && message.kind === "input",
        ),
      ).toHaveLength(1);
      expect(
        await stack.host.store.database
          .selectFrom("runs")
          .select("id")
          .where("threadId", "=", automatic.command.threadId)
          .execute(),
      ).toHaveLength(1);
      passed = true;
    } finally {
      await writeViewReport("automatic-page-admission", { candidates, outcomes }, passed);
    }
  }, 180_000);

  it("attributes reply page chips only to exact pages used by each concurrent Run", async () => {
    const clock = new ManualClock();
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser, undefined, {
      activityClock: clock,
      scenario: "notifications",
      maxConcurrentRuns: 2,
    });
    await browserAvailable(stack);
    const site = createServer((request, response) => {
      const title =
        request.url === "/ada"
          ? "Ada Lovelace"
          : request.url === "/ada-renamed"
            ? "Ada Lovelace — updated"
            : request.url === "/babbage"
              ? "Charles Babbage"
              : "www.sixt.com";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    addCleanup("chip fixture site", async () => {
      site.closeAllConnections();
      await new Promise<void>((resolve) => site.close(() => resolve()));
    });
    const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    const sessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, {
        initialUrl: origin,
        viewport: { width: 1000, height: 700 },
      }),
    );
    const opened = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      sessionId,
      url: `${origin}/ada`,
      idempotencyKey: randomUUID(),
    });
    if (!opened.ok || opened.data.type !== "browser.tab.open")
      throw new Error(JSON.stringify(opened));
    const adaId = opened.data.tabId;
    const threads = await Promise.all(
      ["Ada task", "Concurrent task"].map((title) =>
        stack.createThread({
          title,
          workspaceId: stack.mainWorkspaceId,
          modelSelection: ModelSelectionSchema.parse({
            modelId: "gpt-5.6-sol",
            providerId: "openai",
            options: {},
          }),
        }),
      ),
    );
    const threadA = threads[0]!;
    const threadB = threads[1]!;
    const sent = await stack.api["commands.dispatch"]({
      type: "thread.sendMessage",
      threadId: threadA,
      idempotencyKey: randomUUID(),
      content: [
        { type: "text", text: "[[hold]] Use this Ada page and a new Babbage page." },
        {
          type: "browser-page",
          sessionId,
          tabId: adaId,
          title: "Ada Lovelace",
          url: `${origin}/ada`,
        },
      ],
    });
    if (!sent.ok || sent.data.type !== "thread.sendMessage" || !sent.data.run)
      throw new Error(JSON.stringify(sent));
    const runA = sent.data.run.id;
    const second = await stack.queueMessage({ threadId: threadB, text: "[[hold]]" });
    const runB = second.runId;
    if (!runB) throw new Error("The second task did not start a Run");
    await waitFor(
      async () =>
        (
          await stack.host.store.database
            .selectFrom("runs")
            .select("id")
            .where("id", "in", [runA, runB])
            .where("status", "=", "running")
            .execute()
        ).length === 2,
      15_000,
    ).catch(async (cause: unknown) => {
      throw new Error(
        JSON.stringify(
          await stack.host.store.database
            .selectFrom("runs")
            .select(["id", "status", "failure"])
            .where("id", "in", [runA, runB])
            .execute(),
        ),
        { cause },
      );
    });
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("Missing owner");
    const client = new HttpHostClient({
      baseUrl: stack.hostOrigin,
      refreshIntervalMs: 0,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", stack.sessionCookie);
        headers.set("origin", stack.hostOrigin.origin);
        return fetch(input, { ...init, headers });
      },
      webSocketFactory: (url) =>
        new WebSocket(url, {
          headers: {
            cookie: stack.sessionCookie,
            origin: stack.hostOrigin.origin,
          },
        }) as unknown as WebSocketClient,
    });
    addCleanup("chip Host client", async () => client.dispose());
    await client.load();
    for (const thread of threads) {
      const release = client.observeThread(thread);
      addCleanup("observed chip thread", async () => release());
    }
    const connect = async (runId: string) => {
      const connection = await stack.host.browser.attachCdpForAgent(
        {
          agentBindingId: `run:${runId}`,
          ownerId: owner.id,
          workspaceId: stack.mainWorkspaceId,
          sessionId,
        },
        () => undefined,
      );
      addCleanup("chip agent CDP", async () => connection.close());
      return connection;
    };
    const agentA = await connect(runA);
    const agentB = await connect(runB);
    const commands: { runId: string; method: string; targetId: string | null; admitted: true }[] =
      [];
    const request = async (
      runId: string,
      agent: typeof agentA,
      command: Parameters<typeof agentA.request>[0],
    ) => {
      const result = await agent.request(command);
      commands.push({
        runId,
        method: command.method,
        targetId:
          typeof command.parameters?.targetId === "string" ? command.parameters.targetId : null,
        admitted: true,
      });
      return result;
    };
    const inventory = z
      .object({
        targetInfos: z.array(
          z.object({ targetId: z.string(), surfaceId: z.string(), title: z.string() }),
        ),
      })
      .parse(await request(runA, agentA, { method: "Target.getTargets" }));
    const unrelated = inventory.targetInfos.find((target) => target.title === "www.sixt.com")!;
    const ada = inventory.targetInfos.find((target) => target.surfaceId === adaId)!;
    expect(unrelated).toBeDefined();
    expect(ada).toBeDefined();
    const session = () =>
      client.getSnapshot().browserSessions.find((value) => value.id === sessionId)!;
    const usageReady = (runId: string) =>
      session()?.uses?.some((use) => use.runId === runId) === true;
    await waitFor(
      async () => usageReady(runA) && usageReady(runB) && session().acting === true,
      10_000,
    );
    const phases: {
      phase: string;
      session: BrowserSessionSummary;
      pagesA: ReturnType<typeof runPages>;
      pagesB: ReturnType<typeof runPages>;
    }[] = [];
    const note = (phase: string) => {
      const current = session();
      const unrelatedTab = current.tabCatalog?.tabs.find((tab) => tab.id === unrelated.surfaceId);
      if (current.state === "ready") expect(unrelatedTab).toBeDefined();
      expect(unrelatedTab?.occupants ?? []).toEqual([]);
      expect(current.uses?.some((use) => use.runId && use.tabId === unrelated.surfaceId)).toBe(
        false,
      );
      const pagesA = runPages([current], [runA]);
      const pagesB = runPages([current], [runB]);
      expect(
        [...pagesA, ...pagesB].some(
          (page) => page.destination.tabId === unrelated.surfaceId || page.title === "www.sixt.com",
        ),
      ).toBe(false);
      phases.push({ phase, session: current, pagesA, pagesB });
      return { pagesA, pagesB };
    };
    // Connecting and discovering a session do not select any of its pages.
    expect(note("discovery-only pause")).toEqual({ pagesA: [], pagesB: [] });
    clock.advanceBy(300);
    await request(runB, agentB, { method: "Target.getTargets" });
    // Catalog notices use real time. Flush their queued work and observe the
    // resulting authoritative revision in the same client that note() reads.
    await stack.host.browser.catalogsForViewers(sessionId);
    await stack.host.browser.flushPendingTabDescriptors();
    const discoveryCatalog = (await stack.host.browser.catalogsForViewers(sessionId)).get(owner.id);
    expect(discoveryCatalog).toBeDefined();
    await waitFor(
      async () =>
        session().tabCatalog?.generation === discoveryCatalog!.generation &&
        (session().tabCatalog?.revision ?? -1) >= discoveryCatalog!.revision,
      10_000,
    );
    expect(note("still discovery-only")).toEqual({ pagesA: [], pagesB: [] });
    const attached = z.object({ sessionId: z.string(), surfaceId: z.string() }).parse(
      await request(runA, agentA, {
        method: "Target.attachToTarget",
        parameters: { targetId: ada.targetId, flatten: true },
      }),
    );
    expect(attached.surfaceId).toBe(adaId);
    await waitFor(
      async () =>
        session().uses?.some((use) => use.runId === runA && use.tabId === adaId) === true &&
        session()
          .tabCatalog?.tabs.find((tab) => tab.id === adaId)
          ?.occupants.some((occupant) => occupant.threadId === threadA && occupant.acting) === true,
      10_000,
    );
    expect(note("Run A attached Ada")).toMatchObject({
      pagesA: [{ title: "Ada Lovelace", acting: true }],
      pagesB: [],
    });
    // A human navigation updates the authoritative catalog while the recorded use remains old.
    const control = await openBrowserView(stack, sessionId, "control");
    addCleanup("chip control viewer", async () => control.socket.terminate());
    control.socket.send(
      JSON.stringify({ type: "navigation.go", surfaceId: adaId, url: `${origin}/ada-renamed` }),
    );
    await waitFor(
      async () =>
        session().tabCatalog?.tabs.find((tab) => tab.id === adaId)?.title ===
        "Ada Lovelace — updated",
      15_000,
    );
    expect(session().tabs).toEqual([]);
    expect(
      session().uses?.find((use) => use.runId === runA && use.tabId === adaId)?.pageTitle,
    ).toBe("Ada Lovelace");
    expect(note("catalog renamed Ada without a client viewer").pagesA[0]?.title).toBe(
      "Ada Lovelace — updated",
    );
    const created = z.object({ targetId: z.string() }).parse(
      await request(runA, agentA, {
        method: "Target.createTarget",
        parameters: { url: `${origin}/babbage` },
      }),
    );
    const babbage = z.object({ sessionId: z.string(), surfaceId: z.string() }).parse(
      await request(runA, agentA, {
        method: "Target.attachToTarget",
        parameters: { targetId: created.targetId, flatten: true },
      }),
    );
    await waitFor(
      async () =>
        session().uses?.some((use) => use.runId === runA && use.tabId === babbage.surfaceId) ===
          true &&
        session().tabCatalog?.tabs.find((tab) => tab.id === babbage.surfaceId)?.title ===
          "Charles Babbage",
      15_000,
    );
    expect(note("Run A created Babbage").pagesA.map((page) => page.title)).toEqual([
      "Ada Lovelace — updated",
      "Charles Babbage",
    ]);
    // A second Run using the same tab cannot lend its dot to the idle first Run.
    clock.advanceBy(15_100);
    await request(runB, agentB, { method: "Target.getTargets" });
    await waitFor(
      async () =>
        session().acting === true &&
        session().tabCatalog?.tabs.every((tab) =>
          tab.occupants.every((occupant) => !occupant.acting),
        ) === true,
      10_000,
    );
    expect(note("Run B discovery while Run A is idle").pagesA.every((page) => !page.acting)).toBe(
      true,
    );
    const attachedB = z.object({ sessionId: z.string(), surfaceId: z.string() }).parse(
      await request(runB, agentB, {
        method: "Target.attachToTarget",
        parameters: { targetId: created.targetId, flatten: true },
      }),
    );
    await waitFor(
      async () =>
        session().uses?.some((use) => use.runId === runB && use.tabId === babbage.surfaceId) ===
          true &&
        session()
          .tabCatalog?.tabs.find((tab) => tab.id === babbage.surfaceId)
          ?.occupants.some((occupant) => occupant.threadId === threadB && occupant.acting) === true,
      10_000,
    );
    const concurrent = note("only Run B acts on shared Babbage");
    expect(concurrent.pagesA.every((page) => !page.acting)).toBe(true);
    expect(concurrent.pagesB).toMatchObject([{ title: "Charles Babbage", acting: true }]);
    const combined = runPages([session()], [runA, runB]);
    expect(combined).toHaveLength(2);
    expect(combined.find((page) => page.destination.tabId === babbage.surfaceId)?.acting).toBe(
      true,
    );
    await stack.interruptRun(threadB, runB);
    await waitFor(async () => !session().attachedRunIds.includes(runB), 10_000);
    expect(note("Run B ended").pagesB.every((page) => !page.acting)).toBe(true);
    await request(runA, agentA, {
      method: "Runtime.evaluate",
      sessionId: babbage.sessionId,
      parameters: { expression: "document.title" },
    });
    const image = z.object({ data: z.string() }).parse(
      await request(runA, agentA, {
        method: "Page.captureScreenshot",
        sessionId: babbage.sessionId,
        parameters: { format: "png" },
      }),
    );
    expect(attachedB.surfaceId).toBe(babbage.surfaceId);
    expect(
      commands
        .filter((command) => command.method === "Target.attachToTarget")
        .map((command) => command.targetId),
    ).toEqual([ada.targetId, created.targetId, created.targetId]);
    await stack.interruptRun(threadA, runA);
    await waitFor(async () => !session().attachedRunIds.includes(runA), 10_000);
    note("both Runs ended");
    await stack.host.browser.stop(owner.id, sessionId);
    await waitFor(async () => session().state === "closed", 10_000);
    const ended = note("browser ended; exact recorded labels survive");
    expect(ended.pagesA.every((page) => page.ended && !page.acting && page.favicon === null)).toBe(
      true,
    );
    expect(ended.pagesA.find((page) => page.destination.tabId === adaId)?.title).toBe(
      "Ada Lovelace",
    );
    const directory =
      process.env.OPENSTEER_RUN_CHIPS_E2E_ARTIFACT_DIR ??
      path.join(tmpdir(), "opensteer-run-chips-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "final-babbage.png"), Buffer.from(image.data, "base64"));
    await writeFile(
      path.join(directory, "run-page-chips.json"),
      JSON.stringify(
        {
          passed: true,
          headless: true,
          discoveryCatalogRevision: discoveryCatalog!.revision,
          sessionId,
          runA,
          runB,
          threadA,
          threadB,
          targets: {
            unrelated,
            ada,
            babbage: { targetId: created.targetId, surfaceId: babbage.surfaceId },
          },
          commands,
          phases,
        },
        null,
        2,
      ) + "\n",
    );
    process.stdout.write(`Run page chips E2E artifacts: ${directory}\n`);
  }, 120_000);

  it("retains acquired site icons across a real Host restart and lazy sibling restoration", async () => {
    let launches = 0;
    const browser = await startBrowser({ onLaunch: () => launches++ });
    addCleanup("durable icon Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const requests: string[] = [];
    let iconRequestsSucceed = true;
    const site = createServer((request, response) => {
      if (
        ignoreForeignTestRequest(request, response, (path) =>
          ["/blue", "/red", "/blue.svg", "/red.svg"].includes(path),
        )
      )
        return;
      const pathname = new URL(request.url ?? "/", "http://icons.test").pathname;
      requests.push(pathname);
      if (pathname.endsWith(".svg")) {
        if (!iconRequestsSucceed) {
          response.writeHead(503).end();
          return;
        }
        response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
        response.end(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.mark{fill:${pathname === "/blue.svg" ? "blue" : "red"}}</style><rect class="mark" width="32" height="32"/></svg>`,
        );
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<title>${pathname}</title><link rel="icon" href="${pathname}.svg">`);
      }
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    addCleanup("durable icon fixture", async () => {
      site.closeAllConnections();
      await new Promise<void>((resolve) => site.close(() => resolve()));
    });
    const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    const tabs: BrowserTabOpenResult[] = [];
    for (const name of ["blue", "red"]) {
      const result = await stack.api["commands.dispatch"]({
        type: "browser.tab.open",
        identity: { kind: "guest" },
        url: `${origin}/${name}`,
        idempotencyKey: randomUUID(),
      });
      if (!result.ok || result.data.type !== "browser.tab.open")
        throw new Error(JSON.stringify(result));
      tabs.push(result.data);
    }
    const sessionId = tabs[0]!.sessionId;
    expect(tabs[1]!.sessionId).toBe(sessionId);
    const coldRows = async () => {
      const result = await stack.api["bootstrap.get"]({});
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.data.browser.workspaceTabs?.flatMap((group) => group.tabs ?? []) ?? [];
    };
    await waitFor(async () => (await coldRows()).filter((row) => row.iconRef).length === 2, 10_000);
    const before = await coldRows();
    const images = new Map<string, string>();
    for (const row of before) {
      const result = await stack.api["browser.tabIcon.get"]({
        sessionId: row.sessionId,
        iconRef: row.iconRef!,
      });
      if (!result.ok || !result.data.favicon) throw new Error(JSON.stringify(result));
      images.set(row.id, result.data.favicon);
    }
    expect(new Set(images.values()).size).toBe(2);
    iconRequestsSucceed = false;
    await stack.restartHost();
    const requestsAtRestart = requests.length;
    const launchesAtRestart = launches;
    // Foreign traffic during dormant reads must not look like a browser wake-up.
    await probeTestServer(site);
    const dormant = await coldRows();
    expect(dormant.map(({ id, iconRef, state }) => ({ id, iconRef, state }))).toEqual(
      before.map(({ id, iconRef }) => ({ id, iconRef, state: "suspended" })),
    );
    for (const row of dormant) {
      expect(
        await stack.api["browser.tabIcon.get"]({ sessionId: row.sessionId, iconRef: row.iconRef! }),
      ).toMatchObject({ ok: true, data: { favicon: images.get(row.id) } });
    }
    expect(requests.length, JSON.stringify(requests.slice(requestsAtRestart))).toBe(
      requestsAtRestart,
    );
    expect(launches).toBe(launchesAtRestart);
    await browserAvailable(stack);
    const restored = await stack.api["commands.dispatch"]({
      type: "workspace.tab.activate",
      tabId: tabs[0]!.tabId,
      idempotencyKey: randomUUID(),
    });
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });
    const restoredCatalog = await stack.api["browser.tabs.get"]({
      sessionId:
        restored.ok && restored.data.type === "workspace.tab.activate"
          ? restored.data.session.id
          : sessionId,
    });
    expect(restoredCatalog).toMatchObject({
      ok: true,
      data: {
        tabs: [
          expect.objectContaining({
            id: tabs[0]!.tabId,
            iconRef: before.find((row) => row.id === tabs[0]!.tabId)!.iconRef,
          }),
        ],
      },
    });
    const rebound = await coldRows();
    const sibling = rebound.find((row) => row.id === tabs[1]!.tabId)!;
    expect(sibling.state).toBe("suspended");
    expect(sibling.iconRef).toBe(before.find((row) => row.id === sibling.id)!.iconRef);
    expect(
      await stack.api["browser.tabIcon.get"]({
        sessionId: sibling.sessionId,
        iconRef: sibling.iconRef!,
      }),
    ).toMatchObject({ ok: true, data: { favicon: images.get(sibling.id) } });
    expect(requests.filter((pathname) => pathname === "/red")).toHaveLength(1);
    expect(launches).toBe(launchesAtRestart + 1);
    const directory =
      process.env.OPENSTEER_DURABLE_ICON_E2E_ARTIFACT_DIR ??
      path.join(tmpdir(), "opensteer-durable-icon-e2e");
    await mkdir(directory, { recursive: true });
    for (const [id, favicon] of images)
      await writeFile(
        path.join(directory, `${id}.png`),
        Buffer.from(favicon.split(",")[1]!, "base64"),
      );
    await writeFile(
      path.join(directory, "restart.json"),
      JSON.stringify(
        { passed: true, before, dormant, rebound, requests, launchesAtRestart, launches },
        null,
        2,
      ),
    );
  }, 90_000);

  it("works on a browser the agent's own computer relays, as on desktop", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await agentJourney(stack, "relayed", () => killChromium(process.pid));
  }, 240_000);

  it("answers dialogs through the Host's CDP route without waiting on the command a dialog blocks", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    const page = await uploadPage();
    addCleanup("dialog site", () => {
      page.closeAllConnections();
      return new Promise((resolve) => page.close(() => resolve(undefined)));
    });
    const pageOrigin = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
    await waitFor(async () => {
      const bootstrap = await stack.api["bootstrap.get"]({});
      return bootstrap.ok && bootstrap.data.browser.available;
    }, 30_000);
    const workspace = await stack.createWorkspace("Listings");
    const threadId = await stack.createThread({
      modelSelection: ModelSelectionSchema.parse({
        modelId: "gpt-5.6-sol",
        options: {},
        providerId: "openai",
      }),
      title: "Delete the listing",
      workspaceId: workspace.id,
    });
    const evidence =
      process.env.OPENSTEER_HOST_DIALOG_EVIDENCE_DIR ??
      path.join(tmpdir(), "opensteer-host-dialog");
    await mkdir(evidence, { recursive: true });
    const turn = async (trigger: string) => {
      const reply = await stack.sendMessage({
        text: `Delete the listing. DIALOG_PAGE=${pageOrigin}/upload?dialog DIALOG_TRIGGER=${trigger}`,
        threadId,
        workspaceId: workspace.id,
      });
      const report = JSON.parse(reply.assistantText) as DialogReport;
      await writeFile(
        path.join(evidence, `${trigger}.json`),
        `${JSON.stringify({ harness: browserHarness, report }, null, 2)}\n`,
      );
      return report;
    };
    // An input whose handler opens a dialog stays unanswered until the dialog
    // closes. Nothing the agent sends next waits on it: the dialog is reported
    // at once, a program that leaves it open exits promptly, a later program
    // answers that same dialog, and the same program can answer it too.
    for (const trigger of ["mousedown", "click", "keydown"]) {
      const { answeredLater, leftOpen, sameProgram } = await turn(trigger);
      expect(leftOpen, trigger).toMatchObject({ code: 0, dialogId: expect.any(String) });
      expect(leftOpen.outcome, trigger).toMatch(/^DialogOpenedError: /u);
      expect(leftOpen.actMs, trigger).toBeLessThan(2000);
      expect(leftOpen.exitMs, trigger).toBeLessThan(5000);
      expect(answeredLater, trigger).toMatchObject({
        answers: [true],
        code: 0,
        inputs: 1,
        openId: leftOpen.dialogId,
      });
      expect(answeredLater.answerMs, trigger).toBeLessThan(5000);
      expect(sameProgram, trigger).toMatchObject({ answers: [true], code: 0, inputs: 1 });
      expect(sameProgram.outcome, trigger).toMatch(/^DialogOpenedError: /u);
      expect(sameProgram.actMs, trigger).toBeLessThan(2000);
      expect(sameProgram.answerMs, trigger).toBeLessThan(5000);
      expect(sameProgram.exitMs, trigger).toBeLessThan(5000);
    }
    // An answer naming a dialog that already closed is refused, and the
    // dialog that replaced it stays open for its own answer.
    const { replacement } = await turn("replacement");
    expect(replacement).toMatchObject({
      answers: [true, true],
      code: 0,
      inputs: 1,
      stillOpen: replacement.replacementId,
    });
    expect(replacement.replacementId).toEqual(expect.any(String));
    expect(replacement.replacementId).not.toBe(replacement.dialogId);
    expect(replacement.stale).toMatch(/^refused: /u);
  }, 240_000);

  it("works on a browser service of its own, as self-hosted and in the cloud", async () => {
    const enrollmentToken = randomBytes(36).toString("base64url");
    const stack = await deployment(undefined, enrollmentToken);
    const service = await startBrowserService(stack, enrollmentToken);
    await agentJourney(stack, "service", () => killChromium(service.pid));
  }, 240_000);

  it("opens personal identities atomically and replays durable page outcomes without spare tabs", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const site = await loadingSite();
    addCleanup("test site", () => site.close());
    const created = await stack.api["commands.dispatch"]({
      type: "browser.profile.create",
      input: { name: "Work" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok || created.data.type !== "browser.profile.create")
      throw new Error(JSON.stringify(created));
    const profileId = created.data.profile.id;
    const bootstrap = await stack.api["bootstrap.get"]({});
    if (!bootstrap.ok) throw new Error(JSON.stringify(bootstrap));
    const owner = bootstrap.data.user.id;
    // A legacy browser has unknown creation provenance and cannot become the person's reuse candidate.
    const legacy = await stack.host.browser.start({
      ownerId: owner,
      workspaceId: stack.mainWorkspaceId,
      profileId,
      origin: "agent",
    });
    const identity = { kind: "profile" as const, profileId };
    const commands = ["/one?full=first", "/two?full=second"].map((suffix) => ({
      type: "browser.tab.open" as const,
      identity,
      url: site.origin + suffix,
      idempotencyKey: randomUUID(),
      viewport: { width: 1000, height: 700 },
    }));
    const startedAt = performance.now();
    const replies = await Promise.all(
      commands.map((command) => stack.api["commands.dispatch"](command)),
    );
    const results = replies.map((reply) => {
      if (!reply.ok || reply.data.type !== "browser.tab.open")
        throw new Error(JSON.stringify(reply));
      return reply.data;
    });
    expect(results[0]!.sessionId).toBe(results[1]!.sessionId);
    expect(results[0]!.sessionId).not.toBe(legacy.session.id);
    expect(results.map((result) => result.browserStarted).sort()).toEqual([false, true]);
    expect(results[0]!.session.opener).toEqual({ kind: "you" });
    const sessionId = results[0]!.sessionId;
    const catalog = await stack.api["browser.tabs.get"]({ sessionId });
    expect(catalog).toMatchObject({ ok: true, data: { tabs: expect.any(Array) } });
    if (!catalog.ok) throw new Error(JSON.stringify(catalog));
    expect(catalog.data.tabs).toHaveLength(2);
    expect(catalog.data.tabs.map((tab) => tab.id).sort()).toEqual(
      results.map((result) => result.tabId).sort(),
    );
    expect(site.requests).toContain("/one");
    expect(site.requests).toContain("/two");
    const openedPages = await Promise.all(
      results.map((result) =>
        stack.api["browser.contextCandidate.get"]({ sessionId, tabId: result.tabId }),
      ),
    );
    expect(openedPages).toEqual(
      commands.map((command) =>
        expect.objectContaining({ ok: true, data: expect.objectContaining({ url: command.url }) }),
      ),
    );
    const replay = await stack.api["commands.dispatch"](commands[0]!);
    expect(replay).toMatchObject({
      ok: true,
      data: { sessionId, tabId: results[0]!.tabId, browserStarted: results[0]!.browserStarted },
    });
    const binding = await stack.host.store.getBrowserTabOpen(owner, commands[0]!.idempotencyKey);
    expect(binding).toMatchObject({
      chosenSessionId: sessionId,
      browserStarted: results[0]!.browserStarted,
      outcome: { kind: "opened", tabId: results[0]!.tabId },
    });
    expect(
      await stack.api["commands.dispatch"]({ ...commands[0]!, url: site.origin + "/changed" }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await stack.api["commands.dispatch"]({
        ...commands[0]!,
        idempotencyKey: randomUUID(),
        placement: { kind: "runner", runnerId: createId("runner") },
      }),
    ).toMatchObject({ ok: false, error: { reason: "browser-placement-unavailable" } });
    expect(
      await stack.api["commands.dispatch"]({
        ...commands[0]!,
        idempotencyKey: randomUUID(),
        identity: { kind: "profile", profileId: createId("browserProfile") },
      }),
    ).toMatchObject({ ok: false, error: { reason: "browser-profile-unavailable" } });
    const guest = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      identity: { kind: "guest" },
      url: site.origin + "/guest",
      idempotencyKey: randomUUID(),
    });
    expect(guest).toMatchObject({
      ok: true,
      data: { browserStarted: true, catalog: { tabs: [expect.any(Object)] } },
    });
    const after = await stack.host.browser.bootstrap(owner);
    expect(after.sessions.find((session) => session.id === legacy.session.id)?.opener).toEqual({
      kind: "unknown",
    });
    // Initialization is the real Host restart recovery path: open sessions fail; bindings survive.
    await stack.host.browser.stop(owner, sessionId);
    await stack.restartHost();
    const endedReplay = await stack.api["commands.dispatch"](commands[0]!);
    expect(endedReplay).toMatchObject({
      ok: true,
      data: { sessionId, tabId: results[0]!.tabId, browserStarted: results[0]!.browserStarted },
    });
    const evidence = {
      replies,
      replay,
      binding,
      endedReplay,
      elapsedMs: performance.now() - startedAt,
      requests: site.requests,
      onePersonalSession: true,
      noSpareBlank: true,
      openedPages,
      legacyNotReused: true,
      exactUrls: commands.map((command) => command.url),
    };
    const directory =
      process.env.OPENSTEER_TAB_OPEN_E2E_ARTIFACT_DIR ??
      path.join(tmpdir(), "opensteer-tab-open-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "identity-open.json"), JSON.stringify(evidence, null, 2));
  }, 90_000);

  it("opens pages independently of unrelated start work and reports pre-submission unavailability honestly", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("Missing owner");
    const first = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      identity: { kind: "guest" },
      idempotencyKey: randomUUID(),
    });
    if (!first.ok || first.data.type !== "browser.tab.open") throw new Error(JSON.stringify(first));
    const initial = first.data;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const getWorkspace = stack.host.store.getWorkspaceForOwner.bind(stack.host.store);
    let held = false;
    const gate = vi
      .spyOn(stack.host.store, "getWorkspaceForOwner")
      .mockImplementation(async (...args) => {
        if (!held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return getWorkspace(...args);
      });
    const unrelated = stack.host.browser.start({
      ownerId: owner.id,
      workspaceId: initial.session.workspaceId,
      fresh: true,
    });
    await entered.promise;
    let sessionOpenMs: number;
    let identityOpenMs: number;
    try {
      const at = performance.now();
      const session = await Promise.race([
        stack.api["commands.dispatch"]({
          type: "browser.tab.open",
          sessionId: initial.sessionId,
          idempotencyKey: randomUUID(),
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Session open waited on unrelated start")),
            2_000,
          );
          timer.unref();
        }),
      ]);
      sessionOpenMs = performance.now() - at;
      expect(session).toMatchObject({
        ok: true,
        data: { browserStarted: false, sessionId: initial.sessionId },
      });
      const identityAt = performance.now();
      const identity = await Promise.race([
        stack.api["commands.dispatch"]({
          type: "browser.tab.open",
          identity: { kind: "guest" },
          idempotencyKey: randomUUID(),
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Identity reuse waited on unrelated start")),
            2_000,
          );
          timer.unref();
        }),
      ]);
      identityOpenMs = performance.now() - identityAt;
      expect(identity).toMatchObject({
        ok: true,
        data: { browserStarted: false, sessionId: initial.sessionId },
      });
    } finally {
      release.resolve();
      gate.mockRestore();
    }
    await unrelated;
    await stack.host.store.transitionBrowserSession({
      sessionId: initial.sessionId,
      state: "starting",
    });
    const retryKey = randomUUID();
    const starting = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      sessionId: initial.sessionId,
      idempotencyKey: retryKey,
    });
    expect(starting).toMatchObject({ ok: false, error: { reason: "browser-session-unavailable" } });
    expect(await stack.host.store.getBrowserTabOpen(owner.id, retryKey)).toBeNull();
    await stack.host.store.transitionBrowserSession({
      sessionId: initial.sessionId,
      state: "ready",
    });
    const retry = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      sessionId: initial.sessionId,
      idempotencyKey: retryKey,
    });
    expect(retry).toMatchObject({ ok: true, data: { sessionId: initial.sessionId } });
    const detached = await stack.host.store.createBrowserSession({
      id: createBrowserSessionId(),
      runnerId: initial.session.placement.runnerId,
      workspaceId: initial.session.workspaceId,
      origin: "workspace",
      profileId: null,
      placementKey: "detached-test",
      runtimeId: "browser-e2e",
      leaseGeneration: 1,
      leaseTokenHash: null,
    });
    await stack.host.store.transitionBrowserSession({ sessionId: detached.id, state: "ready" });
    const detachedReply = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      sessionId: detached.id,
      idempotencyKey: randomUUID(),
    });
    expect(detachedReply).toMatchObject({
      ok: false,
      error: { reason: "browser-session-unavailable", retryable: true },
    });
    const navigationEntered = Promise.withResolvers<void>();
    const navigationRelease = Promise.withResolvers<void>();
    const slowSite = createServer((_request, response) => {
      navigationEntered.resolve();
      void navigationRelease.promise.then(() =>
        response.end("<!doctype html><title>Opened</title>"),
      );
    });
    slowSite.listen(0, "127.0.0.1");
    await once(slowSite, "listening");
    addCleanup("held navigation site", async () => {
      navigationRelease.resolve();
      slowSite.closeAllConnections();
      await new Promise<void>((resolve) => slowSite.close(() => resolve()));
    });
    const slowProfile = await stack.host.browser.createProfile({
      name: "Slow navigation",
      ownerId: owner.id,
      idempotencyKey: randomUUID(),
      workspaceId: stack.mainWorkspaceId,
    });
    const fastProfile = await stack.host.browser.createProfile({
      name: "Independent identity",
      ownerId: owner.id,
      idempotencyKey: randomUUID(),
      workspaceId: stack.mainWorkspaceId,
    });
    const slow = stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      identity: { kind: "profile", profileId: slowProfile.id },
      url: `http://127.0.0.1:${(slowSite.address() as { port: number }).port}/blocked`,
      idempotencyKey: randomUUID(),
    });
    await navigationEntered.promise;
    let independentStartMs: number;
    try {
      const at = performance.now();
      const fast = await Promise.race([
        stack.api["commands.dispatch"]({
          type: "browser.tab.open",
          identity: { kind: "profile", profileId: fastProfile.id },
          idempotencyKey: randomUUID(),
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Unrelated identity start waited on first navigation")),
            4_000,
          );
          timer.unref();
        }),
      ]);
      independentStartMs = performance.now() - at;
      expect(fast).toMatchObject({ ok: true, data: { browserStarted: true } });
    } finally {
      navigationRelease.resolve();
    }
    expect(await slow).toMatchObject({ ok: true, data: { browserStarted: true } });
    const directory =
      process.env.OPENSTEER_TAB_OPEN_E2E_ARTIFACT_DIR ??
      path.join(tmpdir(), "opensteer-tab-open-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "open-isolation.json"),
      JSON.stringify(
        { sessionOpenMs, identityOpenMs, independentStartMs, starting, detachedReply, retry },
        null,
        2,
      ),
    );
  }, 90_000);

  it("binds uncertain page operations durably and rejects malformed identity dispatches", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const site = await loadingSite();
    addCleanup("test site", () => site.close());
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("Missing owner");
    const initial = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      identity: { kind: "guest" },
      url: site.origin + "/original",
      idempotencyKey: randomUUID(),
    });
    if (!initial.ok || initial.data.type !== "browser.tab.open")
      throw new Error(JSON.stringify(initial));
    const first = initial.data;
    const next = {
      type: "browser.tab.open" as const,
      identity: { kind: "guest" as const },
      url: site.origin + "/uncertain?full=kept",
      idempotencyKey: randomUUID(),
    };
    const settle = stack.host.store.settleBrowserTabOpen.bind(stack.host.store);
    const failure = vi
      .spyOn(stack.host.store, "settleBrowserTabOpen")
      .mockImplementation(async (binding) => {
        if (binding.idempotencyKey === next.idempotencyKey)
          throw new Error("Injected lost persistence acknowledgement after native page open");
        return settle(binding);
      });
    const lost = await stack.api["commands.dispatch"](next);
    failure.mockRestore();
    expect(lost.ok).toBe(false);
    const bound = await stack.host.store.getBrowserTabOpen(owner.id, next.idempotencyKey);
    expect(bound).toMatchObject({ chosenSessionId: first.sessionId, outcome: { kind: "pending" } });
    const retry = await stack.api["commands.dispatch"](next);
    if (!retry.ok || retry.data.type !== "browser.tab.open") throw new Error(JSON.stringify(retry));
    expect(retry.data.sessionId).toBe(first.sessionId);
    expect(retry.data.catalog.tabs).toHaveLength(2);
    const page = await stack.api["browser.contextCandidate.get"]({
      sessionId: first.sessionId,
      tabId: retry.data.tabId,
    });
    expect(page).toMatchObject({ ok: true, data: { url: next.url } });
    const profile = await stack.host.browser.createProfile({
      name: "Uncertain start",
      ownerId: owner.id,
      idempotencyKey: randomUUID(),
      workspaceId: stack.mainWorkspaceId,
    });
    const starting = {
      type: "browser.tab.open" as const,
      identity: { kind: "profile" as const, profileId: profile.id },
      url: site.origin + "/initial",
      idempotencyKey: randomUUID(),
    };
    const initialFailure = vi
      .spyOn(stack.host.store, "settleBrowserTabOpen")
      .mockImplementation(async (binding) => {
        if (binding.idempotencyKey === starting.idempotencyKey)
          throw new Error("Injected initial-page outcome loss");
        return settle(binding);
      });
    const startLost = await stack.api["commands.dispatch"](starting);
    initialFailure.mockRestore();
    expect(startLost.ok).toBe(false);
    const initialBinding = await stack.host.store.getBrowserTabOpen(
      owner.id,
      starting.idempotencyKey,
    );
    if (!initialBinding) throw new Error("Start binding was not persisted");
    expect(initialBinding.outcome.kind).toBe("pending");
    const unknown = await stack.api["commands.dispatch"](starting);
    expect(unknown).toMatchObject({
      ok: false,
      error: { reason: "browser-tab-open-outcome-unknown" },
    });
    const initialCatalog = await stack.api["browser.tabs.get"]({
      sessionId: initialBinding.chosenSessionId,
    });
    expect(initialCatalog).toMatchObject({ ok: true, data: { tabs: [expect.any(Object)] } });
    const malformed = [];
    for (const input of [
      { ...next, sessionId: first.sessionId },
      { ...next, identity: { kind: "guest", profileId: profile.id } },
    ]) {
      const response = await injectRpcRequest(stack.host.app, "commands.dispatch", input, {
        cookie: stack.sessionCookie,
        origin: stack.hostOrigin.origin,
      });
      expect(response.statusCode, response.body).toBe(400);
      malformed.push({ status: response.statusCode, body: response.json<unknown>() });
    }
    expect((await stack.host.browser.bootstrap(owner.id)).sessions).toHaveLength(2);
    await stack.restartHost();
    expect(await stack.api["commands.dispatch"](starting)).toMatchObject({
      ok: false,
      error: { reason: "browser-session-closed" },
    });
    expect((await stack.host.browser.bootstrap(owner.id)).sessions).toHaveLength(2);
    const directory =
      process.env.OPENSTEER_TAB_OPEN_E2E_ARTIFACT_DIR ??
      path.join(tmpdir(), "opensteer-tab-open-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "uncertain-open.json"),
      JSON.stringify(
        {
          first,
          lost,
          bound,
          retry,
          page,
          startLost,
          initialBinding,
          unknown,
          initialCatalog,
          malformed,
        },
        null,
        2,
      ),
    );
  }, 90_000);

  it("honors identity placement holders and final-save grace across two real browser runtimes", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const token = randomBytes(36).toString("base64url");
    const stack = await deployment(browser, token);
    await browserAvailable(stack);
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("Missing owner");
    const profile = await stack.host.browser.createProfile({
      name: "Held identity",
      ownerId: owner.id,
      idempotencyKey: randomUUID(),
      workspaceId: stack.mainWorkspaceId,
    });
    const site = await loadingSite();
    addCleanup("test site", () => site.close());
    const open = (placement?: {
      kind: "runner";
      runnerId: ReturnType<typeof createId<"runner">>;
    }) =>
      stack.api["commands.dispatch"]({
        type: "browser.tab.open",
        identity: { kind: "profile", profileId: profile.id },
        url: site.origin + "/placed",
        idempotencyKey: randomUUID(),
        ...(placement ? { placement } : {}),
      });
    const first = await open();
    if (!first.ok || first.data.type !== "browser.tab.open") throw new Error(JSON.stringify(first));
    const opened = first.data;
    const firstPlacement = opened.session.placement;
    await startBrowserService(stack, token);
    await waitFor(
      async () =>
        (await stack.host.browser.bootstrap(owner.id)).placements.filter(
          (placement) => placement.available,
        ).length === 2,
      30_000,
    );
    const placements = (await stack.host.browser.bootstrap(owner.id)).placements;
    const other = placements.find(
      (placement) => placement.runnerId !== firstPlacement.runnerId && placement.available,
    );
    if (!other) throw new Error("Second runtime is missing");
    const conflict = await open({ kind: "runner", runnerId: other.runnerId });
    expect(conflict).toMatchObject({
      ok: false,
      error: { reason: "browser-placement-unavailable" },
    });
    const ambiguous = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      identity: { kind: "guest" },
      idempotencyKey: randomUUID(),
    });
    expect(ambiguous).toMatchObject({
      ok: false,
      error: { reason: "browser-placement-ambiguous" },
    });
    const holderReuse = await open();
    expect(holderReuse).toMatchObject({
      ok: true,
      data: { sessionId: opened.sessionId, browserStarted: false },
    });
    const committed = stack.host.store.commitBrowserProfileRevision.bind(stack.host.store);
    const release = Promise.withResolvers<void>();
    const checkpoint = vi
      .spyOn(stack.host.store, "commitBrowserProfileRevision")
      .mockImplementation(async (input) => {
        if (input.profileId === profile.id) await release.promise;
        return committed(input);
      });
    let offline;
    let grace;
    try {
      stack.network.block();
      stack.network.drop();
      await waitFor(
        async () =>
          (await stack.host.store.getBrowserSessionForOwner(opened.sessionId, owner.id))?.state ===
          "failed",
        15_000,
      );
      grace = await stack.host.store.findBrowserSessionHoldingProfilePlacement(profile.id);
      expect(grace?.id).toBe(opened.sessionId);
      offline = await open();
      expect(offline).toMatchObject({
        ok: false,
        error: { reason: "browser-placement-unavailable" },
      });
      expect(await open({ kind: "runner", runnerId: other.runnerId })).toMatchObject({
        ok: false,
        error: { reason: "browser-placement-unavailable" },
      });
      const guest = await stack.api["commands.dispatch"]({
        type: "browser.tab.open",
        identity: { kind: "guest" },
        url: site.origin + "/single",
        idempotencyKey: randomUUID(),
      });
      expect(guest).toMatchObject({
        ok: true,
        data: { session: { placement: { runnerId: other.runnerId } }, browserStarted: true },
      });
    } finally {
      release.resolve();
      checkpoint.mockRestore();
      stack.network.unblock();
    }
    const directory =
      process.env.OPENSTEER_TAB_OPEN_E2E_ARTIFACT_DIR ??
      path.join(tmpdir(), "opensteer-tab-open-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "identity-placement.json"),
      JSON.stringify(
        { first, placements, conflict, ambiguous, holderReuse, grace, offline },
        null,
        2,
      ),
    );
  }, 120_000);

  it("reports a refused final-save lease promptly with its typed reason", async () => {
    const logged = vi.spyOn(console, "error");
    const release = Promise.withResolvers<void>();
    let requests = 0;
    const browser = await startBrowser({
      profileStateFetch: async (input, init) => {
        if (init?.method === "PUT") {
          requests += 1;
          await release.promise;
        }
        return fetch(input, init);
      },
    });
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("Missing owner");
    const profile = await stack.host.browser.createProfile({
      name: "Refused save",
      ownerId: owner.id,
      idempotencyKey: randomUUID(),
      workspaceId: stack.mainWorkspaceId,
    });
    const opened = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      identity: { kind: "profile", profileId: profile.id },
      idempotencyKey: randomUUID(),
    });
    if (!opened.ok || opened.data.type !== "browser.tab.open")
      throw new Error(JSON.stringify(opened));
    const sessionId = opened.data.sessionId;
    stack.network.block();
    stack.network.drop();
    let failure: unknown;
    const started = performance.now();
    try {
      await waitFor(
        async () =>
          (await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id))?.state ===
            "failed" && requests > 0,
        10_000,
      );
      await stack.host.store.database
        .updateTable("browserSessions")
        .set({ profileLeaseExpiresAt: new Date(0) })
        .where("id", "=", sessionId)
        .execute();
      release.resolve();
      failure = await browser.close().catch((error: unknown) => error);
      expect(failure).toMatchObject({
        errors: [
          expect.objectContaining({
            code: "forbidden",
            reason: "profile-state.lease-rejected",
            retryable: false,
          }),
        ],
      });
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(logged).toHaveBeenCalledWith(
        "browser.profile.checkpoint.failed",
        expect.objectContaining({
          phase: "final",
          stage: "host-commit",
          error: expect.objectContaining({ reason: "profile-state.lease-rejected" }),
        }),
      );
    } finally {
      release.resolve();
      stack.network.unblock();
      await stack.host.store.database
        .updateTable("browserSessions")
        .set({ profileLeaseExpiresAt: new Date(Date.now() + 60_000) })
        .where("id", "=", sessionId)
        .execute();
      await browser.close();
      const directory = browserCleanupArtifactDirectory();
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "refused-checkpoint.json"),
        JSON.stringify(
          {
            elapsedMs: performance.now() - started,
            requests,
            error: inspect(failure, { depth: 8 }),
            health: browser.health(),
          },
          null,
          2,
        ),
      );
    }
  }, 30_000);

  it("bounds a stalled Chromium checkpoint and retains the profile for an explicit shutdown retry", async () => {
    const logged = vi.spyOn(console, "error");
    let native: LaunchedBrowser | undefined;
    let exporting: ReturnType<LaunchedBrowser["exportSnapshot"]> | undefined;
    const browser = await startBrowser({
      idleProfileHostTimeoutMs: 600_000,
      onLaunch: (launched) => {
        native = launched;
        const exportSnapshot = launched.exportSnapshot.bind(launched);
        vi.spyOn(launched, "exportSnapshot").mockImplementation(() => {
          exporting = exportSnapshot();
          return exporting;
        });
      },
    });
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("Missing owner");
    const profile = await stack.host.browser.createProfile({
      name: "Stalled save",
      ownerId: owner.id,
      idempotencyKey: randomUUID(),
      workspaceId: stack.mainWorkspaceId,
    });
    const opened = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      identity: { kind: "profile", profileId: profile.id },
      idempotencyKey: randomUUID(),
    });
    if (!opened.ok || opened.data.type !== "browser.tab.open" || !native)
      throw new Error(JSON.stringify(opened));
    const launched = native;
    const inventory = z
      .object({ processInfo: z.array(z.object({ id: z.number(), type: z.string() })) })
      .parse(await launched.cdp.send("SystemInfo.getProcessInfo"));
    const pid = inventory.processInfo.find((entry) => entry.type === "browser")?.id;
    if (!pid) throw new Error("Missing owned Chromium process");
    const directory = browserCleanupArtifactDirectory();
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "stalled-checkpoint.json"),
      JSON.stringify({ pid, phase: "started" }),
    );
    await stack.host.browser.stop(owner.id, opened.data.sessionId);
    await waitFor(
      async () => browser.health().sessionCount === 0 && launched.context.pages().length === 0,
      10_000,
    );
    process.kill(pid, "SIGSTOP");
    const started = performance.now();
    const stopping = browser.close();
    let failure: unknown;
    try {
      failure = await withTimeout(stopping, 22_000, {
        timeoutError: () => new Error("Shutdown still waits on a stopped Chromium checkpoint."),
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        errors: [
          expect.objectContaining({
            reason: "profile-checkpoint.snapshot-timeout",
            retryable: true,
          }),
        ],
      });
      expect(browser.health()).toMatchObject({ state: "closing", profileHostCount: 1 });
      expect(logged).toHaveBeenCalledWith(
        "browser.profile.checkpoint.failed",
        expect.objectContaining({
          phase: "final",
          stage: "snapshot",
          error: expect.objectContaining({ reason: "profile-checkpoint.snapshot-timeout" }),
        }),
      );
      const retried = performance.now();
      await expect(browser.close()).rejects.toMatchObject({
        errors: [expect.objectContaining({ reason: "profile-checkpoint.snapshot-pending" })],
      });
      expect(performance.now() - retried).toBeLessThan(1_000);
    } finally {
      process.kill(pid, "SIGCONT");
      await stopping.catch(() => undefined);
      await exporting;
      await browser.close();
      await writeFile(
        path.join(directory, "stalled-checkpoint.json"),
        JSON.stringify(
          {
            pid,
            phase: "closed",
            elapsedMs: performance.now() - started,
            error: inspect(failure, { depth: 8 }),
            savedRevision: await profileRevision(stack, profile.id),
            health: browser.health(),
          },
          null,
          2,
        ),
      );
    }
  }, 45_000);

  it("opens authoritative tabs without a viewer, replays keys, and fences last-tab close", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const sessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, { viewport: { height: 700, width: 1000 } }),
    );
    const command = { type: "browser.tab.open" as const, sessionId, idempotencyKey: randomUUID() };
    const [first, retry] = await Promise.all([
      stack.api["commands.dispatch"](command),
      stack.api["commands.dispatch"](command),
    ]);
    if (!first.ok || first.data.type !== "browser.tab.open") throw new Error(JSON.stringify(first));
    const firstOpened = first.data;
    expect(retry).toEqual(first);
    expect(firstOpened.catalog.tabs).toHaveLength(2);
    expect(firstOpened.catalog.tabs.some((tab) => tab.id === firstOpened.tabId)).toBe(true);
    const mismatch = await stack.api["commands.dispatch"]({
      ...command,
      url: "https://example.com/",
    });
    expect(mismatch).toMatchObject({ ok: false, error: { code: "conflict" } });
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:secret@example.com/",
    ]) {
      const invalid = { ...command, url, idempotencyKey: randomUUID() };
      expect(await stack.api["commands.dispatch"](invalid)).toMatchObject({
        ok: false,
        error: { reason: "invalid-payload", retryable: false },
      });
      const response = await injectRpcRequest(stack.host.app, "commands.dispatch", invalid, {
        cookie: stack.sessionCookie,
        origin: stack.hostOrigin.origin,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json<unknown>()).toMatchObject({ ok: false, error: { code: "bad_request" } });
    }
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("Missing owner");
    await expect(
      stack.host.browser.openTab(UserIdSchema.parse(`usr_${randomUUID()}`), command),
    ).rejects.toMatchObject({ code: "not_found" });
    const closed = await stack.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId,
      surfaceId: first.data.tabId,
      expectedGeneration: first.data.catalog.generation,
      expectedRevision: first.data.catalog.inventoryRevision!,
      idempotencyKey: randomUUID(),
    });
    if (!closed.ok || closed.data.type !== "browser.tab.close")
      throw new Error(JSON.stringify(closed));
    expect(await stack.api["commands.dispatch"](command)).toMatchObject({
      ok: true,
      data: { tabId: first.data.tabId },
    });
    const site = await sizeReportingSite();
    addCleanup("test site", () => site.close());
    const client = new HttpHostClient({
      baseUrl: stack.hostOrigin,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", stack.sessionCookie);
        headers.set("origin", stack.hostOrigin.origin);
        return fetch(input, { ...init, headers });
      },
      webSocketFactory: () => {
        throw new Error("Opening a tab must not create a viewer socket.");
      },
    });
    addCleanup("Host client", async () => client.dispose());
    const urlSessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, { viewport: { height: 700, width: 1000 } }),
    );
    const clientOpened = await client.openBrowserTab(urlSessionId, { url: site.origin });
    expect(clientOpened.catalog.tabs.some((tab) => tab.id === clientOpened.tabId)).toBe(true);
    await waitFor(
      async () =>
        (await client.readBrowserContextCandidate(urlSessionId, clientOpened.tabId)).url ===
        `${site.origin}/`,
      15_000,
    );
    await stack.host.browser.stop(owner.id, urlSessionId);
    const last = closed.data.catalog.tabs[0]!;
    const race = await Promise.all([
      stack.api["commands.dispatch"]({
        type: "browser.tab.close",
        sessionId,
        surfaceId: last.id,
        expectedGeneration: closed.data.catalog.generation,
        expectedRevision: closed.data.catalog.inventoryRevision!,
        idempotencyKey: randomUUID(),
      }),
      stack.api["commands.dispatch"]({ ...command, idempotencyKey: randomUUID() }),
    ]);
    const closing = race[0];
    const opening = race[1];
    if (
      closing.ok &&
      closing.data.type === "browser.tab.close" &&
      closing.data.outcome === "session-closed"
    ) {
      expect(opening).toMatchObject({ ok: false, error: { reason: "browser-session-closed" } });
      expect(
        await stack.api["commands.dispatch"]({ ...command, idempotencyKey: randomUUID() }),
      ).toMatchObject({ ok: false, error: { reason: "browser-session-closed" } });
    } else {
      expect(closing).toMatchObject({ ok: false, error: { reason: "stale-tab-inventory" } });
      expect(opening.ok).toBe(true);
    }
    await stack.host.browser.stop(owner.id, sessionId);
    expect(
      await stack.api["commands.dispatch"]({ ...command, idempotencyKey: randomUUID() }),
    ).toMatchObject({ ok: false, error: { reason: "browser-session-closed" } });
    expect(await stack.api["commands.dispatch"](command)).toMatchObject({
      ok: true,
      data: { tabId: first.data.tabId },
    });
    const directory =
      process.env.OPENSTEER_TAB_OPEN_E2E_ARTIFACT_DIR ??
      path.join(tmpdir(), "opensteer-tab-open-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "host-tab-open.json"),
      JSON.stringify(
        {
          first,
          retry,
          mismatch,
          race,
          clientOpened,
          sessionClosedAfterRace: true,
          noViewerRequired: true,
          invalidSchemesAndCredentialsRefused: true,
          outsiderRefused: true,
        },
        null,
        2,
      ),
    );
  }, 90_000);

  it("says a tab is loading only while its own page loads, through the catalog, and Stop ends it", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    const site = await loadingSite();
    addCleanup("test site", () => site.close());
    await browserAvailable(stack);
    const sessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, { viewport: { height: 700, width: 1000 } }),
    );
    const started = Date.now();
    const timeline: { at: number; step: string; loading: boolean | undefined }[] = [];
    const catalog = async () => {
      const read = await stack.api["browser.tabs.get"]({ sessionId });
      if (!read.ok) throw new Error(JSON.stringify(read));
      return read.data;
    };
    const tabOf = async (tabId: string) => (await catalog()).tabs.find((tab) => tab.id === tabId);
    const note = async (step: string, tabId: string) =>
      timeline.push({ at: Date.now() - started, step, loading: (await tabOf(tabId))?.loading });
    const until = async (step: string, tabId: string, loading: boolean) => {
      await waitFor(async () => ((await tabOf(tabId))?.loading === true) === loading, 15_000);
      await note(step, tabId);
    };

    // A page whose response is still arriving: its tab loads, as a browser's spinner says.
    const opened = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      sessionId,
      url: `${site.origin}/slow`,
      idempotencyKey: randomUUID(),
    });
    if (!opened.ok || opened.data.type !== "browser.tab.open")
      throw new Error(JSON.stringify(opened));
    const tabId = opened.data.tabId;
    await until("its page's response is held open", tabId, true);
    // The sidebar's place list reads exactly that field.
    const read = await catalog();
    const listed = placeList({
      browserSessions: [
        {
          createdAt: new Date().toISOString(),
          id: sessionId,
          profileId: null,
          placement: { kind: "runner", runnerId: "rnr_11111111-1111-4111-8111-111111111111" },
          state: "ready",
          tabCatalog: read,
          tabs: [],
        } as unknown as BrowserSessionSummary,
      ],
      browserProfiles: [],
      browserPlacements: [],
      machines: [],
    });
    expect(listed.find((place) => place.key === `browser:${sessionId}:${tabId}`)?.loading).toBe(
      true,
    );
    // Another tab of the same browser is not loading.
    expect(read.tabs.filter((tab) => tab.id !== tabId).every((tab) => !tab.loading)).toBe(true);

    // Stop, from that tab's own targeted view, ends it; the server never finished the page.
    const control = await openBrowserView(stack, sessionId, "control");
    addCleanup("control viewer", async () => control.socket.terminate());
    control.socket.send(JSON.stringify({ type: "stream.subscribe", surfaceId: tabId }));
    control.socket.send(JSON.stringify({ type: "navigation.stop", surfaceId: tabId }));
    await until("Stop", tabId, false);
    expect(site.finished).not.toContain("/slow");

    // A page that finishes loads and then stops by itself.
    control.socket.send(
      JSON.stringify({ type: "navigation.go", surfaceId: tabId, url: `${site.origin}/frame-host` }),
    );
    await waitFor(async () => (await tabOf(tabId))?.title === "Frame host", 15_000);
    await until("a page that finished", tabId, false);
    // Its script then adds a frame whose page never finishes: a frame loading is not the tab.
    await waitFor(async () => site.requests.includes("/slow-frame"), 15_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await note("1.5 s into a frame that never finishes", tabId);
    expect(timeline.at(-1)?.loading).toBeUndefined();

    // A navigation the server answers with 204 leaves no spinner behind.
    control.socket.send(
      JSON.stringify({ type: "navigation.go", surfaceId: tabId, url: `${site.origin}/empty` }),
    );
    await waitFor(async () => site.requests.includes("/empty"), 15_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await note("1 s after a 204 answer", tabId);
    expect(timeline.at(-1)?.loading).toBeUndefined();

    // Reloading a held page loads again, and closing the tab takes it all away.
    control.socket.send(
      JSON.stringify({ type: "navigation.go", surfaceId: tabId, url: `${site.origin}/slow` }),
    );
    await until("held again", tabId, true);
    const current = await catalog();
    const closed = await stack.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId,
      surfaceId: tabId,
      expectedGeneration: current.generation,
      expectedRevision: current.inventoryRevision!,
      idempotencyKey: randomUUID(),
    });
    expect(closed.ok).toBe(true);
    expect((await catalog()).tabs.some((tab) => tab.loading)).toBe(false);

    const directory =
      process.env.OPENSTEER_TAB_OPEN_E2E_ARTIFACT_DIR ??
      path.join(tmpdir(), "opensteer-tab-open-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "host-tab-loading.json"),
      JSON.stringify({ timeline, requests: site.requests, finished: site.finished }, null, 2),
    );
  }, 90_000);

  it("recovers the ninth Chromium target and refuses an old two-tab close decision", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const sessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, { viewport: { height: 600, width: 800 } }),
    );
    for (let index = 1; index < 9; index++) {
      const opened = await stack.api["commands.dispatch"]({
        type: "browser.tab.open",
        sessionId,
        idempotencyKey: `capacity-tab-${index}`,
      });
      expect(opened.ok).toBe(true);
    }
    const catalog = await stack.api["browser.tabs.get"]({ sessionId });
    if (!catalog.ok) throw new Error(JSON.stringify(catalog));
    expect(catalog.data.tabs).toHaveLength(9);
    const client = new HttpHostClient({
      baseUrl: stack.hostOrigin,
      refreshIntervalMs: 0,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", stack.sessionCookie);
        headers.set("origin", stack.hostOrigin.origin);
        return fetch(input, { ...init, headers });
      },
      webSocketFactory: (url) =>
        new WebSocket(url, {
          headers: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
        }) as unknown as WebSocketClient,
    });
    addCleanup("Host client", async () => client.dispose());
    await client.load();
    const targets = catalog.data.tabs.map((tab) => tab.id);
    const release = targets
      .slice(0, 8)
      .map((surfaceId) => client.retainBrowserWatch(sessionId, surfaceId));
    await waitFor(
      async () =>
        targets
          .slice(0, 8)
          .every((id) => client.browserWatchState(sessionId, id).status === "live"),
      25_000,
    );
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("Missing browser owner");
    let failOutcome = false;
    let writerFailures = 0;
    let failedReaderClosed = false;
    const brittle = await stack.host.browser.attach(
      owner.id,
      sessionId,
      {
        id: `failed-reader-${randomUUID()}`,
        isOpen: () => !failedReaderClosed,
        close: () => {
          failedReaderClosed = true;
        },
        send: async (data, binary) => {
          if (!binary && JSON.parse(String(data)).type === "browser.stream.state" && failOutcome) {
            failOutcome = false;
            writerFailures++;
            throw new Error("The reader disconnected while its capture outcome was sent.");
          }
        },
      },
      { authSessionId: createId("authSession"), mode: "watch", signedIn: async () => true },
    );
    addCleanup("brittle viewer", async () => brittle.close());
    await brittle.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: targets[0]! })),
      false,
    );
    failOutcome = true;
    release.push(client.retainBrowserWatch(sessionId, targets[8]!));
    addCleanup("browser watch leases", async () => {
      for (const drop of release) drop();
    });
    await waitFor(
      async () =>
        targets
          .slice(0, 8)
          .every((id) => client.browserWatchState(sessionId, id).status === "live") &&
        client.browserWatchState(sessionId, targets[8]!).error !== null,
      25_000,
    );
    expect(writerFailures).toBe(1);
    expect(failedReaderClosed).toBe(true);
    const saturated = targets.map((id) => ({
      id,
      ...client.browserWatchState(sessionId, id),
      frame: undefined,
    }));
    expect(client.browserWatchState(sessionId, targets[8]!)).toMatchObject({
      status: "unavailable",
      error: "Too many browser capture targets.",
    });
    release[0]!();
    await waitFor(
      async () => client.browserWatchState(sessionId, targets[8]!).status === "live",
      20_000,
    );
    expect(
      targets.slice(1).every((id) => client.browserWatchState(sessionId, id).status === "live"),
    ).toBe(true);
    const recovered = targets.slice(1).map((id) => ({
      id,
      status: client.browserWatchState(sessionId, id).status,
      frameId: client.browserWatchFrame(sessionId, id)?.header.frameId,
    }));
    for (const drop of release) drop();
    let current = catalog.data;
    for (const surfaceId of targets.slice(2)) {
      const closed = await stack.api["commands.dispatch"]({
        type: "browser.tab.close",
        sessionId,
        surfaceId,
        expectedGeneration: current.generation,
        expectedRevision: current.inventoryRevision!,
        idempotencyKey: randomUUID(),
      });
      if (!closed.ok || closed.data.type !== "browser.tab.close")
        throw new Error(JSON.stringify(closed));
      current = closed.data.catalog;
    }
    expect(current.tabs).toHaveLength(2);
    const displayed = current;
    const removedElsewhere = await stack.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId,
      surfaceId: targets[1]!,
      expectedGeneration: displayed.generation,
      expectedRevision: displayed.inventoryRevision!,
      idempotencyKey: randomUUID(),
    });
    const firstDecision = await stack.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId,
      surfaceId: targets[0]!,
      expectedGeneration: displayed.generation,
      expectedRevision: displayed.inventoryRevision!,
      idempotencyKey: randomUUID(),
    });
    expect(firstDecision).toMatchObject({ ok: false, error: { reason: "stale-tab-inventory" } });
    const surviving = await stack.api["browser.tabs.get"]({ sessionId });
    expect(surviving).toMatchObject({
      ok: true,
      data: { tabs: [{ id: targets[0]!, availability: "ready" }] },
    });
    if (!surviving.ok) throw new Error("Session did not survive first decision");
    const secondDecision = await stack.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId,
      surfaceId: targets[0]!,
      expectedGeneration: surviving.data.generation,
      expectedRevision: surviving.data.inventoryRevision!,
      idempotencyKey: randomUUID(),
    });
    expect(secondDecision).toMatchObject({ ok: true, data: { outcome: "session-closed" } });
    await writeViewReport("capacity-and-confirmation", {
      sessionId,
      saturated,
      recovered,
      displayed,
      removedElsewhere,
      firstDecision,
      surviving,
      secondDecision,
      refreshIntervalMs: 0,
      isolatedReaderWriteFailure: writerFailures === 1 && failedReaderClosed,
    });
  }, 120_000);

  it("finishes persisting a closed session before acknowledging its close", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const sessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, { viewport: { height: 700, width: 1_000 } }),
    );
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("The deployment has no owner");
    const transition = stack.host.store.transitionBrowserSession.bind(stack.host.store);
    const persisting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = vi
      .spyOn(stack.host.store, "transitionBrowserSession")
      .mockImplementation(async (input) => {
        if (input.sessionId === sessionId && input.state === "closed") {
          persisting.resolve();
          await release.promise;
        }
        return transition(input);
      });
    let closeCompleted = false;
    const closing = stack.host.browser.stop(owner.id, sessionId).then(() => {
      closeCompleted = true;
    });
    try {
      await persisting.promise;
      // Drain the socket-close continuations while the terminal write is held.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const before = await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id);
      expect(before?.state).toBe("closing");
      expect(closeCompleted).toBe(false);
      release.resolve();
      await closing;
      const after = await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id);
      expect(after?.state).toBe("closed");
      const endedMessage = `Browser Session ${sessionId} has ended. Open a new one with browser_session_open.`;
      await expect(
        stack.host.browser.attachCdpForAgent(
          {
            agentBindingId: "trigger:closed-session",
            ownerId: owner.id,
            sessionId,
            workspaceId: stack.mainWorkspaceId,
          },
          () => undefined,
        ),
      ).rejects.toThrow(endedMessage);
      await writeViewReport("closed-session-durable", {
        after: after?.state,
        before: before?.state,
        closeCompleted,
        endedMessage,
        sessionId,
      });
    } finally {
      release.resolve();
      await closing;
      held.mockRestore();
    }
  }, 60_000);

  it("keeps a terminal session when an earlier closing write finishes later", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const sessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, { viewport: { height: 700, width: 1_000 } }),
    );
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("The deployment has no owner");
    const transition = stack.host.store.transitionBrowserSession.bind(stack.host.store);
    const persisting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    const writes: { requested: string; persisted: string }[] = [];
    const spy = vi
      .spyOn(stack.host.store, "transitionBrowserSession")
      .mockImplementation(async (input) => {
        if (input.sessionId === sessionId && input.state === "closing" && !held) {
          held = true;
          persisting.resolve();
          await release.promise;
        }
        const result = await transition(input);
        if (input.sessionId === sessionId)
          writes.push({ requested: input.state, persisted: result.session.state });
        return result;
      });
    const closing = stack.host.browser.stop(owner.id, sessionId);
    try {
      await persisting.promise;
      killChromium(process.pid);
      await waitFor(
        async () =>
          (await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id))?.state ===
          "closed",
        10_000,
      );
      const before = await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id);
      release.resolve();
      await closing;
      const after = await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id);
      expect(after).toEqual(before);
      expect(after?.state).toBe("closed");
      await expect(
        stack.host.browser.attachCdpForAgent(
          {
            agentBindingId: "trigger:delayed-closing",
            ownerId: owner.id,
            sessionId,
            workspaceId: stack.mainWorkspaceId,
          },
          () => undefined,
        ),
      ).rejects.toThrow(
        `Browser Session ${sessionId} has ended. Open a new one with browser_session_open.`,
      );
      await writeViewReport("closed-session-delayed-closing", { before, after, sessionId, writes });
    } finally {
      release.resolve();
      await closing.finally(() => spy.mockRestore());
    }
  }, 60_000);

  it.each(["requested", "unsolicited"] as const)(
    "reports failed terminal persistence after %s close and still cleans up",
    async (source) => {
      const browser = await startBrowser();
      addCleanup("local Browser Runtime", () => browser.close());
      const stack = await deployment(browser);
      await browserAvailable(stack);
      const sessionId = BrowserSessionIdSchema.parse(
        await startPersonBrowser(stack, { viewport: { height: 700, width: 1_000 } }),
      );
      const owner = await stack.host.store.firstUser();
      if (!owner) throw new Error("The deployment has no owner");
      const agent = {
        agentBindingId: "trigger:failed-terminal-write",
        ownerId: owner.id,
        sessionId,
        workspaceId: stack.mainWorkspaceId,
      };
      const consumerClosed = vi.fn();
      const attachment = await stack.host.browser.attachCdpForAgent(
        agent,
        () => undefined,
        consumerClosed,
      );
      const transition = stack.host.store.transitionBrowserSession.bind(stack.host.store);
      const failure = new Error("Injected terminal database failure");
      let attempts = 0;
      const spy = vi
        .spyOn(stack.host.store, "transitionBrowserSession")
        .mockImplementation(async (input) => {
          if (
            input.sessionId === sessionId &&
            (input.state === "closed" || input.state === "failed")
          ) {
            attempts += 1;
            throw failure;
          }
          return transition(input);
        });
      const reported = vi.spyOn(console, "error");
      try {
        let outcome = "unsolicited";
        if (source === "requested") {
          outcome = await stack.host.browser.closeAgentSession(agent).then(
            () => "resolved",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );
        } else {
          killChromium(process.pid);
          await waitFor(
            () => Promise.resolve(reported.mock.calls.some((call) => call.includes(sessionId))),
            10_000,
          );
        }
        const after = await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id);
        const refusal = await stack.host.browser
          .attachCdpForAgent(agent, () => undefined)
          .then(
            () => "attached",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );
        if (source === "requested")
          expect(outcome).toBe(
            `Browser Session ${sessionId} disconnected, but Opensteer could not save its ended state. Open a new one with browser_session_open.`,
          );
        expect(consumerClosed).toHaveBeenCalledOnce();
        expect(attempts).toBe(1);
        expect(after?.state).toBe("closing");
        expect(refusal).toBe(
          `Browser Session ${sessionId} lost its browser connection. Open a new one with browser_session_open.`,
        );
        expect(reported.mock.calls.some((call) => call.includes(sessionId))).toBe(true);
        await writeViewReport(`closed-session-failed-${source}`, {
          attempts,
          consumerClosed: consumerClosed.mock.calls.length,
          outcome,
          refusal,
          reported: reported.mock.calls.map((call) => call.map(String)),
          sessionId,
          state: after?.state,
        });
      } finally {
        spy.mockRestore();
        reported.mockRestore();
        attachment.close();
        await stack.host.browser.stop(owner.id, sessionId);
      }
    },
    60_000,
  );

  it("opens a person's browser at their view's size and follows only their own view", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    const site = await sizeReportingSite();
    addCleanup("test site", () => site.close());
    await browserAvailable(stack);

    // The first page loads at the view's size; it never reflows into it.
    const startView = { height: 777, width: 1_111 };
    const sessionId = await startPersonBrowser(stack, {
      initialUrl: `${site.origin}/sized`,
      viewport: startView,
    });
    await waitFor(async () => site.seen.some((entry) => entry.at === "load"), 20_000);
    const firstLoad = site.seen.find((entry) => entry.at === "load");
    expect(firstLoad).toMatchObject(startView);
    const control = await openBrowserView(stack, sessionId, "control");
    addCleanup("control viewer", async () => control.socket.terminate());
    const surfaceId = control.activeSurfaceId;
    const firstFrame = waitForBrowserFrame(control.socket, true);
    control.socket.send(JSON.stringify({ type: "stream.subscribe" }));
    const startFrame = (await firstFrame).header;
    expect(startFrame).toMatchObject({ viewportHeight: 777, viewportWidth: 1_111 });
    const reflowsBeforeFollow = site.seen.filter((entry) => entry.at === "resize");
    expect(reflowsBeforeFollow).toEqual([]);

    // A browser that follows the view takes the person's size.
    const followed = { height: 700, width: 1_000 };
    const followedFrame = waitForBrowserFrameAt(control.socket, followed);
    control.socket.send(JSON.stringify({ ...followed, surfaceId, type: "viewport.follow" }));
    const followedHeader = (await followedFrame).header;
    await waitFor(
      async () =>
        site.seen.some(
          (entry) =>
            entry.at === "resize" &&
            entry.width === followed.width &&
            entry.height === followed.height,
        ),
      10_000,
    );

    // A watch is refused like any other command and sizes nothing.
    const watch = await openBrowserView(stack, sessionId, "watch");
    addCleanup("watch viewer", async () => watch.socket.terminate());
    const watchClosed = waitForBrowserClosing(watch.socket);
    watch.socket.send(
      JSON.stringify({ height: 650, surfaceId, type: "viewport.follow", width: 900 }),
    );
    const watchRefusal = await watchClosed;
    expect(watchRefusal).toEqual({
      code: 4002,
      reason: "Watch can only subscribe, acknowledge, or unsubscribe.",
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
    const watchResizes = site.seen.filter(
      (entry) => entry.at === "resize" && entry.width === 900 && entry.height === 650,
    );
    expect(watchResizes).toEqual([]);
    const afterWatch = waitForBrowserFrame(control.socket, true);
    control.socket.send(JSON.stringify({ type: "navigation.reload" }));
    const afterWatchHeader = (await afterWatch).header;
    expect(afterWatchHeader).toMatchObject({ viewportHeight: 700, viewportWidth: 1_000 });
    await waitFor(async () => site.seen.filter((entry) => entry.at === "load").length >= 2, 10_000);
    const reload = site.seen.filter((entry) => entry.at === "load").at(-1);
    expect(reload).toMatchObject(followed);

    await writeViewReport("relayed-chromium", {
      startView,
      firstLoad,
      startFrame,
      reflowsBeforeFollow,
      followed: { requested: followed, frame: followedHeader },
      watchRefusal,
      watchResizes,
      afterWatch: { frame: afterWatchHeader, reload },
      pageSizeLog: site.seen,
    });
  }, 120_000);

  it.each([
    "natural",
    "renderer handoff",
    "stopped navigation",
    "stopped before rejection",
    "startup failure",
  ] as const)(
    "keeps the session when a popup asks before it draws, and pictures a tab whose dialog waits (%s)",
    async (mode) => {
      let openingAsking = false;
      let handoffInjected = false;
      const handoff = Promise.withResolvers<void>();
      const stoppedResponse = Promise.withResolvers<void>();
      const loadingStopped = Promise.withResolvers<void>();
      const cdpTrace: Record<string, unknown>[] = [];
      const browser = await startBrowser({
        onLaunch: (launched) => {
          const observe = (page: ReturnType<LaunchedBrowser["context"]["pages"]>[number]) => {
            const cdp = page.cdp.bind(page);
            const injectHandoff = openingAsking && mode !== "natural";
            const loading = Promise.withResolvers<void>();
            let observed = false;
            vi.spyOn(page, "cdp").mockImplementation(async () => {
              const session = await cdp();
              if (!observed) {
                observed = true;
                session.on("Page.frameStartedLoading", () => loading.resolve());
                if (injectHandoff)
                  session.on("Page.frameStoppedLoading", () => loadingStopped.resolve());
                const send = session.send.bind(session);
                vi.spyOn(session, "send").mockImplementation(
                  async <Result>(
                    method: string,
                    parameters?: Record<string, unknown>,
                  ): Promise<Result> => {
                    const at = performance.now();
                    try {
                      // Hold the fixture response until Chromium's observed renderer-handoff
                      // rejection has reached the real Runtime subscription path.
                      if (injectHandoff && !handoffInjected && method === "Page.startScreencast") {
                        if (mode !== "startup failure") await loading.promise;
                        handoffInjected = true;
                        handoff.resolve();
                        if (mode === "stopped before rejection") {
                          await send("Page.stopLoading");
                          await loadingStopped.promise;
                        }
                        throw new Error(
                          mode === "startup failure"
                            ? "Unrelated cast startup failure"
                            : "Protocol error (Page.startScreencast): Not attached to an active page",
                        );
                      }
                      const result = await send<Result>(method, parameters);
                      if (/Screencast|DeviceMetrics|navigate/.test(method))
                        cdpTrace.push({
                          at,
                          completed: performance.now(),
                          url: page.url(),
                          method,
                          parameters,
                        });
                      if (
                        process.env.OPENSTEER_BROWSER_DIAGNOSTICS === "1" &&
                        /Screencast|DeviceMetrics|navigate/.test(method)
                      )
                        console.info(
                          JSON.stringify({
                            popupCdp: true,
                            at,
                            completed: performance.now(),
                            url: page.url(),
                            method,
                            parameters,
                          }),
                        );
                      return result;
                    } catch (error) {
                      cdpTrace.push({
                        at,
                        rejected: performance.now(),
                        url: page.url(),
                        method,
                        parameters,
                        error: inspect(error, { depth: 8 }),
                      });
                      console.info(
                        JSON.stringify({
                          popupCdp: true,
                          at,
                          rejected: performance.now(),
                          url: page.url(),
                          method,
                          parameters,
                          error: inspect(error, { depth: 8 }),
                        }),
                      );
                      throw error;
                    }
                  },
                );
              }
              return session;
            });
          };
          launched.context.pages().forEach(observe);
          launched.context.onPage(observe);
        },
      });
      addCleanup("local Browser Runtime", () => browser.close());
      const stack = await deployment(browser);
      const site = await popupDialogSite(
        mode === "stopped navigation" || mode === "stopped before rejection"
          ? stoppedResponse.promise
          : mode === "renderer handoff"
            ? handoff.promise
            : undefined,
      );
      addCleanup("test site", () => site.close());
      await browserAvailable(stack);
      const view = { height: 700, width: 1_000 };
      const sessionId = await startPersonBrowser(stack, {
        initialUrl: `${site.origin}/opener`,
        viewport: view,
      });
      const control = await openBrowserView(stack, sessionId, "control");
      addCleanup("control viewer", async () => control.socket.terminate());
      const opener = control.activeSurfaceId;
      const viewer = recordBrowserView(control.socket);
      control.socket.send(JSON.stringify({ type: "stream.subscribe" }));
      await waitFor(async () => site.seen.includes("opener-load"), 20_000);
      const frameOf = (surfaceId: string) => (entry: ViewerEntry) =>
        entry.kind === "frame" &&
        entry.header.surfaceId === surfaceId &&
        entry.header.viewportWidth === view.width &&
        entry.header.viewportHeight === view.height;
      const directory =
        process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
        path.join(tmpdir(), "opensteer-browser-follow-e2e");
      await mkdir(directory, { recursive: true });
      const journeys = [];
      for (const kind of ["confirm", "alert"] as const) {
        await waitFor(async () => viewer.entries.some(frameOf(opener)), 10_000);
        // The person clicks the page's button in its picture; it opens a popup
        // whose first script asks before the popup draws anything.
        const from = viewer.entries.length;
        for (const action of ["down", "up"] as const) {
          control.socket.send(
            JSON.stringify({
              action,
              button: "left",
              clickCount: 1,
              surfaceId: opener,
              type: "input.pointer",
              viewportHeight: view.height,
              viewportWidth: view.width,
              x: 0.5,
              y: 0.5,
            }),
          );
        }
        let openedPopup: string | undefined;
        await waitFor(async () => {
          openedPopup = viewer.entries
            .slice(from)
            .flatMap((entry) =>
              entry.kind === "message" && entry.message.type === "browser.surfaces.changed"
                ? entry.message.surfaces
                : [],
            )
            .find((surface) => surface.openerId != null && surface.id !== opener)?.id;
          return openedPopup !== undefined;
        }, 10_000);
        expect(control.activeSurfaceId).toBe(opener);
        control.socket.send(JSON.stringify({ type: "surface.activate", surfaceId: openedPopup }));
        const since = () => viewer.entries.slice(from);
        const shownAt = () =>
          since().findIndex(
            (entry) =>
              entry.kind === "message" &&
              entry.message.type === "browser.dialog.changed" &&
              entry.message.dialog !== null &&
              entry.message.dialog.surfaceId !== opener,
          );
        await waitFor(async () => shownAt() !== -1, 10_000);
        const shown = since()[shownAt()];
        const dialog =
          shown?.kind === "message" && shown.message.type === "browser.dialog.changed"
            ? shown.message.dialog
            : null;
        if (!dialog) throw new Error("The popup's dialog was not shown.");
        const popup = dialog.surfaceId;
        const namedAt = since().findIndex(
          (entry) =>
            entry.kind === "message" &&
            entry.message.type === "browser.surfaces.changed" &&
            entry.message.surfaces.some((surface) => surface.id === popup),
        );
        const order = since()
          .slice(0, shownAt() + 1)
          .map((entry) => describeViewerEntry(entry, { [opener]: "opener", [popup]: "popup" }));

        // They answer the dialog they see, by its id; the popup then draws.
        const answeredFrom = viewer.entries.length;
        control.socket.send(
          JSON.stringify({ accept: true, dialogId: dialog.id, type: "dialog.respond" }),
        );
        await waitFor(
          async () => site.seen.some((at) => at.startsWith(`popup-answered:${kind}`)),
          10_000,
        );
        await waitFor(
          async () => viewer.entries.slice(answeredFrom).some(frameOf(popup)),
          10_000,
        ).catch(async (error: unknown) => {
          await writeFile(
            path.join(directory, "popup-frame-failure.json"),
            JSON.stringify(
              {
                kind,
                popup,
                opener,
                seen: site.seen,
                entries: viewer.entries.map((entry) =>
                  entry.kind === "frame" ? { kind: entry.kind, header: entry.header } : entry,
                ),
              },
              null,
              2,
            ),
          );
          throw error;
        });
        const popupFrame = viewer.entries.slice(answeredFrom).find(frameOf(popup));
        if (popupFrame?.kind !== "frame") throw new Error("The popup was never pictured.");
        await writeFile(path.join(directory, `deployment-popup-${kind}.jpeg`), popupFrame.jpeg);
        const cleared = viewer.entries
          .slice(answeredFrom)
          .some(
            (entry) =>
              entry.kind === "message" &&
              entry.message.type === "browser.dialog.changed" &&
              entry.message.dialog === null,
          );

        // Closing the popup returns them to the opener, which is as it was.
        const closedFrom = viewer.entries.length;
        control.socket.send(JSON.stringify({ surfaceId: popup, type: "surface.close" }));
        await waitFor(async () => viewer.entries.slice(closedFrom).some(frameOf(opener)), 10_000);
        const surfacesAfterClose = viewer.entries
          .slice(closedFrom)
          .flatMap((entry) =>
            entry.kind === "message" && entry.message.type === "browser.surfaces.changed"
              ? [
                  entry.message.surfaces.map((surface) => ({
                    active: surface.active,
                    id: surface.id,
                  })),
                ]
              : [],
          )
          .at(-1);
        journeys.push({
          kind,
          dialog,
          order,
          namedBeforeShown: namedAt !== -1 && namedAt < shownAt(),
          answeredInPage: site.seen.filter((at) => at.startsWith(`popup-answered:${kind}`)),
          dialogCleared: cleared,
          popupFrame: { header: popupFrame.header, decoded: popupFrame.decoded },
          openerAfterClose: surfacesAfterClose,
        });
      }

      // A tab whose dialog waits cannot draw. Turning back to it shows its last
      // picture beneath the dialog, after the list that makes it the tab shown.
      const isDialogOn = (surfaceId: string) => (entry: ViewerEntry) =>
        entry.kind === "message" &&
        entry.message.type === "browser.dialog.changed" &&
        entry.message.dialog?.surfaceId === surfaceId;
      const shownTab = (from: number) =>
        viewer.entries
          .slice(from)
          .flatMap((entry) =>
            entry.kind === "message" && entry.message.type === "browser.surfaces.changed"
              ? entry.message.surfaces
                  .filter((surface) => surface.active)
                  .map((surface) => surface.id)
              : [],
          )
          .at(-1);
      const openedFrom = viewer.entries.length;
      openingAsking = true;
      if (mode === "startup failure") {
        const stoppedFrom = cdpTrace.length;
        control.socket.send(JSON.stringify({ type: "stream.unsubscribe" }));
        await waitFor(
          async () =>
            cdpTrace.slice(stoppedFrom).some((entry) => entry.method === "Page.stopScreencast"),
          10_000,
        );
      }
      control.socket.send(
        JSON.stringify({ type: "surface.open", url: `${site.origin}/asks`, viewport: view }),
      );
      if (mode === "startup failure") {
        await loadingStopped.promise;
        await waitFor(async () => {
          const latest = viewer.entries.findLast(
            (entry) =>
              entry.kind === "message" && entry.message.type === "browser.surfaces.changed",
          );
          return (
            latest?.kind === "message" &&
            latest.message.type === "browser.surfaces.changed" &&
            latest.message.surfaces.some(
              (surface) =>
                surface.active && surface.url === `${site.origin}/asks` && !surface.loading,
            )
          );
        }, 10_000);
        control.socket.send(JSON.stringify({ type: "stream.subscribe" }));
      }
      if (
        mode === "stopped navigation" ||
        mode === "stopped before rejection" ||
        mode === "startup failure"
      ) {
        await handoff.promise;
        await waitFor(
          async () => shownTab(openedFrom) !== undefined && shownTab(openedFrom) !== opener,
          10_000,
        );
        const asking = shownTab(openedFrom)!;
        const errors = () =>
          viewer.entries.filter(
            (entry) => entry.kind === "message" && entry.message.type === "browser.error",
          );
        const report = () =>
          writeViewReport(`popup-first-script-dialog-${mode.replaceAll(" ", "-")}`, {
            mode,
            asking,
            handoffInjected,
            cdpTrace,
            seen: site.seen,
            entries: viewer.entries.map((entry) =>
              entry.kind === "frame" ? { kind: entry.kind, header: entry.header } : entry,
            ),
          });
        if (mode === "startup failure") {
          try {
            await waitFor(async () => errors().length > 0, 10_000);
          } finally {
            await report();
          }
          expect(errors()).toHaveLength(1);
        } else {
          if (mode === "stopped before rejection") await loadingStopped.promise;
          else control.socket.send(JSON.stringify({ type: "navigation.stop", surfaceId: asking }));
          try {
            await waitFor(
              async () => viewer.entries.slice(openedFrom).some(frameOf(asking)),
              10_000,
            );
          } finally {
            await report();
          }
          expect(site.seen).not.toContain("asks-load");
          expect(errors()).toEqual([]);
        }
        expect(handoffInjected).toBe(true);
        return;
      }
      await waitFor(
        async () =>
          shownTab(openedFrom) !== undefined &&
          shownTab(openedFrom) !== opener &&
          site.seen.includes("asks-load"),
        10_000,
      ).catch(async (error: unknown) => {
        await writeFile(
          path.join(directory, "surface-open-failure.json"),
          JSON.stringify(
            {
              closed: viewer.closed(),
              seen: site.seen,
              entries: viewer.entries.map((entry) =>
                entry.kind === "frame" ? { kind: entry.kind, header: entry.header } : entry,
              ),
              bootstrap: await stack.api["bootstrap.get"]({}),
            },
            null,
            2,
          ),
        );
        throw error;
      });
      const asking = shownTab(openedFrom)!;
      await waitFor(
        async () => viewer.entries.slice(openedFrom).some(frameOf(asking)),
        10_000,
      ).catch(async (error: unknown) => {
        await writeFile(
          path.join(directory, "surface-frame-failure.json"),
          JSON.stringify(
            {
              closed: viewer.closed(),
              seen: site.seen,
              asking,
              cdpTrace,
              entries: viewer.entries.map((entry) =>
                entry.kind === "frame" ? { kind: entry.kind, header: entry.header } : entry,
              ),
            },
            null,
            2,
          ),
        );
        throw error;
      });
      const askFrom = viewer.entries.length;
      for (const action of ["down", "up"] as const) {
        control.socket.send(
          JSON.stringify({
            action,
            button: "left",
            clickCount: 1,
            surfaceId: asking,
            type: "input.pointer",
            viewportHeight: view.height,
            viewportWidth: view.width,
            x: 0.5,
            y: 0.5,
          }),
        );
      }
      await waitFor(async () => viewer.entries.slice(askFrom).some(isDialogOn(asking)), 10_000);
      const askedEntry = viewer.entries.slice(askFrom).find(isDialogOn(asking));
      const waitingDialog =
        askedEntry?.kind === "message" && askedEntry.message.type === "browser.dialog.changed"
          ? askedEntry.message.dialog
          : null;
      if (!waitingDialog) throw new Error("The tab's dialog was not shown.");
      const awayFrom = viewer.entries.length;
      control.socket.send(JSON.stringify({ surfaceId: opener, type: "surface.activate" }));
      await waitFor(async () => viewer.entries.slice(awayFrom).some(frameOf(opener)), 10_000);
      const returnFrom = viewer.entries.length;
      const returnedAt = performance.now();
      control.socket.send(JSON.stringify({ surfaceId: asking, type: "surface.activate" }));
      await waitFor(
        async () => viewer.entries.slice(returnFrom).some(frameOf(asking)),
        5_000,
      ).catch(() => undefined);
      const back = viewer.entries.slice(returnFrom);
      const listAt = back.findIndex(
        (entry) =>
          entry.kind === "message" &&
          entry.message.type === "browser.surfaces.changed" &&
          entry.message.surfaces.some((surface) => surface.active && surface.id === asking),
      );
      const pictureAt = back.findIndex(frameOf(asking));
      const retained = back[pictureAt];
      const reshown = back.find(isDialogOn(asking));
      const pageAnsweredBeforePicture = site.seen.some((at) => at.startsWith("asked:"));
      if (retained?.kind === "frame") {
        await writeFile(path.join(directory, "deployment-waiting-tab-return.jpeg"), retained.jpeg);
      }
      const answerFrom = viewer.entries.length;
      control.socket.send(
        JSON.stringify({ accept: true, dialogId: waitingDialog.id, type: "dialog.respond" }),
      );
      await waitFor(async () => site.seen.includes("asked:true"), 10_000);
      await waitFor(async () => viewer.entries.slice(answerFrom).some(frameOf(asking)), 10_000);
      const live = viewer.entries.slice(answerFrom).find(frameOf(asking));
      const waitingTab = {
        dialog: waitingDialog,
        order: back
          .slice(0, Math.max(pictureAt, listAt) + 1)
          .map((entry) =>
            describeViewerEntry(entry, { [opener]: "opener", [asking]: "waiting tab" }),
          ),
        listBeforePicture: listAt !== -1 && pictureAt > listAt,
        pictureAfterMs: retained ? Math.round(retained.at - returnedAt) : null,
        picture:
          retained?.kind === "frame"
            ? { header: retained.header, decoded: retained.decoded }
            : null,
        reshownDialog:
          reshown?.kind === "message" && reshown.message.type === "browser.dialog.changed"
            ? reshown.message.dialog
            : null,
        pageAnsweredBeforePicture,
        liveAfterAnswer: live?.kind === "frame" ? live.header : null,
      };
      const bootstrap = await stack.api["bootstrap.get"]({});
      const sessionState =
        bootstrap.ok && bootstrap.data.browser.sessions.find((s) => s.id === sessionId)?.state;
      const outcome = {
        mode,
        handoffInjected,
        cdpTrace,
        view,
        journeys,
        waitingTab,
        viewerClosed: viewer.closed(),
        sessionState,
        pageLog: site.seen,
      };
      await writeViewReport(`popup-first-script-dialog-${mode.replaceAll(" ", "-")}`, outcome);
      expect(handoffInjected).toBe(mode === "renderer handoff");
      expect(
        viewer.entries.filter(
          (entry) => entry.kind === "message" && entry.message.type === "browser.error",
        ),
      ).toEqual([]);
      for (const journey of journeys) {
        expect(journey.dialog, journey.kind).toMatchObject({
          message: "Immediate popup",
          type: journey.kind,
        });
        expect(journey.namedBeforeShown, JSON.stringify(journey.order)).toBe(true);
        expect(journey.answeredInPage).toEqual([
          `popup-answered:${journey.kind}:${journey.kind === "confirm" ? "true" : "undefined"}`,
        ]);
        expect(journey.dialogCleared).toBe(true);
        expect(journey.popupFrame.header).toMatchObject({
          viewportHeight: view.height,
          viewportWidth: view.width,
        });
        expect(journey.popupFrame.decoded).toEqual({
          height: journey.popupFrame.header.rasterHeight,
          width: journey.popupFrame.header.rasterWidth,
        });
        expect(journey.openerAfterClose).toEqual([{ active: true, id: opener }]);
      }
      expect(waitingTab.listBeforePicture, JSON.stringify(waitingTab.order)).toBe(true);
      expect(waitingTab.pictureAfterMs).not.toBeNull();
      expect(waitingTab.pictureAfterMs).toBeLessThanOrEqual(300);
      expect(waitingTab.picture?.header).toMatchObject({
        surfaceId: asking,
        viewportHeight: view.height,
        viewportWidth: view.width,
      });
      expect(waitingTab.picture?.decoded).toEqual({
        height: waitingTab.picture?.header.rasterHeight,
        width: waitingTab.picture?.header.rasterWidth,
      });
      expect(waitingTab.reshownDialog).toEqual(waitingDialog);
      expect(waitingTab.pageAnsweredBeforePicture).toBe(false);
      expect(waitingTab.liveAfterAnswer).not.toBeNull();
      expect(outcome.viewerClosed).toBeNull();
      expect(outcome.sessionState).toBe("ready");
    },
    120_000,
  );

  it("keeps proof-v2 browser computers connected while translating older viewer contracts", async () => {
    const startView = { height: 777, width: 1_111 };
    const journey = async (sharedControl: boolean) => {
      const stack = await deployment(undefined);
      const enrollment = await stack.api["commands.dispatch"]({
        allowedModules: ["browser"],
        idempotencyKey: randomUUID(),
        name: "Browser computer",
        type: "runner.enrollment.createLocal",
      });
      if (!enrollment.ok || enrollment.data.type !== "runner.enrollment.createLocal") {
        throw new Error("Could not enroll the browser computer");
      }
      const releasedDialog = {
        message: "Continue?",
        surfaceId: "page-integration",
        type: "confirm",
      };
      const runtime = await startBrowserRuntime(
        Number(stack.hostOrigin.port),
        enrollment.data.token,
        {
          agentReady: sharedControl,
          initialDialog: { ...releasedDialog, ...(sharedControl ? { id: randomUUID() } : {}) },
        },
      );
      addCleanup("protocol runtime", () => runtime.close());
      const forwarded: Record<string, unknown>[] = [];
      void (async () => {
        for (;;) {
          const command = await runtime.nextCommand();
          if (command.type !== "cdp.command") {
            forwarded.push(command);
            continue;
          }
          const method = (command.command as { method?: string } | undefined)?.method;
          runtime.sendServer({
            requestId: command.requestId,
            result:
              method === "Target.getTargets"
                ? { targetInfos: [{ targetId: "target-integration", type: "page" }] }
                : method === "Target.attachToTarget"
                  ? { sessionId: "cdp-integration" }
                  : {},
            type: "cdp.result",
          });
        }
      })();
      await browserAvailable(stack);
      const sessionId = await startPersonBrowser(stack, { viewport: startView });
      const ticketViewport = runtime.lastClaims()?.viewport ?? null;
      const control = await openBrowserView(stack, sessionId, "control");
      addCleanup("control viewer", async () => control.socket.terminate());
      const surfaceId = control.activeSurfaceId;
      const snapshotDialog = control.snapshot.dialog;
      expect(snapshotDialog).toMatchObject(releasedDialog);
      expect(snapshotDialog?.id).toMatch(/^[0-9a-f-]{36}$/);
      const late = await openBrowserView(stack, sessionId, "control");
      addCleanup("late viewer", async () => late.socket.terminate());
      expect(late.snapshot.dialog).toEqual(snapshotDialog);

      control.socket.send(
        JSON.stringify({ height: 700, surfaceId, type: "viewport.follow", width: 1_000 }),
      );
      control.socket.send(
        JSON.stringify({ type: "surface.open", url: "https://example.com/", viewport: startView }),
      );
      control.socket.send(
        JSON.stringify({ height: 650, surfaceId, type: "viewport.set", width: 900 }),
      );

      const changed = nextJson(control.socket, "browser.dialog.changed");
      runtime.sendServer({
        dialog: { ...releasedDialog, ...(sharedControl ? { id: randomUUID() } : {}) },
        type: "browser.dialog.changed",
      });
      const dialogEvent = BrowserServerMessageSchema.parse(await changed);
      if (dialogEvent.type !== "browser.dialog.changed" || !dialogEvent.dialog) {
        throw new Error("The browser sent no active dialog.");
      }
      const dialogId = dialogEvent.dialog.id;
      expect(dialogId).not.toBe(snapshotDialog?.id);
      const refusals: { code: number; reason: string }[] = [];
      if (!sharedControl) {
        const staleClosed = waitForBrowserClosing(late.socket);
        late.socket.send(
          JSON.stringify({ accept: true, dialogId: snapshotDialog!.id, type: "dialog.respond" }),
        );
        refusals.push(await staleClosed);
      }
      control.socket.send(JSON.stringify({ accept: true, dialogId, type: "dialog.respond" }));
      control.socket.send(JSON.stringify({ type: "navigation.reload" }));
      await waitFor(
        async () => forwarded.some((command) => command.type === "navigation.reload"),
        10_000,
      );
      if (!sharedControl) {
        const duplicate = await openBrowserView(stack, sessionId, "control");
        addCleanup("duplicate viewer", async () => duplicate.socket.terminate());
        const duplicateClosed = waitForBrowserClosing(duplicate.socket);
        duplicate.socket.send(JSON.stringify({ accept: false, dialogId, type: "dialog.respond" }));
        refusals.push(await duplicateClosed);
        const closed = nextJson(control.socket, "browser.dialog.changed");
        runtime.sendServer({ dialog: null, type: "browser.dialog.changed" });
        expect(await closed).toEqual({ dialog: null, type: "browser.dialog.changed" });
        const afterClose = await openBrowserView(stack, sessionId, "control");
        addCleanup("closed-session viewer", async () => afterClose.socket.terminate());
        expect(afterClose.snapshot.dialog).toBeNull();
        const afterCloseRefused = waitForBrowserClosing(afterClose.socket);
        afterClose.socket.send(JSON.stringify({ accept: true, dialogId, type: "dialog.respond" }));
        refusals.push(await afterCloseRefused);
        const reopened = nextJson(control.socket, "browser.dialog.changed");
        runtime.sendServer({ dialog: releasedDialog, type: "browser.dialog.changed" });
        const reopenedEvent = BrowserServerMessageSchema.parse(await reopened);
        if (reopenedEvent.type !== "browser.dialog.changed" || !reopenedEvent.dialog) {
          throw new Error("The browser did not reopen its dialog.");
        }
        expect(reopenedEvent.dialog.id).not.toBe(dialogId);
        expect(reopenedEvent.dialog.id).not.toBe(snapshotDialog?.id);
        expect(refusals).toEqual(
          Array.from({ length: 3 }, () => ({
            code: 4002,
            reason: "There is no active browser dialog.",
          })),
        );
      }
      expect(runtime.protocolErrors()).toEqual([]);
      expect(runtime.streamOpen()).toBe(true);
      expect(control.socket.readyState).toBe(WebSocket.OPEN);
      const bootstrap = await stack.api["bootstrap.get"]({});
      expect(
        bootstrap.ok && bootstrap.data.browser.sessions.find((s) => s.id === sessionId)?.state,
      ).toBe("ready");
      return {
        browserModule: runtime.browserModule(),
        dialogId,
        forwarded,
        protocolErrors: runtime.protocolErrors(),
        receivedCommands: runtime.receivedCommands(),
        refusals,
        snapshotDialog,
        streamOpen: runtime.streamOpen(),
        ticketViewport,
      };
    };
    const older = await journey(false);
    const current = await journey(true);
    expect(older.browserModule).toEqual({
      profileSnapshotVersion: 2,
      runtimeId: "browser-runtime-integration",
    });
    expect(older.ticketViewport).toBeNull();
    expect(older.forwarded).toEqual([
      { type: "surface.open", url: "https://example.com/" },
      { height: 650, type: "viewport.set", width: 900 },
      { accept: true, type: "dialog.respond" },
      { type: "navigation.reload" },
    ]);
    expect(current.ticketViewport).toEqual(startView);
    expect(current.forwarded).toEqual([
      { height: 700, surfaceId: "page-integration", type: "viewport.follow", width: 1_000 },
      { type: "surface.open", url: "https://example.com/", viewport: startView },
      { height: 650, surfaceId: "page-integration", type: "viewport.set", width: 900 },
      { accept: true, dialogId: current.dialogId, type: "dialog.respond" },
      { type: "navigation.reload" },
    ]);
    await writeViewReport("older-runtime", { startView, older, current });
  }, 120_000);

  it("requires dialog ids from a computer advertising shared control", async () => {
    const stack = await deployment(undefined);
    const enrollment = await stack.api["commands.dispatch"]({
      allowedModules: ["browser"],
      idempotencyKey: randomUUID(),
      name: "Malformed current browser",
      type: "runner.enrollment.createLocal",
    });
    if (!enrollment.ok || enrollment.data.type !== "runner.enrollment.createLocal") {
      throw new Error("Could not enroll the browser computer");
    }
    const runtime = await startBrowserRuntime(
      Number(stack.hostOrigin.port),
      enrollment.data.token,
      {
        agentReady: true,
        initialDialog: { message: "Continue?", surfaceId: "page-integration", type: "confirm" },
      },
    );
    addCleanup("protocol runtime", () => runtime.close());
    await browserAvailable(stack);
    await expect(
      startPersonBrowser(stack, { viewport: { height: 777, width: 1_111 } }),
    ).rejects.toThrow();
    expect(runtime.streamOpen()).toBe(true);
    await writeViewReport("current-runtime-requires-dialog-id", { refused: true });
  }, 60_000);
});

/**
 * One agent's work, as the skill and tools describe it: two sessions side by
 * side, the chat's photo uploaded, every mistake explained, a granted profile
 * signed in, and the sign-in still there after Chromium dies.
 */
async function agentJourney(
  stack: VerticalStack,
  label: string,
  crashChromium: () => void,
): Promise<void> {
  const page = await uploadPage();
  addCleanup("upload site", () => {
    // Chromium is still running when the page closes, and it can hold a
    // connection here that never carried a request. close() leaves such a
    // connection open and waits for it for as long as Chromium keeps it.
    page.closeAllConnections();
    return new Promise((resolve) => page.close(() => resolve(undefined)));
  });
  const pageOrigin = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
  await waitFor(async () => {
    const bootstrap = await stack.api["bootstrap.get"]({});
    return bootstrap.ok && bootstrap.data.browser.available;
  }, 30_000);

  const workspace = await stack.createWorkspace("Marketplace");
  const threadId = await stack.createThread({
    modelSelection: ModelSelectionSchema.parse({
      modelId: "gpt-5.6-sol",
      options: {},
      providerId: "openai",
    }),
    title: "List the mattress",
    workspaceId: workspace.id,
  });
  const profileId = await grantedProfile(stack, workspace.id);
  const photo = noisePng(900, 900);
  const attachment = await upload(stack, workspace.id, "mattress.png", "image/png", photo);

  const first = await stack.sendMessage({
    attachments: [
      {
        artifactId: attachment.id,
        mediaType: attachment.mediaType,
        name: attachment.name,
        sizeBytes: attachment.sizeBytes,
        type: "artifact" as const,
      },
    ],
    text: `List this mattress. UPLOAD_PAGE=${pageOrigin}/upload PROFILE_ID=${profileId}`,
    threadId,
    workspaceId: workspace.id,
  });
  const report = JSON.parse(first.assistantText) as AgentReport;
  if ("error" in report) throw new Error(report.error);

  // Two sessions, both held by the Run, each driven by its own ID.
  const [sessionA, sessionB] = report.opened;
  expect(sessionA).not.toBe(sessionB);
  expect(report.listed).toEqual(
    expect.arrayContaining([
      { attached: true, id: sessionA },
      { attached: true, id: sessionB },
    ]),
  );
  // The chat's photo reaches the page under its own name and type, byte for byte.
  expect(report.photoName).toBe("mattress.png");
  const expectedPhoto = { name: "mattress.png", size: photo.byteLength, type: "image/png" };
  expect(report.upload.direct).toEqual({ files: [expectedPhoto] });
  expect(report.upload.chooser).toEqual({ files: [expectedPhoto] });
  for (const key of ["single", "hidden"] as const) {
    expect(report.upload.received[key]).toEqual({
      files: [{ name: "mattress.png", sha256: sha256(photo), size: photo.byteLength }],
      trusted: true,
    });
  }
  expect(report.second).toMatchObject({ url: `${pageOrigin}/upload?second` });
  expect(report.backToFirst).toEqual({
    received: ["single", "hidden"],
    url: `${pageOrigin}/upload`,
  });
  // One tab carries the visits: the session's own page, navigated in place.
  const { browsing } = report;
  expect(browsing.start).toMatchObject({ tabs: 1, url: `${pageOrigin}/upload?first` });
  expect(browsing.inPlace).toMatchObject({ tabs: 1, url: `${pageOrigin}/upload?next` });
  // A tab that cannot open is never left behind, and the page in use stays in use.
  expect(browsing.failed).toMatchObject({
    failures: [
      { error: "Navigation requires an HTTP or HTTPS URL" },
      { error: expect.stringMatching(/^Could not open http:\/\/127\.0\.0\.1:1\/: net::ERR_/u) },
    ],
    tabs: 1,
    url: `${pageOrigin}/upload?next`,
  });
  // Past six tabs the agent hears once that it is collecting tabs; closing
  // what it opened leaves the session as it found it.
  expect(browsing.many).toMatchObject({ tabs: 1, whileMany: 8 });
  // Cmd+V crosses the Runner and Host to the session's router, which refuses
  // it however the agent presses it; the page receives neither key nor paste.
  expect(browsing.paste).toMatchObject({
    refusals: ["refused", "refused", "refused", "refused"],
    pastes: 0,
    typedOnly: true,
    vKeys: 0,
  });
  expect(
    browsing.many.stderr.match(/\[opensteer\] This Browser Session has \d+ tabs open/gu),
  ).toEqual(["[opensteer] This Browser Session has 7 tabs open"]);
  // Every mistake says what happened and what to do next.
  expect(report.withoutSession.stderr).toContain("--session <Browser Session ID>");
  expect(report.outsideFile.stderr).toContain("accepts only files staged for this Browser Session");
  expect(report.endedSession.stderr).toContain(`Browser Session ${sessionB} has ended`);
  expect(report.unknownSession.stderr).toContain("was not found");
  expect(report.accessAlreadyAvailable.error).toContain(
    `This Workspace can already use browser profile ${profileId}`,
  );
  expect(report.signedIn).toMatchObject({
    stdout: expect.stringContaining("marketplace_session=signed-in"),
  });

  // The profile saves while in use; Chromium dying afterwards loses nothing.
  // The next session launches a new Chromium from the Host's saved copy.
  await waitFor(async () => (await profileRevision(stack, profileId)) > 0, 20_000);
  const savedRevision = await profileRevision(stack, profileId);
  const watch =
    label === "relayed" ? await watchBrowserSession(stack, report.profileSession) : null;
  if (watch && process.env.OPENSTEER_BROWSER_WATCH_CHROMIUM_ARTIFACT_PATH) {
    await writeFile(
      process.env.OPENSTEER_BROWSER_WATCH_CHROMIUM_ARTIFACT_PATH,
      `${JSON.stringify(watch, null, 2)}\n`,
    );
  }
  crashChromium();
  await waitFor(async () => {
    const bootstrap = await stack.api["bootstrap.get"]({});
    return (
      bootstrap.ok &&
      bootstrap.data.browser.sessions.every(
        (session) => session.id !== report.profileSession || session.state !== "ready",
      )
    );
  }, 20_000);
  const later = await stack.sendMessage({
    text: `Check the account. UPLOAD_PAGE=${pageOrigin}/upload CHECK_PROFILE=${profileId}`,
    threadId,
    workspaceId: workspace.id,
  });
  const check = JSON.parse(later.assistantText) as { cookie: string };
  expect(check.cookie).toContain("marketplace_session=signed-in");

  const reportPath = path.join(
    tmpdir(),
    `opensteer-browser-sessions-e2e-${label}-${Date.now()}.json`,
  );
  await writeFile(
    reportPath,
    `${JSON.stringify({ afterCrash: check, report, savedRevision, watch }, null, 2)}\n`,
  );
  process.stdout.write(`browser sessions E2E report (${label}): ${reportPath}\n`);
}

async function watchBrowserSession(
  stack: VerticalStack,
  sessionId: string,
): Promise<{
  readonly firstFrameId: number;
  readonly creditedFrameId: number;
  readonly frameIdAfterNavigation: number;
  readonly jpegBytes: number;
  readonly viewportWidth: number;
  readonly viewportMutationCloseCode: number;
  readonly pointerMutationCloseCode: number;
  readonly noAckCloseCode: number;
  readonly noAckElapsedMs: number;
  readonly controlFrameIdAfterWatchClose: number;
}> {
  const sockets: WebSocket[] = [];
  const open = async (mode: "control" | "watch") => {
    const url = new URL(`/v1/browser-sessions/${sessionId}/connect`, stack.hostOrigin);
    if (mode === "watch") url.searchParams.set("mode", "watch");
    const socket = new WebSocket(url, {
      headers: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
    });
    sockets.push(socket);
    await waitForBrowserSnapshot(socket);
    return socket;
  };
  try {
    const watch = await open("watch");
    const firstFrame = waitForBrowserFrame(watch);
    watch.send(JSON.stringify({ type: "stream.subscribe" }));
    const first = await firstFrame;
    expect(first.header.watchToken).toBeDefined();
    expect(first.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(first.jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    watch.send(JSON.stringify({ type: "stream.ack", token: first.header.watchToken }));

    const viewportAttempt = await open("watch");
    const viewportClose = waitForBrowserClose(viewportAttempt);
    viewportAttempt.send(
      JSON.stringify({
        height: first.header.viewportHeight + 1,
        surfaceId: first.header.surfaceId,
        type: "viewport.set",
        width: first.header.viewportWidth + 1,
      }),
    );
    const viewportMutationCloseCode = await viewportClose;
    expect(viewportMutationCloseCode).toBe(4002);

    const pointerAttempt = await open("watch");
    const pointerClose = waitForBrowserClose(pointerAttempt);
    pointerAttempt.send(
      JSON.stringify({
        action: "down",
        button: "left",
        surfaceId: first.header.surfaceId,
        type: "input.pointer",
        viewportHeight: first.header.viewportHeight,
        viewportWidth: first.header.viewportWidth,
        x: 0.5,
        y: 0.5,
      }),
    );
    const pointerMutationCloseCode = await pointerClose;
    expect(pointerMutationCloseCode).toBe(4002);

    const control = await open("control");
    const creditedFrame = waitForBrowserFrame(watch);
    control.send(JSON.stringify({ type: "navigation.reload" }));
    const second = await creditedFrame;
    expect(second.header.frameId).toBeGreaterThan(first.header.frameId);
    expect(second.header.viewportWidth).toBe(first.header.viewportWidth);
    expect(second.header.viewportHeight).toBe(first.header.viewportHeight);
    // The page navigates while that picture is still unacknowledged: its new
    // title and address are the same tab, so the acknowledgement still counts
    // and Watch carries on.
    control.send(JSON.stringify({ type: "navigation.reload" }));
    await new Promise((resolve) => setTimeout(resolve, 750));
    const afterNavigation = waitForBrowserFrame(watch);
    watch.send(JSON.stringify({ type: "stream.ack", token: second.header.watchToken }));
    const third = await afterNavigation;
    expect(third.header.frameId).toBeGreaterThan(second.header.frameId);
    expect(watch.readyState).toBe(WebSocket.OPEN);
    watch.close(1000, "Viewer done");
    await waitForBrowserClose(watch);

    const uncredited = await open("watch");
    const noAckFrame = waitForBrowserFrame(uncredited);
    const noAckClose = waitForBrowserClose(uncredited, 25_000);
    uncredited.send(JSON.stringify({ type: "stream.subscribe" }));
    const pending = await noAckFrame;
    expect(pending.header.watchToken).toBeDefined();
    const noAckStartedAt = Date.now();
    const noAckCloseCode = await noAckClose;
    const noAckElapsedMs = Date.now() - noAckStartedAt;
    expect(noAckCloseCode).toBe(1013);
    expect(noAckElapsedMs).toBeGreaterThanOrEqual(13_000);
    expect(noAckElapsedMs).toBeLessThan(25_000);

    const controlFrame = waitForBrowserFrame(control);
    control.send(JSON.stringify({ type: "stream.subscribe" }));
    const usable = await controlFrame;
    expect(usable.header.frameId).toBeGreaterThan(second.header.frameId);
    const result = {
      controlFrameIdAfterWatchClose: usable.header.frameId,
      creditedFrameId: second.header.frameId,
      firstFrameId: first.header.frameId,
      frameIdAfterNavigation: third.header.frameId,
      jpegBytes: first.jpeg.byteLength,
      noAckCloseCode,
      noAckElapsedMs,
      pointerMutationCloseCode,
      viewportMutationCloseCode,
      viewportWidth: first.header.viewportWidth,
    };
    control.send(JSON.stringify({ type: "stream.unsubscribe" }));
    control.close(1000, "Viewer done");
    await waitForBrowserClose(control);
    return result;
  } finally {
    for (const socket of sockets) socket.terminate();
  }
}

function waitForBrowserSnapshot(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Browser snapshot timed out."));
    }, 10_000);
    const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString()) as { type: string };
      if (message.type !== "browser.snapshot") return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve();
    };
    socket.on("message", onMessage);
  });
}

function waitForBrowserFrame(
  socket: WebSocket,
  accept = false,
): Promise<{
  readonly header: ReturnType<typeof decodeBrowserFrameEnvelope>["header"];
  readonly jpeg: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Browser JPEG frame timed out."));
    }, 20_000);
    const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      const envelope = decodeBrowserFrameEnvelope(
        Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer),
      );
      if (accept && envelope.header.watchToken)
        socket.send(JSON.stringify({ type: "stream.ack", token: envelope.header.watchToken }));
      resolve({ header: envelope.header, jpeg: Buffer.from(envelope.data) });
    };
    socket.on("message", onMessage);
  });
}

function waitForBrowserClose(socket: WebSocket, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve(1000);
    const timeout = setTimeout(() => {
      socket.off("close", onClose);
      reject(new Error("Browser viewer close timed out."));
    }, timeoutMs);
    const onClose = (code: number) => {
      clearTimeout(timeout);
      resolve(code);
    };
    socket.once("close", onClose);
  });
}

/** Waits until the deployment offers a browser. */
/** A person starts a fresh browser from a view of `viewport`'s size. */
async function startPersonBrowser(
  stack: VerticalStack,
  input: {
    readonly initialUrl?: string;
    readonly viewport: { readonly height: number; readonly width: number };
  },
): Promise<string> {
  const started = await stack.api["commands.dispatch"]({
    idempotencyKey: randomUUID(),
    input: { fresh: true, reuseExisting: false, ...input },
    type: "browser.session.start",
    workspaceId: stack.mainWorkspaceId,
  });
  if (!started.ok) throw new Error(started.error.message);
  if (started.data.type !== "browser.session.start") throw new Error("Session command mismatch.");
  return started.data.session.id;
}

/** Opens a viewer on a session and answers it with the page the session shows. */
async function openBrowserView(
  stack: VerticalStack,
  sessionId: string,
  mode: "control" | "watch",
): Promise<{
  readonly activeSurfaceId: string;
  readonly snapshot: Extract<BrowserServerMessage, { type: "browser.snapshot" }>;
  readonly socket: WebSocket;
}> {
  const url = new URL(`/v1/browser-sessions/${sessionId}/connect`, stack.hostOrigin);
  if (mode === "watch") url.searchParams.set("mode", "watch");
  const socket = new WebSocket(url, {
    headers: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
  });
  const snapshot = await new Promise<Extract<BrowserServerMessage, { type: "browser.snapshot" }>>(
    (resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Browser snapshot timed out.")), 10_000);
      const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return;
        const message = BrowserServerMessageSchema.parse(JSON.parse(raw.toString()));
        if (message.type !== "browser.snapshot") return;
        clearTimeout(timeout);
        socket.off("message", onMessage);
        const active = message.surfaces?.find((surface) => surface.active);
        if (active) resolve(message);
        else reject(new Error("The session shows no page."));
      };
      socket.on("message", onMessage);
    },
  );
  if (mode === "control")
    socket.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const { header } = decodeBrowserFrameEnvelope(
        Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer),
      );
      if (header.watchToken)
        socket.send(JSON.stringify({ type: "stream.ack", token: header.watchToken }));
    });
  return {
    activeSurfaceId: snapshot.surfaces.find((surface) => surface.active)!.id,
    snapshot,
    socket,
  };
}

/** The next frame whose page is `size`. */
async function waitForBrowserFrameAt(
  socket: WebSocket,
  size: { readonly height: number; readonly width: number },
): Promise<Awaited<ReturnType<typeof waitForBrowserFrame>>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const frame = await waitForBrowserFrame(socket);
    if (frame.header.viewportWidth === size.width && frame.header.viewportHeight === size.height) {
      return frame;
    }
    if (Date.now() > deadline) throw new Error("No frame arrived at the followed size.");
  }
}

function waitForBrowserClosing(
  socket: WebSocket,
): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Browser viewer close timed out.")), 10_000);
    socket.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** A page that reports its size when it loads and whenever it is resized. */
async function sizeReportingSite(): Promise<{
  readonly origin: string;
  readonly seen: { readonly at: string; readonly height: number; readonly width: number }[];
  close(): Promise<void>;
}> {
  const seen: { at: string; height: number; width: number }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/seen") {
      seen.push({
        at: url.searchParams.get("at") ?? "",
        height: Number(url.searchParams.get("h")),
        width: Number(url.searchParams.get("w")),
      });
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>Sized page</title>
<style>html,body{margin:0}</style><p id="state">Sized page</p>
<script>
const report = (at) => fetch("/seen?at=" + at + "&w=" + innerWidth + "&h=" + innerHeight);
report("load");
addEventListener("resize", () => report("resize"));
</script>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
  };
}

/**
 * Pages for a tab's loading: /slow sends its start and never finishes, /frame-host
 * finishes and then adds a frame at /slow-frame that never finishes, /empty
 * answers 204. `finished` lists the pages the server completed.
 */
async function loadingSite(): Promise<{
  readonly origin: string;
  readonly requests: string[];
  readonly finished: string[];
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const finished: string[] = [];
  const held = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    requests.push(path);
    if (path === "/slow" || path === "/slow-frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.write(
        `<!doctype html><meta charset="utf-8"><title>${path === "/slow" ? "Still loading" : "A frame"}</title><p>The start of a page`,
      );
      held.add(response);
      response.on("close", () => held.delete(response));
      return;
    }
    if (path === "/empty") {
      response.writeHead(204).end();
      finished.push(path);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>Frame host</title><p>Done
<script>
addEventListener("load", () => setTimeout(() => {
  const frame = document.createElement("iframe");
  frame.src = "/slow-frame";
  document.body.append(frame);
}, 200));
</script>`);
    finished.push(path);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    close: async () => {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    finished,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
  };
}

/**
 * An opener whose page-wide button opens a popup, a confirm() and then an
 * alert() one; each popup's first script asks before the popup draws. A page
 * at /asks confirms when its page-wide button is clicked. Every page reports
 * the answer it got.
 */
async function popupDialogSite(waitForAsks?: Promise<void>): Promise<{
  readonly origin: string;
  readonly seen: string[];
  close(): Promise<void>;
}> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/seen") {
      seen.push(url.searchParams.get("at") ?? "");
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/asks") {
      const answer = () =>
        response.end(`<!doctype html><meta charset="utf-8"><title>Asks</title>
<style>html,body{margin:0}#ask{position:fixed;inset:0;width:100%;height:100%;border:0;background:#9cf}</style>
<button id="ask">Ask</button>
<script>
document.getElementById("ask").addEventListener("click", () => setTimeout(() => {
  const answer = confirm("Waiting on you");
  fetch("/seen?at=asked:" + answer);
}, 0));
fetch("/seen?at=asks-load");
</script>`);
      if (waitForAsks) void waitForAsks.then(answer);
      else answer();
      return;
    }
    if (url.pathname === "/popup") {
      const kind = url.searchParams.get("kind") === "alert" ? "alert" : "confirm";
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Immediate ${kind}</title>
<script>const answer = ${kind}("Immediate popup"); fetch("/seen?at=" + encodeURIComponent("popup-answered:${kind}:" + answer));</script>
</head><body style="margin:0;background:#aee"><p>Popup ${kind}</p></body></html>`);
      return;
    }
    response.end(`<!doctype html><meta charset="utf-8"><title>Opener</title>
<style>html,body{margin:0}#open{position:fixed;inset:0;width:100%;height:100%;border:0;background:#fe8}</style>
<button id="open">Open a popup</button>
<script>
let opened = 0;
document.getElementById("open").addEventListener("click", () => {
  window.open("/popup?kind=" + (opened++ === 0 ? "confirm" : "alert"), "_blank");
});
fetch("/seen?at=opener-load");
</script>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
  };
}

type ViewerEntry =
  | { readonly at: number; readonly kind: "message"; readonly message: BrowserServerMessage }
  | {
      readonly at: number;
      readonly decoded: { readonly height: number; readonly width: number } | null;
      readonly header: ReturnType<typeof decodeBrowserFrameEnvelope>["header"];
      readonly jpeg: Buffer;
      readonly kind: "frame";
    };

/** Everything a viewer's socket receives, in order, and how it closed. */
function recordBrowserView(socket: WebSocket): {
  readonly entries: ViewerEntry[];
  closed(): { readonly code: number; readonly reason: string } | null;
} {
  const entries: ViewerEntry[] = [];
  let closed: { readonly code: number; readonly reason: string } | null = null;
  socket.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
    const at = performance.now();
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (!isBinary) {
      const message = BrowserServerMessageSchema.parse(JSON.parse(bytes.toString()));
      entries.push({ at, kind: "message", message });
      return;
    }
    const envelope = decodeBrowserFrameEnvelope(bytes);
    const jpeg = Buffer.from(envelope.data);
    const decoded = readImageDimensions(jpeg, "jpeg");
    entries.push({ at, decoded, header: envelope.header, jpeg, kind: "frame" });
    if (envelope.header.watchToken)
      socket.send(JSON.stringify({ type: "stream.ack", token: envelope.header.watchToken }));
  });
  socket.once("close", (code: number, reason: Buffer) => {
    closed = { code, reason: reason.toString() };
  });
  return { closed: () => closed, entries };
}

/** One line of a viewer's record, naming pages by the role they play. */
function describeViewerEntry(entry: ViewerEntry, names: Record<string, string>): string {
  const name = (surfaceId: string) => names[surfaceId] ?? surfaceId;
  if (entry.kind === "frame") {
    return `frame ${name(entry.header.surfaceId)} ${entry.header.viewportWidth}x${entry.header.viewportHeight}`;
  }
  const { message } = entry;
  if (message.type === "browser.surfaces.changed") {
    return `${message.type} [${message.surfaces.map((surface) => `${name(surface.id)}${surface.active ? "*" : ""}`).join(", ")}]`;
  }
  if (message.type === "browser.dialog.changed") {
    return `${message.type} ${message.dialog ? `${name(message.dialog.surfaceId)} ${message.dialog.type}` : "none"}`;
  }
  return message.type;
}

async function writeViewReport(
  label: string,
  report: Record<string, unknown>,
  passed = true,
): Promise<void> {
  const directory =
    process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), "opensteer-browser-follow-e2e");
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, `deployment-${label}.json`);
  await writeFile(
    reportPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report, passed }, null, 2)}\n`,
  );
  process.stdout.write(`browser follow-view report (${label}): ${reportPath}\n`);
}

interface HarnessResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface DialogRun {
  readonly code: number;
  readonly exitMs?: number;
  readonly runMs: number;
  readonly stderr: string;
}

interface DialogAct extends DialogRun {
  readonly actMs?: number;
  readonly dialogId?: string;
  readonly outcome?: string;
}

interface DialogAnswer extends DialogRun {
  readonly answerMs?: number;
  readonly answers?: boolean[];
  readonly inputs?: number;
}

interface DialogReport {
  readonly answeredLater: DialogAnswer & { readonly openId?: string };
  readonly leftOpen: DialogAct;
  readonly replacement: DialogAct &
    DialogAnswer & {
      readonly replacementId?: string;
      readonly stale?: string;
      readonly stillOpen?: string;
    };
  readonly sameProgram: DialogAct & DialogAnswer;
}

type AgentReport =
  | { readonly error: string }
  | {
      readonly accessAlreadyAvailable: { readonly error?: string };
      readonly backToFirst: { readonly received: string[]; readonly url: string };
      readonly browsing: {
        readonly failed: {
          readonly failures: unknown[];
          readonly tabs: number;
          readonly url: string;
        };
        readonly inPlace: { readonly tabs: number; readonly url: string };
        readonly many: {
          readonly stderr: string;
          readonly tabs: number;
          readonly whileMany: number;
        };
        readonly paste: {
          readonly pastes: number;
          readonly refusals: string[];
          readonly typedOnly: boolean;
          readonly vKeys: number;
        };
        readonly start: { readonly tabs: number; readonly url: string };
      };
      readonly endedSession: HarnessResult;
      readonly listed: { readonly attached: boolean; readonly id: string }[];
      readonly opened: [string, string];
      readonly outsideFile: HarnessResult;
      readonly photoName: string;
      readonly profileSession: string;
      readonly second: { readonly url: string };
      readonly signedIn: HarnessResult;
      readonly unknownSession: HarnessResult;
      readonly upload: {
        readonly chooser: unknown;
        readonly direct: unknown;
        readonly received: Record<"hidden" | "single", unknown>;
      };
      readonly withoutSession: HarnessResult;
    };

/**
 * The shipped browser service, as a process of its own that enrolls with the
 * Deployment's configured token and relays to the Host itself — the Compose
 * and managed-cloud arrangement.
 */
async function startBrowserService(
  stack: VerticalStack,
  enrollmentToken: string,
): Promise<{ readonly pid: number }> {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-browser-service-e2e-"));
  addCleanup("browser service files", () => rm(root, { force: true, recursive: true }));
  const child = spawn(process.execPath, ["--import", "tsx", browserServiceMain], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      OPENSTEER_BROWSER_BRIDGE_TOKEN: randomBytes(32).toString("base64url"),
      OPENSTEER_BROWSER_CHECKPOINT_INTERVAL_MS: "1000",
      OPENSTEER_BROWSER_HEADLESS: "true",
      OPENSTEER_BROWSER_PORT: "0",
      OPENSTEER_BROWSER_PROFILE_ROOT: path.join(root, "profiles"),
      OPENSTEER_BROWSER_RELAY_HOST_URL: stack.hostOrigin.origin,
      OPENSTEER_BROWSER_RUNTIME_DATA_DIR: path.join(root, "runner"),
      OPENSTEER_BROWSER_RUNTIME_ID: "browser-service-e2e",
      OPENSTEER_CHROMIUM_EXECUTABLE: executablePath!,
      OPENSTEER_MODE: "development",
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: enrollmentToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  // A container stop is a SIGTERM: the service saves its profiles and exits.
  addCleanup("browser service process", async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    try {
      const [code] = await withTimeout(exited, 20_000, {
        timeoutError: () => new Error(`The browser service did not stop: ${output.join("")}`),
      });
      if (code !== 0) {
        throw new Error(
          `The browser service did not stop cleanly (${String(code)}): ${output.join("")}`,
        );
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`The browser service exited: ${output.join("")}`);
    return output.join("").includes("browser-runtime.ready");
  }, 30_000);
  if (!child.pid) throw new Error("The browser service has no process ID");
  return { pid: child.pid };
}

async function upload(
  stack: VerticalStack,
  workspaceId: WorkspaceId,
  name: string,
  mediaType: string,
  bytes: Buffer,
) {
  const reservation = await stack.api["commands.dispatch"]({
    idempotencyKey: randomUUID(),
    mediaType,
    name,
    sizeBytes: bytes.length,
    type: "attachment.upload.create",
    workspaceId,
  });
  if (!reservation.ok || reservation.data.type !== "attachment.upload.create") {
    throw new Error("Could not reserve the attachment");
  }
  const uploaded = await stack.api["attachment.upload"](
    { attachmentId: reservation.data.attachment.id },
    { body: new Blob([Uint8Array.from(bytes)]) },
  );
  if (!uploaded.ok) throw new Error(uploaded.error.message);
  return uploaded.data;
}

/** A real, incompressible PNG about the size of a phone photo. */
function noisePng(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const start = row * (width * 3 + 1);
    rows[start] = 0;
    randomBytes(width * 3).copy(rows, start + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.byteLength);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function uploadPage(): Promise<Server> {
  const html = `<!doctype html><meta charset="utf-8"><title>Marketplace listing</title>
<input id="single" type="file" accept="image/*">
<input id="hidden" type="file" accept="image/*" style="display:none">
<button id="choose" style="position:absolute;left:20px;top:120px;width:200px;height:40px">Add photos</button>
<script>
window.received = {};
async function digest(file) {
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return { name: file.name, sha256: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""), size: file.size };
}
for (const id of ["single", "hidden"]) {
  document.getElementById(id).addEventListener("change", async (event) => {
    window.received[id] = { files: await Promise.all([...event.target.files].map(digest)), trusted: event.isTrusted };
  });
}
document.getElementById("choose").addEventListener("click", () => document.getElementById("hidden").click());
</script>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
