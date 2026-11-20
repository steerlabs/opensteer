import { once } from "node:events";
import { createServer } from "node:http";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { expect, it } from "vitest";
import { z } from "zod";
import { BrowserReplService } from "../../../host/src/browser-use/browser-repl-service.js";
import { browserTestSignal, cleanup, waitForLedgerState } from "./browser-test-lifecycle.js";
import { rootCdpNavigate } from "./chromium.test-support.js";
import { startActionJourney } from "./harness-actions.test-support.js";

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
    await new Promise((resolve) => server.close(() => resolve()));
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
  const openPage = async (tabId) => {
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
  const port = {
    listPages: async () =>
      ledger.snapshot().map(({ id, url, title }) => ({
        tabId: id,
        url,
        title,
        profile: "Test profile",
      })),
    openPage,
    newPage: async ({ url }, { signal }) => {
      const created = await ledger.openSurface({ signal, origin: "agent", activate: false });
      await rootCdpNavigate(ledger, created.id, url);
      return openPage(created.id);
    },
    command: async (target, method, parameters, attached) => {
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
        return {};
      }
      return router.send(sessionId, command);
    },
    subscribe: (target, listener) =>
      router.onEvent(sessionId, ({ method, parameters, sessionId: attached }) => {
        if (attached && router.attachedTargetId(sessionId, attached) === target.targetId)
          listener({ method, params: parameters, sessionId: attached });
      }),
  };
  const service = new BrowserReplService({ port });
  cleanup.push(() => service.close());
  const execute = (code) => service.execute("chromium", code, browserTestSignal());
  const program = `
    await page.goto(${JSON.stringify(origin + "/journey?source=repl")});
    await page.waitForURL(url => url.pathname === "/journey" && url.searchParams.get("source") === "repl");
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
      title: await page.title(), status: await status.innerText(),
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
