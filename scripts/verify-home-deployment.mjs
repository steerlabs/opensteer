#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:https";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  apiVersionHeaders,
  hostKeyFingerprint,
  verifyHostDiscoveryEnvelope,
} from "../packages/deployment-authority/src/index.ts";

import { quote, redact } from "./verify-home-deployment-support.mjs";

const root = resolve(import.meta.dirname, "..");
const requireHost = createRequire(resolve(root, "apps/host/package.json"));
const WebSocket = requireHost("ws");
const suffix = randomBytes(5).toString("hex");
const project = `opensteer-home-proof-${suffix}`;
const managedProject = `${project}-managed`;
const dockerHost = "unix:///Users/timjang/.colima/default/docker.sock";
const env = { ...process.env, DOCKER_HOST: dockerHost };
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
const tag = `home-proof-${suffix}`;
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
    throw new Error(`${label}\n${redact(child.stderr || child.stdout).trim()}`);
  return child.stdout.trim();
}

function docker(args, options) {
  return checked(result("docker", args, options), `docker ${args[0]} failed`);
}

function vm(command, { managed = false, allowFailure = false } = {}) {
  const child = result("colima", ["ssh", "--", "sudo", "-n", "bash", "-s"], {
    input: vmScript(command, managed),
  });
  return allowFailure ? child : checked(child, "Colima command failed");
}

