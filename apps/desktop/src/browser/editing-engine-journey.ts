import { mkdtempSync } from "node:fs";
import { app } from "electron";
import { createServer } from "node:http";
import { once } from "node:events";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBrowserSessionId } from "@opensteer/protocol/browser";
import type { LaunchedBrowser } from "@opensteer/browser-runtime-core";
import { runEditingEngineJourney } from "@opensteer/browser-runtime-core/test-support/editing-engine";
import { ElectronBrowserLauncher } from "./electron-browser-launcher.js";
import { DesktopDownloads } from "../downloads/desktop-downloads.js";

const scratch = mkdtempSync(path.join(tmpdir(), "opensteer-editing-engine-"));
app.setPath("userData", path.join(scratch, "user-data"));
let finished = false;
app.on("before-quit", (event) => {
  if (!finished) event.preventDefault();
});
const evidence =
  process.env.OPENSTEER_EDITING_ENGINE_EVIDENCE_DIR ?? path.join(scratch, "evidence");
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(
    '<!doctype html><textarea id="t"></textarea><script>window.events=[];for(const type of ["keydown","beforeinput","input","compositionstart","compositionupdate","compositionend","copy","cut","paste"])document.addEventListener(type,e=>events.push({type,key:e.key,code:e.code,meta:e.metaKey,control:e.ctrlKey,shift:e.shiftKey,alt:e.altKey,inputType:e.inputType,trusted:e.isTrusted}));if(parent!==window)addEventListener("message",e=>{if(e.data==="alert")alert("frame")}),setInterval(()=>parent.postMessage({frame:{value:t.value,active:document.activeElement===t,hasFocus:document.hasFocus(),keys:events.filter(e=>e.type==="keydown").length}},"*"),100);t.focus()</script>',
  );
});
let browser: LaunchedBrowser | undefined;
let launcher: ElectronBrowserLauncher | undefined;
let downloads: DesktopDownloads | undefined;
let failure: unknown;
async function main(): Promise<void> {
  try {
    await mkdir(evidence, { recursive: true });
    await app.whenReady();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address.");
    downloads = new DesktopDownloads({
      directory: () => path.join(scratch, "downloads"),
      staging: path.join(scratch, "staging"),
    });
    launcher = new ElectronBrowserLauncher({
      downloads,
      pagePolicyPreloadPath:
        process.env.OPENSTEER_EDITING_PRELOAD ??
        path.resolve(path.dirname(process.argv[1]!), "browser-page-preload.cjs"),
    });
    const sessionId = createBrowserSessionId();
    browser = await launcher.launch({
      sessionId,
      partitionKey: `session:${sessionId}`,
      initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
      snapshot: { cookies: [], origins: [] },
    });
    await runEditingEngineJourney(browser, `http://127.0.0.1:${address.port}/`, evidence);
  } catch (error) {
    failure = error;
    console.error(error);
    await writeFile(
      path.join(evidence, "startup-or-journey-failure.json"),
      JSON.stringify({ passed: false, failure: String(error) }, null, 2),
    );
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      failure ??= error;
    }
    launcher?.close();
    try {
      await downloads?.close();
    } catch (error) {
      failure ??= error;
    }
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!evidence.startsWith(scratch + path.sep))
      await rm(scratch, { force: true, recursive: true });
    finished = true;
    app.exit(failure ? 1 : 0);
  }
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
