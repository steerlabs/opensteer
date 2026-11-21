import { expect, it, vi } from "vitest";
import { AgentSessionService } from "../apps/host/src/agent-sessions/agent-session-service.js";
import { BrowserScriptService } from "../apps/host/src/browser-use/browser-script-service.js";
import {
  BrowserScriptConfinement,
  BrowserToolHandlers,
} from "../apps/host/src/mcp/handlers/browser.js";
import { connection, serveMcp } from "../apps/host/src/mcp/connection-caller.test-support.js";
import type { TabRecord } from "../packages/database/src/index.js";
import { before, holdResume, journey } from "./browser-pool-journey.test-support.js";

type Journey = Awaited<ReturnType<typeof journey>>;
type Home = Awaited<ReturnType<Journey["startHome"]>>;

/**
 * A connected agent's direct browser work on the pooled browser, through the one door and the
 * real script service. The tab list is the Home's own rows; authority stays in the database.
 */
async function directWork(j: Journey, home: () => Home) {
  const refuse = async (): Promise<never> => {
    throw new Error("Unexpected tab operation in this fixture.");
  };
  const ownerId = j.task.userId;
  const row = async (tabId: string) => {
    const tab = await j.tabs.get(ownerId, tabId as TabRecord["id"]);
    if (!tab) throw new Error("No such tab.");
    return tab;
  };
  const scriptTabs = {
    browserScriptPages: async function* () {
      const { rows } = await j.tabs.snapshot(ownerId);
      for (const tab of rows) if (tab.kind === "page") yield tab;
    },
    bindBrowserScript: async (actor: never, tabId: string) =>
      home().service.pageTabs.bindBrowserScript!(actor, await row(tabId)),
    open: refuse,
    get: async (_owner: unknown, tabId: string) => {
      const tab = await row(tabId);
      return { kind: tab.kind, profile: tab.profileId ? { profileId: tab.profileId } : null };
    },
  };
  const sessions = new AgentSessionService({ store: j.store, holdMs: 0 });
  const confinement = new BrowserScriptConfinement();
  const scripts = new BrowserScriptService({
    browser: home().service,
    store: j.store,
    tabs: confinement.tabs(scriptTabs as never),
  } as never);
  const handlers = new BrowserToolHandlers({
    sessions,
    tabs: { list: refuse, open: refuse, connectionTab: refuse, bindBrowserScript: refuse } as never,
    scripts,
    confinement,
    profiles: (owner) => home().service.listProfiles(owner),
    requireDevice: (runnerId) => j.store.requireSelfDeviceId(runnerId),
    issueTicket: (input) => home().service.issueStandardCdpTicket(input),
    pooledBrowser: (runnerId) => home().service.pooledDirectBrowser(runnerId),
    origin: new URL("https://home.example.test"),
  });
  const url = await serveMcp(j.fixture, { browser: handlers });
  const agent = await connection(j.store, url, {
    userId: ownerId,
    accessMode: "full-access",
    grant: {
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
  return { sessions, scripts, agent, use };
}

const text = (result: Awaited<ReturnType<Awaited<ReturnType<typeof directWork>>["use"]>>) =>
  JSON.stringify(result.content);

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
    expect(j.controller.effects).toEqual(["start", "pause", "resume", "pause", "resume"]);
  } finally {
    await j.close();
  }
});
