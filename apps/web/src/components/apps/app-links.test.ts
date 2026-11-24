// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const appUrl = `opensteer-app://view/v1/apps/app_11111111-1111-4111-8111-111111111111/dark/${"a".repeat(43)}/`;
let active: boolean | null = true;
let clock = 100_000;

beforeEach(() => {
  vi.resetModules();
  active = true;
  clock += 60_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  // Frames load only a blank page here, which the test DOM would otherwise report it refuses.
  Reflect.set(Reflect.get(window, "happyDOM").settings, "enableIframePageLoading", true);
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    get: () => (active === null ? undefined : { isActive: active, hasBeenActive: true }),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "userActivation");
  Reflect.deleteProperty(window, "opensteerDesktop");
  document.body.replaceChildren();
});

/** An app's frame as this page sees it; the test DOM loads no frame's page. */
function frame(src = appUrl): HTMLIFrameElement {
  const element = document.createElement("iframe");
  document.body.append(element);
  Object.defineProperty(element, "src", { configurable: true, get: () => src });
  return element;
}
const focus = (element: Element | null) =>
  vi.spyOn(document, "activeElement", "get").mockReturnValue(element);
async function links() {
  const module = await import("./app-links.js");
  const open = vi.fn();
  return { ...module, open, places: { open } };
}

it("opens a page an app asks for at once while a press is under way and the app holds focus", async () => {
  const { openAppLink, open, places } = await links();
  const app = frame();
  // Another app on screen, a key rather than a pointer, a press on the page just before: none of
  // it stops a page opening, and nothing asks.
  frame("opensteer-app://view/v1/apps/app_2/dark/b/");
  focus(app);
  const proof = { kind: "frame", frame: app } as const;
  expect(openAppLink("https://www.linkedin.com/in/someone", places, proof)).toBe("opened");
  expect(open).toHaveBeenCalledExactlyOnceWith("https://www.linkedin.com/in/someone");
  clock += 1_000;
  expect(openAppLink("https://www.reddit.com/", places, proof)).toBe("opened");
  expect(open).toHaveBeenCalledTimes(2);
});

it("opens one page at a time, however often an app asks while a press lasts", async () => {
  const { openAppLink, open, places } = await links();
  const app = frame();
  focus(app);
  const proof = { kind: "frame", frame: app } as const;
  expect(openAppLink("https://example.com/a", places, proof)).toBe("opened");
  clock += 100;
  expect(openAppLink("https://example.com/b", places, proof)).toBe("ignored");
  clock += 600;
  expect(openAppLink("https://example.com/c", places, proof)).toBe("opened");
  expect(open.mock.calls.map(([url]) => url)).toEqual([
    "https://example.com/a",
    "https://example.com/c",
  ]);
});

it("does nothing for an app asking with no press at all, or without focus", async () => {
  const { openAppLink, open, places } = await links();
  const app = frame();
  focus(document.body);
  expect(openAppLink("https://alone.test/", places, { kind: "frame", frame: app })).toBe("ignored");
  focus(app);
  active = false;
  expect(openAppLink("https://alone.test/", places, { kind: "frame", frame: app })).toBe("ignored");
  // Another app's frame holding focus is not this app's.
  active = true;
  focus(frame("opensteer-app://view/v1/apps/app_2/dark/b/"));
  expect(openAppLink("https://alone.test/", places, { kind: "frame", frame: app })).toBe("ignored");
  expect(open).not.toHaveBeenCalled();
});

it("opens what desktop main caught for the focused frame of the app named, and nothing for another", async () => {
  const { openAppLink, open, places } = await links();
  const app = frame();
  focus(app);
  expect(
    openAppLink("https://example.com/", places, { kind: "window", source: appUrl + "settings" }),
  ).toBe("opened");
  clock += 2_000;
  expect(
    openAppLink("https://example.com/", places, {
      kind: "window",
      source: "opensteer-app://view/v1/apps/app_2/dark/b/",
    }),
  ).toBe("ignored");
  expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/");
});

it("goes to the person's own browser without a workspace, or for a page the workspace cannot open", async () => {
  const { openAppLink } = await links();
  const app = frame();
  focus(app);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const proof = { kind: "frame", frame: app } as const;
  expect(openAppLink("https://example.com/", { open: null }, proof)).toBe("opened");
  expect(open).toHaveBeenCalledExactlyOnceWith(
    "https://example.com/",
    "_blank",
    "noopener,noreferrer",
  );
  const openExternalUrl = vi.fn(async () => ({}));
  Reflect.set(window, "opensteerDesktop", { openExternalUrl });
  clock += 2_000;
  openAppLink("https://example.com/desktop", { open: null }, proof);
  expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith({ url: "https://example.com/desktop" });
  const workspace = vi.fn();
  clock += 2_000;
  openAppLink("mailto:someone@example.com", { open: workspace }, proof);
  expect(workspace).not.toHaveBeenCalled();
  expect(openExternalUrl).toHaveBeenLastCalledWith({ url: "mailto:someone@example.com" });
});
