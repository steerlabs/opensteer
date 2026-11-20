import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import { startPersonalRuntime } from "../apps/host/src/runtime/personal-startup.test-support.js";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
} from "../packages/browser-runtime-core/src/index.js";
import { createId } from "../packages/core/src/index.js";
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
      if (frame.type === "capability.accepted")
        accepted.push(frame.capability.capabilityGeneration);
      if (hold && frame.type === "browser.server-message" && frame.message?.type === "cdp.raw") {
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

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
          { noDefaults: true },
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
      await firstChunk.promise;
      expect(rawGenerations).toEqual([accepted[0]]);

      // The auxiliary socket has a two-minute lease. Move just its scheduling timers.
      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => accepted.length).toBe(2);
      resume.resolve();
      const [largeResult] = await outcome;
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
      vi.useRealTimers();
      spy.mockRestore();
    }
  },
);

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
