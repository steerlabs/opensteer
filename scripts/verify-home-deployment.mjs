#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { request } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  apiVersionHeaders,
  hostKeyFingerprint,
  verifyHostDiscoveryEnvelope,
} from "../packages/deployment-authority/src/index.ts";

import { registerCloudComputerRoutes } from "../apps/control-plane/src/cloud-computers/routes.ts";
import { ControlPlaneError } from "../apps/control-plane/src/server/errors.ts";
import {
  CloudComputerBootResponseSchema,
  CloudComputerEgressResponseSchema,
} from "../packages/control-plane-protocol/src/cloud-computers.ts";
import { decodeBrowserFrameEnvelope } from "../packages/protocol/src/browser.ts";
import { scopedPersonalApiVersion } from "../packages/protocol/src/personal-sync.ts";

import {
  assertBuildSpace,
  builderPlatforms,
  checkoutTemporaryDirectory,
  homeImageBuilds,
  platformSummary,
  quote,
  redact,
  verifierTarget,
} from "./verify-home-deployment-support.mjs";

const root = resolve(import.meta.dirname, "..");
const requireHost = createRequire(resolve(root, "apps/host/package.json"));
const WebSocket = requireHost("ws");
const Fastify = createRequire(resolve(root, "apps/control-plane/package.json"))("fastify");
const suffix = randomBytes(5).toString("hex");
const project = `opensteer-home-proof-${suffix}`;
const managedProject = `${project}-managed`;
const replacementProject = `${project}-replacement`;
const failedCandidate = `local/${project}-failed-host:proof`;
const registryName = `${project}-registry`;
const registryImage = "registry:3";
let registryId;
const registryReferences = [];
const builder = "opensteer-home-verifier";
const target = verifierTarget({
  env: process.env,
  home: homedir(),
  os: process.platform,
  arch: process.arch,
  builder,
});
const dockerHost = target.dockerHost;
const env = { ...process.env, DOCKER_HOST: dockerHost };
const [rootShell, rootShellArgs] = target.rootShell;
const vmDirectory = `/tmp/${project}`;
const recipe = resolve(root, "deploy/home");
const components = [
  "host",
  "gateway",
  "runner",
  "browser-runtime",
  "browser-egress",
  "channel-runtime",
];
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const tag = "home-verifier";
const builderDirectory = target.builderDirectory;
const builderEnv = { ...env, BUILDX_CONFIG: resolve(builderDirectory, "buildx") };
let builderUsed = false;
let proofPassed = false;
let buildOnlyPassed;
const images = Object.fromEntries(
  components.map((name) => [name, `local/opensteer-home-${name}:${tag}`]),
);
const manifest = { version, images };
const hostname = `home-${suffix}.test`;
const managedHostname = `managed-${suffix}.test`;
const origin = `https://${hostname}`;
const email = "owner@example.test";
const password = randomBytes(32).toString("base64url");
const s3Image =
  "rustfs/rustfs:1.0.0-alpha.85@sha256:23ff2af1ec2d64e0fb9608a1c39b5eb96fcff3a8efecf332986c948b0e3e4f8a";
const resticImage =
  "restic/restic:0.18.1@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76";
const postgresImage =
  "postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const s3Name = `${project}-s3`;
const s3Volume = `${project}-s3-data`;
const bind = 20_000 + (Number.parseInt(suffix.slice(0, 4), 16) % 8_000) * 4;
const steps = { pass: 0, fail: 0, blocked: 0 };
let interrupted;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted ??= signal;
  });
}

function result(command, args, options = {}) {
  const child = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (child.error) throw child.error;
  return child;
}

function checked(child, label) {
  if (child.status !== 0)
    throw new Error(`${label}\n${redact(child.stderr || child.stdout || "").trim()}`);
  return child.stdout?.trim() ?? "";
}

async function bounded(promise, label, milliseconds = 30_000) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(milliseconds, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`${label} timed out`);
      }),
    ]);
  } finally {
    controller.abort();
  }
}

function docker(args, options) {
  return checked(
    result("docker", args, { timeout: 600_000, ...options }),
    `docker ${args[0]} failed`,
  );
}

function vm(command, { managed = false, allowFailure = false, timeout = 600_000 } = {}) {
  const child = result(rootShell, rootShellArgs, {
    input: vmScript(command, managed),
    timeout,
  });
  return allowFailure ? child : checked(child, `${target.shellLabel} command failed`);
}

// Keep fixtures hosted by the verifier responsive while commands run in the root shell.
function vmAsync(command, { managed = false, timeout = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      rootShell,
      rootShellArgs,
      { cwd: root, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ status: error?.code ?? 0, stdout, stderr });
      },
    );
    child.stdin.on("error", reject);
    child.stdin.end(vmScript(command, managed));
  });
}

function vmScript(command, managed) {
  const name = managed === "replacement" ? replacementProject : managed ? managedProject : project;
  return `set -euo pipefail
umask 077
export OPENSTEER_HOME_DIR=${quote(`${vmDirectory}/${name}`)}
export COMPOSE_PROJECT_NAME=${quote(name)}
export OPENSTEER_HOME_BIND_IP=127.0.0.1 OPENSTEER_HOME_HTTP_PORT=${bind + (managed ? 2 : 0)} OPENSTEER_HOME_HTTPS_PORT=${bind + (managed ? 3 : 1)}
operator() { "$OPENSTEER_HOME_DIR/opensteer-home" "$@"; }
load_compose() { source "$OPENSTEER_HOME_DIR/common.sh"; }
${command}
`;
}

function container(service, managed = false) {
  const name = managed === "replacement" ? replacementProject : managed ? managedProject : project;
  const id = docker([
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${name}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ]);
  assert.match(id, /^[a-f0-9]{12}$/u, `Missing one ${name} ${service} container`);
  return id;
}

function health(service, managed = false) {
  return docker([
    "inspect",
    "--format",
    "{{.State.Status}}/{{.State.Health.Status}}",
    container(service, managed),
  ]);
}

function caddyRoot(managed = false) {
  return docker([
    "exec",
    container("gateway", managed),
    "cat",
    "/data/caddy/pki/authorities/local/root.crt",
  ]);
}

