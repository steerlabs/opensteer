import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseHostConfig } from "../packages/config/src/config.ts";
import { expandSecretFiles } from "../deploy/container/opensteer-entrypoint.mjs";
import {
  assertBuildSpace,
  quote,
  redact,
  requiredFreeKiB,
} from "./verify-home-deployment-support.mjs";

test("Colima test input keeps whitespace, quotes and shell metacharacters literal", () => {
  const value = "'a b' `printf substituted` $(printf substituted)\n--arg";
  const output = execFileSync("bash", ["-c", `printf '%s' ${quote(value)}`], { encoding: "utf8" });
  assert.equal(output, value);
});

test("diagnostics redact setup tokens and preserve other error text", () => {
  assert.equal(
    redact(
      "First: https://home.example/setup#token=a.B_c-d\nsecond: /v1/browser/connect/fixture-ticket 401",
    ),
    "First: https://home.example/setup#token=[redacted]\nsecond: /v1/browser/connect/[redacted] 401",
  );
});

test("build preflight checks every backing filesystem, including paths with spaces", () => {
  const df = (...rows) =>
    ["Filesystem 1024-blocks Used Available Capacity Mounted on", ...rows].join("\n");
  const row = (available, mount) => `/dev/disk 999999999 1000 ${available} 20% ${mount}`;
  assert.doesNotThrow(() => assertBuildSpace("macOS", df(row(requiredFreeKiB, "/Home VM"))));
  assert.throws(
    () => assertBuildSpace("Colima", df(row(requiredFreeKiB, "/"), row(1024, "/var/lib/docker"))),
    /Colima \(\/var\/lib\/docker\) has 0.0 GiB free/u,
  );
  assert.throws(() => assertBuildSpace("Colima", df()), /No filesystem usage/u);
  assert.throws(() => assertBuildSpace("Colima", df("malformed")), /Cannot parse/u);
});