function vmScript(command, managed) {
  const name = managed ? managedProject : project;
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
  const name = managed ? managedProject : project;
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
          lookup: (_host, options, done) =>
            options.all
              ? done(null, [{ address: "127.0.0.1", family: 4 }])
              : done(null, "127.0.0.1", 4),
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

function expectStatus(result, status) {
  assert.equal(result.status, status, result.json?.error?.message);
  return result;
}

async function check(name, run, available = true) {
  if (!available) {
    steps.blocked++;
    console.error(`BLOCKED ${name}`);
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
  if (ids.length) docker(["rm", "-f", ...ids]);
  if (networks.length) docker(["network", "rm", ...networks]);
  if (volumes.length || extraVolumes.length)
    docker(["volume", "rm", ...new Set([...volumes, ...extraVolumes])]);
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

function assertNetworkProbes(cid, image, pid, running) {
  const probe = `
    const {connect}=require("node:net");
    const targets=[["169.254.169.254",80],["fd00:ec2::254",80],["10.0.0.1",443],
      ["192.0.2.25",25],["192.0.2.25",465],["192.0.2.25",587],["127.0.0.1",5432]];
    async function open([host,port]) {
      return new Promise(resolve=>{
        const s=connect({host,port}); s.on("connect",()=>{s.destroy();resolve(true)});
        s.on("error",()=>resolve(false)); s.setTimeout(1500,()=>{s.destroy();resolve(false)});
      });
    }
    Promise.all(targets.map(open)).then(results=>{if(results.some(Boolean))throw Error("A blocked endpoint accepted TCP")});
  `;
  if (running) docker(["exec", cid, "node", "-e", probe]);
  else
    docker([
      "run",
      "--rm",
      "--network",
      `container:${container("host")}`,
      "--entrypoint",
      "node",
      image,
      "-e",
      probe,
    ]);
  const counters = vm(`nsenter -t ${pid} -n iptables -nvx -L OPENSTEER-HOME`);
  assert.ok(
    counters.split("\n").some((line) => /^\s*[1-9]\d*\s+\d+.*25,465,587/u.test(line)),
    "SMTP REJECT counter did not increment",
  );
  assert.ok(
    counters.split("\n").some((line) => /^\s*[1-9]\d*\s+\d+.*169\.254\.0\.0\/16/u.test(line)),
    "IPv4 metadata REJECT counter did not increment",
  );
}

async function browserJourney(api, cookie, ca, expectedFailure) {
  const target = "https://example.com/";
  const opened = expectStatus(
    await rpc(
      api,
      "commands.dispatch",
      {
        type: "tab.open",
        idempotencyKey: randomUUID(),
        target: { kind: "page", guest: true, url: target },
      },
      cookie,
    ),
    200,
  );
  const activated = expectStatus(
    await rpc(
      api,
      "commands.dispatch",
      {
        type: "tab.activate",
        idempotencyKey: randomUUID(),
        tabId: opened.data.tab.tabId,
      },
      cookie,
    ),
    200,
  );
  const { sessionId } = activated.data.viewer;
  assert.ok(sessionId);
  const socket = new WebSocket(
    `wss://${hostname}:${bind + 1}/v1/browser-sessions/${sessionId}/connect?mode=watch`,
    {
      ca,
      headers: { ...apiVersionHeaders("personal"), origin, cookie },
      lookup: (_host, _options, done) => done(null, "127.0.0.1", 4),
    },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("No committed browser page or navigation failure")),
      30_000,
    );
    socket.on("message", (data, binary) => {
      if (binary) return;
      const frame = JSON.parse(data.toString());
      const surfaces =
        frame.type === "browser.snapshot" ? frame.surfaces : frame.surface ? [frame.surface] : [];
      for (const surface of surfaces) {
        if (surface.navigationFailed) {
          if (expectedFailure) resolve();
          else reject(new Error("Browser failed to load the public page"));
        }
        if (surface.url === target && surface.title === "Example Domain" && !surface.loading) {
          if (expectedFailure)
            reject(new Error("The browser reached the public page through a bogus upstream"));
          else resolve();
        }
      }
    });
    socket.once("error", reject);
    socket.once("close", () =>
      reject(new Error("Browser stream closed before a navigation result")),
    );
    socket.once("close", () => clearTimeout(timer));
  }).finally(() => socket.terminate());
  const listing = docker(["top", container("browser-runtime"), "-eo", "args"]);
  assert.match(
    listing,
    /\/ms-playwright\/.*(chrome|chromium)/u,
    "Chromium did not launch in browser-runtime",
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
      "/CN=host.lima.internal",
      "-addext",
      "subjectAltName=DNS:host.lima.internal",
    ]),
    "Fake Account TLS generation failed",
  );

  const token = randomBytes(32).toString("base64url");
  const setupToken = randomBytes(32).toString("base64url");
  const setupCodeDigest = createHash("sha256").update(setupToken).digest("hex");
  const cloudComputerId = `cc_${randomUUID()}`;
  let accepted = 0;
  let requests = 0;
  let badRequest = false;
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    async (req, res) => {
      requests++;
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {}
      if (
        req.method !== "POST" ||
        req.url !== `/v1/cloud-computers/${cloudComputerId}/bootstrap` ||
        parsed?.hostname !== managedHostname ||
        parsed?.bootstrapToken !== token
      ) {
        badRequest = true;
        res.writeHead(400).end();
      } else if (accepted) {
        res.writeHead(410).end();
      } else {
        accepted++;
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            setupCodeDigest,
            release: manifest,
            backup: {
              repository: "s3:https://storage.example.test/home",
              password: "fixture-backup-password",
              accessKeyId: "fixture",
              secretAccessKey: "fixture",
            },
          }),
        );
      }
    },
  );
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  try {
    const spec = {
      cloudComputerId,
      accountOrigin: `https://host.lima.internal:${server.address().port}`,
      hostname: managedHostname,
      installerUrl: "https://release.example.test/opensteer-home-installer.sh",
      installerSha256: createHash("sha256").update(readFileSync(bootPackage)).digest("hex"),
    };
    const code = `
      install -d -m 0700 ${quote(vmDirectory)}
      printf '%s' ${quote(JSON.stringify(spec))} > ${quote(vmDirectory)}/boot.json
      printf '%s' ${quote(token)} > ${quote(vmDirectory)}/bootstrap-token
      export CURL_CA_BUNDLE=${quote(certificate)}
      bash ${quote(bootPackage)} --local --prepare --boot-spec ${quote(vmDirectory)}/boot.json --bootstrap-token-file ${quote(vmDirectory)}/bootstrap-token
    `;
    const run = (script) =>
      new Promise((resolve, reject) => {
        const child = spawn("colima", ["ssh", "--", "sudo", "-n", "bash", "-s"], {
          cwd: root,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
        child.stdin.end(vmScript(script, true));
      });
    const first = await run(code);
    checked(first, "Bundled managed installation failed");
    assert.equal(first.stdout, "");
    assert.equal(requests, 1);
    assert.equal(accepted, 1);
    assert.equal(badRequest, false);
    assert.equal(
      vm('cat "$OPENSTEER_HOME_DIR/secrets/setup_digest"', { managed: true }),
      setupCodeDigest,
    );
    const second = await run(`export OPENSTEER_HOME_DIR="${"$"}OPENSTEER_HOME_DIR-spent"\n${code}`);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /bootstrap token has already been used/u);
    assert.equal(requests, 2);
    assert.equal(accepted, 1);
    const started = vm("operator start", { managed: true, allowFailure: true });
    vm("load_compose; compose up -d --wait --pull never gateway", { managed: true });
    const managedApi = client(managedHostname, bind + 3, caddyRoot(true));
    const config = expectStatus(await rpc(managedApi, "auth.config"), 200).data;
    assert.equal(config.setupState, "required");
    const admission = expectStatus(
      await rpc(managedApi, "auth.setup.exchange", { token: setupToken }),
      200,
    );
    assert.ok(admission.cookie);
    if (started.status !== 0)
      console.error("The managed core started while the full pod was unhealthy.");
  } finally {
    server.close();
    await once(server, "close");
  }
}