function lookupLoopback(_host, options, done) {
  if (options.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
  else done(null, "127.0.0.1", 4);
}

function client(host, port, ca) {
  return (path, { body, cookie, negotiation = true } = {}) =>
    new Promise((accept, reject) => {
      const headers = {
        origin: `https://${host}`,
        ...(negotiation ? apiVersionHeaders("personal") : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      };
      const req = request(
        {
          ca,
          agent: false,
          hostname: host,
          port,
          path,
          method: body ? "POST" : "GET",
          headers,
          lookup: lookupLoopback,
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () => {
            const cookie = response.headers["set-cookie"]
              ?.map((entry) => entry.split(";", 1)[0])
              .join("; ");
            const json = response.headers["content-type"]?.includes("application/json")
              ? JSON.parse(text)
              : undefined;
            accept({ status: response.statusCode, data: json?.data, json, cookie });
          });
          response.on("error", reject);
        },
      );
      req.setTimeout(30_000, () => req.destroy(new Error("Home HTTPS request timed out")));
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
}

function rpc(api, name, body, cookie) {
  return api(`/v1/rpc/${name}${body ? "" : "?input=%7B%7D"}`, { body, cookie });
}

function readRpc(api, name, input, cookie) {
  return api(`/v1/rpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`, { cookie });
}

async function dispatch(api, cookie, command) {
  return expectStatus(
    await rpc(api, "commands.dispatch", { ...command, idempotencyKey: randomUUID() }, cookie),
    200,
  ).data;
}

function expectStatus(result, status) {
  assert.equal(result.status, status, result.json?.error?.message);
  return result;
}

async function check(name, run, available = true, blockedReason) {
  if (interrupted && !cleaningUp)
    throw new Error(`The verifier was interrupted by ${interrupted}.`);
  if (!available) {
    steps.blocked++;
    console.error(`BLOCKED ${name}${blockedReason ? `: ${blockedReason}` : ""}`);
    return;
  }
  try {
    const value = await run();
    steps.pass++;
    console.log(`PASS ${name}`);
    return value ?? true;
  } catch (error) {
    steps.fail++;
    console.error(`FAIL ${name}\n${redact(error.message)}`);
  }
}

function cleanupProject(name, extraVolumes = []) {
  const filter = ["--filter", `label=com.docker.compose.project=${name}`];
  const ids = docker(["ps", "-aq", ...filter])
    .split("\n")
    .filter(Boolean);
  const networks = docker(["network", "ls", "-q", ...filter])
    .split("\n")
    .filter(Boolean);
  const volumes = docker(["volume", "ls", "-q", ...filter])
    .split("\n")
    .filter(Boolean);
  const staged = new RegExp(`^${name}-restore-[a-f0-9]{12}_[a-z-]+$`, "u");
  volumes.push(
    ...docker(["volume", "ls", "-q"])
      .split("\n")
      .filter((volume) => staged.test(volume)),
  );
  for (const stage of new Set(
    volumes.filter((volume) => staged.test(volume)).map((volume) => volume.split("_")[0]),
  )) {
    cleanupProject(stage);
  }
  if (ids.length) docker(["rm", "-f", ...ids]);
  if (networks.length) docker(["network", "rm", ...networks]);
  const remaining = new Set(docker(["volume", "ls", "-q"]).split("\n"));
  const owned = [...new Set([...volumes, ...extraVolumes])].filter((volume) =>
    remaining.has(volume),
  );
  if (owned.length) docker(["volume", "rm", ...owned]);
}

function assertFirewall(pid) {
  const rules = vm(`nsenter -t ${pid} -n iptables -S; nsenter -t ${pid} -n ip6tables -S`);
  assert.equal(rules.match(/-A OUTPUT -j OPENSTEER-HOME/gu)?.length, 2);
  for (const expected of [
    "169.254.0.0/16",
    "fc00::/7",
    "172.16.0.0/12",
    "25,465,587",
    "--ctdir REPLY",
  ]) {
    assert.ok(rules.includes(expected), `Missing firewall rule for ${expected}`);
  }
}

function assertNetworkProbes(cid, pid) {
  const probe = `
    const {connect}=require("node:net");
    const socket=connect({host:process.argv[1],port:Number(process.argv[2])});
    socket.on("connect",()=>{socket.destroy();process.exitCode=1});
    socket.on("error",()=>{});
    socket.setTimeout(1500,()=>socket.destroy());
  `;
  const probes = [
    ["169.254.169.254", 80, "iptables", "169.254.0.0/16"],
    ["fd00:ec2::254", 80, "ip6tables", "fc00::/7"],
    ["10.0.0.1", 443, "iptables", "10.0.0.0/8"],
    ...[25, 465, 587].map((port) => ["192.0.2.25", port, "iptables", "25,465,587"]),
  ];
  const addresses = [
    ...new Set(probes.map(([host]) => `${host}/${host.includes(":") ? 128 : 32}`)),
  ];
  const installed = [];
  try {
    for (const address of addresses) {
      vm(
        `nsenter -t ${pid} -n ip address add ${address} dev lo${address.includes(":") ? " nodad" : ""}`,
      );
      installed.push(address);
    }
    for (const [host, port, tool, rule] of probes) {
      const count = () => {
        const counters = vm(`nsenter -t ${pid} -n ${tool} -nvx -L OPENSTEER-HOME`);
        const line = counters.split("\n").find((entry) => entry.includes(rule));
        assert.ok(line, `Missing ${rule} counter`);
        return BigInt(line.trim().split(/\s+/u)[0]);
      };
      const before = count();
      docker(["exec", cid, "node", "-e", probe, host, String(port)]);
      assert.ok(count() > before, `No firewall REJECT for ${host}:${port}`);
    }
    docker(["exec", cid, "node", "-e", probe, "127.0.0.1", "5432"]);
  } finally {
    if (installed.length)
      vm(
        installed
          .map((address) => `nsenter -t ${pid} -n ip address del ${address} dev lo`)
          .join("\n"),
      );
  }
}

const launchProof = `
  require() {
    label=$1
    shift
    "$@" || { printf '%s' "$label" >&2; exit 1; }
  }
  require 'Agent home working directory' test "$(pwd -P)" = /workspaces
  require 'read Agent home input' test "$(cat home-proof-input)" = agent-home
  require 'mask Runner identity' test ! -r /var/lib/opensteer/identity.json
  for file in main_token environment_id browser_token; do
    require "mask Runner secret $file" test ! -r "/var/lib/opensteer/.secrets/$file"
  done
  runner_pid=$(cat home-proof-runner-pid)
  require 'prevent access through Runner proc root' test ! -r "/proc/$runner_pid/root/var/lib/opensteer/identity.json"
  require 'mask Runner process environment' test ! -r "/proc/$runner_pid/environ"
  require 'browser harness executable' test -x "$OPENSTEER_BROWSER_HARNESS"
  require 'mask another profile credential' test ! -r /var/lib/opensteer/private/harness-state/harness-profiles/home-proof-other/provider-home/auth.json
  printf '%s' confined > home-proof-result
`;

const verifyHarnessLaunch = `function verifyHarnessLaunch() {
  const home = process.env.CODEX_HOME;
  if (!home?.startsWith("/var/lib/opensteer/private/harness-state/harness-profiles/")) {
    throw new Error("The test engine did not receive its isolated provider home");
  }
  writeFileSync(home + "/auth.json", '{"homeProof":"synthetic"}', { mode: 0o600 });
  writeFileSync(home + "/sessions/home-proof-state", "synthetic engine state", { mode: 0o600 });
  const proof = launchProofShell("/bin/sh", ["-ec", launchProof], { encoding: "utf8" });
  if (proof.status !== 0) {
    const reason = proof.stderr?.trim() || proof.error?.message || \`exit \${proof.status}\`;
    writeFileSync("/workspaces/home-proof-result", \`failed: \${reason}\`);
    throw new Error(\`Container harness confinement or Agent home failed: \${reason}\`);
  }
}`;

function assertEngineState() {
  docker([
    "exec",
    container("runner"),
    "sh",
    "-ec",
    `
    state=/var/lib/opensteer/private/harness-state
    test "$(cat "$state/harness-profiles/$1/provider-home/auth.json")" = '{"homeProof":"synthetic"}'
    test "$(cat "$state/harness-stores/codex/store/sessions/home-proof-state")" = 'synthetic engine state'
    test "$(cat "$state/harness-profiles/home-proof-other/provider-home/auth.json")" = synthetic-other
  `,
    "proof",
    proofHarnessId,
  ]);
}

async function verifyPublicCdp(api, cookie, ca) {
  const issued = JSON.parse(
    docker([
      "exec",
      container("host"),
      "node",
      "-e",
      `
    const socket = require('node:net').connect('/tmp/opensteer-home-proof-cdp.sock');
    socket.on('connect', () => socket.end(process.argv[1]));
    socket.on('data', (chunk) => process.stdout.write(chunk));
  `,
      JSON.stringify({ ownerId: userId, threadId: proofThreadId, environmentId }),
    ]),
  );
  if (issued.error) throw new Error(issued.error);
  const { path, sessionId } = issued;
  assert.ok(path?.startsWith("/v1/browser/connect/") && sessionId);
  const connect = () =>
    new WebSocket(`wss://${hostname}:${bind + 1}${path}`, {
      ca,
      lookup: lookupLoopback,
      handshakeTimeout: 10_000,
    });
  const socket = connect();
  const deadline = setTimeout(() => socket.terminate(), 20_000);
  try {
    await once(socket, "open");
    let nextId = 0;
    async function cdp(method, params = {}, sessionId) {
      const id = ++nextId;
      let onMessage;
      const reply = new Promise((resolve, reject) => {
        onMessage = (data) => {
          const response = JSON.parse(data.toString());
          if (response.id !== id) return;
          if (response.error) reject(new Error(response.error.message));
          else resolve(response.result);
        };
        socket.on("message", onMessage);
      });
      const stop = once(socket, "close").then(() => {
        throw new Error("CDP connection closed");
      });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
      try {
        return await Promise.race([reply, stop]);
      } finally {
        socket.off("message", onMessage);
      }
    }
    assert.match((await cdp("Browser.getVersion")).product, /Chromium|Chrome/u);
    const { targetInfos } = await cdp("Target.getTargets");
    const page = targetInfos.find((target) => target.type === "page");
    assert.ok(page, "CDP session did not expose its browser page");
    const attached = await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const payloadLength = 7 * 1024 * 1024;
    const evaluated = await cdp(
      "Runtime.evaluate",
      {
        expression: JSON.stringify("x".repeat(payloadLength)) + ".length",
        returnByValue: true,
      },
      attached.sessionId,
    );
    assert.equal(evaluated.result.value, payloadLength);
    const replay = connect();
    try {
      await assert.rejects(once(replay, "open"), /Unexpected server response: 401/u);
    } finally {
      replay.terminate();
    }
    const logControl = `/home-proof-log-${randomUUID()}`;
    await api(logControl);
    const logs = (service) => {
      const output = result("docker", ["logs", container(service)], { timeout: 15_000 });
      assert.equal(output.status, 0);
      return `${output.stdout}\n${output.stderr}`;
    };
    const gateway = logs("gateway");
    assert.ok(gateway.includes(logControl), "Caddy request log control was not captured");
    assert.ok(!gateway.includes(path), "Caddy logged a CDP ticket");
    const host = logs("host");
    assert.ok(host.includes(logControl), "Host request log control was not captured");
    assert.ok(!host.includes(path), "Host logged a CDP ticket");
  } finally {
    clearTimeout(deadline);
    socket.terminate();
    await dispatch(api, cookie, { type: "browser.session.close", sessionId });
  }
}

const publicPage = { url: "https://example.com/", title: "Example Domain" };
const loopbackOrigin = "http://127.0.0.1:4369";

function startLoopbackServer(managed = false) {
  docker([
    "exec",
    "-d",
    container("runner", managed),
    "node",
    "-e",
    `
      const server = require('node:http').createServer((request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (request.url === '/seed') {
          response.setHeader('Set-Cookie', 'home-proof=restored; Path=/; Max-Age=86400; HttpOnly');
          response.end('<title>Home profile seeded</title>');
        } else if (request.url === '/check') {
          const saved = request.headers.cookie?.split('; ').includes('home-proof=restored');
          response.end(saved ? '<title>Home profile restored</title>' : '<title>Home profile missing</title>');
        } else {
          response.end('<title>Runner loopback</title>');
        }
      });
      server.listen(4369, '127.0.0.1');
    `,
  ]);
}

async function verifyAuthenticatedUpstream(api, cookie, ca) {
  const proof = resolve(checkoutTemp, "egress");
  mkdirSync(proof);
  const key = resolve(proof, "key.pem");
  const cert = resolve(proof, "cert.pem");
  checked(
    result("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=8.8.8.8",
      "-addext",
      `subjectAltName=IP:8.8.8.8,DNS:${target.fixtureHost}`,
    ]),
    "Upstream fixture TLS generation failed",
  );
  const username = "home-upstream";
  const password = randomBytes(24).toString("base64url");
  const authorization = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  const hostPid = docker(["inspect", "--format", "{{.State.Pid}}", container("host")]);
  // The fixture address exists only on this disposable pod's loopback device.
  const address = "8.8.8.8";
  const originAddress = "8.8.4.4";
  const port = 4370;
  const originPort = 4371;
  const fixture = `
    const fs = require('node:fs');
    const net = require('node:net');
    const [key, cert, authorization] = process.argv.slice(2);
    const server = require('node:https').createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
    server.on('connect', (request, client, head) => {
      if (request.headers['proxy-authorization'] !== authorization) { client.end('HTTP/1.1 407 Proxy Authentication Required\\r\\n\\r\\n'); return; }
      const target = new URL('http://' + request.url);
      const hostname = target.hostname.replace(/^\\[|\\]$/g, '');
      if (hostname !== '${originAddress}' || target.port !== '${originPort}') { client.destroy(); return; }
      const upstream = net.connect(${originPort}, hostname);
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client).pipe(upstream);
        process.stdout.write('authenticated CONNECT\\n');
      });
    });
    const origin = require('node:http').createServer((request, response) => {
      process.stdout.write('origin ' + request.url + '\\n');
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      response.end('<title>Controlled public page</title>');
    });
    origin.listen(${originPort}, '${originAddress}', () =>
      server.listen(${port}, '0.0.0.0', () => process.stdout.write('ready\\n')));
  `;
  const fixturePath = resolve(proof, "upstream.cjs");
  writeFileSync(fixturePath, fixture);
  const override = `services:
  browser-egress:
    environment:
      OPENSTEER_BROWSER_EGRESS_UPSTREAM_CA_FILE: /home-proof-upstream.pem
    volumes:
      - ${cert}:/home-proof-upstream.pem:ro`;
  const oidc = {
    clientId: `occ_${randomUUID()}`,
    clientSecret: `ocs_${randomBytes(32).toString("base64url")}`,
  };
  const id = `cc_${randomUUID()}`;
  let egressRequests = 0;
  let egress;
  const account = Fastify({ https: { key: readFileSync(key), cert: readFileSync(cert) } });
  registerCloudComputerRoutes(account, {
    store: {
      async egressForHome(computerId, credentials) {
        assert.equal(computerId, id);
        assert.ok(
          credentials ===
            `Basic ${Buffer.from(`${oidc.clientId}:${oidc.clientSecret}`).toString("base64")}`,
        );
        egressRequests++;
        return CloudComputerEgressResponseSchema.parse(egress ? { egress } : {});
      },
    },
    authenticator: {},
    verifyProvisioner: async () => {
      throw new Error("Unexpected provisioner request");
    },
    stripeWebhookSecret: "fixture",
  });
  let process;
  await account.listen({ host: "0.0.0.0", port: 0 });
  const accountOrigin = `https://${target.fixtureHost}:${account.server.address().port}`;
  const maintain = async () =>
    checked(
      await vmAsync(`CURL_CA_BUNDLE=${quote(cert)} operator maintain`, { timeout: 300_000 }),
      `${target.shellLabel} maintenance command failed`,
    );
  try {
    vm(`nsenter -t ${hostPid} -n ip address add ${address}/32 dev lo
        nsenter -t ${hostPid} -n ip address add ${originAddress}/32 dev lo`);
    process = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        `${project}-egress-fixture`,
        "--network",
        `container:${container("host")}`,
        "--entrypoint",
        "node",
        "--mount",
        `type=bind,src=${proof},dst=/proof,readonly`,
        "--user",
        "0:0",
        images["browser-egress"],
        "/proof/upstream.cjs",
        "/proof/key.pem",
        "/proof/cert.pem",
        authorization,
      ],
      { env, stdio: ["ignore", "pipe", "inherit"] },
    );
    let output = "";
    process.stdout.on("data", (data) => {
      output += data;
    });
    await bounded(
      Promise.race([
        once(process.stdout, "data"),
        once(process, "exit").then(() => {
          throw new Error("TLS upstream fixture stopped");
        }),
      ]),
      "TLS and public origin fixtures",
    );
    assert.match(output, /ready/u);
    const probe = async (name, expectedFailure = false) => {
      const path = `/probe-${name}-${randomUUID()}`;
      await browserJourney(api, cookie, ca, {
        url: `http://${originAddress}:${originPort}${path}`,
        title: "Controlled public page",
        expectedFailure,
      });
      const logs = docker(["logs", `${project}-egress-fixture`]);
      assert.equal(
        logs.split("\n").filter((line) => line === `origin ${path}`).length,
        expectedFailure ? 0 : 1,
      );
    };
    await probe("direct-control");
    vm(`load_compose
      cp "$home_dir/config.env" "$home_dir/config.egress.original"
      cp "$home_dir/common.sh" "$home_dir/common.egress.original"
      printf '%s\n' ${quote(override)} > "$home_dir/egress-upstream.proof.yaml"
      sed -i '/local apparmor=/i\\  if [[ -s "$home_dir/secrets/egress_url" ]]; then args+=(-f "$home_dir/egress-upstream.proof.yaml"); fi' "$home_dir/common.sh"
      printf '%s\n' ${quote(`OPENSTEER_HOME_ACCOUNT_ORIGIN='${accountOrigin}'
OPENSTEER_HOME_MANAGED_ID='${id}'
OPENSTEER_HOME_OIDC_CLIENT_ID='${oidc.clientId}'`)} >> "$home_dir/config.env"
      printf '%s' ${quote(oidc.clientSecret)} | save_secret "$home_dir/secrets/oidc_client_secret"
      touch "$home_dir/managed"
      load_compose
      compose up -d --wait --wait-timeout 60 --no-deps --force-recreate browser-egress`);
    await maintain();
    assert.equal(egressRequests, 1);
    vm('test ! -e "$OPENSTEER_HOME_DIR/secrets/egress_url"');
    assert.equal(
      docker([
        "exec",
        container("browser-egress"),
        "printenv",
        "OPENSTEER_BROWSER_EGRESS_UPSTREAM_REQUIRED",
      ]),
      "true",
    );
    await probe("pending", true);
    egress = { url: `https://${address}:${port}`, username, password };
    await maintain();
    assert.equal(egressRequests, 2);
    vm(
      'test -s "$OPENSTEER_HOME_DIR/secrets/egress_url" && test ! -e "$OPENSTEER_HOME_DIR/egress.pending"',
    );
    await probe("assigned");
    assert.match(docker(["logs", `${project}-egress-fixture`]), /authenticated CONNECT/u);
    const replaceUpstream = (file, value) =>
      vm(`load_compose
      printf '%s' ${quote(value)} | save_secret "$home_dir/secrets/egress_${file}"
      compose up -d --wait --wait-timeout 60 --no-deps --force-recreate browser-egress`);
    replaceUpstream("password", "incorrect");
    await probe("auth-refusal", true);
    replaceUpstream("password", password);
    replaceUpstream("url", `https://${originAddress}:${port}`);
    await probe("tls-refusal", true);
    replaceUpstream("url", `https://${address}:${port + 2}`);
    await probe("upstream-offline", true);
  } finally {
    const name = `${project}-egress-fixture`;
    try {
      try {
        if (result("docker", ["container", "inspect", name]).status === 0)
          docker(["rm", "-f", name]);
      } finally {
        if (process?.exitCode === null && process?.signalCode === null) {
          const exited = once(process, "exit");
          process.kill();
          await bounded(exited, "TLS upstream fixture shutdown");
        }
      }
    } finally {
      try {
        vm(`nsenter -t ${hostPid} -n ip address del ${address}/32 dev lo 2>/dev/null || true
        nsenter -t ${hostPid} -n ip address del ${originAddress}/32 dev lo 2>/dev/null || true
        if [[ -f "$OPENSTEER_HOME_DIR/common.egress.original" ]]; then
          load_compose
          mv "$home_dir/common.egress.original" "$home_dir/common.sh"
          mv "$home_dir/config.egress.original" "$home_dir/config.env"
          rm -f "$home_dir/egress-upstream.proof.yaml" "$home_dir/managed" "$home_dir/egress.pending" "$home_dir/secrets/"egress_{url,username,password}
          : | save_secret "$home_dir/secrets/oidc_client_secret"
          load_compose
          compose up -d --wait --wait-timeout 60 --no-deps --force-recreate browser-egress
        fi`);
      } finally {
        await bounded(account.close(), "egress Account shutdown");
      }
    }
  }
}

