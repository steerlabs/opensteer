import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseHostConfig } from "../packages/config/src/config.ts";
import { expandSecretFiles } from "../deploy/container/opensteer-entrypoint.mjs";
import {
  assertBuildSpace,
  homeImageBuilds,
  quote,
  redact,
  requiredFreeKiB,
} from "./verify-home-deployment-support.mjs";

await test("builds AMD64 locally and loads only ARM64 for the Colima deployment proof", () => {
  const bake = [
    "buildx",
    "bake",
    "--builder",
    "test-builder",
    "-f",
    "deploy/container/docker-bake.hcl",
  ];
  assert.deepEqual(homeImageBuilds("test-builder"), [
    {
      platform: "linux/amd64",
      args: [
        ...bake,
        "--set",
        "home-*.platform=linux/amd64",
        "--set",
        "home-*.output=type=cacheonly",
        "home",
      ],
    },
    {
      platform: "linux/arm64",
      args: [...bake, "--set", "home-*.platform=linux/arm64", "--load", "home"],
    },
  ]);
});

await test("Colima test input keeps whitespace, quotes and shell metacharacters literal", () => {
  const value = "'a b' `printf substituted` $(printf substituted)\n--arg";
  const output = execFileSync("bash", ["-c", `printf '%s' ${quote(value)}`], { encoding: "utf8" });
  assert.equal(output, value);
});

await test("diagnostics redact setup tokens and preserve other error text", () => {
  assert.equal(
    redact(
      "First: https://home.example/setup#token=a.B_c-d\nsecond: /v1/browser/connect/fixture-ticket 401",
    ),
    "First: https://home.example/setup#token=[redacted]\nsecond: /v1/browser/connect/[redacted] 401",
  );
});

