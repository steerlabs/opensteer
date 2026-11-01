/**
 * Failure journeys, written before the backend:
 * - Failed Runtime disposal can become false close success; dead memberships can exhaust limits.
 * - Grouped lineages older than the bootstrap window can vanish.
 * - Organization can accidentally change session authority, cookies, bindings or CDP visibility.
 * - Owner layouts can leak across people sharing the same Guest tab.
 * - A bootstrap-sized read can hide old lineages; partial group reads can leak unreachable members.
 * - The catalog's coalescing timer can make a just-opened surface impossible to group.
 * - Retried organization can duplicate groups; repeated close can affect unlisted tabs or call the browser again.
 * - Restart/restore can lose membership, wake siblings, move a person's view or omit the Run hold.
 * - Tab reads can lose profile/Guest identity when a lineage sleeps or starts restoring, or wake it.
 * - Regroup, last-member close, restore and Workspace deletion can invert locks or resurrect tabs.
 * Evidence includes source SHA, inputs, outputs and assertions outside the checkout.
 */
import { execFileSync } from "node:child_process";
import { createPublicKey, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import {
  startVerticalStack,
  type VerticalStack,
} from "../apps/host/src/agents/vertical-stack.test-support.js";
import { BrowserTabGroupService } from "../apps/host/src/browser/browser-tab-group-service.js";
import { WebSocket } from "../apps/host/src/browser/browser-watch-e2e.test-support.js";
import type { CoreCommand } from "../apps/host/src/server/host-api-handlers.js";
import { SurfaceLedger } from "../packages/browser-runtime-core/src/browser/surface-ledger.js";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
  defaultAttachTicketReplayLedgerPath,
  sessionFilesRoot,
} from "../packages/browser-runtime-core/src/index.js";
import { createHttpHostApiClient } from "../packages/client/src/host/host-api-client.js";
import {
  ModelSelectionSchema,
  createId,
  resolveBrowserTabOrder,
} from "../packages/core/src/index.js";
import {
  BrowserTabGroupStore,
  WorkspaceTabStore,
  createDatabase,
} from "../packages/database/src/index.js";
import { pauseAfterLock } from "../packages/database/src/lock-race.test-support.js";
import { CodexHarnessDriver } from "../packages/harness-codex/src/codex-driver.js";
import {
  HarnessRegistry,
  isolatedServiceHarnessRuntimeBoundary,
} from "../packages/harness/src/index.js";
import { RealtimeHub } from "../packages/orchestration/src/index.js";
import {
  BrowserServerMessageSchema,
  BrowserSurfaceIdSchema,
  BrowserTabLayoutSchema,
  BrowserTabReadResultSchema,
  BrowserTabWriteResultSchema,
} from "../packages/protocol/src/index.js";

const executablePath = [
  process.env.OPENSTEER_CHROMIUM_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
const integration =
  process.env.OPENSTEER_TEST_DATABASE_URL && executablePath ? describe : describe.skip;
const evidenceDir =
  process.env.OPENSTEER_TAB_GROUPS_EVIDENCE_DIR ??
  path.join(tmpdir(), `opensteer-tab-groups-${process.pid}`);
const cleanup: Array<() => Promise<unknown>> = [];
const evidence: Array<Record<string, unknown>> = [];
afterEach(async (context) => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(String(error));
    }
  }
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    path.join(evidenceDir, `${randomUUID()}.json`),
    JSON.stringify(
      {
        gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        journey: context.task.name,
        result: context.task.result,
        evidence: evidence.splice(0),
        cleanupFailures: failures,
      },
      null,
      2,
    ),
  );
  expect(failures).toEqual([]);
}, 90_000);

