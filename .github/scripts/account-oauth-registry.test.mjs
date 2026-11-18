import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseAllDocuments } from "yaml";

const root = new URL("../../", import.meta.url).pathname;
const script = path.join(root, ".github/scripts/account-oauth-registry.ts");
const tsx = path.join(root, "node_modules/.bin/tsx");
const manifest = readFileSync(path.join(root, "deploy/account/account.yaml"), "utf8");
const template = JSON.parse(
  readFileSync(path.join(root, "deploy/account/oauth-providers.json"), "utf8"),
);
const [, project, version] =
  /projects\/([a-z0-9-]+)\/secrets\/opensteer-account-runtime\/versions\/([0-9]+)"/u.exec(manifest);

// Made-up values: the keys the Account init container requires, plus the managed provider registry.
const runtime = {
  OPENSTEER_ADOPTION_OPERATION_KEY: "fake-adoption-key-0001",
  OPENSTEER_PERSONAL_ACCOUNT_LINK_OPERATION_KEY: "fake-link-key-0002",
  OPENSTEER_GOOGLE_CLIENT_ID: "fake-account-google-id-0003",
  OPENSTEER_GOOGLE_CLIENT_SECRET: "fake-account-google-secret-0004",
  OPENSTEER_HOSTED_OAUTH_STATE_KEY: "fake-state-key-0005",
  OPENSTEER_HOSTED_OAUTH_ENCRYPTION_KEY: "fake-encryption-key-0006",
  OPENSTEER_CONNECT_CLOUDFLARE_ACCOUNT_ID: "fake-cloudflare-account-0007",
  OPENSTEER_CONNECT_CLOUDFLARE_API_TOKEN: "fake-cloudflare-token-0008",
  OPENSTEER_CONNECT_CLOUDFLARE_ZONE_ID: "fake-cloudflare-zone-0009",
  OPENSTEER_CONNECT_CREDENTIAL_DERIVATION_SECRET: "fake-derivation-secret-0010",
  OPENSTEER_APNS_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\nfake-apns-0011\n-----END PRIVATE KEY-----\n",
  OPENSTEER_APPLE_SIGN_IN_PRIVATE_KEY: 'fake-apple-key-0012 "quoted" ünïcode',
};
const registryKey = "OPENSTEER_HOSTED_OAUTH_PROVIDERS";
const registry = template.map((entry, index) => ({
  ...entry,
  revision: entry.revision + index,
  clientId: `fake-${entry.provider}-id-${index}`,
  clientSecret: `fake-${entry.provider}-secret-${index}`,
  ...(entry.provider === "github"
    ? { installationUrl: "https://github.com/apps/test-app/installations/new" }
    : {}),
}));
const legacyEntry = (entry) => ({
  ...entry,
  oauth: {
    ...entry.oauth,
    identity: {
      source: "userinfo",
      userinfoUrl: "https://provider.example.test/userinfo",
      identityPath: "sub",
    },
  },
});
const legacyDocument = (entries) => ({
  ...runtime,
  [registryKey]: JSON.stringify(entries.map(legacyEntry)),
});

