// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const appUrl = `opensteer-app://view/v1/apps/app_11111111-1111-4111-8111-111111111111/dark/${"a".repeat(43)}/`;
let active: boolean | null = true;
let clock = 100_000;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setInterval"] });
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
function trusted<T extends Event>(event: T): T {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}
const pointAt = (element: Element) =>
  element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
const pointAway = (element: Element) =>
  element.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));

async function links() {
  const module = await import("./app-links.js");
  module.watchAppInput();
  const open = vi.fn();
  const ask = vi.fn();
  return { ...module, open, ask, places: { open, ask } };
}

it("opens at once a press this page can tell was in the asking app, and only one page for it", async () => {
  const { openAppLink, open, ask, places } = await links();
  const app = frame();
  focus(app);
  pointAt(app);
  const proof = { kind: "frame", frame: app } as const;
  expect(openAppLink("https://www.linkedin.com/in/someone", places, proof)).toBe("opened");
  expect(open).toHaveBeenCalledExactlyOnceWith("https://www.linkedin.com/in/someone");
  // What else the app asks for while that press lasts is asked about, once per page.
  clock += 1_000;
  expect(openAppLink("https://www.reddit.com/", places, proof)).toBe("asked");
  clock += 400;
  expect(openAppLink("https://www.reddit.com/", places, proof)).toBe("ignored");
  clock += 5_000;
  expect(openAppLink("https://www.reddit.com/", places, proof)).toBe("opened");
  expect(ask).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledTimes(2);
});

it("credits nothing at once while another frame is on the page, and forgets a frame removed under the pointer", async () => {
  const { openAppLink, open, ask, places } = await links();
  const app = frame();
  const other = frame("opensteer-app://view/v1/apps/app_2/dark/b/");
  pointAt(other);
  focus(app);
  pointAt(app);
  const proof = { kind: "frame", frame: app } as const;
  expect(openAppLink("https://example.com/two", places, proof)).toBe("asked");
  // The other frame goes (a tab switch) without the pointer ever leaving it.
  other.remove();
  clock += 6_000;
  expect(openAppLink("https://example.com/later", places, proof)).toBe("asked");
  clock += 6_000;
  expect(openAppLink("https://example.com/alone", places, proof)).toBe("opened");
  expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/alone");
  expect(ask).toHaveBeenCalledTimes(2);
});

it("does nothing for an app asking with no press at all, or without focus", async () => {
  const { openAppLink, open, ask, places } = await links();
  const app = frame();
  pointAt(app);
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
  expect(ask).not.toHaveBeenCalled();
});

it("asks when a press might have been elsewhere: on the page, under another frame, by key, or in a frame that held focus", async () => {
  const { openAppLink, open, ask, places } = await links();
  const app = frame();
  const other = frame("opensteer-app://view/v1/apps/app_2/dark/b/");
  const proof = { kind: "frame", frame: app } as const;
  focus(app);
  // A key: the pointer is not over the app.
  expect(openAppLink("https://example.com/key", places, proof)).toBe("asked");
  // A press on the page just before, pointer now over the app.
  clock += 2_000;
  pointAt(app);
  window.dispatchEvent(trusted(new KeyboardEvent("keydown", { key: "Tab" })));
  clock += 1_000;
  expect(openAppLink("https://example.com/page", places, proof)).toBe("asked");
  // The pointer was just over another app.
  clock += 6_000;
  pointAt(other);
  pointAway(other);
  pointAt(app);
  clock += 1_000;
  expect(openAppLink("https://example.com/other", places, proof)).toBe("asked");
  // Another app held focus a moment ago, then this one took it.
  clock += 6_000;
  focus(other);
  vi.advanceTimersByTime(200);
  focus(app);
  clock += 1_000;
  expect(openAppLink("https://example.com/focus", places, proof)).toBe("asked");
  expect(open).not.toHaveBeenCalled();
  expect(ask.mock.calls.map(([url]) => url)).toEqual([
    "https://example.com/key",
    "https://example.com/page",
    "https://example.com/other",
    "https://example.com/focus",
  ]);
  // Agreeing opens it, in the workspace.
  ask.mock.calls[0]![1]();
  expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/key");
  // Long after all of that, with this app alone on the page, a press opens at once.
  other.remove();
  clock += 6_000;
  expect(openAppLink("https://example.com/now", places, proof)).toBe("opened");
});

it("asks for everything desktop main caught, and only for the focused frame of the app named", async () => {
  const { openAppLink, open, ask, places } = await links();
  const app = frame();
  focus(app);
  pointAt(app);
  expect(
    openAppLink("https://example.com/", places, { kind: "window", source: appUrl + "settings" }),
  ).toBe("asked");
  clock += 2_000;
  expect(
    openAppLink("https://example.com/", places, {
      kind: "window",
      source: "opensteer-app://view/v1/apps/app_2/dark/b/",
    }),
  ).toBe("ignored");
  expect(open).not.toHaveBeenCalled();
  expect(ask).toHaveBeenCalledOnce();
});

it("asks rather than opens where the browser cannot say a press happened, and never buries the person", async () => {
  const { openAppLink, ask, places } = await links();
  const app = frame();
  focus(app);
  pointAt(app);
  const proof = { kind: "frame", frame: app } as const;
  active = null;
  expect(openAppLink("https://example.com/a", places, proof)).toBe("asked");
  clock += 100;
  expect(openAppLink("https://example.com/b", places, proof)).toBe("ignored");
  clock += 400;
  expect(openAppLink("https://example.com/a", places, proof)).toBe("ignored");
  expect(openAppLink("https://example.com/b", places, proof)).toBe("asked");
  expect(ask.mock.calls.map(([url]) => url)).toEqual([
    "https://example.com/a",
    "https://example.com/b",
  ]);
});

it("goes to the person's own browser without a workspace, and names pages briefly", async () => {
  const { openAppLink, appLinkLabel } = await links();
  const app = frame();
  focus(app);
  pointAt(app);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const proof = { kind: "frame", frame: app } as const;
  expect(openAppLink("https://example.com/", { open: null, ask: vi.fn() }, proof)).toBe("opened");
  expect(open).toHaveBeenCalledExactlyOnceWith(
    "https://example.com/",
    "_blank",
    "noopener,noreferrer",
  );
  const openExternalUrl = vi.fn(async () => ({}));
  Reflect.set(window, "opensteerDesktop", { openExternalUrl });
  clock += 2_000;
  openAppLink("https://example.com/desktop", { open: null, ask: vi.fn() }, proof);
  expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith({ url: "https://example.com/desktop" });
  expect(appLinkLabel("https://www.linkedin.com/in/someone?x=1")).toBe("linkedin.com/in/someone");
  expect(appLinkLabel(`https://example.com/${"a".repeat(100)}`)).toHaveLength(60);
  // The whole site, port included, however long; only the path gives way.
  const site = `${"login.".repeat(12)}example.com:8443`;
  expect(appLinkLabel(`https://${site}/x/y`)).toBe(site + "…");
});
