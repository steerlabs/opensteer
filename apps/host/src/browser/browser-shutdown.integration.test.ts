import { createDatabase, OpensteerStore } from "@opensteer/database";
import { describeStore, pendingEvent } from "@opensteer/database/test-support/store";
import { createBrowserSessionId } from "@opensteer/protocol";
import { generateKeyPairSync } from "node:crypto";
import { expect } from "vitest";
import { terminalRunReaction } from "../runtime/runtime.js";
import { BrowserService } from "./browser-service.js";
import { BrowserAttachTicketSigner } from "./browser-ticket.js";

describeStore("Browser shutdown reconciliation", (it) => {
  it("clears attachments on restart when a terminal Run arrives after browser close", async ({
    storeFixture,
    onTestFinished,
  }) => {
    const { store, database, databaseUrl, startRunFixture } = storeFixture;
    const signer = new BrowserAttachTicketSigner({
      keyId: "test",
      privateKey: generateKeyPairSync("ed25519").privateKey,
    });
    const services: BrowserService[] = [];
    let restartedDatabase: ReturnType<typeof createDatabase> | undefined;
    const service = (repository: OpensteerStore) => {
      const browser = new BrowserService({
        hostOrigin: new URL("http://127.0.0.1:4310"),
        onSessionsChanged: () => undefined,
        onWorkspaceEvent: () => undefined,
        repository,
        signer,
      });
      services.push(browser);
      return browser;
    };
    onTestFinished(async () => {
      for (const browser of services) await browser.close();
      await restartedDatabase?.destroy();
    });
    const browser = service(store);
    await browser.initialize();
    const f = await startRunFixture("late-browser-detach");
    const sessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: sessionId,
      origin: "agent",
      placementKey: `runner:${f.runnerId}:browser`,
      profileId: null,
      runnerId: f.runnerId,
      runtimeId: "browser",
      workspaceId: f.workspace.id,
    });
    const bindingId = `run:${f.run.id}`;
    expect(
      await store.attachBrowserSession({
        agentBindingId: bindingId,
        ownerId: f.userId,
        sessionId,
        workspaceId: f.workspace.id,
      }),
    ).toBe(true);

    // The Host stops its browser before stopping terminal-event producers.
    await browser.close();
    const terminal = await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: { status: "completed" },
        environmentId: f.environmentId,
        ordinal: 1,
        runId: f.run.id,
        threadId: f.thread.id,
        type: "run.completed",
        workspaceId: f.workspace.id,
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    let detaching: Promise<unknown> | undefined;
    terminalRunReaction({
      detachBrowserSessions: (binding) =>
        (detaching = browser.detachAgentSessionsForBinding(binding)),
      endShellSessions: async () => undefined,
    })(terminal.event);
    expect(detaching).toBeDefined();
    await detaching;
    expect(await store.countBrowserSessionAttachments(sessionId)).toBe(1);
    expect(await store.listAttachedRunIdsForBrowserSessions([sessionId])).toEqual(
      new Map([[sessionId, [f.run.id]]]),
    );
    await database.destroy();

    restartedDatabase = createDatabase({ connectionString: databaseUrl });
    const restartedStore = new OpensteerStore(restartedDatabase);
    const restarted = service(restartedStore);
    await restarted.initialize();
    expect(await restartedStore.countBrowserSessionAttachments(sessionId)).toBe(0);
    expect(await restartedStore.listAttachedRunIdsForBrowserSessions([sessionId])).toEqual(
      new Map(),
    );
    expect(await restartedStore.listActiveBrowserSessionsForAgentBinding(bindingId)).toEqual([]);
    expect(
      await restartedStore.listActiveBrowserSessionsForAgent({
        allOwnerWorkspaces: true,
        ownerId: f.userId,
        workspaceId: f.workspace.id,
      }),
    ).toEqual([]);
    expect(await restartedStore.listBrowserPlaceHoldings(sessionId)).toEqual([]);
    expect(
      await restartedStore.resolvePlaceActors({
        agentBindingIds: [bindingId],
        ownerIds: [f.userId],
      }),
    ).toEqual([]);
    await restarted.close();
  });
});
