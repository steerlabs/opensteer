// A managed Home follows the feed address its account gives it now, has an update timer from
// install, reads its feed line in either form, and says which kind of update a release is
// (deploy/home/common.sh, update.sh, install-scheduler.sh).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { asOpensteerHomeCallsUpdate } from "./home-update.test-support.js";

const recipe = join(import.meta.dirname, "../deploy/home");
const id = "cc_00000000-0000-4000-8000-000000000001";
const clientId = "occ_00000000-0000-4000-8000-000000000002";
const secret = `ocs_${"A".repeat(43)}`;
const configured = "https://releases.example.test/managed/stable.json";
const moved = "https://feed.example.test/opensteer/stable.json";
let work: string;
let home: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "opensteer-home-updates-"));
  home = join(work, "home");
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeFileSync(join(home, "managed"), "");
  writeFileSync(join(home, "secrets", "oidc_client_secret"), secret);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function config(feedLine?: string) {
  writeFileSync(
    join(home, "config.env"),
    [
      "OPENSTEER_HOME_HOSTNAME=cc.example.test",
      "OPENSTEER_HOME_ACCOUNT_ORIGIN='https://account.example.test'",
      `OPENSTEER_HOME_MANAGED_ID='${id}'`,
      `OPENSTEER_HOME_OIDC_CLIENT_ID='${clientId}'`,
      ...(feedLine === undefined ? [] : [feedLine]),
      "",
    ].join("\n"),
  );
}

/** Stands in for curl: answers the account's feed route with `answer`, or fails when null. */
function account(answer: object | null) {
  writeFileSync(
    join(work, "curl"),
    `#!/usr/bin/env bash
cat > /dev/null # curl --config - reads its credentials from stdin
out='' url=''
while (($#)); do
  case $1 in --output) out=$2; shift 2 ;; --) url=$2; shift 2 ;; *) shift ;; esac
done
printf '%s\\n' "$url" >> "${work}/asked"
${answer === null ? "exit 7" : `printf '%s' '${JSON.stringify(answer)}' > "$out"; printf 200`}
`,
  );
  chmodSync(join(work, "curl"), 0o755);
}

/** Runs `script` with common.sh sourced; public-address checks pass unless named as failing. */
function run(script: string, failingAddresses: readonly string[] = []) {
  return spawnSync(
    "bash",
    [
      "-c",
      `source "$1"; managed_feed_resolution() { case "$1" in ${failingAddresses.map((a) => `'${a}'`).join("|") || "''"}) return 1 ;; esac; echo ok; }; ${script}`,
      "updates",
      join(recipe, "common.sh"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, OPENSTEER_HOME_DIR: home, PATH: `${work}:${process.env.PATH}` },
    },
  );
}

const feedLine = () =>
  readFileSync(join(home, "config.env"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("OPENSTEER_HOME_RELEASE_MANIFEST_URL"));

it("follows the feed address the account gives now, and rewrites its own line", () => {
  config(`OPENSTEER_HOME_RELEASE_MANIFEST_URL='${configured}'`);
  account({ releaseManifestUrl: moved });
  const result = run("managed_feed");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${moved}\n`);
  expect(result.stderr).toContain("now follows");
  expect(feedLine()).toEqual([`OPENSTEER_HOME_RELEASE_MANIFEST_URL='${moved}'`]);
  expect(readFileSync(join(work, "asked"), "utf8")).toBe(
    `https://account.example.test/v1/cloud-computers/${id}/release-feed\n`,
  );
  // A Home that was born without a feed gets one the same way.
  config();
  expect(run("managed_feed").stdout).toBe(`${moved}\n`);
  expect(feedLine()).toEqual([`OPENSTEER_HOME_RELEASE_MANIFEST_URL='${moved}'`]);
});

