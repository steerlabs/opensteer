import { createId } from "@opensteer/core";
import { BrowserRuntime, type BrowserAttachment } from "@opensteer/browser-runtime-core";
import {
  FakeIsolatingLauncher,
  FakeContext,
  FakePage,
} from "@opensteer/browser-runtime-core/test-support";
import { TabStore, type DatabaseSchema } from "@opensteer/database";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "@opensteer/database/test-support/store";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import { BrowserAttachTicketClaimsSchema, type InitialPageReady } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { BrowserService, type BrowserRuntimeConnection } from "./browser-service.js";
import { BrowserAttachTicketSigner } from "./browser-ticket.js";
import type { RunToolScope } from "../agents/run-tool-tokens.js";

class RuntimeConnection extends EventEmitter implements BrowserRuntimeConnection {
  readyState = 1;
  initialPage: InitialPageReady | undefined;
  readonly attachment: Promise<BrowserAttachment>;
  readonly commands: string[] = [];
  constructor(runtime: BrowserRuntime, ticket: string) {
    super();
    this.attachment = Promise.resolve()
      .then(() =>
        runtime.attach(ticket, {
          sendFrame: async () => {},
          sendServer: async (message) => {
            if (this.readyState === 1)
              this.emit("message", Buffer.from(JSON.stringify(message)), false);
          },
        }),
      )
      .then((attachment) => {
        this.initialPage = attachment.initialPage;
        return attachment;
      });
    void this.attachment.catch((error) => this.emit("error", error));
  }
  send(data: string, _options: { binary: false }, callback: (error?: Error) => void): void {
    const message = JSON.parse(data) as { command?: { method: string } };
    if (message.command) this.commands.push(message.command.method);
    void this.attachment
      .then((attachment) => attachment.handle(data))
      .then(
        () => callback(),
        (error) => callback(error),
      );
  }
  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    void this.attachment
      .then(
        (attachment) => attachment.close(),
        () => undefined,
      )
      .finally(() => this.emit("close", 1000, Buffer.from("closed")));
  }
  terminate(): void {
    this.close();
  }
}
const integration = describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL);
integration("page tab adapter", () => {
  it("binds live pages without a resume and restores an ended session once without changing membership", async () => {
    const fixture = await createStoreFixture(),
      f = await fixture.startRunFixture("page-tabs");
    const root = await mkdtemp(join(tmpdir(), "opensteer-tab-runtime-"));
    const { database, store } = fixture;
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", f.runnerId)
      .execute();
    const tabs = new TabStore(database as unknown as Kysely<DatabaseSchema>);
    const launcher = new FakeIsolatingLauncher();
    const runtime = new BrowserRuntime({
      runtimeId: "tabs-test",
      launcher,
      sessionFilesRoot: root,
      ticketVerifier: {
        verify: async (token) =>
          BrowserAttachTicketClaimsSchema.parse(
            JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()),
          ),
      },
    });
    const connections: RuntimeConnection[] = [],
      errors: unknown[] = [];
    const browser = new BrowserService({
      deploymentId: f.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      personal: true,
      repository: personalBrowserRepository(store),
      tabs,
      tabPlaces: { write: async () => undefined, publish: () => {}, notice: () => {} },
      signer: new BrowserAttachTicketSigner({
        keyId: "test",
        privateKey: generateKeyPairSync("ed25519").privateKey,
      }),
      onDeploymentEvent: () => {},
      onSessionsChanged: () => {},
      onError: (error) => errors.push(error),
      targetResolver: {
        placements: () => [
          {
            kind: "runner",
            runnerId: f.runnerId,
            runtimeId: "tabs-test",
            label: "Computer",
            available: true,
            agents: true,
            environmentIds: [f.environmentId],
          },
        ],
        resolve: (placement) =>
          placement.runnerId === f.runnerId
            ? {
                runtimeId: "tabs-test",
                placementKey: "test",
                cdpBoundary: true,
                sharedControl: true,
                targetControl: true,
                surfaceState: 1,
                tabRestoreVersion: true,
                connect: (ticket) => {
                  const connection = new RuntimeConnection(runtime, ticket);
                  connections.push(connection);
                  return connection;
                },
              }
            : undefined,
      },
    });
    await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
      close: async () => {
        await browser.close();
        await runtime.shutdown();
        await rm(root, { recursive: true, force: true });
      },
    }));
    const claims: RunToolScope = {
      aud: "opensteer-run-tools",
      iss: "opensteer-host",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: randomUUID(),
      requestedBy: f.userId,
      threadId: f.threadId,
      runId: f.runId,
      environmentId: f.environmentId,
      runnerId: f.runnerId,
      runnerBootId: f.runnerBootId,
      bindingGeneration: f.bindingGeneration,
    };
    const actor = { kind: "run", claims } as const;
    const descriptor = await browser.pageTabs.open(
      actor,
      { kind: "page", url: "https://example.com/saved", guest: true },
      "page",
    );
    const initialContext = [...launcher.browsersByPartition.values()].at(-1)!
      .context as FakeContext;
    const initialOpener = initialContext.pages()[0]!;
    initialContext.addPage(
      new FakePage({
        opener: initialOpener,
        title: "Initial popup",
        url: "https://example.com/initial-popup",
      }),
    );
    await vi.waitFor(
      () =>
        expect(
          [...browser.pageInventory(descriptor.pageBinding!.sessionId)!.records.values()].some(
            (page) => page.url === "https://example.com/initial-popup",
          ),
        ).toBe(true),
      { timeout: 3000 },
    );
    await browser.flushPendingTabDescriptors();
    expect((await tabs.snapshot(f.userId)).rows).toEqual([]);
    await tabs.open(descriptor, "page");
    await browser.pageTabs.admitted!(descriptor);
    expect(
      (await tabs.snapshot(f.userId)).rows.some(
        (page) => page.url === "https://example.com/initial-popup",
      ),
    ).toBe(true);
    let row = await tabs.get(f.userId, descriptor.id);
    if (!row) throw new Error("Admitted page missing");
    const first = await withTimeout(browser.bindPage(claims, row), 3000, {
      timeoutError: () => new Error("Live page bind did not complete"),
    });
    expect(first).toMatchObject({
      tabId: row.id,
      sessionId: row.pageBinding!.sessionId,
      reloaded: false,
    });
    expect(connections.flatMap((connection) => connection.commands)).not.toContain(
      "Opensteer.resumeTab",
    );
    expect(
      await browser.signInTarget({ ownerId: f.userId, tabId: row.id, sessionId: first.sessionId }),
    ).toMatchObject({ tabId: row.id });
    let viewerOpen = true;
    const viewer = await browser.attach(
      f.userId,
      first.sessionId,
      {
        id: "viewer",
        isOpen: () => viewerOpen,
        close: () => {
          viewerOpen = false;
        },
        send: async () => {},
      },
      { authSessionId: createId("authSession"), mode: "control", signedIn: async () => true },
    );
    await viewer.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: row.id, frames: false })),
      false,
    );
    const siblingWrite = await browser.pageTabs.open(
      actor,
      { kind: "page", url: "https://example.com/sibling", guest: true },
      "sibling",
    );
    await tabs.open(siblingWrite, "sibling");
    await browser.pageTabs.admitted!(siblingWrite);
    const sibling = (await tabs.get(f.userId, siblingWrite.id))!;
    expect(sibling.pageBinding?.sessionId).toBe(first.sessionId);
    const oldRow = row;
    await tabs.close(f.userId, [row.id], "close-held");
    await expect(
      viewer.handle(
        Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: row.id, frames: false })),
        false,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await browser.signInTarget({ ownerId: f.userId, tabId: row.id, sessionId: first.sessionId }),
    ).toBeNull();
    expect(connections.flatMap((connection) => connection.commands)).not.toContain(
      "Opensteer.closeTab",
    );
    await tabs.reopen(f.userId, row.id, "reopen");
    row = (await tabs.get(f.userId, row.id))!;
    let nextViewerOpen = true;
    const nextViewer = await browser.attach(
      f.userId,
      first.sessionId,
      {
        id: "next-viewer",
        isOpen: () => nextViewerOpen,
        close: () => {
          nextViewerOpen = false;
        },
        send: async () => {},
      },
      { authSessionId: createId("authSession"), mode: "control", signedIn: async () => true },
    );
    await nextViewer.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: row.id, frames: false })),
      false,
    );
    await browser.pageTabs.closeViewers(f.userId, oldRow);
    expect(viewerOpen).toBe(false);
    expect(nextViewerOpen).toBe(true);
    viewer.close();
    nextViewer.close();
    await browser.stop(f.userId, first.sessionId);
    expect(await tabs.get(f.userId, row.id)).toMatchObject({ id: row.id, generation: 3 });
    const restored = await withTimeout(browser.bindPage(claims, row), 3000, {
      timeoutError: () => new Error("Page restoration did not complete"),
    });
    expect(restored.tabId).toBe(row.id);
    expect(restored.sessionId).not.toBe(first.sessionId);
    expect(restored.reloaded).toBe(true);
    expect((await browser.bindPage(claims, (await tabs.get(f.userId, row.id))!)).reloaded).toBe(
      false,
    );
    const restoredContext = [...launcher.browsersByPartition.values()].at(-1)!
      .context as FakeContext;
    const siblingRestored = await browser.bindPage(claims, sibling);
    expect(siblingRestored.sessionId).not.toBe(restored.sessionId);
    expect(connections).toHaveLength(3);
    const context = restoredContext;
    const opener = context.pages()[0] as FakePage;
    opener.navigate("https://example.com/after-sibling", "A after sibling restoration");
    context.addPage(
      new FakePage({ opener, title: "Popup after sibling", url: "https://example.com/popup" }),
    );
    await vi.waitFor(
      async () => {
        await browser.flushPendingTabDescriptors();
        expect((await tabs.get(f.userId, row.id))?.url).toBe("https://example.com/after-sibling");
        expect(
          (await tabs.snapshot(f.userId)).rows.some(
            (row) => row.url === "https://example.com/popup",
          ),
        ).toBe(true);
      },
      { timeout: 3000 },
    );
    expect((await tabs.snapshot(f.userId)).rows).toHaveLength(4);
    expect(errors).toEqual([]);
  });
});
