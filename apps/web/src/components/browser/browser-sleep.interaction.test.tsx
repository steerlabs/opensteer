// @vitest-environment happy-dom
import { mockBrowserPoolReport, type BrowserSleepScene } from "@opensteer/client/mock";
import type { PlaceItem } from "@opensteer/client/host";
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  click,
  client,
  element,
  mount,
  pageTab,
  settle,
  tabSearch,
  until,
} from "../workspace/workspace.interaction.test-support.js";

/**
 * A Cloud Computer's browser sleeping and waking, as the web and desktop app show it: nothing
 * while it is awake or asleep, one line while a person waits, a note once for a page that came
 * back by reloading, and Restart browser for that browser alone.
 */

function drawn(node: Element): string {
  return node.outerHTML.replace(/\b(id|for|aria-controls|aria-labelledby)="[^"]*"/gu, '$1=""');
}

/** Pictures decode and draw here as in a browser, so a page can show its last picture. */
function drawPictures() {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 960, height: 600, close: vi.fn() })),
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
}

let place: PlaceItem;
const computerOf = (item: PlaceItem) => {
  const listed = client.getSnapshot().tabs.get(item.key as never);
  if (listed?.kind !== "page") throw new Error("Not a page tab");
  return listed.computer.computerId;
};

async function openPage(options: { readonly pictures?: boolean; readonly width?: number } = {}) {
  if (options.pictures) drawPictures();
  await mount(
    (source) => {
      place = pageTab(source);
      return `/${tabSearch(place)}`;
    },
    { width: options.width ?? 1440 },
  );
  const view = await until("The page was never shown", () => element(".browser-view"));
  if (options.pictures)
    await until("The page's picture was never drawn", () =>
      expect(view.querySelector(".browser-status")).toBeNull(),
    );
  await settle(60);
  return view;
}

async function report(scene: BrowserSleepScene) {
  await act(async () =>
    client.setBrowserPools([mockBrowserPoolReport(scene, computerOf(place), place.key)]),
  );
  await settle(60);
}

async function menuItems() {
  await click(element('.place [aria-label="Browser options"]'));
  return until("The browser's options never opened", () => {
    const items = [...document.querySelectorAll(".popover [role=menuitem]")];
    expect(items.length).toBeGreaterThan(0);
    return items as HTMLElement[];
  });
}

it("shows an awake or sleeping Cloud Computer browser exactly like any other", async () => {
  const view = await openPage();
  const before = drawn(view);
  for (const scene of ["awake", "asleep"] as const) {
    await report(scene);
    expect(drawn(element(".browser-view")), scene).toBe(before);
  }
});

it("offers Restart browser only for a Cloud Computer's browser", async () => {
  await openPage();
  const plain = (await menuItems()).map((item) => item.textContent?.trim());
  expect(plain.some((label) => label?.startsWith("Restart browser"))).toBe(false);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  await settle();
  await report("awake");
  const pooled = (await menuItems()).map((item) => item.textContent?.trim());
  expect(pooled.filter((label) => !label?.startsWith("Restart browser"))).toEqual(plain);
  expect(pooled).toContain("Restart browserCloses every page and starts it fresh");
});

it("asks once, says exactly what Restart does, and is refused plainly until the Home can", async () => {
  await openPage();
  await report("awake");
  const restart = (await menuItems()).find((item) =>
    item.textContent?.startsWith("Restart browser"),
  )!;
  await click(restart);
  const dialog = await until("Restart was never confirmed", () => element("[role=dialog]"));
  expect(dialog.textContent).toContain("Restart browser?");
  expect(dialog.textContent).toContain(
    "Every page in your Cloud Computer’s browser closes and opens again from its address. Your tabs and sign-ins stay. Anything typed and not sent may be lost.",
  );
  const restartSpy = vi.spyOn(client, "restartPooledBrowser");
  const confirm = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Restart browser",
  )!;
  await click(confirm);
  expect(restartSpy).toHaveBeenCalledExactlyOnceWith(computerOf(place));
  await until("The refusal was never said", () =>
    expect(document.body.textContent).toContain(
      "Your Cloud Computer can’t restart its browser yet. Nothing was changed.",
    ),
  );
  expect(document.querySelector("[role=dialog]")).toBeNull();
});

it("says a fresh start in one line where there is no picture yet, and nothing before", async () => {
  await openPage();
  await report("starting");
  // Under the quiet moment nothing is said; the view renders again when it passes.
  expect(document.querySelector(".browser-status--wake")).toBeNull();
  const line = await until("The fresh start was never said", () =>
    element(".browser-status--wake"),
  );
  expect(line.getAttribute("role")).toBe("status");
  expect(line.textContent).toBe("Starting browser…");
});

it("answers a restart at once", async () => {
  await openPage();
  await report("restarting");
  expect(element(".browser-status--wake").textContent).toBe("Restarting browser…");
});

it("dims the last picture at once before a fresh start, and names it", async () => {
  await openPage({ pictures: true });
  await report("starting");
  const cover = await until("The picture never went stale", () => element(".browser-stale"));
  expect(cover.classList.contains("browser-stale--now")).toBe(true);
  expect(cover.textContent).toBe("Last picture · Starting browser…");
  // The chip is drawn for the eye; the same words are announced.
  expect(cover.getAttribute("aria-hidden")).toBe("true");
  expect(element('.browser-stage p.visually-hidden[role="status"]').textContent).toBe(
    "Last picture · Starting browser…",
  );
});

