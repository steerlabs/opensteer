// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const appUrl = `opensteer-app://view/v1/apps/app_11111111-1111-4111-8111-111111111111/dark/${"a".repeat(43)}/`;
let active: boolean | null = true;

beforeEach(() => {
  vi.resetModules();
  active = true;
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

it("opens a page an app asks for at once for a press in it, and nothing asks", async () => {
  const { openAppLink, noteAppPress, open, places } = await links();
  const app = frame();
  // Another app on screen, a key rather than a pointer, a press on the page just before: none of
  // it stops a page opening, and nothing asks.
  frame("opensteer-app://view/v1/apps/app_2/dark/b/");
  focus(app);
  const proof = { kind: "frame", frame: app } as const;
  noteAppPress(app);
  expect(openAppLink("https://www.linkedin.com/in/someone", places, proof)).toBe("opened");
  expect(open).toHaveBeenCalledExactlyOnceWith("https://www.linkedin.com/in/someone");
  noteAppPress(app);
  expect(openAppLink("https://www.reddit.com/", places, proof)).toBe("opened");
  expect(open).toHaveBeenCalledTimes(2);
});

it("opens one page per press, however the app asks for more", async () => {
  const { openAppLink, noteAppPress, open, places } = await links();
  const app = frame(appUrl + "start");
  focus(app);
  const fromFrame = { kind: "frame", frame: app } as const;
  // A navigation desktop main caught for this app.
  const fromWindow = { kind: "window", source: appUrl + "start" } as const;
  noteAppPress(app);
  expect(openAppLink("https://example.com/a", places, fromFrame)).toBe("opened");
  // The same press, long after, by the port or by a navigation, opens nothing more.
  expect(openAppLink("https://example.com/b", places, fromFrame)).toBe("ignored");
  expect(openAppLink("https://example.com/c", places, fromWindow)).toBe("ignored");
  // A new press opens one page, by either way.
  noteAppPress(app);
  expect(openAppLink("https://example.com/d", places, fromWindow)).toBe("opened");
  expect(openAppLink("https://example.com/e", places, fromFrame)).toBe("ignored");
  // A press in another app is that app's own.
  noteAppPress(frame("opensteer-app://view/v1/apps/app_2/dark/b/"));
  expect(openAppLink("https://example.com/f", places, fromFrame)).toBe("ignored");
  expect(open.mock.calls.map(([url]) => url)).toEqual([
    "https://example.com/a",
    "https://example.com/d",
  ]);
});

it("does nothing for an app asking with no press of its own, no press under way, or without focus", async () => {
  const { openAppLink, noteAppPress, open, places } = await links();
  const app = frame();
  const proof = { kind: "frame", frame: app } as const;
  focus(app);
  expect(openAppLink("https://alone.test/", places, proof)).toBe("ignored");
  noteAppPress(app);
  focus(document.body);
  expect(openAppLink("https://alone.test/", places, proof)).toBe("ignored");
  focus(app);
  active = false;
  expect(openAppLink("https://alone.test/", places, proof)).toBe("ignored");
  // Another app's frame holding focus is not this app's.
  active = true;
  focus(frame("opensteer-app://view/v1/apps/app_2/dark/b/"));
  expect(openAppLink("https://alone.test/", places, proof)).toBe("ignored");
  expect(open).not.toHaveBeenCalled();
});

it("opens what desktop main caught only for the focused frame of the app named", async () => {
  const { openAppLink, noteAppPress, open, places } = await links();
  const app = frame();
  focus(app);
  noteAppPress(app);
  expect(
    openAppLink("https://example.com/", places, {
      kind: "window",
      source: "opensteer-app://view/v1/apps/app_2/dark/b/",
    }),
  ).toBe("ignored");
  expect(
    openAppLink("https://example.com/", places, { kind: "window", source: appUrl + "settings" }),
  ).toBe("opened");
  expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/");
});

it("goes to the person's own browser without a workspace, or for a page the workspace cannot open", async () => {
  const { openAppLink, noteAppPress } = await links();
  const app = frame();
  focus(app);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const proof = { kind: "frame", frame: app } as const;
  noteAppPress(app);
  expect(openAppLink("https://example.com/", { open: null }, proof)).toBe("opened");
  expect(open).toHaveBeenCalledExactlyOnceWith(
    "https://example.com/",
    "_blank",
    "noopener,noreferrer",
  );
  const openExternalUrl = vi.fn(async () => ({}));
  Reflect.set(window, "opensteerDesktop", { openExternalUrl });
  noteAppPress(app);
  openAppLink("https://example.com/desktop", { open: null }, proof);
  expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith({ url: "https://example.com/desktop" });
  const workspace = vi.fn();
  noteAppPress(app);
  openAppLink("mailto:someone@example.com", { open: workspace }, proof);
  expect(workspace).not.toHaveBeenCalled();
  expect(openExternalUrl).toHaveBeenLastCalledWith({ url: "mailto:someone@example.com" });
});
