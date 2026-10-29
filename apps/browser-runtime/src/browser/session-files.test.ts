import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BrowserServerMessage } from "@opensteer/protocol";
import { BrowserRuntime, stageFileMethod } from "@opensteer/browser-runtime-core";
import {
  FakeProfileStateClient,
  FakeSink,
  FakeTicketVerifier,
  validClaims,
} from "@opensteer/browser-runtime-core/test-support";
import { delay } from "@opensteer/shared/delay";
import {
  TestChromiumLauncher as PlaywrightChromiumLauncher,
  findChromium,
  browserTestSignal,
  cleanup,
  waitForBrowserState,
  withBrowserTestSignal,
} from "./browser-test-lifecycle.js";

/**
 * End to end through a real Chromium: files staged over the session's own CDP
 * channel reach real pages through a file input, a file chooser, and a drop,
 * byte for byte; every path outside the session's folder is refused; and a
 * profile in use saves its changed state on the interval, not only at close.
 * The run writes a JSON report to the system temporary directory.
 */
const executablePath = findChromium();

describe("Browser Session files and profile saving in real Chromium", () => {
  it(
    "delivers staged files to inputs, choosers and drops, refuses other paths, and saves profile state while in use",
    { timeout: 60_000 },
    async () => {
      const report: Record<string, unknown> = { chromium: executablePath };
      const server = await uploadPage();
      cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

      const scratch = await mkdtemp(path.join(tmpdir(), "opensteer-session-files-e2e-"));
      cleanup.push(() => rm(scratch, { force: true, recursive: true }));
      const filesRoot = path.join(scratch, "runtime-files");
      const photo = path.join(scratch, "mattress photo.png");
      const second = path.join(scratch, "receipt.pdf");
      await writeFile(photo, randomBytes(2_424_653));
      await writeFile(second, randomBytes(70_001));

      const state = new FakeProfileStateClient();
      const claims = validClaims();
      const runtime = new BrowserRuntime({
        checkpointIntervalMs: 1_000,
        launcher: new PlaywrightChromiumLauncher({
          chromiumSandbox: false,
          executablePath,
          headless: true,
        }),
        profileStateClient: state,
        runtimeId: "runtime_test",
        sessionFilesRoot: filesRoot,
        ticketVerifier: new FakeTicketVerifier(claims),
      });
      cleanup.push(() => runtime.shutdown());
      const sink = new FakeSink();
      const attachment = await runtime.attach("ticket", sink);
      const cdp = cdpClient(sink, (frame) => attachment.handle(frame));

      const { targetInfos } = (await cdp.send("Target.getTargets")) as {
        targetInfos: Array<{ targetId: string; type: string }>;
      };
      const pageTarget = targetInfos.find((target) => target.type === "page");
      if (!pageTarget) throw new Error("No page target");
      const { sessionId: page } = (await cdp.send("Target.attachToTarget", {
        flatten: true,
        targetId: pageTarget.targetId,
      })) as { sessionId: string };
      await cdp.send("Page.enable", {}, page);
      await cdp.send("Page.navigate", { url: `${origin}/upload` }, page);
      await waitFor(async () => (await evaluate(cdp, page, "document.readyState")) === "complete");

      // Staging: chunks cross the CDP channel and land beside the session.
      const stagedPhoto = await stage(cdp, photo);
      const stagedSecond = await stage(cdp, second);
      expect(stagedPhoto.startsWith(path.join(filesRoot, claims.sessionId) + path.sep)).toBe(true);
      expect(path.basename(stagedPhoto)).toBe("mattress photo.png");
      report.staged = [stagedPhoto, stagedSecond];

      // A file input, as a page's own <input type=file>.
      await setFiles(cdp, page, "#single", [stagedPhoto]);
      await setFiles(cdp, page, "#multi", [stagedPhoto, stagedSecond]);
      // A button that opens a chooser for a hidden input.
      await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, page);
      const box = (await evaluate(
        cdp,
        page,
        "(() => { const r = document.querySelector('#choose').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
      )) as { x: number; y: number };
      const chooser = cdp.nextEvent("Page.fileChooserOpened", page);
      await cdp.send(
        "Input.dispatchMouseEvent",
        { button: "left", clickCount: 1, type: "mousePressed", ...box },
        page,
      );
      await cdp.send(
        "Input.dispatchMouseEvent",
        { button: "left", clickCount: 1, type: "mouseReleased", ...box },
        page,
      );
      const opened = (await chooser) as { backendNodeId: number; mode: string };
      await cdp.send(
        "DOM.setFileInputFiles",
        { backendNodeId: opened.backendNodeId, files: [stagedPhoto] },
        page,
      );
      await cdp.send("Page.setInterceptFileChooserDialog", { enabled: false }, page);
      // A drop zone that reads dataTransfer.files.
      const drop = (await evaluate(
        cdp,
        page,
        "(() => { const r = document.querySelector('#drop').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
      )) as { x: number; y: number };
      const dragData = { dragOperationsMask: 1, files: [stagedSecond], items: [] };
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await cdp.send("Input.dispatchDragEvent", { data: dragData, type, ...drop }, page);
      }

      await waitFor(async () => {
        const received = (await evaluate(cdp, page, "window.received")) as Record<string, unknown>;
        return ["single", "multi", "hidden", "drop"].every((key) => key in received);
      });
      const received = (await evaluate(cdp, page, "window.received")) as Record<
        string,
        { files: Array<{ name: string; sha256: string; size: number }>; trusted?: boolean }
      >;
      const expected = {
        photo: { name: "mattress photo.png", sha256: await sha256(photo), size: 2_424_653 },
        second: { name: "receipt.pdf", sha256: await sha256(second), size: 70_001 },
      };
      expect(received.single).toMatchObject({ files: [expected.photo], trusted: true });
      expect(received.multi).toMatchObject({
        files: [expected.photo, expected.second],
        trusted: true,
      });
      expect(received.hidden).toMatchObject({ files: [expected.photo], trusted: true });
      expect(received.drop).toMatchObject({ files: [expected.second] });
      report.received = received;

      // Every other path, and every other way to name one, is refused.
      const refusals: Record<string, string> = {};
      const refuse = async (label: string, method: string, parameters: object, on?: string) => {
        const error = await cdp.send(method, parameters, on).then(
          () => null,
          (failure: Error) => failure,
        );
        expect(error, label).toBeInstanceOf(Error);
        refusals[label] = (error as Error).message;
      };
      await refuse(
        "outside file",
        "DOM.setFileInputFiles",
        { files: ["/etc/hosts"], nodeId: 1 },
        page,
      );
      await refuse(
        "traversal",
        "DOM.setFileInputFiles",
        { files: [path.join(filesRoot, claims.sessionId, "..", "escape.txt")], nodeId: 1 },
        page,
      );
      await refuse(
        "sibling prefix",
        "DOM.setFileInputFiles",
        { files: [`${path.join(filesRoot, claims.sessionId)}-other/x.txt`], nodeId: 1 },
        page,
      );
      await refuse(
        "drag outside file",
        "Input.dispatchDragEvent",
        {
          data: { dragOperationsMask: 1, files: ["/etc/hosts"], items: [] },
          type: "drop",
          x: 1,
          y: 1,
        },
        page,
      );
      await refuse(
        "retired chooser answer",
        "Page.handleFileChooser",
        { action: "accept", files: [] },
        page,
      );
      await refuse(
        "page downloads",
        "Browser.setDownloadBehavior",
        { behavior: "allow", downloadPath: "/tmp" },
        page,
      );
      await refuse("browser downloads", "Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: "/tmp",
      });
      await refuse(stageFileMethod, stageFileMethod, {
        data: "",
        fileId: "escape",
        name: "../escape.txt",
        offset: 0,
        size: 0,
      });
      await refuse(`${stageFileMethod} out of order`, stageFileMethod, {
        data: "aGVsbG8=",
        fileId: "gap",
        name: "gap.txt",
        offset: 5,
      });
      await refuse(`${stageFileMethod} short`, stageFileMethod, {
        data: "aGVsbG8=",
        fileId: "short",
        name: "short.txt",
        offset: 0,
        size: 6,
      });
      expect(refusals["outside file"]).toMatch(/staged for this Browser Session/u);
      report.refusals = refusals;

      // A profile in use saves changed state on the interval and skips unchanged state.
      const commitsBefore = state.commits.length;
      await evaluate(cdp, page, "document.cookie = 'listing=draft; max-age=3600; path=/'");
      await waitFor(async () => state.commits.length > commitsBefore, 10_000);
      const saved = state.commits.at(-1)?.snapshot;
      expect(saved?.cookies.some((cookie) => cookie.name === "listing")).toBe(true);
      const afterChange = state.commits.length;
      await delay(2_500, browserTestSignal());
      expect(state.commits.length).toBe(afterChange);
      report.checkpoints = { afterChange, unchangedAfterTwoIntervals: state.commits.length };

      // Ending the session removes its files and saves a final revision.
      await attachment.close();
      expect(existsSync(path.join(filesRoot, claims.sessionId))).toBe(false);
      expect(await readdir(filesRoot)).toEqual([]);
      expect(state.commits.length).toBe(afterChange + 1);

      const reportPath = path.join(tmpdir(), `opensteer-session-files-e2e-${Date.now()}.json`);
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`session files E2E report: ${reportPath}\n`);
    },
  );
});

