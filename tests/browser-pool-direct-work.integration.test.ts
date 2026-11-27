import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { standardCdpEndpoint } from "../apps/host/src/browser/standard-cdp-endpoint.test-support.js";
import { AgentSessionService } from "../apps/host/src/agent-sessions/agent-session-service.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import { BrowserScriptService } from "../apps/host/src/browser-use/browser-script-service.js";
import { TabService } from "../apps/host/src/tabs/tab-service.js";
import { operationRow } from "../packages/client/src/host/agent-work.js";
import { threadAgentPage, watchPage } from "../packages/client/src/host/agent-place-links.js";
import { createConnectionRpcHandlers } from "../apps/host/src/mcp/connections/connection-routes.js";
import { CommandTools } from "../apps/host/src/mcp/handlers/commands.js";
import { releaseUngrantedTabs } from "../apps/host/src/agent-sessions/release-ungranted-tabs.js";
import { stateAreas } from "../packages/agent-tools/src/tools/commands.js";
import { listAgentOperations } from "../packages/database/src/agent-session-store.js";
import { tabReadAuthority } from "../apps/host/src/tabs/tab-authority.js";
import { AgentConnectionStore } from "../packages/database/src/agent-connection-store.js";
import type { AgentGrant } from "../packages/core/src/index.js";
import {
  BrowserScriptConfinement,
  BrowserToolHandlers,
} from "../apps/host/src/mcp/handlers/browser.js";
import {
  commands,
  connection,
  serveMcp,
} from "../apps/host/src/mcp/connection-caller.test-support.js";
import {
  OpensteerError,
  TabSchema,
  type AgentWorkingIn,
  type RequestId,
  type ThreadId,
} from "../packages/core/src/index.js";
import { type TabRecord } from "../packages/database/src/index.js";
import { listBrowserPoolDocumentLosses } from "./browser-pool-journey.test-support.js";
import { TabSleeper } from "../packages/browser-runtime-core/src/browser/tab-sleeper.js";
import {
  before,
  holdResume,
  journey,
  TestRuntimeConnection,
  until,
} from "./browser-pool-journey.test-support.js";

type Journey = Awaited<ReturnType<typeof journey>>;
type Home = Awaited<ReturnType<Journey["startHome"]>>;

/**
 * A connected agent's direct browser work on the pooled browser, through the one door and the
 * real script service. The tab list is the Home's own rows; authority stays in the database.
 */
async function directWork(
  j: Journey,
  home: () => Home,
  options: {
    /** Read tabs as the Home's tab service does, through the tab authority (rule 1). */
    readonly realAuthority?: boolean;
    /** The connection's grant; selected on the profile unless given. */
    readonly grant?: AgentGrant;
    /** Runs after a script's bind decided its tab and bound the page, inside the call. */
    readonly afterBind?: () => Promise<void>;
    /** A session's end ends its browser work, as the Home wires it (its binding's scripts). */
    readonly endsBrowserWork?: boolean;
    /** Each call's own bound (two minutes). */
    readonly executionMs?: number;
    /**
     * The Home's holder record for each tab a script binds is filed under the binding this
     * names (another session's), and a kept handle taken up again refreshes none: the task holds
     * no record of the tabs it works in.
     */
    readonly misfileHolders?: () =>
      { readonly bindingId: string; readonly threadId: string } | undefined;
    /** Each command a script sends, after its recheck, with the tab it goes to. */
    readonly onScriptCommand?: (tabId: string) => void;
    /** Runs once a browser_connect ticket was issued, before its reply. */
    readonly afterTicket?: () => Promise<void>;
  } = {},
) {
  let tabChange: ((tab: TabRecord) => TabRecord | Promise<TabRecord>) | undefined;
  const ownerId = j.task.userId;
  const row = async (tabId: string) => {
    const tab = await j.tabs.get(ownerId, tabId as TabRecord["id"]);
    if (!tab) throw new Error("No such tab.");
    return tab;
  };
  // The agent's own page: the Home's page service opens it and its tab row is written, as the
  // tab service does (whose authorization this fixture does not repeat).
  const open = async (actor: never, target: never, key: string) => {
    const write = await home().service.pageTabs.open(actor, target, `fixture:${key}`);
    await j.tabs.open(write, `fixture:${key}`);
    await home().service.pageTabs.admitted?.(write);
    return { tab: { tabId: write.id } };
  };
  const readable = async (actor: never, tab: TabRecord) =>
    !options.realAuthority || (await (await tabReadAuthority(actor, j.database))(tab));
  const scriptTabs = {
    browserScriptPages: async function* (actor: never) {
      const { rows } = await j.tabs.snapshot(ownerId);
      for (const tab of rows) if (tab.kind === "page" && (await readable(actor, tab))) yield tab;
    },
    bindBrowserScript: async (actor: never, tabId: string) => {
      const tab = await row(tabId);
      if (!(await readable(actor, tab)))
        throw new OpensteerError({ code: "not_found", message: "Tab not found." });
      const elsewhere = options.misfileHolders?.();
      const filed = elsewhere
        ? ({
            ...(actor as object),
            threadId: elsewhere.threadId,
            authority: {
              ...(actor as { authority: object }).authority,
              agentBindingId: elsewhere.bindingId,
            },
          } as never)
        : actor;
      const binding = await home().service.pageTabs.bindBrowserScript!(filed, tab);
      await options.afterBind?.();
      return binding;
    },
    open,
    get: async (_owner: unknown, tabId: string) => {
      const tab = await row(tabId);
      return { kind: tab.kind, profile: tab.profileId ? { profileId: tab.profileId } : null };
    },
  };
  let endBrowserWork: (bindingId: string, reason: string) => void = () => {};
  /** What the person who owns the Home was told of where each session works, in order. */
  const workingIn: { readonly ownerUserId: string; readonly notice: AgentWorkingIn }[] = [];
  const sessions = new AgentSessionService({
    store: j.store,
    holdMs: 0,
    onWorkingIn: (ownerUserId, notice) => workingIn.push({ ownerUserId, notice }),
    // As the Home's runtime wires it: after a narrowing, each held tab decided by the rule.
    releaseUngrantedTabs: (bindingId) =>
      releaseUngrantedTabs(
        bindingId,
        home().service,
        (ownerId, tabId) => j.tabs.get(ownerId, tabId),
        j.database,
      ),
    ...(options.executionMs ? { executionMs: options.executionMs } : {}),
    ...(options.endsBrowserWork
      ? { closeBinding: (bindingId: string, reason: string) => endBrowserWork(bindingId, reason) }
      : {}),
  });
  const confinement = new BrowserScriptConfinement();
  const scripts = new BrowserScriptService({
    browser: options.misfileHolders
      ? new Proxy(home().service, {
          get: (target, key) =>
            key === "tabTakenUp"
              ? undefined
              : (Reflect.get(target, key) as unknown) instanceof Function
                ? (Reflect.get(target, key) as (...args: unknown[]) => unknown).bind(target)
                : Reflect.get(target, key),
        })
      : home().service,
    store: j.store,
    tabs: confinement.tabs(scriptTabs as never),
    // As the Home's runtime wires it.
    workingIn: (bindingId: string, tabId: never) => {
      options.onScriptCommand?.(tabId);
      sessions.workingIn.note(bindingId, tabId);
    },
  } as never);
  // As the Home's runtime: the session's end closes its raw CDP and its scripts' browser work.
  endBrowserWork = (bindingId, reason) => {
    home().service.closeStandardCdpForBinding(bindingId, reason);
    void scripts.closeBrowserScriptsForBinding(bindingId).catch(() => undefined);
  };
  /** The tab row a connection reads; a test can make the next reads see a changed tab. */
  const tabRow = async (tabId: string) => {
    const tab = await row(tabId);
    return tabChange ? await tabChange(tab) : tab;
  };
  const handlers = new BrowserToolHandlers({
    sessions,
    tabs: {
      // The owner's own page tabs, as a connection with this grant lists them.
      list: async () => ({
        tabs: (await j.tabs.snapshot(ownerId)).rows
          .filter((tab) => tab.kind === "page")
          .map((tab) => ({ tabId: tab.id })),
      }),
      open,
      connectionTab: async (_actor: never, tabId: string) => tabRow(tabId),
      bindBrowserScript: async (actor: never, tabId: string) =>
        home().service.pageTabs.bindBrowserScript!(actor, await row(tabId)),
    } as never,
    scripts,
    confinement,
    profiles: (owner) => home().service.listProfiles(owner),
    requireDevice: (runnerId) => j.store.requireSelfDeviceId(runnerId),
    issueTicket: async (input) => {
      const issued = await home().service.issueStandardCdpTicket(input);
      await options.afterTicket?.();
      return issued;
    },
    pooledBrowser: (runnerId) => home().service.pooledDirectBrowser(runnerId),
    // As the Home wires it: the connection's own read of the tab row.
    pooledTab: async (_actor: never, tabId: string) => tabRow(tabId),
    origin: new URL("https://home.example.test"),
  });
  // The Home's command tools too, reading as the Home registers its reads (opensteer_state).
  const reads = createConnectionRpcHandlers({
    store: new AgentConnectionStore(j.database),
  } as never);
  const url = await serveMcp(j.fixture, {
    browser: handlers,
    commands: new CommandTools({
      database: j.database,
      registry: {} as never,
      administration: {} as never,
      requests: () => undefined,
      secretDigestKey: Buffer.alloc(32),
      reads: () => reads,
    }),
  });
  const agent = await connection(j.store, url, {
    userId: ownerId,
    accessMode: "full-access",
    grant: options.grant ?? {
      scope: "selected",
      tasks: false,
      resources: [{ kind: "browser-profile", profileId: j.profile!.id }],
    },
  });
  const use = (code: string) =>
    agent.client.callTool({
      name: "browser_use",
      arguments: { profileId: j.profile!.id, code, reason: "Read the draft" },
    });
  const resume = (code: string, operationId: string) =>
    agent.client.callTool({
      name: "browser_use",
      arguments: { profileId: j.profile!.id, code, reason: "Read the draft", operationId },
    });
  const connect = () =>
    agent.client.callTool({
      name: "browser_connect",
      arguments: { profileId: j.profile!.id, reason: "Drive the page" },
    });
  const useTab = (code: string, tabId: string, operationId?: string) =>
    agent.client.callTool({
      name: "browser_use",
      arguments: { tabId, code, reason: "Read the draft", ...(operationId ? { operationId } : {}) },
    });
  const connectTab = (tabId: string) =>
    agent.client.callTool({
      name: "browser_connect",
      arguments: { tabId, reason: "Drive the page" },
    });
  /** From now on, reads of a tab see it changed by `change`; undefined restores them. */
  const changeTabs = (change: ((tab: TabRecord) => TabRecord | Promise<TabRecord>) | undefined) => {
    tabChange = change;
  };
  /** Another connection of the same person, with the same grant: another agent. */
  const anotherAgent = async () => {
    const other = await connection(j.store, url, {
      userId: ownerId,
      accessMode: "full-access",
      grant: {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: j.profile!.id }],
      },
    });
    const use = (code: string) =>
      other.client.callTool({
        name: "browser_use",
        arguments: { profileId: j.profile!.id, code, reason: "Read the draft" },
      });
    return Object.assign(use, {
      id: other.id,
      useTab: (code: string, tabId: string) =>
        other.client.callTool({
          name: "browser_use",
          arguments: { tabId, code, reason: "Read the draft" },
        }),
    });
  };
  /** Another connection of the same person, with this grant. */
  const connectAs = (grant: AgentGrant) =>
    connection(j.store, url, { userId: ownerId, accessMode: "full-access", grant });
  return {
    sessions,
    scripts,
    workingIn,
    connectAs,
    agent,
    use,
    resume,
    connect,
    useTab,
    connectTab,
    changeTabs,
    anotherAgent,
  };
}

/** The tab row the Home keeps for `tabId`. */
const row = async (j: Journey, tabId: string) => {
  const tab = await j.tabs.get(j.task.userId, tabId as TabRecord["id"]);
  if (!tab) throw new Error("No such tab.");
  return tab;
};

const text = (result: Awaited<ReturnType<Awaited<ReturnType<typeof directWork>>["use"]>>) =>
  JSON.stringify(result.content);

it("makes a tab a pooled browser_use script binds the agent's at the bind, before any input (V5)", async () => {
  // The runtime's sleeper hears every session state the Home sends (TS12's agentTabs).
  const states: { sessionId: string; agentTabs: readonly string[] }[] = [];
  const setSessionState = TabSleeper.prototype.setSessionState;
  const spy = vi.spyOn(TabSleeper.prototype, "setSessionState").mockImplementation(function (
    this: TabSleeper,
    id,
    state,
  ) {
    states.push({ sessionId: id, agentTabs: state.agentTabs ?? [] });
    return setSessionState.call(this, id, state);
  });
  const j = await journey("direct-script-bound", { profile: true });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    await j.draft();
    const work = await directWork(j, () => home);
    // A read only: no input, no action; the bind alone makes the tab the agent's.
    const read = await work.use(
      `const page = await openPage(${JSON.stringify(tab.id)}); return await page.js("document.title")`,
    );
    expect(read.isError, text(read)).not.toBe(true);
    await vi.waitFor(() =>
      expect(
        states.some((state) => state.sessionId === session.id && state.agentTabs.includes(tab.id)),
      ).toBe(true),
    );
  } finally {
    spy.mockRestore();
    await j.close();
  }
});

it.each([
  ["", false],
  [", the browser parked between them", true],
] as const)(
  "names a connected agent's task as the holder of a tab its earlier call opened, while a later call works in it%s",
  async (_, park) => {
    // Tester run 14: one call opens a tab with newPage and ends; the next names that tab and works
    // in it for half a minute. The person's Watch found no page of the task.
    const site = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Example Domain</title><p>example</p>");
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    // The person's tab rows as the Home publishes them, each with who holds each tab named at that
    // moment: what the person's snapshot (and so Watch, which reads it once at the click) holds.
    let home: Home | undefined;
    const published: Promise<ReadonlyMap<string, unknown>>[] = [];
    const j: Journey = await journey("direct-script-later-holder", {
      profile: true,
      onTabsChanged: (_owner, ids) => {
        published.push(
          (async () => {
            const rows = (await j.tabs.snapshot(j.task.userId)).rows.filter(
              (tab) => tab.kind === "page" && (!ids || ids.includes(tab.id)),
            );
            return new Map(
              await Promise.all(
                rows.map(
                  async (tab) =>
                    [
                      tab.id,
                      (await home!.service.pageTabs.state!(j.task.userId, tab)).usedBy,
                    ] as const,
                ),
              ),
            );
          })().catch(() => new Map()),
        );
      },
    });
    try {
      home = await j.startHome();
      const work = await directWork(j, () => home!);
      const opened = await work.use(
        `const page = await newPage(${JSON.stringify(`${origin}/`)}); return page.tabId;`,
      );
      expect(opened.isError, text(opened)).not.toBe(true);
      const tabId = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(text(opened))?.[0];
      if (!tabId) throw new Error(`The script returned no tab: ${text(opened)}`);
      // The pooled browser sleeps between the calls, as a Cloud Computer's does when idle.
      if (park) expect(await home.coordinator.tryPark()).toBe("parked");
      let done = false;
      const working = work
        .useTab(
          `const page = await openPage(${JSON.stringify(tabId)}); await page.js("document.title"); await page.waitForTimeout(4000); return 1;`,
          tabId,
        )
        .finally(() => {
          done = true;
        });
      const { threadId } = await j.database
        .selectFrom("agentSessions")
        .select("threadId")
        .where("userId", "=", j.task.userId)
        .executeTakeFirstOrThrow();
      await vi.waitFor(
        async () => {
          expect(done).toBe(false);
          const state = await home!.service.pageTabs.state!(j.task.userId, await row(j, tabId));
          expect(state.usedBy).toEqual([{ taskId: threadId, since: expect.any(String) }]);
          // And the person's row says so: the last time it was published, it named the task.
          const last = (await Promise.all(published)).filter((rows) => rows.has(tabId)).at(-1);
          expect(last?.get(tabId)).toEqual([{ taskId: threadId, since: expect.any(String) }]);
        },
        { timeout: 4_000 },
      );
      const result = await working;
      expect(result.isError, text(result)).not.toBe(true);
    } finally {
      await j.close();
      site.close();
    }
  },
);

it("names a second connection's task as the holder of its tab, after the person disconnected the first", async () => {
  // Tester run 14, its second cloud trial: the first connection worked in a tab and was
  // disconnected; a new connection opened a tab with newPage, and its next call worked in it.
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Example Domain</title><p>example</p>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  let home: Home | undefined;
  const published: Promise<ReadonlyMap<string, unknown>>[] = [];
  const j: Journey = await journey("direct-script-second-connection", {
    profile: true,
    onTabsChanged: (_owner, ids) => {
      published.push(
        (async () => {
          const rows = (await j.tabs.snapshot(j.task.userId)).rows.filter(
            (tab) => tab.kind === "page" && (!ids || ids.includes(tab.id)),
          );
          return new Map(
            await Promise.all(
              rows.map(
                async (tab) =>
                  [
                    tab.id,
                    (await home!.service.pageTabs.state!(j.task.userId, tab)).usedBy,
                  ] as const,
              ),
            ),
          );
        })().catch(() => new Map()),
      );
    },
  });
  try {
    home = await j.startHome();
    const work = await directWork(j, () => home!, { endsBrowserWork: true });
    const tabOf = (reply: Awaited<ReturnType<typeof work.use>>) => {
      const id = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(text(reply))?.[0];
      if (!id) throw new Error(`The script returned no tab: ${text(reply)}`);
      return id;
    };
    // The first connection opens a tab and works in it; the person disconnects it.
    const first = tabOf(
      await work.use(
        `const page = await newPage(${JSON.stringify(`${origin}/one`)}); return page.tabId;`,
      ),
    );
    const firstWork = await work.useTab(
      `const page = await openPage(${JSON.stringify(first)}); return await page.js("document.title");`,
      first,
    );
    expect(firstWork.isError, text(firstWork)).not.toBe(true);
    const connection = commands(j.fixture, j.task.userId, {
      afterStop: (id, reason) => work.sessions.closeConnection(id, reason === "disconnect"),
    });
    await connection.revoke(work.agent.id);
    await j.store.driveConnectionCleanups();
    // A new connection opens a tab, and its next call works in it by its id.
    const other = await work.anotherAgent();
    const second = tabOf(
      await other(
        `const page = await newPage(${JSON.stringify(`${origin}/two`)}); return page.tabId;`,
      ),
    );
    let done = false;
    const working = other
      .useTab(
        `const page = await openPage(${JSON.stringify(second)}); await page.js("document.title"); await page.waitForTimeout(4000); return 1;`,
        second,
      )
      .finally(() => {
        done = true;
      });
    const { threadId } = await j.database
      .selectFrom("agentSessions")
      .innerJoin("agentConnections", "agentConnections.id", "agentSessions.connectionId")
      .select("agentSessions.threadId")
      .where("agentSessions.connectionId", "=", other.id)
      .executeTakeFirstOrThrow();
    await vi.waitFor(
      async () => {
        expect(done).toBe(false);
        const state = await home!.service.pageTabs.state!(j.task.userId, await row(j, second));
        expect(state.usedBy).toEqual([{ taskId: threadId, since: expect.any(String) }]);
        const last = (await Promise.all(published)).filter((rows) => rows.has(second)).at(-1);
        expect(last?.get(second)).toEqual([{ taskId: threadId, since: expect.any(String) }]);
      },
      { timeout: 4_000 },
    );
    const result = await working;
    expect(result.isError, text(result)).not.toBe(true);
  } finally {
    await j.close();
    site.close();
  }
});