const portalLines = () =>
  readFileSync(join(home, "config.env"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("OPENSTEER_HOME_PORTAL_ORIGIN"));

it("takes the account's portal into config.env at each check, and only an https origin", () => {
  config(`OPENSTEER_HOME_RELEASE_MANIFEST_URL='${configured}'`);
  const before = readFileSync(join(home, "config.env"), "utf8");
  for (const portalOrigin of [
    undefined,
    "http://portal.example.test",
    "https://portal.example.test/",
    "https://user@portal.example.test",
    "https://portal.example.test'\nOPENSTEER_HOME_HOSTNAME='x",
    "https://portal.example.test\nhttps://other.example.test",
    7,
  ]) {
    account({ releaseManifestUrl: configured, portalOrigin });
    const result = run("managed_feed");
    expect(result.status, String(portalOrigin)).toBe(0);
    expect(readFileSync(join(home, "config.env"), "utf8"), String(portalOrigin)).toBe(before);
  }
  account({ releaseManifestUrl: configured, portalOrigin: "https://portal.example.test" });
  const result = run("managed_feed");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${configured}\n`);
  expect(result.stderr).toContain("portal");
  expect(portalLines()).toEqual(["OPENSTEER_HOME_PORTAL_ORIGIN='https://portal.example.test'"]);
  // The same answer again writes nothing; a moved portal replaces the line.
  expect(run("managed_feed").stderr).not.toContain("portal");
  account({ releaseManifestUrl: moved, portalOrigin: "https://portal.example.test:8443" });
  expect(run("managed_feed").stdout).toBe(`${moved}\n`);
  expect(portalLines()).toEqual([
    "OPENSTEER_HOME_PORTAL_ORIGIN='https://portal.example.test:8443'",
  ]);
  expect(feedLine()).toEqual([`OPENSTEER_HOME_RELEASE_MANIFEST_URL='${moved}'`]);
});

it("keeps its own address, and says so, when the account does not answer", () => {
  config(`OPENSTEER_HOME_RELEASE_MANIFEST_URL='${configured}'`);
  account(null);
  const result = run("managed_feed");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${configured}\n`);
  expect(result.stderr).toContain("did not answer");
  expect(feedLine()).toEqual([`OPENSTEER_HOME_RELEASE_MANIFEST_URL='${configured}'`]);
});

it("never takes an address that fails the boot checks", () => {
  config(`OPENSTEER_HOME_RELEASE_MANIFEST_URL='${configured}'`);
  for (const [answer, failing] of [
    [{ releaseManifestUrl: "http://feed.example.test/stable.json" }, []],
    [{ releaseManifestUrl: "https://user:pw@feed.example.test/x" }, []],
    [{ releaseManifestUrl: "https://feed.example.test/x?y=1" }, []],
    [{ releaseManifestUrl: moved }, [moved]], // resolves to a private address
    [{ releaseManifestUrl: 7 }, []],
    [{}, []],
  ] as const) {
    account(answer);
    const result = run("managed_feed", failing);
    expect(result.stdout, JSON.stringify(answer)).toBe(`${configured}\n`);
    expect(result.stderr, JSON.stringify(answer)).toContain("failed the checks");
    expect(feedLine()).toEqual([`OPENSTEER_HOME_RELEASE_MANIFEST_URL='${configured}'`]);
  }
  // Its own address is checked too: one that fails is never used.
  config(`OPENSTEER_HOME_RELEASE_MANIFEST_URL='${configured}'`);
  account(null);
  const own = run("managed_feed", [configured]);
  expect(own.status).not.toBe(0);
  expect(own.stdout).toBe("");
});

it("reads its feed line quoted or bare, and says so when the line is there but unreadable", () => {
  for (const line of [
    `OPENSTEER_HOME_RELEASE_MANIFEST_URL='${configured}'`,
    `OPENSTEER_HOME_RELEASE_MANIFEST_URL=${configured}`,
  ]) {
    config(line);
    expect(run("configured_feed").stdout, line).toBe(`${configured}\n`);
  }
  config(`OPENSTEER_HOME_RELEASE_MANIFEST_URL="${configured}"`);
  const unreadable = run("configured_feed");
  expect(unreadable.status).not.toBe(0);
  expect(unreadable.stderr).toContain(`OPENSTEER_HOME_RELEASE_MANIFEST_URL='https://`);
  config();
  expect(run("configured_feed")).toMatchObject({ status: 0, stdout: "" });
  // The message an operator reads names the form that works.
  expect(readFileSync(join(recipe, "update.sh"), "utf8")).toContain(
    "Set OPENSTEER_HOME_RELEASE_MANIFEST_URL='https://…' in config.env",
  );
});

it("tells a release it already runs, a rebuild of the same version, and an older one apart", () => {
  const selection = (version: string, digit: string) =>
    `OPENSTEER_HOME_VERSION=${version}\nOPENSTEER_HOME_HOST_IMAGE=example.test/host@sha256:${digit.repeat(64)}\n`;
  const change = (active: string, candidate: string) => {
    writeFileSync(join(work, "active.env"), active);
    writeFileSync(join(work, "candidate.env"), candidate);
    return run(`release_change "${work}/active.env" "${work}/candidate.env"`).stdout.trim();
  };
  expect(change(selection("1.2.3", "a"), selection("1.2.3", "a"))).toBe("same");
  expect(change(selection("1.2.3", "a"), selection("1.2.3", "b"))).toBe("rebuild");
  expect(change(selection("1.2.3", "a"), selection("1.2.4", "b"))).toBe("newer");
  expect(change(selection("1.10.0", "a"), selection("1.9.9", "b"))).toBe("older");
  const update = readFileSync(join(recipe, "update.sh"), "utf8");
  for (const said of [
    "Already on this release",
    "Same version, different build: updating",
    "older: refused",
  ])
    expect(update).toContain(said);
});