interface CdpClient {
  nextEvent(method: string, sessionId: string): Promise<unknown>;
  send(method: string, parameters?: object, sessionId?: string): Promise<unknown>;
}

/** Speaks to a runtime attachment exactly as the Host's broker does. */
function cdpClient(sink: FakeSink, handle: (frame: string) => Promise<void>): CdpClient {
  const signal = browserTestSignal();
  const answered = new Map<string, (message: BrowserServerMessage) => void>();
  const eventWaiters: Array<{
    readonly method: string;
    readonly resolve: (parameters: unknown) => void;
    readonly sessionId: string;
  }> = [];
  const original = sink.sendServer.bind(sink);
  sink.sendServer = async (message) => {
    await original(message);
    if ((message.type === "cdp.result" || message.type === "cdp.error") && message.requestId) {
      answered.get(message.requestId)?.(message);
    }
    if (message.type === "cdp.event") {
      const index = eventWaiters.findIndex(
        (waiter) =>
          waiter.method === message.event.method && waiter.sessionId === message.event.sessionId,
      );
      if (index >= 0) eventWaiters.splice(index, 1)[0]?.resolve(message.event.parameters);
    }
  };
  return {
    nextEvent: (method, sessionId) => {
      let waiter: (typeof eventWaiters)[number];
      const waiting = new Promise<unknown>((resolve) => {
        waiter = { method, resolve, sessionId };
        eventWaiters.push(waiter);
      });
      return withBrowserTestSignal(waiting, signal).finally(() => {
        const index = eventWaiters.indexOf(waiter);
        if (index >= 0) eventWaiters.splice(index, 1);
      });
    },
    send: (method, parameters, sessionId) => {
      const requestId = randomUUID();
      const { promise: reply, resolve, reject } = Promise.withResolvers<unknown>();
      answered.set(requestId, (message) => {
        answered.delete(requestId);
        if (message.type === "cdp.error") reject(new Error(message.error.message));
        else if (message.type === "cdp.result") resolve(message.result);
      });
      void handle(
        JSON.stringify({
          command: {
            method,
            ...(parameters ? { parameters } : {}),
            ...(sessionId ? { sessionId } : {}),
          },
          requestId,
          type: "cdp.command",
        }),
      ).catch(reject);
      return withBrowserTestSignal(reply, signal).finally(() => answered.delete(requestId));
    },
  };
}