it("says which of a task's tabs its work took up last, and tells the person when that changes", async () => {
  // Tester run 15, trial 4: the task holds two tabs; its call works in the first again. Watch
  // takes the tab whose holder says the latest `since`.
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Example Domain</title><p>example</p>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const published: (readonly string[] | "all")[] = [];
  const j = await journey("direct-script-since", {
    profile: true,
    onTabsChanged: (_owner, ids) => published.push(ids ?? "all"),
  });
  try {
    const home = await j.startHome();
    const work = await directWork(j, () => home);
    const open = async (path: string) => {
      const reply = await work.use(
        `const page = await newPage(${JSON.stringify(`${origin}/${path}`)}); return page.tabId;`,
      );
      const id = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(text(reply))?.[0];
      if (!id) throw new Error(`The script returned no tab: ${text(reply)}`);
      return id;
    };
    const first = await open("one");
    const second = await open("two");
    const since = async (tabId: string) =>
      (await home.service.pageTabs.state!(j.task.userId, await row(j, tabId))).usedBy[0]?.since;
    expect(await since(second)).toBeDefined();
    expect((await since(second))! > (await since(first))!).toBe(true);
    const before = published.length;
    let done = false;
    const working = work
      .useTab(
        `const page = await openPage(${JSON.stringify(first)}); await page.js("document.title"); await page.waitForTimeout(3000); return 1;`,
        first,
      )
      .finally(() => {
        done = true;
      });
    await vi.waitFor(
      async () => {
        expect(done).toBe(false);
        // Its work took the first tab up again: that is now the latest, and the person's row for
        // it was published again since.
        expect((await since(first))! > (await since(second))!).toBe(true);
        expect(published.slice(before).some((ids) => ids === "all" || ids.includes(first))).toBe(
          true,
        );
      },
      { timeout: 3_000 },
    );
    const result = await working;
    expect(result.isError, text(result)).not.toBe(true);
  } finally {
    await j.close();
    site.close();
  }
});

it("names a connected agent's task as the holder of the tab its script binds, so the person's Watch lands on it", async () => {
  // Tester run 12: a connected agent's script working in a tab of the pooled browser; the
  // person's Watch found no page of its task (threadAgentPage) and stayed on the launcher.
  const j = await journey("direct-script-holder", { profile: true });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    await j.draft();
    const work = await directWork(j, () => home);
    // The agent's script binds the person's tab and keeps working in it.
    let done = false;
    const working = work
      .useTab(
        `const page = await openPage(${JSON.stringify(tab.id)}); await page.js("document.title"); await page.waitForTimeout(4000); return 1;`,
        tab.id,
      )
      .finally(() => {
        done = true;
      });
    const { threadId } = await vi.waitFor(
      () =>
        j.database
          .selectFrom("agentSessions")
          .select("threadId")
          .where("userId", "=", j.task.userId)
          .executeTakeFirstOrThrow(),
      { timeout: 10_000 },
    );
    // While it works, the Home names its task as the tab's holder, and Watch picks that tab.
    await vi.waitFor(
      async () => {
        expect(done).toBe(false);
        const state = await home.service.pageTabs.state!(j.task.userId, await row(j, tab.id));
        expect(state.usedBy).toEqual([{ taskId: threadId, since: expect.any(String) }]);
      },
      { timeout: 4_000 },
    );
    const listed = TabSchema.parse({
      tabId: tab.id,
      kind: "page",
      title: "Draft",
      computer: { computerId: j.task.runnerId, name: "Main computer" },
      groupId: null,
      state: "open",
      usedBy: [{ taskId: threadId }],
      openedBy: "person",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      url: "https://example.test/",
      profile: { profileId: j.profile!.id, name: "Work" },
    });
    expect(
      threadAgentPage({ tabs: { rows: new Map([[tab.id, listed]]) } } as never, threadId),
    ).toEqual({ tabId: tab.id });
    const result = await working;
    expect(result.isError, text(result)).not.toBe(true);
  } finally {
    await j.close();
  }
});

it("runs a connected agent's script on a parked browser after one wake, and rebinds its cached page only with its witnesses", async () => {
  const j = await journey("direct-script", { profile: true });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    const page = await j.draft();
    const work = await directWork(j, () => home);
    const read = `return await page.js("document.querySelector('input').value")`;
    const first = await work.use(
      `globalThis.page = await openPage(${JSON.stringify(tab.id)}); ${read}`,
    );
    expect(first.isError, text(first)).not.toBe(true);
    expect(text(first)).toContain("unsent draft");
    // The script's state update is a protection fact: it is delivered before a park.
    await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
    expect(await home.coordinator.tryPark()).toBe("parked");
    // The call arrives while parked: it waits for one wake before anything is handed off.
    const resume = holdResume(j.controller);
    const parkedCall = work.use(read);
    await before(resume.seen, parkedCall, "The parked script");
    const waiting = await j.database
      .selectFrom("agentOperations")
      .select(["state", "handedOffAt"])
      .orderBy("createdAt", "desc")
      .executeTakeFirstOrThrow();
    expect(waiting).toMatchObject({ handedOffAt: null });
    resume.allow();
    const second = await parkedCall;
    expect(second.isError, text(second)).not.toBe(true);
    expect(text(second)).toContain("unsent draft");
    expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
    expect(await j.slot()).toMatchObject({ phase: "running", epoch: 2 });
    expect(await page.value()).toBe('["unsent draft",99]');
    // The page moves to another document while awake; the cached handle's witness no longer
    // matches after the next park, so it is not rebound.
    await page.cdp.send("Runtime.evaluate", { expression: "location.hash = '#moved'" });
    const previous = home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId;
    await page.cdp.send("Page.navigate", { url: "about:blank" });
    // A navigation in progress vetoes a park: wait until the new document is committed.
    await vi.waitFor(() =>
      expect(home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId).not.toBe(
        previous,
      ),
    );
    await vi.waitFor(async () => {
      const state = await page.cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      expect(state.result.value).toBe("complete");
      expect(home.coordinator.gate.held).toBe(0);
    });
    expect(await home.coordinator.tryPark()).toBe("parked");
    const third = await work.use(read);
    // Its witness names the old document: it is not rebound, and nothing reaches the page.
    expect(third.structuredContent).toMatchObject({
      error: { message: "The browser page attachment has ended.", performed: [] },
    });
    // Handed off, then the Home's own witness refused the script's page before any command left:
    // the script's failure, with nothing performed, and never unknown, since nothing left.
    expect(
      await j.database
        .selectFrom("agentOperations")
        .select(["state", "outcome", "handedOffAt"])
        .orderBy("createdAt", "desc")
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: "failed", outcome: "failed", handedOffAt: expect.any(Date) });
    expect(j.controller.effects).toEqual(["start", "pause", "resume", "pause", "resume"]);
  } finally {
    await j.close();
  }
});

