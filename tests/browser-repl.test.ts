import { once } from "node:events";
import { createServer } from "node:http";
import { BrowserSurfaceIdSchema } from "../packages/protocol/src/index.js";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  BrowserReplService,
  type BrowserUseBudget,
  type BrowserUseCall,
  type BrowserUsePort,
} from "../apps/host/src/browser-use/browser-repl-service.js";
import {
  browserTestSignal,
  cleanup,
  waitForLedgerState,
} from "../apps/browser-runtime/src/browser/browser-test-lifecycle.js";
import { rootCdpNavigate } from "../apps/browser-runtime/src/browser/chromium.test-support.js";
import { startActionJourney } from "../apps/browser-runtime/src/browser/harness-actions.test-support.js";

async function serveFixture() {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url?.startsWith("/popup")) {
      response.end("<!doctype html><title>Popup</title><main>Opened from the journey</main>");
      return;
    }
    response.end(`<!doctype html><title>Browser REPL fixture</title>
      <button id="activate">Activate</button>
      <p id="activity"></p>
      <form><label>Name <input name="name"></label><button>Submit</button></form>
      <button id="popup">Open popup</button>
      <button id="confirm">Confirm</button>
      <p id="answer" hidden></p>
      <script>
        document.querySelector("#activate").onclick = event => {
          document.querySelector("#activity").textContent = event.isTrusted ? "trusted click" : "synthetic click";
        };
        document.querySelector("form").onsubmit = event => {
          event.preventDefault();
          const name = new FormData(event.target).get("name");
          setTimeout(() => {
            const status = document.createElement("p");
            status.setAttribute("role", "status");
            status.textContent = "Submitted " + name;
            document.body.append(status);
          }, 200);
        };
        document.querySelector("#popup").onclick = () => window.open("/popup", "_blank");
        document.querySelector("#confirm").onclick = () => {
          const answer = document.querySelector("#answer");
          answer.textContent = window.confirm("Submit this form?") ? "Accepted" : "Declined";
          answer.hidden = false;
        };
      </script>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture had no listening address.");
  return `http://127.0.0.1:${address.port}`;
}

