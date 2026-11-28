/**
 * What a Home and the desktop's own Runner trust, in the VM guest only.
 *
 * A fixture root is added to the guest's System keychain with an
 * administrator's trust setting and removed again at the end; an HTTPS server
 * answers under a certificate it signed. With the trust the app gives its
 * processes (`opensteer-node-trust.mjs`), and again with
 * `OPENSTEER_SYSTEM_CERTIFICATES=off`:
 * - the Personal runtime's own Node, the interpreter the app's Home runs on,
 *   started with the environment the Home is given, reaches that server;
 * - an Electron utility process, which is how the desktop's own Runner runs,
 *   lists the root among its authorities and reaches the server.
 * Turned off, both refuse. Each records how long its first TLS connection took.
 * Never run on a person's Mac: it changes the System keychain.
 */
import { app, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  nodeTrustEnvironment,
  nodeTrustSetting,
} from "../../../deploy/container/opensteer-node-trust.mjs";
import { readPersonalRuntimeRelease } from "../src/releases/personal-runtime-release.js";
import {
  generateSystemCaFixtureCertificates,
  runSystemCaSmokeLifecycle,
} from "./system-ca-smoke-support.js";
import { installSmokeGuard } from "./test-support/smoke-guard.js";

installSmokeGuard("system-ca", 180000);

const home = process.env.HOME ?? "";
if (!(home === "/Users/admin" && process.env.OPENSTEER_SYSTEM_CA_E2E_ARTIFACT_DIR)) {
  process.stderr.write("electron-system-ca-smoke changes the System keychain; run it in the VM.\n");
  process.exit(2);
}
const artifacts = path.resolve(z.string().parse(process.env.OPENSTEER_SYSTEM_CA_E2E_ARTIFACT_DIR));
const resources = path.resolve(z.string().parse(process.env.OPENSTEER_PERSONAL_E2E_RESOURCES));
const work = mkdtempSync(path.join(tmpdir(), "opensteer-system-ca-"));
const commonName = `Opensteer system CA fixture ${process.pid}`;
const rootPem = path.join(work, "root.pem");
const rootDer = path.join(work, "root.der");
const priorTrustPlist = path.join(work, "prior-trust.plist");

/** Probes a URL from inside whichever process runs it, and prints one JSON line. */
const probe = `
const tls = require("node:tls");
const https = require("node:https");
const { X509Certificate } = require("node:crypto");
const [url, fingerprint] = process.argv.slice(-2);
const started = performance.now();
const listed = tls.getCACertificates("default").some((pem) => new X509Certificate(pem).fingerprint256 === fingerprint);
const done = (result) => {
  const line = JSON.stringify({ ...result, listed, firstTlsMs: Math.round(performance.now() - started) });
  if (process.parentPort) process.parentPort.postMessage(line); else process.stdout.write(line + "\\n");
  setTimeout(() => process.exit(0), 50);
};
https.get(url, (response) => { response.resume(); done({ reached: response.statusCode === 200 }); })
  .on("error", (error) => done({ reached: false, error: error.code ?? error.message }));
`;

function fixtureCertificates(): {
  readonly fingerprint: string;
  readonly key: string;
  readonly cert: string;
} {
  return generateSystemCaFixtureCertificates({
    commonName,
    rootDer,
    rootPem,
    workDir: work,
  });
}

async function homeNode(
  node: string,
  environment: Record<string, string>,
  url: string,
  fingerprint: string,
): Promise<Record<string, unknown>> {
  const script = path.join(work, "probe.cjs");
  writeFileSync(script, probe);
  const child = spawn(node, ["--disable-sigusr1", script, url, fingerprint], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  const line = output.trim().split("\n").at(-1) ?? "";
  if (exit.code !== 0 || !line) {
    throw new Error(
      `home-node probe failed (code=${String(exit.code)}, signal=${String(exit.signal)}): ${stderr.trim() || output.trim() || "no output"}`,
    );
  }
  return JSON.parse(line) as Record<string, unknown>;
}

async function utilityRunner(
  environment: Record<string, string>,
  url: string,
  fingerprint: string,
): Promise<Record<string, unknown>> {
  const script = path.join(work, "probe-utility.cjs");
  writeFileSync(script, probe);
  const child = utilityProcess.fork(script, [url, fingerprint], {
    env: environment,
    stdio: "pipe",
  });
  let stderr = "";
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `utility-runner probe timed out after 30s${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        ),
      );
    }, 30_000);
    child.once("message", (value) => {
      clearTimeout(timer);
      resolve(String(value));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `utility-runner exited before posting (code=${String(code)}): ${stderr.trim() || stdout.trim() || "no output"}`,
        ),
      );
    });
  });
  return JSON.parse(line) as Record<string, unknown>;
}

async function main(): Promise<void> {
  await app.whenReady();
  const release = await readPersonalRuntimeRelease(path.join(resources, "personal-runtime"));
  const fixture = fixtureCertificates();
  const server = createServer({ cert: fixture.cert, key: fixture.key }, (_request, response) =>
    response.end("ok"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  const report = await runSystemCaSmokeLifecycle({
    artifactsDir: artifacts,
    closeServer: () => server.close(),
    commonName,
    fingerprint: fixture.fingerprint,
    nodeIdentity: release.identity,
    priorTrustPlist,
    rootDer,
    rootPem,
    workDir: work,
    runProbes: async (rows) => {
      for (const setting of ["on", "off"] as const) {
        const environment = nodeTrustEnvironment(
          { HOME: home, PATH: "/usr/bin:/bin" },
          {
            environmentInputs: "drop",
            settings: setting === "off" ? { [nodeTrustSetting]: "off" } : {},
          },
        );
        rows.push({
          process: "home-node",
          setting,
          ...(await homeNode(release.entrypoints.node, environment, url, fixture.fingerprint)),
        });
        rows.push({
          process: "utility-runner",
          setting,
          ...(await utilityRunner(environment, url, fixture.fingerprint)),
        });
      }
    },
    verifyCleanupProbe: async () => {
      const environment = nodeTrustEnvironment(
        { HOME: home, PATH: "/usr/bin:/bin" },
        { environmentInputs: "drop", settings: {} },
      );
      return {
        process: "home-node",
        setting: "on",
        ...(await homeNode(release.entrypoints.node, environment, url, fixture.fingerprint)),
      };
    },
  });

  for (const row of report.rows) {
    if (row.setting === "on") {
      assert.equal(
        row.reached,
        true,
        `${String(row.process)} did not reach the server: ${String(row.error)}`,
      );
      assert.equal(row.listed, true, `${String(row.process)} did not list the fixture root`);
    } else {
      assert.equal(
        row.reached,
        false,
        `${String(row.process)} reached the server with the switch off`,
      );
      assert.equal(
        row.listed,
        false,
        `${String(row.process)} listed the fixture root with the switch off`,
      );
    }
  }
}

void main().then(
  () => {
    process.stdout.write("electron-system-ca-smoke.passed\n");
    app.exit(0);
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    app.exit(1);
  },
);