it("keeps a connected agent's pooled browser_use page attachment alive across multiple commands, navigations, and openPage, and settles unknown if attachment ends after a command was sent", async () => {
  const site = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const step = url.searchParams.get("r") ?? "0";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><title>Step ${step}</title><p id="step">step-${step}</p><a href="/?r=linked">Next</a>`,
    );
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const j = await journey("direct-script-goto", { profile: true });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const work = await directWork(j, () => home);
    // 1. newPage + multiple commands (url, title, goto, url, title, locator click + waitForURL)
    const first = await work.use(
      `globalThis.p = await newPage(${JSON.stringify(`${origin}/?r=0`)}); print(await p.url()); print(await p.title()); await p.goto(${JSON.stringify(`${origin}/?r=1`)}); print(await p.url(), await p.title()); await p.locator("a").first().click(); await p.waitForURL(${JSON.stringify(`${origin}/?r=linked`)}); print(await p.title()); return p.tabId;`,
    );
    expect(first.isError, text(first)).not.toBe(true);
    expect(text(first)).toContain(`${origin}/?r=0`);
    expect(text(first)).toContain("Step 0");
    expect(text(first)).toContain(`${origin}/?r=1 Step 1`);
    expect(text(first)).toContain("Step linked");

    // 2. A second script using openPage(tabId) on the tab created by the first script succeeds on
    // its first and subsequent commands (including goto).
    // The page's own navigation (the link click) is saved shortly after the script returns.
    const createdTab = await vi.waitFor(async () => {
      const pages = await home.service.savedPages(j.task.userId, session.id);
      const tab = pages.find((row) => row.url?.includes("r=linked"));
      if (!tab?.pageBinding) throw new Error("Expected the navigated page tab.");
      return tab;
    });
    const second = await work.use(
      `const q = await openPage(${JSON.stringify(createdTab.id)}); print(await q.url()); await q.goto(${JSON.stringify(`${origin}/?r=2`)}); return await q.title();`,
    );
    expect(second.isError, text(second)).not.toBe(true);
    expect(text(second)).toContain(`${origin}/?r=linked`);
    expect(text(second)).toContain("Step 2");

    // Read the reported large DOM, plus a shorter answer whose JSON escapes put it over budget.
    const largeRead = await work.use(`
      const demo = await openPage(${JSON.stringify(createdTab.id)});
      const form = await newPage(${JSON.stringify(origin + "/?r=form")});
      print({ two: await Promise.all([demo.title(), form.title()]) });
      await demo.evaluate(() => {
        const content = document.createElement("div");
        content.hidden = true;
        content.textContent = "x".repeat(600 * 1024);
        document.body.append(content);
        const link = document.createElement("a");
        link.id = "large-popup";
        link.textContent = "Open test popup";
        link.href = "/popup";
        link.target = "_blank";
        document.body.prepend(link);
      });
      print({ htmlCharacters: await demo.evaluate(() => document.documentElement.outerHTML.length) });
      try {
        print({ unexpectedLargeLength: (await demo.evaluate(() => document.documentElement.outerHTML)).length });
      } catch (error) {
        print({ largeReadError: error.message });
      }
      try {
        await demo.evaluate(() => String.fromCharCode(34).repeat(300 * 1024));
        print({ unexpectedEscapedSuccess: true });
      } catch (error) {
        print({ escapedReadError: error.message });
      }
      print({ continued: await demo.title() });
      await demo.locator("#large-popup").click();
      await demo.waitForTimeout(2000);
      print({ afterPopup: await pages() });
    `);
    expect(largeRead.structuredContent, text(largeRead)).toMatchObject({
      status: "completed",
    });
    expect(text(largeRead)).toMatch(/answer is 60[0-9] KiB, over the 432 KiB limit/u);
    expect(text(largeRead)).toMatch(/escapedReadError.*over the 432 KiB limit/u);
    expect(text(largeRead)).toMatch(/afterPopup.*\/popup/u);
    const { rows: popupRows } = await j.tabs.snapshot(j.task.userId);
    expect(popupRows.find((row) => row.url === origin + "/popup")).toMatchObject({
      openedBy: createdTab.openedBy,
      openerTabId: createdTab.id,
    });
    const uncaught = await work.use(
      `const demo = await openPage(${JSON.stringify(createdTab.id)});
       return await demo.evaluate(() => document.documentElement.outerHTML);`,
    );
    expect(uncaught.structuredContent, text(uncaught)).toMatchObject({
      status: "failed",
      error: { message: expect.stringMatching(/answer is 60[0-9] KiB, over the 432 KiB limit/u) },
    });

    // 2b. Tab-targeted browser_use({ tabId, code }) also stays attached across its own goto.
    const tabTargeted = await work.useTab(
      `const t = await openPage(${JSON.stringify(createdTab.id)}); await t.goto(${JSON.stringify(`${origin}/?r=tab-nav`)}); return await t.title();`,
      createdTab.id,
    );
    expect(tabTargeted.isError, text(tabTargeted)).not.toBe(true);
    expect(text(tabTargeted)).toContain("Step tab-nav");

    // 3. A park/wake after the script's own navigation still rebinds the cached handle to the new document.
    await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
    expect(await home.coordinator.tryPark()).toBe("parked");
    const afterWake = await work.use(`return await p.title()`);
    expect(afterWake.isError, text(afterWake)).not.toBe(true);
    expect(text(afterWake)).toContain("Step tab-nav");

    // 4. Rule 4: if the attachment ends after a command was sent (e.g. target closes mid-script),
    // the operation settles as `unknown`, never `failed`.
    const lostCode = `await p.goto(${JSON.stringify(`${origin}/?r=3`)}); print("before close"); await p.close();
        try { await p.title(); } catch {}
        const recovery = await newPage(${JSON.stringify(`${origin}/?r=recovered`)});
        print("reopened", await recovery.title());`;
    const endedAfterSend = await work.use(lostCode);
    expect(endedAfterSend.structuredContent, text(endedAfterSend)).toMatchObject({
      status: "unknown",
      error: { code: "outcome-unknown", method: "Runtime.evaluate" },
    });
    expect(text(endedAfterSend)).toContain("before close");
    expect(text(endedAfterSend)).toContain("reopened Step recovered");
    expect(
      await j.database
        .selectFrom("agentOperations")
        .select(["state", "outcome", "resultSummary"])
        .orderBy("createdAt", "desc")
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      state: "unknown",
      outcome: "unknown",
      resultSummary: {
        texts: expect.any(Number),
        scriptError: { code: "outcome-unknown", method: "Runtime.evaluate" },
      },
    });
    const operationId = (endedAfterSend.structuredContent as { operationId: string }).operationId;
    const replay = await work.resume(lostCode, operationId);
    expect(replay.structuredContent, text(replay)).toMatchObject({
      status: "unknown",
      operationId,
      error: { code: "outcome-unknown", method: "Runtime.evaluate" },
    });
  } finally {
    site.close();
    await j.close();
  }
});

/** A connected agent's unanswered command on a saved profile's page, then the Runner's channel drops. */
async function unansweredAtChannelLoss(key: string, channelDeadlineMs: number) {
  const j = await journey(key, { profile: true, channelDeadlineMs });
  const home = await j.startHome();
  const { session } = await home.service.start({
    ownerId: j.task.userId,
    profileId: j.profile!.id,
  });
  const [tab] = await home.service.savedPages(j.task.userId, session.id);
  if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
  const page = await j.draft();
  const work = await directWork(j, () => home);
  const read = `return await page.js("document.querySelector('input').value")`;
  const bound = await work.use(`globalThis.page = await openPage(${JSON.stringify(tab.id)});`);
  expect(bound.isError, text(bound)).not.toBe(true);
  const sent = async () =>
    (
      await page.cdp.send<{ result: { value?: number } }>("Runtime.evaluate", {
        expression: "window.__sent ?? 0",
        returnByValue: true,
      })
    ).result.value;
  const document = home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId;
  // The page receives the command and never answers it.
  const hanging = work.use(
    `return await page.js("(window.__sent = (window.__sent ?? 0) + 1, new Promise(() => {}))")`,
  );
  await vi.waitFor(async () => expect(await sent()).toBe(1));
  j.runnerDown();
  // The agent hears that the Home lost track of it, never that it failed.
  const result = await hanging;
  expect(result.structuredContent, text(result)).toMatchObject({ status: "unknown" });
  const operations = () =>
    j.database
      .selectFrom("agentOperations")
      .select(["state", "outcome"])
      .orderBy("createdAt", "asc")
      .execute();
  const settled = [
    { state: "completed", outcome: "completed" },
    { state: "unknown", outcome: "unknown" },
  ];
  expect(await operations()).toEqual(settled);
  return { j, home, session, tab, page, work, read, sent, document, operations, settled };
}

it("keeps a session whose unanswered command was settled unknown when the Runner's channel dropped, and the Runner came back in time", async () => {
  const w = await unansweredAtChannelLoss("direct-unknown", 20_000);
  try {
    // The Runner comes back inside the window: the same page is reattached and usable, and the
    // command is never sent again.
    w.j.runnerUp();
    // The gate opens once the Runner is reachable; this session is back when its own reattach
    // is (a call meanwhile waits for it, per session). Read on the gate alone, the pages were
    // read before the reattach had them (workbench-1, 1 run in 3 to 11).
    await vi.waitFor(
      () => {
        expect(w.home.coordinator.gate.phase).toBe("open");
        expect(w.home.coordinator.reattaching(w.session.id)).toBe(false);
      },
      { timeout: 10_000 },
    );
    expect((await w.j.row(w.session.id))?.state).toBe("ready");
    expect(w.home.service.pageInventory(w.session.id)?.records.get(w.tab.id)?.documentId).toBe(
      w.document,
    );
    const again = await w.work.use(w.read);
    expect(again.isError, text(again)).not.toBe(true);
    expect(text(again)).toContain("unsent draft");
    expect(await w.sent()).toBe(1);
    expect((await w.operations()).slice(0, 2)).toEqual(w.settled);
  } finally {
    await w.j.close();
  }
});

it("lets a tab-targeted call made while the Runner's channel reconnects wait for it, never refuse it as not found", async () => {
  const w = await unansweredAtChannelLoss("direct-tab-reconnecting", 20_000);
  try {
    await vi.waitFor(() => expect(w.home.coordinator.gate.phase).toBe("reconnecting"));
    // The broker is gone with its channel: the page's document stands from when it was lost.
    expect(w.home.service.pageInventory(w.session.id)).toBeUndefined();
    let settled = false;
    const call = w.work.useTab(w.read, w.tab.id).finally(() => {
      settled = true;
    });
    // The call passed its witness and waits on admission for the browser to come back.
    await vi.waitFor(() => expect(w.home.coordinator.gate.demand).toBe(true));
    expect(settled).toBe(false);
    expect(w.home.coordinator.gate.phase).toBe("reconnecting");
    w.j.runnerUp();
    const result = await call;
    expect(result.isError, text(result)).not.toBe(true);
    expect(text(result)).toContain("unsent draft");
    expect(w.home.service.pageInventory(w.session.id)?.records.get(w.tab.id)?.documentId).toBe(
      w.document,
    );
    // The unanswered command is never sent again.
    expect(await w.sent()).toBe(1);
  } finally {
    w.j.runnerUp();
    await w.j.close();
  }
});

it("lets a tab-targeted call made while a crashed Home reattaches its sessions wait for them, never refuse it as not found", async () => {
  const j = await journey("direct-tab-crash", { profile: true, channelDeadlineMs: 20_000 });
  try {
    let home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    await j.draft();
    const document = home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId;
    // The Home dies while its Runner is away: the new Home has its tab rows, a session with no
    // channel, and no document it knows for the page.
    j.runnerDown();
    home = await j.crashHome(home);
    await vi.waitFor(() => expect(home.coordinator.gate.phase).toBe("reconnecting"), {
      timeout: 10_000,
    });
    expect(home.service.pageInventory(session.id)).toBeUndefined();
    const work = await directWork(j, () => home);
    let settled = false;
    const call = work
      .useTab(
        `const page = await openPage(${JSON.stringify(tab.id)});
         return await page.js("document.querySelector('input').value")`,
        tab.id,
      )
      .finally(() => {
        settled = true;
      });
    // Prevent an unhandled MCP 'Connection closed' rejection if an earlier assertion fails before await call.
    void call.catch(() => undefined);
    // The call passed the checks it can make now and waits on admission for the reattach.
    await until(() => expect(home.coordinator.gate.demand).toBe(true));
    expect(settled).toBe(false);
    j.runnerUp();
    const result = await call;
    expect(result.isError, text(result)).not.toBe(true);
    expect(text(result)).toContain("unsent draft");
    expect(home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId).toBe(document);
    expect((await j.row(session.id))?.state).toBe("ready");
  } finally {
    j.runnerUp();
    await j.close();
  }
});

it("waits for the named profile before a script opens its existing tab", async () => {
  const j = await journey("direct-profile-crash", { profile: true, channelDeadlineMs: 60_000 });
  const reattaching = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  try {
    let home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    await j.draft();
    j.runnerDown();
    home = await j.crashHome(home);
    const attach = j.guest.attach.bind(j.guest);
    vi.spyOn(j.guest, "attach").mockImplementationOnce(async (...args) => {
      reattaching.resolve();
      await resume.promise;
      return attach(...args);
    });
    j.runnerUp();
    await reattaching.promise;
    expect(home.coordinator.gate.phase).toBe("open");
    expect(home.service.pageInventory(session.id)?.ready).toBe(false);
    const work = await directWork(j, () => home);
    let settled = false;
    const call = work
      .use(
        `const page = await openPage(${JSON.stringify(tab.id)});
            return await page.js("document.querySelector('input').value")`,
      )
      .finally(() => {
        settled = true;
      });
    void call.catch(() => undefined);
    await until(() => expect(settled || home.coordinator.gate.demand).toBe(true));
    expect(settled, settled ? text(await call) : undefined).toBe(false);
    const other = await j.store.createBrowserProfile({
      name: "Other saved browser",
      ownerId: j.task.userId,
      homeRunnerId: j.task.runnerId,
      idempotencyKey: "other-saved-profile",
    });
    expect(
      await home.service.openTab(j.task.userId, {
        ...j.command("other-profile"),
        identity: { kind: "profile", profileId: other.id },
      }),
    ).toMatchObject({ tabId: expect.any(String) });
    expect(settled).toBe(false);
    resume.resolve();
    const result = await call;
    expect(result.isError, text(result)).not.toBe(true);
    expect(text(result)).toContain("unsent draft");
  } finally {
    resume.resolve();
    j.runnerUp();
    await j.close();
  }
});

it("reattaches a pooled profile and serves scripts after a crashed Home finds a session's last page closed", async () => {
  const j = await journey("direct-crash-gone-page", { profile: true, channelDeadlineMs: 60_000 });
  try {
    let home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    await j.draft();
    const gone = await home.service.openTab(j.task.userId, j.command("gone"));
    const gonePage = await j.draft();
    j.runnerDown();
    await gonePage.page.close();
    home = await j.crashHome(home);
    j.runnerUp();
    await until(async () => expect((await j.row(gone.sessionId))?.state).toBe("failed"));
    await until(() => expect(home.coordinator.gate.phase).toBe("open"));
    expect((await j.row(session.id))?.state).toBe("ready");
    expect(
      await listBrowserPoolDocumentLosses(j.database, j.task.userId, gone.tabId),
    ).toMatchObject([{ sessionId: gone.sessionId, surfaceId: gone.tabId, reason: "session-gone" }]);
    const work = await directWork(j, () => home);
    const result = await work.use(
      `const page = await openPage(${JSON.stringify(tab.id)});
       return await page.js("document.querySelector('input').value")`,
    );
    expect(result.isError, text(result)).not.toBe(true);
    expect(text(result)).toContain("unsent draft");
  } finally {
    j.runnerUp();
    await j.close();
  }
});

it("ends a session whose unanswered command was settled unknown with its note when the Runner does not come back", async () => {
  const w = await unansweredAtChannelLoss("direct-unknown-gone", 1_500);
  try {
    await vi.waitFor(() => expect(w.home.coordinator.gate.phase).toBe("open"), {
      timeout: 10_000,
    });
    expect((await w.j.row(w.session.id))?.state).toBe("failed");
    expect(
      await listBrowserPoolDocumentLosses(w.j.database, w.j.task.userId, w.tab.id),
    ).toMatchObject([{ sessionId: w.session.id, surfaceId: w.tab.id, reason: "not-adopted" }]);
    await vi.waitFor(() => expect(w.page.page.isClosed()).toBe(true), { timeout: 10_000 });
    expect(await w.operations()).toEqual(w.settled);
  } finally {
    w.j.runnerUp();
    await w.j.close();
  }
});

it("restarts only once a command in flight has its recorded outcome, and once per idempotency key", async () => {
  const j = await journey("direct-restart", { profile: true });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    const page = await j.draft();
    const work = await directWork(j, () => home);
    const bound = await work.use(`globalThis.page = await openPage(${JSON.stringify(tab.id)});`);
    expect(bound.isError, text(bound)).not.toBe(true);
    const hanging = work.use(`return await page.js("(window.__sent = 1, new Promise(() => {}))")`);
    await vi.waitFor(async () => {
      const sent = await page.cdp.send<{ result: { value?: number } }>("Runtime.evaluate", {
        expression: "window.__sent ?? 0",
        returnByValue: true,
      });
      expect(sent.result.value).toBe(1);
    });
    const latest = () =>
      j.database
        .selectFrom("agentOperations")
        .select(["state", "outcome"])
        .orderBy("createdAt", "desc")
        .executeTakeFirstOrThrow();
    expect(await latest()).toMatchObject({ state: "handed-off" });
    // When the controller is asked to stop the guest, the command already has its outcome.
    let atStop: unknown;
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    j.controller.hold("stop", async () => {
      atStop = await latest();
      reached.resolve();
      await release.promise;
    });
    const asked = vi.spyOn(home.coordinator, "restart");
    const restarting = home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "key-1");
    await reached.promise;
    // A second restart asked while one runs joins it.
    const joined = home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "key-2");
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(2));
    release.resolve();
    await Promise.all([restarting, joined]);
    expect(atStop).toEqual({ state: "unknown", outcome: "unknown" });
    expect((await hanging).structuredContent).toMatchObject({ status: "unknown" });
    expect(j.controller.effects).toEqual(["start", "stop", "start"]);
    expect((await j.row(session.id))?.state).toBe("failed");
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tab.id)).toMatchObject([
      { sessionId: session.id, reason: "person" },
    ]);
    // A retry after a lost response, with the same key: the first outcome, nothing discarded.
    await home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "key-1");
    expect(j.controller.effects).toEqual(["start", "stop", "start"]);
    expect(home.coordinator.gate.phase).toBe("open");
    // The joined restart's own retry: its key was recorded with the same start.
    await home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "key-2");
    expect(j.controller.effects).toEqual(["start", "stop", "start"]);
    // A later cold start that was not a restart (the saved state expired while parked) keeps
    // both keys handled.
    expect(await home.coordinator.tryPark()).toBe("parked");
    j.controller.observe({ phase: "stopped", savedState: null, epoch: null });
    (await home.coordinator.gate.reserve(AbortSignal.timeout(10_000))).release();
    expect(j.controller.effects).toEqual(["start", "stop", "start", "pause", "start"]);
    expect(await j.slot()).toMatchObject({
      lastStart: { reason: expect.not.stringMatching(/^person$/) },
    });
    for (const key of ["key-1", "key-2"])
      await home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, key);
    expect(j.controller.effects).toEqual(["start", "stop", "start", "pause", "start"]);
    expect(home.coordinator.gate.phase).toBe("open");
  } finally {
    await j.close();
  }
});

/** A connected agent that already used the profile, with the browser parked afterwards. */
async function parkedAfterWork(key: string, options: { readonly executionMs?: number } = {}) {
  const j = await journey(key, { profile: true });
  const home = await j.startHome();
  const { session } = await home.service.start({
    ownerId: j.task.userId,
    profileId: j.profile!.id,
  });
  const [tab] = await home.service.savedPages(j.task.userId, session.id);
  if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
  const page = await j.draft();
  const work = await directWork(j, () => home, options);
  const read = `return await page.js("document.querySelector('input').value")`;
  const first = await work.use(
    `globalThis.page = await openPage(${JSON.stringify(tab.id)}); ${read}`,
  );
  expect(first.isError, text(first)).not.toBe(true);
  const taskId = (first.structuredContent as { taskId: ThreadId }).taskId;
  await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
  expect(await home.coordinator.tryPark()).toBe("parked");
  const connection = commands(j.fixture, j.task.userId, {
    afterStop: (id, reason) => work.sessions.closeConnection(id, reason === "disconnect"),
  });
  return { j, home, session, tab, page, work, read, taskId, connection };
}

const parkedEffects = ["start", "pause"];

it("honours a Disconnect that arrives while the browser is parked, with its end shown and no wake", async () => {
  const p = await parkedAfterWork("parked-disconnect");
  try {
    await p.connection.revoke(p.work.agent.id);
    await p.j.store.driveConnectionCleanups();
    // A validly parked browser has no outstanding attempt: Disconnect shows its end at once.
    const [row] = (await p.connection.list()).filter(({ id }) => id === p.work.agent.id);
    expect(row).toMatchObject({ state: "stopped" });
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.j.slot()).toMatchObject({ phase: "parked" });
    const after = await p.work.use(p.read).catch((error: unknown) => error);
    expect(after).toBeInstanceOf(Error);
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.page.value()).toBe('["unsent draft",99]');
  } finally {
    await p.j.close();
  }
});

it("honours a grant cut that arrives while the browser is parked, refusing before any wake", async () => {
  const p = await parkedAfterWork("parked-grant");
  try {
    await p.connection.update(p.work.agent.id, {
      grant: { scope: "selected", tasks: false, resources: [] },
    });
    // A connection names only what it holds: with no browser profile left, the tool is gone.
    await expect(p.work.use(p.read)).rejects.toThrow("Method not found");
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.j.slot()).toMatchObject({ phase: "parked" });
  } finally {
    await p.j.close();
  }
});

it("honours a mode cut that arrives while the browser is parked: the call waits for the person, not for a wake", async () => {
  const p = await parkedAfterWork("parked-mode");
  try {
    await p.j.store.updateThreadAccessMode({
      threadId: p.taskId,
      requestedBy: p.j.task.userId,
      accessMode: "approval-required",
    });
    await p.work.sessions.lowerTaskMode(p.taskId, "approval-required");
    const after = await p.work.use(p.read);
    expect(after.structuredContent).toMatchObject({ status: "pending" });
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.j.slot()).toMatchObject({ phase: "parked" });
  } finally {
    await p.j.close();
  }
});

it("never wakes a parked browser for an approved call whose grant was cut before its hand-off", async () => {
  const p = await parkedAfterWork("parked-grant-after-approval");
  try {
    const ownerId = p.j.task.userId;
    await p.j.store.updateThreadAccessMode({
      threadId: p.taskId,
      requestedBy: ownerId,
      accessMode: "approval-required",
    });
    await p.work.sessions.lowerTaskMode(p.taskId, "approval-required");
    const pending = (await p.work.use(p.read)).structuredContent as {
      status: string;
      requestId: RequestId;
      operationId: string;
    };
    expect(pending.status).toBe("pending");
    await p.work.sessions.respond({
      requestId: pending.requestId,
      expectedRevision: (await p.j.store.requests.revision(pending.requestId))!,
      resolvedBy: ownerId,
      response: { kind: "form", answers: { decision: ["allow"] } },
    });
    // Between the person's approval and the hand-off, the grant is cut: the profile goes, a
    // second one keeps the tool listed.
    {
      const other = await p.j.store.createBrowserProfile({
        name: "Other",
        ownerId,
        homeRunnerId: p.j.task.runnerId,
        idempotencyKey: "other-profile",
      });
      await p.connection.update(p.work.agent.id, {
        grant: {
          scope: "selected",
          tasks: false,
          resources: [{ kind: "browser-profile", profileId: other.id }],
        },
      });
    }
    const resumed = await p.work.resume(p.read, pending.operationId);
    expect(text(resumed)).not.toContain("unsent draft");
    // Refused before anything could wake the browser.
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.j.slot()).toMatchObject({ phase: "parked" });
    const operation = await p.j.database
      .selectFrom("agentOperations")
      .select(["state", "handedOffAt"])
      .where("id", "=", pending.operationId as never)
      .executeTakeFirstOrThrow();
    expect(operation).toMatchObject({ state: "refused", handedOffAt: null });
  } finally {
    await p.j.close();
  }
});

it("never wakes a parked browser for a tab-targeted call whose tab changed before its hand-off", async () => {
  const p = await parkedAfterWork("parked-tab-changed");
  try {
    // The call's own target and witness read the tab as it was; from the next read on, the tab
    // has changed (another generation), as if the person rebound it in that interval.
    let reads = 0;
    p.work.changeTabs((tab) => (++reads > 2 ? { ...tab, generation: tab.generation + 1 } : tab));
    const result = await p.work.useTab(p.read, p.tab.id);
    expect(reads).toBe(3);
    expect(text(result)).not.toContain("unsent draft");
    // Refused before anything could wake the browser, and recorded so.
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.j.slot()).toMatchObject({ phase: "parked" });
    expect(
      await p.j.database
        .selectFrom("agentOperations")
        .select(["state", "handedOffAt"])
        .orderBy("createdAt", "desc")
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: "refused", handedOffAt: null });
  } finally {
    p.work.changeTabs(undefined);
    await p.j.close();
  }
});

it("records refused a tab-targeted call the Home refused after its hand-off, before any command", async () => {
  const p = await parkedAfterWork("handed-off-refused");
  try {
    // Every check up to the hand-off reads the tab as it was; the execute's own check after it
    // sees the tab changed, so nothing is sent.
    p.work.changeTabs(async (tab) => {
      const latest = await p.j.database
        .selectFrom("agentOperations")
        .select("handedOffAt")
        .where("tool", "=", "browser_connect")
        .executeTakeFirst();
      return latest?.handedOffAt ? { ...tab, generation: tab.generation + 1 } : tab;
    });
    const result = await p.work.connectTab(p.tab.id);
    expect(text(result)).toContain("not_found");
    expect(
      await p.j.database
        .selectFrom("agentOperations")
        .select(["state", "outcome", "handedOffAt"])
        .where("tool", "=", "browser_connect")
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: "refused", outcome: "refused", handedOffAt: expect.any(Date) });
  } finally {
    p.work.changeTabs(undefined);
    await p.j.close();
  }
});

it("honours a Stop of the agent's task that arrives while the browser is parked, without a wake", async () => {
  const p = await parkedAfterWork("parked-stop");
  try {
    const operation = await p.j.database
      .selectFrom("agentOperations")
      .select("sessionId")
      .orderBy("createdAt", "desc")
      .executeTakeFirstOrThrow();
    await p.work.sessions.stopSession({
      ownerUserId: p.j.task.userId,
      sessionId: operation.sessionId,
      threadId: p.taskId,
    });
    const after = await p.work.use(p.read);
    expect(after.isError).toBe(true);
    expect(text(after)).toContain("stopped");
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.j.slot()).toMatchObject({ phase: "parked" });
  } finally {
    await p.j.close();
  }
});

it("restarts at once with an unredeemed connection ticket, which no longer attaches", async () => {
  const j = await journey("restart-ticket", { profile: true });
  let endpoint: Awaited<ReturnType<typeof standardCdpEndpoint>> | undefined;
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    await j.draft();
    const work = await directWork(j, () => home);
    endpoint = await standardCdpEndpoint(() => home.service);
    const issued = await work.connect();
    expect(issued.isError, text(issued)).not.toBe(true);
    const { endpoint: url } = issued.structuredContent as { endpoint: string };
    // The ticket holds the gate until it is redeemed or ends: the restart revokes it first.
    expect(home.coordinator.gate.held).toBeGreaterThan(0);
    const asked = Date.now();
    await home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "with-ticket");
    expect(Date.now() - asked).toBeLessThan(15_000);
    expect(j.controller.effects).toEqual(["start", "stop", "start"]);
    await expect(endpoint.open(url)).rejects.toThrow();
  } finally {
    await endpoint?.close();
    await j.close();
  }
});

it("redeems no connection ticket and passes no frame while a restart holds admission", async () => {
  const j = await journey("ticket-held", { profile: true });
  let endpoint: Awaited<ReturnType<typeof standardCdpEndpoint>> | undefined;
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    await j.draft();
    const work = await directWork(j, () => home);
    endpoint = await standardCdpEndpoint(() => home.service);
    const endpointOf = async () => {
      const issued = await work.connect();
      expect(issued.isError, text(issued)).not.toBe(true);
      return (issued.structuredContent as { endpoint: string }).endpoint;
    };
    // A refusal comes back as the command's CDP error, or as a closed connection.
    const refused = (sent: Promise<unknown>) =>
      sent.then(
        (reply) => (reply as { error?: { message?: string } }).error?.message ?? "answered",
        () => "closed",
      );
    // The restart's hold is set before its turn quiesces anything: the interval the loop has
    // not reached yet. A ticket redeemed then attaches nothing (the handshake may complete).
    const unredeemed = await endpointOf();
    home.coordinator.gate.set({ hold: "restart" });
    const late = await endpoint.open(unredeemed).catch(() => undefined);
    if (late)
      expect(await refused(late.send("Target.getTargets"))).toBe(
        "This browser is restarting. Request a new attachment.",
      );
    home.coordinator.gate.set({ hold: null });
    // A connection already attached passes no frame once the hold is set.
    const attached = await endpoint.open(await endpointOf());
    expect(await refused(attached.send("Target.getTargets"))).toBe("answered");
    home.coordinator.gate.set({ hold: "restart" });
    expect(await refused(attached.send("Target.getTargets"))).not.toBe("answered");
    expect(j.controller.effects).toEqual(["start"]);
  } finally {
    await endpoint?.close();
    await j.close();
  }
});

it("refuses an attach whose restart hold began after its last check, at the dispatch itself", async () => {
  const j = await journey("attach-dispatch-held", { profile: true });
  let endpoint: Awaited<ReturnType<typeof standardCdpEndpoint>> | undefined;
  const issue = BrowserAttachTicketSigner.prototype.issue;
  let holdAtIssue: (() => void) | undefined;
  const issuing = vi
    .spyOn(BrowserAttachTicketSigner.prototype, "issue")
    .mockImplementation(function (this: BrowserAttachTicketSigner, ...args) {
      const ticket = Reflect.apply(issue, this, args) as ReturnType<typeof issue>;
      // The attach's ticket is issued after every await and just before its dispatch.
      if ((args[0] as { standardCdp?: unknown }).standardCdp) holdAtIssue?.();
      return ticket;
    });
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    await j.draft();
    const work = await directWork(j, () => home);
    endpoint = await standardCdpEndpoint(() => home.service);
    const issued = await work.connect();
    expect(issued.isError, text(issued)).not.toBe(true);
    const url = (issued.structuredContent as { endpoint: string }).endpoint;
    // What reaches the guest: an attach dispatched to its runtime.
    const reached = vi.spyOn(j.guest, "attachStandardCdp");
    holdAtIssue = () => {
      holdAtIssue = undefined;
      home.coordinator.gate.set({ hold: "restart" });
    };
    const refused = (sent: Promise<unknown>) =>
      sent.then(
        (reply) => (reply as { error?: { message?: string } }).error?.message ?? "answered",
        () => "closed",
      );
    const late = await endpoint.open(url).catch(() => undefined);
    const answer = late ? await refused(late.send("Target.getTargets")) : "closed";
    expect(holdAtIssue).toBeUndefined();
    expect(answer).not.toBe("answered");
    // Refused at the dispatch: nothing of it reached the guest.
    expect(reached).not.toHaveBeenCalled();
    expect(j.controller.effects).toEqual(["start"]);
  } finally {
    issuing.mockRestore();
    await endpoint?.close();
    await j.close();
  }
});

it("issues browser_connect for a parked browser after access checks and one wake, attaches for real, and refuses a frame for another document", async () => {
  const j = await journey("direct-connect", { profile: true });
  let endpoint: Awaited<ReturnType<typeof standardCdpEndpoint>> | undefined;
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    await j.draft();
    const work = await directWork(j, () => home);
    endpoint = await standardCdpEndpoint(() => home.service);
    await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
    expect(await home.coordinator.tryPark()).toBe("parked");
    // Access is checked from Home data first: a profile outside the grant wakes nothing.
    const outside = await work.agent.client.callTool({
      name: "browser_connect",
      arguments: { profileId: "bpr_00000000-0000-4000-8000-000000000000", reason: "x" },
    });
    expect(outside.isError).toBe(true);
    expect(j.controller.effects).toEqual(["start", "pause"]);
    // One wake, then the ticket.
    const resume = holdResume(j.controller);
    const calling = work.connect();
    await before(resume.seen, calling, "The ticket");
    resume.allow();
    const issued = await calling;
    expect(issued.isError, text(issued)).not.toBe(true);
    const { endpoint: url } = issued.structuredContent as { endpoint: string };
    expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
    // An outstanding ticket holds the gate: no park, so there is no wake after issue.
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    const cdp = await endpoint.open(url);
    const targets = (await cdp.send("Target.getTargets")) as {
      result: { targetInfos: { targetId: string; type: string }[] };
    };
    const page = targets.result.targetInfos.find(({ type }) => type === "page");
    expect(page).toBeDefined();
    const attached = (await cdp.send("Target.attachToTarget", {
      targetId: page!.targetId,
      flatten: true,
    })) as { result: { sessionId: string } };
    const evaluated = (await cdp.send(
      "Runtime.evaluate",
      { expression: "1 + 1", returnByValue: true },
      attached.result.sessionId,
    )) as { result: { result: { value: number } } };
    expect(evaluated.result.result.value).toBe(2);
    expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
    // The agent's page reloads into a new document: the next frame is refused and the socket
    // closes. (The runtime refuses a data: navigation, so a reload makes the new document.)
    for (const target of targets.result.targetInfos.filter(({ type }) => type === "page")) {
      const session = (await cdp.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      })) as { result: { sessionId: string } };
      await cdp.send("Page.reload", {}, session.result.sessionId);
    }
    await vi.waitFor(async () => {
      await expect(
        cdp.send("Runtime.evaluate", { expression: "2" }, attached.result.sessionId),
      ).rejects.toThrow("closed");
    });
    // Every exit releases the hold: the browser can park again.
    await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
    expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
  } finally {
    await endpoint?.close();
    await j.close();
  }
});

it("keeps a connected agent's paste, copy and cut off the browser's clipboard in its own page, through browser_use and browser_connect", async () => {
  const sentence =
    "The clipboard is not available to a connected agent. Use Input.insertText to enter text.";
  const permissionSentence = "Browser permissions cannot be changed by a connected agent.";
  const sentinel = `opensteer-clipboard-sentinel-${randomUUID()}`;
  /** What a script returned, encoded so that no transcript escaping can change it. */
  const outcomeOf = (result: Parameters<typeof text>[0]): unknown =>
    JSON.parse(decodeURIComponent(/outcome:([^:"\\]*):end/u.exec(text(result))![1]!));
  // A secure origin, so that the page's own clipboard API exists in the agent's page.
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Form</title><input id=field>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const form = `http://127.0.0.1:${(site.address() as AddressInfo).port}/form`;
  const j = await journey("direct-clipboard", { profile: true });
  let endpoint: Awaited<ReturnType<typeof standardCdpEndpoint>> | undefined;
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    // The agent's own page loads the form before the agent binds it: a pooled script is bound to
    // one document.
    const own = await j.launched()!.context.pages().at(-1)!.cdp();
    const previous = home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId;
    await own.send("Page.navigate", { url: form });
    await vi.waitFor(async () => {
      expect(home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId).not.toBe(
        previous,
      );
      const state = await own.send<{ result: { value: string } }>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      expect(state.result.value).toBe("complete");
    });
    // A page in the same browser that the connection does not hold: the sentinel is copied there
    // with the browser's own copy command, outside any agent's CDP.
    const other = await j.launched()!.context.createPage();
    const person = await other.cdp();
    const key = (commands: string[], code: string) =>
      ["rawKeyDown", "keyUp"].map((type) =>
        person.send("Input.dispatchKeyEvent", {
          type,
          modifiers: 4,
          key: code.slice(3).toLowerCase(),
          code,
          ...(type === "keyUp" ? {} : { commands }),
        }),
      );
    const value = async (id: string) =>
      (
        await person.send<{ result: { value: string } }>("Runtime.evaluate", {
          expression: `document.getElementById(${JSON.stringify(id)}).value`,
          returnByValue: true,
        })
      ).result.value;
    const focus = (id: string) =>
      person.send("Runtime.evaluate", {
        expression: `(document.getElementById(${JSON.stringify(id)}).focus(), document.getElementById(${JSON.stringify(id)}).select())`,
      });
    await person.send("Runtime.evaluate", {
      expression: `document.body.innerHTML = '<input id="secret" value=${JSON.stringify(sentinel)}><input id="probe"><input id="after">'`,
    });
    await focus("secret");
    await Promise.all(key(["copy"], "KeyC"));
    /** What the browser's clipboard holds, read by pasting into a field of the person's page. */
    const clipboard = async (id: string) => {
      await focus(id);
      await Promise.all(key(["paste"], "KeyV"));
      return value(id);
    };
    expect(await clipboard("probe")).toBe(sentinel);

    const work = await directWork(j, () => home);
    const pasted = await work.use(`
      const page = await openPage(${JSON.stringify(tab.id)});
      await page.js("document.getElementById('field').focus(); location.origin");
      const refused = [];
      const attempt = async (name, run) => {
        try { await run(); refused.push([name, "performed"]); }
        catch (error) { refused.push([name, String(error && error.message)]); }
      };
      await attempt("Meta+V", () => page.keyboard.press("Meta+V"));
      await attempt("Control+V", () => page.keyboard.press("Control+V"));
      await attempt("Shift+Insert", () => page.keyboard.press("Shift+Insert"));
      await attempt("stated", () => page.pressKey("v", { modifiers: 4, commands: ["paste"] }));
      await attempt("pasteAndMatchStyle", () => page.pressKey("v", { modifiers: 12, commands: ["pasteAndMatchStyle"] }));
      for (const permission of ["clipboardReadWrite", "audioCapture", "videoCapture", "geolocation"])
        await attempt(permission, () => page.cdp("Browser.grantPermissions", { permissions: [permission] }));
      await attempt("setPermission", () => page.cdp("Browser.setPermission", { permission: { name: "camera" }, setting: "granted" }));
      await attempt("resetPermissions", () => page.cdp("Browser.resetPermissions", {}));
      const read = await page.cdp("Runtime.evaluate", {
        expression: "navigator.clipboard.readText().then(t => 'read:' + t, e => 'denied:' + e.name)",
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
      });
      const execPaste = await page.js("document.execCommand('paste')");
      return "outcome:" + encodeURIComponent(JSON.stringify({
        refused,
        read: read.result.value,
        execPaste,
        value: await page.js("document.getElementById('field').value"),
        html: await page.js("document.documentElement.outerHTML"),
      })) + ":end";
    `);
    expect(pasted.isError, text(pasted)).not.toBe(true);
    const outcome = outcomeOf(pasted) as {
      refused: [string, string][];
      read: string;
      execPaste: boolean;
      value: string;
      html: string;
    };
    const { html: _html, ...seen } = outcome;
    expect(outcome.refused, JSON.stringify(seen)).toEqual([
      ...["Meta+V", "Control+V", "Shift+Insert", "stated", "pasteAndMatchStyle"].map((name) => [
        name,
        expect.stringContaining(sentence),
      ]),
      ...[
        "clipboardReadWrite",
        "audioCapture",
        "videoCapture",
        "geolocation",
        "setPermission",
        "resetPermissions",
      ].map((name) => [name, expect.stringContaining(permissionSentence)]),
    ]);
    expect(outcome.read).toMatch(/^denied:/u);
    expect(outcome.execPaste).toBe(false);
    expect(outcome.value).toBe("");
    expect(text(pasted)).not.toContain(sentinel);

    // The reverse: the agent's copy and cut leave the clipboard holding what it held.
    const copied = await work.use(`
      const page = await openPage(${JSON.stringify(tab.id)});
      await page.js("const field = document.getElementById('field'); field.value = 'agent-text'; field.focus(); field.select(); true");
      const refused = [];
      for (const chord of ["Meta+C", "Meta+X", "Control+C", "Control+X", "Control+Insert", "Shift+Delete"]) {
        try { await page.keyboard.press(chord); refused.push(chord + ": performed"); }
        catch (error) { refused.push(chord + ": " + String(error && error.message)); }
      }
      return "outcome:" + encodeURIComponent(JSON.stringify({
        refused,
        value: await page.js("document.getElementById('field').value"),
      })) + ":end";
    `);
    expect(copied.isError, text(copied)).not.toBe(true);
    const copy = outcomeOf(copied) as { refused: string[]; value: string };
    expect(copy.refused).toEqual(
      ["Meta+C", "Meta+X", "Control+C", "Control+X", "Control+Insert", "Shift+Delete"].map(
        (chord) =>
          expect.stringMatching(new RegExp(`^${chord.replace("+", "\\+")}: .*${sentence}`, "u")),
      ),
    );
    // Cut left the agent's text where it was.
    expect(copy.value).toBe("agent-text");
    expect(await clipboard("after")).toBe(sentinel);

    // The same through a standard CDP connection, before anything reaches the page.
    endpoint = await standardCdpEndpoint(() => home.service);
    const issued = await work.connect();
    expect(issued.isError, text(issued)).not.toBe(true);
    const { endpoint: url } = issued.structuredContent as { endpoint: string };
    const cdp = await endpoint.open(url);
    const targets = (await cdp.send("Target.getTargets")) as {
      result: { targetInfos: { targetId: string; type: string }[] };
    };
    const page = targets.result.targetInfos.find(({ type }) => type === "page")!;
    const attached = (await cdp.send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    })) as { result: { sessionId: string } };
    const pageSession = attached.result.sessionId;
    await cdp.send(
      "Runtime.evaluate",
      {
        expression:
          "document.body.innerHTML = '<input id=field>'; document.getElementById('field').focus()",
      },
      pageSession,
    );
    const cmdV = {
      type: "rawKeyDown",
      modifiers: 4,
      key: "v",
      code: "KeyV",
      windowsVirtualKeyCode: 86,
    };
    for (const [method, params, scope] of [
      ["Input.dispatchKeyEvent", cmdV, pageSession],
      ["Input.dispatchKeyEvent", { ...cmdV, commands: ["paste"] }, pageSession],
      ["Input.dispatchKeyEvent", { ...cmdV, modifiers: 2 }, pageSession],
      [
        "Input.dispatchKeyEvent",
        { ...cmdV, key: "c", code: "KeyC", windowsVirtualKeyCode: 67 },
        pageSession,
      ],
    ] as const)
      expect(await cdp.send(method, params, scope), method).toMatchObject({
        error: { message: sentence },
      });
    // No permission changes at all, on the root or on its page.
    for (const scope of [undefined, pageSession])
      for (const [method, params] of [
        ["Browser.grantPermissions", { permissions: ["clipboardReadWrite"] }],
        ["Browser.grantPermissions", { permissions: ["audioCapture"] }],
        ["Browser.grantPermissions", { permissions: ["videoCapture"] }],
        ["Browser.grantPermissions", { permissions: ["geolocation"] }],
        ["Browser.setPermission", { permission: { name: "clipboard-read" }, setting: "granted" }],
        ["Browser.resetPermissions", {}],
      ] as const)
        expect(await cdp.send(method, params, scope), `${method} ${String(scope)}`).toMatchObject({
          error: { message: permissionSentence },
        });
    const field = (await cdp.send(
      "Runtime.evaluate",
      {
        expression: "[document.getElementById('field').value, document.documentElement.outerHTML]",
        returnByValue: true,
      },
      pageSession,
    )) as { result: { result: { value: [string, string] } } };
    expect(field.result.result.value[0]).toBe("");
    expect(field.result.result.value[1]).not.toContain(sentinel);
    expect(await clipboard("probe")).toBe(sentinel);
  } finally {
    await endpoint?.close();
    await j.close();
    site.close();
  }
});