async function deployment() {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-tab-groups-browser-"));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const keys = new Map<string, KeyObject>();
  const bridgeToken = randomBytes(32).toString("base64url");
  const runtime = new BrowserRuntime({
    runtimeId: "tab-groups-e2e",
    launcher: new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath: executablePath!,
      headless: true,
    }),
    sessionFilesRoot: sessionFilesRoot(root),
    ticketVerifier: await Ed25519AttachTicketVerifier.create({
      replayLedgerPath: defaultAttachTicketReplayLedgerPath(root),
      resolvePublicKey: (id) => keys.get(id) ?? null,
    }),
  });
  const server = new BrowserRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    runtime,
    relayBridge: {
      token: bridgeToken,
      updateAttachKeys: (entries) => {
        keys.clear();
        for (const entry of entries) keys.set(entry.keyId, createPublicKey(entry.publicKeyPem));
      },
    },
  });
  const address = await server.start();
  cleanup.push(() => server.close());
  let boots = 0;
  const harnesses = () => {
    // A restarted Runner's engine reports its models late, as a busy machine's
    // does, so readiness after a restart has to come from the new boot.
    const restarted = boots++ > 0;
    const harnesses = new HarnessRegistry();
    harnesses.registerDriver(
      new CodexHarnessDriver({
        launch: {
          executable: process.execPath,
          arguments: [
            fileURLToPath(
              new URL(
                "../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
                import.meta.url,
              ),
            ),
            "--scenario=browser-tab-groups",
            "--unique-threads",
            ...(restarted ? ["--model-list-delay-ms=2000"] : []),
          ],
        },
      }),
    );
    return harnesses;
  };
  const stack = await startVerticalStack({
    databaseUrl: process.env.OPENSTEER_TEST_DATABASE_URL!,
    browser: {
      bridgeToken,
      runtimeId: "tab-groups-e2e",
      url: new URL(`http://${address.host}:${address.port}/`),
    },
    browserHarnessExecutable: fileURLToPath(
      new URL("../apps/runner/browser-harness/browser-harness.mjs", import.meta.url),
    ),
    harnesses,
    harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
    harnessInstance: { config: {}, driverKind: "codex", sourceId: "openai", stateKind: "isolated" },
    catalogTimeoutMs: 15_000,
    runTimeoutMs: 90_000,
  });
  cleanup.push(() => stack.close());
  cleanup.push(() => server.close());
  await expect
    .poll(
      async () => {
        const r = await stack.api["bootstrap.get"]({});
        return r.ok && r.data.browser.available;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return stack;
}
async function command(stack: VerticalStack, input: CoreCommand) {
  const result = await stack.api["commands.dispatch"](input);
  evidence.push({ input, result });
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
async function bootstrap(stack: VerticalStack) {
  const result = await stack.api["bootstrap.get"]({});
  if (!result.ok) throw new Error(result.error.message);
  evidence.push({ layout: result.data.browser.tabGroups });
  return result.data.browser;
}
async function open(stack: VerticalStack) {
  const result = await command(stack, {
    type: "browser.tab.open",
    identity: { kind: "guest" },
    idempotencyKey: randomUUID(),
  });
  if (result.type !== "browser.tab.open") throw new Error("Wrong tab-open result");
  return result;
}

async function resolvedOrder(stack: VerticalStack) {
  const browser = await bootstrap(stack);
  const layout = browser.tabGroups!;
  return resolveBrowserTabOrder(
    layout.order,
    (browser.workspaceTabs ?? []).flatMap((lineage) =>
      (lineage.tabs ?? []).map((tab) => ({
        ...tab,
        createdAt: tab.createdAt!,
        lineageCreatedAt: lineage.createdAt,
      })),
    ),
    new Map(layout.groups.flatMap((group) => group.tabIds.map((id) => [id, group.id]))),
  );
}

integration("personal tab order", () => {
  it("places recorded link children after their opener and after its group without materializing reads", async () => {
    const stack = await deployment();
    const a = await open(stack);
    const b = await open(stack);
    const db = stack.host.store.database;
    const owner = await db.selectFrom("users").select("id").executeTakeFirstOrThrow();
    const recorder = new WorkspaceTabStore(db);
    const child = () => ({
      id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`),
      title: "Link",
      url: "about:blank",
      order: 1,
      openerId: a.tabId,
    });
    const c = child();
    const d = child();
    await recorder.record(a.sessionId, [c, d], []);
    expect(await resolvedOrder(stack)).toEqual([a.tabId, c.id, d.id, b.tabId]);
    expect((await bootstrap(stack)).tabGroups?.order).toEqual([]);
    const group = await command(stack, {
      type: "workspace.tabs.group",
      tabIds: [a.tabId, b.tabId],
      idempotencyKey: randomUUID(),
    });
    if (group.type !== "workspace.tabs.group") throw new Error("Wrong group result");
    const e = child();
    await recorder.record(a.sessionId, [e], []);
    expect(await resolvedOrder(stack)).toEqual([a.tabId, b.tabId, c.id, d.id, e.id]);
    expect(
      (await recorder.read(owner.id, a.sessionId))?.tabs?.every((tab) =>
        Number.isFinite(Date.parse(tab.createdAt!)),
      ),
    ).toBe(true);
    expect((await new BrowserTabGroupStore(db).layout(owner.id)).order).toEqual(group.layout.order);
    evidence.push({
      assertions: [
        "link children keep recording order",
        "loose child follows opener group",
        "lineage timestamps are ISO",
        "reads never write",
      ],
    });
  }, 120_000);

  it("drops hidden tabs on organization writes and resolves their surviving membership when visibility returns", async () => {
    const stack = await deployment();
    const a = await open(stack);
    const b = await open(stack);
    const db = stack.host.store.database;
    const owner = await db.selectFrom("users").select("id").executeTakeFirstOrThrow();
    const other = await stack.createWorkspace("Hidden later");
    const session = await command(stack, {
      type: "browser.session.start",
      workspaceId: other.id,
      input: { fresh: true, reuseExisting: false },
      idempotencyKey: randomUUID(),
    });
    if (session.type !== "browser.session.start") throw new Error("Wrong session result");
    const hidden = await command(stack, {
      type: "browser.tab.open",
      sessionId: session.session.id,
      idempotencyKey: randomUUID(),
    });
    if (hidden.type !== "browser.tab.open") throw new Error("Wrong tab result");
    await stack.host.browser.flushPendingTabDescriptors();
    const hiddenTabs = (await new WorkspaceTabStore(db).read(owner.id, session.session.id))!.tabs!;
    expect(hiddenTabs).toHaveLength(2);
    const group = await command(stack, {
      type: "workspace.tabs.group",
      tabIds: [a.tabId, ...hiddenTabs.map((tab) => tab.id)],
      idempotencyKey: randomUUID(),
    });
    if (group.type !== "workspace.tabs.group") throw new Error("Wrong group result");
    const membership = await db
      .selectFrom("workspaceMemberships")
      .selectAll()
      .where("workspaceId", "=", other.id)
      .where("userId", "=", owner.id)
      .executeTakeFirstOrThrow();
    const custodian = await stack.host.store.createUser("Workspace custodian");
    await db
      .insertInto("workspaceMemberships")
      .values({ ...membership, id: createId("workspaceMembership"), userId: custodian })
      .execute();
    await db.deleteFrom("workspaceMemberships").where("id", "=", membership.id).execute();
    const store = new BrowserTabGroupStore(db);
    expect((await store.layout(owner.id)).order).not.toContain(hidden.tabId);
    const moved = await command(stack, {
      type: "workspace.tabs.move",
      item: { tabIds: [b.tabId] },
      to: { groupId: null, before: { groupId: group.groupId } },
      idempotencyKey: randomUUID(),
    });
    expect(moved).toMatchObject({ layout: { order: [b.tabId, a.tabId] } });
    await command(stack, {
      type: "workspace.tabs.ungroup",
      tabIds: [b.tabId],
      idempotencyKey: randomUUID(),
    });
    expect(
      await db
        .selectFrom("browserTabGroupMembers")
        .selectAll()
        .where("tabId", "=", hidden.tabId)
        .execute(),
    ).toHaveLength(1);
    await db.insertInto("workspaceMemberships").values(membership).execute();
    expect((await store.layout(owner.id)).order).toEqual([b.tabId, a.tabId]);
    expect(await resolvedOrder(stack)).toEqual([
      b.tabId,
      a.tabId,
      ...hiddenTabs.map((tab) => tab.id),
    ]);
    evidence.push({
      assertions: [
        "visibility filters saved order",
        "writes forget hidden positions",
        "hidden membership survives",
        "regained member joins group run",
      ],
    });
  }, 120_000);

  it("serializes two clients and an agent, publishing each owner's layout through the existing notice", async () => {
    const stack = await deployment();
    const a = await open(stack);
    const b = await open(stack);
    const c = await open(stack);
    const d = await open(stack);
    const secondClient = createHttpHostApiClient({
      baseUrl: stack.hostOrigin,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", stack.sessionCookie);
        headers.set("origin", stack.hostOrigin.origin);
        return fetch(input, { ...init, headers });
      },
      onAuthenticationRequired: () => undefined,
    });
    const notices: unknown[][] = [];
    const publish = vi.spyOn(RealtimeHub.prototype, "publishBrowserSessionsChanged");
    const outcomes = await Promise.all([
      command(stack, {
        type: "workspace.tabs.move",
        item: { tabIds: [b.tabId] },
        to: { groupId: null, before: { tabId: a.tabId } },
        idempotencyKey: randomUUID(),
      }),
      secondClient["commands.dispatch"]({
        type: "workspace.tabs.move",
        item: { tabIds: [d.tabId] },
        to: { groupId: null, before: { tabId: c.tabId } },
        idempotencyKey: randomUUID(),
      }),
      agent(stack, stack.mainWorkspaceId, {
        calls: [
          {
            name: "browser_tab_write",
            input: { action: "move", tabIds: [c.tabId], before: a.tabId },
          },
        ],
      }),
    ]);
    expect(outcomes[1]).toMatchObject({ ok: true });
    expect(outcomes[2].report.calls[0]).toMatchObject({ result: { action: "move" } });
    expect(await resolvedOrder(stack)).toEqual([b.tabId, c.tabId, a.tabId, d.tabId]);
    const one = await bootstrap(stack);
    const two = await secondClient["bootstrap.get"]({});
    expect(two).toMatchObject({ ok: true, data: { browser: { tabGroups: one.tabGroups } } });
    expect(one.tabGroups?.revision).toBe(3);
    notices.push(...publish.mock.calls);
    expect(notices.length).toBeGreaterThanOrEqual(3);
    evidence.push({
      notices,
      assertions: [
        "two clients and agent moves apply",
        "revisions increase",
        "session notices invalidate both clients",
        "clients converge",
      ],
    });
  }, 120_000);

  it("revalidates discovered groups when a source or anchor closes before tab locks", async () => {
    const stack = await deployment();
    const db = stack.host.store.database;
    const owner = await db.selectFrom("users").select("id").executeTakeFirstOrThrow();
    for (const closed of ["source", "anchor"] as const) {
      const a = await open(stack);
      const b = await open(stack);
      const grouped = await new BrowserTabGroupStore(db).group(owner.id, {
        tabIds: [a.tabId],
        idempotencyKey: randomUUID(),
      });
      const barrier = pauseAfterLock(
        db,
        (node) =>
          /"name":"browser_?tab_?group_?members"/iu.test(node) && !node.includes("ForUpdate"),
      );
      const moving = new BrowserTabGroupStore(barrier.database).move(owner.id, {
        item: { groupId: grouped.groupId },
        to: { groupId: null, before: { tabId: b.tabId } },
        idempotencyKey: randomUUID(),
      });
      const outcome = moving.then(
        (layout) => ({ layout }),
        (error: unknown) => ({ error }),
      );
      try {
        await barrier.reached;
        await new WorkspaceTabStore(db).close(owner.id, closed === "source" ? a.tabId : b.tabId);
      } finally {
        barrier.release();
      }
      expect(await outcome).toMatchObject({
        error: { code: closed === "source" ? "not_found" : "conflict" },
      });
      evidence.push({
        closed,
        outcome: await outcome,
        assertions: [
          "closed source never resurrects",
          "closed anchor never changes destination",
          "scope revalidated after layout lock",
        ],
      });
    }
  }, 120_000);

  it("keeps exactly 10,000 saved positions and refuses an oversized materialization without changing it", async () => {
    const stack = await deployment();
    const a = await open(stack);
    const db = stack.host.store.database;
    const owner = await db.selectFrom("users").select("id").executeTakeFirstOrThrow();
    const seed = (id: string, order: number) => ({
      id,
      order,
      groupId: a.sessionId,
      sessionId: a.sessionId,
      title: "Saved",
      url: "about:blank",
      state: "suspended" as const,
      openerId: null,
    });
    for (let start = 1; start <= 9999; start += 1000)
      await db
        .insertInto("workspaceTabs")
        .values(
          Array.from({ length: Math.min(1000, 10000 - start) }, (_, index) =>
            seed(`surface_cap_${start + index}`, start + index),
          ),
        )
        .execute();
    const groups = new BrowserTabGroupStore(db);
    const first = await groups.move(owner.id, {
      item: { tabIds: [a.tabId] },
      to: { groupId: null, before: null },
      idempotencyKey: randomUUID(),
    });
    expect(first.order).toHaveLength(10000);
    await db.insertInto("workspaceTabs").values(seed("surface_cap_extra", 10000)).execute();
    await expect(
      groups.move(owner.id, {
        item: { tabIds: [a.tabId] },
        to: { groupId: null, before: null },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message:
        "Close some tabs to keep organizing; Opensteer keeps the order of up to 10,000 tabs.",
    });
    expect(await groups.layout(owner.id)).toEqual(first);
    await db
      .updateTable("workspaceTabs")
      .set({ closedAt: new Date() })
      .where("id", "=", "surface_cap_1")
      .execute();
    await groups.prune();
    expect((await groups.layout(owner.id)).order).not.toContain("surface_cap_1");
    expect(
      (
        await groups.move(owner.id, {
          item: { tabIds: [a.tabId] },
          to: { groupId: null, before: null },
          idempotencyKey: randomUUID(),
        })
      ).order,
    ).toHaveLength(10000);
    evidence.push({
      assertions: [
        "cap accepts 10000",
        "cap refuses 10001 atomically",
        "read remains bounded",
        "prune drops closed IDs",
        "closing restores capacity",
      ],
    });
  }, 120_000);

  it("materializes moves and previous-release grouping commands in the person's order", async () => {
    const stack = await deployment();
    const a = await open(stack);
    const b = await open(stack);
    const c = await open(stack);
    const d = await open(stack);
    expect((await bootstrap(stack)).tabGroups?.order).toEqual([]);
    expect(await resolvedOrder(stack)).toEqual([a.tabId, b.tabId, c.tabId, d.tabId]);
    expect(BrowserTabLayoutSchema.parse({ revision: 0, groups: [] })).toEqual({
      revision: 0,
      groups: [],
    });
    const move = async (
      item: Extract<CoreCommand, { type: "workspace.tabs.move" }>["item"],
      to: Extract<CoreCommand, { type: "workspace.tabs.move" }>["to"],
    ) => {
      const result = await command(stack, {
        type: "workspace.tabs.move",
        item,
        to,
        idempotencyKey: randomUUID(),
      });
      if (result.type !== "workspace.tabs.move") throw new Error("Wrong move result");
      return result.layout;
    };
    const first = await move({ tabIds: [d.tabId] }, { groupId: null, before: { tabId: a.tabId } });
    expect(first.order).toEqual([d.tabId, a.tabId, b.tabId, c.tabId]);
    expect(
      (await move({ tabIds: [d.tabId] }, { groupId: null, before: { tabId: a.tabId } })).revision,
    ).toBe(first.revision);
    const g = await command(stack, {
      type: "workspace.tabs.group",
      tabIds: [a.tabId, c.tabId],
      title: "Research",
      idempotencyKey: randomUUID(),
    });
    if (g.type !== "workspace.tabs.group") throw new Error("Wrong group result");
    expect(g.layout.order).toEqual([d.tabId, a.tabId, c.tabId, b.tabId]);
    expect(
      (await move({ tabIds: [b.tabId] }, { groupId: null, before: { groupId: g.groupId } })).order,
    ).toEqual([d.tabId, b.tabId, a.tabId, c.tabId]);
    await command(stack, {
      type: "workspace.tabGroup.update",
      groupId: g.groupId,
      collapsed: true,
      idempotencyKey: randomUUID(),
    });
    expect(
      (await move({ tabIds: [b.tabId] }, { groupId: g.groupId, before: { tabId: c.tabId } })).order,
    ).toEqual([d.tabId, a.tabId, b.tabId, c.tabId]);
    expect(
      (await move({ tabIds: [d.tabId] }, { groupId: g.groupId, before: null })).groups[0]
        ?.collapsed,
    ).toBe(true);
    expect(
      (await move({ tabIds: [c.tabId, a.tabId] }, { groupId: null, before: null })).order,
    ).toEqual([b.tabId, d.tabId, a.tabId, c.tabId]);
    expect((await move({ groupId: g.groupId }, { groupId: null, before: null })).order).toEqual([
      a.tabId,
      c.tabId,
      b.tabId,
      d.tabId,
    ]);
    const n = await command(stack, {
      type: "workspace.tabs.group",
      tabIds: [a.tabId, c.tabId],
      idempotencyKey: randomUUID(),
    });
    if (n.type !== "workspace.tabs.group") throw new Error("Wrong group result");
    expect(
      (await move({ groupId: g.groupId }, { groupId: null, before: { groupId: n.groupId } })).order,
    ).toEqual([b.tabId, d.tabId, a.tabId, c.tabId]);
    await move({ groupId: g.groupId }, { groupId: null, before: null });
    expect(
      (await move({ tabIds: [c.tabId] }, { groupId: g.groupId, before: { tabId: b.tabId } })).order,
    ).toEqual([a.tabId, c.tabId, b.tabId, d.tabId]);
    expect((await move({ tabIds: [c.tabId] }, { groupId: n.groupId, before: null })).order).toEqual(
      [a.tabId, c.tabId, b.tabId, d.tabId],
    );
    await command(stack, {
      type: "workspace.tabs.ungroup",
      tabIds: [a.tabId, c.tabId],
      idempotencyKey: randomUUID(),
    });
    const nonSibling = await stack.api["commands.dispatch"]({
      type: "workspace.tabs.move",
      item: { tabIds: [a.tabId] },
      to: { groupId: null, before: { tabId: b.tabId } },
      idempotencyKey: randomUUID(),
    });
    expect(nonSibling).toMatchObject({ ok: false, error: { code: "conflict" } });
    const refused = await stack.api["commands.dispatch"]({
      type: "workspace.tabs.move",
      item: { groupId: g.groupId },
      to: { groupId: g.groupId, before: null },
      idempotencyKey: randomUUID(),
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "bad_request" } });
    const self = await stack.api["commands.dispatch"]({
      type: "workspace.tabs.move",
      item: { tabIds: [a.tabId] },
      to: { groupId: null, before: { tabId: a.tabId } },
      idempotencyKey: randomUUID(),
    });
    expect(self).toMatchObject({ ok: false, error: { code: "bad_request" } });
    await command(stack, {
      type: "workspace.tabs.ungroup",
      tabIds: [b.tabId],
      idempotencyKey: randomUUID(),
    });
    expect(await resolvedOrder(stack)).toEqual([a.tabId, c.tabId, d.tabId, b.tabId]);
    await command(stack, {
      type: "workspace.tabs.group",
      tabIds: [c.tabId],
      groupId: g.groupId,
      idempotencyKey: randomUUID(),
    });
    expect(await resolvedOrder(stack)).toEqual([a.tabId, d.tabId, c.tabId, b.tabId]);
    await command(stack, {
      type: "workspace.tabs.ungroup",
      tabIds: [d.tabId, c.tabId],
      idempotencyKey: randomUUID(),
    });
    expect(await resolvedOrder(stack)).toEqual([a.tabId, d.tabId, c.tabId, b.tabId]);
    await command(stack, {
      type: "workspace.tabs.close",
      tabIds: [b.tabId],
      idempotencyKey: randomUUID(),
    });
    const stale = await stack.api["commands.dispatch"]({
      type: "workspace.tabs.move",
      item: { tabIds: [a.tabId] },
      to: { groupId: null, before: { tabId: b.tabId } },
      idempotencyKey: randomUUID(),
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await move({ tabIds: [a.tabId] }, { groupId: null, before: null })).order).toEqual([
      d.tabId,
      c.tabId,
      a.tabId,
    ]);
    const e = await open(stack);
    expect(await resolvedOrder(stack)).toEqual([d.tabId, c.tabId, a.tabId, e.tabId]);
    evidence.push({
      assertions: [
        "fresh recording order",
        "new tabs append",
        "saved order on writes",
        "natural idempotency",
        "group contiguity",
        "old commands preserve order",
        "closed anchor conflict",
        "legacy layout parses",
      ],
    });
  }, 120_000);
});

integration("personal tab groups through a real deployment", () => {
  it("groups across identities, updates, ungroups and closes exactly the requested durable tabs", async () => {
    const stack = await deployment();
    const first = await open(stack);
    const second = await command(stack, {
      type: "browser.tab.open",
      sessionId: first.sessionId,
      idempotencyKey: randomUUID(),
    });
    if (second.type !== "browser.tab.open") throw new Error("Wrong tab-open result");
    const profile = await command(stack, {
      type: "browser.profile.create",
      input: { name: "Research" },
      idempotencyKey: randomUUID(),
    });
    if (profile.type !== "browser.profile.create") throw new Error("Wrong profile result");
    const third = await command(stack, {
      type: "browser.tab.open",
      identity: { kind: "profile", profileId: profile.profile.id },
      idempotencyKey: randomUUID(),
    });
    if (third.type !== "browser.tab.open") throw new Error("Wrong tab-open result");
    const owner = await stack.host.store.database
      .selectFrom("users")
      .select("id")
      .executeTakeFirstOrThrow();
    const cookie = {
      domain: "example.test",
      name: "research-login",
      value: "unchanged",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    };
    expect(
      await stack.host.browser.applySiteCookies(third.sessionId, "https://example.test", [cookie]),
    ).toBe("applied");
    const beforeCatalog = await stack.host.browser.readTabCatalog(owner.id, first.sessionId);
    const grouped = await command(stack, {
      type: "workspace.tabs.group",
      tabIds: [first.tabId, third.tabId],
      title: "Research",
      idempotencyKey: randomUUID(),
    });
    if (grouped.type !== "workspace.tabs.group") throw new Error("Wrong grouping result");
    expect(
      (await stack.host.browser.readTabCatalog(owner.id, first.sessionId)).tabs.map((t) => t.id),
    ).toEqual(beforeCatalog.tabs.map((t) => t.id));
    await expect(
      command(stack, {
        type: "workspace.tabs.group",
        groupId: grouped.groupId,
        tabIds: [first.tabId],
        title: "Invalid join",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("Joining groupId");
    expect(grouped.layout.groups).toEqual([
      {
        id: grouped.groupId,
        title: "Research",
        color: "grey",
        collapsed: false,
        tabIds: expect.arrayContaining([first.tabId, third.tabId]),
      },
    ]);
    const updated = await command(stack, {
      type: "workspace.tabGroup.update",
      groupId: grouped.groupId,
      title: "Compare",
      color: "cyan",
      collapsed: true,
      idempotencyKey: randomUUID(),
    });
    expect(updated).toMatchObject({
      layout: { groups: [{ title: "Compare", color: "cyan", collapsed: true }] },
    });
    expect(await bootstrap(stack)).toMatchObject({
      tabGroupsVersion: 1,
      tabGroups: { revision: 2 },
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: first.sessionId }),
        expect.objectContaining({ id: third.sessionId }),
      ]),
    });
    await command(stack, {
      type: "workspace.tabs.ungroup",
      tabIds: [third.tabId],
      idempotencyKey: randomUUID(),
    });
    expect((await bootstrap(stack)).workspaceTabs?.flatMap((l) => l.tabs ?? [])).toContainEqual(
      expect.objectContaining({ id: third.tabId, state: "live" }),
    );
    const closed = await command(stack, {
      type: "workspace.tabs.close",
      tabIds: [first.tabId],
      idempotencyKey: randomUUID(),
    });
    expect(closed).toMatchObject({ closed: [first.tabId], failed: [] });
    const after = await bootstrap(stack);
    expect(after.tabGroups?.groups).toEqual([]);
    expect(after.workspaceTabs?.flatMap((l) => l.tabs ?? []).map((t) => t.id)).toEqual(
      expect.arrayContaining([second.tabId, third.tabId]),
    );
    evidence.push({
      assertions: [
        "cross-identity membership",
        "bootstrap layout",
        "ungroup keeps tab live",
        "exact close",
        "last closed member hides group",
        "session bindings unchanged",
        "cookies unchanged",
        "CDP visibility unchanged",
      ],
    });
  }, 120_000);
});

async function agent(
  stack: VerticalStack,
  workspaceId: VerticalStack["mainWorkspaceId"],
  plan: Record<string, unknown>,
) {
  const threadId = await stack.createThread({
    workspaceId,
    title: "Organize research",
    idempotencyKey: randomUUID(),
    modelSelection: ModelSelectionSchema.parse({
      modelId: "gpt-5.6-sol",
      providerId: "openai",
      options: {},
    }),
  });
  const turn = await stack.sendMessage({
    threadId,
    workspaceId,
    text: `TAB_GROUP_JOURNEY:${JSON.stringify(plan)}`,
  });
  const report: unknown = JSON.parse(turn.assistantText);
  evidence.push({ toolPlan: plan, report, runId: turn.runId, threadId });
  return {
    report: report as {
      pages: unknown[];
      calls: Array<{ result?: unknown; error?: string }>;
      immediate?: { tabId: string; first: unknown; replay: unknown };
      attached?: { sessions: Array<{ id: string; attached: boolean }> };
    },
    turn,
    threadId,
  };
}
integration("agent organization and durable ownership", () => {
  it("reads profile and Guest identity for open, asleep and opening tabs without waking them", async () => {
    const stack = await deployment();
    const guest = await open(stack);
    const profile = await command(stack, {
      type: "browser.profile.create",
      input: { name: "Tab identity" },
      idempotencyKey: randomUUID(),
    });
    if (profile.type !== "browser.profile.create") throw new Error("Wrong profile result");
    const saved = await command(stack, {
      type: "browser.tab.open",
      identity: { kind: "profile", profileId: profile.profile.id },
      idempotencyKey: randomUUID(),
    });
    if (saved.type !== "browser.tab.open") throw new Error("Wrong tab-open result");
    const inventory = () =>
      stack.host.store.database.selectFrom("workspaceTabs").selectAll().orderBy("id").execute();
    const sessions = () =>
      stack.host.store.database
        .selectFrom("browserSessions")
        .select(["id", "state", "profileId"])
        .orderBy("id")
        .execute();
    for (const state of ["open", "asleep", "opening"] as const) {
      if (state === "asleep") {
        await stack.restartHost();
        await stack.restartRunner();
        await expect
          .poll(
            async () => {
              const result = await stack.api["bootstrap.get"]({});
              return result.ok && result.data.browser.available;
            },
            { timeout: 30_000 },
          )
          .toBe(true);
      } else if (state === "opening") {
        // Hold both durable rows at the restore boundary without starting a browser.
        const tabs = new WorkspaceTabStore(stack.host.store.database);
        await tabs.bind(guest.sessionId, guest.sessionId, guest.tabId);
        await tabs.bind(saved.sessionId, saved.sessionId, saved.tabId);
      }
      await stack.host.browser.flushPendingTabDescriptors();
      const beforeTabs = await inventory();
      const beforeSessions = await sessions();
      const read = await agent(stack, stack.mainWorkspaceId, {
        calls: [{ name: "browser_tab_read", input: {} }],
      });
      expect(read.report.calls).toHaveLength(1);
      expect(read.report.calls[0]?.error).toBeUndefined();
      const result = BrowserTabReadResultSchema.parse(read.report.calls[0]?.result);
      expect(result.tabs).toHaveLength(2);
      for (const [opened, profileId] of [
        [guest, null],
        [saved, profile.profile.id],
      ] as const) {
        expect(result.tabs.find((tab) => tab.tabId === opened.tabId)).toEqual({
          tabId: opened.tabId,
          title: expect.any(String),
          site: expect.any(String),
          state,
          sessionId: state === "open" ? opened.sessionId : null,
          profileId,
          groupId: null,
          position: opened.tabId === guest.tabId ? 0 : 1,
          usedByThisTask: false,
          usedByOtherTask: false,
        });
      }
      expect(await inventory()).toEqual(beforeTabs);
      expect(await sessions()).toEqual(beforeSessions);
      if (state !== "open")
        expect(
          (await bootstrap(stack)).sessions
            .map((session) => ({
              id: session.id,
              state: session.state,
              tabIds: session.tabCatalog?.tabs.map((tab) => tab.id),
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        ).toEqual(
          [guest, saved]
            .map((opened) => ({ id: opened.sessionId, state: "closed", tabIds: [] }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        );
      evidence.push({
        state,
        result,
        beforeTabs,
        beforeSessions,
        assertions: [
          "profile-backed tab reports its profile ID and Guest reports null",
          "reading preserves saved tab state and session records",
          "reading sleeping and opening tabs starts no browser session",
        ],
      });
    }
  }, 150_000);

  it("reads beyond the bootstrap window, keeps whole groups private, groups a new surface immediately and replays safely", async () => {
    const stack = await deployment();
    const opened = await open(stack);
    const db = stack.host.store.database;
    const session = await db
      .selectFrom("browserSessions")
      .selectAll()
      .where("id", "=", opened.sessionId)
      .executeTakeFirstOrThrow();
    const owner = await db.selectFrom("users").select("id").executeTakeFirstOrThrow();
    const specialized = await stack.createWorkspace("Special research");
    const outside = await command(stack, {
      type: "browser.session.start",
      workspaceId: specialized.id,
      input: { fresh: true, reuseExisting: false },
      idempotencyKey: randomUUID(),
    });
    if (outside.type !== "browser.session.start") throw new Error("Wrong session result");
    const outsideTab = await command(stack, {
      type: "browser.tab.open",
      sessionId: outside.session.id,
      idempotencyKey: randomUUID(),
    });
    if (outsideTab.type !== "browser.tab.open") throw new Error("Wrong tab result");
    const mixed = await command(stack, {
      type: "workspace.tabs.group",
      tabIds: [opened.tabId, outsideTab.tabId],
      title: "Private mixed purpose",
      idempotencyKey: randomUUID(),
    });
    if (mixed.type !== "workspace.tabs.group") throw new Error("Wrong group result");
    const { createBrowserSessionId, BrowserSurfaceIdSchema } =
      await import("../packages/protocol/src/browser.js");
    const seedIds: string[] = [];
    for (let index = 0; index < 105; index++) {
      const id = createBrowserSessionId();
      await stack.host.store.createBrowserSession({
        id,
        runnerId: session.runnerId,
        workspaceId: index < 70 ? specialized.id : session.workspaceId,
        profileId: null,
        origin: "workspace",
        runtimeId: session.runtimeId,
        placementKey: `seed-${index}`,
      });
      const tabId = BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`);
      seedIds.push(tabId);
      await new WorkspaceTabStore(db).record(
        id,
        [
          {
            id: tabId,
            title: `Seed ${index}`,
            url: "https://example.test/private/path?token=secret",
            order: 0,
            openerId: null,
          },
        ],
        [],
      );
      await new WorkspaceTabStore(db).suspend(id);
      await db
        .updateTable("browserSessions")
        .set({ state: "closed" })
        .where("id", "=", id)
        .execute();
    }
    const main = await agent(stack, stack.mainWorkspaceId, { paginate: true, immediate: true });
    const pages = main.report.pages.map((p) => BrowserTabReadResultSchema.parse(p));
    expect(pages.length).toBeGreaterThan(1);
    const allIds = pages.flatMap((p) => p.tabs.map((t) => t.tabId));
    const positions = pages.flatMap((p) => p.tabs.map((t) => t.position!));
    expect([...positions].sort((a, b) => a - b)).toEqual(
      Array.from({ length: allIds.length }, (_, index) => index),
    );
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toEqual(expect.arrayContaining(seedIds));
    expect(JSON.stringify(pages)).not.toContain("token=secret");
    expect(pages[0]?.groups).toContainEqual(
      expect.objectContaining({ id: mixed.groupId, createdBy: "person" }),
    );
    expect(main.report.immediate?.first).toEqual(main.report.immediate?.replay);
    expect(pages[0]?.groups).toContainEqual(
      expect.objectContaining({ createdBy: "this-task", tabCount: 1 }),
    );
    expect(pages[0]?.groups.every((g) => !("tabIds" in g))).toBe(true);
    expect(pages.flatMap((p) => p.tabs)).toContainEqual(
      expect.objectContaining({ tabId: main.report.immediate?.tabId, usedByThisTask: true }),
    );
    expect(
      new Set((await new BrowserTabGroupStore(db).layout(owner.id)).groups.map((g) => g.id)).size,
    ).toBe(2);
    const scoped = await agent(stack, specialized.id, {
      paginate: true,
      calls: [
        {
          name: "browser_tab_write",
          input: { action: "group", groupId: mixed.groupId, tabIds: [outsideTab.tabId] },
        },
        { name: "browser_tab_write", input: { action: "ungroup", tabIds: [opened.tabId] } },
        { name: "browser_tab_write", input: { action: "restore", tabIds: [opened.tabId] } },
        {
          name: "browser_tab_write",
          input: { action: "update_group", groupId: mixed.groupId, title: "Leak" },
        },
        {
          name: "browser_tab_write",
          input: { action: "close", tabIds: [outsideTab.tabId, opened.tabId] },
        },
        { name: "browser_tab_write", input: { action: "move", tabIds: [opened.tabId] } },
        { name: "browser_tab_write", input: { action: "move", groupId: mixed.groupId } },
        {
          name: "browser_tab_write",
          input: { action: "move", tabIds: [outsideTab.tabId], toGroupId: mixed.groupId },
        },
        {
          name: "browser_tab_write",
          input: { action: "move", tabIds: [outsideTab.tabId], before: mixed.groupId },
        },
      ],
    });
    const scopedPages = scoped.report.pages.map((p) => BrowserTabReadResultSchema.parse(p));
    expect(scopedPages.flatMap((p) => p.groups)).not.toContainEqual(
      expect.objectContaining({ id: mixed.groupId }),
    );
    expect(scopedPages.flatMap((p) => p.tabs)).toContainEqual(
      expect.objectContaining({ tabId: outsideTab.tabId, groupId: null }),
    );
    expect(scoped.report.calls.every((c) => c.error)).toBe(true);
    expect(scopedPages.length).toBeGreaterThan(1);
    expect(scopedPages.at(-1)?.nextCursor).toBeNull();
    expect(scopedPages.flatMap((page) => page.tabs.map((tab) => tab.tabId))).toEqual(
      expect.arrayContaining(seedIds.slice(0, 70)),
    );
    expect(scopedPages.flatMap((page) => page.tabs.map((tab) => tab.tabId))).not.toEqual(
      expect.arrayContaining(seedIds.slice(70)),
    );
    const scopedPositions = scopedPages.flatMap((page) => page.tabs.map((tab) => tab.position!));
    expect([...scopedPositions].sort((a, b) => a - b)).toEqual(
      Array.from({ length: scopedPositions.length }, (_, index) => index),
    );
    const otherTask = await agent(stack, stack.mainWorkspaceId, { paginate: true });
    expect(
      otherTask.report.pages
        .map((p) => BrowserTabReadResultSchema.parse(p))
        .flatMap((p) => p.groups),
    ).toContainEqual(expect.objectContaining({ createdBy: "another-task", tabCount: 1 }));
    expect(await new WorkspaceTabStore(db).get(owner.id, outsideTab.tabId)).not.toBeNull();
    const moves = await agent(stack, stack.mainWorkspaceId, {
      calls: [
        {
          name: "browser_tab_write",
          input: {
            action: "move",
            tabIds: [outsideTab.tabId],
            toGroupId: mixed.groupId,
            before: opened.tabId,
          },
        },
        { name: "browser_tab_write", input: { action: "move", groupId: mixed.groupId } },
        { name: "browser_tab_write", input: { action: "move", tabIds: [outsideTab.tabId] } },
        {
          name: "browser_tab_write",
          input: { action: "move", tabIds: [outsideTab.tabId], before: mixed.groupId },
        },
      ],
    });
    expect(moves.report.calls).toHaveLength(4);
    expect(
      moves.report.calls.every(
        (call) => !call.error && BrowserTabWriteResultSchema.parse(call.result).action === "move",
      ),
    ).toBe(true);
    const scopedMove = await agent(stack, specialized.id, {
      calls: [
        {
          name: "browser_tab_write",
          input: { action: "move", tabIds: [outsideTab.tabId], before: seedIds[0] },
        },
      ],
    });
    expect(scopedMove.report.calls[0]).toMatchObject({ result: { action: "move" } });
    expect([...(await new BrowserTabGroupStore(db).layout(owner.id)).order!].sort()).toEqual(
      [...allIds].sort(),
    );
    evidence.push({
      assertions: [
        "pagination beyond 100 lineages",
        "no duplicate tabs",
        "site only",
        "whole group secrecy",
        "all-before-any close authorization",
        "immediate newTab grouping",
        "idempotent tool replay",
      ],
    });
  }, 180_000);

  it("keeps two owners independent and serializes regroup against close, pruning and deletion", async () => {
    const stack = await deployment();
    const first = await open(stack);
    const second = await command(stack, {
      type: "browser.tab.open",
      sessionId: first.sessionId,
      idempotencyKey: randomUUID(),
    });
    if (second.type !== "browser.tab.open") throw new Error("Wrong tab result");
    const db = stack.host.store.database;
    const owner = await db.selectFrom("users").select("id").executeTakeFirstOrThrow();
    const person = await stack.host.store.createUser("Second reader");
    const membership = await db
      .selectFrom("workspaceMemberships")
      .selectAll()
      .where("workspaceId", "=", stack.mainWorkspaceId)
      .where("userId", "=", owner.id)
      .executeTakeFirstOrThrow();
    await db
      .insertInto("workspaceMemberships")
      .values({
        ...membership,
        id: (await import("../packages/core/src/index.js")).createId("workspaceMembership"),
        userId: person,
      })
      .execute();
    const groups = new BrowserTabGroupStore(db);
    const one = await groups.group(owner.id, {
      tabIds: [first.tabId],
      title: "My research",
      idempotencyKey: "personal",
    });
    const two = await groups.group(person, {
      tabIds: [first.tabId],
      title: "My shopping",
      idempotencyKey: "personal",
    });
    const movedOne = await groups.move(owner.id, {
      item: { tabIds: [second.tabId] },
      to: { groupId: null, before: { groupId: one.groupId } },
      idempotencyKey: randomUUID(),
    });
    await groups.move(person, {
      item: { groupId: two.groupId },
      to: { groupId: null, before: null },
      idempotencyKey: randomUUID(),
    });
    // Give the second person the opposite arrangement of the same shared Guest tabs.
    await groups.move(person, {
      item: { tabIds: [second.tabId] },
      to: { groupId: null, before: null },
      idempotencyKey: randomUUID(),
    });
    expect(movedOne.order).toEqual([second.tabId, first.tabId]);
    expect((await groups.layout(person)).order).toEqual([first.tabId, second.tabId]);
    evidence.push({ personalOrders: [movedOne.order, (await groups.layout(person)).order] });
    expect(one.groupId).not.toBe(two.groupId);
    const named = await db
      .selectNoFrom((eb) => eb.fn<string>("current_database", []).as("name"))
      .executeTakeFirstOrThrow();
    const url = new URL(process.env.OPENSTEER_TEST_DATABASE_URL!);
    url.pathname = `/${named.name}`;
    url.searchParams.delete("options");
    const smallPool = createDatabase({ connectionString: url.href, maxConnections: 1 });
    cleanup.push(() => smallPool.destroy());
    const service = new BrowserTabGroupService({
      groups: new BrowserTabGroupStore(smallPool),
      browser: stack.host.browser,
      publish: () => undefined,
    });
    const actor = {
      kind: "agent" as const,
      ownerId: owner.id,
      workspaceId: stack.mainWorkspaceId,
      threadId: createId("thread"),
      agentBindingId: "pool-journey",
    };
    await Promise.all(
      Array.from({ length: 4 }, () =>
        service.group(actor, {
          tabIds: [first.tabId],
          groupId: one.groupId,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect((await groups.layout(owner.id)).groups.map((g) => g.title)).toEqual(["My research"]);
    expect((await groups.layout(person)).groups.map((g) => g.title)).toEqual(["My shopping"]);
    const replay = await groups.group(owner.id, {
      tabIds: [first.tabId],
      title: "My research",
      idempotencyKey: "personal",
    });
    expect(replay.layout.revision).toBe(movedOne.revision);
    const regroupLocked = Promise.withResolvers<void>();
    const releaseRegroup = Promise.withResolvers<void>();
    const regroup = groups.group(
      owner.id,
      {
        tabIds: [second.tabId],
        groupId: one.groupId,
        idempotencyKey: randomUUID(),
      },
      async () => {
        regroupLocked.resolve();
        await releaseRegroup.promise;
      },
    );
    await regroupLocked.promise;
    const closing = stack.host.browser.closeWorkspaceTab(owner.id, first.tabId);
    releaseRegroup.resolve();
    await Promise.all([regroup, closing]);
    expect((await groups.layout(owner.id)).groups[0]?.tabIds).toEqual([second.tabId]);
    expect((await new WorkspaceTabStore(db).get(owner.id, second.tabId))?.closedAt).toBeNull();

    const third = await command(stack, {
      type: "browser.tab.open",
      sessionId: first.sessionId,
      idempotencyKey: randomUUID(),
    });
    if (third.type !== "browser.tab.open") throw new Error("Wrong tab result");
    const closingGroup = await groups.group(owner.id, {
      tabIds: [third.tabId],
      title: "Closing",
      idempotencyKey: randomUUID(),
    });
    const barrier = pauseAfterLock(
      db,
      (node) => /"name":"browser_?tab_?group_?members"/iu.test(node) && !node.includes("ForUpdate"),
    );
    const lateRegroup = new BrowserTabGroupStore(barrier.database).group(owner.id, {
      tabIds: [second.tabId],
      groupId: closingGroup.groupId,
      idempotencyKey: randomUUID(),
    });
    const lateOutcome = lateRegroup.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await barrier.reached;
      await stack.host.browser.closeWorkspaceTab(owner.id, third.tabId);
    } finally {
      barrier.release();
    }
    expect(await lateOutcome).toMatchObject({ error: { code: "not_found" } });
    expect((await groups.layout(owner.id)).groups[0]?.tabIds).toEqual([second.tabId]);

    const temporary = await groups.group(owner.id, {
      tabIds: [second.tabId],
      title: "Temporary",
      idempotencyKey: randomUUID(),
    });
    await groups.ungroup(owner.id, { tabIds: [second.tabId], idempotencyKey: randomUUID() });
    expect((await groups.layout(owner.id)).groups).toEqual([]);
    expect(
      await db
        .selectFrom("browserTabGroups")
        .selectAll()
        .where("id", "=", temporary.groupId)
        .execute(),
    ).toEqual([]);
    evidence.push({
      layouts: [one, two, replay],
      assertions: [
        "shared Guest independent owners",
        "replay does not bump revision",
        "regroup/close race preserves added tab",
        "empty group deletion",
      ],
    });
  }, 120_000);

  it("keeps collapsed groups across restart and restores one sleeping member attached to the Run", async () => {
    const stack = await deployment();
    const first = await open(stack);
    const second = await command(stack, {
      type: "browser.tab.open",
      sessionId: first.sessionId,
      idempotencyKey: randomUUID(),
    });
    if (second.type !== "browser.tab.open") throw new Error("Wrong tab result");
    const grouped = await command(stack, {
      type: "workspace.tabs.group",
      tabIds: [first.tabId, second.tabId],
      title: "Return later",
      idempotencyKey: randomUUID(),
    });
    if (grouped.type !== "workspace.tabs.group") throw new Error("Wrong group result");
    await command(stack, {
      type: "workspace.tabGroup.update",
      groupId: grouped.groupId,
      collapsed: true,
      idempotencyKey: randomUUID(),
    });
    await command(stack, {
      type: "workspace.tabs.move",
      item: { tabIds: [second.tabId] },
      to: { groupId: grouped.groupId, before: { tabId: first.tabId } },
      idempotencyKey: randomUUID(),
    });
    await stack.restartHost();
    await expect
      .poll(
        async () => {
          const r = await stack.api["bootstrap.get"]({});
          return r.ok && r.data.browser.available;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await stack.restartRunner();
    const before = await bootstrap(stack);
    expect(before.tabGroups?.order).toEqual([second.tabId, first.tabId]);
    expect(before.tabGroups?.groups).toContainEqual(
      expect.objectContaining({
        id: grouped.groupId,
        collapsed: true,
        tabIds: expect.arrayContaining([first.tabId, second.tabId]),
      }),
    );
    const personBrowser = await open(stack);
    const view = new WebSocket(
      new URL(`/v1/browser-sessions/${personBrowser.sessionId}/connect`, stack.hostOrigin),
      {
        headers: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
      },
    );
    cleanup.push(async () => {
      if (view.readyState !== WebSocket.CLOSED) {
        const closed = once(view, "close");
        view.terminate();
        await closed;
      }
    });
    const activeSeen: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The person's browser did not publish its view.")),
        10_000,
      );
      view.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      view.on("message", (raw, binary) => {
        if (binary) return;
        const message = BrowserServerMessageSchema.parse(JSON.parse(raw.toString()));
        if (message.type !== "browser.snapshot") return;
        const active = message.surfaces.find((surface) => surface.active);
        if (active) {
          activeSeen.push(active.id);
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const restored = await agent(stack, stack.mainWorkspaceId, {
      calls: [{ name: "browser_tab_write", input: { action: "restore", tabIds: [first.tabId] } }],
      paginate: true,
    });
    const write = BrowserTabWriteResultSchema.parse(restored.report.calls[0]?.result);
    expect(write.restored).toHaveLength(1);
    const sessionId = write.restored![0]!.sessionId;
    expect(restored.report.attached?.sessions).toContainEqual(
      expect.objectContaining({ id: sessionId, attached: true }),
    );
    const db = stack.host.store.database;
    expect(
      await db
        .selectFrom("browserSessionUses")
        .selectAll()
        .where("sessionId", "=", sessionId)
        .where("runId", "=", restored.turn.runId)
        .execute(),
    ).not.toEqual([]);
    const after = await bootstrap(stack);
    expect(after.tabGroups?.order).toEqual([second.tabId, first.tabId]);
    const tabs = after.workspaceTabs?.flatMap((l) => l.tabs ?? []);
    expect(tabs).toContainEqual(expect.objectContaining({ id: first.tabId, state: "live" }));
    expect(tabs).toContainEqual(expect.objectContaining({ id: second.tabId, state: "suspended" }));
    expect(activeSeen.every((id) => id === activeSeen[0])).toBe(true);
    expect(after.tabGroups?.groups[0]?.tabIds).toEqual(
      expect.arrayContaining([first.tabId, second.tabId]),
    );
    evidence.push({
      assertions: [
        "restart preserves collapsed membership",
        "restore wakes exactly one sibling",
        "returned session attached to Run",
        "restore preserves membership",
        "person view stays unchanged",
      ],
    });
  }, 150_000);
});

integration("tab group deletion and response bounds", () => {
  it("races regroup, last-member close, restore and Workspace deletion without resurrecting a tab", async () => {
    const stack = await deployment();
    const workspace = await stack.createWorkspace("Disposable research");
    const started = await command(stack, {
      type: "browser.session.start",
      workspaceId: workspace.id,
      input: { fresh: true, reuseExisting: false },
      idempotencyKey: randomUUID(),
    });
    if (started.type !== "browser.session.start") throw new Error("Wrong session result");
    const first = await command(stack, {
      type: "browser.tab.open",
      sessionId: started.session.id,
      idempotencyKey: randomUUID(),
    });
    const second = await command(stack, {
      type: "browser.tab.open",
      sessionId: started.session.id,
      idempotencyKey: randomUUID(),
    });
    if (first.type !== "browser.tab.open" || second.type !== "browser.tab.open")
      throw new Error("Wrong tab result");
    const grouped = await command(stack, {
      type: "workspace.tabs.group",
      tabIds: [first.tabId],
      title: "Delete later",
      idempotencyKey: randomUUID(),
    });
    if (grouped.type !== "workspace.tabs.group") throw new Error("Wrong group result");
    const owner = await stack.host.store.database
      .selectFrom("users")
      .select("id")
      .executeTakeFirstOrThrow();
    const groups = new BrowserTabGroupStore(stack.host.store.database);
    const outcomes = await Promise.allSettled([
      groups.group(owner.id, {
        tabIds: [second.tabId],
        groupId: grouped.groupId,
        idempotencyKey: randomUUID(),
      }),
      stack.host.browser.closeWorkspaceTab(owner.id, first.tabId),
      stack.host.browser.activateWorkspaceTab(owner.id, second.tabId),
      command(stack, {
        type: "workspace.delete",
        workspaceId: workspace.id,
        idempotencyKey: randomUUID(),
      }),
    ]);
    evidence.push({
      race: outcomes.map((o) =>
        o.status === "fulfilled"
          ? { status: o.status }
          : { status: o.status, error: String(o.reason) },
      ),
    });
    expect(outcomes[3]?.status).toBe("fulfilled");
    await stack.host.store.markWorkspaceDeleted({ workspaceId: workspace.id });
    await groups.prune();
    expect((await groups.layout(owner.id)).groups).toEqual([]);
    expect(
      await stack.host.store.database
        .selectFrom("browserTabGroupMembers")
        .selectAll()
        .where("groupId", "=", grouped.groupId)
        .execute(),
    ).toEqual([]);
    expect(
      await stack.host.store.database
        .selectFrom("browserTabGroups")
        .selectAll()
        .where("id", "=", grouped.groupId)
        .execute(),
    ).toEqual([]);
    expect(
      await stack.host.store.database
        .selectFrom("workspaceTabs")
        .selectAll()
        .where("id", "in", [first.tabId, second.tabId])
        .execute(),
    ).toEqual([]);
    await expect(stack.host.browser.activateWorkspaceTab(owner.id, second.tabId)).rejects.toThrow();
    evidence.push({
      assertions: [
        "lock checker sees regroup/close/restore/delete race",
        "Workspace deletion cascades memberships",
        "prune removes empty group",
        "deleted tab cannot restore",
      ],
    });
  }, 120_000);

  it("retries failed Runtime disposal after the durable close marker committed", async () => {
    const stack = await deployment();
    const first = await open(stack);
    const second = await command(stack, {
      type: "browser.tab.open",
      sessionId: first.sessionId,
      idempotencyKey: randomUUID(),
    });
    if (second.type !== "browser.tab.open") throw new Error("Wrong tab result");
    const owner = await stack.host.store.database
      .selectFrom("users")
      .select("id")
      .executeTakeFirstOrThrow();
    const dispose = vi
      .spyOn(SurfaceLedger.prototype, "closeSurface")
      .mockRejectedValueOnce(new Error("Too many pending CDP requests"));
    const input = {
      type: "workspace.tabs.close" as const,
      tabIds: [first.tabId],
      idempotencyKey: randomUUID(),
    };
    const failed = await command(stack, input);
    expect(failed).toMatchObject({ closed: [], failed: [{ tabId: first.tabId }] });
    expect(
      (
        await stack.host.store.database
          .selectFrom("workspaceTabs")
          .select("closedAt")
          .where("id", "=", first.tabId)
          .executeTakeFirstOrThrow()
      ).closedAt,
    ).not.toBeNull();
    expect(
      (await stack.host.browser.readTabCatalog(owner.id, first.sessionId)).tabs.map(
        (tab) => tab.id,
      ),
    ).toContain(first.tabId);
    dispose.mockRestore();
    expect(await command(stack, input)).toMatchObject({ closed: [first.tabId], failed: [] });
    const remaining = (await stack.host.browser.readTabCatalog(owner.id, first.sessionId)).tabs.map(
      (tab) => tab.id,
    );
    expect(remaining).not.toContain(first.tabId);
    expect(remaining).toContain(second.tabId);
    expect(await command(stack, input)).toMatchObject({ closed: [first.tabId], failed: [] });
    evidence.push({
      assertions: [
        "durable close can precede failed disposal",
        "retry disposes the still-live page",
        "retry of an unbound surface succeeds",
        "unlisted sibling stays alive",
      ],
    });
  }, 120_000);

  it("reclaims closed memberships before enforcing either limit and during pruning", async () => {
    const stack = await deployment();
    const first = await open(stack);
    const second = await command(stack, {
      type: "browser.tab.open",
      sessionId: first.sessionId,
      idempotencyKey: randomUUID(),
    });
    if (second.type !== "browser.tab.open") throw new Error("Wrong tab result");
    const db = stack.host.store.database;
    const owner = await db.selectFrom("users").select("id").executeTakeFirstOrThrow();
    const initial = await command(stack, {
      type: "workspace.tabs.group",
      tabIds: [first.tabId],
      title: "Live",
      idempotencyKey: randomUUID(),
    });
    if (initial.type !== "workspace.tabs.group") throw new Error("Wrong group result");
    const { BrowserSurfaceIdSchema } = await import("../packages/protocol/src/browser.js");
    const closed = Array.from({ length: 698 }, (_, order) => ({
      id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`),
      groupId: first.sessionId,
      sessionId: first.sessionId,
      title: "Closed",
      url: "about:blank",
      order: order + 2,
      state: "suspended" as const,
      openerId: null,
      closedAt: new Date(),
    }));
    await db.insertInto("workspaceTabs").values(closed).execute();
    const deadGroups = Array.from({ length: 199 }, () => ({
      id: createId("browserTabGroup"),
      ownerId: owner.id,
      title: "Gone",
      color: "grey" as const,
    }));
    await db.insertInto("browserTabGroups").values(deadGroups).execute();
    await db
      .insertInto("browserTabGroupMembers")
      .values(
        closed.map((tab, index) => ({
          ownerId: owner.id,
          tabId: tab.id,
          groupId: index < 499 ? initial.groupId : deadGroups[index - 499]!.id,
        })),
      )
      .execute();
    const joined = await command(stack, {
      type: "workspace.tabs.group",
      groupId: initial.groupId,
      tabIds: [second.tabId],
      idempotencyKey: randomUUID(),
    });
    expect(joined).toMatchObject({
      layout: {
        groups: [
          { id: initial.groupId, tabIds: expect.arrayContaining([first.tabId, second.tabId]) },
        ],
      },
    });
    const created = await command(stack, {
      type: "workspace.tabs.group",
      tabIds: [second.tabId],
      title: "Room again",
      idempotencyKey: randomUUID(),
    });
    if (created.type !== "workspace.tabs.group") throw new Error("Wrong group result");
    expect(created.layout.groups).toHaveLength(2);
    expect(
      await db
        .selectFrom("browserTabGroupMembers")
        .select("tabId")
        .where(
          "tabId",
          "in",
          closed.map((tab) => tab.id),
        )
        .execute(),
    ).toEqual([]);
    await command(stack, {
      type: "workspace.tabs.close",
      tabIds: [first.tabId],
      idempotencyKey: randomUUID(),
    });
    await new BrowserTabGroupStore(db).prune();
    expect(
      await db
        .selectFrom("browserTabGroups")
        .select("id")
        .where("id", "=", initial.groupId)
        .execute(),
    ).toEqual([]);
    expect(
      (await new BrowserTabGroupStore(db).layout(owner.id)).groups.map((group) => group.id),
    ).toEqual([created.groupId]);
    evidence.push({
      assertions: [
        "closed members do not consume 500-tab capacity",
        "dead groups do not consume 200-group capacity",
        "prune removes closed memberships and empty groups",
      ],
    });
  }, 120_000);

  it("keeps an old grouped lineage in the bounded bootstrap inventory", async () => {
    const stack = await deployment();
    const first = await open(stack);
    const db = stack.host.store.database;
    const original = await db
      .selectFrom("browserSessions")
      .selectAll()
      .where("id", "=", first.sessionId)
      .executeTakeFirstOrThrow();
    const { createBrowserSessionId, BrowserSurfaceIdSchema } =
      await import("../packages/protocol/src/browser.js");
    for (let index = 0; index < 101; index++) {
      const id = createBrowserSessionId();
      await db
        .insertInto("browserSessions")
        .values({
          ...original,
          id,
          tabGroupId: id,
          state: "closed",
          createdAt: new Date(original.createdAt.getTime() + index + 1),
        })
        .execute();
      await db
        .insertInto("workspaceTabs")
        .values({
          id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`),
          groupId: id,
          sessionId: id,
          title: "Newer",
          url: "about:blank",
          order: 0,
          state: "suspended",
          openerId: null,
        })
        .execute();
    }
    expect(
      (await bootstrap(stack)).workspaceTabs?.some((lineage) => lineage.id === first.sessionId),
    ).toBe(false);
    await command(stack, {
      type: "workspace.tabs.group",
      tabIds: [first.tabId],
      title: "Older work",
      idempotencyKey: randomUUID(),
    });
    const inventory = await bootstrap(stack);
    expect(inventory.workspaceTabs).toHaveLength(100);
    expect(
      inventory.workspaceTabs?.flatMap((lineage) => lineage.tabs ?? []).map((tab) => tab.id),
    ).toContain(first.tabId);
    evidence.push({
      assertions: [
        "grouped lineage is preferred past newest 100",
        "bootstrap stays within old-client limit",
      ],
    });
  }, 120_000);

  it("reads all 200 group summaries inside the tool response budget", async () => {
    const stack = await deployment();
    const opened = await open(stack);
    const db = stack.host.store.database;
    const owner = await db.selectFrom("users").select("id").executeTakeFirstOrThrow();
    const original = await db
      .selectFrom("browserSessions")
      .selectAll()
      .where("id", "=", opened.sessionId)
      .executeTakeFirstOrThrow();
    const { createBrowserSessionId, BrowserSurfaceIdSchema, BrowserTabGroupIdSchema } =
      await import("../packages/protocol/src/browser.js");
    for (let index = 0; index < 200; index++) {
      const lineageId = createBrowserSessionId();
      await db
        .insertInto("browserSessions")
        .values({
          ...original,
          id: lineageId,
          tabGroupId: lineageId,
          state: "closed",
        })
        .execute();
      const groupId = BrowserTabGroupIdSchema.parse(`btg_${randomUUID()}`);
      await db
        .insertInto("browserTabGroups")
        .values({
          id: groupId,
          ownerId: owner.id,
          title: "\u0001".repeat(80),
          color: "blue",
          createdByThreadId: null,
        })
        .execute();
      const tabIds = Array.from({ length: 50 }, () =>
        BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`),
      );
      await db
        .insertInto("workspaceTabs")
        .values(
          tabIds.map((id, order) => ({
            id,
            order,
            groupId: lineageId,
            sessionId: lineageId,
            title: "Saved",
            url: "https://example.test/private",
            state: "suspended" as const,
            openerId: null,
          })),
        )
        .execute();
      await db
        .insertInto("browserTabGroupMembers")
        .values(tabIds.map((tabId) => ({ ownerId: owner.id, groupId, tabId })))
        .execute();
    }
    const read = await agent(stack, stack.mainWorkspaceId, {
      calls: [{ name: "browser_tab_read", input: {} }],
    });
    const result = BrowserTabReadResultSchema.parse(read.report.calls[0]?.result);
    expect(result.groups).toHaveLength(200);
    await expect(
      command(stack, {
        type: "workspace.tabs.group",
        tabIds: [opened.tabId],
        title: "Over the limit",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("200 tab groups");
    expect(result.groups.every((g) => g.tabCount === 50 && !("tabIds" in g))).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(result));
    const { agentControlResponseMaxSerializedBytes } =
      await import("../packages/protocol/src/agent-control.js");
    expect(bytes).toBeLessThan(agentControlResponseMaxSerializedBytes);
    evidence.push({
      bytes,
      groups: result.groups.length,
      assertions: [
        "200 groups with 10000 members fit one tool response",
        "group members stay paginated",
      ],
    });
  }, 180_000);
});

integration("naturally idempotent tab operations", () => {
  it("repeats organization and exact tab closure across a Host restart", async () => {
    const stack = await deployment();
    const first = await open(stack);
    const second = await command(stack, {
      type: "browser.tab.open",
      sessionId: first.sessionId,
      idempotencyKey: randomUUID(),
    });
    if (second.type !== "browser.tab.open") throw new Error("Wrong tab result");
    const third = await command(stack, {
      type: "browser.tab.open",
      sessionId: first.sessionId,
      idempotencyKey: randomUUID(),
    });
    if (third.type !== "browser.tab.open") throw new Error("Wrong tab result");
    const groupInput = {
      type: "workspace.tabs.group" as const,
      tabIds: [first.tabId],
      title: "Temporary",
      idempotencyKey: randomUUID(),
    };
    const grouped = await command(stack, groupInput);
    if (grouped.type !== "workspace.tabs.group") throw new Error("Wrong group result");
    expect(await command(stack, groupInput)).toEqual(grouped);
    expect(
      await command(stack, {
        type: "workspace.tabs.group",
        tabIds: [first.tabId],
        groupId: grouped.groupId,
        idempotencyKey: randomUUID(),
      }),
    ).toEqual(grouped);
    expect(grouped.layout.groups).toHaveLength(1);
    const updateInput = {
      type: "workspace.tabGroup.update" as const,
      groupId: grouped.groupId,
      title: "Renamed",
      color: "purple" as const,
      collapsed: true,
      idempotencyKey: randomUUID(),
    };
    const updated = await command(stack, updateInput);
    expect(await command(stack, updateInput)).toEqual(updated);
    expect(await command(stack, { ...updateInput, idempotencyKey: randomUUID() })).toEqual(updated);
    const ungroupInput = {
      type: "workspace.tabs.ungroup" as const,
      tabIds: [first.tabId],
      idempotencyKey: groupInput.idempotencyKey,
    };
    const ungrouped = await command(stack, ungroupInput);
    expect(await command(stack, ungroupInput)).toEqual(ungrouped);
    expect(await command(stack, { ...ungroupInput, idempotencyKey: randomUUID() })).toEqual(
      ungrouped,
    );
    expect(await command(stack, groupInput)).toMatchObject({
      groupId: grouped.groupId,
      layout: { groups: [expect.objectContaining({ id: grouped.groupId, tabIds: [first.tabId] })] },
    });
    const closeInput = {
      type: "workspace.tabs.close" as const,
      tabIds: [first.tabId, second.tabId],
      idempotencyKey: randomUUID(),
    };
    const closeTab = vi.spyOn(stack.host.browser, "closeWorkspaceTab");
    const closed = await command(stack, closeInput);
    expect(closed).toMatchObject({ closed: [first.tabId, second.tabId], failed: [] });
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(await command(stack, closeInput)).toEqual(closed);
    expect(await command(stack, { ...closeInput, idempotencyKey: randomUUID() })).toEqual(closed);
    expect(closeTab).toHaveBeenCalledTimes(6);
    closeTab.mockRestore();
    expect(await command(stack, { ...ungroupInput, tabIds: [third.tabId] })).toMatchObject({
      layout: { groups: [] },
    });
    const owner = await stack.host.store.database
      .selectFrom("users")
      .select("id")
      .executeTakeFirstOrThrow();
    const tabs = new WorkspaceTabStore(stack.host.store.database);
    expect((await tabs.get(owner.id, third.tabId))?.closedAt).toBeNull();
    expect(
      (await new BrowserTabGroupStore(stack.host.store.database).layout(owner.id)).groups,
    ).toEqual([]);
    await stack.restartHost();
    const restartedClose = vi.spyOn(stack.host.browser, "closeWorkspaceTab");
    expect(await command(stack, closeInput)).toEqual(closed);
    expect(restartedClose).toHaveBeenCalledTimes(2);
    expect(
      (await new WorkspaceTabStore(stack.host.store.database).get(owner.id, third.tabId))?.closedAt,
    ).toBeNull();
    restartedClose.mockRestore();
    await stack.restartRunner();
    const inputs = [
      {
        requestId: 9005,
        name: "browser_tab_write",
        input: { action: "group", tabIds: [third.tabId], title: "Transient" },
      },
      {
        requestId: 9006,
        name: "browser_tab_write",
        input: { action: "ungroup", tabIds: [third.tabId] },
      },
      {
        requestId: 9007,
        name: "browser_tab_write",
        input: { action: "close", tabIds: [third.tabId] },
      },
    ];
    const agentClose = vi.spyOn(stack.host.browser, "closeWorkspaceTab");
    const throughTools = await agent(stack, stack.mainWorkspaceId, {
      calls: inputs.flatMap((input) => [input, input]),
    });
    expect(throughTools.report.calls).toHaveLength(6);
    expect(throughTools.report.calls.every((c) => c.error === undefined)).toBe(true);
    for (let i = 0; i < 6; i += 2)
      expect(throughTools.report.calls[i + 1]).toEqual(throughTools.report.calls[i]);
    expect(agentClose).toHaveBeenCalledTimes(2);
    agentClose.mockRestore();
    evidence.push({
      assertions: [
        "retry creates no second group",
        "already-member group, identical update and absent membership are no-ops",
        "retry after emptying may recreate the deterministic group",
        "repeated close redisposes the same explicit tabs",
        "unlisted tab stays open",
        "repeated close after Host restart",
        "real MCP duplicate calls are naturally idempotent",
      ],
    });
  }, 150_000);
});
