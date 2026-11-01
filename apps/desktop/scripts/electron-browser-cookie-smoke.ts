import { type BrowserCookie, browserCookieToCdp } from "@opensteer/browser-profile/cookies";
import { LocalProfileStore } from "@opensteer/browser-runtime-core";
import { runStateImportScenario } from "@opensteer/browser-runtime-core/test-support/state-import";
import { LocalProfileBindingSchema, createBrowserSessionId } from "@opensteer/protocol";
import { app } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElectronBrowserLauncher } from "../src/browser/electron-browser-launcher.js";
import { acquireElectronLocalProfile } from "../src/browser/electron-local-profile.js";
import { assertCookies } from "./test-support/native-profile-smoke.js";
import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
const root = await mkdtemp(path.join(tmpdir(), "native-cookie-proof-"));
const userData = path.join(root, "user-data");
await mkdir(userData);
app.setPath("userData", userData);
app.setPath("sessionData", userData);
app.commandLine.appendSwitch("headless");
app.commandLine.appendSwitch(
  "host-resolver-rules",
  "MAP example.test 127.0.0.1, MAP *.example.test 127.0.0.1",
);
app.on("window-all-closed", () => {});
const expires = Math.floor(Date.now() / 1000) + 3600;
const cookies: BrowserCookie[] = [
  {
    domain: "example.test",
    expires,
    hostOnly: true,
    httpOnly: true,
    name: "__Host-host-only",
    path: "/",
    sameSite: "Lax",
    secure: true,
    value: "host",
  },
  {
    domain: ".example.test",
    expires,
    hostOnly: false,
    httpOnly: false,
    name: "domain-wide",
    path: "/",
    sameSite: "Lax",
    secure: true,
    value: "domain",
  },
  {
    domain: "example.test",
    expires,
    hostOnly: true,
    httpOnly: false,
    name: "same-site-absent",
    path: "/",
    secure: true,
    value: "unspecified",
  },
  {
    domain: "example.test",
    expires,
    hostOnly: true,
    httpOnly: false,
    name: "partition-false",
    path: "/",
    partitionKey: "https://example.test",
    partitionKeyHasCrossSiteAncestor: false,
    sameSite: "None",
    secure: true,
    value: "false",
  },
  {
    domain: "example.test",
    expires,
    hostOnly: true,
    httpOnly: false,
    name: "partition-true",
    path: "/",
    partitionKey: "https://example.test",
    partitionKeyHasCrossSiteAncestor: true,
    sameSite: "None",
    secure: true,
    value: "true",
  },
  {
    domain: "embedded.test",
    expires,
    hostOnly: true,
    httpOnly: true,
    name: "third-party-partition",
    path: "/",
    partitionKey: "https://example.test",
    partitionKeyHasCrossSiteAncestor: true,
    sameSite: "None",
    secure: true,
    value: "embedded",
  },
  {
    domain: "example.test",
    expires: -1,
    hostOnly: true,
    httpOnly: true,
    name: "session-cookie",
    path: "/",
    sameSite: "Strict",
    secure: true,
    value: "session",
  },
];
let failed = false;
try {
  await app.whenReady();
  const nativeRoot = path.join(root, "profiles");
  const store = await LocalProfileStore.acquire(nativeRoot, "electron");
  const binding = LocalProfileBindingSchema.parse({
    version: 1,
    deploymentId: "dep_00000000-0000-4000-8000-000000000001",
    runnerId: "rnr_00000000-0000-4000-8000-000000000001",
    profileId: "bpr_00000000-0000-4000-8000-000000000001",
    bindingId: randomUUID(),
    storageInstanceId: store.storageInstanceId,
    engine: "electron",
  });
  const launcher = new ElectronBrowserLauncher({
    downloads: smokeDesktopDownloads(),
    localProfileRoot: nativeRoot,
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  });
  try {
    const directory = await store.provision(
      binding,
      false,
      (parent, signal) => launcher.localProfiles.createFiles(parent, binding, signal),
      new AbortController().signal,
    );
    const sessionId = createBrowserSessionId();
    const request = {
      sessionId,
      partitionKey: `profile:${binding.profileId}` as const,
      initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
      storage: { kind: "local" as const, binding, directory },
    };
    const browser = await launcher.launch(request);
    await browser.profile!.admit();
    const page = await browser.context.createPage();
    await (
      await page.cdp()
    ).send("Network.setCookies", { cookies: cookies.map(browserCookieToCdp) });
    await acquireElectronLocalProfile({
      root: nativeRoot,
      directory,
      binding,
      configure: () => {},
    }).mirror.flush();
    await assertCookies(browser, cookies);
    await browser.close();
    const reopened = await launcher.launch(request);
    await reopened.profile!.admit();
    await reopened.context.createPage();
    await assertCookies(reopened, cookies);
    await reopened.close();
  } finally {
    launcher.close();
    await store.close();
  }
  const importRoot = path.join(root, "imports");
  const importer = new ElectronBrowserLauncher({
    downloads: smokeDesktopDownloads(),
    localProfileRoot: importRoot,
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  });
  try {
    const report = await runStateImportScenario({
      engine: "electron",
      launcher: importer,
      nativeRoot: importRoot,
    });
    process.stdout.write(JSON.stringify(report) + "\n");
  } finally {
    importer.close();
  }
} catch (error) {
  failed = true;
  process.stderr.write(String(error) + "\n");
} finally {
  await rm(root, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}