it("keeps a person's own Run's paste chord as before, and refuses its clipboard grant, in real Chromium", async () => {
  const clipboardGrantSentence =
    "Clipboard permissions cannot be granted to a page. Paste with a key chord, or use Input.insertText to enter text.";
  const sentinel = `opensteer-clipboard-sentinel-${randomUUID()}`;
  // A secure origin, so that the page's own clipboard API exists.
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Form</title><input id=field>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const form = `http://127.0.0.1:${(site.address() as AddressInfo).port}/form`;
  const j = await journey("own-clipboard");
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(
      j.task.userId,
      j.command("own-clipboard"),
    );
    const own = await j.launched()!.context.pages().at(-1)!.cdp();
    const previous = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    await own.send("Page.navigate", { url: form });
    await vi.waitFor(async () => {
      expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).not.toBe(
        previous,
      );
      const state = await own.send<{ result: { value: string } }>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      expect(state.result.value).toBe("complete");
    });
    // The sentinel is copied in another page of the same browser, outside any agent's CDP.
    const other = await (await j.launched()!.context.createPage()).cdp();
    await other.send("Runtime.evaluate", {
      expression: `document.body.innerHTML = '<input id="secret" value=${JSON.stringify(sentinel)}>'; document.getElementById('secret').focus(); document.getElementById('secret').select()`,
    });
    for (const type of ["rawKeyDown", "keyUp"])
      await other.send("Input.dispatchKeyEvent", {
        type,
        modifiers: 4,
        key: "c",
        code: "KeyC",
        ...(type === "keyUp" ? {} : { commands: ["copy"] }),
      });

    const run = {
      agentBindingId: `run:${j.task.runId}`,
      ownerId: j.task.userId,
      environmentId: j.task.environmentId,
      threadId: j.task.threadId,
    };
    const scope = await j.store.runCapabilityScope(j.task.runId);
    if (!scope) throw new Error("The test Run has no browser authority.");
    const bound = await home.service.bindPage(
      {
        ...scope,
        aud: "opensteer-run-tools",
        iss: "opensteer-host",
        jti: randomUUID(),
        iat: 1,
        exp: 2,
      },
      (await j.tabs.get(j.task.userId, tabId))!,
    );
    const cdp = await home.service.attachCdpForAgent(
      { ...run, sessionId: bound.sessionId },
      () => {},
    );
    try {
      const { targetInfos } = (await cdp.request({ method: "Target.getTargets" })) as {
        targetInfos: { targetId: string; url: string }[];
      };
      const target = targetInfos.find(({ url }) => url === form)!;
      const { sessionId: page } = (await cdp.request({
        method: "Target.attachToTarget",
        parameters: { targetId: target.targetId, flatten: true },
      })) as { sessionId: string };
      const evaluate = async (expression: string, userGesture = false) =>
        (
          (await cdp.request({
            method: "Runtime.evaluate",
            parameters: { expression, awaitPromise: true, returnByValue: true, userGesture },
            sessionId: page,
          })) as { result: { value: unknown } }
        ).result.value;
      await evaluate("document.getElementById('field').focus()");
      // The person's own Run keeps what #638 gave it: paste by chord.
      for (const type of ["rawKeyDown", "keyUp"])
        await cdp.request({
          method: "Input.dispatchKeyEvent",
          parameters: {
            type,
            modifiers: 4,
            key: "v",
            code: "KeyV",
            ...(type === "keyUp" ? {} : { commands: ["paste"] }),
          },
          sessionId: page,
        });
      expect(await evaluate("document.getElementById('field').value")).toBe(sentinel);
      // A clipboard grant would outlast the Run and serve a connected agent's page script.
      for (const scope of [undefined, page])
        for (const parameters of [
          { permissions: ["clipboardReadWrite"] },
          { permissions: ["clipboardSanitizedWrite"] },
        ])
          await expect(
            cdp.request({
              method: "Browser.grantPermissions",
              parameters,
              ...(scope ? { sessionId: scope } : {}),
            }),
          ).rejects.toThrow(clipboardGrantSentence);
      expect(
        await evaluate(
          "navigator.clipboard.readText().then(t => 'read:' + t, e => 'denied:' + e.name)",
          true,
        ),
      ).toMatch(/^denied:/u);
    } finally {
      if (cdp.pooledClose) await cdp.pooledClose();
      else cdp.close();
    }
  } finally {
    await j.close();
    site.close();
  }
});