async function stage(cdp: CdpClient, file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(file);
  const fileId = randomUUID();
  const chunk = 256 * 1_024;
  for (let offset = 0; ; offset += chunk) {
    const part = bytes.subarray(offset, offset + chunk);
    const last = offset + part.byteLength >= bytes.byteLength;
    const result = (await cdp.send(stageFileMethod, {
      data: part.toString("base64"),
      fileId,
      name: path.basename(file),
      offset,
      ...(last ? { size: bytes.byteLength } : {}),
    })) as { path?: string };
    if (last) {
      if (!result.path) throw new Error("Staging returned no path");
      return result.path;
    }
  }
}

async function setFiles(
  cdp: CdpClient,
  page: string,
  selector: string,
  files: readonly string[],
): Promise<void> {
  const found = (await cdp.send(
    "Runtime.evaluate",
    { expression: `document.querySelector(${JSON.stringify(selector)})` },
    page,
  )) as { result: { objectId?: string } };
  if (!found.result.objectId) throw new Error(`${selector} not found`);
  await cdp.send("DOM.setFileInputFiles", { files, objectId: found.result.objectId }, page);
}

async function evaluate(cdp: CdpClient, page: string, expression: string): Promise<unknown> {
  const response = (await cdp.send(
    "Runtime.evaluate",
    { awaitPromise: true, expression, returnByValue: true },
    page,
  )) as { result: { value?: unknown } };
  return response.result.value;
}

async function sha256(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

const waitFor = (predicate: () => Promise<boolean>, timeoutMs = 15_000) =>
  waitForBrowserState(predicate, timeoutMs);

async function uploadPage(): Promise<Server> {
  const html = `<!doctype html><meta charset="utf-8"><title>Upload</title>
<input id="single" type="file">
<input id="multi" type="file" multiple>
<input id="hidden" type="file" style="display:none">
<button id="choose" style="position:absolute;left:20px;top:120px;width:200px;height:40px">Add photos</button>
<div id="drop" style="position:absolute;left:20px;top:200px;width:300px;height:150px;border:1px solid #888">Drop files</div>
<script>
window.received = {};
async function digest(file) {
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return { name: file.name, size: file.size, sha256: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("") };
}
for (const id of ["single", "multi", "hidden"]) {
  document.getElementById(id).addEventListener("change", async (event) => {
    window.received[id] = { trusted: event.isTrusted, files: await Promise.all([...event.target.files].map(digest)) };
  });
}
document.getElementById("choose").addEventListener("click", () => document.getElementById("hidden").click());
const drop = document.getElementById("drop");
drop.addEventListener("dragover", (event) => event.preventDefault());
drop.addEventListener("drop", async (event) => {
  event.preventDefault();
  window.received.drop = { files: await Promise.all([...event.dataTransfer.files].map(digest)) };
});
</script>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