async function waitForHarnessCatalog(api, cookie, ca, environmentId, harnessInstanceId) {
  const socket = new WebSocket(`wss://${hostname}:${bind + 1}/v1/realtime`, {
    ca,
    headers: { ...apiVersionHeaders("personal"), origin, cookie },
    lookup: lookupLoopback,
  });
  let lastCatalog;
  let deadline;
  try {
    await new Promise((resolve, reject) => {
      deadline = setTimeout(
        () =>
          reject(new Error(`Harness catalog did not become ready: ${JSON.stringify(lastCatalog)}`)),
        30_000,
      );
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            type: "client.attach",
            apiVersion: scopedPersonalApiVersion,
            generation: 1,
            interests: ["harness-catalog"],
            installed: {},
          }),
        );
      });
      socket.once("error", reject);
      socket.once("close", (code, reason) =>
        reject(new Error(`Catalog stream closed before readiness (${code} ${reason})`)),
      );
      socket.on("message", async (data) => {
        try {
          const frame = JSON.parse(data.toString());
          if (frame.type !== "host.resource") return;
          if (frame.reply)
            expectStatus(
              await rpc(
                api,
                "harness.catalog.refresh",
                { environmentId, harnessInstanceId },
                cookie,
              ),
              200,
            );
          else if (!("harness-catalog" in frame.revisions)) return;
          const catalog = expectStatus(
            await readRpc(
              api,
              "resources.detail.get",
              { kind: "harness-catalog", id: environmentId },
              cookie,
            ),
            200,
          )
            .data.data.environments.flatMap((entry) => entry.harnessCatalogs)
            .find((candidate) => candidate.harnessInstanceId === harnessInstanceId);
          if (catalog?.status === "ready") resolve();
          if (catalog) {
            lastCatalog = { status: catalog.status, detail: catalog.detail };
            assert.ok(
              ["preparing", "ready"].includes(catalog.status),
              catalog.detail ?? catalog.status,
            );
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    clearTimeout(deadline);
    socket.terminate();
  }
}

async function browserJourney(
  api,
  cookie,
  ca,
  {
    url = publicPage.url,
    title = publicPage.title,
    expectedFailure = false,
    profileId,
    managed = false,
  } = {},
) {
  const { tab } = await dispatch(api, cookie, {
    type: "tab.open",
    target: { kind: "page", url, ...(profileId ? { profileId } : { guest: true }) },
  });
  const { viewer } = await dispatch(api, cookie, { type: "tab.activate", tabId: tab.tabId });
  const { sessionId, surfaceId } = viewer;
  assert.ok(sessionId && surfaceId);
  const socket = new WebSocket(
    `wss://${managed ? managedHostname : hostname}:${bind + (managed ? 3 : 1)}/v1/browser-sessions/${sessionId}/connect?mode=watch`,
    {
      ca,
      headers: {
        ...apiVersionHeaders("personal"),
        origin: managed ? `https://${managedHostname}` : origin,
        cookie,
      },
      lookup: lookupLoopback,
    },
  );
  try {
    await new Promise((resolve, reject) => {
      let lastSurface;
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `No browser navigation result for ${url}. Last surface: ${JSON.stringify(lastSurface)}`,
            ),
          ),
        30_000,
      );
      socket.on("message", (data, binary) => {
        try {
          if (binary) {
            const { header } = decodeBrowserFrameEnvelope(new Uint8Array(data));
            if (header.watchToken)
              socket.send(JSON.stringify({ type: "stream.ack", token: header.watchToken }));
            return;
          }
          const frame = JSON.parse(data.toString());
          if (frame.type === "browser.error") throw new Error(frame.error.message);
          if (frame.type === "browser.snapshot")
            socket.send(JSON.stringify({ type: "stream.subscribe", surfaceId }));
          const surfaces =
            frame.type === "browser.snapshot"
              ? frame.surfaces
              : frame.surface
                ? [frame.surface]
                : [];
          for (const surface of surfaces) {
            if (surface.id !== surfaceId) continue;
            lastSurface = { url: surface.url, title: surface.title, loading: surface.loading };
            if (surface.url === url && surface.navigationFailed) {
              if (expectedFailure) resolve();
              else reject(new Error(`Browser failed to load ${url}`));
            }
            if (surface.url === url && surface.title === title && !surface.loading) {
              if (expectedFailure)
                reject(new Error("The browser reached the public page through a bogus upstream"));
              else resolve();
            }
            if (surface.url === url && surface.title === "Home profile missing" && !surface.loading)
              reject(new Error("Chromium did not send the persisted profile cookie"));
          }
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
      socket.once("close", (code, reason) => {
        clearTimeout(timer);
        reject(new Error(`Browser stream closed before a navigation result (${code} ${reason})`));
      });
    });
    const listing = docker(["top", container("browser-runtime", managed), "-eo", "pid,args"]);
    assert.match(listing, /\/ms-playwright\/.*(chrome|chromium)/u);
    assert.doesNotMatch(listing, /(?:^|\s)--no-sandbox(?:\s|$)/u);
  } finally {
    socket.terminate();
    await dispatch(api, cookie, { type: "tab.close", tabIds: [tab.tabId] });
  }
}

function managedImages() {
  registryId = docker([
    "run",
    "-d",
    "--name",
    registryName,
    "-p",
    "127.0.0.1::5000",
    registryImage,
  ]);
  const address = docker(["port", registryId, "5000/tcp"]);
  return Object.fromEntries(
    components.map((service) => {
      const repo = `${address}/${project}/${service}`;
      const tagged = `${repo}:${tag}`;
      registryReferences.push(tagged);
      docker(["tag", images[service], tagged]);
      const output = docker(["push", tagged]);
      const digest = output.match(/digest: (sha256:[0-9a-f]{64})/u)?.[1];
      assert.ok(digest, `Registry did not return a digest for ${service}`);
      const ref = `${repo}@${digest}`;
      registryReferences.push(ref);
      return [service, ref];
    }),
  );
}

async function waitForSystemd(unit, successFile, expectedState, managed = true, timeout = 360_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = vm(
      `test ! -f ${quote(successFile)} || echo complete
      systemctl show ${quote(unit)} -p ActiveState -p ExecMainStatus -p NRestarts -p Result`,
      { managed, timeout: 15_000 },
    );
    if (state.includes("complete") && state.split("\n").includes(`ActiveState=${expectedState}`))
      return state;
    if (state.includes("ActiveState=failed") && state.includes("ExecMainStatus=78")) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    vm(`journalctl -u ${quote(unit)} --no-pager -n 100`, { managed, timeout: 15_000 }),
  );
}

async function managedProof(directory, bootPackage) {
  const accountDirectory = resolve(directory, "account");
  mkdirSync(accountDirectory);
  const key = resolve(accountDirectory, "key.pem");
  const certificate = resolve(accountDirectory, "certificate.pem");
  checked(
    result("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      certificate,
      "-subj",
      `/CN=${target.fixtureHost}`,
      "-addext",
      `subjectAltName=DNS:${target.fixtureHost}`,
    ]),
    "Account fixture TLS generation failed",
  );

  const release = { version, images: managedImages() };
  const token = randomBytes(32).toString("base64url");
  const replacementToken = randomBytes(32).toString("base64url");
  const setupToken = randomBytes(32).toString("base64url");
  const setupCodeDigest = createHash("sha256").update(setupToken).digest("hex");
  const cloudComputerId = `cc_${randomUUID()}`;
  const backupPassword = randomBytes(32).toString("hex");
  const feedAddress = `11.${Number.parseInt(suffix.slice(0, 2), 16)}.${Number.parseInt(suffix.slice(2, 4), 16)}.${Number.parseInt(suffix.slice(4, 6), 16)}`;
  const feedDirectory = `${vmDirectory}/update-feed`;
  const feedServer = `opensteer-home-feed-${suffix}`;
  const feedPort = bind + 2;
  const feedUrl = `https://${feedAddress}:${feedPort}/manifest.json`;
  let feedAddressAdded = false;
  let feedServerAttempted = false;
  const work = {
    organizationId: `org_${randomUUID()}`,
    organizationName: "Fixture's Work Home",
    assignmentId: `was_${randomUUID()}`,
  };
  const unit = managedProject;
  let bootRequests = 0;
  let completeRequests = 0;
  let identity;
  let snapshotId;
  let replacementCompleted = false;
  const app = Fastify({ https: { key: readFileSync(key), cert: readFileSync(certificate) } });
  app.setErrorHandler((error, _request, reply) => {
    if (!(error instanceof ControlPlaneError)) throw error;
    return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  });
  registerCloudComputerRoutes(app, {
    store: {
      async boot(id, input) {
        assert.equal(id, cloudComputerId);
        assert.equal(input.hostname, managedHostname);
        const replacing = input.bootstrapToken === replacementToken && snapshotId;
        if (replacing ? replacementCompleted : input.bootstrapToken !== token || identity)
          throw new ControlPlaneError(
            "unauthorized",
            "Invalid or expired Cloud Computer bootstrap token",
          );
        bootRequests++;
        if (bootRequests === 1)
          throw new ControlPlaneError("unavailable", "Temporary boot fixture outage");
        return CloudComputerBootResponseSchema.parse({
          hostname: managedHostname,
          accountOrigin,
          setupCodeDigest: replacing ? "e".repeat(64) : setupCodeDigest,
          ...(replacing ? { restoreSnapshot: snapshotId } : {}),
          ipv6Enabled: false,
          release,
          releaseManifestUrl: feedUrl,
          work,
          backup: {
            endpoint: backupFixture.endpoint,
            bucket: backupFixture.bucket,
            prefix: cloudComputerId,
            repository: `s3:${backupFixture.endpoint}/${backupFixture.bucket}/${cloudComputerId}`,
            password: backupPassword,
            accessKeyId: backupFixture.accessKeyId,
            secretAccessKey: backupFixture.secretAccessKey,
          },
        });
      },
      async bootComplete(id, input) {
        assert.equal(id, cloudComputerId);
        if (input.bootstrapToken === replacementToken) {
          assert.equal(input.hostname, managedHostname);
          assert.ok(snapshotId);
          assert.deepEqual(input.identity, identity);
          for (const service of ["postgres", ...components])
            assert.equal(health(service, "replacement"), "running/healthy");
          replacementCompleted = true;
          return;
        }
        assert.deepEqual(
          { hostname: input.hostname, bootstrapToken: input.bootstrapToken },
          { hostname: managedHostname, bootstrapToken: token },
        );
        for (const service of ["postgres", ...components])
          assert.equal(health(service, true), "running/healthy");
        if (identity) assert.deepEqual(input.identity, identity);
        identity = input.identity;
        completeRequests++;
        if (completeRequests === 1)
          throw new ControlPlaneError("unavailable", "Lost completion acknowledgement");
      },
    },
    authenticator: {
      authenticate() {
        throw Error("Unexpected owner Account route");
      },
    },
    async verifyProvisioner() {
      throw Error("Unexpected provisioner route");
    },
    stripeWebhookSecret: "fixture",
  });
  await app.listen({ host: "0.0.0.0", port: 0 });
  const accountOrigin = `https://${target.fixtureHost}:${app.server.address().port}`;
  const spec = {
    cloudComputerId,
    accountOrigin,
    hostname: managedHostname,
    installerUrl: "https://release.example.test/opensteer-home-installer.sh",
    installerSha256: createHash("sha256").update(readFileSync(bootPackage)).digest("hex"),
  };
  const specPath = `${vmDirectory}/boot.json`;
  const tokenPath = `${vmDirectory}/bootstrap-token`;
  try {
    vm(`ip address add ${feedAddress}/32 dev lo`);
    feedAddressAdded = true;
    vm(
      `
      install -d -m 0700 ${quote(vmDirectory)}
      printf '%s' ${quote(JSON.stringify(spec))} > ${quote(specPath)}
      printf '%s' ${quote(token)} > ${quote(tokenPath)}
      export CURL_CA_BUNDLE=${quote(certificate)} OPENSTEER_HOME_UNIT_PREFIX=${quote(unit)} OPENSTEER_HOME_BACKUP_NETWORK=host
      bash ${quote(bootPackage)} --local --boot-spec ${quote(specPath)} --bootstrap-token-file ${quote(tokenPath)}
    `,
      { managed: true },
    );
    const completed = `${vmDirectory}/${managedProject}/boot/completed`;
    await waitForSystemd(`${unit}-managed.service`, completed, "inactive");
    await waitForSystemd(`${unit}.service`, completed, "active");
    vm(`test ! -e ${quote(tokenPath)} && test ! -e "$OPENSTEER_HOME_DIR/boot/token"`, {
      managed: true,
    });
    assert.equal(bootRequests, 2);
    assert.equal(completeRequests, 2);
    vm(`test -e /etc/systemd/system/${unit}-update.timer`, { managed: true });
    assert.deepEqual(
      JSON.parse(
        docker(["exec", container("host", true), "printenv", "OPENSTEER_MANAGED_HOME_WORK_JSON"]),
      ),
      work,
    );
    for (const [service, image] of Object.entries(release.images)) {
      assert.equal(
        docker(["inspect", "--format", "{{.Config.Image}}", container(service, true)]),
        image,
      );
    }
    const ca = caddyRoot(true);
    const api = client(managedHostname, bind + 3, ca);
    const authority = expectStatus(await api("/.well-known/opensteer"), 200).json.authority;
    const document = verifyHostDiscoveryEnvelope(authority);
    assert.deepEqual(identity, {
      deploymentId: document.deploymentId,
      hostKeyFingerprint: hostKeyFingerprint(authority.publicKey.spki),
    });
    const config = expectStatus(await rpc(api, "auth.config"), 200).data;
    assert.equal(config.setupState, "required");
    const admission = expectStatus(
      await rpc(api, "auth.setup.exchange", { token: setupToken }),
      200,
    );
    assert.ok(admission.cookie);
    const claim = expectStatus(
      await rpc(api, "auth.setup.claim", { kind: "password", email, password }, admission.cookie),
      200,
    );
    assert.ok(claim);
    const owner = expectStatus(await rpc(api, "auth.password.signIn", { email, password }), 200);
    await browserJourney(api, owner.cookie, ca, { managed: true, expectedFailure: true });
    const spent = await app.inject({
      method: "POST",
      url: `/v1/cloud-computers/${cloudComputerId}/boot`,
      payload: { hostname: managedHostname, bootstrapToken: token },
    });
    assert.equal(spent.statusCode, 401);
    const alias = await app.inject({
      method: "POST",
      url: `/v1/cloud-computers/${cloudComputerId}/bootstrap`,
      payload: { hostname: managedHostname, bootstrapToken: token },
    });
    assert.equal(alias.statusCode, 404);
    const tagManifest = `${vmDirectory}/tag-manifest.json`;
    const refused = vm(
      `printf '%s' ${quote(JSON.stringify(manifest))} > ${quote(tagManifest)}
      operator update ${quote(tagManifest)}`,
      { managed: true, allowFailure: true },
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /only from the Account feed/u);
    const feedCertificate = `${feedDirectory}/certificate.pem`;
    feedServerAttempted = true;
    vm(
      `
      install -d -m 0700 ${quote(feedDirectory)}
      cd ${quote(feedDirectory)}
      openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout key.pem -out certificate.pem \
        -subj /CN=${feedAddress} -addext subjectAltName=IP:${feedAddress} 2>/dev/null
      printf 'HTTP/1.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n%s' ${quote(JSON.stringify(manifest))} > manifest.json
      systemd-run --quiet --unit=${feedServer} --working-directory=${quote(feedDirectory)} \
        openssl s_server -quiet -accept ${feedAddress}:${feedPort} -cert certificate.pem -key key.pem -HTTP
      for attempt in {1..50}; do
        if ss -Hltn 'sport = :${feedPort}' | grep -Fq ${feedAddress}; then exit 0; fi
        sleep 0.1
      done
      exit 1`,
      { managed: true },
    );
    const refusedFeed = vm(`CURL_CA_BUNDLE=${quote(feedCertificate)} operator update`, {
      managed: true,
      allowFailure: true,
    });
    assert.notEqual(refusedFeed.status, 0);
    assert.match(refusedFeed.stderr, /Managed Home releases require a digest/u);
    assert.equal(
      vm(
        `load_compose
      OPENSTEER_HOME_HOST_IMAGE=not-admitted OPENSTEER_HOME_VOLUME_SET=not-admitted \
      compose config --format json | jq -r '[.services.host.image,.volumes["host-data"].name][]'`,
        { managed: true },
      ),
      `${release.images.host}\n${managedProject}_host-data`,
    );
    const runnerIdentity = (target = true) =>
      JSON.parse(
        docker([
          "exec",
          container("runner", target),
          "node",
          "-e",
          "const { runnerId, environmentId } = require('/var/lib/opensteer/identity.json'); console.log(JSON.stringify({runnerId, environmentId}));",
        ]),
      );
    const enrolled = runnerIdentity();
    const { profile } = await dispatch(api, owner.cookie, {
      type: "browser.profile.create",
      input: { name: "Managed recovery profile", homeRunnerId: enrolled.runnerId },
    });
    startLoopbackServer(true);
    await browserJourney(api, owner.cookie, ca, {
      managed: true,
      url: `${loopbackOrigin}/seed`,
      title: "Home profile seeded",
      profileId: profile.id,
    });
    const backedUp = vm(
      `install -m 0600 ${quote(backupFixture.caPath)} "$OPENSTEER_HOME_DIR/backup-ca.pem"
      OPENSTEER_HOME_BACKUP_NETWORK=host operator backup`,
      { managed: true },
    );
    snapshotId = backedUp.match(/snapshot ([0-9a-f]+) saved/u)?.[1];
    assert.ok(snapshotId);
    vm(`systemctl stop ${unit}.service`, { managed: true });
    const replacementTokenPath = `${vmDirectory}/replacement-token`;
    vm(
      `test ! -e "$OPENSTEER_HOME_DIR"
      install -d -m 0700 "$OPENSTEER_HOME_DIR"
      install -m 0600 ${quote(backupFixture.caPath)} "$OPENSTEER_HOME_DIR/backup-ca.pem"
      printf '%s' ${quote(replacementToken)} > ${quote(replacementTokenPath)}
      export CURL_CA_BUNDLE=${quote(certificate)} OPENSTEER_HOME_UNIT_PREFIX=${quote(replacementProject)} OPENSTEER_HOME_BACKUP_NETWORK=host
      bash ${quote(bootPackage)} --local --boot-spec ${quote(specPath)} --bootstrap-token-file ${quote(replacementTokenPath)}`,
      { managed: "replacement" },
    );
    const replacementMarker = `${vmDirectory}/${replacementProject}/boot/completed`;
    await waitForSystemd(
      `${replacementProject}-managed.service`,
      replacementMarker,
      "inactive",
      "replacement",
    );
    await waitForSystemd(
      `${replacementProject}.service`,
      replacementMarker,
      "active",
      "replacement",
    );
    assert.ok(replacementCompleted);
    assert.equal(bootRequests, 3);
    vm(
      `test -f "$OPENSTEER_HOME_DIR/boot/restored"
      test ! -e "$OPENSTEER_HOME_DIR/boot/token" && test ! -e ${quote(replacementTokenPath)}`,
      { managed: "replacement" },
    );
    for (const service of ["postgres", ...components])
      assert.equal(health(service, "replacement"), "running/healthy");
    assert.deepEqual(runnerIdentity("replacement"), enrolled);
    const restoredCa = caddyRoot("replacement");
    const restoredApi = client(managedHostname, bind + 3, restoredCa);
    const restoredAuthority = expectStatus(await restoredApi("/.well-known/opensteer"), 200).json
      .authority;
    assert.equal(
      verifyHostDiscoveryEnvelope(restoredAuthority).deploymentId,
      identity.deploymentId,
    );
    assert.equal(hostKeyFingerprint(restoredAuthority.publicKey.spki), identity.hostKeyFingerprint);
    const restoredOwner = expectStatus(
      await rpc(restoredApi, "auth.password.signIn", { email, password }),
      200,
    );
    assert.equal(restoredOwner.data.session.user.id, owner.data.session.user.id);
    startLoopbackServer("replacement");
    await browserJourney(restoredApi, restoredOwner.cookie, restoredCa, {
      managed: "replacement",
      url: `${loopbackOrigin}/check`,
      title: "Home profile restored",
      profileId: profile.id,
    });
  } finally {
    try {
      if (feedServerAttempted || feedAddressAdded) {
        vm(`
          if ${feedServerAttempted} && systemctl show ${feedServer}.service -p LoadState --value | grep -qx loaded; then
            systemctl stop ${feedServer}.service
          fi
          if ${feedAddressAdded}; then ip address del ${feedAddress}/32 dev lo; fi`);
      }
    } finally {
      await bounded(app.close(), "managed Account shutdown");
    }
  }
}