it("gives every managed Home an hourly update timer from install, feed or not", () => {
  config();
  const units = join(work, "units");
  mkdirSync(units);
  writeFileSync(join(work, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(work, "systemctl"), 0o755);
  const result = spawnSync("bash", [join(recipe, "install-scheduler.sh"), home, "opensteer-home"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${work}:${process.env.PATH}`, OPENSTEER_HOME_UNIT_DIR: units },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(units, "opensteer-home-update.timer"))).toBe(true);
  expect(readFileSync(join(units, "opensteer-home-update.timer"), "utf8")).toContain(
    "OnCalendar=hourly",
  );
  expect(readFileSync(join(units, "opensteer-home-update.service"), "utf8")).toContain(
    "opensteer-home scheduled-update",
  );
});

it("runs a scheduled update from the account's feed and decides by the release's identity", () => {
  config(`OPENSTEER_HOME_RELEASE_MANIFEST_URL='${configured}'`);
  // A managed Home's release is its images and its account's pinned recipe, which it runs already.
  const pin = {
    url: "https://releases.example.test/opensteer-home-installer.sh",
    sha256: "c".repeat(64),
  };
  // The release the Home runs, in its own directory.
  mkdirSync(join(home, "releases", "running"), { recursive: true });
  symlinkSync("releases/running", join(home, "current"));
  writeFileSync(join(home, "releases", "running", "recipe.sha256"), `${pin.sha256}\n`);
  const images = (digit: string) =>
    Object.fromEntries(
      // In the order release_to_env writes them (common.sh's services).
      ["host", "gateway", "runner", "browser-runtime", "browser-egress", "channel-runtime"].map(
        (service) => [service, `example.test/${service}@sha256:${digit.repeat(64)}`],
      ),
    );
  const selection = (version: string, digit: string) =>
    [
      `OPENSTEER_HOME_VERSION=${version}`,
      ...Object.entries(images(digit)).map(
        ([service, ref]) =>
          `OPENSTEER_HOME_${service.toUpperCase().replaceAll("-", "_")}_IMAGE=${ref}`,
      ),
      "",
    ].join("\n");
  const update = (running: string, feedRelease: { version: string; digit: string }) => {
    // The account's pin names the release the feed offers, and the feed's manifest names the
    // same installer: the two halves agree.
    account({ releaseManifestUrl: moved, recipe: pin });
    writeFileSync(join(home, "releases", "running", "images.env"), running);
    writeFileSync(
      join(work, "release.json"),
      JSON.stringify({
        version: feedRelease.version,
        images: images(feedRelease.digit),
        recipe: pin,
      }),
    );
    // The fetch records which address it used; going any further than the decision stops here.
    return run(
      `source "${join(recipe, "update.sh")}"
       fetch_manifest() { printf '%s\\n' "$1" > "${work}/fetched"; cp "${work}/release.json" "$2"; }
       room_for_release() { echo "went on to update" >&2; exit 42; }
       ${asOpensteerHomeCallsUpdate("scheduled-update")}`,
    );
  };
  const same = update(selection("1.2.3", "a"), { version: "1.2.3", digit: "a" });
  expect(same.status).toBe(0);
  expect(same.stdout).toContain("Already on this release (1.2.3).");
  expect(readFileSync(join(work, "fetched"), "utf8")).toBe(`${moved}\n`);
  const rebuild = update(selection("1.2.3", "a"), { version: "1.2.3", digit: "b" });
  expect(rebuild.stdout).toContain("Same version, different build: updating 1.2.3.");
  expect(rebuild.stderr).toContain("went on to update");
  const older = update(selection("1.10.0", "a"), { version: "1.9.9", digit: "b" });
  expect(older.status).not.toBe(0);
  expect(older.stderr).toContain("older: refused");
  expect(older.stderr).not.toContain("went on to update");
  const newer = update(selection("1.2.3", "a"), { version: "1.2.4", digit: "b" });
  expect(newer.stdout).toContain("Updating from 1.2.3 to 1.2.4.");
  expect(newer.stderr).toContain("went on to update");
});