test("restore rollback reselects the previous volume set before restarting the Home", () => {
  const output = execFileSync(
    "bash",
    [
      "-c",
      `
    set -euo pipefail
    home_dir=$(mktemp -d)
    trap 'rm -rf -- "$home_dir"' EXIT
    source deploy/home/backup.sh
    mkdir -p "$home_dir/restore.pending" "$home_dir/identity/staging"
    journal=$home_dir/restore.pending
    echo staging > "$journal/volume-set"
    echo OPENSTEER_HOME_VOLUME_SET=previous > "$journal/previous.env"
    echo OPENSTEER_HOME_VOLUME_SET=staging > "$home_dir/volumes.env"
    cp "$home_dir/volumes.env" "$home_dir/identity/staging/volumes.env"
    touch "$journal/cutover"
    compose() { printf '%s %s\\n' "\${stage_project:-live}" "$*"; }
    docker() { [[ $* == 'volume inspect staging_host-data' ]] || [[ $* == 'volume rm staging_host-data' ]]; }
    start_pod() { cat "$home_dir/volumes.env"; }
    restore_rollback
    test ! -e "$journal" && test ! -e "$home_dir/identity/staging"
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(output, "live down\nOPENSTEER_HOME_VOLUME_SET=previous\nstaging down --volumes\n");
});

test("the image expands the upstream address and leaves the password and CA files for egress to read", async (t) => {
  const temp = mkdtempSync(resolve(tmpdir(), "home-egress-files-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const url = resolve(temp, "url");
  const username = resolve(temp, "username");
  writeFileSync(url, "https://proxy.example.test:443\n");
  writeFileSync(username, "fixture\n");
  const env = {
    OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL_FILE: url,
    OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME_FILE: username,
    OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD_FILE: resolve(temp, "password"),
    OPENSTEER_BROWSER_EGRESS_UPSTREAM_CA_FILE: resolve(temp, "ca.pem"),
  };
  await expandSecretFiles(env);
  assert.deepEqual(env, {
    OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL: "https://proxy.example.test:443",
    OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME: "fixture",
    OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD_FILE: resolve(temp, "password"),
    OPENSTEER_BROWSER_EGRESS_UPSTREAM_CA_FILE: resolve(temp, "ca.pem"),
  });
});

test("production Host parses file-only enrollment and Account credentials after the image entrypoint", async (t) => {
  const temp = mkdtempSync(resolve(tmpdir(), "home-host-files-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const tokenPath = resolve(temp, "token");
  const secretPath = resolve(temp, "oidc");
  const token = "a".repeat(64);
  const secret = `ocs_${"b".repeat(43)}`;
  writeFileSync(tokenPath, token);
  writeFileSync(secretPath, secret);
  const env = {
    OPENSTEER_MODE: "production",
    OPENSTEER_DEPLOYMENT_KIND: "personal",
    OPENSTEER_CANONICAL_ORIGIN: "https://home.example.test",
    OPENSTEER_DATABASE_URL: "postgresql://localhost/opensteer",
    OPENSTEER_AUTH_SECRET: "a".repeat(64),
    OPENSTEER_SIGNUP_POLICY: "closed",
    OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
    OPENSTEER_BIND_ADDRESS: "127.0.0.1",
    OPENSTEER_HOSTING_ENVIRONMENT_ID: "env_0192f4a1-1111-4000-8000-000000000001",
    OPENSTEER_AGENT_HOME: temp,
    OPENSTEER_HOST_PRIVATE_KEY_PATH: resolve(temp, "host-private.pem"),
    OPENSTEER_HOST_PUBLIC_KEY_PATH: resolve(temp, "host-public.pem"),
    OPENSTEER_WEB_DISTRIBUTION_DIRECTORY: temp,
    OPENSTEER_WEB_DISTRIBUTION_MANIFEST: resolve(temp, "opensteer-web.json"),
    OPENSTEER_HOST_RELEASE_VERSION: "1.0.0",
    OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST: "a".repeat(64),
    OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN_FILE: tokenPath,
    OPENSTEER_MANAGED_HOME_ID: "cc_0192f4a1-1111-4000-8000-000000000001",
    OPENSTEER_MANAGED_HOME_GENERATION: "1",
    OPENSTEER_MANAGED_HOME_ACCOUNT_ORIGIN: "https://accounts.example.test",
    OPENSTEER_MANAGED_HOME_OIDC_CLIENT_ID: "occ_0192f4a1-1111-4000-8000-000000000001",
    OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET_FILE: secretPath,
  };
  await expandSecretFiles(env);
  assert.equal(env.OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN, undefined);
  assert.equal(env.OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET, undefined);
  const config = parseHostConfig(env);
  assert.equal(config.managedHome?.oidc.clientSecret, secret);
});

test("managed installs schedule updates only when Account supplied an HTTPS feed", (t) => {
  const temp = mkdtempSync(resolve(tmpdir(), "home-schedule-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const units = resolve(temp, "units");
  const config = resolve(temp, "config.env");
  mkdirSync(units);
  writeFileSync(resolve(temp, "managed"), "");
  writeFileSync(resolve(temp, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o700 });
  const scheduler = readFileSync("deploy/home/install-scheduler.sh", "utf8").replace(
    "unit_dir=/etc/systemd/system",
    `unit_dir=${quote(units)}`,
  );
  const run = () =>
    execFileSync("bash", ["-c", scheduler, "schedule", temp, "opensteer-home-proof"], {
      env: { ...process.env, PATH: `${temp}:${process.env.PATH}` },
      encoding: "utf8",
    });
  const updateTimer = resolve(units, "opensteer-home-proof-update.timer");
  writeFileSync(
    config,
    "OPENSTEER_HOME_RELEASE_MANIFEST_URL='https://release.example.test/home/stable.json'\n",
  );
  assert.match(run(), /enable --now .*opensteer-home-proof-update\.timer/u);
  assert.match(readFileSync(updateTimer, "utf8"), /OnCalendar=hourly/u);
  writeFileSync(config, "");
  const output = run();
  assert.match(output, /disable --now opensteer-home-proof-update\.timer/u);
  assert.match(
    output,
    /enable --now opensteer-home-proof-backup\.timer opensteer-home-proof-maintain\.timer/u,
  );
  assert.equal(existsSync(updateTimer), false);
});