function prepareBuilder() {
  assertBuildSpace(
    target.checkoutLabel,
    checked(
      result("df", ["-Pk", root, target.checkoutSpacePath]),
      "Cannot measure host free space",
    ),
  );
  const dockerRoot = docker(["info", "--format", "{{.DockerRootDir}}"]);
  assertBuildSpace(
    target.shellLabel,
    vm(`paths=(${quote(dockerRoot)})
[[ ! -d /var/lib/containerd ]] || paths+=(/var/lib/containerd)
df -Pk "\${paths[@]}"`),
  );
  for (const ref of Object.values(images)) {
    assert.notEqual(
      result("docker", ["image", "inspect", ref]).status,
      0,
      `Verifier tag ${ref} already exists. Resolve the leftover tag before building.`,
    );
  }
  if (result("docker", ["buildx", "inspect", builder], { env: builderEnv }).status !== 0) {
    const config = resolve(builderDirectory, "buildkitd.toml");
    writeFileSync(
      config,
      '[worker.oci]\n  gc = true\n  reservedSpace = "0B"\n  maxUsedSpace = "12GB"\n  minFreeSpace = "20GB"\n',
      { mode: 0o600 },
    );
    docker(
      [
        "buildx",
        "create",
        "--name",
        builder,
        "--driver",
        "docker-container",
        "--buildkitd-config",
        config,
        dockerHost,
      ],
      { env: builderEnv },
    );
  }
}

