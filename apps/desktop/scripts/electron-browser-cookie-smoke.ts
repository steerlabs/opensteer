import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
/**
 * Real Electron cookie round trip and live `state.import` sign-in in a
 * disposable, isolated userData directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "electron";
import type { BrowserProfileSnapshot } from "@opensteer/browser-profile";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import type { BrowserLaunchRequest } from "@opensteer/browser-runtime-core";
import { runStateImportScenario } from "@opensteer/browser-runtime-core/test-support/state-import";
import { ElectronBrowserLauncher } from "../src/browser/electron-browser-launcher.js";

const smokeDownloads = smokeDesktopDownloads();

const userData = mkdtempSync(path.join(tmpdir(), "opensteer-cookie-smoke-"));
app.setPath("userData", userData);
app.commandLine.appendSwitch("headless");
// The state.import scenario's HTTP fixture answers as *.example.test.
app.commandLine.appendSwitch(
  "host-resolver-rules",
  "MAP example.test 127.0.0.1, MAP *.example.test 127.0.0.1",
);
const liveness = setInterval(() => undefined, 1_000);
let finished = false;
app.on("before-quit", (event) => {
  if (!finished) event.preventDefault();
});

const expires = Math.floor(Date.now() / 1_000) + 3_600;
const snapshot: BrowserProfileSnapshot = {
  cookies: [
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
  ],
  origins: [],
};

void run().then(
  () => finish(null),
  (error: unknown) => finish(error),
);

async function run(): Promise<void> {
  await app.whenReady();
  const launcher = new ElectronBrowserLauncher({
    downloads: smokeDownloads,
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  });
  const request: BrowserLaunchRequest = {
    initialViewport: { devicePixelRatio: 1, height: 480, width: 640 },
    partitionKey: "profile:bpr_00000000-0000-4000-8000-000000000099",
    sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000099"),
    storage: { kind: "legacy", snapshot },
  };
  const first = await launcher.launch(request);
  const exported = await first.exportSnapshot();
  assertRoundTrip(exported, "first export");
  const isolated = await launcher.launch({
    ...request,
    partitionKey: "session:bsn_00000000-0000-4000-8000-000000000100",
    sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000100"),
    storage: { kind: "guest" },
  });
  if ((await isolated.exportSnapshot()).cookies.length !== 0)
    throw new Error("A fresh partition saw another profile's cookies");
  assertRoundTrip(await first.exportSnapshot(), "concurrent isolated export");
  await isolated.close();
  await first.close();
  const reopened = await launcher.launch({
    ...request,
    storage: { kind: "legacy", snapshot: exported },
  });
  const restored = await reopened.exportSnapshot();
  assertRoundTrip(restored, "reopened export");
  await reopened.close();

  const report = await runStateImportScenario({ engine: "electron", launcher });
  const artifactDirectory =
    process.env.OPENSTEER_STATE_IMPORT_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), "opensteer-state-import-e2e");
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    path.join(artifactDirectory, "electron.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

function assertRoundTrip(actual: BrowserProfileSnapshot, stage: string): void {
  const relevant = actual.cookies.filter((cookie) =>
    snapshot.cookies.some((expected) => expected.name === cookie.name),
  );
  if (relevant.length !== snapshot.cookies.length) {
    throw new Error(
      `${stage}: expected ${snapshot.cookies.length} synthetic cookies, got ${JSON.stringify(relevant)}`,
    );
  }
  for (const expected of snapshot.cookies) {
    const cookie = relevant.find((candidate) => candidate.name === expected.name);
    if (!cookie) throw new Error(`${stage}: missing ${expected.name}`);
    for (const field of [
      "domain",
      "expires",
      "hostOnly",
      "httpOnly",
      "sameSite",
      "partitionKey",
      "partitionKeyHasCrossSiteAncestor",
      "secure",
      "path",
      "value",
    ] as const) {
      if (cookie[field] !== expected[field]) {
        throw new Error(
          `${stage}: ${expected.name}.${field} expected ${String(expected[field])}, got ${String(cookie[field])}; cookie=${JSON.stringify(cookie)}`,
        );
      }
    }
  }
}

function finish(error: unknown): void {
  finished = true;
  clearInterval(liveness);
  rmSync(userData, { recursive: true, force: true });
  if (error) {
    process.stderr.write(
      `${JSON.stringify({ event: "electron-browser-cookie-smoke.failed", error: error instanceof Error ? error.stack : String(error) })}\n`,
    );
    app.exit(1);
  } else {
    process.stdout.write(`${JSON.stringify({ event: "electron-browser-cookie-smoke.passed" })}\n`);
    app.quit();
  }
}
