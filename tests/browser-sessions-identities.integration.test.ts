import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { injectRpcRequest } from "../apps/host/src/server/test-host-api-request.js";
import { type LaunchedBrowser } from "../packages/browser-runtime-core/src/index.js";
import { createId } from "../packages/core/src/index.js";
import { createBrowserSessionId } from "../packages/protocol/src/browser.js";
import {
  addCleanup,
  browserAvailable,
  deployment,
  run,
  startBrowser,
} from "./browser-deployment.test-support.js";
import { loadingSite } from "./browser-sessions.test-support.js";

run("Browser Sessions through a whole deployment", () => {
  it("opens personal identities atomically and replays durable page outcomes without spare tabs", async () => {
    const launchedBrowsers: { browser: LaunchedBrowser; native: boolean }[] = [];
    const browser = await startBrowser({
      onLaunch: (browser, request) =>
        launchedBrowsers.push({ browser, native: request.storage.kind === "local" }),
    });
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
    // Native profiles use Chromium's default context; Guest has its own disposable context.
    expect(launchedBrowsers.filter(({ native }) => native)).toHaveLength(1);
    for (const { browser: launched, native } of launchedBrowsers) {
      const contexts = (await launched.cdp.send("Target.getBrowserContexts")) as {
        browserContextIds: string[];
      };
      expect(contexts.browserContextIds).toHaveLength(native ? 0 : 1);
      if (!native) expect(contexts.browserContextIds[0]).toEqual(expect.any(String));
    }
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
    });
    await stack.host.store.transitionBrowserSession({ sessionId: detached.id, state: "ready" });
    const detachedReply = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      sessionId: detached.id,
      idempotencyKey: randomUUID(),
    });
    expect(detachedReply).toMatchObject({
      ok: false,
      error: { reason: "browser-tab-open-failed", retryable: false },
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
      error: { reason: "browser-tab-open-failed" },
    });
    expect(
      await stack.host.store.getBrowserTabOpen(owner.id, starting.idempotencyKey),
    ).toMatchObject({ outcome: { kind: "failed" } });
    const initialCatalog = await stack.api["browser.tabs.get"]({
      sessionId: initialBinding.chosenSessionId,
    });
    expect(initialCatalog).toMatchObject({ ok: false });
    expect(
      await stack.host.store.getBrowserSessionForOwner(initialBinding.chosenSessionId, owner.id),
    ).toMatchObject({ state: "failed" });
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
      error: { reason: "browser-tab-open-failed" },
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
});