mkdirSync(builderDirectory, { recursive: true, mode: 0o700 });
const lock = resolve(builderDirectory, "active-run");
try {
  mkdirSync(lock, { mode: 0o700 });
} catch (error) {
  if (error.code === "EEXIST") {
    throw new Error(
      `The Home verifier already has a run lock at ${lock}. Check its PID before clearing a stale lock.`,
    );
  }
  throw error;
}
let checkoutTemp;
let managedPrepared = false;
let cleaningUp = false;
let resourcesAllowed = false;
const publicImageRefs = [
  s3Image,
  resticImage,
  postgresImage,
  registryImage,
  "moby/buildkit:buildx-stable-1",
];
const preexisting = new Set();
let s3VolumeCreated = false;
let s3Id;
let backupFixture;
let api;
let ca;
let discovery;
let setupToken;
let ownerCookie;
let userId;
let runnerBoot;
let runnerId;
let environmentId;
let browserProfileId;
let proofThreadId;
let proofHarnessId;
let backupSucceeded;
let restoreSucceeded;
try {
  writeFileSync(resolve(lock, "pid"), `${process.pid}\n`, { mode: 0o600 });
  prepareBuilder();
  for (const ref of publicImageRefs) {
    if (result("docker", ["image", "inspect", ref]).status === 0) preexisting.add(ref);
  }
  checkoutTemp = checkoutTemporaryDirectory(root);
  const bundleDirectory = resolve(checkoutTemp, "bundle");
  mkdirSync(bundleDirectory);
  const bootPackage = resolve(bundleDirectory, "opensteer-home-installer.sh");
  const contract = await check(
    "Home boot, egress and backup reports match the Account routes",
    () => {
      checked(
        result("pnpm", ["exec", "tsx", "--test", "scripts/verify-home-boot-contract.test.mjs"]),
        "Home Account contract failed",
      );
    },
  );
  if (!contract) throw new Error("Home Account contract failed");
  resourcesAllowed = true;
  const revision = checked(result("git", ["rev-parse", "HEAD"]), "Cannot read source revision");
  const builds = homeImageBuilds(builder, target.proofPlatform);
  const buildHome = ({ platform, args }, blockedReason) =>
    check(
      `build all six Home images for ${platform}`,
      () => {
        builderUsed = true;
        const build = result("docker", args, {
          env: {
            ...builderEnv,
            REGISTRY: "local",
            TAG: tag,
            RELEASE_VERSION: version,
            SOURCE_REVISION: revision,
            CACHE_BACKEND: "none",
            CACHE_EXPORT: "false",
          },
          stdio: ["ignore", "inherit", "inherit"],
        });
        checked(build, "Home build failed");
      },
      !blockedReason,
      blockedReason,
    );
  if (!(await buildHome(builds.proof)))
    throw new Error(`The deployment proof needs the source-built ${builds.proof.platform} images.`);
  const prepared = await check("prepare the local Home and stage the standalone installer", () => {
    checked(
      result("bash", [resolve(recipe, "package-installer.sh"), bootPackage]),
      "Installer packaging failed",
    );
    assert.deepEqual(
      checked(result("ls", ["-1", bundleDirectory]), "Installer bundle directory unavailable"),
      "opensteer-home-installer.sh",
    );
    const fixtureDirectory = resolve(checkoutTemp, "codex");
    mkdirSync(fixtureDirectory);
    const fixtures = resolve(root, "packages/harness-codex/src/test-fixtures");
    const original = readFileSync(resolve(fixtures, "fake-codex-app-server.mjs"), "utf8");
    const captureFile = "capture-records.mjs";
    writeFileSync(
      resolve(fixtureDirectory, captureFile),
      readFileSync(resolve(fixtures, captureFile)),
    );
    assert.match(original, /case "turn\/start":/u);
    writeFileSync(
      resolve(fixtureDirectory, "engine.mjs"),
      `import { spawnSync as launchProofShell } from 'node:child_process';\n${verifyHarnessLaunch}\nconst launchProof = ${JSON.stringify(launchProof)};\n${original
        .replace("createRequire(import.meta.url)", 'createRequire("/app/package.json")')
        .replace(
          'case "turn/start":',
          'case "turn/start":\n      if (!ephemeralThreads.has(message.params.threadId)) verifyHarnessLaunch();',
        )}`,
      { mode: 0o644 },
    );
    writeFileSync(
      resolve(fixtureDirectory, "codex"),
      '#!/bin/sh\nexec node /home-proof-codex/engine.mjs "$@"\n',
      { mode: 0o755 },
    );
    setupToken = new URL(
      vm(`
      install -d -m 0700 "$OPENSTEER_HOME_DIR"
      printf '%s\\n' ${quote(JSON.stringify(manifest))} > ${quote(vmDirectory)}/release.json
      bash ${quote(resolve(recipe, "install.sh"))} --local --prepare --manifest ${quote(vmDirectory)}/release.json ${quote(hostname)}
    `),
    ).hash.match(/^#token=(.+)$/u)?.[1];
    assert.ok(setupToken);
    const cdpFixture = resolve(root, "scripts/verify-home-deployment-cdp.mjs");
    const caddyFixture = resolve(checkoutTemp, "Caddyfile");
    writeFileSync(
      caddyFixture,
      readFileSync(resolve(recipe, "Caddyfile"), "utf8").replace(
        "\timport /etc/caddy/tls.caddy",
        "\tlog\n\timport /etc/caddy/tls.caddy",
      ),
      { mode: 0o644 },
    );
    vm(`cat > "$OPENSTEER_HOME_DIR/compose.proof.yaml" <<'OPENSTEER_HOME_PROOF'
services:
  gateway:
    volumes:
      - ${caddyFixture}:/etc/caddy/Caddyfile:ro
  host:
    command: [node, --import, /home-proof-cdp.mjs, dist/main.js]
    volumes:
      - ${cdpFixture}:/home-proof-cdp.mjs:ro
  runner:
    volumes:
      - ${fixtureDirectory}:/home-proof-codex:ro
    environment:
      OPENSTEER_CODEX_EXECUTABLE: /home-proof-codex/codex
OPENSTEER_HOME_PROOF
awk '/^  local args=/{ recipe=1 } { print } recipe && /compose.yaml/ {
  print "  args+=(-f \\"$home_dir/compose.proof.yaml\\")"
  recipe=0
}' "$OPENSTEER_HOME_DIR/common.sh" > "$OPENSTEER_HOME_DIR/common.proof.sh"
mv "$OPENSTEER_HOME_DIR/common.proof.sh" "$OPENSTEER_HOME_DIR/common.sh"
`);
  });
  const podHealthy = await check(
    "all seven Compose services are healthy",
    () => {
      const started = vm("operator start", { allowFailure: true });
      if (started.status !== 0) {
        const states = ["postgres", ...components].map((name) => {
          try {
            return `${name} ${health(name)}`;
          } catch {
            return `${name} was not created`;
          }
        });
        const logs = ["host", "runner", "browser-runtime", "channel-runtime"].map((name) => {
          const output = result("docker", ["logs", "--tail", "8", `${project}-${name}-1`]);
          return `${name}\n${output.stdout}${output.stderr}`;
        });
        throw new Error(`${started.stderr}\n${states.join("\n")}\n${logs.join("\n")}`);
      }
      for (const service of ["postgres", ...components])
        assert.equal(health(service), "running/healthy");
    },
    Boolean(prepared),
  );
  await check(
    "HTTPS validates against Caddy's CA and discovery signature and hostname verify",
    async () => {
      ca = caddyRoot();
      api = client(hostname, bind + 1, ca);
      discovery = expectStatus(
        await api("/.well-known/opensteer", { negotiation: false }),
        200,
      ).json;
      const document = verifyHostDiscoveryEnvelope(discovery.authority);
      assert.equal(document.canonicalOrigin, origin);
      assert.equal(document.deploymentShape.kind, "personal");
      assert.deepEqual(discovery.bootstrapMethods, ["password"]);
    },
    Boolean(podHealthy),
  );
  await check(
    "localhost bootstrap endpoint is absent on HTTPS",
    async () => {
      expectStatus(await api("/v1/local-bootstrap"), 404);
    },
    Boolean(discovery),
  );
  await check(
    "setup-link rotates admission and invalidates the old link",
    async () => {
      const oldToken = setupToken;
      const renewed = vm("operator setup-link");
      setupToken = new URL(renewed).hash.match(/^#token=(.+)$/u)?.[1];
      assert.ok(setupToken && setupToken !== oldToken);
      expectStatus(await rpc(api, "auth.setup.exchange", { token: oldToken }), 403);
    },
    Boolean(discovery),
  );
  await check(
    "one initial claim wins and password sign-in creates a working session",
    async () => {
      assert.equal(expectStatus(await rpc(api, "auth.config"), 200).data.setupState, "required");
      const first = expectStatus(await rpc(api, "auth.setup.exchange", { token: setupToken }), 200);
      const second = expectStatus(
        await rpc(api, "auth.setup.exchange", { token: setupToken }),
        200,
      );
      assert.ok(first.cookie && second.cookie);
      const claims = await Promise.all(
        [first, second].map((entry) =>
          rpc(api, "auth.setup.claim", { kind: "password", email, password }, entry.cookie),
        ),
      );
      assert.equal(claims.filter(({ status }) => status === 200).length, 1);
      assert.ok(claims.some(({ status }) => status === 403 || status === 409));
      expectStatus(await rpc(api, "auth.setup.exchange", { token: setupToken }), 403);
      const owner = expectStatus(await rpc(api, "auth.password.signIn", { email, password }), 200);
      ownerCookie = owner.cookie;
      userId = owner.data.session.user.id;
      assert.equal(
        expectStatus(await api("/v1/auth/session", { cookie: ownerCookie }), 200).json.session.user
          .id,
        userId,
      );
    },
    Boolean(discovery),
  );
  await check(
    "operator status reports the selected version and claim state",
    () => {
      const output = vm("operator status");
      assert.ok(output.startsWith(`Version ${version}\n`));
      assert.ok(output.endsWith("Claimed"));
    },
    Boolean(userId),
  );
  await check(
    "hosting Runner self-enrolled and is online",
    async () => {
      assert.equal(health("runner"), "running/healthy");
      const info = JSON.parse(
        docker(["exec", container("runner"), "cat", "/var/lib/opensteer/readiness/connected.json"]),
      );
      assert.equal(info.state, "connected");
      runnerBoot = info.bootId;
      ({ runnerId, environmentId } = JSON.parse(
        docker([
          "exec",
          container("runner"),
          "node",
          "-e",
          `
          const { runnerId, environmentId } = require('/var/lib/opensteer/identity.json');
          console.log(JSON.stringify({ runnerId, environmentId }));
        `,
        ]),
      ));
      assert.equal(
        expectStatus(
          await readRpc(
            api,
            "personal.readiness.get",
            {
              kind: "runner",
              environmentId,
              runnerId,
            },
            ownerCookie,
          ),
          200,
        ).data.ready,
        true,
      );
    },
    Boolean(discovery),
  );
  await check(
    "a sandboxed Codex can write its profile and store, use Agent home, and cannot read another profile or Runner credentials",
    async () => {
      docker([
        "exec",
        container("runner"),
        "sh",
        "-ec",
        `
        test -r /var/lib/opensteer/identity.json
        test -r /var/lib/opensteer/.secrets/main_token
        umask 077
        other=/var/lib/opensteer/private/harness-state/harness-profiles/home-proof-other/provider-home
        mkdir -p "$other"
        printf '%s' synthetic-other > "$other/auth.json"
        printf '%s' ${quote("agent-home")} > /workspaces/home-proof-input
        node -p "require('/var/lib/opensteer/readiness/connected.json').pid" > /workspaces/home-proof-runner-pid
      `,
      ]);
      const { harness } = await dispatch(api, ownerCookie, {
        type: "harness.create",
        environmentId,
        driverKind: "codex",
        sourceId: "openai",
        name: "Home containment proof",
        stateKind: "isolated",
      });
      await waitForHarnessCatalog(api, ownerCookie, ca, environmentId, harness.id);
      const { thread } = await dispatch(api, ownerCookie, {
        type: "thread.create",
        environmentId,
        harnessInstanceId: harness.id,
        title: "Home containment proof",
        modelSelection: {
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          options: { effort: "low" },
        },
      });
      const pending = spawn(
        "docker",
        [
          "exec",
          container("runner"),
          "node",
          "-e",
          `
        const fs = require('node:fs');
        const path = '/workspaces/home-proof-result';
        const watch = fs.watch('/workspaces', (event, name) => { if (name === 'home-proof-result') read(); });
        const timeout = setTimeout(() => { watch.close(); process.exitCode = 1; }, 30000);
        function read() {
          if (!fs.existsSync(path)) return;
          const result = fs.readFileSync(path, 'utf8');
          if (!result) return;
          clearTimeout(timeout);
          watch.close();
          console.log(result);
        }
        read();
      `,
        ],
        { env, stdio: ["ignore", "pipe", "inherit"] },
      );
      const proof = once(pending, "close");
      let output = "";
      pending.stdout.on("data", (data) => {
        output += data;
      });
      try {
        await dispatch(api, ownerCookie, {
          type: "thread.sendMessage",
          threadId: thread.id,
          content: [{ type: "text", text: "Run the Home confinement fixture." }],
        });
        const exit = await proof;
        if (exit[0] !== 0) {
          const details = ["host", "runner"].flatMap((service) => {
            const { stdout, stderr } = result("docker", [
              "logs",
              "--tail",
              "100",
              container(service),
            ]);
            return `${stdout}\n${stderr}`
              .split("\n")
              .filter((line) => /run\.failed|Runner command dispatch failed/u.test(line));
          });
          assert.deepEqual(
            exit,
            [0, null],
            ["No result from the sandboxed shell", ...details].join("\n"),
          );
        }
        assert.equal(output.trim(), "confined");
        proofThreadId = thread.id;
        proofHarnessId = harness.id;
        assertEngineState();
      } finally {
        if (pending.exitCode === null) pending.kill();
        await proof;
      }
    },
    Boolean(runnerId),
  );
  await check(
    "Runner resolves the pinned Claude Code executable from PATH",
    () => {
      assert.equal(
        docker(["exec", container("runner"), "claude", "--version"]),
        "2.1.294 (Claude Code)",
      );
    },
    Boolean(runnerId),
  );
  await check(
    "stock CDP crosses Caddy with a single-use ticket and a multi-MiB message",
    () => verifyPublicCdp(api, ownerCookie, ca),
    Boolean(proofThreadId),
  );
  await check(
    "Host opens a tab and Chromium loads a public HTTPS page through direct egress",
    () => browserJourney(api, ownerCookie, ca),
    Boolean(runnerBoot),
  );
  await check(
    "root maintenance polls the Account for late egress, blocks public Chromium traffic until assignment, then loads it through authenticated TLS CONNECT",
    () => verifyAuthenticatedUpstream(api, ownerCookie, ca),
    Boolean(runnerBoot),
  );
  await check(
    "bogus upstream fails closed for public HTTPS and Chromium still reaches Runner loopback",
    async () => {
      startLoopbackServer();
      vm(`load_compose
      printf '%s' https://upstream.invalid:443 | save_secret "$home_dir/secrets/egress_url"
      printf '%s' invalid | save_secret "$home_dir/secrets/egress_username"
      printf '%s' invalid | save_secret "$home_dir/secrets/egress_password"
      compose up -d --wait --force-recreate browser-egress browser-runtime
    `);
      try {
        await browserJourney(api, ownerCookie, ca, { expectedFailure: true });
        await browserJourney(api, ownerCookie, ca, {
          url: `${loopbackOrigin}/`,
          title: "Runner loopback",
        });
      } finally {
        vm(`load_compose
        rm -f "$home_dir/secrets/"egress_{url,username,password}
        compose up -d --wait --force-recreate browser-egress browser-runtime
      `);
      }
    },
    Boolean(runnerBoot),
  );
  await check(
    "Runner has no Host data or socket mount, and PostgreSQL has no TCP listener",
    () => {
      const runner = container("runner");
      docker([
        "exec",
        runner,
        "sh",
        "-ec",
        "test ! -e /var/lib/opensteer/keys/host-private.pem; test ! -S /var/run/postgresql/.s.PGSQL.5432",
      ]);
      const mounts = JSON.parse(docker(["inspect", "--format", "{{json .Mounts}}", runner]));
      assert.ok(
        mounts.every(
          ({ Name }) => !Name?.endsWith("_host-data") && !Name?.endsWith("_postgres-socket"),
        ),
      );
      assert.equal(
        docker(["inspect", "--format", "{{.HostConfig.NetworkMode}}", container("postgres")]),
        "none",
      );
      vm(`load_compose
      compose exec -T postgres sh -ec 'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; test -z "$(psql -At -U opensteer -d opensteer -c "SHOW listen_addresses")"'
    `);
    },
    Boolean(discovery),
  );
  await check(
    "namespace firewall blocks private, metadata and SMTP TCP from Runner",
    () => {
      const pid = docker(["inspect", "--format", "{{.State.Pid}}", container("host")]);
      assertFirewall(pid);
      assertNetworkProbes(container("runner"), pid);
    },
    Boolean(discovery),
  );
  await check(
    "browser image cannot reach private, metadata and SMTP TCP in the pod namespace",
    () => {
      const pid = docker(["inspect", "--format", "{{.State.Pid}}", container("host")]);
      assertFirewall(pid);
      assertNetworkProbes(container("browser-runtime"), pid);
    },
    Boolean(discovery),
  );
  await check(
    "Caddy administration is unavailable from the Runner and every service is capped",
    () => {
      docker([
        "exec",
        container("runner"),
        "node",
        "-e",
        `
      const assert=require('node:assert/strict');
      const net=require('node:net');
      const socket=net.connect(2019,'127.0.0.1');
      socket.once('connect',()=>{throw Error('Caddy admin accepted a connection');});
      socket.once('error',error=>assert.equal(error.code,'ECONNREFUSED'));
    `,
      ]);
      for (const service of ["postgres", ...components]) {
        const config = JSON.parse(
          docker(["inspect", "--format", "{{json .HostConfig}}", container(service)]),
        );
        assert.ok(
          config.NanoCpus > 0 && config.Memory > 0 && config.MemorySwap === config.Memory,
          service,
        );
        assert.equal(config.RestartPolicy.Name, "no");
      }
    },
    Boolean(discovery),
  );
  await check(
    "namespace firewall detects a missing rule and repairs both address-family policies",
    () => {
      const id = container("host");
      const pid = docker(["inspect", "--format", "{{.State.Pid}}", id]);
      vm(`load_compose
        nsenter -t ${pid} -n iptables -w -D OPENSTEER-HOME -d 169.254.0.0/16 -j REJECT
        if check_firewall ${pid}; then exit 1; fi
        operator maintain
        check_firewall ${pid}`);
      assert.equal(container("host"), id);
      vm(`unshare --net bash -euc '
        firewall="$OPENSTEER_HOME_DIR/firewall.sh"
        "$firewall" "$$" apply false
        "$firewall" "$$" check false
        iptables -w -D OPENSTEER-HOME -d 169.254.0.0/16 -j REJECT
        if "$firewall" "$$" check false; then exit 1; fi
        "$firewall" "$$" apply true
        "$firewall" "$$" check true
        if "$firewall" "$$" check false; then exit 1; fi
      '`);
    },
    Boolean(discovery),
  );
  await check(
    "IPv4 defaults and explicit IPv6 Compose publication",
    () => {
      const output = vm(`load_compose
      compose config --format json | jq -e '.networks.default.enable_ipv6 == false and all(.services.host.ports[]; .host_ip != "::")'
      touch "$home_dir/ipv6.enabled"
      trap 'rm -f -- "$home_dir/ipv6.enabled"' EXIT
      compose config --format json | jq -e '.networks.default.enable_ipv6 == true and ([.services.host.ports[] | select(.host_ip == "::")] | length) == 2'`);
      assert.equal(output, "true\ntrue");
    },
    Boolean(discovery),
  );
  await check(
    "restart preserves claim and the owner session over HTTPS",
    async () => {
      const oldOwner = container("host");
      vm("load_compose; compose stop host; operator maintain");
      assert.notEqual(container("host"), oldOwner);
      const pid = docker(["inspect", "--format", "{{.State.Pid}}", container("host")]);
      assertFirewall(pid);
      assert.equal(expectStatus(await rpc(api, "auth.config"), 200).data.setupState, "complete");
      assert.equal(
        expectStatus(await api("/v1/auth/session", { cookie: ownerCookie }), 200).json.session.user
          .id,
        userId,
      );
    },
    Boolean(userId),
  );
  await check(
    "Runner reauthenticates after the restart under a new boot ID",
    () => {
      assert.equal(health("runner"), "running/healthy");
      const info = JSON.parse(
        docker(["exec", container("runner"), "cat", "/var/lib/opensteer/readiness/connected.json"]),
      );
      assert.notEqual(info.bootId, runnerBoot);
      assert.equal(info.state, "connected");
    },
    Boolean(runnerBoot),
  );
  await check(
    "a Host-owned native Chromium profile stores a persistent cookie before backup",
    async () => {
      startLoopbackServer();
      const { profile } = await dispatch(api, ownerCookie, {
        type: "browser.profile.create",
        input: { name: "Home backup profile", homeRunnerId: runnerId },
      });
      await browserJourney(api, ownerCookie, ca, {
        url: `${loopbackOrigin}/seed`,
        title: "Home profile seeded",
        profileId: profile.id,
      });
      await browserJourney(api, ownerCookie, ca, {
        url: `${loopbackOrigin}/check`,
        title: "Home profile restored",
        profileId: profile.id,
      });
      browserProfileId = profile.id;
    },
    Boolean(runnerId),
  );
  const bucketReady = await check(
    "start a private disposable S3-compatible bucket",
    () => {
      const tlsDirectory = resolve(checkoutTemp, "s3-tls");
      mkdirSync(tlsDirectory);
      const caPath = resolve(tlsDirectory, "rustfs_cert.pem");
      const keyPath = resolve(tlsDirectory, "rustfs_key.pem");
      checked(
        result("openssl", [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-keyout",
          keyPath,
          "-out",
          caPath,
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ]),
        "S3 fixture TLS generation failed",
      );
      const accessKey = "homeproof";
      const secretKey = randomBytes(24).toString("hex");
      docker(["volume", "create", s3Volume]);
      s3VolumeCreated = true;
      s3Id = docker([
        "run",
        "-d",
        "--name",
        s3Name,
        "--user",
        "0:0",
        "-p",
        "127.0.0.1::9000",
        "--mount",
        `type=volume,src=${s3Volume},dst=/data`,
        "--mount",
        `type=bind,src=${tlsDirectory},dst=/opt/tls,readonly`,
        "-e",
        "RUSTFS_TLS_PATH=/opt/tls",
        "-e",
        `RUSTFS_ACCESS_KEY=${accessKey}`,
        "-e",
        `RUSTFS_SECRET_KEY=${secretKey}`,
        "-e",
        "RUSTFS_CONSOLE_ENABLE=false",
        s3Image,
        "/data",
      ]);
      const port = docker(["port", s3Id, "9000/tcp"]).split(":").at(-1);
      const endpoint = `https://127.0.0.1:${port}`;
      backupFixture = {
        endpoint,
        bucket: "home",
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
        caPath,
      };
      vm(`
      endpoint=${quote(endpoint)}
      install -m 0600 ${quote(caPath)} "$OPENSTEER_HOME_DIR/backup-ca.pem"
      curl -q --silent --show-error --fail --retry 5 --retry-connrefused --max-time 15 \
        --cacert ${quote(caPath)} --aws-sigv4 'aws:amz:us-east-1:s3' --user ${quote(`${accessKey}:${secretKey}`)} -X PUT "$endpoint/home" >/dev/null
      printf 's3:%s/home/%s\\n' "$endpoint" ${quote(project)} > "$OPENSTEER_HOME_DIR/secrets/backup_repository"
      printf '%s\\n' ${quote(randomBytes(32).toString("hex"))} > "$OPENSTEER_HOME_DIR/secrets/backup_password"
      printf '%s\\n' ${quote(accessKey)} > "$OPENSTEER_HOME_DIR/secrets/backup_accessKeyId"
      printf '%s\\n' ${quote(secretKey)} > "$OPENSTEER_HOME_DIR/secrets/backup_secretAccessKey"
    `);
    },
    Boolean(userId),
  );
  await check(
    "restore refuses to overwrite a claimed Home without --replace",
    () => {
      const unacknowledged = vm("OPENSTEER_HOME_BACKUP_NETWORK=host operator restore", {
        allowFailure: true,
      });
      assert.notEqual(unacknowledged.status, 0);
      assert.match(unacknowledged.stderr, /acknowledge it with --source-stopped/u);
      const attempt = vm("OPENSTEER_HOME_BACKUP_NETWORK=host operator restore --source-stopped", {
        allowFailure: true,
      });
      assert.notEqual(attempt.status, 0);
      assert.match(attempt.stderr, /This Home is claimed\. Use --replace/u);
    },
    Boolean(bucketReady),
  );
  await check(
    "operator creates one encrypted restic snapshot containing PostgreSQL and durable volumes",
    () => {
      const backedUp = vm("OPENSTEER_HOME_BACKUP_NETWORK=host operator backup");
      assert.match(backedUp, /snapshot [0-9a-f]+ saved/u);
      backupSucceeded = true;
    },
    Boolean(bucketReady),
  );
  await check(
    "a missing snapshot leaves the running destination and its volumes intact",
    () => {
      const previous = container("host");
      const before = vm("load_compose; compose config --format json | jq -S .volumes");
      const failed = vm(
        "OPENSTEER_HOME_BACKUP_NETWORK=host operator restore --source-stopped --replace deadbeef",
        { allowFailure: true },
      );
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /no matching snapshot|no matching ID|no snapshot found/u);
      assert.equal(container("host"), previous);
      assert.equal(vm("load_compose; compose config --format json | jq -S .volumes"), before);
    },
    Boolean(backupSucceeded),
  );
  await check(
    "an interrupted unhealthy candidate restores previous images without rolling back database writes",
    () => {
      const previous = vm('cat "$OPENSTEER_HOME_DIR/images.env"');
      const before = Object.fromEntries(
        components.map((service) => [
          service,
          docker(["inspect", "--format", "{{.Image}}", container(service)]),
        ]),
      );
      const fixture = docker(["create", "--name", `${project}-failed-host`, images.host]);
      try {
        docker(["commit", "--change", 'ENTRYPOINT ["/bin/false"]', fixture, failedCandidate]);
      } finally {
        docker(["rm", "-v", fixture]);
      }
      const candidateId = docker(["image", "inspect", "--format", "{{.Id}}", failedCandidate]);
      assert.notEqual(candidateId, before.host);
      vm(`load_compose
      source "$home_dir/backup.sh"
      journal="$home_dir/update.pending"
      mkdir "$journal"
      cp "$home_dir/images.env" "$journal/previous.env"
      cp "$home_dir/images.env" "$journal/original.env"
      sed 's|^OPENSTEER_HOME_HOST_IMAGE=.*|OPENSTEER_HOME_HOST_IMAGE=${failedCandidate}|' "$journal/previous.env" > "$journal/candidate.env"
      postgres_tool pg_dump --format=custom > "$home_dir/update-database.dump"
      compose down
      release_env="$journal/candidate.env" compose up -d --pull never host
      candidate=$(release_env="$journal/candidate.env" compose ps --all -q host)
      test "$(docker inspect --format '{{.Image}}' "$candidate")" = ${quote(candidateId)}
      test "$(timeout 20s docker wait "$candidate")" = 1
      postgres_tool psql -v ON_ERROR_STOP=1 -c 'CREATE TABLE home_proof_expand (value integer); INSERT INTO home_proof_expand VALUES (42)'
      operator start
      test ! -e "$journal"
      test -s "$home_dir/update-database.dump"
      test "$(postgres_tool psql -Atc 'SELECT value FROM home_proof_expand')" = 42
      postgres_tool psql -v ON_ERROR_STOP=1 -c 'DROP TABLE home_proof_expand'`);
      assert.equal(vm('cat "$OPENSTEER_HOME_DIR/images.env"'), previous);
      for (const service of components)
        assert.equal(
          docker(["inspect", "--format", "{{.Image}}", container(service)]),
          before[service],
        );
      for (const service of ["postgres", ...components])
        assert.equal(health(service), "running/healthy");
    },
    Boolean(backupSucceeded),
  );
  await check(
    "wipe volumes and restore the same signed Host identity, claim and owner password",
    async () => {
      vm("load_compose; compose down --volumes");
      const wipe = docker([
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ]);
      assert.equal(wipe, "");
      const restored = vm("OPENSTEER_HOME_BACKUP_NETWORK=host operator restore --source-stopped");
      for (const service of ["postgres", ...components])
        assert.equal(health(service), "running/healthy");
      assert.match(restored, /Restore will overwrite the database/u);
      const restoredApi = client(hostname, bind + 1, caddyRoot());
      const current = expectStatus(await restoredApi("/.well-known/opensteer"), 200).json.authority;
      const document = verifyHostDiscoveryEnvelope(current);
      assert.equal(
        hostKeyFingerprint(current.publicKey.spki),
        hostKeyFingerprint(discovery.authority.publicKey.spki),
      );
      assert.equal(document.deploymentId, discovery.authority.document.deploymentId);
      assert.equal(document.hostInstanceId, discovery.authority.document.hostInstanceId);
      assert.equal(
        expectStatus(await rpc(restoredApi, "auth.config"), 200).data.setupState,
        "complete",
      );
      assert.equal(
        expectStatus(await rpc(restoredApi, "auth.password.signIn", { email, password }), 200).data
          .session.user.id,
        userId,
      );
      api = restoredApi;
      ca = caddyRoot();
      ownerCookie = expectStatus(
        await rpc(restoredApi, "auth.password.signIn", { email, password }),
        200,
      ).cookie;
      assertEngineState();
      restoreSucceeded = true;
    },
    Boolean(backupSucceeded),
  );
  await check(
    "restored Chromium profile sends its original cookie to the loopback app",
    async () => {
      startLoopbackServer();
      await browserJourney(api, ownerCookie, ca, {
        url: `${loopbackOrigin}/check`,
        title: "Home profile restored",
        profileId: browserProfileId,
      });
    },
    Boolean(browserProfileId && restoreSucceeded),
  );
  if (restoreSucceeded) {
    vm("operator stop");
  }
  await check(
    "managed installer retries completion, restores onto a fresh destination, and refuses mutable images",
    () => {
      managedPrepared = true;
      return managedProof(checkoutTemp, bootPackage);
    },
    Boolean(setupToken && bucketReady),
  );
  // The deployment proof above is complete; the other platform is built afterwards so it
  // cannot block it.
  proofPassed = steps.fail === 0 && steps.blocked === 0;
  let buildOnlyBlocked;
  if (target.requireBuilderPlatform) {
    const inspected = docker(["buildx", "inspect", "--bootstrap", builder], { env: builderEnv });
    if (!builderPlatforms(inspected).includes(builds.buildOnly.platform))
      buildOnlyBlocked = `the ${builder} builder cannot run ${builds.buildOnly.platform} (no emulation is installed on this machine)`;
  }
  const buildOnly = await buildHome(builds.buildOnly, buildOnlyBlocked);
  buildOnlyPassed = buildOnlyBlocked ? undefined : Boolean(buildOnly);
} finally {
  cleaningUp = true;
  try {
    if (resourcesAllowed) {
      await check("remove owned test resources and cap the dedicated build cache", () => {
        const errors = [];
        function clean(task) {
          try {
            task();
            return true;
          } catch (error) {
            errors.push(error.message);
            return false;
          }
        }
        let unitsStopped = true;
        if (managedPrepared) {
          for (const unit of [managedProject, replacementProject])
            unitsStopped =
              clean(() =>
                vm(`
            units=()
            for suffix in -managed.service -update.timer -backup.timer -maintain.timer -update.service -backup.service -maintain.service .service; do
              name=${quote(unit)}"$suffix"
              if [[ -f "/etc/systemd/system/$name" ]]; then units+=("$name"); fi
            done
            if (( \${#units[@]} )); then
              systemctl stop "\${units[@]}"
              systemctl disable "\${units[@]}"
              for name in "\${units[@]}"; do rm -f -- "/etc/systemd/system/$name"; done
              systemctl daemon-reload
            fi`),
              ) && unitsStopped;
        }
        clean(() => {
          if (!s3Id) s3Id = docker(["ps", "-aq", "--filter", `name=^/${s3Name}$`]);
          if (s3Id) docker(["rm", "-f", s3Id]);
        });
        clean(() => cleanupProject(project, s3VolumeCreated ? [s3Volume] : []));
        if (unitsStopped) {
          clean(() => cleanupProject(managedProject));
          clean(() => cleanupProject(replacementProject));
        }
        clean(() => {
          if (registryId) docker(["rm", "-fv", registryId]);
        });
        for (const managed of [false, true, "replacement"]) {
          if (managed && !unitsStopped) continue;
          clean(() =>
            vm(
              'if [[ -f "$OPENSTEER_HOME_DIR/common.sh" ]]; then load_compose; remove_runner_apparmor; fi',
              { managed },
            ),
          );
        }
        if (builderUsed) {
          clean(() =>
            docker(
              [
                "buildx",
                "prune",
                "--builder",
                builder,
                "--all",
                "--force",
                "--max-used-space",
                "12gb",
                "--reserved-space",
                "0b",
              ],
              { env: builderEnv },
            ),
          );
          clean(() =>
            console.log(docker(["buildx", "du", "--builder", builder], { env: builderEnv })),
          );
          clean(() => docker(["buildx", "rm", "--keep-state", builder], { env: builderEnv }));
        }
        for (const image of [
          ...registryReferences,
          ...Object.values(images),
          failedCandidate,
          ...publicImageRefs.filter((ref) => !preexisting.has(ref)),
        ]) {
          clean(() => {
            if (result("docker", ["image", "inspect", image]).status === 0)
              docker(["image", "rm", image]);
          });
        }
        if (unitsStopped) clean(() => vm(`rm -rf -- ${quote(vmDirectory)}`));
        else errors.push(`Preserved ${vmDirectory} because unit cleanup failed.`);
        if (errors.length) throw new Error(errors.join("\n"));
      });
    }
  } finally {
    if (checkoutTemp) rmSync(checkoutTemp, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
  console.log(JSON.stringify(steps));
  console.log(
    platformSummary({
      proofPassed,
      buildOnly: buildOnlyPassed,
      proofPlatform: target.proofPlatform,
      buildOnlyPlatform: homeImageBuilds(builder, target.proofPlatform).buildOnly.platform,
    }),
  );
  if (interrupted || steps.fail || steps.blocked) process.exitCode = 1;
}
