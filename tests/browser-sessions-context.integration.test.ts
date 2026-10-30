import { ManualClock } from "@opensteer/shared/test-support/clock";
import {
  ignoreForeignTestRequest,
  probeTestServer,
} from "@opensteer/shared/test-support/serverProbes";
import {
  run,
  addCleanup,
  deployment,
  browserAvailable,
  browserHarness,
  startBrowser,
  waitFor,
} from "./browser-deployment.test-support.js";
import { testRpcRequest } from "../apps/host/src/server/test-host-api-request.js";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { ModelSelectionSchema } from "../packages/core/src/index.js";
import {
  BrowserSessionIdSchema,
  type BrowserTabOpenResult,
} from "../packages/protocol/src/browser.js";
import {
  HttpHostClient,
  type WebSocketClient,
} from "../packages/client/src/host/host-session-client.js";
import type { BrowserSessionSummary } from "../packages/client/src/host/client.js";
import { hostApi } from "../packages/protocol/src/host-api.js";
import { runPages } from "../packages/client/src/host/surfaces.js";
import { WebSocket } from "../apps/host/src/browser/browser-watch-e2e.test-support.js";
import {
  startPersonBrowser,
  openBrowserView,
  writeViewReport,
  type DialogReport,
  uploadPage,
} from "./browser-sessions.test-support.js";

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
      expect(answeredLater, trigger).toMatchObject({
        answers: [true],
        code: 0,
        inputs: 1,
        openId: leftOpen.dialogId,
      });
      expect(sameProgram, trigger).toMatchObject({
        answers: [true],
        code: 0,
        dialogId: expect.any(String),
        inputs: 1,
      });
      expect(sameProgram.outcome, trigger).toMatch(/^DialogOpenedError: /u);
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
});
