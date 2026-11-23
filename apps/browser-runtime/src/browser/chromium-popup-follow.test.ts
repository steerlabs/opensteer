import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserSurfaceId } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { cleanup } from "./browser-test-lifecycle.js";
import {
  asRecord,
  redBoxInFrame,
  rootCdpNavigate,
  startFollowSession,
} from "./chromium.test-support.js";

const viewer = randomUUID();
const size = { width: 800, height: 600 };
const inButton = { x: 0.1, y: 0.1 };
/** Well inside the test timeout, so a lost step fails naming itself instead of timing out. */
const step = { timeout: 2_000 };

/** A page with a big button running `onclick`, and a frame on another site with the same. */
async function popupSite() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    response.setHeader("content-type", "text/html");
    response.end(
      url.pathname === "/popup"
        ? "<title>Popup</title>"
        : url.pathname === "/frame"
          ? `<body style="margin:0"><button style="width:400px;height:200px;background:rgb(255,0,0)" onclick="window.open('/popup','_blank','width=400,height=300')">open</button><script>parent.postMessage("ready","*")</script>`
          : url.pathname === "/frame-link"
            ? `<body style="margin:0"><a href="/popup?frame-bg" style="display:block;width:400px;height:200px;background:rgb(255,0,0)">frame link</a><script>parent.postMessage("ready","*")</script>`
            : `<body style="margin:0">`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, otherSite: `http://localhost:${port}` };
}

async function openPage() {
  const site = await popupSite();
  const session = await startFollowSession();
  const id = session.rootSurfaceId;
  await rootCdpNavigate(session.ledger, id, site.origin);
  await session.controller.handle({ type: "stream.subscribe", surfaceId: id });
  await session.fit(id, size);
  await vi.waitFor(
    () =>
      expect(
        session.frames.some((f) => f.header.surfaceId === id),
        "the page streamed its first frame",
      ).toBe(true),
    step,
  );
  const opened = () =>
    session.sink.messages.flatMap((message) =>
      message.type === "browser.popup.opened" ? [message] : [],
    );
  const popups = () => session.ledger.snapshot().filter((surface) => surface.id !== id);
  return {
    ...session,
    id,
    opened,
    popups,
    site,
    /** Puts a button filling the page's top-left, opening a popup each `opens` times. */
    button: (opens = 1) =>
      session.read(
        id,
        `document.body.innerHTML = '<button id="b" style="width:400px;height:200px">open</button>';
         document.querySelector("#b").onclick = () => {
           for (let i = 0; i < ${opens}; i++) window.open("/popup?" + i, "_blank", "width=400,height=300");
         };
         document.querySelector("#b").focus();`,
      ),
    click: async (surfaceId: BrowserSurfaceId = id) => {
      for (const action of ["down", "up"] as const)
        await session.controller.handle({
          type: "input.pointer",
          action,
          button: "left",
          clickCount: 1,
          surfaceId,
          ...inButton,
          viewportWidth: size.width,
          viewportHeight: size.height,
          producerId: viewer,
        });
    },
  };
}

