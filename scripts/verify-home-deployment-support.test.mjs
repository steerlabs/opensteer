import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseHostConfig } from "../packages/config/src/config.ts";
import { expandSecretFiles } from "../deploy/container/opensteer-entrypoint.mjs";
import {
  accountFixtureRoute,
  assertBuildSpace,
  builderPlatforms,
  checkoutTemporaryDirectory,
  installerContents,
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
    dockerHost: "unix:///Users/proof/.colima/default/docker.sock",
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
    remove: "ip address del 11.1.2.3/32 dev lo || true",
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

/** A switch from release a to b that stopped halfway, with an older release c beside them. */
const switchFixture = `
    for name in a b c; do
      mkdir -p "$home_dir/releases/$name"
      printf 'OPENSTEER_HOME_VERSION=1.0.0\nOPENSTEER_HOME_HOST_IMAGE=host:%s\n' "$name" > "$home_dir/releases/$name/images.env"
      # What each pulled or made, by id and name: PostgreSQL's is shared by all three.
      printf 'sha256:%064d postgres:shared\nsha256:%s host:%s\n' 0 "$(printf "$name%.0s" {1..64})" "$name" > "$home_dir/releases/$name/images.ids"
    done
    printf 'manual recovery copy\n' > "$home_dir/releases/b/database.dump"
    printf 'a b\n' > "$home_dir/update.pending"
    current() { ln -sfn "releases/$1" "$home_dir/current"; }
    docker() { echo "docker $*" >> "$home_dir/docker.log"; }
    compose() { echo "compose $*"; }
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

const homeServices = [
  "host",
  "gateway",
  "runner",
  "browser-runtime",
  "browser-egress",
  "channel-runtime",
];

/** An installed Home in a temporary directory, its old release, and stubs that log. */
const installedHome = ({ state = "required", fetch = "ok", start = "ok", running = true } = {}) => `
    log=$(mktemp); staging=$(mktemp -d)
    printf '%s\\n' ${quote(releaseManifest("1.0.0", "old"))} > "$staging/old.json"
    printf '%s\\n' ${quote(releaseManifest("1.0.1", "new"))} > "$staging/new.json"
    mkdir -p "$home_dir/releases/old"
    for name in "\${release_files[@]}" chromium-oci.json runner-oci.json; do echo old > "$home_dir/releases/old/$name"; done
    release_to_env "$staging/old.json" "$home_dir/releases/old/images.env" false
    ln -s releases/old "$home_dir/current"
    printf 'tls internal\\n' > "$home_dir/tls.caddy"
    printf "OPENSTEER_HOME_HOSTNAME=home.example.test\\n" > "$home_dir/config.env"
    mkdir "$staging/run"
    # What a run that changes nothing leaves alone: the Home's files, and the release it runs.
    checksums() {
      readlink "$home_dir/current"
      (cd "$home_dir" && find . -type f ! -path './releases/*' | LC_ALL=C sort | xargs cksum)
      (cd "$home_dir/releases/old" && find . -type f | LC_ALL=C sort | xargs cksum)
    }
    checksums > "$staging/before"
    compose() {
      case $1 in
        config) printf '%s' '{"services":{"gateway":{"environment":{"OPENSTEER_HOME_HOSTNAME":"home.example.test"}}},"volumes":{"postgres-data":{"name":"proof_postgres-data"}}}' ;;
        ps) ${running ? "echo hostcontainer" : ":"} ;;
        *) echo "compose $*" >> "$log" ;;
      esac
    }
    docker() { echo "docker $*" >> "$log"; false; }
    claimed_state() { echo ${state}; }
    fetch_release_images() { echo "fetch $2" >> "$log"; ${fetch === "ok" ? "true" : "false"}; }
    install_sandbox_policies() { echo new > "$release_dir/chromium-oci.json"; echo new > "$release_dir/runner-oci.json"; }
    version_of() { sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$1/images.env"; }
    # The new release's own gate (it runs as root), and the old release started again.
    run_release() { echo "start $(version_of "$1")" >> "$log"; ${start === "ok" ? "true" : "false"}; }
    pin_release() { echo "pin $(version_of "$release_dir")" >> "$log"; }
    plan_inventory() { :; }
    install_units() { echo units >> "$log"; }
    start_pod() { echo "start $(version_of "$release_dir")" >> "$log"; }
    rerun() { (rerun_installed_home "$@" "$(pwd)/deploy/home"); }
    report() { status=$1; checksums > "$staging/after"; if cmp -s "$staging/before" "$staging/after"; then echo unchanged; else echo changed; fi; cat "$log"; echo "status $status"; }
`;

await test("the installer run again on a claimed, managed or mismatched Home changes nothing", () => {
  const cases = [
    {
      setup: installedHome({ state: "complete" }),
      run: 'rerun home.example.test "$staging/new.json" false true',
      message:
        /This Home is already claimed, so the installer will not change it\. Change its release with: sudo opensteer-home update \/.*\/new\.json\. Or remove it with: sudo opensteer-home uninstall --purge\. Nothing was changed\./u,
    },
    {
      setup: `${installedHome()} touch "$home_dir/managed"; checksums > "$staging/before"`,
      run: 'rerun home.example.test "$staging/new.json" false true',
      message:
        /This Home is managed by its Opensteer account; the installer run by hand does not change it\. Nothing was changed\./u,
    },
    {
      setup: installedHome({ state: "complete" }),
      run: "rerun home.example.test '' true true",
      message:
        /--local-images applies to the release given with --manifest\. Nothing was changed\./u,
    },
    {
      setup: installedHome(),
      run: 'rerun other.example.test "$staging/new.json" false true',
      message: /This installation already uses home\.example\.test\. Nothing was changed\./u,
    },
    {
      setup: installedHome(),
      run: 'rerun home.example.test "$staging/new.json" false false',
      message:
        /This Home was installed with --local, and the installer does not change that\. Nothing was changed\./u,
    },
    {
      setup: installedHome({ running: false }),
      run: 'docker() { true; }; rerun home.example.test "$staging/new.json" false true',
      message:
        /Could not tell whether this Home was claimed\. Start it with: sudo opensteer-home start\./u,
    },
    {
      setup: installedHome({ fetch: "fails" }),
      run: 'rerun home.example.test "$staging/new.json" true true',
      message: /The release's images could not be obtained\. Nothing was changed\./u,
      log: "fetch true\n",
    },
    {
      // Without a manifest it reuses the running release's images where they are: no registry.
      setup: installedHome({ fetch: "fails" }),
      run: "rerun home.example.test '' false true",
      message: /The release's images could not be obtained\. Nothing was changed\./u,
      log: "fetch true\n",
    },
    {
      // A switch the last start could not finish (its `previous` is gone): never a second one.
      setup: `${installedHome()} printf 'gone old\\n' > "$home_dir/update.pending"; checksums > "$staging/before"`,
      run: 'rerun home.example.test "$staging/new.json" true true',
      message: /The last switch of releases is not finished yet; start the Home first/u,
    },
  ];
  for (const { setup, run, message, log = "" } of cases) {
    const result = runHome(`${setup}
      ${run} && report 0 || report $?`);
    assert.equal(result.stdout, `unchanged\n${log}status 1\n`, result.stderr);
    assert.match(result.stderr, message);
  }
});

await test("the installer run again on an unclaimed Home replaces it, or puts it back when it does not start", () => {
  const replaced = runHome(`${installedHome()}
    rerun home.example.test "$staging/new.json" true true && status=0 || status=$?
    echo "status $status"; cat "$log"
    sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$home_dir/current/images.env"
    test -f "$home_dir/local-images" && echo local-images
    cmp -s "$home_dir/current/common.sh" deploy/home/common.sh && echo recipe-replaced
    cat "$home_dir/current/runner-oci.json"
    readlink "$home_dir/previous"`);
  assert.equal(
    replaced.stdout,
    [
      "This Home was never claimed. It now runs release 1.0.1.",
      "The setup link printed by the first install still works. Run sudo opensteer-home setup-link for a new one.",
      "status 0",
      "fetch true",
      "pin 1.0.1",
      "compose down",
      "start 1.0.1",
      "units",
      "1.0.1",
      "local-images",
      "recipe-replaced",
      "new",
      "releases/old",
      "",
    ].join("\n"),
    replaced.stderr,
  );
  const restored = runHome(`${installedHome({ start: "new release fails" })}
    rerun home.example.test "$staging/new.json" true true && report 0 || report $?`);
  assert.equal(
    restored.stdout,
    "unchanged\nfetch true\npin 1.0.1\ncompose down\nstart 1.0.1\ncompose down --remove-orphans\nstart 1.0.0\nstatus 1\n",
    restored.stderr,
  );
  assert.match(
    restored.stderr,
    /The new release did not start\. Putting the previous one back\.\nThe Home is back on its previous release\./u,
  );
  // No success without the units every start compares.
  const unitless = runHome(`${installedHome()}
    install_units() { return 1; }
    rerun home.example.test "$staging/new.json" true true && echo "status 0" || echo "status $?"`);
  assert.match(unitless.stdout, /status 1/u);
  assert.match(unitless.stderr, /its units could not be written; run this installer again/u);
});

await test("the installer decides about an installed Home before it writes anything", () => {
  const installer = readFileSync("deploy/home/install.sh", "utf8");
  const rerun = installer.indexOf("rerun_installed_home ");
  assert.ok(rerun > 0);
  for (const write of [
    'install -d -m 0700 "$home_dir/secrets"',
    'release_dir=$(install_release "$source_dir")',
    "/usr/local/bin/opensteer-home",
  ])
    assert.ok(installer.indexOf(write) > rerun, `${write} runs before the rerun is decided`);
  assert.match(
    installer,
    /if \[\[ -z \$managed && -f "\$home_dir\/config\.env" \]\]; then\n  # An installed Home/u,
  );
  assert.match(installer, /if ! \$prepare && owns_operator_command; then/u);
  assert.match(
    installer,
    /\[\[ -z \$hostname && -z \$manifest && -n \$token_path \]\] && ! \$local_images \|\| usage/u,
  );
  assert.match(
    readFileSync("deploy/home/install-scheduler.sh", "utf8"),
    /\[\[ -z \$check \]\] \|\| exit 0\n\n# Only the Home in the default directory owns the command on the path: a link to its current one\.\nif \[\[ \$unit == opensteer-home && \$home_dir == \/etc\/opensteer-home && /u,
  );
});

await test("only the default Home owns the command on the path, and purge removes only its own files", () => {
  const owner = runHome(`
    owns_operator_command && echo temp-owns || echo temp-does-not-own
    home_dir=/etc/opensteer-home; owns_operator_command && echo default-owns
    OPENSTEER_HOME_UNIT_PREFIX=opensteer-home-proof owns_operator_command || echo prefixed-does-not-own`);
  assert.equal(
    owner.stdout,
    "temp-does-not-own\ndefault-owns\nprefixed-does-not-own\n",
    owner.stderr,
  );
  const purged = runHome(`
    mkdir -p "$home_dir/"{secrets,boot,backup.abc123,install.def456,restore.pending.retired,releases/1.0.0-abc123}
    ln -s releases/1.0.0-abc123 "$home_dir/current"; ln -s releases/1.0.0-abc123 "$home_dir/previous"
    touch "$home_dir/"{config.env,backup.resume,local-images,runner-apparmor.name,update.pending,update.waiting,images.env.Xy12Ab} "$home_dir/someone-else.txt"
    printf 'opensteer-home-proof\n' > "$home_dir/unit-prefix"
    installed_unit_prefix
    remove_home_files
    remove_home_files
    installed_unit_prefix
    (cd "$home_dir" && find . -mindepth 1 | LC_ALL=C sort)`);
  assert.equal(purged.status, 0, purged.stderr);
  assert.equal(
    purged.stdout,
    "opensteer-home-proof\nopensteer-home\n./images.env.Xy12Ab\n./someone-else.txt\n",
  );
  const stopped = runHome(`
    compose() { echo "compose $* with $(sed -n 's/^OPENSTEER_HOME_HOST_IMAGE=//p' "$release_env")"; }
    compose_down_home --volumes
    ls "$home_dir" | grep -c placeholder || true`);
  assert.equal(stopped.stdout, "compose down --volumes with placeholder\n0\n", stopped.stderr);
  const apparmor = runHome(`
    printf 'proof-runner-userns\\n' > "$home_dir/runner-apparmor.name"
    apparmor_parser() { echo "unload $*"; return 1; }
    remove_runner_apparmor
    test ! -e "$home_dir/runner-apparmor.name" && echo name-removed`);
  assert.equal(apparmor.status, 0, apparmor.stderr);
  assert.equal(apparmor.stdout, "name-removed\n");
  const home = readFileSync("deploy/home/opensteer-home", "utf8");
  assert.ok(home.indexOf("[[ $EUID == 0 ]]") < home.indexOf('source "${own%/*}/common.sh"'));
  assert.ok(
    home.indexOf("$(stat -c '%u:%a' \"$home_dir\") != 0:700") <
      home.indexOf('source "${own%/*}/common.sh"'),
  );
  assert.match(home, /if owns_operator_command; then rm -f \/usr\/local\/bin\/opensteer-home; fi/u);
  // The command is a release's, and operates the Home whose releases/ holds it.
  assert.match(home, /own=\$\(readlink -f -- "\$0"\)\nhome_dir=\$\{own%\/releases\/\*\}\n/u);
});

await test("a Home installed with local images checks the machine's images instead of pulling them", () => {
  const composeConfig = JSON.stringify({
    services: Object.fromEntries(
      homeServices.map((service) => [service, { image: `local/opensteer-home-${service}:1.2.3` }]),
    ),
  });
  const stubs = `
    compose() {
      if [[ $1 == config ]]; then printf '%s' ${quote(composeConfig)}; else echo "compose $*"; fi
    }
    check_release_stamps() { echo "stamps $1"; }
  `;
  const pulled = runHome(`${stubs}
    touch "$home_dir/local-images"
    docker() { echo "docker $*"; }
    fetch_release_images "$home_dir/images.env" false`);
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.equal(pulled.stdout, "compose pull --quiet\n");
  const local = runHome(`${stubs}
    docker() { [[ $1 == image && $2 == inspect ]]; }
    fetch_release_images "$home_dir/images.env" true`);
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /^compose pull --quiet postgres\nstamps \/.*\/images\.env\n$/u);
  const missing = runHome(`${stubs}
    docker() { [[ $3 != local/opensteer-home-runner:1.2.3 && $3 != local/opensteer-home-host:1.2.3 ]]; }
    fetch_release_images "$home_dir/images.env" true`);
  assert.notEqual(missing.status, 0);
  assert.match(
    missing.stderr,
    /These Home images are not on this machine: local\/opensteer-home-host:1\.2\.3 local\/opensteer-home-runner:1\.2\.3\. Build them with: sudo bash deploy\/home\/build-images\.sh/u,
  );
  assert.doesNotMatch(missing.stdout, /stamps/u);
});

/**
 * A Home whose backup runs restic's container scripts here, against a fake restic: they decide
 * what is reported, so they run as written, with only /backups and /tmp moved.
 */
function backupHome(t) {
  const directory = mkdtempSync(resolve(tmpdir(), "home-backup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = resolve(directory, "bin");
  const backups = resolve(directory, "backups");
  const home = resolve(directory, "home");
  for (const path of [bin, backups, home]) mkdirSync(path);
  writeFileSync(resolve(backups, "accessKeyId"), "key");
  writeFileSync(resolve(backups, "secretAccessKey"), "secret");
  writeFileSync(
    resolve(bin, "restic"),
    `#!/bin/sh
case "$*" in
  *"cat config"*)
    case $RESTIC_REPOSITORY in
      wrong-password) echo 'Fatal: wrong password or no key found' >&2; exit 12 ;;
      new) echo 'Fatal: repository does not exist: unable to open config file' >&2; exit 10 ;;
      unreachable) echo 'Stat(<config/>) returned error, retrying after 557ms: dial tcp 192.0.2.1:443: connect: connection refused' >&2; exec sleep 3 ;;
      *) exit 0 ;;
    esac ;;
  *init*) echo "created restic repository" ;;
  *"snapshots --latest 1"*) exit 0 ;;
  *backup*)
    echo '{"message_type":"status","percent_done":0.5,"files_done":3,"total_files":6}'
    case $RESTIC_REPOSITORY in
      slow) exec sleep 5 ;;
      failing) echo 'Fatal: unable to save snapshot: connection reset by peer' >&2; exit 1 ;;
    esac
    echo '{"message_type":"summary","snapshot_id":"0123abcd"}' ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    resolve(bin, "timeout"),
    `#!/bin/sh
seconds=$1; shift
"$@" & pid=$!
( sleep "$seconds"; kill -TERM "$pid" 2>/dev/null ) & killer=$!
wait "$pid"; status=$?
kill "$killer" 2>/dev/null
if [ "$status" -ge 128 ]; then exit 124; fi
exit "$status"
`,
    { mode: 0o755 },
  );
  const script = `
    set -euo pipefail
    export OPENSTEER_HOME_DIR=${quote(home)}
    source deploy/home/common.sh
    source deploy/home/backup.sh
    sync() { :; }
    backup_check_seconds=1
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
    restic_container() {
      local script=\${1//\\/backups\\//${backups}/} argument arguments=()
      script=\${script//\\/tmp\\//${backups}/}
      shift
      for argument in "$@"; do
        argument=\${argument//\\/backups\\//${backups}/}
        arguments+=("\${argument//\\/tmp\\//${backups}/}")
      done
      PATH=${quote(bin)}:$PATH sh -euc "$script" home-backup "\${arguments[@]}"
    }
    backup_command backup
  `;
  const run = (repository) =>
    spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, RESTIC_REPOSITORY: repository },
    });
  const start = (repository) =>
    spawn("bash", ["-c", script], {
      env: { ...process.env, RESTIC_REPOSITORY: repository },
    });
  return { home, run, start };
}