// A fake gcloud that serves one secret version and records what it was asked and given.
function fixture(document) {
  const dir = mkdtempSync(path.join(tmpdir(), "account-oauth-registry-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(dir, "secret.json"), JSON.stringify(document, null, 2));
  writeFileSync(
    path.join(bin, "gcloud"),
    `#!/usr/bin/env bash
set -eu
echo "$*" >> "$FAKE_DIR/calls"
case "$*" in
  "secrets versions access "*) cat "$FAKE_DIR/secret.json" ;;
  "secrets versions add "*)
    cat > "$FAKE_DIR/added"
    echo "projects/123456/secrets/opensteer-account-runtime/versions/$((${version} + 1))" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  const file = (name) =>
    existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8") : "";
  const run = (...args) => {
    const result = spawnSync(tsx, [script, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, FAKE_DIR: dir, PATH: `${bin}:${process.env.PATH}` },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: file("calls"),
      added: file("added"),
    };
  };
  return { dir, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function assertNoSecrets(result, document) {
  const values = Object.values(document).filter((value) => value.length > 1);
  // A plain value can leak even if the full registry string does not.
  values.push(...(document[registryKey]?.match(/fake-[a-z]+-(?:id|secret)-[0-9]+/gu) ?? []));
  for (const value of values) {
    assert.ok(!result.stdout.includes(value), "stdout carries a secret value");
    assert.ok(!result.stderr.includes(value), "stderr carries a secret value");
  }
}

// The init container's own script, run against a document as the CSI driver would mount it.
function expandRuntimeSecrets(dir, added) {
  const deployment = parseAllDocuments(manifest)
    .map((document) => document.toJS())
    .find((document) => document?.kind === "Deployment");
  const init = deployment.spec.template.spec.initContainers.find(
    ({ name }) => name === "expand-runtime-secrets",
  );
  const raw = path.join(dir, "raw");
  const out = path.join(dir, "runtime");
  mkdirSync(raw);
  writeFileSync(path.join(raw, "account-runtime.json"), added);
  writeFileSync(path.join(raw, "account-auth"), "fake-auth");
  writeFileSync(path.join(raw, "account-app-review"), "fake-review");
  const source = init.args[0]
    .replaceAll("/var/run/opensteer-raw", raw)
    .replaceAll("/var/run/opensteer-runtime", out);
  const result = spawnSync(init.command[0], [...init.command.slice(1), source], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return (key) => readFileSync(path.join(out, "secrets", key), "utf8");
}

test("adds a version without the obsolete identity fields and preserves existing settings", () => {
  const document = legacyDocument(registry);
  const f = fixture(document);
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      "Validated providers: google, microsoft, slack, discord, github\n" +
        `Added opensteer-account-runtime version ${Number(version) + 1}\n`,
    );
    assert.equal(
      result.calls,
      `secrets versions access ${version} --secret=opensteer-account-runtime --project=${project}\n` +
        `secrets versions add opensteer-account-runtime --project=${project} --data-file=- --format=value(name)\n`,
    );
    assertNoSecrets(result, document);

    const added = JSON.parse(result.added);
    const { [registryKey]: updated, ...rest } = added;
    assert.deepEqual(Object.entries(rest), Object.entries(runtime));
    assert.deepEqual(JSON.parse(updated), registry);

    const expanded = expandRuntimeSecrets(f.dir, result.added);
    assert.equal(expanded(registryKey), updated);
    assert.equal(
      expanded("OPENSTEER_APPLE_SIGN_IN_PRIVATE_KEY"),
      runtime.OPENSTEER_APPLE_SIGN_IN_PRIVATE_KEY,
    );
  } finally {
    f.cleanup();
  }
});

test("a dry run names the validated providers and adds nothing", () => {
  const document = legacyDocument(registry.slice(0, 1));
  const f = fixture(document);
  try {
    const result = f.run("--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Validated providers: google\nDry run: no version added\n");
    assert.doesNotMatch(result.calls, /versions add/);
    assert.equal(result.added, "");
    assertNoSecrets(result, document);
  } finally {
    f.cleanup();
  }
});

test("refuses a registry the service would reject, without adding or printing a value", () => {
  // A GitHub App without its installation URL fails the service's own registry schema.
  const { installationUrl: _installationUrl, ...github } = registry.at(-1);
  const document = legacyDocument([github]);
  const f = fixture(document);
  try {
    const result = f.run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /The registry is invalid:\n {2}entry 1: Hosted OAuth GitHub requires its exact installation URL/,
    );
    assert.doesNotMatch(result.calls, /versions add/);
    assertNoSecrets(result, document);
  } finally {
    f.cleanup();
  }
});

test("refuses a missing, malformed or incomplete source registry", () => {
  const { clientSecret: _clientSecret, ...incomplete } = registry[0];
  for (const [document, message] of [
    [runtime, /missing OPENSTEER_HOSTED_OAUTH_PROVIDERS/],
    [{ ...runtime, [registryKey]: "broken JSON" }, /is not JSON/],
    [{ ...runtime, [registryKey]: "[]" }, /not a nonempty provider registry/],
    [legacyDocument([incomplete]), /The registry is invalid:\n {2}entry 1: invalid_type/],
  ]) {
    const f = fixture(document);
    try {
      const result = f.run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.calls, /versions add/);
      assertNoSecrets(result, document);
    } finally {
      f.cleanup();
    }
  }
});
