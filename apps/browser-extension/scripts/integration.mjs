/**
 * End-to-end check of the built extension in a real MV3 service worker, in a
 * throwaway Chromium profile, against a synthetic Opensteer that signs with
 * the real deployment-authority formats. Every cookie and credential is fake.
 *
 * Ways this could fail, each covered below:
 *  1. A web page cannot detect the extension (probe not web-accessible, key → ID drift).
 *  2. The connect page cannot be opened from a web page, or loses its fragment.
 *  3. A framed connect page pairs (clickjacking), or a page that is not one of the
 *     invitation's own Opensteer addresses opens it and gets a Connect button.
 *  4. The one-use invitation stays in the tab's address or history.
 *  5. A tampered or expired link spends the pairing code.
 *  6. Pairing dials an unreachable or impostor address instead of the first live match,
 *     or sends the code to a squatter replaying the public discovery document
 *     without signing a fresh pair challenge.
 *  7. The token leaves before the Host proves its identity, or a proof for another
 *     route generation is accepted.
 *  8. Export leaks cookies outside the site: sibling private-suffix subdomains, other
 *     partitions, secure cookies to an http site, lookalike domains, public suffixes,
 *     loopback, or the site of a connected Opensteer itself.
 *  9. Export drops in-scope cookies: host-only subdomains, partitioned cookies.
 * 10. Stopped sites still export, including when stopped during the cookie read.
 * 11. The daily budget of new sites is ignored, spent by inspect or by a repeat share.
 * 12. Chrome's own site-access setting is ignored.
 * 13. Inspect leaks values; no-state and available are confused.
 * 14. The first share has no notification, or repeats notify again; a share whose
 *     socket was replaced during the read is still recorded.
 * 15. Reconnecting creates a duplicate instead of sending `replaces`, loses the
 *     person's sharing choices, or sends `replaces` to another Deployment.
 * 16. Connecting while already healthy leaves Opensteer waiting instead of pairing
 *     again with `replaces`.
 * 17. A pre-proof `source-unauthorized` or unsigned `route-changed` ends the
 *     connection; proven refusals keep retrying; a signed pre-proof
 *     `route-changed` is ignored.
 * 18. The popup shows the wrong state, jargon, or no fix, or offers an older
 *     Opensteer's extension as an "update".
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";
import {
  browserSourceChallengeBytes,
  browserSourceInvitationSigningBytes,
  browserSourcePairChallengeBytes,
  browserSourceRouteChangedBytes,
  encodeBrowserSourceInvitation,
  hostApiVersion,
  hostDiscoverySigningBytes,
  personalHostAccessRouteSigningBytes,
} from "@opensteer/deployment-authority";
import {
  browserSourceProtocolVersion,
  opensteerChromeExtensionId,
} from "@opensteer/protocol/browser-sources";

const builtExtension = fileURLToPath(new URL("../dist/", import.meta.url));
const screenshotDirectory = process.env.OPENSTEER_EXTENSION_SCREENSHOTS ?? null;
const reportPath =
  process.env.OPENSTEER_EXTENSION_REPORT ??
  path.join(tmpdir(), `opensteer-browser-extension-e2e-${process.pid}.json`);
await rm(reportPath, { force: true });
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });

const profile = await mkdtemp(path.join(tmpdir(), "opensteer-extension-test-"));
const extensionDirectory = path.join(profile, "extension");
await cp(builtExtension, extensionDirectory, { recursive: true });
const certificatePath = path.join(profile, "remote.crt");
const privateKeyPath = path.join(profile, "remote.key");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    privateKeyPath,
    "-out",
    certificatePath,
    "-subj",
    "/CN=remote.opensteer.test",
    "-addext",
    "subjectAltName=DNS:remote.opensteer.test",
  ],
  { stdio: "ignore" },
);

// ---- Synthetic Opensteer ----

const hostKey = generateKeyPairSync("ed25519");
const impostorKey = generateKeyPairSync("ed25519");
const remoteHost = "remote.opensteer.test";
const routeGeneration = 7;
const deploymentName = "Home";
const spki = (key) => key.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const signed = (bytes, key = hostKey) => sign(null, bytes, key.privateKey).toString("base64url");

const host = {
  // impostor: another identity; squatter: replays this Deployment's public
  // discovery document but cannot sign; other: a different, honest Deployment.
  loopbackMode: "down", // "down" | "impostor" | "squatter" | "other" | "up"
  remoteDown: false,
  // One-shot modes reset to "valid" after answering one challenge.
  proofMode: "valid", // "valid" | "wrong-generation" | "pre-proof-unauthorized" | "route-changed-unsigned" | "route-changed-forged" | "route-changed-signed"
  validCodes: new Set(),
  pairChallenges: [],
  pairRequests: [],
  sources: new Map(),
  frames: [],
  clients: new Map(),
  disconnected: [],
};
let loopbackOrigin;
let remoteOrigin;

function discoveryDocument() {
  return {
    canonicalOrigin: loopbackOrigin,
    deploymentId: "dep_11111111-1111-4111-8111-111111111111",
    hostInstanceId: "hst_22222222-2222-4222-8222-222222222222",
    hostKey: { algorithm: "Ed25519" },
    deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
  };
}

function authority(key = hostKey) {
  const document = discoveryDocument();
  return {
    document,
    publicKey: { algorithm: "Ed25519", spki: spki(key) },
    signature: signed(hostDiscoverySigningBytes(document), key),
  };
}

function route() {
  const document = {
    authority: discoveryDocument(),
    documentVersion: 2,
    purpose: "opensteer-personal-access-route",
    route: { generation: routeGeneration, kind: "private", origin: remoteOrigin },
  };
  return {
    document,
    publicKey: { algorithm: "Ed25519", spki: spki(hostKey) },
    schemaVersion: 1,
    signature: signed(personalHostAccessRouteSigningBytes(document)),
  };
}

function invitation({
  order = "loopback-first",
  expiresInMs = 15 * 60_000,
  key = hostKey,
  name = deploymentName,
} = {}) {
  const code = `code-${randomBytes(24).toString("base64url")}`;
  host.validCodes.add(code);
  const loopback = { origin: loopbackOrigin, route: null };
  const remote = { origin: remoteOrigin, route: route() };
  const document = {
    version: 2,
    destinations:
      order === "loopback-only"
        ? [loopback]
        : order === "loopback-first"
          ? [loopback, remote]
          : [remote, loopback],
    deploymentName: name,
    code,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    authority: authority(key),
  };
  return {
    code,
    text: encodeBrowserSourceInvitation({
      ...document,
      signature: signed(browserSourceInvitationSigningBytes(document), key),
    }),
  };
}

/** The key the Deployment answering on `origin` holds, and the one its discovery document shows. */
function keysAt(origin) {
  if (origin !== loopbackOrigin) return { discovery: hostKey, signing: hostKey };
  if (host.loopbackMode === "squatter") return { discovery: hostKey, signing: impostorKey };
  if (host.loopbackMode === "impostor" || host.loopbackMode === "other") {
    return { discovery: impostorKey, signing: impostorKey };
  }
  return { discovery: hostKey, signing: hostKey };
}

