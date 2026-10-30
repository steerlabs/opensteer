import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
/**
 * Runs both the default absent policy and the test-only provider in a disposable
 * VM, with independent relying-party verification and isolated browser sessions.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import {
  passkeyProviderCertificate,
  untrustedCert,
} from "@opensteer/browser-runtime-core/test-support/passkey-provider";
import { app, session as electronSession } from "electron";
import type { BrowserLauncher } from "@opensteer/browser-runtime-core";
import {
  PasskeyProviderTestAuthenticator,
  passkeyProviderChromiumArguments,
  runPasskeyProviderScenario,
  runPasskeyCertificateErrorScenario,
} from "@opensteer/browser-runtime-core/test-support/passkey-provider";
import { runPasskeyPolicyScenario } from "@opensteer/browser-runtime-core/test-support/passkey-policy";
import {
  ElectronBrowserLauncher,
  electronBrowserPartition,
} from "../src/browser/electron-browser-launcher.js";

const smokeDownloads = smokeDesktopDownloads();

const userData = mkdtempSync(path.join(tmpdir(), "opensteer-passkey-smoke-"));
app.setPath("userData", userData);
app.commandLine.appendSwitch("headless");
for (const argument of passkeyProviderChromiumArguments) {
  const separator = argument.indexOf("=");
  if (separator < 0) app.commandLine.appendSwitch(argument.slice(2));
  else app.commandLine.appendSwitch(argument.slice(2, separator), argument.slice(separator + 1));
}
// This fixture-only override models proceeding through a certificate warning.
// Chromium must still report the certificate error to the bridge.
app.on("certificate-error", (event, _contents, url, _error, certificate, callback) => {
  const matches =
    new URL(url).hostname === "untrusted.example.test" &&
    new X509Certificate(certificate.data).fingerprint256 ===
      new X509Certificate(untrustedCert).fingerprint256;
  if (matches) event.preventDefault();
  callback(matches);
});
const liveness = setInterval(() => undefined, 1_000);
let finished = false;
app.on("before-quit", (event) => {
  if (!finished) event.preventDefault();
});

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
  const report = await runPasskeyPolicyScenario({ engine: "electron", launcher });
  const authenticator = new PasskeyProviderTestAuthenticator();
  const engine = new ElectronBrowserLauncher({
    authenticator,
    downloads: smokeDownloads,
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  });
  const trustedFixture: BrowserLauncher = {
    launch(request) {
      const profile = electronSession.fromPartition(
        electronBrowserPartition(request.partitionKey),
        { cache: true },
      );
      profile.setCertificateVerifyProc((verification, callback) => {
        const matches =
          ["rp.example.test", "other.example.test"].includes(verification.hostname) &&
          new X509Certificate(verification.certificate.data).fingerprint256 ===
            new X509Certificate(passkeyProviderCertificate).fingerprint256;
        callback(matches ? 0 : -3);
      });
      return engine.launch(request);
    },
  };
  const provider = await runPasskeyProviderScenario({
    authenticator,
    launcher: trustedFixture,
  });
  const certificate = await runPasskeyCertificateErrorScenario({
    authenticator,
    launcher: trustedFixture,
  });
  const artifactDirectory =
    process.env.OPENSTEER_PASSKEY_POLICY_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), "opensteer-passkey-policy-e2e");
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    path.join(artifactDirectory, "electron.json"),
    `${JSON.stringify({ policy: report, provider, certificate }, null, 2)}\n`,
  );
}

function finish(error: unknown): void {
  finished = true;
  clearInterval(liveness);
  rmSync(userData, { recursive: true, force: true });
  if (error) {
    process.stderr.write(
      `${JSON.stringify({ event: "electron-browser-passkey-smoke.failed", error: error instanceof Error ? error.stack : String(error) })}\n`,
    );
    app.exit(1);
  } else {
    process.stdout.write(`${JSON.stringify({ event: "electron-browser-passkey-smoke.passed" })}\n`);
    app.quit();
  }
}
