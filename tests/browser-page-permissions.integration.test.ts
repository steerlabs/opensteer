import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { expect, it, vi } from "vitest";
import { journey } from "./browser-pool-journey.test-support.js";

/**
 * What page script gets in the Home's own Chromium without a person, on each way the Home
 * launches it: a guest browser (a browser server and a fresh context) and a saved profile (a
 * persistent context). The page is focused, as an agent can emulate, and each request runs with a
 * fresh user gesture, as after an agent's synthesized click. A request that never answers counts
 * as getting nothing; the external scheme is a random one no application on this computer handles.
 */
const settle = `const settle = (work) => Promise.race([
  Promise.resolve().then(work).then((value) => "granted:" + String(value), (error) => "refused:" + (error && error.name)),
  new Promise((resolve) => setTimeout(() => resolve("pending"), 1500)),
]);`;

const media = (constraints: string) => `(async () => {
  const stream = await navigator.mediaDevices.getUserMedia(${constraints});
  stream.getTracks().forEach((track) => track.stop());
  return stream.getTracks().length;
})()`;

const requests: Readonly<Record<string, string>> = {
  camera: media("{ video: true }"),
  microphone: media("{ audio: true }"),
  location: `new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition((position) => resolve(position.coords.latitude), (error) => reject({ name: "code" + error.code }), { timeout: 1000 }))`,
  notifications: `Notification.requestPermission().then((answer) => { if (answer !== "granted") throw { name: answer }; return answer; })`,
  clipboardRead: `navigator.clipboard.readText()`,
  clipboardWrite: `navigator.clipboard.writeText("opensteer-g8").then(() => "written")`,
  usb: `navigator.usb ? navigator.usb.requestDevice({ filters: [] }) : Promise.reject({ name: "absent" })`,
  filePicker: `window.showOpenFilePicker ? window.showOpenFilePicker() : Promise.reject({ name: "absent" })`,
};

/** Last: in headless Chromium a port request with focus and a gesture stops its page answering. */
const serial = `navigator.serial ? navigator.serial.requestPort() : Promise.reject({ name: "absent" })`;

const externalScheme = (scheme: string) => `(async () => {
  const before = location.href;
  const link = document.createElement("a");
  link.href = ${JSON.stringify(`${scheme}://probe`)};
  document.body.append(link);
  link.click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  return location.href === before ? "stayed" : "navigated:" + location.href;
})()`;

/** Nothing granted: a denial, an absent API or no answer at all. */
const nothing = /^(refused:|pending$)/u;

async function probeLaunch(path: "guest" | "profile") {
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Permissions</title><body>probe</body>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const j = await journey(`page-permissions-${path}`, { profile: path === "profile" });
  try {
    const home = await j.startHome();
    if (path === "profile")
      await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    else await home.service.openTab(j.task.userId, j.command("page-permissions"));
    const page = j.launched()!.context.pages().at(-1)!;
    const cdp = await page.cdp();
    await cdp.send("Page.navigate", { url: `${origin}/` });
    await vi.waitFor(async () => {
      const state = await cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
        expression: "location.origin + ' ' + document.readyState",
        returnByValue: true,
      });
      expect(state.result.value).toBe(`${origin} complete`);
    });
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const pagesBefore = j.launched()!.context.pages().length;
    // A page that stops answering gave its script nothing either.
    const evaluate = (expression: string) =>
      withTimeout(
        cdp
          .send<{ result: { value: string } }>("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            userGesture: true,
            returnByValue: true,
          })
          .then(({ result }) => result.value),
        4_000,
        { timeoutError: () => new Error("pending") },
      ).catch((error: unknown) => {
        if (error instanceof Error && error.message === "pending") return "pending";
        throw error;
      });
    const seen: Record<string, string> = {};
    for (const [name, request] of Object.entries(requests))
      seen[name] = await evaluate(`(() => { ${settle} return settle(() => ${request}); })()`);
    seen.externalScheme = await evaluate(
      externalScheme(`opensteer-g8-${randomUUID().slice(0, 8)}`),
    );
    seen.serial = await evaluate(`(() => { ${settle} return settle(() => ${serial}); })()`);
    return { seen, newPages: j.launched()!.context.pages().length - pagesBefore };
  } finally {
    await j.close();
    site.close();
  }
}

for (const path of ["guest", "profile"] as const)
  it(`gives page script no device, clipboard read, file picker or external app without a person (${path} launch)`, async () => {
    const { seen, newPages } = await probeLaunch(path);
    const { clipboardWrite, externalScheme: external, ...asked } = seen;
    for (const [name, answer] of Object.entries(asked))
      expect(answer, `${name}: ${JSON.stringify(seen)}`).toMatch(nothing);
    expect(external, JSON.stringify(seen)).toBe("stayed");
    expect(newPages).toBe(0);
    // Reported, not decided: with focus and a gesture, page script writes this browser's own
    // clipboard, as any page can when it is clicked.
    expect(clipboardWrite, JSON.stringify(seen)).toBe("granted:written");
  });