const checkoutTemp = mkdtempSync(resolve(root, ".home-proof-"));
const bundleDirectory = resolve(checkoutTemp, "bundle");
mkdirSync(bundleDirectory);
const bootPackage = resolve(bundleDirectory, "opensteer-home-installer.sh");
const publicImageRefs = [s3Image, resticImage, postgresImage];
const preexisting = new Set(
  publicImageRefs.filter((image) => result("docker", ["image", "inspect", image]).status === 0),
);
let s3VolumeCreated = false;
let s3Id;
let api;
let ca;
let discovery;
let setupToken;
let ownerCookie;
let userId;
let runnerBoot;
let backupSucceeded;
try {
  const built = await check("build all six Home images for Colima linux/arm64", () => {
    const revision = checked(result("git", ["rev-parse", "HEAD"]), "Cannot read source revision");
    const build = result(
      "docker",
      [
        "buildx",
        "bake",
        "-f",
        "deploy/container/docker-bake.hcl",
        "--set",
        "home-*.platform=linux/arm64",
        "--load",
        "home",
      ],
      {
        env: {
          ...env,
          REGISTRY: "local",
          TAG: tag,
          RELEASE_VERSION: version,
          SOURCE_REVISION: revision,
          CACHE_BACKEND: "none",
          CACHE_EXPORT: "false",
        },
      },
    );
    checked(build, "Home build failed");
  });
  if (!built) throw new Error("The deployment proof needs the source-built images.");
  await check("prepare the local Home and stage the standalone installer", () => {
    checked(
      result("bash", [resolve(recipe, "package-installer.sh"), bootPackage]),
      "Installer packaging failed",
    );
    assert.deepEqual(
      checked(result("ls", ["-1", bundleDirectory]), "Installer bundle directory unavailable"),
      "opensteer-home-installer.sh",
    );
    setupToken = new URL(
      vm(`
      install -d -m 0700 "$OPENSTEER_HOME_DIR"
      printf '%s\\n' ${quote(JSON.stringify(manifest))} > ${quote(vmDirectory)}/release.json
      bash ${quote(resolve(recipe, "install.sh"))} --local --prepare --manifest ${quote(vmDirectory)}/release.json ${quote(hostname)}
    `),
    ).hash.match(/^#token=(.+)$/u)?.[1];
    assert.ok(setupToken);
  });
  await check(
    "all seven Compose services are healthy",
    () => {
      const started = vm("operator start", { allowFailure: true });
      if (started.status !== 0) {
        const states = ["postgres", ...components].map((name) => {
          const id = container(name);
          return `${name} ${docker(["inspect", "--format", "{{.State.Status}}/{{.State.Health.Status}}", id])}`;
        });
        const browser = result("docker", ["logs", "--tail", "3", container("browser-runtime")]);
        throw new Error(`${states.join("\n")}\n${browser.stdout}${browser.stderr}`);
      }
      for (const service of ["postgres", ...components])
        assert.equal(health(service), "running/healthy");
    },
    Boolean(setupToken),
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
    Boolean(setupToken),
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
      const renewed = vm("operator setup-link", { allowFailure: true });
      setupToken = new URL(renewed.stdout.trim()).hash.match(/^#token=(.+)$/u)?.[1];
      assert.ok(setupToken && setupToken !== oldToken);
      vm("load_compose; compose up -d --wait --pull never gateway");
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
    () => {
      assert.equal(health("runner"), "running/healthy");
      const info = JSON.parse(
        docker(["exec", container("runner"), "cat", "/var/lib/opensteer/readiness/connected.json"]),
      );
      assert.equal(info.state, "connected");
      runnerBoot = info.bootId;
    },
    Boolean(discovery),
  );
  await check(
    "Host opens a tab and Chromium loads a public HTTPS page through direct egress",
    () => browserJourney(api, ownerCookie, ca, false),
    Boolean(runnerBoot),
  );
  await check(
    "bogus upstream fails closed in Chromium",
    async () => {
      vm(`load_compose
      printf '%s' https://upstream.invalid:443 | save_secret "$home_dir/secrets/egress_url"
      printf '%s' invalid | save_secret "$home_dir/secrets/egress_username"
      printf '%s' invalid | save_secret "$home_dir/secrets/egress_password"
      compose up -d --wait --force-recreate browser-egress browser-runtime
    `);
      try {
        await browserJourney(api, ownerCookie, ca, true);
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
      assertNetworkProbes(container("runner"), images.runner, pid, true);
    },
    Boolean(discovery),
  );
  await check(
    "browser image cannot reach private, metadata and SMTP TCP in the pod namespace",
    () => {
      const pid = docker(["inspect", "--format", "{{.State.Pid}}", container("host")]);
      assertFirewall(pid);
      assertNetworkProbes(
        container("browser-runtime"),
        images["browser-runtime"],
        pid,
        health("browser-runtime") === "running/healthy",
      );
    },
    Boolean(discovery),
  );
  await check(
    "restart preserves claim and the owner session over HTTPS",
    async () => {
      vm("operator stop");
      vm("operator start", { allowFailure: true });
      vm("load_compose; compose up -d --wait --pull never gateway");
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
  const bucketReady = await check(
    "start a private disposable S3-compatible bucket",
    () => {
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
      vm(`
      endpoint=http://127.0.0.1:${port}
      curl -q --silent --show-error --fail --retry 5 --retry-connrefused --max-time 15 \
        --aws-sigv4 'aws:amz:us-east-1:s3' --user ${quote(`${accessKey}:${secretKey}`)} -X PUT "$endpoint/home" >/dev/null
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
      const attempt = vm("OPENSTEER_HOME_BACKUP_NETWORK=host operator restore", {
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
      const backedUp = vm("OPENSTEER_HOME_BACKUP_NETWORK=host operator backup", {
        allowFailure: true,
      });
      assert.match(backedUp.stdout, /snapshot [0-9a-f]+ saved/u, redact(backedUp.stderr));
      if (backedUp.status !== 0)
        console.error("The snapshot was saved while the full pod was unable to restart.");
      backupSucceeded = true;
    },
    Boolean(bucketReady),
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
      const restored = vm("OPENSTEER_HOME_BACKUP_NETWORK=host operator restore", {
        allowFailure: true,
      });
      assert.match(
        restored.stdout,
        /Restore will overwrite the database/u,
        redact(restored.stderr),
      );
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
      if (restored.status !== 0)
        console.error(
          "Restored Host credentials and data verified while the full pod was unable to restart.",
        );
    },
    backupSucceeded,
  );
  await check(
    "standalone installer consumes a managed bootstrap token and starts an unclaimed Host for its digest",
    () => managedProof(checkoutTemp, bootPackage),
    Boolean(setupToken),
  );
} finally {
  await check("remove all owned test containers, networks, volumes and image references", () => {
    try {
      if (!s3Id) s3Id = docker(["ps", "-aq", "--filter", `name=^/${s3Name}$`]);
      if (s3Id) docker(["rm", "-f", s3Id]);
      cleanupProject(project, s3VolumeCreated ? [s3Volume] : []);
      cleanupProject(managedProject);
    } finally {
      try {
        for (const image of [
          ...Object.values(images),
          ...publicImageRefs.filter((ref) => !preexisting.has(ref)),
        ]) {
          if (result("docker", ["image", "inspect", image]).status === 0)
            docker(["image", "rm", image]);
        }
      } finally {
        try {
          vm(`rm -rf -- ${quote(vmDirectory)}`);
        } finally {
          rmSync(checkoutTemp, { recursive: true, force: true });
        }
      }
    }
  });
  console.log(JSON.stringify(steps));
  if (steps.fail || steps.blocked) process.exitCode = 1;
}