it("keeps a waking picture undimmed by the quiet moment, and says a tap on it was not sent", async () => {
  await openPage({ pictures: true });
  await report("waking");
  const cover = await until("The picture never went stale", () => element(".browser-stale"));
  expect(cover.classList.contains("browser-stale--now")).toBe(false);
  expect(cover.textContent).toBe("Last picture");
  await act(async () => cover.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await settle();
  expect(element(".browser-stale").textContent).toBe("Not sent · Waking browser…");
  expect(element('.browser-stage p.visually-hidden[role="status"]').textContent).toBe(
    "Not sent · Waking browser…",
  );
  // Awake again, the live picture takes over and nothing is left behind.
  await report("awake");
  await until("The live picture never came back", () =>
    expect(document.querySelector(".browser-stale")).toBeNull(),
  );
  expect(document.querySelector('.browser-stage p.visually-hidden[role="status"]')).toBeNull();
});

it("puts a browser that could not start in place of the page, tabs and sign-ins kept", async () => {
  await openPage();
  await report("failed");
  const state = await until("The failure was never shown", () => element(".place-state"));
  expect(state.textContent).toContain("Your browser couldn’t start");
  expect(state.textContent).toContain("Your tabs and sign-ins are kept. Try again in a moment.");
  const retry = [...state.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  )!;
  await click(retry);
  await until("Trying again was never answered", () =>
    expect(document.body.textContent).toContain(
      "Your Cloud Computer can’t restart its browser yet. Nothing was changed.",
    ),
  );
  await report("failed-again");
  expect(element(".place-state").textContent).toContain(
    "Your tabs and sign-ins are kept. If this keeps happening, contact support.",
  );
});

it("says once that a page reloaded, and the note leaves when seen", async () => {
  await openPage();
  await report("reloaded-typed");
  const note = element(".browser-return-note");
  expect(note.getAttribute("role")).toBe("status");
  expect(note.textContent).toBe(
    "This page reloaded because your browser restarted. Check anything you were typing.",
  );
  await click(element('.browser-return-note [aria-label="Dismiss"]'));
  expect(document.querySelector(".browser-return-note")).toBeNull();
  // The Home still reports it; this device has shown it, so it does not come back.
  await report("reloaded-typed");
  expect(document.querySelector(".browser-return-note")).toBeNull();
});

it("says once that a tab put to sleep by closing reloaded, on a Home with no pooled browser (TS7)", async () => {
  await openPage();
  expect(document.querySelector(".browser-return-note")).toBeNull();
  await act(async () => client.setBrowserReopened(place.key, Date.parse("2026-11-22T10:00:00Z")));
  await settle(60);
  const note = element(".browser-return-note");
  expect(note.getAttribute("role")).toBe("status");
  expect(note.textContent).toBe("This page reloaded because it was closed to free memory.");
  await click(element('.browser-return-note [aria-label="Dismiss"]'));
  expect(document.querySelector(".browser-return-note")).toBeNull();
  // The tab still says when it reopened; this device has shown it, so it does not come back.
  await act(async () => client.setBrowserReopened(place.key, Date.parse("2026-11-22T10:00:00Z")));
  await settle(60);
  expect(document.querySelector(".browser-return-note")).toBeNull();
  // A later reopening is a new note.
  await act(async () => client.setBrowserReopened(place.key, Date.parse("2026-11-22T11:00:00Z")));
  await settle(60);
  expect(element(".browser-return-note").textContent).toBe(
    "This page reloaded because it was closed to free memory.",
  );
});

it("lets a first touch in the page put the note away", async () => {
  await openPage();
  await report("lost");
  expect(element(".browser-return-note").textContent).toBe(
    "This page couldn’t be restored as you left it. Reload to open it again.",
  );
  await act(async () =>
    element(".browser-stage").dispatchEvent(new Event("pointerdown", { bubbles: true })),
  );
  await settle();
  expect(document.querySelector(".browser-return-note")).toBeNull();
});

it("tells the person they restarted it, when they did", async () => {
  await openPage({ width: 390 });
  await report("reloaded-by-you");
  expect(element(".browser-return-note").textContent).toBe(
    "This page reloaded because you restarted your browser.",
  );
});

it("shows an unconfirmed-closing replaced-browser session and removes it from the list (X2)", async () => {
  await openPage();
  const computerId = computerOf(place);
  const sessionId =
    client.getSnapshot().browserSessions.find((item) => item.state !== "closed")?.id ??
    "bsn_11111111-1111-4111-8111-111111111111";
  const dismissSpy = vi.fn(async () => {});
  (
    client as unknown as { dismissBrowserSession?: (id: string) => Promise<void> }
  ).dismissBrowserSession = dismissSpy;
  await act(async () =>
    client.setBrowserPools([
      {
        ...mockBrowserPoolReport("awake", computerId, place.key),
        unconfirmedClosings: [{ sessionId, surfaceIds: [place.key] }],
      } as never,
    ]),
  );
  await settle(60);
  const state = await until("The unconfirmed-closing state was never shown", () =>
    element(".place-state"),
  );
  expect(state.textContent).toContain("This page didn't confirm it closed");
  expect(state.textContent).toContain(
    "Its browser was replaced before it answered, and Opensteer can no longer ask it. Nothing more is sent to this page.",
  );
  const remove = [...state.querySelectorAll("button")].find(
    (button) => button.textContent === "Remove from list",
  );
  expect(remove).toBeDefined();
  await click(remove!);
  expect(dismissSpy).toHaveBeenCalledWith(sessionId);
});
