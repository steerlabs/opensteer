import { describe, expect, it } from "vitest";
import {
  SessionCdpRouter,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpParameters,
} from "./session-cdp-router.js";

/** A page's channel that records what ran in it. */
class Page implements CdpChannel {
  readonly ran: string[] = [];
  close(): Promise<void> {
    return Promise.resolve();
  }
  onEvent(): () => void {
    return () => undefined;
  }
  async send(method: string): Promise<unknown> {
    this.ran.push(method);
    return {};
  }
}

/** As Electron's backend: a root command that is no Target.* runs on the profile's first page. */
class FirstPageBackend implements BrowserCdpBackend {
  readonly pages = new Map([
    ["person-tab", new Page()],
    ["run-tab", new Page()],
  ]);
  onEvent(): () => void {
    return () => undefined;
  }
  async attach(targetId: string): Promise<CdpChannel> {
    return this.pages.get(targetId)!;
  }
  async send(method: string, parameters?: CdpParameters): Promise<unknown> {
    if (method === "Target.getTargets")
      return {
        targetInfos: [...this.pages.keys()].map((targetId) => ({
          targetId,
          type: "page",
          url: "https://web.test/",
        })),
      };
    if (method === "Target.getTargetInfo")
      return {
        targetInfo: { targetId: parameters?.targetId, type: "page", url: "https://web.test/" },
      };
    return this.pages.get("person-tab")!.send(method);
  }
}

describe("a Run's root command that needs a page names a page session (G6)", () => {
  it("never runs in whatever tab is first: the person's own page or another task's", async () => {
    const backend = new FirstPageBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("s", "person-tab", async () => true, "/files/s");
    router.claimTarget("s", "run-tab");
    // The Run holds the second tab through its own page session.
    const { sessionId } = (await router.send("s", {
      method: "Target.attachToTarget",
      parameters: { targetId: "run-tab", flatten: true },
    })) as { sessionId: string };
    for (const method of [
      "Runtime.evaluate",
      "Page.navigate",
      "Page.captureScreenshot",
      "Network.setCookie",
      "Network.getAllCookies",
      "DOM.getDocument",
      "Input.dispatchMouseEvent",
    ])
      await expect(router.send("s", { method, parameters: {} }), method).rejects.toMatchObject({
        code: "forbidden",
      });
    expect(backend.pages.get("person-tab")!.ran).toEqual([]);
    // Through its own page session it works as before, in its own tab.
    await router.send("s", { method: "Runtime.evaluate", parameters: {}, sessionId });
    expect(backend.pages.get("run-tab")!.ran).toContain("Runtime.evaluate");
    // The browser's and the profile's own commands need no page and are answered as before.
    for (const method of ["Browser.getVersion", "SystemInfo.getProcessInfo", "Storage.getCookies"])
      await router.send("s", { method, parameters: {} });
  });
});