it("V2 (Opus M1): turning off the device Browser switch during browserSend.recheck refuses newPage without opening a page", async () => {
  let browserSwitchOn = true;
  let accessChecks = 0;
  const j = await journey("direct-v2-switch-off", {
    profile: true,
    chromium: false,
    requireAgentAccess: async () => {
      accessChecks += 1;
      if (!browserSwitchOn) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Browser access is turned off on this device.",
        });
      }
    },
  });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const pagesBefore = home.service.pageInventory(session.id)?.records.size ?? 0;
    expect(pagesBefore).toBe(1);
    const work = await directWork(j, () => home);

    // Flip the device Browser switch OFF and run disableAgentAccess inside browserSend.recheck()'s
    // requireSelfDeviceId read — after #resumeTabOpen's #requireAgentAccess check already passed
    // and after send() released the Runner admission lane.
    const originalRequireDevice = j.store.requireSelfDeviceId.bind(j.store);
    let flipped = false;
    const deviceSpy = vi
      .spyOn(j.store, "requireSelfDeviceId")
      .mockImplementation(async (runnerId) => {
        const id = await originalRequireDevice(runnerId);
        // Once #resumeTabOpen's recheck has run its #requireAgentAccess check (accessChecks >= 2
        // during the openTab flow), simulate server.ts turning Browser off for this device.
        if (!flipped && accessChecks >= 2) {
          flipped = true;
          await home.service.withRunnerAdmission(j.task.runnerId, async () => {
            browserSwitchOn = false;
            await home.service.disableAgentAccess(j.task.runnerId);
          });
        }
        return id;
      });
    try {
      const result = await work.use(`await newPage("https://example.test/"); return "opened";`);
      expect(flipped).toBe(true);
      expect(result.isError).toBe(true);
      const pagesAfter = home.service.pageInventory(session.id)?.records.size ?? 0;
      expect(pagesAfter).toBe(pagesBefore);
    } finally {
      deviceSpy.mockRestore();
    }
  } finally {
    await j.close();
  }
});

it("lists, in its next call, a page a connected agent's script opened and left by throwing, and closes it", async () => {
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Left open</title><p>left</p>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const j = await journey("direct-pages-left", { profile: true });
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    const work = await directWork(j, () => home);
    // The script opens a page and throws before it closes it, as the real machine's did.
    const left = await work.use(
      `const page = await newPage(${JSON.stringify(`${origin}/left`)}); print(page.tabId); throw new Error("before its close");`,
    );
    expect(left.isError, text(left)).toBe(true);
    const tabId = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(text(left))?.[0];
    if (!tabId) throw new Error(`The script printed no tab: ${text(left)}`);
    // The next call of the same connection lists it ...
    const listed = await work.use("return (await pages()).map((page) => page.tabId);");
    expect(listed.isError, text(listed)).not.toBe(true);
    expect(text(listed)).toContain(tabId);
    // ... and closes it.
    const closed = await work.use(
      `const page = await openPage(${JSON.stringify(tabId)}); await page.close(); await sleep(500); return (await pages()).map((page) => page.tabId);`,
    );
    expect(closed.isError, text(closed)).not.toBe(true);
    expect(text(closed)).not.toContain(tabId);
    // A script that ends unknown (its other page closed under a command it had sent) leaves the
    // page it kept: the next call lists it too, and closes it.
    const lost = await work.use(
      `const kept = await newPage(${JSON.stringify(`${origin}/kept`)}); print(kept.tabId); const gone = await newPage(${JSON.stringify(`${origin}/gone`)}); await gone.close(); return await gone.title();`,
    );
    expect(lost.structuredContent, text(lost)).toMatchObject({ status: "unknown" });
    // An unknown result carries no output: the kept page is found by its address in the Home's rows.
    const keptId = await vi.waitFor(async () => {
      const kept = (await j.tabs.snapshot(j.task.userId)).rows.find(
        (row) => row.kind === "page" && row.url?.includes("/kept"),
      );
      if (!kept) throw new Error("The kept page has no tab row.");
      return kept.id;
    });
    const relisted = await work.use("return (await pages()).map((page) => page.tabId);");
    expect(relisted.isError, text(relisted)).not.toBe(true);
    expect(text(relisted)).toContain(keptId);
    const reclosed = await work.use(
      `const page = await openPage(${JSON.stringify(keptId)}); await page.close(); await sleep(500); return (await pages()).map((page) => page.tabId);`,
    );
    expect(reclosed.isError, text(reclosed)).not.toBe(true);
    expect(text(reclosed)).not.toContain(keptId);
  } finally {
    await j.close();
    site.close();
  }
});

it("lets a connected agent reach the page-handle limit with pages its scripts left, then list and close them all and go on", async () => {
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Left open</title><p>left</p>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const j = await journey("direct-pages-limit", { profile: true });
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    const work = await directWork(j, () => home);
    const left: string[] = [];
    // Scripts that each open a page and fail before closing it, until the limit refuses one.
    for (let index = 0; index < 20; index++) {
      const result = await work.use(
        `const page = await newPage(${JSON.stringify(`${origin}/left-${index}`)}); print(page.tabId); throw new Error("before its close");`,
      );
      const tabId = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(text(result))?.[0];
      if (!tabId) {
        expect(text(result)).toContain("At most 16 page handles");
        // The limit says how to get out.
        expect(text(result)).toContain("pages()");
        break;
      }
      left.push(tabId);
    }
    expect(left).toHaveLength(16);
    // The next call lists every page it left, and closes them.
    const cleared = await work.use(
      `const left = new Set(${JSON.stringify(left)}); for (const listed of await pages()) if (left.has(listed.tabId)) await (await openPage(listed.tabId)).close(); await sleep(500); return (await pages()).map((page) => page.tabId);`,
    );
    expect(cleared.isError, text(cleared)).not.toBe(true);
    for (const tabId of left) expect(text(cleared)).not.toContain(tabId);
    // Closed pages count no more: the agent opens a new one.
    const next = await work.use(
      `const page = await newPage(${JSON.stringify(`${origin}/next`)}); const id = page.tabId; await page.close(); return id;`,
    );
    expect(next.isError, text(next)).not.toBe(true);
  } finally {
    await j.close();
    site.close();
  }
});

it("ends the page of every tab the person closes while a connected agent's handle holds it: the handle ends in plain words and the agent opens a new page", async () => {
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Held</title><p>held</p>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const j = await journey("direct-pages-person-close", { profile: true });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [own] = await home.service.savedPages(j.task.userId, session.id);
    if (!own?.pageBinding) throw new Error("The saved profile has no durable tab.");
    const work = await directWork(j, () => home);
    // The agent opens a page of its own and binds the person's tab, and keeps both handles.
    const held = await work.use(
      `globalThis.mine = await newPage(${JSON.stringify(`${origin}/held`)}); globalThis.theirs = await openPage(${JSON.stringify(own.id)}); return mine.tabId;`,
    );
    expect(held.isError, text(held)).not.toBe(true);
    const mineId = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(text(held))?.[0];
    if (!mineId) throw new Error(`The script returned no tab: ${text(held)}`);
    // The person closes both, by the route the web app's close-all calls (tabs.close).
    const tabs = new TabService({
      store: j.tabs,
      pages: home.service.pageTabs,
      nativeTargets: { onTargetAcquired: () => () => undefined },
      authorizeMembership: async () => undefined,
      onError: (error: unknown) => {
        throw error;
      },
    } as never);
    const result = await tabs.close(
      { kind: "person", ownerId: j.task.userId },
      [mineId as TabRecord["id"], own.id],
      "person-close-all",
    );
    expect(result.failed).toEqual([]);
    expect([...result.closed].sort()).toEqual([mineId, own.id].sort());
    // Each page closes, the agent's and the person's own alike: closing a tab ends its page,
    // whoever opened it and whatever holds it.
    await vi.waitFor(
      () => {
        expect(home.service.tabStateOf(session.id, mineId as never)).toBeUndefined();
        expect(home.service.tabStateOf(session.id, own.id)).toBeUndefined();
      },
      { timeout: 10_000 },
    );
    // The agent's handles end as a closed page's do: an ordinary error its script catches, in
    // plain words, the next use and every one after it; and the agent goes on in a new page.
    const after = await work.use(
      `const out = []; for (const page of [mine, theirs]) for (let use = 0; use < 2; use++) { try { await page.title(); out.push("ran"); } catch (error) { out.push(error.code + ": " + error.message); } } const fresh = await newPage(${JSON.stringify(`${origin}/again`)}); out.push("fresh:" + await fresh.title()); out.push("listed:" + JSON.stringify((await pages()).map((page) => page.tabId))); return out;`,
    );
    expect(after.isError, text(after)).not.toBe(true);
    const lines = JSON.parse(
      (after.content as { type: string; text: string }[]).find(({ type }) => type === "text")!.text,
    ) as string[];
    expect(lines, text(after)).toHaveLength(6);
    for (const first of [lines[0], lines[2]])
      expect(first).toMatch(
        /^conflict: (?:page\.\w+\(\): )?The browser page attachment has ended\.$/u,
      );
    // A later use reads as a narrowed-away handle's later use does: nothing of it is left.
    for (const later of [lines[1], lines[3]])
      expect(later).toMatch(
        /This page handle has ended\. Bind the tab again with openPage\(tabId\)\./u,
      );
    expect(lines[4]).toBe("fresh:Held");
    expect(lines[5]).not.toContain(mineId);
    expect(lines[5]).not.toContain(own.id);
  } finally {
    await j.close();
    site.close();
  }
});

it("tells the agent and the person that the person closed the tab a call was using: its outcome unknown, its cause said", async () => {
  const hits: string[] = [];
  const site = createServer((request, response) => {
    hits.push(request.url ?? "/");
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Held</title><p>held</p>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const j = await journey("direct-person-close-mid-call", { profile: true });
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    const work = await directWork(j, () => home);
    const held = await work.use(
      `globalThis.mine = await newPage(${JSON.stringify(`${origin}/held`)}); return mine.tabId;`,
    );
    expect(held.isError, text(held)).not.toBe(true);
    const mineId = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(text(held))?.[0];
    if (!mineId) throw new Error(`The script returned no tab: ${text(held)}`);
    // The agent's script uses the page, waits, and uses it again: the person closes the tab
    // between the two, as the tester did.
    const running = work.use(
      `const marker = (await mine.title()) + "-private-timeout-marker";
       print(marker);
       await mine.goto(${JSON.stringify(`${origin}/started`)});
       await mine.waitForTimeout(4000);
       try { await mine.title(); } catch {}
       throw new Error(marker);`,
    );
    await vi.waitFor(() => expect(hits).toContain("/started"), { timeout: 15_000 });
    const tabs = new TabService({
      store: j.tabs,
      pages: home.service.pageTabs,
      nativeTargets: { onTargetAcquired: () => () => undefined },
      authorizeMembership: async () => undefined,
      onError: (error: unknown) => {
        throw error;
      },
    } as never);
    const closed = await tabs.close(
      { kind: "person", ownerId: j.task.userId },
      [mineId as TabRecord["id"]],
      "person-close-mid-call",
    );
    expect(closed.failed).toEqual([]);
    // Rule 4: a command was in flight, so its effect is unknown; the Home knows why, and says so.
    const result = await running;
    expect(result.structuredContent, text(result)).toMatchObject({
      status: "unknown",
      next: "The person closed this tab while the command ran; whether it took effect is unknown. Open the page again if you still need it.",
    });
    expect(text(result)).not.toContain("lost track");
    expect(JSON.stringify(result)).not.toContain("Held-private-timeout-marker");
    const operation = await j.database
      .selectFrom("agentOperations")
      .select(["id", "state", "outcome", "ending", "resultSummary"])
      .orderBy("createdAt", "desc")
      .executeTakeFirstOrThrow();
    expect(operation).toMatchObject({
      state: "unknown",
      outcome: "unknown",
      ending: "tab-closed",
      resultSummary: null,
    });
    // The person's activity reads the same cause.
    const [listed] = (
      await listAgentOperations(j.database, {
        userId: j.task.userId,
        connectionId: work.agent.id,
        limit: 1,
      })
    ).operations;
    expect(operationRow(listed!).detail).toBe(
      "You closed this tab while it ran, so Opensteer can’t say whether this happened. Check before trying again.",
    );
  } finally {
    await j.close();
    site.close();
  }
});

/** The person's own close and reopen, by the routes the web app calls. */
function personTabs(
  j: Journey,
  home: Home,
  closed?: (ownerId: TabRecord["ownerId"], tabId: TabRecord["id"]) => void,
) {
  return new TabService({
    store: j.tabs,
    pages: home.service.pageTabs,
    nativeTargets: { onTargetAcquired: () => () => undefined },
    authorizeMembership: async () => undefined,
    onError: (error: unknown) => {
      throw error;
    },
    ...(closed ? { closed } : {}),
  } as never);
}

const tabClosedSentence =
  "The person closed this tab while the command ran; whether it took effect is unknown. Open the page again if you still need it.";

it("never says the person closed a tab while a command ran when they closed it before the call began", async () => {
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Page</title><p>page</p>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const j = await journey("direct-person-closed-before", { profile: true });
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    const work = await directWork(j, () => home);
    const opened = await work.use(
      `globalThis.closed = await newPage(${JSON.stringify(`${origin}/closed`)}); globalThis.other = await newPage(${JSON.stringify(`${origin}/other`)}); return closed.tabId;`,
    );
    const closedId = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(text(opened))?.[0];
    if (!closedId) throw new Error(`The script returned no tab: ${text(opened)}`);
    // The person closes the tab and its page ends; only afterwards does the next call begin.
    const row = await j.tabs.get(j.task.userId, closedId as TabRecord["id"]);
    if (!row?.pageBinding) throw new Error("The closed tab had no page.");
    await personTabs(j, home).close(
      { kind: "person", ownerId: j.task.userId },
      [closedId as TabRecord["id"]],
      "person-close-before",
    );
    await vi.waitFor(
      () =>
        expect(
          home.service.tabStateOf(row.pageBinding!.sessionId, row.pageBinding!.surfaceId),
        ).toBeUndefined(),
      { timeout: 10_000 },
    );
    // It sends on another page, then touches its stale handle to the closed one.
    const later = await work.use(`await other.title(); return await closed.title();`);
    expect(text(later)).not.toContain(tabClosedSentence);
    const operation = await j.database
      .selectFrom("agentOperations")
      .select(["ending"])
      .orderBy("createdAt", "desc")
      .executeTakeFirstOrThrow();
    expect(operation.ending).not.toBe("tab-closed");
  } finally {
    await j.close();
    site.close();
  }
});

