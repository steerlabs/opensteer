import { browserRows } from "./browser-rows.test-support.js";
import { zeroSequence } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closed,
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  startPrivateMachineHost,
  waitForMessage,
  type MachineAccessHost,
} from "../runtime/private-machine-host.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import { startBrowserRuntime } from "./browser-runtime.test-support.js";
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
interface Listener {
  readonly messages: Record<string, unknown>[];
  socket: WebSocket;
  close(): Promise<void>;
}

/** A personal realtime socket that keeps every message. */
async function listen(
  host: MachineAccessHost,
  headers: Record<string, string>,
  subscribe = true,
  placeEvents = false,
  browserStreams = true,
): Promise<Listener> {
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/v1/realtime`, { headers });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (frame: WebSocket.RawData) => {
    const message = JSON.parse(frame.toString()) as Record<string, unknown> & {
      readonly events?: readonly { readonly sequence?: string }[];
    };
    messages.push(message);
    const latest = message.events?.at(-1);
    if (message.type === "host.events" && latest?.sequence && subscribe) {
      socket.send(JSON.stringify({ sequence: latest.sequence, type: "client.ack" }));
    }
  });
  if (subscribe) {
    const synchronized = waitForMessage(socket, (message) => message.type === "host.synchronized");
    socket.send(
      JSON.stringify({
        cursor: {
          deploymentId: (await host.store.getDeployment())!.id,
          apiVersion: hostApiVersion,
          afterSequence: zeroSequence,
        },
        apiVersion: hostApiVersion,
        threadId: null,
        personShow: "accept",
        ...(placeEvents ? { placeEvents: "include" } : {}),
        type: "client.subscribe",
      }),
    );
    await synchronized;
  }
  if (browserStreams) socket.send(JSON.stringify({ type: "client.browser.resync" }));
  return {
    socket,
    close: async () => {
      socket.close();
      await closed(socket);
    },
    messages,
  };
}

async function until<Value>(
  produce: () => Value | undefined | Promise<Value | undefined>,
  timeoutMs = 10_000,
): Promise<Value> {
  return vi.waitFor(
    async () => {
      const value = await produce();
      if (value === undefined) throw new Error("Realtime condition never arrived");
      return value;
    },
    { timeout: timeoutMs },
  );
}

const ofType = (listener: Listener, type: string) =>
  listener.messages.filter((message) => message.type === type);
integration("Tab activity attribution", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  });
  it("announces a later Run acting in the same page as its Thread's newest place", async () => {
    const database = await createMachineAccessDatabase(databaseUrl!);
    cleanups.push(() => database.drop());
    const host = await startPrivateMachineHost(database.url, { remoteAccess: true });
    cleanups.push(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Same page caller",
      token: await host.hostingRunnerEnrollmentToken,
    });
    cleanups.push(() => caller.close());
    const first = await dispatchCallerRun(host, caller, { key: "same-page", title: "Same page" });
    const runtime = await startBrowserRuntime(
      host.hostPort,
      await enrollmentToken(host, {
        allowedModules: ["browser"],
        idempotencyKey: "same-page-browser",
        name: "Same page browser",
      }),
      { agentReady: true, targetedStreaming: true },
    );
    cleanups.push(() => runtime.close());
    await until(() => (host.runtime.browser.available ? true : undefined));
    const owner = await listen(host, host.ownerHeaders);
    cleanups.push(() => owner.close());
    const opened = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "tab.open",
        idempotencyKey: "same-page-session",
        target: {
          kind: "page",
          guest: true,
          computerId: runtime.runnerId,
          url: "https://shared.example/",
        },
      },
      { headers: host.ownerHeaders },
    );
    if (opened.type !== "tab.open") throw new Error("Unexpected command");
    const tabId = opened.tab.tabId;
    const activated = await host.runtime.tabs.activate(host.ownerId, tabId, "activate");
    if (activated.viewer.kind !== "page") throw new Error("Expected page");
    const sessionId = activated.viewer.sessionId;
    runtime.publishTabs({
      surfaces: [
        {
          id: tabId,
          active: true,
          title: "Shared",
          url: "https://shared.example/",
          order: 0,
          documentId: "document-shared",
          geometryRevision: 1,
          openerId: null,
        },
      ],
    });
    await until(async () =>
      (await browserRows(host.runtime.browser, host.ownerId, sessionId)).tabs.some(
        (tab) => tab.id === tabId,
      )
        ? true
        : undefined,
    );
    // The Runtime also hears the Host's own housekeeping; each step answers only its own command.
    const nextCdp = async (method: string) => {
      for (;;) {
        const command = await runtime.nextCommand();
        if (
          command.type === "cdp.command" &&
          (command.command as { method?: string } | undefined)?.method === method
        )
          return command;
      }
    };
    const actIn = async (run: typeof first, cdpSession: string) => {
      const cdp = await host.runtime.browser.attachCdpForAgent(
        {
          agentBindingId: `run:${run.runId}`,
          ownerId: host.ownerId,
          sessionId,
        },
        () => undefined,
      );
      cleanups.push(async () => cdp.close());
      const warm = cdp.request({ method: "Target.getTargets" });
      const warmCommand = await nextCdp("Target.getTargets");
      runtime.sendServer({
        type: "cdp.result",
        requestId: warmCommand.requestId,
        result: { targetInfos: [] },
      });
      await warm;
      const attach = cdp.request({
        method: "Target.attachToTarget",
        parameters: { targetId: "target-shared", flatten: true },
      });
      const attachCommand = await nextCdp("Target.attachToTarget");
      runtime.sendServer({
        type: "cdp.result",
        requestId: attachCommand.requestId,
        result: { sessionId: cdpSession, surfaceId: tabId },
      });
      await attach;
      // Acting is attributed once the Host has resolved this Run as the tab's holder.
      await until(async () =>
        [
          ...new Map([
            [host.ownerId, await browserRows(host.runtime.browser, host.ownerId, sessionId)],
          ]).values(),
        ].some((catalog) =>
          catalog.tabs.some(
            (tab) =>
              tab.id === tabId &&
              tab.occupants.some(
                (occupant) => occupant.threadId === run.threadId && occupant.holding,
              ),
          ),
        )
          ? true
          : undefined,
      );
      const acting = cdp.request({
        method: "Runtime.evaluate",
        parameters: { expression: "void 0" },
        sessionId: cdpSession,
      });
      const command = await nextCdp("Runtime.evaluate");
      expect(typeof command.actorToken).toBe("string");
      runtime.sendServer({
        type: "browser.activity",
        actorToken: command.actorToken,
        surfaceId: tabId,
        seq: 1,
        geometryRevision: 1,
        pointer: null,
      });
      runtime.sendServer({ type: "cdp.result", requestId: command.requestId, result: {} });
      await acting;
    };
    const named = (runId: string) =>
      ofType(owner, "host.thread-place-changed").find(
        (message) => (message.reference as { runId?: string }).runId === runId,
      );

    await actIn(first, "cdp-first");
    expect(await until(() => named(first.runId))).toMatchObject({
      reference: { taskId: first.threadId, tabId, title: "Shared" },
    });
    await first.complete();
    // The same Thread's next Run, in the same page, title and site as the first.
    const second = await dispatchCallerRun(host, caller, {
      key: "same-page-again",
      title: "Same page",
      threadId: first.threadId,
    });
    expect(second.runId).not.toBe(first.runId);
    await actIn(second, "cdp-second");
    expect(await until(() => named(second.runId))).toMatchObject({
      reference: { taskId: first.threadId, tabId, title: "Shared" },
    });
    expect(
      (await host.runtime.browser.latestTabPlaces(host.ownerId)).find(
        (reference) => reference.taskId === first.threadId,
      ),
    ).toMatchObject({ runId: second.runId });
  }, 60_000);
});