function readJson(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(JSON.parse(body)));
  });
}

function hostRequest(origin, request, response) {
  if (origin === loopbackOrigin && host.loopbackMode === "down") {
    request.socket.destroy();
    return;
  }
  if (origin === remoteOrigin && host.remoteDown) {
    request.socket.destroy();
    return;
  }
  if (request.url === "/.well-known/opensteer" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        apiVersion: hostApiVersion,
        authority: authority(keysAt(origin).discovery),
        bootstrapMethods: ["pairing-code"],
        capabilities: [],
      }),
    );
    return;
  }
  if (request.url === "/internal/v1/browser-sources/pair/challenge" && request.method === "POST") {
    void readJson(request).then((payload) => {
      host.pairChallenges.push({ ...payload, dialed: origin, at: host.pairRequests.length });
      const signature = signed(
        browserSourcePairChallengeBytes({
          nonce: payload.nonce,
          origin: payload.origin,
          routeGeneration: payload.routeGeneration,
        }),
        keysAt(origin).signing,
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ signature }));
    });
    return;
  }
  if (request.url === "/internal/v1/browser-sources/pair" && request.method === "POST") {
    void readJson(request).then((payload) => {
      host.pairRequests.push({ ...payload, dialed: origin });
      const refuse = (reason) => {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "bad_request", reason, message: reason } }));
      };
      if (!host.validCodes.delete(payload.code)) return refuse("code");
      if (payload.origin !== origin) return refuse("origin");
      if (payload.routeGeneration !== (origin === remoteOrigin ? routeGeneration : null)) {
        return refuse("route");
      }
      if (payload.version !== browserSourceProtocolVersion) return refuse("unsupported-version");
      if (payload.replaces) {
        const old = host.sources.get(payload.replaces.sourceId);
        if (!old || old.token !== payload.replaces.token) return refuse("replaces");
        old.revoked = true;
      }
      const sourceId = `bsr_${randomUUID()}`;
      const token = randomBytes(32).toString("base64url");
      host.sources.set(sourceId, {
        name: payload.name,
        origin,
        routeGeneration: payload.routeGeneration,
        token,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sourceId, token }));
    });
    return;
  }
  if (request.url === "/app") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><title>Opensteer</title><button id="connect">Connect Chrome</button>`,
    );
    return;
  }
  response.writeHead(404).end();
}

function acceptSocket(origin, client) {
  const log = { origin, sourceId: null, messages: [] };
  host.frames.push(log);
  client.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    log.messages.push(message.type);
    if (message.type === "source.challenge") {
      log.sourceId = message.sourceId;
      assert.equal(message.origin, origin);
      if (host.proofMode === "pre-proof-unauthorized") {
        host.proofMode = "valid";
        client.send(JSON.stringify({ type: "source.error", code: "source-unauthorized" }));
        return;
      }
      if (host.proofMode.startsWith("route-changed-")) {
        const mode = host.proofMode;
        host.proofMode = "valid";
        const bytes = browserSourceRouteChangedBytes({
          nonce: message.nonce,
          origin,
          routeGeneration: message.routeGeneration,
          sourceId: message.sourceId,
        });
        client.send(
          JSON.stringify({
            type: "source.error",
            code: "route-changed",
            ...(mode === "route-changed-unsigned"
              ? {}
              : {
                  signature: signed(bytes, mode === "route-changed-forged" ? impostorKey : hostKey),
                }),
          }),
        );
        return;
      }
      const generation =
        host.proofMode === "wrong-generation"
          ? routeGeneration + 1
          : origin === remoteOrigin
            ? routeGeneration
            : null;
      const signature = signed(
        browserSourceChallengeBytes({
          nonce: message.nonce,
          origin,
          routeGeneration: generation,
          sourceId: message.sourceId,
        }),
        keysAt(origin).signing,
      );
      client.send(JSON.stringify({ type: "source.proof", nonce: message.nonce, signature }));
      return;
    }
    if (message.type === "source.hello") {
      const source = host.sources.get(message.sourceId);
      if (!source || source.revoked || source.token !== message.token) {
        client.send(JSON.stringify({ type: "source.error", code: "source-unauthorized" }));
        return;
      }
      host.clients.set(message.sourceId, client);
      client.send(JSON.stringify({ type: "source.ready", sourceId: message.sourceId }));
      return;
    }
    if (message.type === "source.disconnect") {
      const source = host.sources.get(log.sourceId);
      if (source) source.revoked = true;
      host.disconnected.push(log.sourceId);
      client.close(1000, "Disconnected");
      return;
    }
    const resolve = host.pending.get(message.operationId);
    if (resolve) {
      host.pending.delete(message.operationId);
      resolve(message);
    }
  });
}
host.pending = new Map();

const loopbackServer = createHttpServer((request, response) =>
  hostRequest(loopbackOrigin, request, response),
);
const remoteServer = createHttpsServer(
  { cert: await readFile(certificatePath), key: await readFile(privateKeyPath) },
  (request, response) => hostRequest(remoteOrigin, request, response),
);
const sockets = new WebSocketServer({ noServer: true });
for (const [server, origin] of [
  [loopbackServer, () => loopbackOrigin],
  [remoteServer, () => remoteOrigin],
]) {
  server.on("upgrade", (request, socket, head) => {
    const down =
      (origin() === loopbackOrigin && !["up", "other"].includes(host.loopbackMode)) ||
      (origin() === remoteOrigin && host.remoteDown);
    if (request.url !== "/internal/v1/browser-sources/connect" || down) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => acceptSocket(origin(), client));
  });
}
await new Promise((resolve) => loopbackServer.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => remoteServer.listen(0, "127.0.0.1", resolve));
loopbackOrigin = `http://127.0.0.1:${loopbackServer.address().port}`;
remoteOrigin = `https://${remoteHost}:${remoteServer.address().port}`;

