import { createId, refused } from "@opensteer/core";
import type { TabRecord } from "@opensteer/database";
import { expect, it, vi } from "vitest";
import { BrowserScriptService } from "./browser-script-service.js";

it("does not tell the owner about a page whose bind returns after abort", async () => {
  const ownerId = createId("user");
  const tabId = createId("tab");
  const abort = new AbortController();
  const entered = Promise.withResolvers<void>();
  const bound = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const workingIn = vi.fn();
  const openPage = vi.fn(async () => {
    entered.resolve();
    await bound.promise;
    return { tabId, targetId: "target", sessionId: "channel" };
  });
  const service = new BrowserScriptService({
    browser: { browserBindingEnded: () => false },
    store: { admitExecution: async () => ({ agentConnection: { grantRevision: 1 } }) },
    sharedChromeTabs: { browserUsePort: () => ({ openPage, release: () => released.resolve() }) },
    workingIn,
  } as unknown as ConstructorParameters<typeof BrowserScriptService>[0]);
  const result = service
    .runBrowserScript({
      authority: { ownerId, agentBindingId: `session:${createId("agentSession")}` },
      sharedChromeTabId: tabId,
      contextKey: "returning-bind",
      code: `await openPage(${JSON.stringify(tabId)});`,
      signal: abort.signal,
    })
    .catch(() => undefined);
  try {
    await entered.promise;
    abort.abort(new Error("The person narrowed the grant."));
    bound.resolve();
    await released.promise;
    expect(workingIn).not.toHaveBeenCalled();
  } finally {
    bound.resolve();
    await result;
    await service.close();
  }
});

it("keeps Guest and ungranted profiles out of a selected binding's script", async () => {
  const ownerId = createId("user");
  const threadId = createId("thread");
  const runId = createId("run");
  const authority = { ownerId, agentBindingId: `run:${runId}` };
  const guestTabId = createId("tab");
  const grantedProfileId = createId("browserProfile");
  const ungrantedProfileId = createId("browserProfile");
  const services = {
    browser: {
      attachCdpForAgent: vi.fn(),
      flushPendingTabDescriptors: vi.fn(),
      listAgentProfiles: vi.fn(async () => [
        { id: ungrantedProfileId, name: "Private", home: null },
      ]),
      detachAgentSessionsForBinding: vi.fn(),
      tabOccupants: vi.fn(),
      browserBindingEnded: vi.fn(() => false),
    },
    store: {
      admitExecution: vi.fn<
        ConstructorParameters<typeof BrowserScriptService>[0]["store"]["admitExecution"]
      >(async ({ subject }) => ({
        ownerUserId: ownerId,
        subject,
        actor: "agent",
        threadId,
        runId,
        taskMode: "full-access",
        runMode: "full-access",
        mode: "full-access",
        agentConnection: {
          agentConnectionId: "mcn_selected",
          grantRevision: 1,
          consentVersion: 2,
          accessMode: "full-access",
          grant: {
            scope: "selected",
            tasks: true,
            resources: [
              { kind: "browser-profile", profileId: grantedProfileId, access: "read-write" },
            ],
          },
        },
      })),
    },
    tabs: {
      async *browserScriptPages() {
        const now = new Date();
        yield {
          id: guestTabId,
          ownerId,
          kind: "page",
          computerId: createId("device"),
          title: "Guest tab",
          url: "about:blank",
          profileId: null,
          profileName: null,
          appId: null,
          windowId: null,
          windowApp: null,
          pageBinding: null,
          favicon: null,
          iconRef: null,
          openerTabId: null,
          openedBy: { taskId: threadId },
          generation: 1,
          createdAt: now,
          updatedAt: now,
          closedAt: null,
          closedPosition: null,
        } satisfies TabRecord;
      },
      bindBrowserScript: vi.fn<
        ConstructorParameters<typeof BrowserScriptService>[0]["tabs"]["bindBrowserScript"]
      >(async (_actor, _tabId, options) => {
        if (options?.savedProfileOnly) throw refused("forbidden", "Guest tabs are unavailable.");
        throw new Error("Guest restriction missing.");
      }),
      open: vi.fn(),
    },
  };
  const scripts = new BrowserScriptService(services);
  const run = (code: string) => scripts.runBrowserScript({ authority, contextKey: "test", code });
  try {
    expect(await run("return await pages();")).toMatchObject({
      content: [{ type: "text", text: "[]" }],
    });
    expect(await run(`await openPage(${JSON.stringify(guestTabId)});`)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "forbidden", message: "Guest tabs are unavailable." } },
    });
    for (const code of [
      'await newPage("about:blank");',
      `await newPage("about:blank", { profileId: ${JSON.stringify(ungrantedProfileId)} });`,
    ])
      expect(await run(code)).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: "forbidden", message: "No granted browser profile matches this request." },
        },
      });
    expect(services.tabs.open).not.toHaveBeenCalled();
    expect(services.browser.attachCdpForAgent).not.toHaveBeenCalled();
  } finally {
    await scripts.close();
  }
});