it("runs the native Page API inside the REPL against a managed Chromium session", async () => {
  const origin = await serveFixture();
  const { ledger, router, claims, surfaceId, run: native } = await startActionJourney("20", {});
  const { sessionId } = claims;
  const attachment = z.object({ sessionId: z.string() });
  const dialogReply = z.object({
    dialogId: z.string(),
    accept: z.boolean(),
    promptText: z.string().optional(),
  });
  // The fixture router already caps incoming CDP frames. Check the narrower REPL budget as well.
  const encode = (value: unknown, budget: BrowserUseBudget) => {
    const json = JSON.stringify(value ?? null);
    if (Buffer.byteLength(json) > budget.maxBytes)
      throw new Error("Fixture reply exceeded its budget.");
    return json;
  };
  const openPage = async (tabId: string, { signal }: BrowserUseCall) => {
    signal.throwIfAborted();
    const surface = BrowserSurfaceIdSchema.parse(tabId);
    const binding = ledger.binding(surface);
    if (!binding) throw new Error(`Tab ${tabId} has no browser target.`);
    const { targetId } = binding;
    await ledger.settleTarget(targetId);
    const attached = attachment.parse(
      await router.send(sessionId, {
        method: "Target.attachToTarget",
        parameters: { targetId, flatten: true },
      }),
    );
    return { tabId, targetId, sessionId: attached.sessionId, dialog: ledger.dialogOf(surface) };
  };
  const port: BrowserUsePort = {
    listPages: async () =>
      ledger.snapshot().map(({ id, url, title }) => ({
        tabId: id,
        url,
        title,
        profile: "Test profile",
      })),
    openPage,
    newPage: async ({ url }, call) => {
      const { signal } = call;
      const created = await ledger.openSurface({ signal, origin: "agent", activate: false });
      await rootCdpNavigate(ledger, created.id, url);
      return openPage(created.id, call);
    },
    command: async (target, method, parameters, attached, call) => {
      call.signal.throwIfAborted();
      const command = {
        method,
        ...(parameters ? { parameters } : {}),
        ...(attached ? { sessionId: attached } : {}),
      };
      if (method === "Page.handleJavaScriptDialog") {
        router.admitPageCommand(sessionId, command);
        const { dialogId, accept, promptText } = dialogReply.parse(parameters);
        if (ledger.dialogOf(BrowserSurfaceIdSchema.parse(target.tabId))?.id !== dialogId)
          throw new Error("This dialog is no longer active on the page.");
        await ledger.answerDialog(dialogId, accept, promptText);
        return "{}";
      }
      return encode(await router.send(sessionId, command), call);
    },
    subscribe: (target, listener, onEnd, budget) => {
      const offLedger = ledger.subscribe((event) => {
        if (
          event.type === "closed" ||
          (event.type === "changed" &&
            event.change === "closed" &&
            event.surface.id === target.tabId)
        )
          onEnd();
      });
      const offCdp = router.onEvent(sessionId, ({ method, parameters, sessionId: attached }) => {
        if (method === "Target.detachedFromTarget" && parameters?.sessionId === target.sessionId)
          onEnd();
        else if (attached && router.attachedTargetId(sessionId, attached) === target.targetId)
          listener({ method, paramsJson: encode(parameters, budget), sessionId: attached });
      });
      return () => {
        offCdp();
        offLedger();
      };
    },
  };
  const service = new BrowserReplService({ port });
  cleanup.push(() => service.close());
  const execute = (code: string) => service.execute("chromium", code, browserTestSignal());
  const program = `
    await page.goto(${JSON.stringify(origin + "/journey?source=repl&tag=first&tag=two+words#ready")});
    let urlView;
    await page.waitForURL(url => {
      urlView = [url.origin, url.pathname, url.hash, String(url), url.toJSON(),
        url.searchParams.get("source"), url.searchParams.getAll("tag"), [...url.searchParams],
        url.searchParams.has("tag", "two words"), url.searchParams.get("missing")];
      return url.pathname === "/journey" && url.searchParams.get("source") === "repl";
    });
    if (await page.evaluate(() => document.querySelector('[role="status"]') !== null))
      throw new Error("The journey began on a document an earlier run had used.");
    await page.getByRole("button", { name: "Activate" }).click();
    await page.getByLabel("Name").fill("Ada Lovelace");
    await page.getByRole("button", { name: "Submit" }).click();
    const status = page.getByRole("status");
    await status.waitFor({ state: "visible" });
    let dialog;
    try { await page.getByRole("button", { name: "Confirm" }).click(); }
    catch (error) {
      if (!error.dialog) throw error;
      dialog = error.dialog;
      await page.respondDialog({ accept: true });
    }
    await page.locator("#answer").waitFor({ state: "visible" });
    const raw = await page.cdp("Runtime.evaluate", {
      expression: "document.querySelector('#answer').textContent", returnByValue: true,
    });
    const result = {
      urlView, title: await page.title(), status: await status.innerText(),
      activity: await page.locator("#activity").innerText(),
      dialog: { type: dialog.type, message: dialog.message }, answer: raw.result.value,
    };
  `;
  const sandbox = await execute(`
    globalThis.page = await openPage(${JSON.stringify(surfaceId)});
    ${program}
    print(result);
    await page.screenshot();
  `);
  expect(sandbox).not.toHaveProperty("isError");
  const [output, image] = sandbox.content;
  expect(output?.type).toBe("text");
  if (output?.type !== "text") throw new Error("Missing browser journey output.");
  expect(JSON.parse(output.text)).toEqual({
    urlView: [
      origin,
      "/journey",
      "#ready",
      `${origin}/journey?source=repl&tag=first&tag=two+words#ready`,
      `${origin}/journey?source=repl&tag=first&tag=two+words#ready`,
      "repl",
      ["first", "two words"],
      [
        ["source", "repl"],
        ["tag", "first"],
        ["tag", "two words"],
      ],
      true,
      null,
    ],
    title: "Browser REPL fixture",
    status: "Submitted Ada Lovelace",
    activity: "trusted click",
    dialog: { type: "confirm", message: "Submit this form?" },
    answer: "Accepted",
  });
  expect(image).toMatchObject({
    type: "image",
    mimeType: "image/png",
    data: expect.stringMatching(/^iVBORw0KGgo/u),
  });

  // The program's address carries a fragment, so going to it again from the
  // same address is a same-document navigation that keeps this run's status.
  // Another address first gives the harness run a document of its own.
  expect(await execute(`await page.goto(${JSON.stringify(`${origin}/between-runs`)})`)).toEqual({
    content: [],
  });
  const harness = await native(`${program} console.log(JSON.stringify(result));`);
  expect(JSON.parse(harness.stdout)).toEqual(JSON.parse(output.text));

  expect(await execute('await page.getByRole("button", { name: "Open popup" }).click()')).toEqual({
    content: [],
  });
  await waitForLedgerState(ledger, () =>
    ledger
      .snapshot()
      .some((surface) => surface.openerId === surfaceId && surface.url === `${origin}/popup`),
  );
  expect(
    await execute(`
    const popup = (await pages()).find(tab => tab.url.endsWith("/popup"));
    const tab = await openPage(popup.tabId);
    await tab.getByText("Opened from the journey").waitFor({ state: "visible" });
    const fresh = await newPage(${JSON.stringify(origin + "/popup")});
    await fresh.getByText("Opened from the journey").waitFor({ state: "visible" });
    return [popup.profile, await tab.title(), await fresh.title()];
  `),
  ).toEqual({ content: [{ type: "text", text: '["Test profile","Popup","Popup"]' }] });
});
