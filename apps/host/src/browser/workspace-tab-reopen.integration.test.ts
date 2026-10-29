import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceTabStore } from "@opensteer/database";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMachineAccessDatabase,
  connectCallerMachine,
  dispatchCallerRun,
  enrollmentToken,
  startMachineAccessHost,
} from "../runtime/machine-access.test-support.js";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import { startBrowserRuntime } from "./browser-runtime.test-support.js";

// Failures: access refusal consumes the close, a new identity is substituted,
// the Host opens a page eagerly, or concurrent commands return the same tab.
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration("Reopen closed workspace tab through the Host", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  });
  it("rechecks activation access, refuses without consuming, and returns a new suspended tab", async () => {
    const database = await createMachineAccessDatabase(databaseUrl!);
    cleanups.push(() => database.drop());
    const host = await startMachineAccessHost(database.url, { signupPolicy: "open" });
    cleanups.push(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Reopen caller",
      token: await enrollmentToken(host, {
        allowedModules: ["agents"],
        idempotencyKey: "caller",
        name: "Caller",
      }),
    });
    cleanups.push(() => caller.close());
    const run = await dispatchCallerRun(host, caller, { key: "reopen", title: "Reopen" });
    const runtime = await startBrowserRuntime(
      host.hostPort,
      await enrollmentToken(host, {
        allowedModules: ["browser"],
        idempotencyKey: "browser",
        name: "Browser",
      }),
      { agentReady: true, workspaceTabs: true, targetedStreaming: true },
    );
    cleanups.push(() => runtime.close());
    await expect.poll(() => host.runtime.browser.available).toBe(true);
    const opened = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "browser.session.start",
        workspaceId: run.workspaceId,
        idempotencyKey: "start",
        input: { fresh: true },
      },
      { headers: host.ownerHeaders },
    );
    if (opened.type !== "browser.session.start") throw new Error("Unexpected start");
    const db = host.store.database;
    const sessionId = opened.session.id;
    const tabs = new WorkspaceTabStore(db);
    const ownerId = (
      await db
        .selectFrom("browserSessions")
        .innerJoin("workspaces", "workspaces.id", "browserSessions.workspaceId")
        .select("workspaces.createdBy")
        .where("browserSessions.id", "=", sessionId)
        .executeTakeFirstOrThrow()
    ).createdBy;
    const first = BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`);
    await tabs.record(
      sessionId,
      [
        {
          id: first,
          title: "Saved",
          url: "https://saved.test/path#hash",
          order: 1,
          openerId: null,
        },
      ],
      [],
    );
    await tabs.close(ownerId, first);
    const profile = await host.store.createBrowserProfile({
      idempotencyKey: randomUUID(),
      name: "Removed",
      ownerId,
    });
    await db
      .updateTable("browserSessions")
      .set({ profileId: profile.id })
      .where("id", "=", sessionId)
      .execute();
    await db
      .updateTable("browserProfiles")
      .set({ archivedAt: new Date() })
      .where("id", "=", profile.id)
      .execute();
    const command = () =>
      testRpcRequest(
        host.origin,
        "commands.dispatch",
        { type: "workspace.tab.reopen", idempotencyKey: randomUUID() },
        { headers: host.ownerHeaders },
      );
    const profileRefusal = await command();
    expect(profileRefusal.status).toBe(404);
    const profileBody: unknown = await profileRefusal.json();
    expect(JSON.stringify(profileBody)).toContain("This browser profile is no longer available.");
    await db
      .updateTable("browserProfiles")
      .set({ archivedAt: null })
      .where("id", "=", profile.id)
      .execute();
    await db
      .updateTable("runners")
      .set({ revokedAt: new Date() })
      .where("id", "=", runtime.runnerId)
      .execute();
    const computerRefusal = await command();
    expect(computerRefusal.status).toBe(409);
    const computerBody: unknown = await computerRefusal.json();
    expect(JSON.stringify(computerBody)).toContain("This browser computer was retired.");
    await db
      .updateTable("runners")
      .set({ revokedAt: null })
      .where("id", "=", runtime.runnerId)
      .execute();
    const before = runtime.connectionCount();
    const reopenKey = randomUUID();
    const result = await testRpcData(
      host.origin,
      "commands.dispatch",
      { type: "workspace.tab.reopen", idempotencyKey: reopenKey },
      { headers: host.ownerHeaders },
    );
    expect(
      await testRpcData(
        host.origin,
        "commands.dispatch",
        { type: "workspace.tab.reopen", idempotencyKey: reopenKey },
        { headers: host.ownerHeaders },
      ),
    ).toMatchObject({
      type: "workspace.tab.reopen",
      tabId: result.type === "workspace.tab.reopen" ? result.tabId : "unexpected",
    });
    if (result.type !== "workspace.tab.reopen") throw new Error("Unexpected reopen");
    expect(result.tabId).not.toBe(first);
    expect(result.group.session).toMatchObject({
      id: sessionId,
      profileId: profile.id,
      workspaceId: run.workspaceId,
    });
    expect(result.group.tabs?.find((tab) => tab.id === result.tabId)).toMatchObject({
      title: "Saved",
      state: "suspended",
    });
    expect(runtime.connectionCount()).toBe(before);
    expect(await tabs.get(ownerId, first)).toBeNull();
    expect((await command()).status).toBe(404);
    const catalog = await testRpcData(
      host.origin,
      "browser.tabs.get",
      { sessionId },
      { headers: host.ownerHeaders },
    );
    const legacyClose = testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "browser.tab.close",
        sessionId,
        surfaceId: BrowserSurfaceIdSchema.parse("page-integration"),
        expectedGeneration: catalog.generation,
        expectedRevision: catalog.inventoryRevision ?? catalog.revision,
        idempotencyKey: randomUUID(),
      },
      { headers: host.ownerHeaders },
    );
    void legacyClose.catch(() => undefined);
    await expect
      .poll(() => runtime.receivedCommands().some((command) => command.type === "cdp.command"))
      .toBe(true);
    const closeCommand = runtime
      .receivedCommands()
      .find((command) => command.type === "cdp.command")!;
    runtime.sendServer({
      type: "cdp.result",
      requestId: closeCommand.requestId,
      result: { outcome: "tab-closed" },
    });
    expect(await legacyClose).toMatchObject({ type: "browser.tab.close" });
    expect((await command()).status).toBe(404);
    const directory = join(tmpdir(), `opensteer-reopen-host-${process.pid}`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify(
        { profileRefusal: profileBody, computerRefusal: computerBody, result, connections: before },
        null,
        2,
      ),
    );
    console.info(`Reopen Host evidence: ${directory}`);
  });
});