describe("a popup follows the viewer whose input opened it", () => {
  it("names the viewer of a click in the page or in a cross-site frame", async () => {
    const page = await openPage();
    await page.button();
    await page.click();
    await vi.waitFor(() => expect(page.opened(), "a click in the page").toHaveLength(1), step);
    expect(page.opened()[0]).toMatchObject({
      consumerToken: viewer,
      surfaceId: page.popups()[0]?.id,
    });

    // The first popup can suppress background painting of the root in headless Chromium.
    await page.ledger.binding(page.id)!.cdp.send("Page.bringToFront");
    await page.read(
      page.id,
      `window.frameReady = false;
         window.onmessage = () => { window.frameReady = true; };
         document.body.innerHTML = '<iframe style="border:0;width:500px;height:300px" src="${page.site.otherSite}/frame"></iframe>';`,
    );
    await vi.waitFor(async () => {
      expect(await page.read(page.id, "window.frameReady"), "the frame loaded").toBe(true);
      expect(
        JSON.stringify(await page.agent("Target.getTargets")),
        "the frame has its own target",
      ).toContain(`"type":"iframe"`);
    }, step);
    // A frame's scripts and target precede its compositor surface becoming hit-testable.
    await vi.waitFor(async () => {
      const frame = page.frames.findLast((frame) => frame.header.surfaceId === page.id);
      const button = frame
        ? await redBoxInFrame((expression) => page.read(page.id, expression), frame)
        : null;
      expect(
        button &&
          button.left < inButton.x * button.width &&
          button.right > inButton.x * button.width &&
          button.top < inButton.y * button.height &&
          button.bottom > inButton.y * button.height,
        "the streamed frame shows the button at the click point",
      ).toBe(true);
    }, step);
    await page.click();
    await vi.waitFor(() => expect(page.opened(), "a click in the frame").toHaveLength(2), step);
    expect(page.opened()[1]?.consumerToken).toBe(viewer);
  });

  it("names the viewer of the key that opened it, and only one popup per input", async () => {
    const page = await openPage();
    await page.button(2);
    for (const action of ["down", "up"] as const)
      await page.controller.handle({
        type: "input.key",
        action,
        key: "Enter",
        code: "Enter",
        modifiers: [],
        surfaceId: page.id,
        producerId: viewer,
      });
    await vi.waitFor(() => expect(page.popups(), "a key's two popups").toHaveLength(2), step);
    expect(page.opened()).toHaveLength(1);
  });

  it("names nobody for a popup an agent's click opened", async () => {
    const page = await openPage();
    await page.button();
    const { sessionId } = asRecord(
      await page.agent("Target.attachToTarget", { targetId: page.rootTargetId, flatten: true }),
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await page.agent(
        "Input.dispatchMouseEvent",
        { type, x: 40, y: 40, button: "left", clickCount: 1 },
        String(sessionId),
      );
    await vi.waitFor(() => expect(page.popups(), "an agent's popup").toHaveLength(1), step);
    expect(page.opened()).toHaveLength(0);
  });

  it("opens links in new tabs via primary-click, middle-click, shift-click, cross-site frames, and keyboard without stealing focus on background tabs", async () => {
    const page = await openPage();
    const primary = process.platform === "darwin" ? "meta" : "control";
    const clickLink = async (
      button: "left" | "middle",
      modifiers: Array<"alt" | "control" | "meta" | "shift">,
      point = inButton,
    ) => {
      for (const action of ["down", "up"] as const)
        await page.controller.handle({
          type: "input.pointer",
          action,
          button,
          modifiers,
          clickCount: 1,
          surfaceId: page.id,
          ...point,
          viewportWidth: size.width,
          viewportHeight: size.height,
          producerId: viewer,
        });
    };

    await page.read(
      page.id,
      `document.body.innerHTML = '<a id="l" href="/popup?bg" style="display:block;width:400px;height:150px;background:rgb(255,0,0)">link</a><a id="b" href="/popup?blank" target="_blank" style="display:block;width:400px;height:150px;background:rgb(0,0,255)">blank</a>';`,
    );

    // 1. Primary+Click (Cmd+Click on macOS, Ctrl+Click on Linux/Win) on a normal link opens a background tab owned by this session with openerId.
    await clickLink("left", [primary]);
    await vi.waitFor(() => expect(page.popups(), "primary+click tab").toHaveLength(1), step);
    expect(page.popups()[0]).toMatchObject({ openerId: page.id });
    await vi.waitFor(
      () => expect(page.popups()[0]?.url).toBe(`${page.site.origin}/popup?bg`),
      step,
    );
    expect(page.opened(), "background tab must not steal focus").toHaveLength(0);
    expect(page.ledger.activeSurfaceId, "background tab must not steal activeSurfaceId").toBe(
      page.id,
    );

    // 2. Middle-click on a normal link opens a background tab without stealing focus.
    await clickLink("middle", []);
    await vi.waitFor(() => expect(page.popups(), "middle-click tab").toHaveLength(2), step);
    expect(page.popups()[1]).toMatchObject({ openerId: page.id });
    expect(page.opened(), "middle-click must not steal focus").toHaveLength(0);

    // 3. Primary+Click on target=_blank opens in the background without stealing focus.
    await clickLink("left", [primary], { x: 0.1, y: 0.35 });
    await vi.waitFor(
      () => expect(page.popups(), "primary+click target=_blank").toHaveLength(3),
      step,
    );
    expect(page.popups()[2]).toMatchObject({ openerId: page.id });
    expect(page.opened(), "primary+click on target=_blank must not steal focus").toHaveLength(0);

    // 4. Primary+Shift+Click opens a foreground tab and follows the clicking viewer.
    await clickLink("left", [primary, "shift"]);
    await vi.waitFor(() => expect(page.popups(), "primary+shift+click tab").toHaveLength(4), step);
    await vi.waitFor(
      () =>
        expect(page.opened(), "primary+shift+click brings foreground tab forward").toHaveLength(1),
      step,
    );
    expect(page.opened()[0]).toMatchObject({
      consumerToken: viewer,
      surfaceId: page.popups()[3]?.id,
    });

    // 5. Shift+Middle-Click opens a foreground tab and follows the clicking viewer.
    await clickLink("middle", ["shift"]);
    await vi.waitFor(() => expect(page.popups(), "shift+middle-click tab").toHaveLength(5), step);
    await vi.waitFor(
      () =>
        expect(page.opened(), "shift+middle-click brings foreground tab forward").toHaveLength(2),
      step,
    );
    expect(page.opened()[1]?.surfaceId).toBe(page.popups()[4]?.id);

    // 5b. Shift+Left-Click (new-window disposition) opens a foreground tab and follows the clicking viewer.
    await page.controller.handle({ type: "surface.activate", surfaceId: page.id });
    await page.ledger.binding(page.id)!.cdp.send("Page.bringToFront");
    await clickLink("left", ["shift"]);
    await vi.waitFor(() => expect(page.popups(), "shift+left-click tab").toHaveLength(6), step);
    await vi.waitFor(
      () => expect(page.opened(), "shift+left-click brings foreground tab forward").toHaveLength(3),
      step,
    );
    expect(page.opened()[2]?.surfaceId).toBe(page.popups()[5]?.id);

    // 6. Primary+Click on a link inside a cross-site iframe opens a background tab owned by this session.
    // Clear the top-level page first (white background) so redBoxInFrame cannot match the previous red link.
    await page.controller.handle({ type: "surface.activate", surfaceId: page.id });
    await page.ledger.binding(page.id)!.cdp.send("Page.bringToFront");
    await page.read(page.id, `document.body.innerHTML = '';`);
    await vi.waitFor(async () => {
      const frame = page.frames.findLast((f) => f.header.surfaceId === page.id);
      const box = frame
        ? await redBoxInFrame((expression) => page.read(page.id, expression), frame)
        : null;
      expect(box, "previous red link cleared before mounting cross-site iframe").toBeNull();
    }, step);
    await page.read(
      page.id,
      `window.frameReady = false;
       window.onmessage = () => { window.frameReady = true; };
       document.body.innerHTML = '<iframe style="border:0;width:500px;height:300px" src="${page.site.otherSite}/frame-link"></iframe>';`,
    );
    await vi.waitFor(async () => {
      expect(await page.read(page.id, "window.frameReady"), "the link iframe loaded").toBe(true);
      const frame = page.frames.findLast((f) => f.header.surfaceId === page.id);
      const box = frame
        ? await redBoxInFrame((expression) => page.read(page.id, expression), frame)
        : null;
      expect(
        box &&
          box.left < inButton.x * box.width &&
          box.right > inButton.x * box.width &&
          box.top < inButton.y * box.height &&
          box.bottom > inButton.y * box.height,
        "the streamed frame shows the cross-site link",
      ).toBe(true);
    }, step);
    await clickLink("left", [primary]);
    await vi.waitFor(
      () => expect(page.popups(), "cross-site iframe primary+click tab").toHaveLength(7),
      step,
    );
    expect(page.popups()[6]).toMatchObject({ openerId: page.id });
    await vi.waitFor(
      () => expect(page.popups()[6]?.url).toBe(`${page.site.otherSite}/popup?frame-bg`),
      step,
    );
    expect(page.opened(), "cross-site iframe background tab must not steal focus").toHaveLength(3);

    // 7. Primary+Enter on a focused link opens a background tab without stealing focus.
    await page.ledger.binding(page.id)!.cdp.send("Page.bringToFront");
    await page.read(
      page.id,
      `document.body.innerHTML = '<a id="l" href="/popup?key-bg" style="display:block;width:400px;height:150px">link</a>';`,
    );
    // Return renderer focus from the removed cross-site iframe to the main frame, then focus the link.
    await clickLink("left", [], { x: 0.9, y: 0.9 });
    await page.read(page.id, `document.querySelector("#l").focus();`);
    for (const action of ["down", "up"] as const)
      await page.controller.handle({
        type: "input.key",
        action,
        key: "Enter",
        code: "Enter",
        modifiers: [primary],
        surfaceId: page.id,
        producerId: viewer,
      });
    await vi.waitFor(() => expect(page.popups(), "primary+enter tab").toHaveLength(8), step);
    expect(page.popups()[7]).toMatchObject({ openerId: page.id });
    expect(page.opened(), "primary+enter must not steal focus").toHaveLength(3);

    // 8. A stale primary+click on empty space followed immediately by primary+shift+click on a link
    // must open in the foreground (newest gesture wins), and a stale primary+click before window.open must not suppress follow.
    await clickLink("left", [primary], { x: 0.9, y: 0.9 });
    await clickLink("left", [primary, "shift"], inButton);
    await vi.waitFor(
      () => expect(page.popups(), "foreground link after empty primary+click").toHaveLength(9),
      step,
    );
    await vi.waitFor(
      () =>
        expect(
          page.opened(),
          "primary+shift+click after stale empty primary+click still follows foreground",
        ).toHaveLength(4),
      step,
    );
    expect(page.opened()[3]?.surfaceId).toBe(page.popups()[8]?.id);

    await page.controller.handle({ type: "surface.activate", surfaceId: page.id });
    await page.ledger.binding(page.id)!.cdp.send("Page.bringToFront");
    await clickLink("left", [primary], { x: 0.9, y: 0.9 });
    await page.button();
    await page.click();
    await vi.waitFor(
      () => expect(page.popups(), "window.open after empty primary+click").toHaveLength(10),
      step,
    );
    await vi.waitFor(
      () =>
        expect(page.opened(), "window.open still follows after stale primary+click").toHaveLength(
          5,
        ),
      step,
    );
  });
});
