// A Cloud Computer is pooled only by its boot answer's own flag (phase B, piece 2): the installer
// marks it, the marker adds one override, and the default recipe is the self-hosted one.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";

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
    'if [[ -f "$home_dir/browser-pool" ]]; then args+=(-f "$home_dir/compose.browser-pool.yaml"); fi',
  );
  expect(common).toMatch(/recipe_files=\([^)]*compose\.browser-pool\.yaml/u);
  expect(read("compose.yaml")).not.toMatch(/BROWSER_POOL|browser-pool/u);
  expect(parse(read("compose.browser-pool.yaml"))).toMatchObject({
    services: { host: { environment: { OPENSTEER_MANAGED_HOME_BROWSER_POOL: "true" } } },
  });
  for (const installer of ["install.sh", "package-installer.sh"])
    expect(read(installer)).toContain("compose.browser-pool.yaml");
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
      line === "-f" ? [lines[index + 1]!.slice(directory.length + 1)] : [],
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

it("sizes a Cloud Computer's Home from its machine: no limit adds up past it, room left for the kernel", () => {
  // 3916 MiB is what Linux reports as MemTotal on a 4 GiB e2-medium.
  for (const [memory, cpus] of [
    [4096, 2],
    [3916, 2],
    [8192, 2],
    [16384, 4],
  ] as const) {
    const limits = homeLimits(memory, cpus);
    expect(Object.keys(limits).sort()).toEqual(
      Object.values(pooledServices)
        .flatMap((name) => [
          `OPENSTEER_HOME_LIMIT_${name}_CPUS`,
          `OPENSTEER_HOME_LIMIT_${name}_MEMORY`,
        ])
        .sort(),
    );
    const total = Object.values(pooledServices).reduce(
      (sum, name) => sum + mebibytes(limits[`OPENSTEER_HOME_LIMIT_${name}_MEMORY`]!),
      0,
    );
    // Every cap together stays under the machine. What is left is at least 1 GiB and an eighth:
    // a real Cloud Computer used about 800 MiB outside its containers (kernel, Docker, agents).
    expect(total).toBeLessThanOrEqual(memory - Math.max(1024, Math.floor(memory / 8)));
    for (const name of Object.values(pooledServices)) {
      const share = Number(limits[`OPENSTEER_HOME_LIMIT_${name}_CPUS`]);
      expect(share).toBeGreaterThan(0);
      // Docker refuses a container more CPUs than the machine has.
      expect(share).toBeLessThanOrEqual(cpus);
    }
    // The Runner may use every CPU the machine has, whatever their number.
    expect(limits.OPENSTEER_HOME_LIMIT_RUNNER_CPUS).toBe(`${cpus}`);
    expect(mebibytes(limits.OPENSTEER_HOME_LIMIT_RUNNER_MEMORY!)).toBeGreaterThanOrEqual(1024);
  }
  // The default machine, 4 GiB with two CPUs. No browser runs here, so nothing is kept for one.
  expect(homeLimits(4096, 2)).toEqual({
    OPENSTEER_HOME_LIMIT_POSTGRES_CPUS: "2",
    OPENSTEER_HOME_LIMIT_POSTGRES_MEMORY: "512m",
    OPENSTEER_HOME_LIMIT_HOST_CPUS: "2",
    OPENSTEER_HOME_LIMIT_HOST_MEMORY: "768m",
    OPENSTEER_HOME_LIMIT_GATEWAY_CPUS: "1",
    OPENSTEER_HOME_LIMIT_GATEWAY_MEMORY: "256m",
    OPENSTEER_HOME_LIMIT_RUNNER_CPUS: "2",
    OPENSTEER_HOME_LIMIT_RUNNER_MEMORY: "1280m",
    OPENSTEER_HOME_LIMIT_CHANNEL_CPUS: "1",
    OPENSTEER_HOME_LIMIT_CHANNEL_MEMORY: "256m",
  });
  expect(homeLimits(16384, 4).OPENSTEER_HOME_LIMIT_RUNNER_MEMORY).toBe("9984m");
});

it("refuses a machine too small for a Cloud Computer's Home instead of overcommitting it", () => {
  expect(() => homeLimits(2048, 1)).toThrow(/too small/u);
  expect(() => homeLimits(4096, 0)).toThrow(/CPU/u);
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
  // The self-hosted recipe keeps its own limits and their OPENSTEER_HOME_* overrides.
  expect(read("compose.yaml")).not.toContain("OPENSTEER_HOME_LIMIT_");
  expect(composeEnvironment(["managed", "browser-pool"])).toContain(
    "OPENSTEER_HOME_LIMIT_RUNNER_MEMORY=1280m",
  );
  expect(composeEnvironment(["managed"]).join("\n")).not.toContain("OPENSTEER_HOME_LIMIT_");
  expect(composeEnvironment([]).join("\n")).not.toContain("OPENSTEER_HOME_LIMIT_");
});

/** The environment `common.sh`'s compose() gives Docker Compose, on a 4 GiB two-CPU machine. */
function composeEnvironment(markers: readonly string[]): string[] {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-home-limits-"));
  try {
    writeFileSync(join(directory, "config.env"), "COMPOSE_PROJECT_NAME='shape'\n");
    for (const marker of markers) writeFileSync(join(directory, marker), "");
    const printed = execFileSync(
      "bash",
      [
        "-c",
        `source "$1"; machine_size() { echo 4096 2; }; env() { printf '%s\\n' "$@"; }; compose config`,
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
  expect(read("opensteer-home")).toContain("running_services");
  expect(read("update.sh")).toContain("running_services");
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
