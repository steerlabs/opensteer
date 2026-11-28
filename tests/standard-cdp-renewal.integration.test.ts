import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { CdpAuthority } from "../apps/host/src/browser/standard-cdp-tickets.js";
import { NetworkPartition } from "../apps/host/src/agents/network-partition.test-support.js";
import { ownChild } from "../apps/host/src/agents/owned-child.test-support.js";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import {
  startPersonalRuntime,
  type PersonalRuntime,
} from "../apps/host/src/runtime/personal-startup.test-support.js";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
  defaultAttachTicketReplayLedgerPath,
  sessionFilesRoot,
} from "../packages/browser-runtime-core/src/index.js";
import { createId } from "../packages/core/src/index.js";
import { AgentConnectionStore } from "../packages/database/src/agent-connection-store.js";
import { beginAgentSession } from "../packages/database/src/agent-session-store.js";
import {
  listBrowserStandardCdpLeases,
  requireNoBrowserStandardCdpLease,
} from "../packages/database/src/browser-standard-cdp-lease.js";
import { connectionAttempts } from "../packages/database/src/connection-disconnect.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { machineAccessPolicyDefault } from "../packages/protocol/src/shell.js";
import { standardCdpSettledReason } from "../packages/protocol/src/standard-cdp.js";

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "keeps quiet CDP attachments and partially written results across a real Runner renewal",
  async () => {
    const { stack, clients } = await startBrowserHome();
    const store = stack.host.store;
    const owner = await store.firstUser();
    if (!owner) throw new Error("The Home has no owner.");
    await store.database
      .updateTable("devices")
      .set({ accessPolicy: { ...machineAccessPolicyDefault, browser: true } })
      .where("id", "=", await store.requireSelfDeviceId(stack.agentHome.computerId))
      .execute();
    const catalog = stack.initialCatalog;
    if (catalog.status !== "ready") throw new Error("The test engine is unavailable.");
    const model = catalog.models[0];
    if (!model) throw new Error("The test engine has no model.");
    const task = await stack.api["commands.dispatch"]({
      type: "thread.create",
      environmentId: stack.environmentId,
      harnessInstanceId: stack.harnessInstanceId,
      modelSelection: { modelId: model.modelId, providerId: model.providerId, options: {} },
      idempotencyKey: randomUUID(),
      title: "CDP renewal",
    });
    if (!task.ok || task.data.type !== "thread.create") throw new Error(JSON.stringify(task));
    const threadId = task.data.thread.id;
    const started = await stack.api["commands.dispatch"]({
      type: "thread.sendMessage",
      threadId,
      idempotencyKey: randomUUID(),
      content: [{ type: "text", text: "Keep the test Run active." }],
    });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const findRun = () =>
      store.database
        .selectFrom("runs")
        .select(["id", "status"])
        .where("threadId", "=", threadId)
        .executeTakeFirst();
    // A Run takes 0.6 to 2.3 s to start on a busy machine; the default poll gives up after one.
    await expect.poll(findRun, { timeout: 15_000 }).toMatchObject({ status: "running" });
    const run = await findRun();
    const authority = { agentBindingId: `run:${run!.id}`, ownerId: owner.id };

    const accepted: number[] = [];
    const rawGenerations: number[] = [];
    const firstChunk = Promise.withResolvers<void>();
    const renewed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let hold = false;
    const send = WebSocket.prototype.send;
    const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      data,
      options,
      callback,
    ) {
      if (!this.url?.endsWith("/internal/v1/runners/auxiliary/browser") || typeof data !== "string")
        return send.call(this, data, options, callback);
      const frame = JSON.parse(data);
      if (frame.type === "capability.accepted") {
        accepted.push(frame.capability.capabilityGeneration);
        if (accepted.length === 2) renewed.resolve();
      }
      if (
        hold &&
        frame.type === "browser.server-message" &&
        frame.message?.type === "cdp.raw" &&
        (!frame.message.last || rawGenerations.length > 0)
      ) {
        rawGenerations.push(frame.capability.capabilityGeneration);
        if (!frame.message.last && rawGenerations.length === 1) {
          // Put the first chunk on the real socket, then hold only its writer's completion.
          return send.call(this, data, options, (error) => {
            firstChunk.resolve();
            void resume.promise.then(() => callback?.(error));
          });
        }
      }
      return send.call(this, data, options, callback);
    });

    const scheduled = Promise.withResolvers<() => void>();
    const setTimer = globalThis.setTimeout;
    const timers = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        const timer = setTimer(callback, delay, ...args);
        if (new Error().stack?.includes("RunnerBrowserRuntimeRouter.#scheduleRenewal")) {
          scheduled.resolve(() => {
            clearTimeout(timer);
            callback(...args);
          });
        }
        return timer;
      });
    try {
      const session = (await stack.host.browser.openAgentSession({ ...authority, fresh: true }))
        .session;
      const connect = async () => {
        const ticket = await stack.host.browser.issueStandardCdpTicket({
          authority,
          browserSessionId: session.id,
          mode: "session",
        });
        const browser = await chromium.connectOverCDP(
          stack.hostOrigin.href.replace(/^http/u, "ws").replace(/\/$/u, "") + ticket.path,
          { noDefaults: true, timeout: 5_000 },
        );
        clients.push(browser);
        return browser.contexts()[0]!.pages()[0]!;
      };
      const quiet = await connect();
      const active = await connect();
      expect(accepted).toHaveLength(1);

      hold = true;
      const large = active.evaluate(() => "abcdefgh".repeat(256 * 1024));
      const outcome = Promise.allSettled([large]);
      await milestone(firstChunk.promise, "first response chunk", outcome);
      expect(rawGenerations).toEqual([accepted[0]]);

      // Trigger the production renewal timer while the first chunk is held.
      const renew = await scheduled.promise;
      renew();
      await milestone(renewed.promise, "renewal acknowledgement");
      resume.resolve();
      const [largeResult] = await outcome;
      hold = false;
      const quietResult = await Promise.allSettled([quiet.evaluate(() => 6 * 7)]);
      expect({ large: largeResult?.status, quiet: quietResult }).toEqual({
        large: "fulfilled",
        quiet: [{ status: "fulfilled", value: 42 }],
      });
      if (largeResult?.status !== "fulfilled") throw new Error("The large result did not finish.");
      expect(largeResult.value).toBe("abcdefgh".repeat(256 * 1024));
      expect(rawGenerations).toEqual(expect.arrayContaining([accepted[0], accepted[1]]));
    } finally {
      resume.resolve();
      timers.mockRestore();
      spy.mockRestore();
    }
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "keeps two connected-agent lineages out of Guest contexts",
  async () => {
    const { stack } = await startBrowserHome();
    const { browser, store } = stack.host;
    const owner = await store.firstUser();
    if (!owner) throw new Error("The Home has no owner.");
    const runnerId = stack.agentHome.computerId;
    await store.database
      .updateTable("devices")
      .set({ accessPolicy: { ...machineAccessPolicyDefault, browser: true } })
      .where("id", "=", await store.requireSelfDeviceId(runnerId))
      .execute();
    const profile = await browser.createProfile({
      homeRunnerId: runnerId,
      ownerId: owner.id,
      name: "Connected agent profile",
      idempotencyKey: randomUUID(),
    });
    const guest = await browser.start({ ownerId: owner.id, origin: "person", fresh: true });
    const connectionStore = new AgentConnectionStore(store.database);
    const catalog = stack.initialCatalog;
    if (catalog.status !== "ready" || !catalog.models[0]) throw new Error("No fixture model.");
    const { modelId, providerId } = catalog.models[0];
    for (const scope of ["everything", "selected"] as const) {
      const connection = await connectionStore.create({
        userId: owner.id,
        label: scope,
        clientName: scope,
        accessMode: "full-access",
        resource: stack.hostOrigin.href,
        expiresAt: new Date(Date.now() + 60_000),
        grant:
          scope === "selected"
            ? {
                scope,
                tasks: true,
                resources: [{ kind: "browser-profile", profileId: profile.id }],
              }
            : { scope },
      });
      expect(await connectionStore.activate(connection.id, randomBytes(32).toString("hex"))).toBe(
        true,
      );
      const task = await stack.api["commands.dispatch"]({
        type: "thread.create",
        environmentId: stack.environmentId,
        harnessInstanceId: stack.harnessInstanceId,
        modelSelection: { modelId, providerId, options: {} },
        idempotencyKey: randomUUID(),
        title: scope,
      });
      if (!task.ok || task.data.type !== "thread.create") throw new Error(JSON.stringify(task));
      const threadId = task.data.thread.id;
      await store.database
        .updateTable("threads")
        .set({ originConnectionId: connection.id, accessMode: "full-access" })
        .where("id", "=", threadId)
        .execute();
      const authority = { ownerId: owner.id, agentBindingId: `thread:${threadId}` };
      // The same connection can use its named profile.
      const allowed = await browser.openAgentSession({ ...authority, profileId: profile.id });
      expect(allowed.session.profileId).toBe(profile.id);
      await browser.stop(owner.id, allowed.session.id);
      await expect(browser.openAgentSession({ ...authority, fresh: true })).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(
        browser.openAgentSession({ ...authority, sessionId: guest.session.id }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(
      (await store.listBrowserSessions(owner.id)).filter(({ profileId }) => !profileId),
    ).toEqual([expect.objectContaining({ id: guest.session.id })]);
    await browser.stop(owner.id, guest.session.id);
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "refuses a stale whole-context ticket and fences a profile until a disconnected writer settles",
  async () => {
    const { stack, clients } = await startBrowserHome();
    const { browser, store } = stack.host;
    const owner = await store.firstUser();
    if (!owner) throw new Error("The Home has no owner.");
    const runnerId = stack.agentHome.computerId;
    await store.database
      .updateTable("devices")
      .set({ accessPolicy: { ...machineAccessPolicyDefault, browser: true } })
      .where("id", "=", await store.requireSelfDeviceId(runnerId))
      .execute();
    const left = { ownerId: owner.id, agentBindingId: `thread:${await createTask(stack, "Left")}` };
    const right = {
      ownerId: owner.id,
      agentBindingId: `thread:${await createTask(stack, "Right")}`,
    };
    const profile = await browser.createProfile({
      homeRunnerId: runnerId,
      ownerId: owner.id,
      name: "Whole-context fence",
      idempotencyKey: randomUUID(),
    });
    const { session } = await browser.openAgentSession({ ...left, profileId: profile.id });
    const issue = () =>
      browser.issueStandardCdpTicket({
        authority: left,
        browserSessionId: session.id,
        mode: "whole-context",
      });
    const url = (path: string) => new URL(path, stack.hostOrigin).href.replace(/^http/u, "ws");
    const stale = await issue();
    expect(stale.mode).toBe("whole-context");
    const competitor = await browser.start({
      ownerId: owner.id,
      origin: "person",
      profileId: profile.id,
      reuseExisting: false,
    });
    await expect(chromium.connectOverCDP(url(stale.path), { noDefaults: true })).rejects.toThrow(
      "Request a new attachment",
    );
    await browser.stop(owner.id, competitor.session.id);

    const ticket = await issue();
    expect(ticket.mode).toBe("whole-context");
    const settled = Promise.withResolvers<void>();
    const attach = browser.attachStandardCdpForAgent.bind(browser);
    const spy = vi
      .spyOn(browser, "attachStandardCdpForAgent")
      .mockImplementation(async (...args) => {
        const attached = await attach(...args);
        void attached.settled.then(settled.resolve);
        return attached;
      });
    const arriving = Promise.withResolvers<void>();
    const respond = Promise.withResolvers<void>();
    const site = createServer((request, response) => {
      if (request.url === "/hold") {
        arriving.resolve();
        void respond.promise.then(() => response.end("done"));
      } else response.end("<title>Lease fixture</title>");
    });
    try {
      const attempts = await Promise.allSettled([
        chromium.connectOverCDP(url(ticket.path)),
        chromium.connectOverCDP(url(ticket.path)),
      ]);
      const connected = attempts.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      clients.push(...connected);
      expect(connected).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected")).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ message: expect.stringContaining("401") }),
        }),
      ]);
      const client = connected[0]!;
      const page = client.contexts()[0]!.pages()[0]!;
      site.listen(0, "127.0.0.1");
      await once(site, "listening");
      await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}`);
      const pending = page
        .evaluate(() => fetch("/hold").then((res) => res.text()))
        .catch(() => undefined);
      await milestone(arriving.promise, "page's pending fetch");
      await client.close();
      await expect(browser.openAgentSession({ ...right, sessionId: session.id })).rejects.toThrow(
        "exclusive access",
      );
      await expect(
        store.attachBrowserSession({ ...right, sessionId: session.id }),
      ).rejects.toMatchObject({ reason: "browser-profile-exclusively-held" });
      await expect(
        browser.start({
          ownerId: owner.id,
          origin: "person",
          profileId: profile.id,
          reuseExisting: false,
        }),
      ).rejects.toThrow("exclusive access");
      respond.resolve();
      await milestone(settled.promise, "Runtime settlement");
      await pending;
      const reused = await browser.openAgentSession({ ...right, sessionId: session.id });
      expect(reused.session.id).toBe(session.id);
      expect(reused.session.state).toBe("ready");
      const persisted = await store.database
        .selectFrom("browserSessions")
        .select("standardCdpAttempts")
        .where("id", "=", session.id)
        .executeTakeFirstOrThrow();
      expect(persisted.standardCdpAttempts).toEqual({});
      await browser.stop(owner.id, session.id);
    } finally {
      respond.resolve();
      spy.mockRestore();
      if (site.listening) await new Promise<void>((resolve) => site.close(() => resolve()));
    }
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL).each(["same Runtime boot", "new Runtime boot"])(
  "reconciles an exclusive lease after connection loss with the %s",
  async (boot) => {
    const fixture = await startBrowserHome();
    const { stack, clients } = fixture;
    const { browser, store } = stack.host;
    const { network } = stack;
    if (!(network instanceof NetworkPartition))
      throw new Error("The real Runner needs a TCP partition.");
    const owner = await store.firstUser();
    if (!owner) throw new Error("The Home has no owner.");
    const runnerId = stack.agentHome.computerId;
    await store.database
      .updateTable("devices")
      .set({ accessPolicy: { ...machineAccessPolicyDefault, browser: true } })
      .where("id", "=", await store.requireSelfDeviceId(runnerId))
      .execute();
    const profile = await browser.createProfile({
      homeRunnerId: runnerId,
      ownerId: owner.id,
      name: "Reconnect fence",
      idempotencyKey: randomUUID(),
    });
    const connections = new AgentConnectionStore(store.database);
    const connection = await connections.create({
      userId: owner.id,
      label: "Reconnecting agent",
      clientName: "Reconnecting agent",
      accessMode: "full-access",
      resource: stack.hostOrigin.href,
      expiresAt: new Date(Date.now() + 60_000),
      grant: {
        scope: "selected",
        tasks: true,
        resources: [{ kind: "browser-profile", profileId: profile.id }],
      },
    });
    expect(await connections.activate(connection.id, randomBytes(32).toString("hex"))).toBe(true);
    const threadId = await createTask(stack, "Reconnect lease");
    await store.database
      .updateTable("threads")
      .set({ originConnectionId: connection.id, accessMode: "full-access" })
      .where("id", "=", threadId)
      .execute();
    const authority = { ownerId: owner.id, agentBindingId: `thread:${threadId}` };
    const actor = { kind: "browser-binding", authority, threadId } as const;
    const { tab } = await stack.host.tabs.open(
      actor,
      { kind: "page", profileId: profile.id, url: "about:blank" },
      randomUUID(),
    );
    const seed = await stack.host.tabs.bindBrowserScript(actor, tab.tabId);
    const ticket = await browser.issueStandardCdpTicket({
      authority,
      browserSessionId: seed.sessionId,
      seedTabId: seed.tabId,
      mode: "whole-context",
    });
    expect(ticket.mode).toBe("whole-context");
    const client = await chromium.connectOverCDP(
      new URL(ticket.path, stack.hostOrigin).href.replace(/^http/u, "ws"),
    );
    clients.push(client);
    expect(
      await client
        .contexts()[0]!
        .pages()[0]!
        .evaluate(() => 42),
    ).toBe(42);
    const leases = () => listBrowserStandardCdpLeases(store.database, runnerId);
    const [original] = await leases();
    const oldBoot = fixture.runtime.standardCdpBootId;
    expect(original).toMatchObject({
      sessionId: seed.sessionId,
      bootId: oldBoot,
      attemptId: expect.any(String),
    });
    const competingOpen = () =>
      browser.start({
        ownerId: owner.id,
        origin: "person",
        profileId: profile.id,
        reuseExisting: false,
      });

    const entered = Promise.withResolvers<string>();
    const acknowledge = Promise.withResolvers<void>();
    const reconciled = Promise.withResolvers<void>();
    const recover = browser.reconcileStandardCdpLeases.bind(browser);
    const home = vi
      .spyOn(browser, "reconcileStandardCdpLeases")
      .mockImplementation(async (computer, relay, settle) => {
        let acknowledged = false;
        await recover(computer, relay, async (lease) => {
          const runtimeBootId = await settle(lease);
          if (lease.generation === original?.generation) {
            entered.resolve(runtimeBootId);
            await acknowledge.promise;
            acknowledged = true;
          }
          return runtimeBootId;
        });
        if (acknowledged) reconciled.resolve();
      });
    const disconnected = new Promise<void>((resolve) =>
      client.once("disconnected", () => resolve()),
    );
    network.block();
    try {
      await milestone(disconnected, "client disconnect across the TCP partition");
      await expect(
        requireNoBrowserStandardCdpLease(store.database, profile.id),
      ).rejects.toMatchObject({
        reason: "browser-profile-exclusively-held",
      });
      expect(await leases()).toEqual([original]);
      if (boot === "new Runtime boot") await fixture.restartBrowserRuntime();
      network.unblock();
      await stack.restartRunner();
      await milestone(
        entered.promise.then(() => undefined),
        "Runtime generation acknowledgement over the new relay",
      );
      const currentBootId = await entered.promise;
      if (boot === "new Runtime boot") expect(currentBootId).not.toBe(oldBoot);
      else expect(currentBootId).toBe(oldBoot);
      expect(await leases()).toEqual([original]);
      await expect(competingOpen()).rejects.toThrow("exclusive access");
      acknowledge.resolve();
      await milestone(reconciled.promise, "Home to persist Runtime settlement");
      expect(await leases()).toEqual([]);
      const competing = await competingOpen();
      expect(competing.session).toMatchObject({
        profileId: profile.id,
        placement: { kind: "runner", runnerId },
        state: "ready",
      });

      await connections.revoke(owner.id, connection.id);
      const attempts = await connectionAttempts(store.database, connection.id);
      expect(attempts).toContainEqual(
        expect.objectContaining({
          kind: "standard-cdp",
          id: original!.attemptId,
          terminalEvidenceAt: expect.any(Date),
          ...(boot === "new Runtime boot" ? { contactLostAt: expect.any(Date) } : {}),
        }),
      );
      const cleanup = await store.driveConnectionCleanups();
      expect(cleanup.failures).toEqual([]);
      expect(cleanup.settled).toContain(connection.id);
      if (boot === "new Runtime boot") {
        const record = await store.database
          .selectFrom("agentConnections")
          .select(["lastActionUncertain", "lastActionUncertainAt"])
          .where("id", "=", connection.id)
          .executeTakeFirstOrThrow();
        expect(record).toMatchObject({
          lastActionUncertain: { attemptId: original!.attemptId },
          lastActionUncertainAt: expect.any(Date),
        });
      }
      await browser.stop(owner.id, competing.session.id);
    } finally {
      network.unblock();
      acknowledge.resolve();
      home.mockRestore();
    }
  },
);

it
  .skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)
  .each(["Home restart", "relay loss", "Runtime replacement"])(
  "Disconnect settles a confined CDP attempt after %s",
  async (failure) => {
    const fixture = await startBrowserHome();
    const { stack, clients, runtime } = fixture;
    const { browser, store } = stack.host;
    const { network } = stack;
    if (!(network instanceof NetworkPartition)) throw new Error("Expected a real relay socket.");
    const owner = await store.firstUser();
    if (!owner) throw new Error("The Home has no owner.");
    const runnerId = stack.agentHome.computerId;
    await store.database
      .updateTable("devices")
      .set({ accessPolicy: { ...machineAccessPolicyDefault, browser: true } })
      .where("id", "=", await store.requireSelfDeviceId(runnerId))
      .execute();
    const profile = await browser.createProfile({
      homeRunnerId: runnerId,
      ownerId: owner.id,
      name: "Confined CDP cleanup",
      idempotencyKey: randomUUID(),
    });
    const connections = new AgentConnectionStore(store.database);
    const connection = await connections.create({
      userId: owner.id,
      label: "Confined CDP agent",
      clientName: "Confined CDP agent",
      accessMode: "full-access",
      resource: stack.hostOrigin.href,
      expiresAt: new Date(Date.now() + 60_000),
      grant: { scope: "everything" },
    });
    expect(await connections.activate(connection.id, randomBytes(32).toString("hex"))).toBe(true);
    const { session } = await beginAgentSession(store.database, {
      userId: owner.id,
      agentConnectionId: connection.id,
    });
    const authority = { ownerId: owner.id, agentBindingId: `session:${session.id}` };
    const actor = { kind: "browser-binding", authority, threadId: session.threadId } as const;
    const { tab } = await stack.host.tabs.open(
      actor,
      { kind: "page", profileId: profile.id, url: "about:blank" },
      randomUUID(),
    );
    const seed = await stack.host.tabs.bindBrowserScript(actor, tab.tabId);
    const witnesses = async () =>
      (
        await stack.host.store.database
          .selectFrom("browserSessions")
          .select("standardCdpAttempts")
          .where("id", "=", seed.sessionId)
          .executeTakeFirstOrThrow()
      ).standardCdpAttempts;
    const ticket = await browser.issueStandardCdpTicket({
      authority,
      browserSessionId: seed.sessionId,
      seedTabId: seed.tabId,
      mode: "session",
    });
    expect(ticket.mode).toBe("session");
    expect(await witnesses()).toEqual({});
    const client = await chromium.connectOverCDP(
      new URL(ticket.path, stack.hostOrigin).href.replace(/^http/u, "ws"),
      { noDefaults: true },
    );
    clients.push(client);
    expect(
      await client
        .contexts()[0]!
        .pages()[0]!
        .evaluate(() => 42),
    ).toBe(42);
    expect(await listBrowserStandardCdpLeases(store.database, runnerId)).toEqual([]);
    const [id] = Object.keys(await witnesses());
    expect(id).toBeDefined();
    expect((await witnesses())[id!]).toMatchObject({
      connectionId: connection.id,
      recovery: {
        sessionId: seed.sessionId,
        attachmentId: id,
        runtimeBootId: runtime.standardCdpBootId,
      },
    });

    const disconnect = async () => {
      const reply = await stack.api["commands.dispatch"]({
        type: "connection.revoke",
        connectionId: connection.id,
        idempotencyKey: randomUUID(),
      });
      if (!reply.ok) throw new Error(JSON.stringify(reply));
      expect(reply.data.type).toBe("connection.revoke");
    };

    if (failure === "Home restart") {
      const close = WebSocket.prototype.close;
      const dropDetach = vi.spyOn(WebSocket.prototype, "close").mockImplementation(function (
        this: WebSocket,
        code,
        reason,
      ) {
        if (code === 1000 && String(reason) === standardCdpSettledReason) return this.terminate();
        return close.call(this, code, reason);
      });
      try {
        await stack.restartHost();
      } finally {
        dropDetach.mockRestore();
      }
      expect(client.isConnected()).toBe(false);
      expect((await witnesses())[id!]).toHaveProperty("contactLostAt");
      expect((await witnesses())[id!]).not.toHaveProperty("terminalEvidenceAt");
      await disconnect();
    } else {
      const disconnected = Promise.withResolvers<void>();
      const onDisconnect = () => disconnected.resolve();
      client.once("disconnected", onDisconnect);
      network.block();
      try {
        await milestone(disconnected.promise, "CDP connection loss");
        await disconnect();
        expect(await connectionAttempts(stack.host.store.database, connection.id)).toContainEqual(
          expect.objectContaining({ id, kind: "standard-cdp", terminalEvidenceAt: null }),
        );
        expect(await connections.list(owner.id, { includeRevoked: true })).toContainEqual(
          expect.objectContaining({
            id: connection.id,
            state: "stopping",
            lastActionUncertain: false,
          }),
        );
        if (failure === "Runtime replacement") await fixture.restartBrowserRuntime();
      } finally {
        client.off("disconnected", onDisconnect);
        network.unblock();
      }
      await stack.restartRunner();
    }
    const currentConnections = new AgentConnectionStore(stack.host.store.database);
    const view = await stack.observe(
      async () => {
        const record = (await currentConnections.list(owner.id, { includeRevoked: true })).find(
          ({ id }) => id === connection.id,
        );
        return record?.state === "stopped" ? record : undefined;
      },
      AbortSignal.timeout(5_000),
      "Disconnect did not settle the confined CDP attempt",
    );
    expect(view.lastActionUncertain).toBe(failure === "Runtime replacement");
    expect(await connectionAttempts(stack.host.store.database, connection.id)).toContainEqual(
      expect.objectContaining({
        id,
        kind: "standard-cdp",
        terminalEvidenceAt: expect.any(Date),
        contactLostAt: failure === "Runtime replacement" ? expect.any(Date) : null,
      }),
    );
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "admits a sibling during a stalled Runtime handshake and caps live attachments on its Runner",
  async () => {
    const { stack, runtime } = await startBrowserHome();
    const { browser, store } = stack.host;
    const owner = await store.firstUser();
    if (!owner) throw new Error("The Home has no owner.");
    const runnerId = stack.agentHome.computerId;
    await store.database
      .updateTable("devices")
      .set({ accessPolicy: { ...machineAccessPolicyDefault, browser: true } })
      .where("id", "=", await store.requireSelfDeviceId(runnerId))
      .execute();
    const guest = await browser.start({ ownerId: owner.id, origin: "person", fresh: true });
    const bindings: CdpAuthority[] = [];
    for (let index = 0; index < 5; index++) {
      const authority = {
        ownerId: owner.id,
        agentBindingId: `thread:${await createTask(stack, `Attachment group ${index}`)}`,
      };
      await browser.openAgentSession({ ...authority, sessionId: guest.session.id });
      bindings.push(authority);
    }
    const entered = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const attach = runtime.attachStandardCdp.bind(runtime);
    const spy = vi.spyOn(runtime, "attachStandardCdp").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await unblock.promise;
      return attach(...args);
    });
    const sockets: WebSocket[] = [];
    const probe = async (authority: CdpAuthority) => {
      const ticket = await browser.issueStandardCdpTicket({
        authority,
        browserSessionId: guest.session.id,
        mode: "session",
      });
      const socket = new WebSocket(
        new URL(ticket.path, stack.hostOrigin).href.replace(/^http/u, "ws"),
      );
      sockets.push(socket);
      await once(socket, "open");
      const response = once(socket, "message");
      socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
      return JSON.parse(String((await response)[0]));
    };
    try {
      const slow = probe(bindings[0]!);
      void slow.catch(() => undefined);
      await milestone(entered.promise, "first Runtime attach");
      expect(await probe(bindings[1]!)).toMatchObject({
        id: 1,
        result: { product: expect.any(String) },
      });
      unblock.resolve();
      expect(await slow).toMatchObject({ id: 1, result: { product: expect.any(String) } });
      for (const [index, authority] of bindings.slice(0, 4).entries())
        for (let count = index < 2 ? 1 : 0; count < 4; count++)
          expect(await probe(authority)).toMatchObject({
            id: 1,
            result: { product: expect.any(String) },
          });
      expect(await probe(bindings[4]!)).toMatchObject({
        id: 1,
        error: { message: "This computer has too many live browser connections." },
      });
      const refused = sockets.at(-1)!;
      if (refused.readyState !== WebSocket.CLOSED) await once(refused, "close");
      expect(sockets.filter((socket) => socket.readyState === WebSocket.OPEN)).toHaveLength(16);
    } finally {
      unblock.resolve();
      spy.mockRestore();
      for (const socket of sockets) socket.terminate();
      await browser.stop(owner.id, guest.session.id);
    }
  },
);

async function createTask(stack: PersonalRuntime, title: string) {
  const catalog = stack.initialCatalog;
  if (catalog.status !== "ready" || !catalog.models[0]) throw new Error("No fixture model.");
  const { modelId, providerId } = catalog.models[0];
  const task = await stack.api["commands.dispatch"]({
    type: "thread.create",
    environmentId: stack.environmentId,
    harnessInstanceId: stack.harnessInstanceId,
    modelSelection: { modelId, providerId, options: {} },
    idempotencyKey: randomUUID(),
    title,
  });
  if (!task.ok || task.data.type !== "thread.create") throw new Error(JSON.stringify(task));
  return task.data.thread.id;
}

async function startBrowserHome() {
  const database = await cloneTestDatabase("host");
  return ownTestDatabaseProducer(database.url, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-cdp-renewal-"));
    const bridgeToken = randomBytes(32).toString("base64url");
    const runtimeId = "renewal-browser";
    const profileRoot = join(scratch, "profiles");
    const clients: Browser[] = [];
    let keys: readonly { keyId: string; publicKeyPem: string }[] = [];
    const runtime = new BrowserRuntime({
      launcher: new PlaywrightChromiumLauncher({
        headless: true,
        chromiumSandbox: false,
        executablePath: chromium.executablePath(),
      }),
      localProfiles: { root: profileRoot },
      runtimeId,
      sessionFilesRoot: sessionFilesRoot(profileRoot),
      ticketVerifier: await Ed25519AttachTicketVerifier.create({
        replayLedgerPath: defaultAttachTicketReplayLedgerPath(profileRoot),
        resolvePublicKey: (id) => keys.find((key) => key.keyId === id)?.publicKeyPem ?? null,
      }),
    });
    const runtimeServer = new BrowserRuntimeServer({
      port: 0,
      relayBridge: {
        token: bridgeToken,
        updateAttachKeys: (next) => {
          keys = next;
        },
      },
      runtime,
    });
    let stopRuntime = () => runtimeServer.close();
    try {
      const address = await runtimeServer.start();
      const stack = await startPersonalRuntime({
        databaseUrl: database.url,
        agentHome: { computerId: createId("runner"), path: join(scratch, "work") },
        engineArguments: ["--scenario=interrupt"],
        browser: {
          bridgeToken,
          runtimeId,
          url: new URL(`http://${address.host}:${address.port}`),
        },
      });
      return {
        stack,
        clients,
        runtime,
        restartBrowserRuntime: async () => {
          await runtimeServer.close();
          const child = spawn(
            process.execPath,
            [fileURLToPath(new URL("../apps/browser-runtime/dist/main.js", import.meta.url))],
            {
              env: {
                ...process.env,
                OPENSTEER_MODE: "development",
                OPENSTEER_BROWSER_RELAY_HOST_URL: "",
                OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS: "",
                OPENSTEER_BROWSER_RUNTIME_ID: runtimeId,
                OPENSTEER_BROWSER_PROFILE_ROOT: profileRoot,
                OPENSTEER_BROWSER_BRIDGE_TOKEN: bridgeToken,
                OPENSTEER_BROWSER_PORT: String(address.port),
                OPENSTEER_BROWSER_HOST: address.host,
                OPENSTEER_BROWSER_HEADLESS: "true",
                OPENSTEER_BROWSER_CHROMIUM_SANDBOX: "false",
                OPENSTEER_CHROMIUM_EXECUTABLE: chromium.executablePath(),
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const owned = ownChild(child);
          stopRuntime = () => owned.close(() => child.kill("SIGTERM"), 5_000);
          const ready = Promise.withResolvers<void>();
          const lines = createInterface({ input: child.stdout });
          lines.on("line", (line) => {
            if (line.includes('"event":"browser-runtime.ready"')) ready.resolve();
          });
          let diagnostics = "";
          child.stderr.on("data", (bytes: Buffer) => {
            diagnostics += bytes.toString();
          });
          void owned.exited.then(() =>
            ready.reject(new Error(`The replacement Browser Runtime exited: ${diagnostics}`)),
          );
          await milestone(ready.promise, "replacement Browser Runtime startup");
        },
        close: async () => {
          try {
            await Promise.all(clients.map(async (client) => client.close()));
            await Promise.all([stack.close(), stopRuntime()]);
          } finally {
            await rm(scratch, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      await runtimeServer.close();
      await rm(scratch, { recursive: true, force: true });
      throw error;
    }
  });
}

async function milestone(
  reached: Promise<void>,
  label: string,
  early?: Promise<readonly PromiseSettledResult<unknown>[]>,
) {
  const timeout = AbortSignal.timeout(5_000);
  await Promise.race([
    reached,
    new Promise<never>((_resolve, reject) =>
      timeout.addEventListener("abort", () => reject(new Error(`Missing ${label}`)), {
        once: true,
      }),
    ),
    early?.then((result) => {
      throw new Error(`The command finished before ${label}: ${result[0]?.status}`, {
        cause: result[0]?.status === "rejected" ? result[0].reason : undefined,
      });
    }) ?? new Promise<never>(() => {}),
  ]);
}