// ---- Helpers ----

async function waitUntil(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function operation(sourceId, type, site) {
  const client = host.clients.get(sourceId);
  assert.ok(client, `no live connection for ${sourceId}`);
  const operationId = randomUUID();
  const reply = new Promise((resolve) => host.pending.set(operationId, resolve));
  client.send(JSON.stringify({ type, operationId, site }));
  let timer;
  return await Promise.race([
    reply,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${type} ${site}`)), 15_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function exported(sourceId, site) {
  const reply = await operation(sourceId, "source.export", site);
  return reply.result.status === "exported"
    ? reply.result.snapshot.cookies.map((cookie) => cookie.name).sort()
    : reply.result.status;
}

const checks = [];
function passed(check) {
  checks.push(check);
  console.log(`  ok  ${check}`);
}

let context;
const shots = [];
async function shoot(page, name, selector = null) {
  if (!screenshotDirectory) return;
  const file = path.join(screenshotDirectory, `${name}.png`);
  if (selector) await page.locator(selector).screenshot({ path: file, animations: "disabled" });
  else await page.screenshot({ path: file, animations: "disabled" });
  shots.push(file);
}

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
    viewport: { width: 760, height: 720 },
    args: [
      "--ignore-certificate-errors",
      `--host-resolver-rules=MAP ${remoteHost} 127.0.0.1`,
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  worker.on("console", (message) => console.error("worker:", message.text()));
  const extensionId = new URL(worker.url()).host;
  assert.equal(extensionId, opensteerChromeExtensionId);
  passed("manifest key loads as the ID Opensteer pages look for");
  const extensionUrl = (file) => `chrome-extension://${extensionId}/${file}`;
  const storage = () => worker.evaluate(() => chrome.storage.local.get(null));
  const connections = async () => (await storage()).connections ?? [];

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 340, height: 600 });
  const openPopup = async () => {
    await popup.goto(extensionUrl("popup.html"));
    await popup.locator("#popup[aria-busy='false']").waitFor();
  };
  await openPopup();
  await popup.getByText("In Opensteer, open Settings → Chrome").waitFor();
  await shoot(popup, "popup-not-connected", "body");
  passed("popup explains how to connect when nothing is connected");

  // 1-4: detection, framing, handoff.
  const app = await context.newPage();
  await app.goto(`${remoteOrigin}/app`);
  const probe = (file) =>
    app.evaluate(
      (url) =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () => resolve(true);
          image.onerror = () => resolve(false);
          image.src = url;
        }),
      extensionUrl(file),
    );
  assert.equal(await probe("icons/probe.png"), true);
  assert.equal(await probe("icons/icon-16.png"), false);
  passed("web page detects the extension through probe.png and nothing else");

  const framed = invitation();
  await app.evaluate(
    (url) => {
      const frame = document.createElement("iframe");
      frame.src = url;
      document.body.append(frame);
    },
    `${extensionUrl("connect.html")}#${framed.text}`,
  );
  await waitUntil(
    () => app.frames().some((frame) => frame.url().startsWith(extensionUrl("connect.html"))),
    "framed connect page",
  );
  const frame = app.frames().find((item) => item.url().startsWith(extensionUrl("connect.html")));
  await frame.getByRole("heading", { name: "Open this page on its own" }).waitFor();
  assert.equal(await frame.locator("#form").isHidden(), true);
  assert.equal(host.pairRequests.length, 0);
  passed("framed connect page refuses and never pairs");

  /** Opens the connect page the way Opensteer does: window.open from one of its own pages. */
  const openConnect = async (opener, text) => {
    // Chrome records the active tab as the opener, as when a person clicks there.
    await opener.bringToFront();
    await opener.evaluate(
      ({ url }) => {
        document.querySelector("#connect").onclick = () => window.open(url, "_blank");
      },
      { url: `${extensionUrl("connect.html")}#${encodeURIComponent(text)}` },
    );
    const [page] = await Promise.all([context.waitForEvent("page"), opener.click("#connect")]);
    await page.setViewportSize({ width: 760, height: 640 });
    return page;
  };
  const hostOf = (origin) => new URL(origin).host;
  const connectHeading = (origin) => `Connect Chrome to Opensteer at ${hostOf(origin)}`;
  const challengedBeforePairing = (request) =>
    host.pairChallenges.some(
      (challenge) =>
        challenge.dialed === request.dialed &&
        challenge.at === host.pairRequests.indexOf(request) &&
        challenge.origin === request.origin,
    );

  // 3: pages that are not the invitation's own Opensteer get no Connect button.
  host.loopbackMode = "squatter";
  const orphan = invitation();
  // Chrome records the active tab as a new tab's opener; make it a non-Opensteer page.
  await popup.bringToFront();
  const orphanPage = await context.newPage();
  await orphanPage.setViewportSize({ width: 760, height: 640 });
  await orphanPage.goto(`${extensionUrl("connect.html")}#${orphan.text}`);
  await orphanPage.getByRole("heading", { name: "Open this from Opensteer" }).waitFor();
  assert.equal(await orphanPage.locator("#form").isHidden(), true);
  await sleep(300);
  await shoot(orphanPage, "connect-error-not-from-opensteer");
  await orphanPage.close();
  const foreign = await context.newPage();
  await foreign.goto(`${loopbackOrigin.replace("127.0.0.1", "localhost")}/app`);
  const foreignPage = await openConnect(foreign, orphan.text);
  await foreignPage.getByRole("heading", { name: "Open this from Opensteer" }).waitFor();
  assert.equal(await foreignPage.locator("#form").isHidden(), true);
  await foreignPage.close();
  await foreign.close();
  assert.equal(host.pairRequests.length, 0);
  assert.equal(host.pairChallenges.length, 0);
  passed("a page not opened from one of the link's Opensteer addresses refuses to connect");

  // 6: a squatter on loopback replays the public discovery document but cannot
  // sign a fresh challenge, so the signed remote route is chosen.
  const first = invitation();
  const connectPage = await openConnect(app, first.text);
  await connectPage.getByRole("heading", { name: connectHeading(remoteOrigin) }).waitFor();
  assert.equal(new URL(connectPage.url()).hash, "");
  assert.equal(
    await connectPage.evaluate(() => location.href.includes("opensteer-browser-source")),
    false,
  );
  passed("window.open handoff carries the link in the fragment, which the page strips");
  assert.match(await connectPage.locator("#deployment").textContent(), /Home$/u);
  assert.match(await connectPage.locator("#name").inputValue(), /^Chrome on /u);
  passed("the connect page leads with the Opensteer address; the name is secondary");
  await sleep(450);
  await shoot(connectPage, "connect-idle");

  const closed = connectPage.waitForEvent("close", { timeout: 15_000 });
  await connectPage.locator("#name").fill("Chrome on Test Mac");
  await connectPage.locator("#name").press("Enter");
  await connectPage.getByRole("heading", { name: "Connected" }).waitFor();
  await sleep(600);
  await shoot(connectPage, "connect-success");
  await closed;
  passed("Enter connects, shows Connected, and the tab closes itself");
  assert.equal(host.pairRequests.length, 1);
  assert.equal(host.pairRequests[0].dialed, remoteOrigin);
  assert.equal(host.pairRequests[0].routeGeneration, routeGeneration);
  assert.equal(host.pairRequests[0].replaces, null);
  assert.equal(host.pairRequests[0].name, "Chrome on Test Mac");
  assert.ok(host.pairChallenges.some((challenge) => challenge.dialed === loopbackOrigin));
  assert.ok(challengedBeforePairing(host.pairRequests[0]));
  passed(
    "pairing challenges each address, skips a loopback squatter that cannot sign, and pairs over the signed remote route",
  );
  let [connection] = await connections();
  let sourceId = connection.sourceId;
  const firstFrames = host.frames.filter((log) => log.sourceId === sourceId);
  assert.deepEqual(firstFrames.at(-1).messages.slice(0, 2), ["source.challenge", "source.hello"]);
  passed("the token is sent only after the signed challenge is answered");

  // 5: expired, tampered and unreachable links.
  const errorPage = await context.newPage();
  await errorPage.setViewportSize({ width: 760, height: 640 });
  const expired = invitation({ expiresInMs: -1_000 });
  await errorPage.goto(`${extensionUrl("connect.html")}#${expired.text}`);
  await errorPage.getByRole("heading", { name: "This link expired" }).waitFor();
  assert.match(
    await errorPage.locator("#body").textContent(),
    /Go back to Opensteer and choose Connect Chrome again\./u,
  );
  await sleep(300);
  await shoot(errorPage, "connect-error-expired");
  const tamperedSource = invitation();
  const tampered = JSON.parse(
    Buffer.from(tamperedSource.text.split(":")[1], "base64url").toString("utf8"),
  );
  tampered.deploymentName = "Not Home";
  await errorPage.goto(
    `${extensionUrl("connect.html")}#opensteer-browser-source:${Buffer.from(JSON.stringify(tampered)).toString("base64url")}`,
  );
  await errorPage.getByRole("heading", { name: "This link doesn't work" }).waitFor();
  assert.equal(host.pairRequests.length, 1);
  passed("expired and tampered links explain the fix and never spend a code");

  // 16: a second link while healthy pairs again, replacing the live connection,
  // so the Opensteer page that opened it sees a new connection.
  const again = invitation();
  const healthyToken = (await connections())[0].token;
  const againPage = await openConnect(app, again.text);
  await againPage
    .locator("#note", { hasText: "This replaces this Chrome's earlier connection" })
    .waitFor();
  const againClosed = againPage.waitForEvent("close", { timeout: 15_000 });
  await againPage.getByRole("button", { name: "Connect" }).click();
  await againClosed;
  assert.equal(host.pairRequests.length, 2);
  assert.deepEqual(host.pairRequests[1].replaces, { sourceId, token: healthyToken });
  assert.ok(challengedBeforePairing(host.pairRequests[1]));
  assert.equal(host.sources.get(sourceId).revoked, true);
  [connection] = await connections();
  assert.equal((await connections()).length, 1);
  assert.notEqual(connection.sourceId, sourceId);
  sourceId = connection.sourceId;
  await waitUntil(() => host.clients.get(sourceId)?.readyState === 1, "replacement connected");
  passed("connecting while healthy pairs again with replaces and closes the tab");

  // An honest Opensteer that is not the one this link names.
  host.remoteDown = true;
  host.loopbackMode = "impostor";
  const mismatchPage = await openConnect(app, invitation().text);
  await mismatchPage
    .getByRole("heading", { name: "This isn't the Opensteer that sent you" })
    .waitFor();
  await mismatchPage.close();
  assert.equal(host.pairRequests.length, 2);
  passed("an address answering with another identity is refused without pairing");

  host.loopbackMode = "down";
  const unreachable = invitation();
  // The live connection must be offline first, or the page reports Already connected.
  host.clients.get(sourceId)?.terminate();
  await waitUntil(
    async () =>
      (await errorPage.evaluate(() => chrome.runtime.sendMessage({ type: "ui.status" }))).value
        .connections[0].state === "offline",
    "offline after the remote route drops",
  );
  await openPopup();
  await popup.getByText("Offline — Chrome keeps trying").waitFor();
  await shoot(popup, "popup-offline", "body");
  passed("popup shows Offline with the fix while Opensteer is unreachable");
  const unreachablePage = await openConnect(app, unreachable.text);
  await unreachablePage
    .getByRole("heading", { name: `Chrome can't reach ${deploymentName}` })
    .waitFor();
  await unreachablePage.getByRole("button", { name: "Try again" }).waitFor();
  await sleep(300);
  await shoot(unreachablePage, "connect-error-unreachable");
  await unreachablePage.close();
  assert.equal(host.pairRequests.length, 2);
  passed("unreachable Opensteer shows Try again");
  // A person clicks Try now in the popup in front of them. A tab left behind
  // the connect page renders no frames, so the click could not settle until
  // Chrome's own retry, which Opensteer coming back lets succeed, removed it.
  await popup.bringToFront();
  const tryNow = popup.getByRole("button", { name: "Try now" });
  await tryNow.waitFor();
  host.remoteDown = false;
  await tryNow.click();
  await popup.getByText("Connected", { exact: true }).waitFor();
  passed("Try now reconnects from the popup");

  // 8-9, 13-14: export scope, inspect and the first-share notification.
  // A value no stored token or id can contain by chance: storage and inspect
  // results are searched for it, and random base64url sometimes spells "v1".
  const rootHostValue = "root-host-cookie-value-never-stored";
  await context.addCookies([
    { name: "root-host", value: rootHostValue, url: "https://example.com/", secure: true },
    { name: "parent", value: "v2", domain: ".example.com", path: "/account", secure: true },
    { name: "sub-host", value: "v3", url: "https://app.example.com/" },
    {
      name: "part-in",
      value: "v4",
      domain: "app.example.com",
      path: "/",
      secure: true,
      sameSite: "None",
      partitionKey: "https://example.com",
    },
    {
      name: "part-out",
      value: "v5",
      domain: "app.example.com",
      path: "/",
      secure: true,
      sameSite: "None",
      partitionKey: "https://other.test",
    },
    { name: "lookalike", value: "v6", url: "https://notexample.com/" },
    { name: "alice", value: "v7", url: "https://alice.github.io/" },
    { name: "bob", value: "v8", url: "https://bob.github.io/" },
    { name: "plain-net", value: "v9", url: "http://example.net/" },
    { name: "secure-net", value: "v10", domain: "example.net", path: "/", secure: true },
    { name: "loopback-ip", value: "v11", url: "http://127.0.0.1/" },
    { name: "loopback-name", value: "v12", url: "http://localhost/" },
    { name: "opensteer-own", value: "v13", url: `https://${remoteHost}/` },
    { name: "suffix", value: "v14", domain: "github.io", path: "/" },
  ]);
  await worker.evaluate(async () => {
    for (const id of Object.keys(await chrome.notifications.getAll())) {
      await chrome.notifications.clear(id);
    }
  });
  const inspect = await operation(sourceId, "source.inspect", "https://example.com");
  assert.equal(inspect.status, "available");
  assert.equal(JSON.stringify(inspect).includes(rootHostValue), false);
  assert.deepEqual(Object.keys(await worker.evaluate(() => chrome.notifications.getAll())), []);
  assert.deepEqual((await connections())[0].sharedSites, {});
  passed("inspect reports available without values, sharing, or notifying");

  const example = await operation(sourceId, "source.export", "https://example.com");
  assert.equal(example.result.status, "exported");
  assert.deepEqual(example.result.snapshot.cookies.map((cookie) => cookie.name).sort(), [
    "parent",
    "part-in",
    "root-host",
    "sub-host",
  ]);
  const partIn = example.result.snapshot.cookies.find((cookie) => cookie.name === "part-in");
  assert.equal(partIn.partitionKey, "https://example.com");
  assert.equal(typeof partIn.partitionKeyHasCrossSiteAncestor, "boolean");
  passed("export keeps host-only subdomain, parent and same-site partitioned cookies only");
  assert.deepEqual(await exported(sourceId, "https://alice.github.io"), ["alice"]);
  passed("a private-suffix site never exports its sibling's cookies");
  assert.deepEqual(await exported(sourceId, "http://example.net"), ["plain-net"]);
  passed("an http site never receives secure cookies");
  for (const site of [
    "http://127.0.0.1",
    "http://localhost",
    "http://app.localhost",
    "https://opensteer.test",
    "http://opensteer.test",
    "https://github.io",
  ]) {
    assert.equal(await exported(sourceId, site), "unsupported", site);
    assert.equal((await operation(sourceId, "source.inspect", site)).status, "unsupported", site);
  }
  passed(
    "loopback, a public suffix and the connected Opensteer's own site are never inspected or shared",
  );
  assert.equal(await exported(sourceId, "https://example.org"), "no-state");
  assert.equal(
    (await operation(sourceId, "source.inspect", "https://example.org")).status,
    "no-state",
  );
  passed("a site without cookies is no-state and is not recorded as shared");
  assert.equal(await exported(sourceId, "https://www.example.org"), "unsupported");
  passed("a scope that is not a registrable site is refused");

  const notificationIds = Object.keys(await worker.evaluate(() => chrome.notifications.getAll()));
  assert.deepEqual(notificationIds.sort(), [
    `share\n${sourceId}\nhttp://example.net`,
    `share\n${sourceId}\nhttps://alice.github.io`,
    `share\n${sourceId}\nhttps://example.com`,
  ]);
  await worker.evaluate(async () => {
    for (const id of Object.keys(await chrome.notifications.getAll())) {
      await chrome.notifications.clear(id);
    }
  });
  assert.equal(
    (await operation(sourceId, "source.export", "https://example.com")).result.status,
    "exported",
  );
  assert.deepEqual(Object.keys(await worker.evaluate(() => chrome.notifications.getAll())), []);
  passed("each first share notifies once; sharing again stays quiet");
  assert.equal(JSON.stringify(await storage()).includes(rootHostValue), false);
  passed("storage keeps sites and times, never cookie values");

  // L5: the socket is replaced while cookies are read; nothing may be recorded.
  await context.addCookies([{ name: "late", value: "x", url: "https://late.test/" }]);
  const hookRead = () =>
    worker.evaluate(() => {
      const original = chrome.cookies.getAll;
      globalThis.__readStarted = false;
      chrome.cookies.getAll = async function (details) {
        globalThis.__readStarted = true;
        await new Promise((resolve) => (globalThis.__releaseRead = resolve));
        chrome.cookies.getAll = original;
        return original.call(chrome.cookies, details);
      };
    });
  const sharesBefore = (await connections())[0].newShares.length;
  await hookRead();
  const dropped = host.clients.get(sourceId);
  dropped.send(
    JSON.stringify({ type: "source.export", operationId: randomUUID(), site: "https://late.test" }),
  );
  await waitUntil(
    () => worker.evaluate(() => globalThis.__readStarted),
    "late cookie read started",
  );
  dropped.terminate();
  await waitUntil(
    () => host.clients.get(sourceId) !== dropped && host.clients.get(sourceId)?.readyState === 1,
    "reconnect after the socket dropped mid-read",
  );
  await worker.evaluate(() => globalThis.__releaseRead());
  await sleep(500);
  const afterDrop = (await connections())[0];
  assert.equal(afterDrop.sharedSites["https://late.test"], undefined);
  assert.equal(afterDrop.newShares.length, sharesBefore);
  assert.deepEqual(Object.keys(await worker.evaluate(() => chrome.notifications.getAll())), []);
  passed("a share whose socket was replaced during the read is not recorded or notified");

  await openPopup();
  await popup.getByText("example.com", { exact: true }).waitFor();
  await shoot(popup, "popup-connected-sites", "body");

  // 10: stop sharing, including during an in-flight read.
  await popup.getByRole("button", { name: "Stop sharing example.com" }).click();
  await popup.getByRole("button", { name: "Share example.com again" }).waitFor();
  assert.equal(await exported(sourceId, "https://example.com"), "stopped");
  assert.equal(
    (await operation(sourceId, "source.inspect", "https://example.com")).status,
    "stopped",
  );
  await popup.getByRole("button", { name: "Share example.com again" }).click();
  await popup.getByRole("button", { name: "Stop sharing example.com" }).waitFor();
  assert.equal(
    (await operation(sourceId, "source.export", "https://example.com")).result.status,
    "exported",
  );
  passed("Stop sharing blocks export and inspect; Share again restores it");
  await hookRead();
  const inFlight = operation(sourceId, "source.export", "https://example.com");
  await waitUntil(() => worker.evaluate(() => globalThis.__readStarted), "cookie read started");
  await popup.getByRole("button", { name: "Stop sharing example.com" }).click();
  await popup.getByRole("button", { name: "Share example.com again" }).waitFor();
  await worker.evaluate(() => globalThis.__releaseRead());
  assert.equal((await inFlight).result.status, "stopped");
  passed("stopping during a cookie read still refuses that export");
  await popup.getByRole("button", { name: "Share example.com again" }).click();
  await popup.getByRole("button", { name: "Stop sharing example.com" }).waitFor();

  // 11: rolling budget of 20 new sites.
  const budgetSites = Array.from({ length: 18 }, (_, index) => `https://budget${index + 1}.com`);
  await context.addCookies(
    budgetSites.map((site, index) => ({ name: `b${index}`, value: "x", url: `${site}/` })),
  );
  for (const site of budgetSites.slice(0, 17)) {
    assert.equal((await operation(sourceId, "source.export", site)).result.status, "exported");
  }
  assert.equal((await connections())[0].newShares.length, 20);
  const overBudget = budgetSites[17];
  assert.equal((await operation(sourceId, "source.inspect", overBudget)).status, "limit");
  assert.equal(await exported(sourceId, overBudget), "limit");
  assert.equal(
    (await operation(sourceId, "source.export", "https://example.com")).result.status,
    "exported",
  );
  passed("the 21st new site in a day is limited; already shared sites keep working");
  await openPopup();
  await popup.getByRole("button", { name: "Allow more today" }).waitFor();
  await shoot(popup, "popup-budget", "body");
  await popup.getByRole("button", { name: "Allow more today" }).click();
  await popup.getByRole("button", { name: "Allow more today" }).waitFor({ state: "detached" });
  assert.equal((await operation(sourceId, "source.export", overBudget)).result.status, "exported");
  passed("Allow more today lets new sites share again");

  // 12: Chrome's own site access withheld for a site.
  const settings = await context.newPage();
  await settings.goto("chrome://extensions");
  const setAccess = (hostAccess, hosts = []) =>
    settings.evaluate(
      async ({ id, hostAccess, hosts }) => {
        await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, hostAccess });
        for (const pattern of hosts) await chrome.developerPrivate.addHostPermission(id, pattern);
      },
      { id: extensionId, hostAccess, hosts },
    );
  await setAccess("ON_SPECIFIC_SITES", ["https://example.com/*", `https://${remoteHost}/*`]);
  assert.equal(
    (await operation(sourceId, "source.inspect", "https://alice.github.io")).status,
    "chrome-blocked",
  );
  assert.equal(await exported(sourceId, "https://alice.github.io"), "chrome-blocked");
  assert.equal(
    (await operation(sourceId, "source.export", "https://example.com")).result.status,
    "exported",
  );
  await setAccess("ON_ALL_SITES");
  assert.equal(
    (await operation(sourceId, "source.inspect", "https://alice.github.io")).status,
    "available",
  );
  await settings.close();
  passed("Chrome's Site access setting is honoured as chrome-blocked");

  // 7, 17: wrong proof, pre-proof refusal, then the proven refusals.
  host.proofMode = "wrong-generation";
  const framesBefore = host.frames.length;
  host.clients.get(sourceId).terminate();
  await waitUntil(() => host.frames.length > framesBefore, "reconnect attempt");
  await waitUntil(
    () => host.frames.at(-1).messages.includes("source.challenge"),
    "challenge after reconnect",
  );
  await sleep(300);
  assert.deepEqual(host.frames.at(-1).messages, ["source.challenge"]);
  passed("a proof signed for another route generation is refused before the token is sent");
  host.proofMode = "pre-proof-unauthorized";
  await waitUntil(() => host.proofMode === "valid", "pre-proof refusal sent", 30_000);
  await waitUntil(
    async () => {
      const [item] = await connections();
      return (
        !item.ended &&
        host.clients.get(sourceId)?.readyState === 1 &&
        host.frames.at(-1).messages.includes("source.hello")
      );
    },
    "reconnect after a pre-proof refusal",
    30_000,
  );
  passed("an unproven source-unauthorized does not end the connection");

  const status = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: "ui.status" }));
  host.clients
    .get(sourceId)
    .send(
      JSON.stringify({ type: "source.error", code: "unsupported-version", supportedVersion: 99 }),
    );
  await waitUntil(
    async () => (await status()).value.connections[0].state === "update-required",
    "update needed",
  );
  assert.equal((await connections())[0].blockedVersion, browserSourceProtocolVersion);
  let framesNow = host.frames.length;
  await sleep(2_500);
  assert.equal(host.frames.length, framesNow);
  await openPopup();
  await popup.getByText("Extension update needed").waitFor();
  await popup.getByText("Update the Opensteer extension: download it from Home").waitFor();
  await popup.getByRole("link", { name: "Download update" }).waitFor();
  await shoot(popup, "popup-extension-outdated", "body");
  await popup.getByRole("button", { name: "Try again" }).click();
  await popup.getByText("Connected", { exact: true }).waitFor();
  passed("a newer Opensteer asks to update the extension from it, until Try again");

  host.clients.get(sourceId).send(
    JSON.stringify({
      type: "source.error",
      code: "unsupported-version",
      supportedVersion: browserSourceProtocolVersion - 1,
    }),
  );
  await waitUntil(
    async () => (await status()).value.connections[0].state === "host-outdated",
    "Opensteer update needed",
  );
  assert.equal((await connections())[0].hostOutdated, true);
  framesNow = host.frames.length;
  await sleep(2_500);
  assert.equal(host.frames.length, framesNow);
  await openPopup();
  await popup.getByText("Opensteer update needed").waitFor();
  await popup.getByText("This Opensteer needs an update").waitFor();
  assert.equal(await popup.getByRole("link", { name: "Download update" }).count(), 0);
  await shoot(popup, "popup-opensteer-outdated", "body");
  await popup.getByRole("button", { name: "Try again" }).click();
  await popup.getByText("Connected", { exact: true }).waitFor();
  passed("an older Opensteer asks for an Opensteer update and never offers its extension");

  // A Host that moved says so before its proof; only its signature makes that count.
  const refuseBeforeProof = async (mode) => {
    host.proofMode = mode;
    const live = host.clients.get(sourceId);
    live.terminate();
    await waitUntil(() => host.proofMode === "valid", `${mode} sent`, 30_000);
  };
  for (const mode of ["route-changed-unsigned", "route-changed-forged"]) {
    await refuseBeforeProof(mode);
    await waitUntil(
      async () =>
        !(await connections())[0].routeChanged &&
        host.clients.get(sourceId)?.readyState === 1 &&
        host.frames.at(-1).messages.includes("source.hello"),
      `reconnect after ${mode}`,
      30_000,
    );
  }
  passed("an unsigned or wrongly signed route change before the proof is ignored");
  await refuseBeforeProof("route-changed-signed");
  await waitUntil(
    async () => (await status()).value.connections[0].state === "route-changed",
    "route changed",
  );
  assert.equal((await connections())[0].routeChanged, true);
  assert.deepEqual(host.frames.at(-1).messages, ["source.challenge"]);
  await openPopup();
  await popup.getByText("Reconnect needed").waitFor();
  framesNow = host.frames.length;
  await sleep(2_500);
  assert.equal(host.frames.length, framesNow);
  passed("a signed route change before the proof stops retrying and asks to reconnect");

  // 15: reconnecting sends replaces and keeps the person's choices. Loopback is
  // up and listed second: it still wins.
  host.loopbackMode = "up";
  await popup.getByRole("button", { name: "Stop sharing alice.github.io" }).click();
  await popup.getByRole("button", { name: "Share alice.github.io again" }).waitFor();
  const oldToken = (await connections())[0].token;
  const reconnect = invitation({ order: "remote-first" });
  const reconnectPage = await openConnect(app, reconnect.text);
  await reconnectPage
    .locator("#note", { hasText: "This replaces this Chrome's earlier connection" })
    .waitFor();
  assert.equal(await reconnectPage.locator("#name").inputValue(), "Chrome on Test Mac");
  await reconnectPage.getByRole("heading", { name: connectHeading(loopbackOrigin) }).waitFor();
  await shoot(reconnectPage, "connect-reconnect");
  const reconnectClosed = reconnectPage.waitForEvent("close", { timeout: 15_000 });
  await reconnectPage.getByRole("button", { name: "Connect" }).click();
  await reconnectClosed;
  const replacing = host.pairRequests.at(-1);
  assert.equal(replacing.dialed, loopbackOrigin);
  assert.equal(replacing.routeGeneration, null);
  assert.deepEqual(replacing.replaces, { sourceId, token: oldToken });
  assert.ok(challengedBeforePairing(replacing));
  const afterReplace = await connections();
  assert.equal(afterReplace.length, 1);
  assert.notEqual(afterReplace[0].sourceId, sourceId);
  assert.ok(afterReplace[0].sharedSites["https://example.com"]);
  assert.deepEqual(afterReplace[0].stoppedSites, ["https://alice.github.io"]);
  sourceId = afterReplace[0].sourceId;
  await waitUntil(() => host.clients.get(sourceId)?.readyState === 1, "replacement connected");
  assert.equal(await exported(sourceId, "https://alice.github.io"), "stopped");
  passed("reconnecting prefers loopback, sends replaces, and keeps shared and stopped sites");

  host.clients
    .get(sourceId)
    .send(JSON.stringify({ type: "source.error", code: "source-unauthorized" }));
  await waitUntil(async () => (await status()).value.connections[0].state === "ended", "ended");
  assert.equal((await connections())[0].ended, true);
  framesNow = host.frames.length;
  await sleep(2_500);
  assert.equal(host.frames.length, framesNow);
  await openPopup();
  await popup.getByText("Disconnected by Opensteer").waitFor();
  await shoot(popup, "popup-ended", "body");
  passed("a proven source-unauthorized ends the connection and stops retrying");

  await popup.getByRole("button", { name: "Disconnect", exact: true }).click();
  await popup.getByText("Disconnect Chrome from Home?").waitFor();
  await popup
    .getByText("Opensteer will show this Chrome as offline until you remove it there")
    .waitFor();
  await shoot(popup, "popup-disconnect-confirm", "body");
  const framesBeforeOfflineDisconnect = host.frames.length;
  await popup.getByRole("group").getByRole("button", { name: "Disconnect" }).click();
  await popup.getByText("In Opensteer, open Settings → Chrome").waitFor();
  assert.deepEqual(await connections(), []);
  assert.equal(host.frames.length, framesBeforeOfflineDisconnect);
  assert.deepEqual(host.disconnected, []);
  passed("Disconnect while not connected confirms inline and forgets locally");

  // Online Disconnect asks Opensteer to retire this Chrome before forgetting it.
  const fresh = invitation();
  const freshPage = await openConnect(app, fresh.text);
  const freshClosed = freshPage.waitForEvent("close", { timeout: 15_000 });
  await freshPage.getByRole("button", { name: "Connect" }).click();
  await freshClosed;
  assert.equal(host.pairRequests.at(-1).replaces, null);
  const [online] = await connections();
  await waitUntil(() => host.clients.get(online.sourceId)?.readyState === 1, "fresh connection");

  // Another Deployment (another key) on loopback: its pairing never carries
  // Home's token, and both connections are kept.
  host.loopbackMode = "other";
  const officeApp = await context.newPage();
  await officeApp.goto(`${loopbackOrigin}/app`);
  const officePage = await openConnect(
    officeApp,
    invitation({ order: "loopback-only", key: impostorKey, name: "Office" }).text,
  );
  await officePage.getByRole("heading", { name: connectHeading(loopbackOrigin) }).waitFor();
  assert.equal(await officePage.locator("#note").isHidden(), true);
  const officeClosed = officePage.waitForEvent("close", { timeout: 15_000 });
  await officePage.getByRole("button", { name: "Connect" }).click();
  await officeClosed;
  assert.equal(host.pairRequests.at(-1).replaces, null);
  assert.equal(host.pairRequests.at(-1).dialed, loopbackOrigin);
  const office = (await connections()).find((item) => item.deploymentName === "Office");
  assert.ok(office);
  assert.equal((await connections()).length, 2);
  assert.equal(host.sources.get(online.sourceId).revoked, undefined);
  passed("connecting another Deployment never sends replaces for Home's connection");
  await popup.evaluate(
    (id) => chrome.runtime.sendMessage({ sourceId: id, type: "ui.disconnect" }),
    office.sourceId,
  );
  await waitUntil(async () => (await connections()).length === 1, "Office forgotten");
  await officeApp.close();
  host.loopbackMode = "up";
  await openPopup();
  await popup.getByText("Connected", { exact: true }).waitFor();
  await popup.getByRole("button", { name: "Disconnect", exact: true }).click();
  await popup.getByText("Home removes this Chrome too.").waitFor();
  await shoot(popup, "popup-disconnect-confirm-online", "body");
  await popup.getByRole("group").getByRole("button", { name: "Disconnect" }).click();
  await popup.getByText("In Opensteer, open Settings → Chrome").waitFor();
  assert.deepEqual(host.disconnected, [office.sourceId, online.sourceId]);
  assert.equal(host.sources.get(online.sourceId).revoked, true);
  assert.deepEqual(await connections(), []);
  const framesAfterOnlineDisconnect = host.frames.length;
  await sleep(2_500);
  assert.equal(host.frames.length, framesAfterOnlineDisconnect);
  passed("Disconnect while connected sends source.disconnect, then forgets without reconnecting");

  const archive = await readFile(
    fileURLToPath(new URL("../../web/public/browser-extension.zip", import.meta.url)),
  );
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        result: "passed",
        extensionId,
        protocolVersion: browserSourceProtocolVersion,
        checks,
        screenshots: shots,
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Chrome extension journey passed (${checks.length} checks). Report: ${reportPath}`);
} finally {
  for (const client of host.clients.values()) client.terminate();
  if (context) await context.close();
  sockets.close();
  await new Promise((resolve) => loopbackServer.close(resolve));
  await new Promise((resolve) => remoteServer.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
