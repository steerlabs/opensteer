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

// Made-up values: the keys the Account init container requires, plus the retired per-provider
// OAuth apps the registry is built from.
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
const apps = {
  OPENSTEER_HOSTED_OAUTH_GOOGLE_CLIENT_ID: "fake-google-id-1001.apps.example",
  OPENSTEER_HOSTED_OAUTH_GOOGLE_CLIENT_SECRET: "fake-google-secret-1002",
  OPENSTEER_HOSTED_OAUTH_GOOGLE_REVISION: "3",
  OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_ID: "fake-slack-id-1003",
  OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_SECRET: "fake-slack-secret-1004",
  OPENSTEER_HOSTED_OAUTH_SLACK_REVISION: "2",
  OPENSTEER_HOSTED_OAUTH_MICROSOFT_CLIENT_ID: "fake-microsoft-id-1005",
  OPENSTEER_HOSTED_OAUTH_MICROSOFT_CLIENT_SECRET: "fake-microsoft-secret-1006",
  OPENSTEER_HOSTED_OAUTH_MICROSOFT_REVISION: "1",
  OPENSTEER_HOSTED_OAUTH_DISCORD_CLIENT_ID: "fake-discord-id-1007",
  OPENSTEER_HOSTED_OAUTH_DISCORD_CLIENT_SECRET: "fake-discord-secret-1008",
  OPENSTEER_HOSTED_OAUTH_DISCORD_REVISION: "1",
};
const values = (document) => Object.values(document).filter((value) => value.length > 1);

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
  for (const value of values(document)) {
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

test("adds a version with the registry joined from the existing apps and no retired keys", () => {
  const document = { ...runtime, ...apps };
  const f = fixture(document);
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      "Included: google, microsoft, slack, discord\n" +
        "Skipped, no credentials: github\n" +
        `Added opensteer-account-runtime version ${Number(version) + 1}\n`,
    );
    assert.equal(
      result.calls,
      `secrets versions access ${version} --secret=opensteer-account-runtime --project=${project}\n` +
        `secrets versions add opensteer-account-runtime --project=${project} --data-file=- --format=value(name)\n`,
    );
    assertNoSecrets(result, document);

    const added = JSON.parse(result.added);
    const { OPENSTEER_HOSTED_OAUTH_PROVIDERS: registry, ...rest } = added;
    // Every other key is carried unchanged, in order; the retired per-provider keys are gone.
    assert.deepEqual(Object.entries(rest), Object.entries(runtime));
    const credentials = (provider) => ({
      clientId: apps[`OPENSTEER_HOSTED_OAUTH_${provider.toUpperCase()}_CLIENT_ID`],
      clientSecret: apps[`OPENSTEER_HOSTED_OAUTH_${provider.toUpperCase()}_CLIENT_SECRET`],
    });
    assert.deepEqual(
      JSON.parse(registry),
      template
        .filter(({ provider }) => provider !== "github")
        .map((entry) => ({ ...entry, ...credentials(entry.provider) })),
    );

    // The init container in account.yaml still expands the new document.
    const expanded = expandRuntimeSecrets(f.dir, result.added);
    assert.equal(expanded("OPENSTEER_HOSTED_OAUTH_PROVIDERS"), registry);
    assert.equal(
      expanded("OPENSTEER_APPLE_SIGN_IN_PRIVATE_KEY"),
      runtime.OPENSTEER_APPLE_SIGN_IN_PRIVATE_KEY,
    );
  } finally {
    f.cleanup();
  }
});

test("a dry run names included and skipped providers and adds nothing", () => {
  const document = {
    ...runtime,
    OPENSTEER_HOSTED_OAUTH_GOOGLE_CLIENT_ID: apps.OPENSTEER_HOSTED_OAUTH_GOOGLE_CLIENT_ID,
    OPENSTEER_HOSTED_OAUTH_GOOGLE_CLIENT_SECRET: apps.OPENSTEER_HOSTED_OAUTH_GOOGLE_CLIENT_SECRET,
    OPENSTEER_HOSTED_OAUTH_DISCORD_REVISION: "1",
  };
  const f = fixture(document);
  try {
    const result = f.run("--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      "Included: google\n" +
        "Skipped, no credentials: microsoft, slack, discord, github\n" +
        "Dry run: no version added\n",
    );
    assert.doesNotMatch(result.calls, /versions add/);
    assert.equal(result.added, "");
    assertNoSecrets(result, document);
  } finally {
    f.cleanup();
  }
});

test("refuses a registry the service would reject, without adding or printing a value", () => {
  // A GitHub App without its installation URL fails the service's own registry schema.
  const document = {
    ...runtime,
    ...apps,
    OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_ID: "fake-github-id-1009",
    OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_SECRET: "fake-github-secret-1010",
  };
  const f = fixture(document);
  try {
    const result = f.run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /The registry is invalid:\n {2}github: Hosted OAuth GitHub requires its exact installation URL/,
    );
    assert.doesNotMatch(result.calls, /versions add/);
    assertNoSecrets(result, document);
  } finally {
    f.cleanup();
  }
});

test("refuses half an app's credentials and a secret that already has a registry", () => {
  for (const [document, message] of [
    [
      {
        ...runtime,
        OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_ID: apps.OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_ID,
      },
      /slack has only one of OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_ID and _CLIENT_SECRET/,
    ],
    [
      { ...runtime, ...apps, OPENSTEER_HOSTED_OAUTH_PROVIDERS: "[]" },
      /already has OPENSTEER_HOSTED_OAUTH_PROVIDERS/,
    ],
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