it("never says the person closed a tab they closed and reopened before the call, when contact is later lost under a command on it", async () => {
  const hits: string[] = [];
  const site = createServer((request, response) => {
    hits.push(request.url ?? "/");
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Page</title><p>page</p>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const j = await journey("direct-person-reopened", { profile: true, channelDeadlineMs: 20_000 });
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    const work = await directWork(j, () => home);
    const opened = await work.use(
      `globalThis.keeps = await newPage(${JSON.stringify(`${origin}/keeps`)}); const page = await newPage(${JSON.stringify(`${origin}/reopened`)}); return page.tabId;`,
    );
    const tabId = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(text(opened))?.[0] as TabRecord["id"];
    if (!tabId) throw new Error(`The script returned no tab: ${text(opened)}`);
    // Another page keeps the browser session open, so the reopened tab's page joins the same one.
    // The person closes the tab and reopens it (a page of its own).
    await personTabs(j, home).close(
      { kind: "person", ownerId: j.task.userId },
      [tabId],
      "person-close-then-reopen",
    );
    await j.tabs.reopen(j.task.userId, tabId, "person-reopen");
    // The reopened tab loads its address in a page of its own when it is first opened.
    await vi.waitFor(
      async () => {
        const ready = await work.use(
          `const page = await openPage(${JSON.stringify(tabId)}); return await page.title();`,
        );
        expect(text(ready)).toContain("Page");
      },
      { timeout: 15_000 },
    );
    // A later call uses the reopened tab, and contact is lost under its command: nothing the
    // person did ended it. The cut waits for the page itself to show the command ran: cut on
    // the navigation's hit alone, it could land after the command existed but before it was
    // sent, whose honest answer is failed with nothing sent (workbench-1, 1 run in 3).
    const hanging = work.use(
      `const page = await openPage(${JSON.stringify(tabId)}); await page.goto(${JSON.stringify(`${origin}/hang`)}); return await page.js("(fetch('/sent'), new Promise(() => {}))");`,
    );
    await Promise.race([
      vi.waitFor(() => expect(hits).toContain("/sent"), { timeout: 15_000 }),
      hanging.then((result) => {
        throw new Error(`The call ended before its command hung: ${text(result)}`);
      }),
    ]);
    j.runnerDown();
    const later = await hanging;
    expect(later.structuredContent, text(later)).toMatchObject({ status: "unknown" });
    expect(text(later)).not.toContain(tabClosedSentence);
    const operation = await j.database
      .selectFrom("agentOperations")
      .select(["ending"])
      .orderBy("createdAt", "desc")
      .executeTakeFirstOrThrow();
    expect(operation.ending).not.toBe("tab-closed");
  } finally {
    await j.close();
    site.close();
  }
});

/** The direct-work task the connection's live agent session runs now. */
async function liveTask(j: Journey) {
  return (
    await j.database
      .selectFrom("agentSessions")
      .select("threadId")
      .where("status", "=", "active")
      .executeTakeFirstOrThrow()
  ).threadId;
}

it("lists, opens and closes, in a later direct-work task of the same connection, a tab its earlier task left before its session ended idle", async () => {
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Kept</title><p>kept</p>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const j = await journey("direct-pages-across-tasks", { profile: true });
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    const work = await directWork(j, () => home, { realAuthority: true });
    // The earlier task opens a page and keeps it open.
    const kept = await work.use(
      `globalThis.kept = await newPage(${JSON.stringify(`${origin}/kept`)}); return kept.tabId;`,
    );
    expect(kept.isError, text(kept)).not.toBe(true);
    const tabId = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(text(kept))?.[0];
    if (!tabId) throw new Error(`The script returned no tab: ${text(kept)}`);
    const earlier = await liveTask(j);
    // The agent goes quiet: its agent session ends idle; its next call runs in a new task.
    await work.sessions.endIdle(Date.now() + 60 * 60_000);
    const listed = await work.use("return (await pages()).map((page) => page.tabId);");
    expect(listed.isError, text(listed)).not.toBe(true);
    expect(await liveTask(j)).not.toBe(earlier);
    expect(text(listed)).toContain(tabId);
    const closed = await work.use(
      `const page = await openPage(${JSON.stringify(tabId)}); print(await page.title()); await page.close(); await sleep(500); return (await pages()).map((page) => page.tabId);`,
    );
    expect(closed.isError, text(closed)).not.toBe(true);
    expect(text(closed)).toContain("Kept");
    expect(text(closed)).not.toContain(tabId);
  } finally {
    await j.close();
    site.close();
  }
});

it("still reads a connection's tabs as non-existent to another connection, after its session ends", async () => {
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Mine</title><p>mine</p>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const j = await journey("direct-pages-other-connection", { profile: true });
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    const work = await directWork(j, () => home, { realAuthority: true });
    const mine = await work.use(
      `globalThis.mine = await newPage(${JSON.stringify(`${origin}/mine`)}); return mine.tabId;`,
    );
    const tabId = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(text(mine))?.[0];
    if (!tabId) throw new Error(`The script returned no tab: ${text(mine)}`);
    // This connection's session ends idle: its tabs become no one else's. Another connection, its
    // grant selected on the same profile, still reads them as tabs that do not exist.
    await work.sessions.endIdle(Date.now() + 60 * 60_000);
    const other = await work.anotherAgent();
    const listed = await other("return (await pages()).map((page) => page.tabId);");
    expect(listed.isError, text(listed)).not.toBe(true);
    expect(text(listed)).not.toContain(tabId);
    const bound = await other(
      `try { await openPage(${JSON.stringify(tabId)}); return "bound"; } catch (error) { return error.message; }`,
    );
    expect(text(bound)).not.toContain('"bound"');
    expect(text(bound)).toContain("Tab not found.");
  } finally {
    await j.close();
    site.close();
  }
});

it("closes the tab with its page when the agent's own script closes it and the browser confirms", async () => {
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Done</title><p>done</p>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const j = await journey("direct-page-close-row", { profile: true });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [own] = await home.service.savedPages(j.task.userId, session.id);
    if (!own?.pageBinding) throw new Error("The saved profile has no durable tab.");
    // Under the real tab authority, with a grant that reaches the person's tabs.
    const work = await directWork(j, () => home, {
      realAuthority: true,
      grant: { scope: "everything" },
    });
    // The agent's own page, and the person's tab the agent bound: each closed by the script.
    const done = await work.use(
      `const page = await newPage(${JSON.stringify(`${origin}/done`)}); const id = page.tabId; await page.close(); const theirs = await openPage(${JSON.stringify(own.id)}); await theirs.close(); return id;`,
    );
    expect(done.isError, text(done)).not.toBe(true);
    const tabId = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(text(done))?.[0];
    if (!tabId) throw new Error(`The script returned no tab: ${text(done)}`);
    // Closed in the same command: no tab the person sees is left with no page behind it.
    for (const closed of [tabId, own.id])
      expect(
        (await j.tabs.get(j.task.userId, closed as TabRecord["id"], true))?.closedAt,
        closed,
      ).not.toBeNull();
  } finally {
    await j.close();
    site.close();
  }
});

/** The person changes the connection's grant (a new revision). */
async function setGrant(j: Journey, connectionId: string, grant: AgentGrant) {
  const { grantRevision } = await j.database
    .selectFrom("agentConnections")
    .select("grantRevision")
    .where("id", "=", connectionId)
    .executeTakeFirstOrThrow();
  await new AgentConnectionStore(j.store.database).update(j.task.userId, {
    connectionId,
    expectedRevision: grantRevision,
    grant,
  });
}

/** The person narrows the connection to the profile: a selected grant reaches none of their tabs. */
async function narrowToProfile(j: Journey, connectionId: string) {
  await setGrant(j, connectionId, {
    scope: "selected",
    tasks: false,
    resources: [{ kind: "browser-profile", profileId: j.profile!.id }],
  });
}

/** Waits until the Home has the new document of a tab its page navigated to. */
async function navigated(home: Home, sessionId: string, tabId: string, previous: unknown) {
  await vi.waitFor(() =>
    expect(
      home.service.pageInventory(sessionId as never)?.records.get(tabId as never)?.documentId,
    ).not.toBe(previous),
  );
}

/**
 * A connection with everything binds the person's tab first (handle 1), listens to its page and
 * its console, and opens a page of its own (handle 2).
 */