await test("build preflight checks every backing filesystem, including paths with spaces", () => {
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

const restoreJournal = `
    source deploy/home/backup.sh
    stage=proof-restore-aa1234567890
    mkdir -p "$home_dir/restore.pending" "$home_dir/identity/$stage"
    journal=$home_dir/restore.pending
    echo "$stage" > "$journal/volume-set"
    echo proof > "$journal/previous-set"
    touch "$journal/previous-default" "$journal/cutover"
    restore_selector "$stage" > "$home_dir/volumes.env"
    cp "$home_dir/volumes.env" "$home_dir/identity/$stage/volumes.env"
    compose_project() { echo proof; }
    restore_state() {
      volume_set=proof
      if [[ -f "$home_dir/volumes.env" ]]; then
        volume_set=$(sed -n 's/^OPENSTEER_HOME_VOLUME_SET=//p' "$home_dir/volumes.env")
      fi
    }
`;

const updateJournal = `
    source deploy/home/update.sh
    journal=$home_dir/update.pending
    mkdir "$journal"
    for version in 1 2; do
      selector="$journal/previous.env"
      if [[ $version == 2 ]]; then selector="$journal/candidate.env"; fi
      printf 'OPENSTEER_HOME_VERSION=%s.0.0\n' "$version" > "$selector"
      for service in "\${services[@]}"; do
        printf 'OPENSTEER_HOME_%s_IMAGE=%s:%s\n' "$(echo "$service" | tr 'a-z-' 'A-Z_')" "$service" "$version" >> "$selector"
      done
    done
    cp "$journal/previous.env" "$journal/original.env"
    cp "$journal/candidate.env" "$home_dir/images.env"
`;

function runRecovery(script) {
  return execFileSync(
    "bash",
    [
      "-c",
      `
    set -euo pipefail
    OPENSTEER_HOME_DIR=$(mktemp -d)
    export OPENSTEER_HOME_DIR
    trap 'command rm -rf -- "$OPENSTEER_HOME_DIR"' EXIT
    source deploy/home/common.sh
    sync() { :; }
    ${script}
  `,
    ],
    { encoding: "utf8" },
  );
}

await test("restore rollback reselects the previous volume set before restarting the Home", () => {
  const output = runRecovery(`${restoreJournal}
    compose() { printf '%s %s\\n' "\${stage_project:-live}" "$*"; }
    docker() { [[ "$*" == 'volume inspect proof_'* || "$*" == "volume inspect $stage"_host-data || "$*" == "volume rm $stage"_host-data ]]; }
    start_pod() { test ! -e "$home_dir/volumes.env" && echo previous; }
    restore_rollback
    test ! -e "$journal"
    test ! -e "$home_dir/identity/$stage"
  `);
  assert.equal(output, "live down\nprevious\nproof-restore-aa1234567890 down --volumes\n");
});

await test("interrupted update reselects the previous images without touching the database dump", () => {
  const output = runRecovery(`${updateJournal}
    printf 'manual recovery copy\n' > "$home_dir/update-database.dump"
    compose() { printf '%s %s\n' "$(head -1 "$release_env")" "$*"; }
    install_sandbox_policies() { cmp -s "$journal/previous.env" "$home_dir/images.env"; }
    start_pod() { head -1 "$home_dir/images.env"; }
    update_recovery
    test ! -e "$journal"
    test "$(cat "$home_dir/update-database.dump")" = 'manual recovery copy'
  `);
  assert.match(output, /^OPENSTEER_HOME_VERSION=2\.0\.0 down\nOPENSTEER_HOME_VERSION=1\.0\.0\n/u);
});

for (const { name, fixture, recover, selector } of [
  {
    name: "restore",
    fixture: restoreJournal,
    recover: "restore_rollback",
    selector: "volumes.env",
  },
  { name: "update", fixture: updateJournal, recover: "update_recovery", selector: "images.env" },
]) {
  await test(`interrupted ${name} journal deletion never reopens the cutover`, () => {
    runRecovery(`${fixture}
      touch "$journal/committed"
      cp "$home_dir/${selector}" "$home_dir/expected"
      docker() { [[ $1 == volume && ( $2 == inspect || ( $2 == rm && $3 == proof_* ) ) ]]; }
      compose() { exit 91; }
      start_pod() { exit 92; }
      rm() {
        if [[ "\${!#}" != "$journal"* ]]; then command rm "$@"; return; fi
        command rm -- "\${!#}/committed"
        kill -KILL "$BASHPID"
      }
      if (${recover}) 2>/dev/null; then exit 93; fi
      test ! -e "$journal"
      test -d "$journal.retired"
      test ! -e "$journal.retired/committed"
      unset -f rm
      ${recover}
      test ! -e "$journal.retired"
      cmp "$home_dir/expected" "$home_dir/${selector}"
    `);
  });

  await test(`${name} leaves the journal intact when a durability sync fails`, () => {
    runRecovery(`${fixture}
      touch "$journal/committed"
      docker() { [[ $1 == volume && $2 == inspect ]] || exit 94; }
      rm() { exit 95; }
      sync() { return 1; }
      if ${recover}; then exit 96; fi
      test -f "$journal/committed"
      test ! -e "$journal.retired"
      mv "$journal" "$journal.retired"
      if ${recover}; then exit 97; fi
      test -f "$journal.retired/committed"
    `);
  });

  await test(`${name} leaves both sets in place when the active selector does not match the journal`, () => {
    runRecovery(`${fixture}
      : > "$home_dir/${selector}"
      docker() { exit 94; }
      compose() { exit 95; }
      rm() { exit 96; }
      if ${recover} 2> "$home_dir/error"; then exit 97; fi
      grep -q 'operator intervention is required' "$home_dir/error"
      test -d "$journal"
      test ! -e "$journal.retired"
    `);
  });
}

await test("the image expands the upstream address and leaves the password and CA files for egress to read", async (t) => {
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

await test("production Host parses file-only enrollment and Account credentials after the image entrypoint", async (t) => {
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

await test("the managed scheduler enables the update timer only with a saved feed", (t) => {
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

await test("managed update feed refuses nonpublic addresses, including mixed DNS answers, before curl", () => {
  const script = `source deploy/home/common.sh
    curl() { exit 90; }
    fetch_manifest "$1" /dev/null true`;
  for (const address of ["127.0.0.1", "localhost", "10.0.0.1", "169.254.169.254"]) {
    const refused = spawnSync("bash", ["-c", script, "feed", `https://${address}/manifest.json`], {
      encoding: "utf8",
    });
    assert.equal(refused.status, 1, address);
    assert.match(refused.stderr, /must resolve only to public HTTPS addresses/u);
  }

  const common = readFileSync("deploy/home/common.sh", "utf8");
  const source = common.split("<<'PY'\n")[1].split("\nPY\n")[0];
  for (const address of ["192.168.1.1", "127.0.0.1", "fc00::1", "::ffff:127.0.0.1", "::1"]) {
    const mixed = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        `
import socket
socket.getaddrinfo = lambda *args, **kwargs: [(0, 0, 0, '', ('1.1.1.1', 443)), (0, 0, 0, '', ('${address}', 443))]
${source}
`,
        "https://feed.example.test/manifest.json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(mixed.status, 1, address);
    assert.equal(mixed.stderr, "", address);
  }
});

await test("managed update fetch pins the checked address and disables proxy overrides", () => {
  const args = execFileSync(
    "bash",
    [
      "-c",
      `source deploy/home/common.sh
    curl() { printf '%s\n' "$@"; }
    fetch_manifest https://1.1.1.1:8443/manifest.json /dev/null true`,
    ],
    { encoding: "utf8" },
  ).split("\n");
  assert.equal(args[0], "-q");
  assert.equal(args[args.indexOf("--resolve") + 1], "1.1.1.1:8443:1.1.1.1");
  assert.equal(args[args.indexOf("--noproxy") + 1], "*");
  assert.equal(args[args.indexOf("--") + 1], "https://1.1.1.1:8443/manifest.json");
});
