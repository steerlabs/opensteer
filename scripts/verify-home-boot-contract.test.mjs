import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { registerCloudComputerRoutes } from "../apps/control-plane/src/cloud-computers/routes.ts";
import { ControlPlaneError } from "../apps/control-plane/src/server/errors.ts";
import {
  CloudComputerBootCompleteRequestSchema,
  CloudComputerBootRequestSchema,
  CloudComputerBootResponseSchema,
  CloudComputerEgressResponseSchema,
} from "../packages/control-plane-protocol/src/cloud-computers.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const Fastify = createRequire(resolve(root, "apps/control-plane/package.json"))("fastify");
const id = "cc_9f04810f-1a2b-48d6-8e66-9698269adee3";
const hostname = "home.example.test";
const bootstrapToken = "a".repeat(43);
const identity = {
  deploymentId: "dep_9f04810f-1a2b-48d6-8e66-9698269adee3",
  hostKeyFingerprint: `sha256:${"d".repeat(43)}`,
};

function write(path, data, mode = 0o600) {
  writeFileSync(path, data, { mode });
}

test("managed exchange uses the real Account routes, validates HTTPS, and replays completion", async (t) => {
  const temp = mkdtempSync(resolve(tmpdir(), "home-boot-contract-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const cert = resolve(temp, "cert.pem");
  const key = resolve(temp, "key.pem");
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
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const app = Fastify({ https: { key: readFileSync(key), cert: readFileSync(cert) } });
  t.after(() => app.close());
  app.setErrorHandler((error, _request, reply) => {
    if (!(error instanceof ControlPlaneError)) throw error;
    return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  });
  let payload;
  let completed;
  let assignedEgress;
  let egressRequests = 0;
  const oidc = { clientId: `occ_${id.slice(3)}`, clientSecret: `ocs_${"a".repeat(43)}` };
  let exchanges = 0;
  let acknowledgements = 0;
  registerCloudComputerRoutes(app, {
    store: {
      async egressForHome(computerId, authorization) {
        assert.equal(computerId, id);
        assert.equal(
          authorization,
          `Basic ${Buffer.from(`${oidc.clientId}:${oidc.clientSecret}`).toString("base64")}`,
        );
        egressRequests++;
        return assignedEgress ? { egress: assignedEgress } : {};
      },
      async boot(computerId, input) {
        assert.equal(computerId, id);
        assert.deepEqual(CloudComputerBootRequestSchema.parse(input), { hostname, bootstrapToken });
        if (completed) throw new ControlPlaneError("unauthorized", "Expired bootstrap token");
        exchanges++;
        return payload;
      },
      async bootComplete(computerId, input) {
        assert.equal(computerId, id);
        assert.deepEqual(CloudComputerBootCompleteRequestSchema.parse(input), {
          hostname,
          bootstrapToken,
          identity,
        });
        if (completed) assert.deepEqual(completed, input.identity);
        completed = input.identity;
        acknowledgements++;
        if (acknowledgements === 1)
          throw new ControlPlaneError("unavailable", "Lost acknowledgement");
      },
    },
    authenticator: {},
    verifyProvisioner: async () => {
      throw new Error("Unexpected provisioner request");
    },
    stripeWebhookSecret: "fixture",
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const accountOrigin = `https://localhost:${app.server.address().port}`;
  const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const images = Object.fromEntries(
    ["host", "runner", "browser-runtime", "browser-egress", "channel-runtime", "gateway"].map(
      (name) => [name, `registry.example.test/home-${name}@sha256:${"b".repeat(64)}`],
    ),
  );
  payload = CloudComputerBootResponseSchema.parse({
    hostname,
    accountOrigin,
    setupCodeDigest: "a".repeat(64),
    release: { version, images },
    ipv6Enabled: true,
    restoreSnapshot: "f".repeat(64),
    managedHome: {
      cloudComputerId: id,
      generation: 2,
      oidc,
    },
    egress: {
      url: "https://isp.example.test:3128",
      username: "home-user",
      password: "fixture-egress",
    },
    backup: {
      endpoint: "https://storage.example.test",
      bucket: "homes",
      prefix: id,
      repository: `s3:https://storage.example.test/homes/${id}`,
      accessKeyId: "home-key",
      secretAccessKey: "fixture-storage",
      password: "fixture-backup",
    },
  });
  const spec = resolve(temp, "boot.json");
  const tokenPath = resolve(temp, "token");
  const output = resolve(temp, "output.json");
  write(
    spec,
    JSON.stringify({
      cloudComputerId: id,
      hostname,
      accountOrigin,
      installerUrl: "https://release.example.test/install.sh",
      installerSha256: "c".repeat(64),
    }),
  );
  write(tokenPath, `${bootstrapToken}\n`);
  // Emulate Linux's root-owned file metadata for this unprivileged test.
  write(
    resolve(temp, "stat"),
    `#!/bin/bash
[[ "$1" == -c && "$2" == '%u:%a' && -f "$3" ]] || exit 1
case $(uname -s) in
  Darwin) mode=$(/usr/bin/stat -f %Lp "$3") ;;
  Linux) mode=$(/usr/bin/stat -c %a "$3") ;;
  *) exit 1 ;;
esac
printf '0:%s\\n' "$mode"
`,
    0o700,
  );
  const env = { ...process.env, PATH: `${temp}:${process.env.PATH}`, CURL_CA_BUNDLE: cert };
  const run = (action, destination, overrides = {}) =>
    exec(
      "bash",
      [resolve(root, "deploy/home/managed-boot.sh"), action, spec, tokenPath, destination],
      { env: { ...env, ...overrides } },
    );
  await assert.rejects(
    run("boot", output, { CURL_CA_BUNDLE: resolve(temp, "missing-ca") }),
    /Account boot request failed/u,
  );
  assert.equal(exchanges, 0);
  await run("boot", output);
  assert.deepEqual(JSON.parse(readFileSync(output)), payload);
  payload = CloudComputerBootResponseSchema.parse({
    ...payload,
    releaseManifestUrl: "https://release.example.test/home/stable.json",
    work: {
      organizationId: `org_${id.slice(3)}`,
      organizationName: "Fixture's Work Home",
      assignmentId: `was_${id.slice(3)}`,
    },
  });
  await run("boot", output);
  assert.deepEqual(JSON.parse(readFileSync(output)), payload);
  assert.equal(exchanges, 2);
  const identityArgument = JSON.stringify(identity);
  await assert.rejects(run("boot-complete", identityArgument), { code: 1 });
  await run("boot-complete", identityArgument);
  assert.equal(acknowledgements, 2);
  await assert.rejects(run("boot", output), (error) => {
    assert.equal(error.code, 78);
    assert.match(error.stderr, /invalid, spent, or expired/u);
    assert.doesNotMatch(error.stderr, new RegExp(bootstrapToken, "u"));
    return true;
  });
  const alias = await app.inject({ method: "POST", url: `/v1/cloud-computers/${id}/bootstrap` });
  assert.equal(alias.statusCode, 404);
  const secrets = resolve(temp, "secrets");
  const secretPath = resolve(secrets, "oidc_client_secret");
  const calls = resolve(temp, "compose-calls");
  const maintain = (overrides = {}) =>
    exec(
      "bash",
      [
        "-c",
        `source deploy/home/common.sh
source deploy/home/managed-egress.sh
compose() { printf '%s\n' "$*" >> "$CALLS"; [[ \${FAIL_COMPOSE:-} != yes ]]; }
maintain_managed_egress`,
      ],
      { cwd: root, env: { ...env, OPENSTEER_HOME_DIR: temp, CALLS: calls, ...overrides } },
    );
  mkdirSync(secrets, { mode: 0o700 });
  write(secretPath, oidc.clientSecret);
  write(
    resolve(temp, "config.env"),
    `OPENSTEER_HOME_ACCOUNT_ORIGIN='${accountOrigin}'
OPENSTEER_HOME_MANAGED_ID='${id}'
OPENSTEER_HOME_OIDC_CLIENT_ID='${oidc.clientId}'
`,
  );
  await maintain();
  assert.equal(egressRequests, 1);
  assert.deepEqual(readdirSync(secrets), ["oidc_client_secret"]);
  assignedEgress = CloudComputerEgressResponseSchema.parse({
    egress: { ...payload.egress, url: "https://isp.example.test/" },
  }).egress;
  await assert.rejects(maintain({ FAIL_COMPOSE: "yes" }), { code: 1 });
  assert.equal(egressRequests, 2);
  assert.equal(
    readFileSync(resolve(secrets, "egress_url"), "utf8"),
    "https://isp.example.test:443\n",
  );
  for (const field of ["url", "username", "password"]) {
    assert.equal(statSync(resolve(secrets, `egress_${field}`)).mode & 0o777, 0o444);
  }
  assert.equal(
    readFileSync(resolve(secrets, "egress_password"), "utf8").trim(),
    assignedEgress.password,
  );
  assert.ok(existsSync(resolve(temp, "egress.pending")));
  const applied = await maintain();
  assert.doesNotMatch(applied.stdout + applied.stderr, /fixture-egress|ocs_/u);
  assert.equal(egressRequests, 2);
  assert.equal(existsSync(resolve(temp, "egress.pending")), false);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 2);
  const releasePath = resolve(temp, "release.json");
  const imagesEnv = resolve(temp, "images.env");
  write(releasePath, JSON.stringify(payload.release));
  execFileSync(
    "bash",
    [
      "-c",
      'source deploy/home/common.sh; release_to_env "$1" "$2" true',
      "test",
      releasePath,
      imagesEnv,
    ],
    { cwd: root },
  );
  assert.match(
    readFileSync(imagesEnv, "utf8"),
    /OPENSTEER_HOME_HOST_IMAGE=registry\.example\.test\/home-host@sha256:/u,
  );
});
