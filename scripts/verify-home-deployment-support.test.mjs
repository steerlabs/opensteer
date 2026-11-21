import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseHostConfig } from "../packages/config/src/config.ts";
import { expandSecretFiles } from "../deploy/container/opensteer-entrypoint.mjs";
import {
  accountFixtureRoute,
  assertBuildSpace,
  builderPlatforms,
  checkoutTemporaryDirectory,
  homeImageBuilds,
  platformSummary,
  quote,
  redact,
  requiredFreeKiB,
  verifierTarget,
} from "./verify-home-deployment-support.mjs";

await test("loads ARM64 for the deployment proof first and builds AMD64 only afterwards", () => {
  const bake = [
    "buildx",
    "bake",
    "--builder",
    "test-builder",
    "-f",
    "deploy/container/docker-bake.hcl",
  ];
  assert.deepEqual(homeImageBuilds("test-builder"), {
    proof: {
      platform: "linux/arm64",
      args: [...bake, "--set", "home-*.platform=linux/arm64", "--load", "home"],
    },
    buildOnly: {
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
  });
  assert.equal(
    platformSummary({ proofPassed: true, buildOnly: false }),
    "The linux/arm64 deployment proof passed; the linux/amd64 Home image build failed.",
  );
  assert.equal(
    platformSummary({ proofPassed: false, buildOnly: undefined }),
    "The linux/arm64 deployment proof did not pass; the linux/amd64 Home image build did not run.",
  );
  assert.equal(
    platformSummary({ proofPassed: true, buildOnly: true }),
    "The linux/arm64 deployment proof passed; the linux/amd64 Home image build passed.",
  );
});

await test("the Colima target is the default and keeps its socket, root shell and ARM64 proof", () => {
  const target = verifierTarget({
    env: {},
    home: "/Users/proof",
    os: "darwin",
    arch: "arm64",
    builder: "test-builder",
  });
  assert.deepEqual(target, {
    name: "colima",
    dockerHost: "unix:///Users/timjang/.colima/default/docker.sock",
    rootShell: ["colima", ["ssh", "--", "sudo", "-n", "bash", "-s"]],
    shellLabel: "Colima",
    checkoutLabel: "macOS",
    builderDirectory: "/Users/proof/.colima/test-builder",
    checkoutSpacePath: "/Users/proof/.colima",
    fixtureHost: "host.lima.internal",
    fixtureRoute: "forward-to-fixture-host",
    proofPlatform: "linux/arm64",
    requireBuilderPlatform: false,
  });
  assert.deepEqual(
    verifierTarget({
      env: { OPENSTEER_HOME_VERIFIER_TARGET: "colima" },
      home: "/Users/proof",
      os: "darwin",
      arch: "arm64",
      builder: "test-builder",
    }),
    target,
  );
});

await test("the local target uses this Linux machine's Docker, sudo and native platform", () => {
  const local = (arch, os = "linux") =>
    verifierTarget({
      env: { OPENSTEER_HOME_VERIFIER_TARGET: "local" },
      home: "/home/proof",
      os,
      arch,
      builder: "test-builder",
    });
  assert.deepEqual(local("x64"), {
    name: "local",
    dockerHost: "unix:///var/run/docker.sock",
    rootShell: ["sudo", ["-n", "bash", "-s"]],
    shellLabel: "Local root shell",
    checkoutLabel: "Linux",
    builderDirectory: "/home/proof/.cache/test-builder",
    checkoutSpacePath: "/home/proof/.cache/test-builder",
    fixtureHost: "localhost",
    fixtureRoute: "local-address",
    proofPlatform: "linux/amd64",
    requireBuilderPlatform: true,
  });
  assert.equal(local("arm64").proofPlatform, "linux/arm64");
  assert.throws(() => local("x64", "darwin"), /runs on the Linux machine it verifies/u);
  assert.throws(() => local("ia32"), /no image platform for ia32/u);
  assert.throws(
    () =>
      verifierTarget({
        env: { OPENSTEER_HOME_VERIFIER_TARGET: "remote" },
        home: "/home/proof",
        os: "linux",
        arch: "x64",
        builder: "test-builder",
      }),
    /must be colima or local, not remote/u,
  );
});

await test("an AMD64 proof loads AMD64 and builds ARM64 only afterwards", () => {
  const builds = homeImageBuilds("test-builder", "linux/amd64");
  assert.equal(builds.proof.platform, "linux/amd64");
  assert.deepEqual(builds.proof.args.slice(-4), [
    "--set",
    "home-*.platform=linux/amd64",
    "--load",
    "home",
  ]);
  assert.equal(builds.buildOnly.platform, "linux/arm64");
  assert.ok(builds.buildOnly.args.includes("home-*.platform=linux/arm64"));
  assert.ok(builds.buildOnly.args.includes("home-*.output=type=cacheonly"));
  assert.equal(
    platformSummary({
      proofPassed: true,
      buildOnly: undefined,
      proofPlatform: "linux/amd64",
      buildOnlyPlatform: "linux/arm64",
    }),
    "The linux/amd64 deployment proof passed; the linux/arm64 Home image build did not run.",
  );
});

await test("builder platforms are read from buildx inspect, including default markers", () => {
  const inspected = [
    "Name:          opensteer-home-verifier",
    "Driver:        docker-container",
    "Nodes:",
    "Name:                  opensteer-home-verifier0",
    "Status:                running",
    "Platforms:             linux/amd64*, linux/amd64/v2, linux/amd64/v3, linux/386",
  ].join("\n");
  assert.deepEqual(builderPlatforms(inspected), [
    "linux/amd64",
    "linux/amd64/v2",
    "linux/amd64/v3",
    "linux/386",
  ]);
  assert.ok(!builderPlatforms(inspected).includes("linux/arm64"));
  assert.deepEqual(builderPlatforms("Name: stopped"), []);
});

await test("the verifier's working directory is created in a fresh checkout without .opensteer", () => {
  const checkout = mkdtempSync(resolve(tmpdir(), "home-proof-checkout-"));
  try {
    const directory = checkoutTemporaryDirectory(checkout);
    assert.ok(directory.startsWith(resolve(checkout, ".opensteer", "home-proof-")));
    assert.ok(existsSync(directory));
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

await test("the verifier fetches and removes the PostgreSQL image the Compose recipe pins", () => {
  const verifier = readFileSync(resolve(import.meta.dirname, "verify-home-deployment.mjs"), "utf8");
  const recipe = readFileSync(resolve(import.meta.dirname, "../deploy/home/compose.yaml"), "utf8");
  const pinned = recipe.match(/^ {4}image: (postgres:\S+)$/mu)?.[1];
  assert.ok(pinned);
  assert.ok(
    verifier.includes(`"${pinned}"`),
    "The verifier's postgresImage must match compose.yaml",
  );
  assert.match(verifier, /docker\(\["pull", "--quiet", postgresImage\]\)/u);
});

await test("the Host CDP fixture finds its anchor after the bundler renames the local", async () => {
  const { injectCdpFixture } = await import("./verify-home-deployment-cdp.mjs");
  for (const name of ["address", "address2"]) {
    const bundled = `async function main() {\n  const ${name} = await runtime.listen();\n  log(${name});\n}`;
    assert.equal(
      injectCdpFixture(bundled),
      `async function main() {\n  const ${name} = await runtime.listen();\nglobalThis.opensteerHomeProofCdp(runtime);\n  log(${name});\n}`,
    );
  }
  assert.throws(() => injectCdpFixture("await runtime.start();"), /fixture anchor/u);
});

await test("the Account fixture's public-looking address is local on Linux and forwarded on Colima", () => {
  const local = verifierTarget({
    env: { OPENSTEER_HOME_VERIFIER_TARGET: "local" },
    home: "/home/proof",
    os: "linux",
    arch: "x64",
    builder: "test-builder",
  });
  assert.deepEqual(accountFixtureRoute(local, "11.1.2.3", 4000), {
    add: "ip address add 11.1.2.3/32 dev lo",
    remove: "ip address del 11.1.2.3/32 dev lo",
  });
  const colima = verifierTarget({
    env: {},
    home: "/Users/proof",
    os: "darwin",
    arch: "arm64",
    builder: "test-builder",
  });
  const route = accountFixtureRoute(colima, "11.1.2.3", 4000);
  for (const chain of ["OUTPUT", "PREROUTING"]) {
    assert.match(
      route.add,
      new RegExp(
        `iptables -t nat -I ${chain} -d 11\\.1\\.2\\.3/32 -p tcp --dport 4000 -j DNAT`,
        "u",
      ),
    );
    assert.match(route.remove, new RegExp(`iptables -t nat -D ${chain} -d 11\\.1\\.2\\.3/32`, "u"));
  }
  assert.match(route.add, /getent ahostsv4 host\.lima\.internal/u);
});

await test("the managed proof claims through the Account and never signs in with a password", () => {
  const verifier = readFileSync(resolve(import.meta.dirname, "verify-home-deployment.mjs"), "utf8");
  const managed = verifier.slice(verifier.indexOf("async function managedProof("));
  const body = managed.slice(0, managed.indexOf("\nfunction prepareBuilder("));
  assert.doesNotMatch(body, /auth\.password\.signIn|auth\.setup\.(exchange|claim)/u);
  assert.match(body, /managedHome: \{ cloudComputerId/u);
  assert.match(body, /accountClaim\(api, generations\[0\]/u);
  assert.match(body, /accountClaim\(restoredApi, generations\[1\]/u);
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

function runHome(script) {
  return spawnSync(
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

const releaseManifest = (version, tag) =>
  JSON.stringify({
    version,
    images: Object.fromEntries(
      ["host", "gateway", "runner", "browser-runtime", "browser-egress", "channel-runtime"].map(
        (service) => [service, `local/opensteer-home-${service}:${tag}`],
      ),
    ),
  });

await test("the installer run again installs a new manifest only on a Home that was never claimed", () => {
  const setup = (state) => `
    printf '%s\\n' ${quote(releaseManifest("1.0.0", "old"))} > "$home_dir/old.json"
    printf '%s\\n' ${quote(releaseManifest("1.0.1", "new"))} > "$home_dir/new.json"
    release_to_env "$home_dir/old.json" "$home_dir/images.env" false
    cp "$home_dir/images.env" "$home_dir/images.before"
    compose() {
      case $1 in
        ps) ${state === "running-claimed" || state === "running-unclaimed" ? "echo hostcontainer" : ":"} ;;
        config) printf '%s' '{"volumes":{"postgres-data":{"name":"proof_postgres-data"}}}' ;;
      esac
    }
    claimed_state() { echo ${state === "running-claimed" ? "complete" : "required"}; }
    docker() { ${state === "stopped-with-database" ? "true" : "false"}; }
  `;
  const claimed = runHome(`${setup("running-claimed")}
    (reinstall_release "$home_dir/new.json") || { cmp -s "$home_dir/images.env" "$home_dir/images.before" && echo unchanged; exit 3; }`);
  assert.equal(claimed.status, 3);
  assert.equal(claimed.stdout, "unchanged\n");
  assert.match(
    claimed.stderr,
    /This Home is already claimed, so the installer will not replace its release\. Change its release with: sudo opensteer-home update \/.*\/new\.json\. Or remove it with: sudo opensteer-home uninstall --purge/u,
  );
  for (const state of ["running-unclaimed", "never-started"]) {
    const applied = runHome(`${setup(state)}
      reinstall_release "$home_dir/new.json"
      cat "$home_dir/images.env"`);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /^This Home was never claimed\. Installing the release in /u);
    assert.match(applied.stdout, /OPENSTEER_HOME_VERSION=1\.0\.1\n/u);
    assert.match(applied.stdout, /OPENSTEER_HOME_HOST_IMAGE=local\/opensteer-home-host:new\n/u);
  }
  const unknown = runHome(`${setup("stopped-with-database")}
    reinstall_release "$home_dir/new.json"`);
  assert.notEqual(unknown.status, 0);
  assert.match(
    unknown.stderr,
    /Could not tell whether this Home was claimed\. Start it with: sudo opensteer-home start\. Or remove it with: sudo opensteer-home uninstall --purge/u,
  );
});

await test("the installer refuses --local-images for a managed boot and installs the operator command first", () => {
  const installer = readFileSync("deploy/home/install.sh", "utf8");
  const operator = installer.indexOf(
    'install -m 0755 "$home_dir/opensteer-home" /usr/local/bin/opensteer-home',
  );
  assert.ok(operator > 0);
  for (const later of [
    'release_to_env "$manifest"',
    'publish_file "$staging/config.env"',
    "fetch_release_images",
  ])
    assert.ok(
      installer.indexOf(later) > operator,
      `${later} runs before the operator command exists`,
    );
  assert.match(
    installer,
    /\[\[ -z \$hostname && -z \$manifest && -n \$token_path \]\] && ! \$local_images \|\| usage/u,
  );
  const home = readFileSync("deploy/home/opensteer-home", "utf8");
  assert.match(home, /\$\{1:-\} == uninstall && -d \$home_dir/u);
  assert.match(home, /if \[\[ -f "\$home_dir\/config\.env" \]\]; then compose down --volumes; fi/u);
});

await test("a Home installed with local images checks the machine's images instead of pulling them", () => {
  const composeConfig = JSON.stringify({
    services: Object.fromEntries(
      ["host", "gateway", "runner", "browser-runtime", "browser-egress", "channel-runtime"].map(
        (service) => [service, { image: `local/opensteer-home-${service}:1.2.3` }],
      ),
    ),
  });
  const stubs = `
    compose() {
      if [[ $1 == config ]]; then printf '%s' ${quote(composeConfig)}; else echo "compose $*"; fi
    }
    check_release_stamps() { echo "stamps $1"; }
  `;
  const pulled = runHome(`${stubs}
    docker() { echo "docker $*"; }
    fetch_release_images "$home_dir/images.env"`);
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.equal(pulled.stdout, "compose pull --quiet\n");
  const local = runHome(`${stubs}
    touch "$home_dir/local-images"
    docker() { [[ $1 == image && $2 == inspect ]]; }
    fetch_release_images "$home_dir/images.env"`);
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /^compose pull --quiet postgres\nstamps \/.*\/images\.env\n$/u);
  const missing = runHome(`${stubs}
    touch "$home_dir/local-images"
    docker() { [[ $3 != local/opensteer-home-runner:1.2.3 && $3 != local/opensteer-home-host:1.2.3 ]]; }
    fetch_release_images "$home_dir/images.env"`);
  assert.notEqual(missing.status, 0);
  assert.match(
    missing.stderr,
    /These Home images are not on this machine: local\/opensteer-home-host:1\.2\.3 local\/opensteer-home-runner:1\.2\.3\. Build them with: sudo bash deploy\/home\/build-images\.sh/u,
  );
  assert.doesNotMatch(missing.stdout, /stamps/u);
});

const backupHarness = (restic) => `
    source deploy/home/backup.sh
    backup_config() { :; }
    restore_state() { volume_set=proof; identity_secrets="$home_dir"; }
    compose() {
      if [[ $1 == config ]]; then printf '%s' '{"name":"proof","services":{"gateway":{"environment":{"OPENSTEER_HOME_HOSTNAME":"home.example.test"}}}}'
      else echo "compose $*"; fi
    }
    durable_marker() { :; }
    postgres_tool() { echo database; }
    start_pod() { echo started; }
    touch "$home_dir/auth_secret" "$home_dir/environment_id"
    action=backup
    restic_container() {
      ${restic}
    }
    backup_command backup
`;

await test("a backup whose repository cannot be reached fails before it stops the Home", () => {
  const unreachable = runHome(
    backupHarness(`
      if [[ $1 == *"probe snapshots"* ]]; then
        echo 'Fatal: unable to open config file: Stat: dial tcp 192.0.2.1:443: connect: connection refused' >&2
        return 1
      fi
      echo "unexpected restic $*"`),
  );
  assert.notEqual(unreachable.status, 0);
  assert.doesNotMatch(unreachable.stdout, /compose stop|database|started|unexpected/u);
  assert.match(
    unreachable.stdout,
    /^Checking that the backup repository can be reached and written\.\n$/u,
  );
  assert.match(unreachable.stderr, /connection refused/u);
  assert.match(
    unreachable.stderr,
    /The backup repository could not be reached or written\. The Home was not stopped\./u,
  );
});

await test("a backup shows its progress and says it started the Home again after a late failure", () => {
  const status = JSON.stringify({
    message_type: "status",
    percent_done: 0.5,
    files_done: 3,
    total_files: 6,
  });
  const summary = JSON.stringify({ message_type: "summary", snapshot_id: "0123abcd" });
  const saved = runHome(
    backupHarness(`
      if [[ $1 == *"probe snapshots"* ]]; then return 0; fi
      printf '%s\\n%s\\n' ${quote(status)} ${quote(summary)}`),
  );
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(
    saved.stdout,
    [
      "Checking that the backup repository can be reached and written.",
      "Stopping Home services to capture the database and files together.",
      "compose stop host gateway runner browser-runtime browser-egress channel-runtime",
      "Saving the database.",
      "Uploading the encrypted snapshot.",
      "Uploaded 50% (3 of 6 files)",
      "snapshot 0123abcd saved",
      "Starting Home services.",
      "started",
      "",
    ].join("\n"),
  );
  const failed = runHome(
    backupHarness(`
      if [[ $1 == *"probe snapshots"* ]]; then return 0; fi
      echo 'Fatal: unable to save snapshot: connection reset by peer' >&2
      return 1`),
  );
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /compose stop .*\n.*started\n$/su);
  assert.match(
    failed.stderr,
    /connection reset by peer\nThe backup did not finish after Home services were stopped\. Starting them again\.\nHome services were started again\.\n/u,
  );
});

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
