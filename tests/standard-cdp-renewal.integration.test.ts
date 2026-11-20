import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import {
  startPersonalRuntime,
  type PersonalRuntime,
} from "../apps/host/src/runtime/personal-startup.test-support.js";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
} from "../packages/browser-runtime-core/src/index.js";
import { createId } from "../packages/core/src/index.js";
import { AgentConnectionStore } from "../packages/database/src/agent-connection-store.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { machineAccessPolicyDefault } from "../packages/protocol/src/shell.js";

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
    await expect.poll(findRun).toMatchObject({ status: "running" });
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
    const clients: Browser[] = [];
    let keys: readonly { keyId: string; publicKeyPem: string }[] = [];
    const runtimeServer = new BrowserRuntimeServer({
      port: 0,
      relayBridge: {
        token: bridgeToken,
        updateAttachKeys: (next) => {
          keys = next;
        },
      },
      runtime: new BrowserRuntime({
        launcher: new PlaywrightChromiumLauncher({
          headless: true,
          chromiumSandbox: false,
          executablePath: chromium.executablePath(),
        }),
        localProfiles: { root: join(scratch, "profiles") },
        runtimeId,
        sessionFilesRoot: join(scratch, "files"),
        ticketVerifier: await Ed25519AttachTicketVerifier.create({
          replayLedgerPath: join(scratch, "private", "replay.json"),
          resolvePublicKey: (id) => keys.find((key) => key.keyId === id)?.publicKeyPem ?? null,
        }),
      }),
    });
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
        close: async () => {
          try {
            await Promise.all(clients.map(async (client) => client.close()));
            await Promise.all([stack.close(), runtimeServer.close()]);
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
