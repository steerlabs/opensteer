import { describe, expect, it } from "vitest";
import { tabId } from "../../test-support/mock-tabs.js";
import { pageSite, paramsTabId, tabRoute, viewedPage } from "./surface-route.js";
describe("pageSite", () => {
  it("names a site as a person says it, without its www", () => {
    expect(pageSite("https://www.google.com/search?q=a")).toBe("google.com");
    expect(pageSite("https://mail.example.com/inbox")).toBe("mail.example.com");
    expect(pageSite("about:blank")).toBeNull();
  });
});

describe("viewedPage", () => {
  const session = { id: "bsn_00000000-0000-4000-8000-000000000001" };
  const tab = { active: true, id: "page-1", title: "Example", url: "https://example.com/" };

  it("includes a page the person can see, and not one that failed to load", () => {
    expect(viewedPage(session, tab as never)).toMatchObject({ url: "https://example.com/" });
    expect(viewedPage(session, { ...tab, navigationFailed: true } as never)).toBeNull();
  });
});

describe("tab routes", () => {
  it("name exactly one tab by its tabId, through typed and untyped params", () => {
    const route = tabRoute("deployment", tabId("page"), "thread");
    expect(route).toEqual({ deploymentId: "deployment", tabId: tabId("page"), threadId: "thread" });
    expect(paramsTabId(JSON.parse(JSON.stringify(route)))).toBe(tabId("page"));
    expect(tabRoute("deployment", tabId("page"))).not.toHaveProperty("threadId");
  });

  // A link can carry any value; one that is not a tab id names nothing.
  it.each([undefined, null, 7, "", "x".repeat(513)])("names nothing for %j", (malformed) => {
    expect(paramsTabId({ tabId: malformed })).toBeNull();
  });
});
