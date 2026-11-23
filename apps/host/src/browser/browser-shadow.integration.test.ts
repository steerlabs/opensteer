import { BrowserRuntime, type BrowserAttachment } from "@opensteer/browser-runtime-core";
import {
  FakeIsolatingLauncher,
  type FakeContext,
} from "@opensteer/browser-runtime-core/test-support";
import { TabStore, type DatabaseSchema } from "@opensteer/database";
import { commitPersonalMutation } from "@opensteer/database/personal-mutation";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "@opensteer/database/test-support/store";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import {
  BrowserAttachTicketClaimsSchema,
  type BrowserRuntimeServerMessage,
  type InitialPageReady,
} from "@opensteer/protocol";
import pg from "pg";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { BrowserService, type BrowserRuntimeConnection } from "./browser-service.js";
import { BrowserAttachTicketSigner } from "./browser-ticket.js";
import { shadowRunsTouched } from "./shadow-host.js";
import type { RunToolScope } from "../agents/run-tool-tokens.js";

/** One live Host↔runtime connection in-process, exactly the existing attachment. */
class RuntimeConnection extends EventEmitter implements BrowserRuntimeConnection {
  readyState = 1;
  initialPage: InitialPageReady | undefined;
  readonly attachment: Promise<BrowserAttachment>;
  static readonly received: BrowserRuntimeServerMessage[] = [];
  static readonly open: RuntimeConnection[] = [];
  constructor(runtime: BrowserRuntime, ticket: string) {
    super();
    RuntimeConnection.open.push(this);
    this.attachment = Promise.resolve()
      .then(() =>
        runtime.attach(ticket, {
          sendFrame: async () => {},
          sendServer: async (message) => {
            RuntimeConnection.received.push(message);
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
integration("the Host's shadow comparison of catalog and runtime", () => {
  it("logs what it would destroy, destroys nothing, and does no work at idle", async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const fixture = await createStoreFixture(),
      f = await fixture.startRunFixture("shadow-host");
    const root = await mkdtemp(join(tmpdir(), "opensteer-shadow-runtime-"));
    const { database, store } = fixture;
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", f.runnerId)
      .execute();
    const tabs = new TabStore(database as unknown as Kysely<DatabaseSchema>);
    const launcher = new FakeIsolatingLauncher();
    const runtime = new BrowserRuntime({
      runtimeId: "shadow-test",
      launcher,
      sessionFilesRoot: root,
      ticketVerifier: {
        verify: async (token) =>
          BrowserAttachTicketClaimsSchema.parse(
            JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()),
          ),
      },
    });
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      if (typeof line === "string" && line.startsWith("{")) lines.push(JSON.parse(line));
    });
    let readFails = false;
    const readCut = store.readBrowserSessionCut.bind(store);
    /** Every cut read, by session, and the most read at once. */
    const reads: string[] = [];
    const completedReads: string[] = [];
    let reading = 0;
    let mostAtOnce = 0;
    const repository = Object.assign(personalBrowserRepository(store), {
      readBrowserSessionCut: async (...args: Parameters<typeof readCut>) => {
        reads.push(args[1]);
        reading++;
        mostAtOnce = Math.max(mostAtOnce, reading);
        try {
          if (readFails) throw new Error("connection reset");
          return await readCut(...args);
        } finally {
          reading--;
          completedReads.push(args[1]);
        }
      },
    });
    const browser = new BrowserService({
      deploymentId: f.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      personal: true,
      repository,
      tabs,
      tabPlaces: { write: async () => false, notice: () => {} },
      signer: new BrowserAttachTicketSigner({
        keyId: "test",
        privateKey: generateKeyPairSync("ed25519").privateKey,
      }),
      onSessionsChanged: () => {},
      onError: () => {},
      targetResolver: {
        placements: () => [
          {
            kind: "runner",
            runnerId: f.runnerId,
            runtimeId: "shadow-test",
            label: "Computer",
            available: true,
            agents: true,
            environmentIds: [f.environmentId],
          },
        ],
        resolve: (placement) =>
          placement.runnerId === f.runnerId
            ? {
                runtimeId: "shadow-test",
                placementKey: "shadow-test",
                cdpBoundary: true,
                sharedControl: true,
                targetControl: true,
                stateImport: true,
                surfaceState: 1,
                tabRestoreVersion: true,
                connect: (ticket) => new RuntimeConnection(runtime, ticket),
              }
            : undefined,
      },
    });
    // The Host's own post-commit hooks, as the runtime wires them.
    const stopObserving = fixture.observePersonalReactions({
      notice: (notice) => browser.shadowTabsChanged(notice.changedTabs),
      reaction: (reaction) => {
        const runs = shadowRunsTouched(reaction);
        if (runs !== undefined) browser.shadowRunsChanged(runs);
      },
    });
    await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
      close: async () => {
        stopObserving();
        await browser.close();
        await runtime.shutdown().catch(() => undefined);
        vi.restoreAllMocks();
        vi.useRealTimers();
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
    const converges = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 25 });
    const shadow = (event: string) => lines.filter((line) => line.event === event);
    const descriptor = await browser.pageTabs.open(
      { kind: "run", claims },
      { kind: "page", url: "https://example.com/", guest: true },
      "open",
    );
    await tabs.open(descriptor, "row");
    await browser.pageTabs.admitted!(descriptor);
    const sessionId = descriptor.pageBinding!.sessionId;
    // A page whose catalog row is still being written is not a disagreement.
    // Settled: the catalog and the runtime agree.
    await converges(() => expect(shadow("browser.shadow.summary").length).toBeGreaterThan(0));
    await converges(() =>
      expect(shadow("browser.shadow.summary").at(-1)).toMatchObject({
        session: sessionId,
        counts: { "would-destroy": 0, "tab-without-page": 0 },
      }),
    );

    // Closed in the catalog while the runtime still holds its page: one line, nothing closed.
    await tabs.close(f.userId, [descriptor.id], "close");
    await converges(() =>
      expect(shadow("browser.shadow.appeared")).toEqual([
        expect.objectContaining({
          session: sessionId,
          kind: "would-destroy",
          reason: "closed",
          tab: descriptor.id,
          state: "live",
        }),
      ]),
    );
    const context = [...launcher.browsersByPartition.values()].at(-1)!.context as FakeContext;
    const page = context.pages().find((candidate) => !candidate.isClosed())!;
    expect(page).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(page.isClosed(), "Shadow destroys nothing").toBe(false);
    // Still usable: the live attachment answers a command for it.
    const requestId = randomUUID();
    RuntimeConnection.open.at(-1)!.send(
      JSON.stringify({
        type: "cdp.command",
        requestId,
        command: { method: "Target.getTargets" },
      }),
      { binary: false },
      () => undefined,
    );
    await converges(() =>
      expect(
        RuntimeConnection.received.some(
          (message) => message.type === "cdp.result" && message.requestId === requestId,
        ),
      ).toBe(true),
    );
    expect(shadow("browser.shadow.appeared"), "Logged once, however long it lasts").toHaveLength(1);

    // Reopened: no longer closed, but the page the runtime holds was bound at an earlier
    // generation of the tab, so it is the one that would be destroyed now.
    await tabs.reopen(f.userId, descriptor.id, "reopen");
    await converges(() =>
      expect(shadow("browser.shadow.appeared").map((line) => line.reason)).toEqual([
        "closed",
        "generation",
      ]),
    );
    expect(shadow("browser.shadow.resolved")).toEqual([
      expect.objectContaining({ reason: "closed", tab: descriptor.id }),
    ]);

    // The Run finishes: its actor's hold on the page would be dropped.
    await commitPersonalMutation(database, async (tx, mutation) => {
      await tx.updateTable("runs").set({ status: "completed" }).where("id", "=", f.runId).execute();
      mutation.react({
        type: "runFinished",
        runId: f.runId,
        threadId: f.threadId,
        attemptId: null,
        bindingGeneration: f.bindingGeneration,
        outcome: "completed",
      });
    });
    await converges(() =>
      expect(shadow("browser.shadow.appeared").at(-1)).toMatchObject({
        kind: "would-drop-hold",
        reason: "not-eligible",
        run: f.runId,
        bindingGeneration: f.bindingGeneration,
      }),
    );
    // Recovery: the Run runs again under the binding its actor was issued for.
    await commitPersonalMutation(database, async (tx, mutation) => {
      await tx.updateTable("runs").set({ status: "running" }).where("id", "=", f.runId).execute();
      mutation.react({
        type: "runChanged",
        environmentId: f.environmentId,
        runId: f.runId,
        threadId: f.threadId,
        transition: "restarted",
      });
    });
    await converges(() =>
      expect(shadow("browser.shadow.resolved").at(-1)).toMatchObject({ kind: "would-drop-hold" }),
    );

    // A failing read: logged once, the session unaffected, the next good read resumes.
    readFails = true;
    await tabs.close(f.userId, [descriptor.id], "close-again");
    await tabs.reopen(f.userId, descriptor.id, "reopen-again");
    await converges(() => expect(shadow("browser.shadow.failed")).toHaveLength(1));
    expect(shadow("browser.shadow.failed")[0]).toMatchObject({ kind: "read", session: sessionId });
    readFails = false;
    await tabs.close(f.userId, [descriptor.id], "close-third");
    await converges(() =>
      expect(shadow("browser.shadow.appeared").at(-1)).toMatchObject({ reason: "closed" }),
    );
    expect(page.isClosed()).toBe(false);

    // Fifty more sessions: one tab commit reads the one session it touches, one read at a time.
    const beforeFifty = completedReads.length;
    for (let index = 0; index < 50; index++)
      await browser.start({ fresh: true, ownerId: f.userId });
    await converges(() => expect(completedReads.length).toBe(beforeFifty + 50));
    await vi.advanceTimersByTimeAsync(1_000);
    const before = reads.length;
    const beforeCompleted = completedReads.length;
    await tabs.reopen(f.userId, descriptor.id, "reopen-fanout");
    await converges(() => expect(completedReads.length).toBeGreaterThan(beforeCompleted));
    await converges(() =>
      expect(shadow("browser.shadow.appeared").at(-1)).toMatchObject({ reason: "generation" }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads.slice(before), "Only the session that holds the tab").toEqual([sessionId]);
    expect(mostAtOnce, "Never more than one cut, so one pooled connection, at a time").toBe(1);

    // Idle: sessions attached, nothing changing, no statement for this, or anything, at all.
    await vi.advanceTimersByTimeAsync(60_000);
    const statements: string[] = [];
    const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const query = prototype.query;
    prototype.query = function (this: pg.Client, ...args: unknown[]): unknown {
      const [text] = args as [string | { text?: string } | undefined];
      statements.push(typeof text === "string" ? text : (text?.text ?? "?"));
      return query.apply(this, args);
    };
    try {
      const before = lines.length;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(statements, "No periodic statements at idle").toEqual([]);
      expect(lines.slice(before), "No periodic lines at idle").toEqual([]);
    } finally {
      prototype.query = query;
    }
  }, 60_000);
});