async function heldPersonTab(name: string, afterBind?: () => Promise<void>) {
  const site = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Mine</title><p>${request.url}</p>`);
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const j = await journey(name, { profile: true });
  const home = await j.startHome();
  const { session } = await home.service.start({
    ownerId: j.task.userId,
    profileId: j.profile!.id,
  });
  const [own] = await home.service.savedPages(j.task.userId, session.id);
  if (!own?.pageBinding) throw new Error("The saved profile has no durable tab.");
  expect(own.openedBy).toBe("person");
  const person = await j.draft();
  const work = await directWork(j, () => home, {
    realAuthority: true,
    grant: { scope: "everything" },
    ...(afterBind ? { afterBind } : {}),
  });
  const close = async () => {
    await j.close();
    site.close();
  };
  return { site, origin, j, home, session, own, person, work, close };
}

it("clicks a target=_blank link in the person's pooled tab and reaches the popup under the same grant", async () => {
  const { j, work, close, own, origin } = await heldPersonTab("person-popup-click");
  try {
    const result = await work.use(`
      const page = await openPage(${JSON.stringify(own.id)});
      await newPage(${JSON.stringify(origin + "/second")});
      await page.evaluate((url) => {
        const link = document.createElement("a");
        link.id = "popup";
        link.target = "_blank";
        link.href = url;
        link.textContent = "Open popup";
        document.body.prepend(link);
      }, ${JSON.stringify(origin + "/popup")});
      print("before click");
      await page.locator("#popup").click();
      print("after click");
      let popup;
      for (let attempt = 0; !popup && attempt < 20; attempt++) {
        popup = (await pages()).find((tab) => tab.url.endsWith("/popup"));
        if (!popup) await page.waitForTimeout(100);
      }
      if (!popup) throw new Error("The popup was not listed.");
      print({ popup: popup.tabId, title: await (await openPage(popup.tabId)).title() });
    `);
    expect(result.structuredContent, text(result)).toMatchObject({ status: "completed" });
    expect(text(result)).toContain("before click");
    expect(text(result)).toContain("after click");
    const popup = (result.content as { type: string; text: string }[]).find(
      ({ type, text }) => type === "text" && text.startsWith('{"popup":'),
    );
    expect(popup, text(result)).toBeDefined();
    expect(await j.tabs.get(j.task.userId, JSON.parse(popup!.text).popup)).toMatchObject({
      openedBy: "person",
      openerTabId: own.id,
    });
  } finally {
    await close();
  }
});

async function installClickTarget(
  person: Awaited<ReturnType<typeof heldPersonTab>>["person"],
  covered: boolean,
) {
  await person.cdp.send("Runtime.evaluate", {
    expression: `window.clicks = 0;
      document.body.innerHTML =
        '<button id="click-target" style="position:fixed;left:40px;top:40px;width:120px;height:50px">Click</button>' +
        (${covered} ? '<div id="cover" style="position:fixed;z-index:10;inset:0"></div>' : '');
      document.querySelector("#click-target").onclick = () => window.clicks++;`,
  });
  return async () =>
    (
      await person.cdp.send<{ result: { value: number } }>("Runtime.evaluate", {
        expression: "window.clicks",
        returnByValue: true,
      })
    ).result.value;
}

it.each([false, true])(
  "ends a covered pooled click with its timeout (caught: %s)",
  async (caught) => {
    const { work, close, own, person } = await heldPersonTab("covered-click");
    try {
      const clicks = await installClickTarget(person, true);
      const click =
        'await p.locator("#click-target").click(' + (caught ? "{timeout:800}" : "") + ");";
      const code = caught ? `try { ${click} } catch(e) { print(e.message); }` : click;
      const start = performance.now();
      const result = await work.use(`
      const p = await openPage(${JSON.stringify(own.id)});
      print("before click");
      ${code}
    `);
      const elapsed = Math.round(performance.now() - start);
      expect(await clicks()).toBe(0);
      expect(result.structuredContent, `${elapsed} ms: ${text(result)}`).toMatchObject(
        caught
          ? { status: "completed" }
          : {
              status: "failed",
              error: {
                message: expect.stringContaining(
                  'Timeout 10000ms: <div id="cover"> intercepts pointer events',
                ),
              },
            },
      );
      expect(text(result)).toContain("before click");
      expect(text(result)).toContain("intercepts pointer events");
      if (!caught) expect(elapsed).toBeLessThan(10_500);
    } finally {
      await close();
    }
  },
);

it.each(["cleanup", "input", "hit test"] as const)(
  "settles a pooled script with the %s reply withheld",
  async (kind) => {
    const { work, close, own, person, j } = await heldPersonTab("click-reply");
    const withheld = new Set<string>();
    const dropped = Promise.withResolvers<void>();
    let syncRequest: string | undefined;
    let geometryCalls = 0;
    const send = TestRuntimeConnection.prototype.send;
    const emit = TestRuntimeConnection.prototype.emit;
    const sendSpy = vi.spyOn(TestRuntimeConnection.prototype, "send").mockImplementation(function (
      this: TestRuntimeConnection,
      data,
      options,
      callback,
    ) {
      const frame = JSON.parse(data);
      if (frame.type === "cdp.command") {
        const { method, parameters } = frame.command;
        if (kind === "cleanup" && method === "Runtime.evaluate" && parameters.expression === "1")
          syncRequest = frame.requestId;
        if (
          (kind === "cleanup" &&
            method === "Runtime.releaseObjectGroup" &&
            parameters.objectGroup === "withheld") ||
          (kind === "input" &&
            method === "Input.dispatchMouseEvent" &&
            parameters.type === "mouseReleased") ||
          (kind === "hit test" &&
            method === "Runtime.callFunctionOn" &&
            parameters.arguments?.[0]?.value === "geometry" &&
            ++geometryCalls === 2)
        )
          withheld.add(frame.requestId);
      }
      send.call(this, data, options, callback);
    });
    const emitSpy = vi.spyOn(TestRuntimeConnection.prototype, "emit").mockImplementation(function (
      this: TestRuntimeConnection,
      event,
      ...args
    ) {
      if (event === "message" && args[1] === false) {
        const message = JSON.parse(String(args[0]));
        if (message.type === "cdp.result" && withheld.delete(message.requestId)) {
          dropped.resolve();
          return true;
        }
        // Host admission for the awaited read can finish before admission for cleanup.
        // Let the script throw only once Chromium has actually answered cleanup and we dropped it.
        if (message.type === "cdp.result" && message.requestId === syncRequest && syncRequest) {
          void dropped.promise.then(() => emit.call(this, event, ...args));
          return true;
        }
      }
      return emit.call(this, event, ...args);
    });
    try {
      const clicks = await installClickTarget(person, kind === "hit test");
      const code =
        kind === "cleanup"
          ? `void p.cdp("Runtime.releaseObjectGroup", { objectGroup: "withheld" }).catch(() => {});
           await p.js("1");
           throw new Error("the script's own error");`
          : 'await p.locator("#click-target").click({timeout:1500});';
      const running = work.use(`
        const p = await openPage(${JSON.stringify(own.id)});
        print("before the reply");
        ${code}
      `);
      await before(
        withTimeout(dropped.promise, 10_000, {
          timeoutError: () => new Error("Chromium did not send the CDP reply to withhold."),
        }),
        running,
        "The withheld CDP reply",
      );
      const result = await running;
      const status = kind === "cleanup" ? "failed" : "unknown";
      const message = kind === "cleanup" ? "the script's own error" : "Timeout 1500ms";
      expect(await clicks()).toBe(kind === "input" ? 1 : 0);
      expect(result.structuredContent, text(result)).toMatchObject({
        status,
        error: {
          code: kind === "cleanup" ? "failed" : "outcome-unknown",
          message: expect.stringContaining(message),
          ...(kind === "input" ? { method: "Input.dispatchMouseEvent" } : {}),
        },
      });
      expect(text(result)).toContain("before the reply");
      if (kind !== "cleanup") expect(text(result)).toContain("did not confirm its outcome");
      expect(
        await j.database
          .selectFrom("agentOperations")
          .select(["state", "resultSummary"])
          .orderBy("createdAt", "desc")
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        state: status,
        resultSummary: { scriptError: { message: expect.stringContaining(message) } },
      });
    } finally {
      dropped.resolve();
      emitSpy.mockRestore();
      sendSpy.mockRestore();
      await close();
    }
  },
);

/** The script's returned lines. */
const lines = (result: Awaited<ReturnType<Awaited<ReturnType<typeof directWork>>["use"]>>) =>
  JSON.parse(
    (result.content as { type: string; text: string }[]).find(({ type }) => type === "text")!.text,
  ) as string[];

/** Binds the person's tab (handle 1) and a page of the agent's own (handle 2), both heard. */
const holdBoth = (ownId: string, origin: string) =>
  `globalThis.theirs = await openPage(${JSON.stringify(ownId)}); await theirs.cdp("Page.enable"); await theirs.cdp("Runtime.enable"); globalThis.mine = await newPage(${JSON.stringify(`${origin}/mine`)}); await mine.cdp("Page.enable"); return [mine.tabId];`;

/** In a later call: what of the old context is left, and what the person's tab reads now. */
const afterChange = (ownId: string) =>
  `const out = []; try { await openPage(${JSON.stringify(ownId)}); out.push("bound"); } catch (error) { out.push(error.code + ": " + error.message); } out.push(typeof theirs, typeof mine); return out;`;

const tabNotFound = /^not_found: (?:openPage\(\): )?Tab not found\.$/u;

it("disposes a connection's script context when its grant changed: the person's tab reads as non-existent, its own page opens again, and an unchanged grant keeps everything", async () => {
  const held = await heldPersonTab("direct-narrowed-context");
  const { j, home, session, own, person, work, origin } = held;
  try {
    const bound = await work.use(holdBoth(own.id, origin));
    expect(bound.isError, text(bound)).not.toBe(true);
    const [mineId] = lines(bound);
    // The same grant: the context, its handles and globals are kept, and nothing is read for it.
    const same = await work.use(
      `return [typeof theirs, typeof mine, await mine.evaluate(() => document.title)];`,
    );
    expect(lines(same)).toEqual(["object", "object", "Mine"]);
    await narrowToProfile(j, work.agent.id);
    // The person's page moves on after the narrowing, and the Home has it before the next call.
    const before = home.service.pageInventory(session.id)?.records.get(own.id)?.documentId;
    await person.cdp.send("Page.navigate", { url: `${origin}/theirs-after-narrowing` });
    await navigated(home, session.id, own.id, before);
    // The next call runs in a fresh context: binding the person's tab again first reads as a tab
    // that does not exist, and nothing of the old context is left.
    const after = await work.use(afterChange(own.id));
    expect(after.isError, text(after)).not.toBe(true);
    expect(lines(after)).toEqual([expect.stringMatching(tabNotFound), "undefined", "undefined"]);
    // The agent's own page is listed and opens again, as after ten idle minutes; the new handle
    // (handle 1 again) hears nothing the old context heard.
    const again = await work.use(
      `const listed = (await pages()).map((page) => page.tabId); const page = await openPage(${JSON.stringify(mineId)}); return [JSON.stringify(listed), await page.evaluate(() => document.title), JSON.stringify(page.drainEvents())];`,
    );
    const [listed, title, events] = lines(again);
    expect(JSON.parse(listed!)).toContain(mineId);
    expect(JSON.parse(listed!)).not.toContain(own.id);
    expect(title).toBe("Mine");
    expect(events).not.toContain("theirs-after-narrowing");
    // The person's page and row are untouched.
    expect((await j.tabs.get(j.task.userId, own.id, true))?.closedAt).toBeNull();
    expect(home.service.tabStateOf(session.id, own.id)).toBeDefined();
  } finally {
    await held.close();
  }
});

it("keeps nothing of a held handle to the person's tab that a park detached after the narrowing", async () => {
  const held = await heldPersonTab("direct-narrowed-park");
  const { j, home, session, own, person, work, origin } = held;
  try {
    expect((await work.use(holdBoth(own.id, origin))).isError).not.toBe(true);
    await narrowToProfile(j, work.agent.id);
    const before = home.service.pageInventory(session.id)?.records.get(own.id)?.documentId;
    await person.cdp.send("Page.navigate", { url: `${origin}/theirs-after-narrowing` });
    await navigated(home, session.id, own.id, before);
    await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
    expect(await home.coordinator.tryPark()).toBe("parked");
    const after = await work.use(afterChange(own.id));
    expect(after.isError, text(after)).not.toBe(true);
    expect(lines(after)).toEqual([expect.stringMatching(tabNotFound), "undefined", "undefined"]);
    expect(text(after)).not.toContain("theirs-after-narrowing");
  } finally {
    await held.close();
  }
});

it("keeps nothing of a held handle to the person's tab that the person closed after the narrowing", async () => {
  const held = await heldPersonTab("direct-narrowed-person-close");
  const { j, home, own, work, origin } = held;
  try {
    expect((await work.use(holdBoth(own.id, origin))).isError).not.toBe(true);
    await narrowToProfile(j, work.agent.id);
    const tabs = new TabService({
      store: j.tabs,
      pages: home.service.pageTabs,
      nativeTargets: { onTargetAcquired: () => () => undefined },
      authorizeMembership: async () => undefined,
      onError: (error: unknown) => {
        throw error;
      },
    } as never);
    expect(
      (await tabs.close({ kind: "person", ownerId: j.task.userId }, [own.id], "person-close"))
        .closed,
    ).toEqual([own.id]);
    const after = await work.use(afterChange(own.id));
    expect(after.isError, text(after)).not.toBe(true);
    expect(lines(after)).toEqual([expect.stringMatching(tabNotFound), "undefined", "undefined"]);
  } finally {
    await held.close();
  }
});

it("never delivers what the person's tab did while the connection was outside it, after the grant is widened again", async () => {
  const held = await heldPersonTab("direct-narrowed-widened");
  const { j, home, session, own, person, work, origin } = held;
  try {
    expect((await work.use(holdBoth(own.id, origin))).isError).not.toBe(true);
    await narrowToProfile(j, work.agent.id);
    // The person uses their tab while the connection cannot reach it.
    const before = home.service.pageInventory(session.id)?.records.get(own.id)?.documentId;
    await person.cdp.send("Page.navigate", { url: `${origin}/while-outside` });
    await navigated(home, session.id, own.id, before);
    await person.cdp.send("Runtime.evaluate", { expression: "console.log('typed-while-outside')" });
    // The person gives it everything again.
    await setGrant(j, work.agent.id, { scope: "everything" });
    const after = await work.use(
      `const heard = []; if (typeof theirs !== "undefined") heard.push(theirs.drainEvents()); const page = await openPage(${JSON.stringify(own.id)}); heard.push(page.drainEvents()); return [typeof theirs, JSON.stringify(heard)];`,
    );
    expect(after.isError, text(after)).not.toBe(true);
    const [kept, heard] = lines(after);
    expect(kept).toBe("undefined");
    expect(heard).not.toContain("while-outside");
    expect(heard).not.toContain("typed-while-outside");
  } finally {
    await held.close();
  }
});

it("never delivers to a call after the narrowing what the person's tab said as the call before it ended", async () => {
  const held = await heldPersonTab("direct-narrowed-unacknowledged");
  const { j, own, work, origin } = held;
  try {
    // The person's page speaks as the first call settles: its console line is packed for the
    // context while no call reads it.
    const late = await work.use(
      `${holdBoth(own.id, origin).replace(/return \[mine\.tabId\];$/u, "")} await theirs.cdp("Runtime.evaluate", { expression: "setTimeout(() => console.log('said-as-it-ended'), 0)" }); return [mine.tabId];`,
    );
    expect(late.isError, text(late)).not.toBe(true);
    const [mineId] = lines(late);
    await narrowToProfile(j, work.agent.id);
    // Handle 1 in the next call's context is the agent's own page: nothing packed for the old
    // handle 1 reaches it, nor anything else of the old context.
    const after = await work.use(
      `const heard = []; if (typeof theirs !== "undefined") heard.push(theirs.drainEvents()); const page = await openPage(${JSON.stringify(mineId)}); heard.push(page.drainEvents()); return [typeof theirs, JSON.stringify(heard)];`,
    );
    expect(after.isError, text(after)).not.toBe(true);
    const [kept, heard] = lines(after);
    expect(kept).toBe("undefined");
    expect(heard).not.toContain("said-as-it-ended");
  } finally {
    await held.close();
  }
});

it("ends a connected agent's call on the pool when its grant changes in the middle of it: nothing more reaches the page", async () => {
  let narrow: (() => Promise<void>) | undefined;
  const held = await heldPersonTab("direct-narrowed-mid-call", async () => {
    const change = narrow;
    narrow = undefined;
    await change?.();
  });
  const { j, own, person, work } = held;
  try {
    narrow = () => narrowToProfile(j, work.agent.id);
    // The bind is decided, then the grant changes before the next command of the same call.
    const result = await work.use(
      `const page = await openPage(${JSON.stringify(own.id)}); await page.evaluate(() => { document.title = "after-narrowing"; }); return "ran";`,
    );
    expect(narrow).toBeUndefined();
    expect(result.isError, text(result)).toBe(true);
    expect(text(result)).not.toContain('"ran"');
    const title = await person.cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    expect(title.result.value).not.toBe("after-narrowing");
  } finally {
    await held.close();
  }
});

it("loads a tab the person closed and reopened when the agent opens it first, on the pool: its address in a page of its own, never unknown", async () => {
  const held = await heldPersonTab("direct-reopened-agent-first");
  const { j, home, session, own, person, origin, work } = held;
  try {
    const address = `${origin}/before-close`;
    const before = home.service.pageInventory(session.id)?.records.get(own.id)?.documentId;
    await person.cdp.send("Page.navigate", { url: address });
    await navigated(home, session.id, own.id, before);
    await vi.waitFor(
      async () => {
        await home.service.flushPendingTabDescriptors();
        expect((await j.tabs.get(j.task.userId, own.id))?.url).toBe(address);
      },
      { timeout: 10_000 },
    );
    // The person closes the tab and reopens it at once: it has no page until it is used.
    const tabs = new TabService({
      store: j.tabs,
      pages: home.service.pageTabs,
      nativeTargets: { onTargetAcquired: () => () => undefined },
      authorizeMembership: async () => undefined,
      onError: (error: unknown) => {
        throw error;
      },
    } as never);
    await tabs.close({ kind: "person", ownerId: j.task.userId }, [own.id], "close");
    await j.tabs.reopen(j.task.userId, own.id, "reopen");
    expect((await j.tabs.get(j.task.userId, own.id))?.pageBinding).toBeNull();
    // The agent opens it before the person does: its address loads again.
    const opened = await work.use(
      `const page = await openPage(${JSON.stringify(own.id)}); return [await page.evaluate(() => location.href)];`,
    );
    expect(opened.isError, text(opened)).not.toBe(true);
    expect(lines(opened)).toEqual([address]);
    expect((await j.tabs.get(j.task.userId, own.id))?.pageBinding?.sessionId).not.toBe(session.id);
  } finally {
    await held.close();
  }
});

/** What an agent reads back over MCP for a refusal: the receipt's error, as structured content. */
const refusalOf = (result: Awaited<ReturnType<Awaited<ReturnType<typeof directWork>>["use"]>>) =>
  (result.structuredContent as { error?: { message?: string; next?: string } } | undefined)?.error;

it("tells the agent over MCP that nothing was sent and it may call again when its wake bound runs out", async () => {
  const p = await parkedAfterWork("wake-bound-next", { executionMs: 1_500 });
  try {
    const resume = holdResume(p.j.controller);
    const call = p.work.use(p.read);
    await before(resume.seen, call, "The parked call");
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "refused" });
    expect(refusalOf(result)).toMatchObject({
      message: "The pooled browser did not wake in time. Nothing was sent.",
      next: "Nothing was sent. It is safe to call again.",
    });
    resume.allow();
  } finally {
    await p.j.close();
  }
});

/** Retires the Home's only target for another not yet adopted: the gap of a replaced host. */
const retireForReplacement = (p: Awaited<ReturnType<typeof parkedAfterWork>>) =>
  p.home.service.retirePool(p.j.task.runnerId, "browser-replaced");

/** The call's operation, newest first. */
const latestOperation = (p: Awaited<ReturnType<typeof parkedAfterWork>>) =>
  p.j.database
    .selectFrom("agentOperations")
    .select(["state", "sessionId", "handedOffAt"])
    .orderBy("createdAt", "desc")
    .executeTakeFirstOrThrow();

it("refuses at once, over MCP with its next line, a call on a session of a target retired while it waited", async () => {
  const p = await parkedAfterWork("retired-session-next");
  try {
    const resume = holdResume(p.j.controller);
    // Its tab is a page of the retired target's session: the call ends with that session.
    const call = p.work.useTab(p.read, p.tab.id);
    await before(resume.seen, call, "The tab-targeted call");
    await retireForReplacement(p);
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "refused" });
    expect(refusalOf(result)).toMatchObject({
      message: "This browser is not ready. Nothing was sent.",
      next: "Nothing was sent. It is safe to call again.",
    });
    resume.allow();
  } finally {
    await p.j.close();
  }
});

it("ends a call waiting through a replaced host's gap at once with the person's Stop, in its words", async () => {
  const p = await parkedAfterWork("gap-stop");
  try {
    const resume = holdResume(p.j.controller);
    let settled = false;
    const call = p.work.use(p.read).finally(() => {
      settled = true;
    });
    await before(resume.seen, call, "The profile call");
    await retireForReplacement(p);
    // It follows: no next target yet, so it waits, nothing handed off.
    expect(await latestOperation(p)).toMatchObject({ handedOffAt: null });
    expect(settled).toBe(false);
    await p.work.sessions.stopSession({
      ownerUserId: p.j.task.userId,
      sessionId: (await latestOperation(p)).sessionId,
      threadId: p.taskId,
    });
    const result = await call;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("stopped");
    expect(text(result)).not.toContain("did not wake in time");
    resume.allow();
  } finally {
    await p.j.close();
  }
});

it("ends a call waiting through a replaced host's gap at once with the person's Disconnect", async () => {
  const p = await parkedAfterWork("gap-disconnect");
  try {
    const resume = holdResume(p.j.controller);
    let settled = false;
    const call = p.work
      .use(p.read)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await before(resume.seen, call, "The profile call");
    await retireForReplacement(p);
    expect(await latestOperation(p)).toMatchObject({ handedOffAt: null });
    expect(settled).toBe(false);
    await p.connection.revoke(p.work.agent.id);
    await p.j.store.driveConnectionCleanups();
    // Its end, never a wake refusal at its bound: Disconnect ends the wait itself.
    expect(JSON.stringify(await call)).not.toContain("did not wake in time");
    const [row] = (await p.connection.list()).filter(({ id }) => id === p.work.agent.id);
    expect(row).toMatchObject({ state: "stopped" });
    resume.allow();
  } finally {
    await p.j.close();
  }
});

it("today: settles unknown, and never replays, a command already sent when its target is retired for another", async () => {
  const j = await journey("retired-in-flight", { profile: true });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    const page = await j.draft();
    const work = await directWork(j, () => home);
    const bound = await work.use(`globalThis.page = await openPage(${JSON.stringify(tab.id)});`);
    expect(bound.isError, text(bound)).not.toBe(true);
    const sent = async () =>
      (
        await page.cdp.send<{ result: { value?: number } }>("Runtime.evaluate", {
          expression: "window.__sent ?? 0",
          returnByValue: true,
        })
      ).result.value;
    const hanging = work.use(
      `return await page.js("(window.__sent = (window.__sent ?? 0) + 1, new Promise(() => {}))")`,
    );
    await vi.waitFor(async () => expect(await sent()).toBe(1));
    const operations = () =>
      j.database.selectFrom("agentOperations").select(["id", "state", "outcome"]).execute();
    const before = (await operations()).length;
    await home.service.retirePool(j.task.runnerId, "browser-replaced");
    // Sent to the retired target: unknown, recorded once, and never carried anywhere else.
    expect((await hanging).structuredContent).toMatchObject({ status: "unknown" });
    const after = await operations();
    expect(after.length).toBe(before);
    expect(after.filter(({ state }) => state === "unknown")).toHaveLength(1);
    expect(after.filter(({ state }) => state === "handed-off")).toHaveLength(0);
  } finally {
    await j.close();
  }
});

/*
 * Where a connected agent's script works now (`workingIn`): set in the Home's memory at each
 * command that passed its recheck and at each page opened or taken up again, told to the person
 * who owns the Home when it changes, and read by Watch. It never reads the Home's holder records.
 */

/** A small site whose pages say their path. */
async function pagesSite() {
  const site = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>${request.url}</title><p>${request.url}</p>`);
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  return { site, origin: `http://127.0.0.1:${(site.address() as AddressInfo).port}` };
}

/** What the person's client holds after these notices, as it applies them. */
function heldWorkingIn(notices: readonly { readonly notice: AgentWorkingIn }[]) {
  const held: Record<string, AgentWorkingIn> = {};
  for (const { notice } of notices)
    if (notice.tabId !== null) held[notice.threadId] = notice;
    else if (held[notice.threadId]?.sessionId === notice.sessionId) delete held[notice.threadId];
  return held;
}

/** Where the person's Watch on `threadId` lands, from the Home's own tab rows and the notices. */
async function watchLands(
  j: Journey,
  home: Home,
  threadId: string,
  notices: readonly { readonly notice: AgentWorkingIn }[],
) {
  const rows = new Map<string, unknown>();
  for (const tab of (await j.tabs.snapshot(j.task.userId)).rows) {
    if (tab.kind !== "page") continue;
    const state = await home.service.pageTabs.state!(j.task.userId, tab);
    rows.set(
      tab.id,
      TabSchema.parse({
        tabId: tab.id,
        kind: "page",
        title: tab.title || "Page",
        computer: { computerId: j.task.runnerId, name: "Main computer" },
        groupId: null,
        state: "open",
        usedBy: state.usedBy,
        openedBy: "person",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        url: tab.url ?? "https://example.test/",
        profile: { profileId: j.profile!.id, name: "Work" },
      }),
    );
  }
  const source = {
    tabs: { rows, get: (id: string) => rows.get(id) },
    agentWorkingIn: heldWorkingIn(notices),
    threads: [],
    activeTasks: [],
  };
  return watchPage(source as never, threadId)?.tabId ?? null;
}

const sessionOf = (j: Journey, connectionId?: string) =>
  vi.waitFor(
    () => {
      let query = j.database
        .selectFrom("agentSessions")
        .select(["id", "threadId", "status"])
        .where("userId", "=", j.task.userId)
        .where("status", "=", "active");
      if (connectionId) query = query.where("connectionId", "=", connectionId as never);
      return query.orderBy("startedAt", "desc").executeTakeFirstOrThrow();
    },
    { timeout: 10_000 },
  );

const tabOf = (reply: unknown) => {
  const content = JSON.stringify((reply as { readonly content?: unknown }).content);
  const id = /(?:tab|surface)_[A-Za-z0-9-]+/u.exec(content)?.[0];
  if (!id) throw new Error(`The script returned no tab: ${content}`);
  return id;
};

