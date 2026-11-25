// A Cloud Computer is pooled only by its boot answer's own flag (phase B, piece 2): the installer
// marks it, the marker adds one override, and the default recipe is the self-hosted one.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/** Compose's `!reset` tag: the key is removed from what the files before it set. */
const reset = Symbol("reset");
const parse = (text: string) =>
  parseYaml(text, {
    merge: true,
    customTags: [{ tag: "!reset", identify: () => false, resolve: () => reset }],
  }) as unknown;

const home = join(import.meta.dirname, "../deploy/home");
const read = (name: string) => readFileSync(join(home, name), "utf8");

/** The installer's own condition, run on a boot answer. */
function marksPooled(answer: object): boolean {
  const condition = /jq -e '(\.browserPool == true)' "\$result"/u.exec(read("install.sh"))?.[1];
  if (!condition) throw new Error("The installer no longer reads browserPool.");
  try {
    execFileSync("jq", ["-e", condition], { input: JSON.stringify(answer), stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

it("marks a Cloud Computer pooled only when its boot answer says browserPool: true", () => {
  expect(marksPooled({ browserPool: true })).toBe(true);
  for (const answer of [
    {},
    { browserPool: false },
    { browserPool: "true" },
    // A missing egress is never a reason.
    { egress: null },
    { managedHome: { cloudComputerId: "cc_x" } },
  ])
    expect(marksPooled(answer)).toBe(false);
});

it("adds the pooled override only for a marked Home, and keeps the default recipe free of it", () => {
  const common = read("common.sh");
  expect(common).toContain(
    'if [[ -f "$home_dir/browser-pool" ]]; then args+=(-f "$release_dir/compose.browser-pool.yaml"); fi',
  );
  expect(common).toMatch(/release_files=\([^)]*compose\.browser-pool\.yaml/u);
  expect(read("compose.yaml")).not.toMatch(/BROWSER_POOL|browser-pool/u);
  expect(parse(read("compose.browser-pool.yaml"))).toMatchObject({
    services: { host: { environment: { OPENSTEER_MANAGED_HOME_BROWSER_POOL: "true" } } },
  });
  // The installer's boot copy and the packager take that one list.
  expect(read("install.sh")).toContain('for file in "${release_files[@]}"; do');
  expect(read("package-installer.sh")).toContain("s/^release_files=(\\(.*\\))$/\\1/p");
});

/** The compose files `common.sh` names for a Home directory holding these markers. */
function composeFiles(markers: readonly string[]): string[] {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-home-shape-"));
  try {
    writeFileSync(join(directory, "config.env"), "COMPOSE_PROJECT_NAME='shape'\n");
    for (const marker of markers) {
      mkdirSync(dirname(join(directory, marker)), { recursive: true });
      writeFileSync(join(directory, marker), marker.endsWith("egress_url") ? "http://e\n" : "");
    }
    const printed = execFileSync(
      "bash",
      [
        "-c",
        // compose() runs `env -i ... docker compose <args>`: print the args instead.
        `source "$1"; machine_size() { echo 4096 2; }; env() { printf '%s\\n' "$@"; }; compose config`,
        "shape",
        join(home, "common.sh"),
      ],
      { env: { ...process.env, OPENSTEER_HOME_DIR: directory }, encoding: "utf8" },
    );
    const lines = printed.split("\n");
    return lines.flatMap((line, index) =>
      line === "-f" ? [lines[index + 1]!.slice(home.length + 1)] : [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it("waits for a Home's own exit address only on a Cloud Computer whose browser runs at home", () => {
  expect(composeFiles(["managed"])).toEqual(["compose.yaml", "compose.egress-pending.yaml"]);
  expect(composeFiles(["managed", "secrets/egress_url"])).toEqual([
    "compose.yaml",
    "compose.egress.yaml",
  ]);
  // A pooled Cloud Computer's browser leaves through its own address on the pool host: its Home
  // waits for none.
  expect(composeFiles(["managed", "browser-pool"])).toEqual([
    "compose.yaml",
    "compose.browser-pool.yaml",
  ]);
  expect(composeFiles([])).toEqual(["compose.yaml"]);
});

/** `home_limits` from `common.sh`: a Cloud Computer's limits for a machine of this size. */
function homeLimits(memoryMib: number, cpus: number): Record<string, string> {
  const printed = execFileSync(
    "bash",
    [
      "-c",
      'source "$1"; home_limits "$2" "$3"',
      "limits",
      join(home, "common.sh"),
      `${memoryMib}`,
      `${cpus}`,
    ],
    { encoding: "utf8", env: { ...process.env, OPENSTEER_HOME_DIR: tmpdir() } },
  );
  return Object.fromEntries(
    printed
      .trim()
      .split("\n")
      .map((line) => line.split("=") as [string, string]),
  );
}

const pooledServices = {
  postgres: "POSTGRES",
  host: "HOST",
  gateway: "GATEWAY",
  runner: "RUNNER",
  "channel-runtime": "CHANNEL",
} as const;

const mebibytes = (value: string) => {
  const match = /^(\d+)m$/u.exec(value);
  if (!match) throw new Error(`Not a size in MiB: ${value}`);
  return Number(match[1]);
};

/**
 * Ordinary peaks (MiB) measured on a scratch e2-medium Cloud Computer, as home_limits names them:
 * the Host serving connected agents, its plugin engine and workerd, PostgreSQL, Channel Runtime,
 * the gateway, the Runner's own process, and one Run's allowance.
 */
const peak = { host: 460, plugin: 680, postgres: 110, channel: 100, gateway: 20, runner: 192 };
const runAllowance = 1536;
const ordinary = Object.values(peak).reduce((sum, value) => sum + value, 0);
const kept = (memory: number) => Math.max(768, Math.floor(memory / 8));

it("sizes a Cloud Computer's Home from its machine: every ordinary peak fits beside the kernel's room, under ceilings above it", () => {
  // 3908 and 3916 MiB are what Linux reports as MemTotal on a 4 GiB e2-medium.
  for (const [memory, cpus] of [
    [4096, 2],
    [3916, 2],
    [3908, 2],
    [8192, 2],
    [16384, 4],
  ] as const) {
    const limits = homeLimits(memory, cpus);
    const limit = (name: string) => mebibytes(limits[`OPENSTEER_HOME_LIMIT_${name}_MEMORY`]!);
    expect(Object.keys(limits).sort()).toEqual(
      Object.values(pooledServices)
        .flatMap((name) => [
          `OPENSTEER_HOME_LIMIT_${name}_CPUS`,
          `OPENSTEER_HOME_LIMIT_${name}_MEMORY`,
        ])
        .concat("OPENSTEER_HOME_LIMIT_RUNNER_RUNS")
        .sort(),
    );
    // Runs at once: as many as fit beside every ordinary peak (the plugin engine's included) and
    // the kernel's room, at the allowance for one Run (a measured OpenCode Run's peak and half
    // again), at least one.
    const runs = Number(limits.OPENSTEER_HOME_LIMIT_RUNNER_RUNS);
    expect(runs).toBe(Math.max(1, Math.floor((memory - kept(memory) - ordinary) / runAllowance)));
    expect(kept(memory) + ordinary + runs * runAllowance).toBeLessThanOrEqual(memory);
    // Each limit is a ceiling well above its part's ordinary peak. The Host's holds the Host and
    // its plugin engine at their peaks together; the Runner's holds its Runs and, while no plugin
    // runs, the plugin engine's share too.
    expect(limit("HOST")).toBeGreaterThanOrEqual(peak.host + peak.plugin + 256);
    expect(limit("POSTGRES")).toBeGreaterThanOrEqual(2 * peak.postgres);
    expect(limit("CHANNEL")).toBeGreaterThanOrEqual(2.5 * peak.channel);
    expect(limit("GATEWAY")).toBeGreaterThanOrEqual(3 * peak.gateway);
    // The machine's room for it while the others are at their ordinary peaks, below a further
    // Run's allowance (where it would keep a warm engine).
    expect(limit("RUNNER")).toBe(
      Math.min(
        memory - kept(memory) - peak.host - peak.postgres - peak.channel - peak.gateway,
        peak.runner + (runs + 1) * runAllowance - 1,
      ),
    );
    expect(limit("RUNNER")).toBeGreaterThanOrEqual(peak.runner + runs * runAllowance + peak.plugin);
    for (const name of Object.values(pooledServices)) {
      const share = Number(limits[`OPENSTEER_HOME_LIMIT_${name}_CPUS`]);
      expect(share).toBeGreaterThan(0);
      // Docker refuses a container more CPUs than the machine has.
      expect(share).toBeLessThanOrEqual(cpus);
    }
    // The Runner may use every CPU the machine has, whatever their number.
    expect(limits.OPENSTEER_HOME_LIMIT_RUNNER_CPUS).toBe(`${cpus}`);
  }
  // The default machine, 4 GiB with two CPUs: the scratch e2-medium (3,908 MiB). No browser runs
  // here, so nothing is kept for one. One Run at a time; a second waits for it.
  expect(homeLimits(soldMachine.memTotalMib, 2)).toEqual({
    OPENSTEER_HOME_LIMIT_POSTGRES_CPUS: "2",
    OPENSTEER_HOME_LIMIT_POSTGRES_MEMORY: "256m",
    OPENSTEER_HOME_LIMIT_HOST_CPUS: "2",
    OPENSTEER_HOME_LIMIT_HOST_MEMORY: "1536m",
    OPENSTEER_HOME_LIMIT_GATEWAY_CPUS: "1",
    OPENSTEER_HOME_LIMIT_GATEWAY_MEMORY: "64m",
    OPENSTEER_HOME_LIMIT_RUNNER_CPUS: "2",
    OPENSTEER_HOME_LIMIT_RUNNER_MEMORY: "2450m",
    OPENSTEER_HOME_LIMIT_RUNNER_RUNS: "1",
    OPENSTEER_HOME_LIMIT_CHANNEL_CPUS: "1",
    OPENSTEER_HOME_LIMIT_CHANNEL_MEMORY: "256m",
  });
  expect(homeLimits(16384, 4).OPENSTEER_HOME_LIMIT_RUNNER_MEMORY).toBe("13646m");
  expect(homeLimits(16384, 4).OPENSTEER_HOME_LIMIT_RUNNER_RUNS).toBe("8");
  expect(homeLimits(8192, 2).OPENSTEER_HOME_LIMIT_RUNNER_RUNS).toBe("3");
});

it("gives a 4 GiB machine's Host room for the plugin engine a connected agent's call wakes, beside one Run", () => {
  // At a Host limit of 640 MiB on the scratch e2-medium, one connected agent's discover woke the
  // plugin engine: the Host's container sat at its limit and the kernel killed the engine four
  // times, while 2.5 GiB of the machine stayed free.
  for (const memory of [3866, 3908, 3916, 4096]) {
    const limits = homeLimits(memory, 2);
    expect(mebibytes(limits.OPENSTEER_HOME_LIMIT_HOST_MEMORY!), `${memory}`).toBeGreaterThan(
      peak.host + peak.plugin,
    );
    expect(limits.OPENSTEER_HOME_LIMIT_RUNNER_RUNS).toBe("1");
    expect(mebibytes(limits.OPENSTEER_HOME_LIMIT_RUNNER_MEMORY!)).toBeGreaterThanOrEqual(
      peak.runner + runAllowance,
    );
    // A Run and the plugin engine at their peaks together still leave the kernel its 768 MiB.
    expect(768 + ordinary + runAllowance).toBeLessThanOrEqual(memory);
  }
});

/**
 * The machine Opensteer sells, as Linux reported it: Compute Engine's e2-medium (4 GiB), its
 * MemTotal read on the scratch Cloud Computer on 2026-11-25.
 */
const soldMachine = { type: "e2-medium", memTotalMib: 3908, read: "2026-11-25" } as const;

/** home_limits as a start runs it: what it prints for Compose, what it says, and whether it ran. */
function homeStart(memoryMib: number) {
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; home_limits "$2" 2', "limits", join(home, "common.sh"), `${memoryMib}`],
    { encoding: "utf8", env: { ...process.env, OPENSTEER_HOME_DIR: tmpdir() } },
  );
  return { status: result.status, said: result.stderr.trim(), printed: result.stdout };
}

it("refuses only a machine of a smaller class, and says why and what it needs", () => {
  expect(() => homeLimits(2048, 1)).toThrow(/too small/u);
  expect(homeStart(3583)).toMatchObject({
    status: 1,
    said: "This machine (3583 MiB) is too small for a Cloud Computer's Home: it needs at least 3584 MiB.",
  });
  expect(() => homeLimits(4096, 0)).toThrow(/CPU/u);
});

it("starts a machine short of the ordinary peaks, the shortfall out of the kept room, said at start", () => {
  for (const memory of [3584, 3700, 3865]) {
    const start = homeStart(memory);
    expect(start.status, `${memory}`).toBe(0);
    const short = 768 + ordinary + runAllowance - memory;
    expect(start.said).toBe(
      `This machine has ${short} MiB less than the Home's ordinary peaks; the system's reserve is ${768 - short} MiB.`,
    );
    // The same ceilings as a machine with its full kept room: only the system's reserve gave way.
    expect(start.printed).toBe(homeStart(3866).printed);
  }
  // The floor's kept room: 486 MiB.
  expect(homeStart(3584).said).toMatch(/the system's reserve is 486 MiB\.$/u);
  // A machine with room for every ordinary peak says nothing.
  expect(homeStart(3866).said).toBe("");
  expect(homeStart(soldMachine.memTotalMib).said).toBe("");
});

it("keeps the machine Opensteer sells well above the floor, so an OS update cannot make it refuse", () => {
  // The lowest memory the Home starts on, found from the rule itself.
  let low = 1024;
  let high: number = soldMachine.memTotalMib;
  expect(homeStart(high).status).toBe(0);
  expect(homeStart(low).status).not.toBe(0);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (homeStart(middle).status === 0) high = middle;
    else low = middle;
  }
  expect(high).toBe(3584);
  // A rule that brings the floor within 150 MiB of the sold machine fails here.
  expect(
    soldMachine.memTotalMib - high,
    `${soldMachine.type}, read ${soldMachine.read}`,
  ).toBeGreaterThanOrEqual(150);
});

it("lets the kernel take a Run, or first the plugin engine, before the Host or PostgreSQL", () => {
  const override = parse(read("compose.browser-pool.yaml")) as {
    services: Record<string, Record<string, unknown>>;
  };
  expect(override.services.host?.oom_score_adj).toBe(-500);
  expect(override.services.postgres?.oom_score_adj).toBe(-500);
  expect(override.services.runner?.oom_score_adj).toBe(undefined);
});

it("applies the machine's limits on a pooled Cloud Computer only, never on a self-hosted Home", () => {
  const override = parse(read("compose.browser-pool.yaml")) as {
    services: Record<string, Record<string, unknown>>;
  };
  for (const [service, name] of Object.entries(pooledServices))
    expect(override.services[service]).toMatchObject({
      cpus: `\${OPENSTEER_HOME_LIMIT_${name}_CPUS:?Machine limits required}`,
      mem_limit: `\${OPENSTEER_HOME_LIMIT_${name}_MEMORY:?Machine limits required}`,
      memswap_limit: `\${OPENSTEER_HOME_LIMIT_${name}_MEMORY:?Machine limits required}`,
    });
  // No local Browser Runtime runs, so the Runner is not pointed at one: its bridge settings go.
  const bridge = [
    "OPENSTEER_BROWSER_BRIDGE_URL",
    "OPENSTEER_BROWSER_BRIDGE_TOKEN_FILE",
    "OPENSTEER_BROWSER_RUNTIME_ID",
  ];
  expect(override.services.runner?.environment).toEqual({
    OPENSTEER_MAX_CONCURRENT_RUNS: "${OPENSTEER_HOME_LIMIT_RUNNER_RUNS:?Machine limits required}",
    ...Object.fromEntries(bridge.map((name) => [name, reset])),
  });
  const base = parse(read("compose.yaml")) as {
    services: { runner: { environment: Record<string, string> } };
  };
  for (const name of bridge) expect(base.services.runner.environment).toHaveProperty(name);
  // The self-hosted recipe keeps its own limits and their OPENSTEER_HOME_* overrides, and the
  // Runner's own default number of Runs.
  expect(read("compose.yaml")).not.toContain("OPENSTEER_HOME_LIMIT_");
  expect(read("compose.yaml")).not.toContain("OPENSTEER_MAX_CONCURRENT_RUNS");
  expect(composeEnvironment(["managed", "browser-pool"])).toContain(
    "OPENSTEER_HOME_LIMIT_RUNNER_MEMORY=2638m",
  );
  expect(composeEnvironment(["managed"]).join("\n")).not.toContain("OPENSTEER_HOME_LIMIT_");
  expect(composeEnvironment([]).join("\n")).not.toContain("OPENSTEER_HOME_LIMIT_");
});

/**
 * The environment `common.sh`'s compose() gives Docker Compose when it starts the Home, on a
 * 4 GiB two-CPU machine.
 */
function composeEnvironment(markers: readonly string[]): string[] {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-home-limits-"));
  try {
    writeFileSync(join(directory, "config.env"), "COMPOSE_PROJECT_NAME='shape'\n");
    for (const marker of markers) writeFileSync(join(directory, marker), "");
    const printed = execFileSync(
      "bash",
      [
        "-c",
        `source "$1"; machine_size() { echo 4096 2; }; env() { printf '%s\\n' "$@"; }; compose up -d`,
        "shape",
        join(home, "common.sh"),
      ],
      { env: { ...process.env, OPENSTEER_HOME_DIR: directory }, encoding: "utf8" },
    );
    return printed.split("\n").filter((line) => /^[A-Z_]+=/u.test(line));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Each service's settings once Compose merges the files `common.sh` names for these markers. */
function mergedServices(markers: readonly string[]): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const file of composeFiles(markers)) {
    const { services } = parse(read(file)) as {
      services: Record<string, Record<string, unknown>>;
    };
    for (const [name, settings] of Object.entries(services))
      merged[name] = { ...merged[name], ...settings };
  }
  return merged;
}

it("starts no local browser and no local browser egress on a Cloud Computer", () => {
  const pooled = mergedServices(["managed", "browser-pool"]);
  // Neither the person's profiles nor Chromium run in the VM, and nothing can leave through a
  // local browser proxy on the VM's own address: Compose creates no container for either.
  expect(pooled["browser-runtime"]?.scale).toBe(0);
  expect(pooled["browser-egress"]?.scale).toBe(0);
  for (const service of ["postgres", "host", "gateway", "runner", "channel-runtime"])
    expect(pooled[service]?.scale).toBeUndefined();
  expect(runningServices(["managed", "browser-pool"])).toEqual([
    "host",
    "gateway",
    "runner",
    "channel-runtime",
  ]);
  // A self-hosted Home keeps its browser exactly as before.
  for (const markers of [[], ["managed"]]) {
    const services = mergedServices(markers);
    expect(services["browser-runtime"]?.scale).toBeUndefined();
    expect(services["browser-egress"]?.scale).toBeUndefined();
    expect(runningServices(markers)).toEqual([
      "host",
      "gateway",
      "runner",
      "browser-runtime",
      "browser-egress",
      "channel-runtime",
    ]);
  }
  // Maintenance and update count what runs, not the six images, or a pooled Home would be torn
  // down and restarted on every maintenance pass and could never update.
  expect(read("opensteer-home")).toContain('pod_healthy "$snapshot"');
  expect(read("common.sh")).toMatch(/^pod_healthy\(\) \{\n(?:.*\n)*?.*running_services/mu);
  expect(read("common.sh")).toMatch(/^service_images\(\) \{\n(?:.*\n)*?.*running_services/mu);
});

/** `running_services` from `common.sh` for a Home directory holding these markers. */
function runningServices(markers: readonly string[]): string[] {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-home-running-"));
  try {
    for (const marker of markers) writeFileSync(join(directory, marker), "");
    return execFileSync(
      "bash",
      ["-c", 'source "$1"; running_services', "running", join(home, "common.sh")],
      {
        env: { ...process.env, OPENSTEER_HOME_DIR: directory },
        encoding: "utf8",
      },
    )
      .trim()
      .split("\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it("checks health quickly only while a service starts, then every 30 s, and never with Node", () => {
  for (const markers of [[], ["managed", "browser-pool"]]) {
    const services = mergedServices(markers);
    for (const [name, service] of Object.entries(services)) {
      const health = service.healthcheck as Record<string, unknown> | undefined;
      if (!health) continue;
      // An idle Home spent about 0.4 of a core on 3 s checks that each started Node.
      expect(health.interval, name).toBe("30s");
      expect(health.start_interval, name).toBe("2s");
      expect(health.start_period, name).toBe("60s");
      expect(health.retries, name).toBe(2);
      const test = (health.test as string[]).join(" ");
      expect(test, name).not.toMatch(/(^|[\s/])node(\s|$)/u);
    }
  }
});

it("caps the Runs at once at the Runner's own limit of 1,000", () => {
  expect(homeLimits(2_097_152, 64).OPENSTEER_HOME_LIMIT_RUNNER_RUNS).toBe("1000");
});

it("lets an operator stop and inspect a Home on any machine, even one too small to start it", () => {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-home-small-"));
  try {
    writeFileSync(join(directory, "config.env"), "COMPOSE_PROJECT_NAME='shape'\n");
    for (const marker of ["managed", "browser-pool"]) writeFileSync(join(directory, marker), "");
    const run = (subcommand: string) =>
      spawnSync(
        "bash",
        [
          "-c",
          `source "$1"; machine_size() { echo 1024 1; }; env() { printf '%s\\n' "$@"; }; compose ${subcommand}`,
          "small",
          join(home, "common.sh"),
        ],
        { env: { ...process.env, OPENSTEER_HOME_DIR: directory }, encoding: "utf8" },
      );
    for (const subcommand of ["down", "stop", "logs", "ps", "config", "pull"])
      expect(run(subcommand).status, subcommand).toBe(0);
    // Only what creates or starts containers needs the machine's limits.
    for (const subcommand of ["up -d", "create", "start", "restart", "run --rm host true"])
      expect(run(subcommand).stderr, subcommand).toMatch(/too small/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("neither pulls nor checks the two browser images on a Cloud Computer, which never runs them", () => {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-home-images-"));
  try {
    for (const marker of ["managed", "browser-pool"]) writeFileSync(join(directory, marker), "");
    writeFileSync(join(directory, "images.env"), "OPENSTEER_HOME_VERSION=1.2.3\n");
    const images = Object.fromEntries(
      ["host", "gateway", "runner", "browser-runtime", "browser-egress", "channel-runtime"].map(
        (service) => [service, { image: `example.test/${service}@sha256:${"a".repeat(64)}` }],
      ),
    );
    const log = join(directory, "calls.log");
    const run = (call: string) =>
      spawnSync(
        "bash",
        [
          "-c",
          `source "$1"; calls=$2
           compose() { printf 'compose %s\\n' "$*" >> "$calls"; [[ $1 == config ]] && printf '%s' '${JSON.stringify({ services: images })}'; return 0; }
           docker() { printf 'docker %s\\n' "$*" >> "$calls"; [[ $* == *release.json* ]] && echo '{"version":"1.2.3"}'; [[ $* == *oci.json* ]] && echo '{}'; return 0; }
           ${call}`,
          "images",
          join(home, "common.sh"),
          log,
        ],
        { env: { ...process.env, OPENSTEER_HOME_DIR: directory }, encoding: "utf8" },
      );
    expect(run(`fetch_release_images "${directory}/images.env" false`).status).toBe(0);
    expect(run(`check_release_stamps "${directory}/images.env"`).status).toBe(0);
    expect(run(`install_sandbox_policies "${directory}"`).status).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("compose pull --quiet postgres host gateway runner channel-runtime\n");
    expect(calls).not.toMatch(/browser-(runtime|egress)@sha256/u);
    expect(calls).toContain("runner@sha256");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
