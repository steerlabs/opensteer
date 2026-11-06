import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserSurfaceId } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { cleanup } from "./browser-test-lifecycle.js";
import { asRecord, rootCdpNavigate, startFollowSession } from "./chromium.test-support.js";

const viewer = randomUUID();
const size = { width: 800, height: 600 };
const inButton = { x: 0.1, y: 0.1 };

/** A page with a big button running `onclick`, and a frame on another site with the same. */
async function popupSite() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    response.setHeader("content-type", "text/html");
    response.end(
      url.pathname === "/popup"
        ? "<title>Popup</title>"
        : url.pathname === "/frame"
          ? `<body style="margin:0"><button style="width:400px;height:200px" onclick="window.open('/popup','_blank','width=400,height=300')">open</button><script>parent.postMessage("ready","*")</script>`
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
  await vi.waitFor(() => expect(session.frames.some((f) => f.header.surfaceId === id)).toBe(true), {
    timeout: 5_000,
  });
  const opened = () =>
    session.sink.messages.flatMap((message) =>
      message.type === "browser.popupFollow.opened" ? [message] : [],
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
    await vi.waitFor(() => expect(page.opened()).toHaveLength(1), { timeout: 5_000 });
    expect(page.opened()[0]).toMatchObject({
      consumerToken: viewer,
      surfaceId: page.popups()[0]?.id,
    });

    await page.read(
      page.id,
      `window.frameReady = false;
         window.onmessage = () => { window.frameReady = true; };
         document.body.innerHTML = '<iframe style="border:0;width:500px;height:300px" src="${page.site.otherSite}/frame"></iframe>';`,
    );
    await vi.waitFor(
      async () => {
        expect(await page.read(page.id, "window.frameReady")).toBe(true);
        expect(JSON.stringify(await page.agent("Target.getTargets"))).toContain(`"type":"iframe"`);
      },
      { timeout: 5_000 },
    );
    await page.click();
    await vi.waitFor(() => expect(page.opened()).toHaveLength(2), { timeout: 5_000 });
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
    await vi.waitFor(() => expect(page.popups()).toHaveLength(2), { timeout: 5_000 });
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
    await vi.waitFor(() => expect(page.popups()).toHaveLength(1), { timeout: 5_000 });
    expect(page.opened()).toHaveLength(0);
  });
});