it("tells the person where a kept page handle works, with no holder record of the tab: two tabs, a later call on the earlier one", async () => {
  // Tester run 16: a script context kept its page handle across calls, and the Home named no
  // holder for the tab it worked in; Watch stayed on the launcher.
  const { site, origin } = await pagesSite();
  const j = await journey("direct-working-in-kept", { profile: true });
  try {
    const home = await j.startHome();
    let misfiled: { bindingId: string; threadId: string } | undefined;
    const work = await directWork(j, () => home, { misfileHolders: () => misfiled });
    // Another agent's session: the Home files this task's holder records under it.
    const other = await work.anotherAgent();
    tabOf(await other(`return (await newPage("${origin}/theirs")).tabId;`));
    const theirs = await sessionOf(j, other.id);
    misfiled = { bindingId: `session:${theirs.id}`, threadId: theirs.threadId };
    const first = tabOf(
      await work.use(`globalThis.a = await newPage("${origin}/one"); return a.tabId;`),
    );
    const second = tabOf(
      await work.use(`globalThis.b = await newPage("${origin}/two"); return b.tabId;`),
    );
    const { threadId } = await sessionOf(j, work.agent.id);
    expect(second).not.toBe(first);
    // The later call on the earlier tab, through the handle its context kept.
    let done = false;
    const later = work
      .use(
        `const page = await openPage(${JSON.stringify(first)}); if (page !== a) throw new Error("not kept"); await page.waitForTimeout(1500); await page.title(); await page.waitForTimeout(3000); return 1;`,
      )
      .finally(() => {
        done = true;
      });
    await vi.waitFor(
      async () => {
        expect(done).toBe(false);
        // The Home holds no record of the task in either tab.
        for (const tab of [first, second]) {
          const state = await home.service.pageTabs.state!(j.task.userId, await row(j, tab));
          expect(state.usedBy.some(({ taskId }) => taskId === threadId)).toBe(false);
        }
        const last = work.workingIn.at(-1)!;
        expect(last.notice).toMatchObject({ threadId, tabId: first });
        expect(await watchLands(j, home, threadId, work.workingIn)).toBe(first);
      },
      { timeout: 4_000 },
    );
    const result = await later;
    expect(result.isError, text(result)).not.toBe(true);
    // Only the person who owns the Home heard it; nothing of it reached the agent.
    expect(new Set(work.workingIn.map(({ ownerUserId }) => ownerUserId))).toEqual(
      new Set([j.task.userId]),
    );
    expect(text(result)).not.toContain("workingIn");
  } finally {
    await j.close();
    site.close();
  }
});

it("tells the person where a script works once it opens a page, before any command on it", async () => {
  const { site, origin } = await pagesSite();
  const j = await journey("direct-working-in-open", { profile: true });
  try {
    const home = await j.startHome();
    const work = await directWork(j, () => home);
    const tab = tabOf(await work.use(`return (await newPage("${origin}/one")).tabId;`));
    const other = tabOf(await work.use(`return (await newPage("${origin}/two")).tabId;`));
    const { threadId } = await sessionOf(j);
    expect(work.workingIn.at(-1)?.notice.tabId).toBe(other);
    let done = false;
    // A fresh context opens the first tab again and sends nothing on it.
    const opening = work
      .useTab(
        `await openPage(${JSON.stringify(tab)}); await new Promise((resolve) => setTimeout(resolve, 3000)); return 1;`,
        tab,
      )
      .finally(() => {
        done = true;
      });
    await vi.waitFor(
      async () => {
        expect(done).toBe(false);
        expect(work.workingIn.at(-1)?.notice).toMatchObject({ threadId, tabId: tab });
        expect(await watchLands(j, home, threadId, work.workingIn)).toBe(tab);
      },
      { timeout: 3_000 },
    );
    const result = await opening;
    expect(result.isError, text(result)).not.toBe(true);
  } finally {
    await j.close();
    site.close();
  }
});

it("tells only the owner, within one notice of the first command, and no read an agent makes carries it", async () => {
  // The narrow look, finding 1: opensteer_state's activity forwarded the owner's activity rows,
  // the in-flight operation's tab included, to the connection (and to a Selected grant with no
  // resources). The value now rides one notice, to the owner, and nothing else.
  const { site, origin } = await pagesSite();
  const j = await journey("direct-working-in-owner-only", { profile: true });
  try {
    const home = await j.startHome();
    const work = await directWork(j, () => home);
    let done = false;
    const working = work
      .use(
        `const page = await newPage("${origin}/one"); await page.title(); await page.waitForTimeout(3000); await page.title(); return page.tabId;`,
      )
      .finally(() => {
        done = true;
      });
    const { threadId, id: sessionId } = await sessionOf(j);
    await vi.waitFor(() => expect(work.workingIn.length).toBeGreaterThan(0), { timeout: 3_000 });
    const tab = work.workingIn[0]!.notice.tabId!;
    // One notice for the page it opened and every command on it: the tab did not change.
    expect(work.workingIn).toEqual([
      { ownerUserId: j.task.userId, notice: { threadId, sessionId, tabId: tab } },
    ]);
    // The owner's socket, attaching now, is told the same.
    expect(work.sessions.workingIn.current(j.task.userId)).toEqual([work.workingIn[0]!.notice]);
    // While it works there: every area this connection reads, and a Selected connection with no
    // resources, name no tab of it.
    const empty = await work.connectAs({ scope: "selected", tasks: false, resources: [] });
    const readers = [work.agent, empty];
    for (const reader of readers)
      for (const area of stateAreas) {
        const read = JSON.stringify(
          await reader.client
            .callTool({ name: "opensteer_state", arguments: { area } })
            .catch((error: unknown) => String(error)),
        );
        expect(done, area).toBe(false);
        expect(read, area).not.toContain(tab);
        expect(read, area).not.toContain("workingIn");
      }
    const result = await working;
    expect(result.isError, text(result)).not.toBe(true);
    expect(tabOf(result)).toBe(tab);
    // Its end changes nothing the owner is told: the session's one value stays its last tab.
    expect(work.workingIn).toHaveLength(1);
  } finally {
    await j.close();
    site.close();
  }
});

it("keeps each connection's workingIn to its own task, and starts over after the person's Stop and a new task", async () => {
  const { site, origin } = await pagesSite();
  const j = await journey("direct-working-in-two", { profile: true });
  try {
    const home = await j.startHome();
    const work = await directWork(j, () => home, { endsBrowserWork: true });
    const mine = tabOf(await work.use(`return (await newPage("${origin}/mine")).tabId;`));
    const first = await sessionOf(j, work.agent.id);
    const other = await work.anotherAgent();
    const theirs = tabOf(await other(`return (await newPage("${origin}/theirs")).tabId;`));
    const second = await sessionOf(j, other.id);
    expect(second.threadId).not.toBe(first.threadId);
    expect(heldWorkingIn(work.workingIn)).toMatchObject({
      [first.threadId]: { tabId: mine },
      [second.threadId]: { tabId: theirs },
    });
    expect(await watchLands(j, home, first.threadId, work.workingIn)).toBe(mine);
    expect(await watchLands(j, home, second.threadId, work.workingIn)).toBe(theirs);
    // The person stops the first agent's task: its record goes; the other's stays.
    await work.sessions.stopSession({
      ownerUserId: j.task.userId,
      threadId: first.threadId as ThreadId,
      sessionId: first.id,
    });
    await vi.waitFor(() =>
      expect(work.workingIn.at(-1)?.notice).toMatchObject({
        threadId: first.threadId,
        sessionId: first.id,
        tabId: null,
      }),
    );
    expect(heldWorkingIn(work.workingIn)).not.toHaveProperty(first.threadId);
    expect(heldWorkingIn(work.workingIn)).toHaveProperty(second.threadId);
    // Its next call hears of the Stop; the one after is a new task, in its own tab, and nothing
    // carries over.
    expect(text(await work.use(`return 1;`))).toContain("stopped_by_person");
    const next = tabOf(await work.use(`return (await newPage("${origin}/next")).tabId;`));
    const third = await sessionOf(j, work.agent.id);
    expect(third.threadId).not.toBe(first.threadId);
    expect(heldWorkingIn(work.workingIn)[third.threadId]).toMatchObject({
      sessionId: third.id,
      tabId: next,
    });
    expect(await watchLands(j, home, third.threadId, work.workingIn)).toBe(next);
  } finally {
    await j.close();
    site.close();
  }
});

it("names no tab for a whole-context browser_connect client: neither at its attach nor at its frames", async () => {
  // The narrow look, finding 2: a whole-context client may work in any page of its context; the
  // ticket's own tab is not where its frames go.
  const { site, origin } = await pagesSite();
  const j = await journey("direct-working-in-connect", { profile: true });
  let endpoint: Awaited<ReturnType<typeof standardCdpEndpoint>> | undefined;
  try {
    const home = await j.startHome();
    const work = await directWork(j, () => home);
    endpoint = await standardCdpEndpoint(() => home.service, work.sessions.workingIn);
    const first = tabOf(await work.use(`return (await newPage("${origin}/one")).tabId;`));
    const second = tabOf(await work.use(`return (await newPage("${origin}/two")).tabId;`));
    const { threadId } = await sessionOf(j);
    expect(work.workingIn.at(-1)?.notice).toMatchObject({ threadId, tabId: second });
    const told = work.workingIn.length;
    const issued = await work.connectTab(first);
    expect(issued.isError, text(issued)).not.toBe(true);
    const cdp = await endpoint.open((issued.structuredContent as { endpoint: string }).endpoint);
    const targets = (await cdp.send("Target.getTargets")) as {
      result: { targetInfos: { targetId: string; type: string }[] };
    };
    for (const target of targets.result.targetInfos.filter(({ type }) => type === "page")) {
      const attached = (await cdp.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      })) as { result: { sessionId: string } };
      await cdp.send("Runtime.evaluate", { expression: "1" }, attached.result.sessionId);
    }
    // Nothing new was said: the session's value is still the tab its script worked in last.
    expect(work.workingIn).toHaveLength(told);
    expect(work.sessions.workingIn.current(j.task.userId)).toEqual([
      expect.objectContaining({ threadId, tabId: second }),
    ]);
  } finally {
    await endpoint?.close();
    await j.close();
    site.close();
  }
});

it("clears where an agent works when the person closes that tab, and tells the owner", async () => {
  // The narrow look, finding 4.
  const { site, origin } = await pagesSite();
  const j = await journey("direct-working-in-closed", { profile: true });
  try {
    const home = await j.startHome();
    const work = await directWork(j, () => home);
    const tab = tabOf(await work.use(`return (await newPage("${origin}/one")).tabId;`));
    const { threadId, id: sessionId } = await sessionOf(j);
    expect(work.sessions.workingIn.current(j.task.userId)).toEqual([
      { threadId, sessionId, tabId: tab },
    ]);
    await personTabs(j, home, (ownerId, tabId) =>
      work.sessions.workingIn.forgetTab(ownerId, tabId),
    ).close({ kind: "person", ownerId: j.task.userId }, [tab as TabRecord["id"]], "person-close");
    expect(work.workingIn.at(-1)?.notice).toEqual({ threadId, sessionId, tabId: null });
    expect(work.sessions.workingIn.current(j.task.userId)).toEqual([]);
  } finally {
    await j.close();
    site.close();
  }
});

it("lets go of a held person's tab that a narrowing withdrew, while a covered profile keeps its session", async () => {
  // The narrow look, finding 6: Everything narrowed to the same browser profile after a
  // profile-scoped script used a person's tab. The session stays (its profile is still lent);
  // the person's tab is no longer the connection's to hold.
  const j = await journey("direct-holder-narrowed", { profile: true });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [own] = await home.service.savedPages(j.task.userId, session.id);
    if (!own?.pageBinding) throw new Error("The saved profile has no durable tab.");
    expect(own.openedBy).toBe("person");
    await j.draft();
    const work = await directWork(j, () => home, { grant: { scope: "everything" } });
    const read = await work.use(
      `const page = await openPage(${JSON.stringify(own.id)}); return await page.title();`,
    );
    expect(read.isError, text(read)).not.toBe(true);
    const { threadId, id: sessionId } = await sessionOf(j);
    const holds = async () =>
      (await home.service.pageTabs.state!(j.task.userId, await row(j, own.id))).usedBy.some(
        ({ taskId }) => taskId === threadId,
      );
    expect(await holds()).toBe(true);
    expect(work.sessions.workingIn.current(j.task.userId)).toEqual([
      { threadId, sessionId, tabId: own.id },
    ]);
    const connection = commands(j.fixture, j.task.userId, {
      afterStop: (id, reason) => work.sessions.closeConnection(id, reason === "disconnect"),
    });
    await connection.update(work.agent.id, {
      grant: {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: j.profile!.id }],
      },
    });
    await j.store.driveConnectionCleanups();
    // The session lives on under the profile it still holds.
    expect(
      (
        await j.database
          .selectFrom("agentSessions")
          .select("status")
          .where("id", "=", sessionId as never)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("active");
    await vi.waitFor(async () => expect(await holds()).toBe(false), { timeout: 3_000 });
    expect(work.workingIn.at(-1)?.notice).toEqual({ threadId, sessionId, tabId: null });
    expect(work.sessions.workingIn.current(j.task.userId)).toEqual([]);
  } finally {
    await j.close();
  }
});

it.each([
  ["the person's Stop of its task", "session"],
  ["a stop of the operation alone, as the Disconnect worker sends it", "operation"],
] as const)(
  "ends browser_connect with the stop's receipt and no endpoint when %s comes between the ticket and the reply",
  async (_, stop) => {
    // The narrow look, finding 7.
    const { site, origin } = await pagesSite();
    const ticketed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let pause = false;
    const j = await journey(`direct-connect-stopped-${stop}`, { profile: true });
    try {
      const home = await j.startHome();
      const work = await directWork(j, () => home, {
        endsBrowserWork: true,
        afterTicket: async () => {
          if (!pause) return;
          ticketed.resolve();
          await release.promise;
        },
      });
      const tab = tabOf(await work.use(`return (await newPage("${origin}/one")).tabId;`));
      const { threadId, id: sessionId } = await sessionOf(j);
      pause = true;
      const connecting = work.connectTab(tab);
      await ticketed.promise;
      if (stop === "session")
        await work.sessions.stopSession({
          ownerUserId: j.task.userId,
          threadId: threadId as ThreadId,
          sessionId,
        });
      else {
        const { id } = await j.database
          .selectFrom("agentOperations")
          .select("id")
          .where("sessionId", "=", sessionId as never)
          .where("tool", "=", "browser_connect")
          .executeTakeFirstOrThrow();
        await work.sessions.stopDirectOperation(id, "stopped");
      }
      release.resolve();
      const reply = await connecting;
      expect(text(reply)).not.toContain("endpoint");
      expect(reply.structuredContent).not.toMatchObject({ status: "completed" });
    } finally {
      release.resolve();
      await j.close();
      site.close();
    }
  },
);

it.each([
  ["Disconnect", "revoke"],
  ["narrowed grant", "narrow"],
] as const)(
  "ends a connected agent's holds on its tabs with its session's end by a %s, after its calls finished",
  async (_, end) => {
    // Measured on a Cloud Computer: a disconnected connection's task stayed its tabs' holder
    // until the person closed them; a Stop removed it.
    const { site, origin } = await pagesSite();
    const j = await journey(`direct-holder-ends-${end}`, { profile: true });
    try {
      const home = await j.startHome();
      const work = await directWork(j, () => home, { endsBrowserWork: true });
      const tab = tabOf(await work.use(`return (await newPage("${origin}/one")).tabId;`));
      const { threadId, id: sessionId } = await sessionOf(j);
      const holds = async () =>
        (await home.service.pageTabs.state!(j.task.userId, await row(j, tab))).usedBy.some(
          ({ taskId }) => taskId === threadId,
        );
      expect(await holds()).toBe(true);
      expect(work.sessions.workingIn.current(j.task.userId)).toEqual([
        { threadId, sessionId, tabId: tab },
      ]);
      const connection = commands(j.fixture, j.task.userId, {
        afterStop: (id, reason) => work.sessions.closeConnection(id, reason === "disconnect"),
      });
      if (end === "revoke") await connection.revoke(work.agent.id);
      else
        await connection.update(work.agent.id, {
          grant: { scope: "selected", tasks: false, resources: [] },
        });
      await j.store.driveConnectionCleanups();
      await vi.waitFor(async () => expect(await holds()).toBe(false), { timeout: 3_000 });
      expect(work.sessions.workingIn.current(j.task.userId)).toEqual([]);
      expect(work.workingIn.at(-1)?.notice).toEqual({ threadId, sessionId, tabId: null });
    } finally {
      await j.close();
      site.close();
    }
  },
);

it("names the task as the holder of the tab it works in while the person's viewers watch it: one before the call, a second during it", async () => {
  // The owner's setup, run 16: the Mac app and a web app both had the task's tab open. The
  // holder must be found by the tab itself, whatever session its page is bound to now.
  /** Taken while sampling is on: at each command of the script, and at each tabs publish. */
  const samples: Promise<boolean>[] = [];
  let sample: (() => void) | undefined;
  const j = await journey("direct-holder-viewers", {
    profile: true,
    onTabsChanged: () => sample?.(),
  });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    await j.draft();
    const work = await directWork(j, () => home, { onScriptCommand: () => sample?.() });
    const first = j.viewer(home, session.id, "watch");
    await first.attaching;
    const bound = (await row(j, tab.id)).pageBinding?.sessionId;
    let done = false;
    const working = work
      .useTab(
        `const page = await openPage(${JSON.stringify(tab.id)}); for (let step = 0; step < 8; step++) { await page.title(); await page.waitForTimeout(500); } await page.title(); return 1;`,
        tab.id,
      )
      .finally(() => {
        done = true;
      });
    const { threadId } = await sessionOf(j);
    const holds = async () =>
      (await home.service.pageTabs.state!(j.task.userId, await row(j, tab.id))).usedBy.some(
        ({ taskId }) => taskId === threadId,
      );
    await vi.waitFor(async () => expect(await holds()).toBe(true), { timeout: 3_000 });
    // A second viewer of the same tab, while the call works in it.
    const second = j.viewer(home, (await row(j, tab.id)).pageBinding!.sessionId, "control");
    await second.attaching;
    // From now until the call ends, each command it sends and each tabs publish reads the holder.
    expect(done).toBe(false);
    sample = () => {
      if (!done) samples.push(holds());
    };
    const result = await working;
    sample = undefined;
    expect(result.isError, text(result)).not.toBe(true);
    const seen = await Promise.all(samples);
    // Whether the person's viewing moved the tab's page to another session, it named the task.
    const now = (await row(j, tab.id)).pageBinding?.sessionId;
    console.info(`holder viewers: bound ${bound} -> ${now}; held ${seen.join(",")}`);
    // Its last command at least, and others before it while both viewers watched.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every(Boolean)).toBe(true);
  } finally {
    await j.close();
  }
});