const checking =
  "Checking that the backup repository can be reached and written (at most 1 seconds).\n";

await test("the backup check reports what restic said, within one deadline, before anything stops", (t) => {
  const { run } = backupHome(t);
  const wrong = run("wrong-password");
  assert.equal(wrong.status, 1);
  assert.equal(wrong.stdout, checking);
  assert.match(
    wrong.stderr,
    /Fatal: wrong password or no key found\nThe backup repository could not be reached or written\. The Home was not stopped\./u,
  );
  const started = Date.now();
  const unreachable = run("unreachable");
  assert.ok(Date.now() - started < 3_000, "the check ran past its deadline");
  assert.equal(unreachable.status, 1);
  assert.equal(unreachable.stdout, checking);
  assert.match(
    unreachable.stderr,
    /connection refused\nThe backup repository did not answer within 1 seconds\. The Home was not stopped\./u,
  );
  const created = run("new");
  assert.equal(created.status, 0, created.stderr);
  assert.doesNotMatch(created.stderr, /does not exist/u);
  assert.match(created.stdout, /Stopping Home services/u);
});

await test("a backup shows its progress and starts the Home again after a late failure", (t) => {
  const { home, run } = backupHome(t);
  const saved = run("ready");
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(
    saved.stdout,
    [
      checking.trimEnd(),
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
  const failed = run("failing");
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /compose stop .*\n.*started\n$/su);
  assert.match(
    failed.stderr,
    /connection reset by peer\nIts unfinished files were removed\.\nThe backup did not finish after Home services were stopped\. Starting them again\.\nHome services were started again\.\n/u,
  );
  assert.deepEqual(
    readdirSync(home).filter((name) => name.startsWith("backup.")),
    [],
  );
});

await test("a backup sent TERM midway starts the Home again and removes its staging", async (t) => {
  const { home, start } = backupHome(t);
  const child = start("slow");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("Uploaded 50%") && !child.signalled) {
      child.signalled = true;
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [status] = await once(child, "close");
  assert.notEqual(status, 0);
  assert.match(stdout, /Uploaded 50%.*\nstarted\n$/su);
  assert.match(
    stderr,
    /The operation was stopped by SIGTERM\.\nIts unfinished files were removed\.\nThe backup did not finish after Home services were stopped\. Starting them again\.\nHome services were started again\.\n/u,
  );
  assert.deepEqual(
    readdirSync(home).filter((name) => name.startsWith("backup.")),
    [],
  );
});

await test("build-images.sh writes the manifest where it was asked, and checks that first", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "home-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = resolve(directory, "bin");
  mkdirSync(bin);
  mkdirSync(resolve(directory, "work"));
  const work = realpathSync(resolve(directory, "work"));
  writeFileSync(
    resolve(bin, "docker"),
    `#!/bin/sh
echo "docker $*" >> ${quote(resolve(directory, "docker.log"))}
case "$*" in
  "image inspect --format {{.Id}} "*) echo sha256:${"a".repeat(64)} ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const build = (manifest) =>
    spawnSync("bash", [resolve("deploy/home/build-images.sh"), manifest], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        OPENSTEER_SOURCE_REVISION: "b".repeat(40),
      },
    });
  const built = build("release.json");
  assert.equal(built.status, 0, built.stderr);
  const manifest = JSON.parse(readFileSync(resolve(work, "release.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.images).sort(), [...homeServices].sort());
  assert.match(
    built.stdout,
    new RegExp(`--manifest ${resolve(work, "release.json")} HOSTNAME`, "u"),
  );
  assert.equal(existsSync(resolve("release.json")), false);
  rmSync(resolve(directory, "docker.log"));
  const refused = build("missing/release.json");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Cannot write the manifest to .*\/work\/missing\/release\.json/u);
  assert.equal(existsSync(resolve(directory, "docker.log")), false, "it built before checking");
});

await test("the standalone installer's payload is read back file by file", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "home-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const installer = resolve(directory, "opensteer-home-installer.sh");
  execFileSync("bash", ["deploy/home/package-installer.sh", installer]);
  const { script, files } = installerContents(installer);
  assert.equal(files["common.sh"], readFileSync("deploy/home/common.sh", "utf8"));
  assert.equal(files.version.trim(), JSON.parse(readFileSync("package.json", "utf8")).version);
  assert.match(script, /^#!\/usr\/bin\/env bash\n/u);
  assert.match(script, /\nbash "\$package\/install\.sh" "\$@"\n$/u);
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

await test("an interrupted switch is decided by `current` alone, and keeps the dump", () => {
  // Stopped before `current` named b: b's containers stop, a stays, and so does the dump.
  const back = runRecovery(`${switchFixture}
    current a
    recover_switch
    test ! -e "$home_dir/update.pending"
    readlink "$home_dir/current"
    cat "$home_dir/releases/b/database.dump"
  `);
  assert.equal(
    back,
    "compose down --remove-orphans\nAn update stopped before it switched releases: the Home runs its previous release.\nreleases/a\nmanual recovery copy\n",
  );
  // Stopped after: b stays, a is kept as the way back, and the older c goes with its image.
  const ahead = runRecovery(`${switchFixture}
    current b
    recover_switch
    test ! -e "$home_dir/update.pending"
    readlink "$home_dir/current"; readlink "$home_dir/previous"
    ls "$home_dir/releases"; cat "$home_dir/docker.log"
  `);
  // Only the name c pulled, never by id or forced: an image goes when nothing else names it.
  assert.equal(ahead, "releases/b\nreleases/a\na\nb\ndocker image rm -- host:c\n");
  // Anything else is the operator's: everything stays.
  const neither = runHome(`${switchFixture}
    current c
    if recover_switch; then exit 97; fi
    test -f "$home_dir/update.pending"; ls "$home_dir/releases"`);
  assert.equal(neither.stdout, "a\nb\nc\n", neither.stderr);
  assert.match(neither.stderr, /operator intervention is required/u);
  // An image that cannot be removed keeps its release, to try again later.
  const stuck = runRecovery(`${switchFixture}
    current b
    docker() { [[ $1 == image && $2 == inspect ]]; }
    recover_switch 2>&1
    ls "$home_dir/releases"
  `);
  assert.equal(stuck, "An earlier release is kept to be removed later: c\na\nb\nc\n");
  // A Docker that cannot answer is not an image that is gone: c stays; a missing one is gone.
  const unknown = runRecovery(`${switchFixture}
    current b
    docker() { [[ $2 == inspect ]] && echo 'Cannot connect to the Docker daemon' >&2; return 1; }
    recover_switch 2>&1
    ls "$home_dir/releases"
  `);
  assert.equal(unknown, "An earlier release is kept to be removed later: c\na\nb\nc\n");
  const missing = runRecovery(`${switchFixture}
    current b
    docker() { [[ $2 == inspect ]] && echo "Error: No such image: $4" >&2; return 1; }
    recover_switch 2>&1
    ls "$home_dir/releases"
  `);
  assert.equal(missing, "a\nb\n");
});

for (const { name, fixture, recover, selector } of [
  {
    name: "restore",
    fixture: restoreJournal,
    recover: "restore_rollback",
    selector: "volumes.env",
  },
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

await test("the managed scheduler enables the update timer from install, with or without a feed", (t) => {
  const temp = mkdtempSync(resolve(tmpdir(), "home-schedule-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const units = resolve(temp, "units");
  const config = resolve(temp, "config.env");
  mkdirSync(units);
  writeFileSync(resolve(temp, "managed"), "");
  writeFileSync(resolve(temp, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o700 });
  const run = () =>
    execFileSync("bash", ["deploy/home/install-scheduler.sh", temp, "opensteer-home-proof"], {
      env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, OPENSTEER_HOME_UNIT_DIR: units },
      encoding: "utf8",
    });
  const updateTimer = resolve(units, "opensteer-home-proof-update.timer");
  // A managed Home asks its account for its feed at each check, so it has the timer either way.
  for (const content of [
    "OPENSTEER_HOME_RELEASE_MANIFEST_URL='https://release.example.test/home/stable.json'\n",
    "",
  ]) {
    writeFileSync(config, content);
    // A first install: no units yet, nothing marked enabled.
    rmSync(units, { recursive: true, force: true });
    mkdirSync(units);
    rmSync(resolve(temp, "units.enabled"), { force: true });
    const output = run();
    assert.match(
      output,
      /enable opensteer-home-proof\.service opensteer-home-proof-update\.timer opensteer-home-proof-backup\.timer opensteer-home-proof-maintain\.timer/u,
    );
    assert.doesNotMatch(output, /disable/u);
    assert.match(readFileSync(updateTimer, "utf8"), /OnCalendar=hourly/u);
  }
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
