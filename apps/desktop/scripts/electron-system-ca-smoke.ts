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
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { encoding: "utf8" });
}

function fixtureCertificates(): {
  readonly fingerprint: string;
  readonly key: string;
  readonly cert: string;
} {
  const config = path.join(work, "openssl.cnf");
  writeFileSync(
    config,
    `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${commonName}\n[root]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n`,
  );
  const rootKey = path.join(work, "root.key");
  const leafKey = path.join(work, "leaf.key");
  const leafCsr = path.join(work, "leaf.csr");
  const leafPem = path.join(work, "leaf.pem");
  run("/usr/bin/openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    rootKey,
    "-out",
    rootPem,
    "-days",
    "2",
    "-config",
    config,
    "-extensions",
    "root",
  ]);
  run("/usr/bin/openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    leafKey,
    "-out",
    leafCsr,
    "-subj",
    "/CN=localhost",
    "-config",
    config,
  ]);
  run("/usr/bin/openssl", [
    "x509",
    "-req",
    "-in",
    leafCsr,
    "-CA",
    rootPem,
    "-CAkey",
    rootKey,
    "-CAcreateserial",
    "-out",
    leafPem,
    "-days",
    "2",
    "-extfile",
    config,
    "-extensions",
    "leaf",
  ]);
  const fingerprint = run("/usr/bin/openssl", [
    "x509",
    "-in",
    rootPem,
    "-noout",
    "-fingerprint",
    "-sha256",
  ])
    .trim()
    .split("=")[1]!;
  return { cert: readFileSync(leafPem, "utf8"), fingerprint, key: readFileSync(leafKey, "utf8") };
}

async function homeNode(
  node: string,
  environment: Record<string, string>,
  url: string,
  fingerprint: string,
) {
  const script = path.join(work, "probe.cjs");
  writeFileSync(script, probe);
  const child = spawn(node, ["--disable-sigusr1", script, url, fingerprint], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return JSON.parse(output.trim().split("\n").at(-1)!) as Record<string, unknown>;
}

async function utilityRunner(
  environment: Record<string, string>,
  url: string,
  fingerprint: string,
) {
  const script = path.join(work, "probe-utility.cjs");
  writeFileSync(script, probe);
  const child = utilityProcess.fork(script, [url, fingerprint], {
    env: environment,
    stdio: "ignore",
  });
  const line = await new Promise<string>((resolve) =>
    child.once("message", (value) => resolve(String(value))),
  );
  return JSON.parse(line) as Record<string, unknown>;
}

async function main(): Promise<void> {
  await app.whenReady();
  const release = await readPersonalRuntimeRelease(path.join(resources, "personal-runtime"));
  const fixture = fixtureCertificates();
  run("/usr/bin/sudo", [
    "/usr/bin/security",
    "add-trusted-cert",
    "-d",
    "-r",
    "trustRoot",
    "-k",
    "/Library/Keychains/System.keychain",
    rootPem,
  ]);
  const server = createServer({ cert: fixture.cert, key: fixture.key }, (_request, response) =>
    response.end("ok"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const rows: Record<string, unknown>[] = [];
  try {
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
  } finally {
    server.close();
    // Both the trust setting and the certificate go.
    execFileSync("/usr/bin/sudo", ["/usr/bin/security", "remove-trusted-cert", "-d", rootPem], {
      stdio: "ignore",
    });
    execFileSync(
      "/usr/bin/sudo",
      [
        "/usr/bin/security",
        "delete-certificate",
        "-c",
        commonName,
        "/Library/Keychains/System.keychain",
      ],
      { stdio: "ignore" },
    );
    rmSync(work, { force: true, recursive: true });
  }
  writeFileSync(
    path.join(artifacts, "system-ca.json"),
    `${JSON.stringify({ node: release.identity, rows }, null, 2)}\n`,
  );
  for (const row of rows) {
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
