// A release is one directory: an update prepares the next one whole in releases/<id> beside the
// running one, writing nothing else, and switches by one rename of `current` once that release's own
// code started and checked it (deploy/home). The running release is this checkout's code; the next
// is a stand-in that says which it is.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { asOpensteerHomeCallsUpdate } from "./home-update.test-support.js";

const source = join(import.meta.dirname, "../deploy/home");
const releaseFiles = (() => {
  const line = /^release_files=\(([^)]*)\)$/mu.exec(
    readFileSync(join(source, "common.sh"), "utf8"),
  );
  if (!line?.[1]) throw new Error("common.sh names no release_files");
  return line[1].split(" ");
})();
const id = "cc_00000000-0000-4000-8000-000000000001";
const recipeUrl = "https://releases.example.test/opensteer-home-installer.sh";
const postgres = `postgres@sha256:${"9".repeat(64)}`;
const running = "1.2.3-aaaaaa";
let work: string;
let home: string;
let log: string;

/** A stand-in release that says which it is; its own code logs each step it is asked for, and fails it as told. */
type Steps = { prepare?: number; gate?: number; says?: string; units?: number };
function release(name: string, steps: Steps = {}) {
  const files: Record<string, string> = {};
  for (const file of releaseFiles) files[file] = `# release ${name}: ${file}\n`;
  files["common.sh"] = `release_files=(${releaseFiles.join(" ")})\n# release ${name}: common.sh\n`;
  files["opensteer-home"] = `#!/usr/bin/env bash
[[ $OPENSTEER_HOME_SWITCHING == "$(basename "$(dirname "$0")")" ]] || exit 9
printf 'release ${name} %s\\n' "$*" >> "${log}"
case $1 in
  release-prepare)
    printf 'sha256:%s example.test/${name.toLowerCase()}:pulled\\n' "$(printf '${name.toLowerCase()}%.0s' {1..64})" > "$(dirname "$0")/images.ids"
    ${steps.prepare ? `echo "${steps.says ?? ""}" >&2; exit ${steps.prepare}` : "exit 0"} ;;
  release-gate) ${steps.gate ? `echo "${steps.says ?? ""}" >&2; exit ${steps.gate}` : "exit 0"} ;;
esac
`;
  files["install-scheduler.sh"] = `#!/usr/bin/env bash
printf 'units from release ${name}\\n' >> "${log}"
exit ${steps.units ?? 0}
`;
  return files;
}

/** A standalone installer carrying these files and its version, as package-installer.sh writes one. */
function installer(files: Record<string, string>, version = "1.2.4") {
  const staged = mkdtempSync(join(work, "package-"));
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(staged, file), content);
    chmodSync(join(staged, file), 0o700);
  }
  writeFileSync(join(staged, "version"), `${version}\n`);
  const archive = execFileSync("tar", ["-C", staged, "-czf", "-", "."]);
  const body = archive.toString("base64").replaceAll(/.{76}/gu, "$&\n").replace(/\n?$/u, "\n");
  const path = join(work, `installer-${Math.random().toString(16).slice(2)}.sh`);
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
package=$(mktemp -d)
base64 -d <<'OPENSTEER_HOME_FILES' | tar -xzf - -C "$package"
${body}OPENSTEER_HOME_FILES
bash "$package/install.sh" "$@"
`,
  );
  return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

const images = (digit: string) =>
  Object.fromEntries(
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

/**
 * Compose's configuration stood in for: the images of selector $2 and PostgreSQL's ($1), as JSON,
 * in project $3.
 */
const configured = `configured() {
  jq -Rn --arg pg "$1" --arg name "\${3:-recipe-test}" '[inputs |
    capture("^OPENSTEER_HOME_(?<s>[A-Z_]+)_IMAGE=(?<i>.*)$")? |
    {key: (.s | ascii_downcase | gsub("_"; "-")), value: {image: .i}}] | from_entries |
    {name: $name, services: (. + {postgres: {image: $pg}})}' < "$2"
}`;

/**
 * Docker stood in for: images on this machine are those in work/present, each with an id made from
 * its name; the pod's PostgreSQL runs unless work/down exists; the rest is logged.
 */
const dockerStub = (work: string, log: string) => `docker() {
  case "$1 \${2:-}" in
    "info --format") echo "${work}" ;;
    "image inspect")
      grep -qxF -- "\${*: -1}" "${work}/present" || { echo "Error: No such image: \${*: -1}" >&2; return 1; }
      if [[ $3 == --format ]]; then printf 'sha256:%s\\n' "$(printf %s "\${*: -1}" | openssl dgst -sha256 -r | cut -c1-64)"; fi ;;
    "ps -aq") [[ ! -e "${work}/docker-fails" ]] || return 1; [[ -e "${work}/down" ]] || echo pg ;;
    "inspect --format") echo 'postgres running healthy 42' ;;
    "run --rm") echo '{}' ;;
    *) printf 'docker %s\\n' "$*" >> "${log}" ;;
  esac
}`;

/** Stands in for curl: the account's release-feed answer, and the installer at its address. */
function network(answer: object | null, bundle?: string) {
  accountRecipe = (answer as { recipe?: { url: string; sha256: string } } | null)?.recipe;
  writeFileSync(
    join(work, "curl"),
    `#!/usr/bin/env bash
cat > /dev/null
out='' url=''
while (($#)); do case $1 in --output) out=$2; shift 2 ;; --) url=$2; shift 2 ;; *) shift ;; esac; done
case $url in
  */release-feed) ${answer === null ? "exit 7" : `printf '%s' '${JSON.stringify(answer)}' > "$out"; printf 200`} ;;
  ${recipeUrl}) ${bundle ? `cp "${bundle}" "$out"` : "exit 22"} ;;
  *) exit 22 ;;
esac
`,
  );
  chmodSync(join(work, "curl"), 0o755);
}

/**
 * The installer the account pins now. Its feed's manifest names it too (both halves of one
 * release published), unless a test gives the manifest its own `recipe`.
 */
let accountRecipe: { url: string; sha256: string } | undefined;

/** The account pins this installer, and its feed serves `newer`'s images. */
function pinned(files: Record<string, string>, version?: string) {
  const b = installer(files, version);
  network(
    {
      releaseManifestUrl: "https://releases.example.test/stable.json",
      recipe: { url: recipeUrl, sha256: b.sha256 },
    },
    b.path,
  );
  return b;
}

/**
 * What the Home's own code runs with here: Docker, the database, the disk and the account stood in
 * for, then `fault`. The updater sources it, and so does each step a release with this checkout's
 * code runs in its own process (as its opensteer-home would, which runs only as root); a stand-in
 * release runs its own command.
 */
function standIns(fault = "") {
  const path = join(work, "stand-ins.sh");
  writeFileSync(
    path,
    `managed_feed_resolution() { echo ok; }
sync() { :; } # macOS syncs every disk at each call
fetch_manifest() { cp "${join(work, "release.json")}" "$2"; }
${configured}
compose() {
  [[ $1 != down || ! -e "${join(work, "stop-at-down")}" ]] || kill -KILL $BASHPID
  printf 'compose %s (%s)\\n' "$*" "\${release_dir##*/}" >> "${log}"
  case $1 in
    config) configured "${postgres}" "\${release_env:-$release_dir/images.env}" ;;
    exec) case "$*" in *psql*) echo 1048576 ;; *pg_dump*) echo 'dump of the database' ;; esac ;;
  esac
}
${dockerStub(work, log)}
df() { printf 'Filesystem 1M-blocks Used Available Capacity Mounted\\nstand-in 100000 1 %s 1%% /\\n' "$(cat "${join(work, "free")}")"; }
start_pod() { printf 'start_pod (%s)\\n' "\${release_dir##*/}" >> "${log}"; }
run_release() {
  if grep -q '^gate_release()' "$1/common.sh"; then
    OPENSTEER_HOME_SWITCHING=\${1##*/} bash -c 'source "$1/common.sh"; source "$1/update.sh"; source "$2"; "\${3/release-/}_release" "\${@:4}"' step "$1" "${path}" "\${@:2}"
  else
    OPENSTEER_HOME_SWITCHING=\${1##*/} "$1/opensteer-home" "\${@:2}"
  fi
}
${fault}
`,
  );
  return path;
}

/** The update as its timer runs it: the running release's own code (sourced from `current`, as
 * opensteer-home does), with the stand-ins above. */
function update(
  release: object,
  args = "scheduled-update",
  manifestPath?: string,
  /** More stand-ins, after the usual ones: a fault to inject. */
  fault = "",
) {
  const managed = existsSync(join(home, "managed"));
  writeFileSync(
    join(work, "release.json"),
    JSON.stringify(
      managed && accountRecipe && !("recipe" in release)
        ? { ...release, recipe: accountRecipe }
        : release,
    ),
  );
  return spawnSync(
    "bash",
    [
      "-c",
      `source "$1/common.sh"; source "$1/update.sh"; source "$1/machine-status.sh"; source "$2"
       ${asOpensteerHomeCallsUpdate(`${args}${manifestPath ? ` "${manifestPath}"` : ""}`)}`,
      "update",
      join(home, "current"),
      standIns(fault),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENSTEER_HOME_DIR: home,
        OPENSTEER_HOME_UNIT_DIR: join(work, "units"),
        PATH: `${work}:${process.env.PATH}`,
      },
    },
  );
}

const current = () => readlinkSync(join(home, "current"));
const releases = () => readdirSync(join(home, "releases")).sort();
const inCurrent = (file: string) => readFileSync(join(home, "current", file), "utf8");
const said = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
/** What no update may touch: the configuration and every secret, byte for byte. */
const data = () =>
  [
    readFileSync(join(home, "config.env"), "utf8"),
    ...readdirSync(join(home, "secrets")).map((file) =>
      readFileSync(join(home, "secrets", file), "utf8"),
    ),
  ].join("\0");
/** Nothing changed: the Home runs A as it did, it never stopped, and no other release is left. */
const untouched = () => {
  expect(current()).toBe(`releases/${running}`);
  // A run that changes nothing removes nothing either, the stray directory included.
  expect(releases()).toEqual([running, "1.2.4-stray0"]);
  expect(inCurrent("images.env")).toBe(selection("1.2.3", "a"));
  expect(said()).not.toContain("compose down");
  expect(existsSync(join(home, "update.pending"))).toBe(false);
};
const lastUpdate = () =>
  existsSync(join(home, "last-update.json"))
    ? (JSON.parse(readFileSync(join(home, "last-update.json"), "utf8")) as Record<string, string>)
    : undefined;

beforeEach(() => {
  accountRecipe = undefined;
  work = realpathSync(mkdtempSync(join(tmpdir(), "opensteer-home-release-")));
  home = join(work, "home");
  log = join(work, "log");
  mkdirSync(join(home, "secrets"), { recursive: true });
  mkdirSync(join(work, "units"));
  // The Home was installed with its units: an update refreshes them.
  writeFileSync(join(work, "units", "opensteer-home.service"), "[Service]\nExecStart=installed\n");
  writeFileSync(join(home, "managed"), "");
  writeFileSync(join(home, "secrets", "oidc_client_secret"), `ocs_${"A".repeat(43)}`);
  writeFileSync(join(home, "secrets", "postgres_password"), "kept\n");
  writeFileSync(
    join(home, "config.env"),
    [
      "COMPOSE_PROJECT_NAME='recipe-test'",
      "OPENSTEER_HOME_ACCOUNT_ORIGIN='https://account.example.test'",
      `OPENSTEER_HOME_MANAGED_ID='${id}'`,
      "OPENSTEER_HOME_OIDC_CLIENT_ID='occ_00000000-0000-4000-8000-000000000002'",
      "OPENSTEER_HOME_RELEASE_MANIFEST_URL='https://releases.example.test/stable.json'",
      "",
    ].join("\n"),
  );
  // Release A, as an install leaves it: this checkout's files, its selector and its identity.
  const a = join(home, "releases", running);
  mkdirSync(a, { recursive: true });
  for (const file of releaseFiles) cpSync(join(source, file), join(a, file));
  writeFileSync(join(a, "images.env"), selection("1.2.3", "a"));
  writeFileSync(join(a, "recipe.sha256"), `${"a".repeat(64)}\n`);
  symlinkSync(`releases/${running}`, join(home, "current"));
  // A preparation a stop cut short left this; nothing names it.
  mkdirSync(join(home, "releases", "1.2.4-stray0"));
  // On this machine: A's images, and room for more.
  writeFileSync(join(work, "present"), `${[...Object.values(images("a")), postgres].join("\n")}\n`);
  writeFileSync(join(work, "free"), "50000");
  // systemd stood in for: the Home's main unit is active unless work/main-state says otherwise.
  writeFileSync(
    join(work, "systemctl"),
    `#!/usr/bin/env bash\nprintf 'systemctl %s\\n' "$*" >> "${log}"\n[[ $1 != show ]] || cat "${work}/main-state" 2>/dev/null || echo active\n`,
  );
  chmodSync(join(work, "systemctl"), 0o755);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const newer = { version: "1.2.4", images: images("b") };

it("prepares the release whole in its own directory, gates it with its own code, then switches to it", () => {
  const b = pinned(release("B"));
  const before = data();
  const result = update(newer);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Updated Home to 1.2.4.");
  // `current` names B's directory: its files, the feed's images and the pinned installer.
  expect(current()).toMatch(/^releases\/1\.2\.4-/u);
  expect(inCurrent("compose.yaml")).toBe("# release B: compose.yaml\n");
  expect(inCurrent("images.env")).toBe(selection("1.2.4", "b"));
  expect(inCurrent("recipe.sha256").trim()).toBe(b.sha256);
  expect(inCurrent("database.dump")).toBe("dump of the database\n");
  // B readied itself and passed its gate before the switch; A stopped with A's own files.
  const steps = said();
  const order = [
    "release B release-prepare",
    `compose down (${running})`,
    "release B release-gate",
    "units from release B",
  ].map((step) => steps.indexOf(step));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((x, y) => x - y)).toEqual(order);
  // A is the way back; the stray directory is gone; nothing else changed.
  expect(readlinkSync(join(home, "previous"))).toBe(`releases/${running}`);
  expect(releases()).toEqual([running, current().slice("releases/".length)].sort());
  expect(existsSync(join(home, "update.pending"))).toBe(false);
  expect(lastUpdate()).toMatchObject({
    result: "updated",
    fromVersion: "1.2.3",
    toVersion: "1.2.4",
  });
  expect(data()).toBe(before);
});

it("changes nothing when the recipe does not match its SHA-256", () => {
  const b = installer(release("B"));
  network(
    {
      releaseManifestUrl: "https://releases.example.test/stable.json",
      recipe: { url: recipeUrl, sha256: "0".repeat(64) },
    },
    b.path,
  );
  const result = update(newer);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("does not match its SHA-256");
  untouched();
});

it.each([
  ["its pod does not become healthy", "The new release's services are not all healthy."],
  ["its maintenance check fails", "The new release's firewall check failed."],
  ["its Compose files do not parse", "compose: the candidate's files do not parse"],
])("stays on A when B fails its gate because %s, and starts A", (_case, says) => {
  pinned(release("B", { gate: 1, says }));
  const before = data();
  const result = update(newer);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(says);
  expect(result.stderr).toContain("The update was rolled back.");
  // A was current all along; B's containers stopped with A's files; A started.
  expect(current()).toBe(`releases/${running}`);
  expect(said()).toContain(`compose down --remove-orphans (${running})`);
  expect(said()).toContain(`start_pod (${running})`);
  expect(said()).not.toContain("units from release B");
  expect(existsSync(join(home, "update.pending"))).toBe(false);
  // B's directory stays until the next update, with the dump taken before it.
  const b = releases().find((name) => name.startsWith("1.2.4-") && name !== "1.2.4-stray0");
  expect(readFileSync(join(home, "releases", b!, "database.dump"), "utf8")).toBe(
    "dump of the database\n",
  );
  expect(result.stderr).toContain(`releases/${b}/database.dump`);
  expect(lastUpdate()).toMatchObject({ result: "rolled-back" });
  // It is remembered, by the directory of its first failure, before A starts again.
  expect(readFileSync(join(home, "update.failed"), "utf8")).toMatch(
    new RegExp(`^${b} [0-9a-f]{64} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00Z\\n$`, "u"),
  );
  expect(data()).toBe(before);
});

it("does not call it rolled back when A does not start again", () => {
  pinned(release("B", { gate: 1, says: "B fails its gate" }));
  const stuck = update(newer, "scheduled-update", undefined, "start_pod() { return 1; }");
  expect(stuck.status).not.toBe(0);
  expect(stuck.stderr).not.toContain("The update was rolled back.");
  expect(stuck.stderr).toContain("did not start again");
  expect(current()).toBe(`releases/${running}`);
  expect(existsSync(join(home, "update.pending"))).toBe(false);
});

it("never takes a managed Home's recipe from a manifest, and does not update without its account's pin", () => {
  const b = installer(release("B"));
  network({ releaseManifestUrl: "https://releases.example.test/stable.json" }, b.path);
  const result = update({ ...newer, recipe: { url: recipeUrl, sha256: b.sha256 } });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("gave no recipe for this release: not updating now");
  untouched();
});

/** The Home runs B's images already (an earlier updater took them without B's recipe). */
const runsImagesB = () => {
  writeFileSync(join(home, "current", "images.env"), selection("1.2.4", "b"));
  writeFileSync(join(work, "present"), `${[...Object.values(images("b")), postgres].join("\n")}\n`);
};

it("takes a release whose images it runs already but whose recipe it does not", () => {
  runsImagesB();
  const b = pinned(release("B"));
  const result = update(newer);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Same images, another recipe");
  expect(inCurrent("recipe.sha256").trim()).toBe(b.sha256);
});

/** The feed's manifest of release A, the one this Home runs, naming A's own installer. */
const releaseA = () => ({
  version: "1.2.3",
  images: images("a"),
  recipe: { url: recipeUrl, sha256: "a".repeat(64) },
});

it("does not mix releases: a managed Home whose account pins B's installer while its feed still serves A changes nothing", () => {
  // The account moved to B (built under the same version, as every head build is); the feed did not.
  pinned(release("B"), "1.2.3");
  const first = update(releaseA());
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout).toContain(
    "The release is still being published (its recipe and its images name different releases): not updating now; the next check tries again.",
  );
  expect(first.stdout).not.toContain("Same images, another recipe");
  // Nothing fetched, prepared, stopped or started; A runs as it did.
  untouched();
  expect(said()).not.toContain("release B");
  expect(said()).not.toContain("start_pod");
  expect(inCurrent("recipe.sha256")).toBe(`${"a".repeat(64)}\n`);
  // The next check that finds the same: recorded as waiting since the first.
  const again = update(releaseA());
  expect(again.status, again.stderr).toBe(0);
  untouched();
  expect(lastUpdate()).toMatchObject({
    result: "waiting",
    fromVersion: "1.2.3",
    toVersion: "1.2.3",
  });
});

it("does not mix releases: a managed Home whose feed serves D's images while its account still pins C's installer changes nothing", () => {
  const c = pinned(release("C"), "1.2.4");
  const d = installer(release("D"), "1.2.4");
  expect(d.sha256).not.toBe(c.sha256);
  for (const recipe of [{ url: recipeUrl, sha256: d.sha256 }, undefined]) {
    const result = update({ ...newer, recipe });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("The release is still being published");
    untouched();
    expect(said()).not.toMatch(/release [CD] /u);
  }
});

it("takes a managed release once its feed and its account name the same installer: one update", () => {
  const b = pinned(release("B"));
  const result = update({
    ...newer,
    recipe: { url: "https://elsewhere.example.test/b.sh", sha256: b.sha256 },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Updated Home to 1.2.4.");
  expect(said().match(/release B release-gate/gu)).toHaveLength(1);
  // The account's pin is the one fetched; the manifest's address is never used.
  expect(inCurrent("recipe.sha256").trim()).toBe(b.sha256);
});

/** A self-hosted Home given this manifest by its owner; returns its path. */
const owners = (manifest: object, bundle?: string) => {
  rmSync(join(home, "managed"));
  network(null, bundle);
  writeFileSync(join(work, "owner.json"), JSON.stringify(manifest));
  return join(work, "owner.json");
};

it("updates a self-hosted Home from the manifest its owner gives", () => {
  const b = installer(release("B"));
  const manifest = owners({ ...newer, recipe: { url: recipeUrl, sha256: b.sha256 } }, b.path);
  const result = update(newer, "update", manifest);
  expect(result.status, result.stderr).toBe(0);
  expect(inCurrent("compose.yaml")).toBe("# release B: compose.yaml\n");
});

it("keeps a self-hosted Home's recipe, copied whole into the new release, when its release names none", () => {
  const manifest = owners({ version: "1.2.5", images: images("c") });
  // The copy is this checkout's code, whose own steps run as root: they are stood in for here.
  const imagesOnly = update(
    newer,
    "update",
    manifest,
    `run_release() { printf 'release %s %s\\n' "\${1##*/}" "$2" >> "${log}"; }`,
  );
  expect(imagesOnly.status, imagesOnly.stderr).toBe(0);
  expect(imagesOnly.stdout).toContain("the recipe was not updated");
  expect(current()).toMatch(/^releases\/1\.2\.5-/u);
  expect(inCurrent("compose.yaml")).toBe(readFileSync(join(source, "compose.yaml"), "utf8"));
  expect(inCurrent("images.env")).toBe(selection("1.2.5", "c"));
});

it("waits quietly at the first check while the installer and the feed's images name different releases", () => {
  pinned(release("B"), "9.9.9");
  const first = update(newer);
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout).toContain("The release is still being published");
  untouched();
  expect(lastUpdate()).toBeUndefined();
  expect(readFileSync(join(home, "update.waiting"), "utf8")).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z\n1\.2\.3 1\.2\.4 9\.9\.9\n$/u,
  );
});

/** A note from an earlier check that found this same mismatch. */
const waitingSince = "2026-11-25T07:00:00Z";
const noteWaiting = () =>
  writeFileSync(join(home, "update.waiting"), `${waitingSince}\n1.2.3 1.2.4 9.9.9\n`);

it("records the same mismatch at a later check as an update waiting since the first", () => {
  noteWaiting();
  pinned(release("B"), "9.9.9");
  const second = update(newer);
  expect(second.status, second.stderr).toBe(0);
  expect(lastUpdate()).toEqual({
    result: "waiting",
    at: waitingSince,
    fromVersion: "1.2.3",
    toVersion: "1.2.4",
  });
  untouched();
});

it("clears the waiting update when the two halves agree and the update goes through", () => {
  noteWaiting();
  pinned(release("B"));
  const through = update(newer);
  expect(through.status, through.stderr).toBe(0);
  expect(lastUpdate()).toMatchObject({ result: "updated" });
  expect(existsSync(join(home, "update.waiting"))).toBe(false);
});

it.each([
  [
    "B's own preparation fails (its images, PostgreSQL's included, cannot be obtained)",
    () => pinned(release("B", { prepare: 1, says: "The release's images could not be obtained." })),
    "",
    "The release could not be prepared. Nothing was changed.",
  ],
  [
    "one of A's images is not on this machine for the way back",
    () => {
      pinned(release("B"));
      writeFileSync(join(work, "present"), `${postgres}\n`);
    },
    "",
    "for a rollback. Nothing was changed.",
  ],
  [
    "the manifest's fetch fails after it wrote valid JSON",
    () => pinned(release("B")),
    `fetch_manifest() { cp "${"$"}{work}/release.json" "$2"; return 18; }`,
    "The release manifest could not be fetched. Nothing was changed.",
  ],
  [
    "the selector cannot be written",
    () => pinned(release("B")),
    `publish_file() { [[ $2 == *.env ]] && return 1; sync "$1" && mv -f -- "$1" "$2"; }`,
    "The release selector could not be written.",
  ],
  [
    "there is no room for the release's images",
    () => {
      pinned(release("B"));
      writeFileSync(join(work, "free"), "2000");
    },
    "",
    "There is not enough room on this machine for the release. Nothing was changed.",
  ],
  [
    "the installer holds a file its release does not list, such as the Home's own state",
    () => pinned({ ...release("B"), "config.env": "OPENSTEER_HOME_HOSTNAME=elsewhere\n" }),
    "",
    "The recipe holds config.env, which it does not list.",
  ],
  [
    "the installer lacks a file its release lists",
    () => {
      const files = release("B");
      delete files["firewall.sh"];
      pinned(files);
    },
    "",
    "The recipe lacks firewall.sh.",
  ],
])("never stops the Home when %s", (_case, arrange, fault, says) => {
  const before = data();
  arrange();
  const result = update(newer, "scheduled-update", undefined, fault.replace("${work}", work));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(says);
  untouched();
  expect(data()).toBe(before);
});

it("says nothing was changed when the switch's record fails, and leaves no record a start would act on", () => {
  pinned(release("B"));
  // The record is renamed into place, then its directory's sync fails.
  const result = update(
    newer,
    "scheduled-update",
    undefined,
    `publish_file() {
       if [[ $2 == */update.pending ]]; then mv -f -- "$1" "$2"; return 1; fi
       sync "$1" && mv -f -- "$1" "$2"
     }`,
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("The update could not be recorded. Nothing was changed.");
  untouched();
});

it("goes by `current`: a switch whose rename happened is the update, even when its sync failed", () => {
  pinned(release("B"));
  const result = update(
    newer,
    "scheduled-update",
    undefined,
    `switch_link() {
       ln -sfn -- "$1" "$2.new" && mv -f "$([[ $(uname -s) == Darwin ]] && echo -h || echo -T)" -- "$2.new" "$2"
       return 1
     }`,
  );
  // B is current: the update is made, and what follows it (here `previous`) failed, which is said
  // and is a failure until the next start finishes it; no update runs before that.
  expect(result.stdout).toContain("Updated Home to 1.2.4.");
  expect(result.stderr).not.toContain("rolled back");
  expect(current()).toMatch(/^releases\/1\.2\.4-/u);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("the next start finishes it, and no update runs until then");
  expect(existsSync(join(home, "update.pending"))).toBe(true);
  expect(lastUpdate()).toMatchObject({ result: "updated", toVersion: "1.2.4" });
  // The next update (this checkout's code, as B is a stand-in) refuses before it changes anything.
  const next = spawnSync(
    "bash",
    [
      "-c",
      `source "$1/common.sh"; source "$1/update.sh"; ${asOpensteerHomeCallsUpdate("update")}`,
      "next",
      source,
    ],
    { encoding: "utf8", env: { ...process.env, OPENSTEER_HOME_DIR: home } },
  );
  expect(next.status).not.toBe(0);
  expect(next.stderr).toContain("The last switch of releases is not finished yet");
});

it("reports an update that switched as updated, whether or not its units or its result could be written", () => {
  pinned(release("B", { units: 1 }));
  const result = update(
    newer,
    "scheduled-update",
    undefined,
    'mv() { [[ ${!#} != */last-update.json ]] || return 1; command mv "$@"; }',
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Updated Home to 1.2.4.");
  expect(result.stderr).toContain("units could not be written yet: the next start writes them");
  expect(result.stderr).toContain("The update's result could not be recorded.");
  expect(current()).toMatch(/^releases\/1\.2\.4-/u);
});

/** The next start's recovery, by the code of the release `current` names (this checkout's). */
function nextStart() {
  return spawnSync(
    "bash",
    [
      "-c",
      `source "$1"
       compose() { printf 'compose %s (%s)\\n' "$*" "\${release_dir##*/}" >> "${log}"; }
       docker() { printf 'docker %s\\n' "$*" >> "${log}"; }
       start_pod() { printf 'start_pod (%s)\\n' "\${release_dir##*/}" >> "${log}"; }
       recover_switch && start_pod`,
      "start",
      join(source, "common.sh"),
    ],
    { encoding: "utf8", env: { ...process.env, OPENSTEER_HOME_DIR: home } },
  );
}

it.each([
  ["after the record, before A stopped", "", "stop-at-down"],
  [
    "while B's gate ran",
    'run_release() { [[ $2 != release-gate ]] || kill -KILL $BASHPID; OPENSTEER_HOME_SWITCHING=${1##*/} "$1/opensteer-home" "$2"; }',
    "",
  ],
  ["before the switch's rename", "switch_link() { kill -KILL $BASHPID; }", ""],
])("goes back to A at the next start when the update stopped %s", (_case, fault, marker) => {
  pinned(release("B"));
  if (marker) writeFileSync(join(work, marker), "");
  const stopped = update(newer, "scheduled-update", undefined, fault);
  expect(stopped.status).not.toBe(0);
  expect(existsSync(join(home, "update.pending"))).toBe(true);
  const next = nextStart();
  expect(next.status, next.stderr).toBe(0);
  expect(next.stdout).toContain("the Home runs its previous release");
  expect(current()).toBe(`releases/${running}`);
  expect(said()).toContain("compose down --remove-orphans");
  expect(existsSync(join(home, "update.pending"))).toBe(false);
});

it("keeps B at the next start when the update stopped after the switch", () => {
  pinned(release("B"));
  const stopped = update(
    newer,
    "scheduled-update",
    undefined,
    "finish_switch() { kill -KILL $BASHPID; }",
  );
  expect(stopped.status).not.toBe(0);
  expect(current()).toMatch(/^releases\/1\.2\.4-/u);
  const next = nextStart();
  expect(next.status, next.stderr).toBe(0);
  expect(current()).toMatch(/^releases\/1\.2\.4-/u);
  expect(readlinkSync(join(home, "previous"))).toBe(`releases/${running}`);
  expect(existsSync(join(home, "update.pending"))).toBe(false);
  expect(said()).not.toContain("compose down --remove-orphans");
});

/** B, this checkout's code with a new PostgreSQL digest in a release of its own, and its own preparation. */
function candidate() {
  // B is this checkout's code with a new PostgreSQL digest, in a release of its own.
  const b = join(home, "releases", "1.2.4-bbbbbb");
  mkdirSync(b);
  for (const file of releaseFiles) cpSync(join(source, file), join(b, file));
  const newPostgres = `postgres:18-alpine@sha256:${"b".repeat(64)}`;
  writeFileSync(
    join(b, "compose.yaml"),
    readFileSync(join(source, "compose.yaml"), "utf8").replace(
      /image: postgres:[^\n]*/u,
      `image: ${newPostgres}`,
    ),
  );
  writeFileSync(join(b, "images.env"), selection("1.2.4", "b"));
  // The account does not answer unless a test says what it answers.
  network(null);
  const prepare = (env: Record<string, string> = {}) =>
    spawnSync(
      "bash",
      [
        "-c",
        `source "$1/common.sh"
         ${configured}
         # compose() runs \`env -i … docker compose ARGS\`: Docker Compose stood in for, by its arguments.
         env() {
           while [[ $1 != docker ]]; do shift; done; shift 2
           local file='' selector='' project=''
           while (($#)); do
             case $1 in
               -f) [[ -n $file ]] || file=$2; shift 2 ;;
               --env-file) [[ $2 == */images.env ]] && selector=$2; shift 2 ;;
               --project-name) project=$2; shift 2 ;;
               --project-directory) shift 2 ;;
               *) break ;;
             esac
           done
           case $1 in
             pull)
               printf 'pull %s by %s\\n' "$*" "$file" >> "${log}"
               [[ -z \${FAIL_PULL:-} ]] || return 1
               sed -n 's/^ *image: \\(postgres.*\\)$/\\1/p' "$file" >> "${join(work, "present")}"
               sed -n 's/^OPENSTEER_HOME_[A-Z_]*_IMAGE=//p' "$selector" >> "${join(work, "present")}" ;;
             config) configured "$(sed -n 's/^ *image: \\(postgres.*\\)$/\\1/p' "$file")" "$selector" "$project" ;;
           esac
         }
         ${dockerStub(work, log)}
         sync() { :; } # macOS syncs every disk at each call; when a release flushes is its own test
         check_release_stamps() { :; }
         prepare_release`,
        "prepare",
        b,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENSTEER_HOME_DIR: home,
          PATH: `${work}:${process.env.PATH}`,
          ...env,
        },
      },
    );
  return { b, newPostgres, prepare };
}

it("prepares a release with its own Compose files: PostgreSQL's image too, each recorded by its id", () => {
  const { b, newPostgres, prepare } = candidate();
  const prepared = prepare();
  expect(prepared.status, prepared.stderr).toBe(0);
  expect(said()).toContain(`by ${b}/compose.yaml`);
  expect(readFileSync(join(work, "present"), "utf8")).toContain(newPostgres);
  expect(existsSync(join(b, "runner-oci.json"))).toBe(true);
  // Every image it runs is recorded by its id, PostgreSQL's too; digests stay as they are.
  const inventory = readFileSync(join(b, "images.ids"), "utf8").trim().split("\n");
  // What it was about to pull (PostgreSQL's and the six selected), then each with its id.
  expect(inventory.filter((line) => line.startsWith("- "))).toHaveLength(7);
  expect(inventory.filter((line) => /^sha256:[0-9a-f]{64} /u.test(line))).toHaveLength(7);
  expect(readFileSync(join(b, "images.env"), "utf8")).toBe(selection("1.2.4", "b"));
});

const portalLines = () =>
  readFileSync(join(home, "config.env"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("OPENSTEER_HOME_PORTAL_ORIGIN"));

// Each prepare starts the recipe's shell anew (about half a second on a Mac), so the portal's
// cases are two tests: ten starts in one sat at the default five seconds.
it("leaves config.env as it was when the account's answer names no usable portal", () => {
  const { prepare } = candidate();
  const before = readFileSync(join(home, "config.env"), "utf8");
  for (const answer of [
    { releaseManifestUrl: "https://releases.example.test/stable.json" },
    { portalOrigin: "http://portal.example.test" },
    { portalOrigin: "https://portal.example.test/path" },
    { portalOrigin: "https://portal.example.test'\nOPENSTEER_HOME_HOSTNAME='x" },
    { portalOrigin: 7 },
  ]) {
    network(answer);
    expect(prepare().status, JSON.stringify(answer)).toBe(0);
    expect(readFileSync(join(home, "config.env"), "utf8"), JSON.stringify(answer)).toBe(before);
  }
});

it("takes the account's portal into config.env when it prepares a release, before its gate starts it", () => {
  // A Home installed before its account's boot answer named the portal: its config.env has none,
  // and the code it runs does not ask for one. The release it updates to does, as it prepares.
  const { b, prepare } = candidate();
  const before = readFileSync(join(home, "config.env"), "utf8");
  network({
    releaseManifestUrl: "https://releases.example.test/stable.json",
    portalOrigin: "https://portal.example.test",
  });
  const prepared = prepare();
  expect(prepared.status, prepared.stderr).toBe(0);
  expect(portalLines()).toEqual(["OPENSTEER_HOME_PORTAL_ORIGIN='https://portal.example.test'"]);
  // Every other line stays as it was.
  expect(
    readFileSync(join(home, "config.env"), "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("OPENSTEER_HOME_PORTAL_ORIGIN")),
  ).toEqual(before.split("\n"));
  // The release's own Compose file hands it to the Host its gate starts.
  expect(readFileSync(join(b, "compose.yaml"), "utf8")).toContain(
    "OPENSTEER_PORTAL_ORIGIN: ${OPENSTEER_HOME_PORTAL_ORIGIN:-}",
  );
  // A portal the account moves is followed; one it stops naming is kept.
  network({ portalOrigin: "https://portal.example.test:8443" });
  expect(prepare().status).toBe(0);
  expect(portalLines()).toEqual([
    "OPENSTEER_HOME_PORTAL_ORIGIN='https://portal.example.test:8443'",
  ]);
  network(null);
  expect(prepare().status).toBe(0);
  expect(portalLines()).toEqual([
    "OPENSTEER_HOME_PORTAL_ORIGIN='https://portal.example.test:8443'",
  ]);
  // A self-hosted Home has no account to ask.
  rmSync(join(home, "managed"));
  network({ portalOrigin: "https://other.example.test" });
  expect(prepare().status).toBe(0);
  expect(portalLines()).toEqual([
    "OPENSTEER_HOME_PORTAL_ORIGIN='https://portal.example.test:8443'",
  ]);
});

it("starts each release with the limits its own code computes: an update brings a new split", () => {
  // A Cloud Computer that runs A, whose code gave the Host 640 MiB on a 4 GiB machine.
  writeFileSync(join(home, "browser-pool"), "");
  const a = join(home, "releases", running);
  oldSplitIn(a);
  const b = join(home, "releases", "1.2.4-bbbbbb");
  mkdirSync(b);
  for (const file of releaseFiles) cpSync(join(source, file), join(b, file));
  writeFileSync(join(b, "images.env"), selection("1.2.4", "b"));
  // What Docker Compose is given when a release's own code starts its containers (its gate, or
  // any later start), on the 4 GiB machine.
  const started = (release: string) =>
    spawnSync(
      "bash",
      [
        "-c",
        `source "$1/common.sh"; release_dir=$1
         machine_size() { echo 3908 2; }; env() { printf '%s\\n' "$@"; }; compose up -d`,
        "start",
        release,
      ],
      { encoding: "utf8", env: { ...process.env, OPENSTEER_HOME_DIR: home } },
    ).stdout.split("\n");
  expect(started(a)).toContain("OPENSTEER_HOME_LIMIT_HOST_MEMORY=640m");
  expect(started(b)).toContain("OPENSTEER_HOME_LIMIT_HOST_MEMORY=1536m");
  expect(started(b)).toContain("OPENSTEER_HOME_LIMIT_RUNNER_MEMORY=2450m");
  // Nothing keeps the old split: the limits are not written anywhere the next release reads.
  expect(readFileSync(join(home, "config.env"), "utf8")).not.toContain("LIMIT");
  expect(readdirSync(home).filter((name) => /limit/iu.test(name))).toEqual([]);
  // The gate is the new release's own command, which reads its own common.sh.
  expect(readFileSync(join(b, "opensteer-home"), "utf8")).toContain('source "${own%/*}/common.sh"');

  // The update's own path: A's code switches to B (cutover), B's gate runs in a process of its own
  // from B's code (run_release, as `opensteer-home release-gate` runs it once its root and
  // directory checks pass, which a test cannot), and B's start gives Compose B's limits. Docker
  // and the machine's size are stood in for; Compose is told what each start asked for, and
  // refuses to start, so B's gate fails and A comes back with A's own limits.
  const composed = join(work, "composed");
  const stubs = `machine_size() { echo 3908 2; }
sync() { :; }
${dockerStub(work, log)}
env() {
  local limits=() file='' sub=''
  while [[ $1 != docker ]]; do [[ $1 != OPENSTEER_HOME_LIMIT_HOST_MEMORY=* ]] || limits+=("$1"); shift; done
  shift 2
  while (($#)); do
    case $1 in
      -f) [[ -n $file ]] || file=$2; shift 2 ;;
      --env-file | --project-name | --project-directory) shift 2 ;;
      *) sub=$1; break ;;
    esac
  done
  printf '%s %s %s\n' "$(basename "$(dirname "$file")")" "$sub" "\${limits[*]}" >> "${composed}"
  case $sub in
    config) echo '{"name":"recipe-test"}' ;;
    up) return 1 ;;
  esac
}`;
  writeFileSync(join(work, "stubs.sh"), stubs);
  const update = spawnSync(
    "bash",
    [
      "-c",
      `stubs=$3; source "$1/common.sh"; release_dir=$1; source "$stubs"
       run_release() {
         OPENSTEER_HOME_SWITCHING=\${1##*/} bash -c 'source "$1/common.sh"; source "$2"; "$3"' gate "$1" "$stubs" "\${2/release-/}_release"
       }
       status=0; cutover "$1" "$2" || status=$?
       echo "cutover $status"
       start_pod || :`,
      "update",
      a,
      b,
      join(work, "stubs.sh"),
    ],
    { encoding: "utf8", env: { ...process.env, OPENSTEER_HOME_DIR: home } },
  );
  expect(update.stdout, update.stderr).toContain("cutover 1");
  expect(update.stderr).toContain("The new release did not start.");
  const starts = readFileSync(composed, "utf8")
    .trim()
    .split("\n")
    .filter((line) => / up /u.test(line));
  expect(starts).toEqual([
    // B's gate, with B's split.
    "1.2.4-bbbbbb up OPENSTEER_HOME_LIMIT_HOST_MEMORY=1536m",
    // A again, after B's gate failed, with A's.
    `${running} up OPENSTEER_HOME_LIMIT_HOST_MEMORY=640m`,
  ]);
  expect(current()).toBe(`releases/${running}`);
});

/**
 * A Cloud Computer's pod as Docker Compose keeps it, stood in for: each release's own compose()
 * and start_pod() run, from that release's own files, on a 4 GiB machine; Compose records each
 * `up` with the Host's limit and creates the Host only when what it is asked for differs from the
 * Host it runs (never under --no-recreate), as Compose recreates a container whose configuration
 * changed. The switch of `current` is marked where it happens.
 */
function composeStandIn(composed: string) {
  const pod = join(work, "pod");
  return `eval "stub_$(declare -f compose)"
eval "$(source "$release_dir/common.sh"; declare -f compose start_pod)"
machine_size() { echo 3908 2; }
prepare_release() { :; }
prepare_runner_apparmor() { :; }
host_pid() { echo 42; }
apply_firewall() { :; }
check_firewall() { :; }
pod_healthy() { :; }
readlink() { if [[ $1 == /proc/* ]]; then echo 'net:[1]'; else command readlink "$@"; fi; }
eval "real_$(declare -f switch_link)"
switch_link() {
  real_switch_link "$@" || return
  [[ $2 != */current ]] || printf 'switched to %s\\n' "\${1##*/}" >> "${composed}"
}
env() {
  local limits=() file='' sub='' asked
  while [[ $1 != docker ]]; do [[ $1 != OPENSTEER_HOME_LIMIT_HOST_MEMORY=* ]] || limits+=("$1"); shift; done
  shift 2
  while (($#)); do
    case $1 in
      -f) [[ -n $file ]] || file=$2; shift 2 ;;
      --env-file | --project-name | --project-directory) shift 2 ;;
      *) sub=$1; break ;;
    esac
  done
  asked="$(basename "$(dirname "$file")") \${limits[*]}"
  case $sub in
    up)
      printf '%s up %s\\n' "\${asked%% *}" "\${limits[*]}" >> "${composed}"
      if [[ ! -s "${pod}" ]] || [[ " $* " != *" --no-recreate "* && $(cat "${pod}") != "$asked" ]]; then
        printf 'creates the Host: %s\\n' "$asked" >> "${composed}"
        printf '%s' "$asked" > "${pod}"
      fi ;;
    down) printf '%s down\\n' "\${asked%% *}" >> "${composed}"; rm -f -- "${pod}" ;;
    *) stub_compose "$@" ;;
  esac
}`;
}

/** Release A gives the Host 640 MiB on a 4 GiB machine; this checkout's code gives it 1536 MiB. */
function oldSplitIn(release: string) {
  writeFileSync(
    join(release, "common.sh"),
    readFileSync(join(release, "common.sh"), "utf8").replace(
      /host=\$\(clamp \$\(\(budget \/ 8\)\) \d+ 2048\)/u,
      "host=$(clamp $((budget / 8)) 640 2048)",
    ),
  );
}

const sourceFiles = () =>
  Object.fromEntries(releaseFiles.map((file) => [file, readFileSync(join(source, file), "utf8")]));

it("hands the Home to the release it switched to: after an update only the new release's own code starts it", () => {
  // A Cloud Computer that runs A, with A's split, updates to B, this checkout's code.
  writeFileSync(join(home, "browser-pool"), "");
  oldSplitIn(join(home, "releases", running));
  const composed = join(work, "composed");
  writeFileSync(join(work, "pod"), `${running} OPENSTEER_HOME_LIMIT_HOST_MEMORY=640m`);
  pinned(sourceFiles());
  const result = update(newer, "scheduled-update", undefined, composeStandIn(composed));
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Updated Home to 1.2.4.");
  const b = current().slice("releases/".length);
  const steps = readFileSync(composed, "utf8").trim().split("\n");
  expect(steps).toEqual([
    `${running} down`,
    // B's gate, by B's own code: the Host created once, with B's split.
    `${b} up OPENSTEER_HOME_LIMIT_HOST_MEMORY=1536m`,
    `creates the Host: ${b} OPENSTEER_HOME_LIMIT_HOST_MEMORY=1536m`,
    `${b} up OPENSTEER_HOME_LIMIT_HOST_MEMORY=1536m`,
    `switched to ${b}`,
    // After the switch, B's own code owns the Home: the pod its gate started is the one asked for,
    // so Compose changes nothing (no second Host, no second drop of /healthz).
    `${b} up OPENSTEER_HOME_LIMIT_HOST_MEMORY=1536m`,
    `${b} up OPENSTEER_HOME_LIMIT_HOST_MEMORY=1536m`,
  ]);
  const after = steps.slice(steps.indexOf(`switched to ${b}`));
  expect(after.filter((step) => step.includes("640m"))).toEqual([]);
  expect(steps.filter((step) => step.startsWith("creates the Host"))).toHaveLength(1);
});

it("hands the Home to the release it went back to: after a rollback only that release's own code starts it", () => {
  // A Cloud Computer that runs B (this checkout's code, B's split) goes back to A (A's split).
  writeFileSync(join(home, "browser-pool"), "");
  const a = join(home, "releases", running);
  oldSplitIn(a);
  const b = "1.2.4-bbbbbb";
  mkdirSync(join(home, "releases", b));
  for (const file of releaseFiles) cpSync(join(source, file), join(home, "releases", b, file));
  writeFileSync(join(home, "releases", b, "images.env"), selection("1.2.4", "b"));
  rmSync(join(home, "current"));
  symlinkSync(`releases/${b}`, join(home, "current"));
  symlinkSync(`releases/${running}`, join(home, "previous"));
  const composed = join(work, "composed");
  writeFileSync(join(work, "pod"), `${b} OPENSTEER_HOME_LIMIT_HOST_MEMORY=1536m`);
  const back = spawnSync(
    "bash",
    [
      "-c",
      `source "$1/common.sh"; source "$1/update.sh"; source "$2"
       rollback_home`,
      "rollback",
      join(home, "current"),
      standIns(composeStandIn(composed)),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENSTEER_HOME_DIR: home,
        OPENSTEER_HOME_UNIT_DIR: join(work, "units"),
        PATH: `${work}:${process.env.PATH}`,
      },
    },
  );
  expect(back.status, back.stderr).toBe(0);
  expect(back.stdout).toContain("Back on the previous release (1.2.3).");
  const steps = readFileSync(composed, "utf8").trim().split("\n");
  expect(steps).toEqual([
    `${b} down`,
    `${running} up OPENSTEER_HOME_LIMIT_HOST_MEMORY=640m`,
    `creates the Host: ${running} OPENSTEER_HOME_LIMIT_HOST_MEMORY=640m`,
    `${running} up OPENSTEER_HOME_LIMIT_HOST_MEMORY=640m`,
    `switched to ${running}`,
    `${running} up OPENSTEER_HOME_LIMIT_HOST_MEMORY=640m`,
    `${running} up OPENSTEER_HOME_LIMIT_HOST_MEMORY=640m`,
  ]);
  const after = steps.slice(steps.indexOf(`switched to ${running}`));
  expect(after.filter((step) => step.includes("1536m"))).toEqual([]);
  expect(steps.filter((step) => step.startsWith("creates the Host"))).toHaveLength(1);
});

it("names a release's tagged images by their ids, by tags no release can move", () => {
  const { b, prepare } = candidate();
  // Images named by tag are named by their id instead, by a tag no release can move.
  const tagged = selection("1.2.4", "b").replaceAll(/@sha256:b{64}/gu, ":1.2.4");
  writeFileSync(join(b, "images.env"), tagged);
  expect(prepare().status).toBe(0);
  expect(readFileSync(join(b, "release.env"), "utf8")).toBe(tagged);
  expect(readFileSync(join(b, "images.env"), "utf8")).toMatch(
    /^OPENSTEER_HOME_HOST_IMAGE=opensteer-home-image\/host:[0-9a-f]{64}$/mu,
  );
  expect(said()).toMatch(
    /docker image tag sha256:[0-9a-f]{64} opensteer-home-image\/host:[0-9a-f]{64}/u,
  );
});

it("stops preparing on a failed pull, also a Home's own images' PostgreSQL pull", () => {
  const { prepare } = candidate();
  // A pull that fails stops it, also a Home's own images' PostgreSQL pull.
  const failed = prepare({ FAIL_PULL: "1" });
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain("The release's images could not be obtained.");
  writeFileSync(join(home, "local-images"), "");
  const local = prepare({ FAIL_PULL: "1" });
  expect(local.status).not.toBe(0);
  expect(said()).toContain("pull --quiet postgres by");
});

it("refuses a release whose units lack the main service or a timer", () => {
  const b = join(work, "release-b");
  mkdirSync(b);
  for (const file of releaseFiles) cpSync(join(source, file), join(b, file));
  const check = () =>
    spawnSync("bash", ["-c", 'source "$1/common.sh"; check_units', "units", b], {
      encoding: "utf8",
      env: { ...process.env, OPENSTEER_HOME_DIR: home },
    });
  expect(check().status, check().stderr).toBe(0);
  // A scheduler that writes one service with the right lines, and nothing else.
  writeFileSync(
    join(b, "install-scheduler.sh"),
    `#!/usr/bin/env bash\nprintf 'ExecStart=%s/current/opensteer-home start\\n' "$1" > "$OPENSTEER_HOME_UNITS_CHECK/other.service"\n`,
  );
  expect(check().status).not.toBe(0);
});

/** The real scheduler against a unit directory of its own, with systemctl and others stood in for. */
function scheduling() {
  const units = join(work, "units");
  const fake = (name: string, body: string) => {
    writeFileSync(join(work, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(work, name), 0o755);
  };
  fake("systemctl", `printf 'systemctl %s\\n' "$*" >> "${log}"\n[[ $1 != show ]] || echo no`);
  const schedule = () =>
    spawnSync("bash", [join(source, "install-scheduler.sh"), home, "recipe-test"], {
      encoding: "utf8",
      env: { ...process.env, OPENSTEER_HOME_UNIT_DIR: units, PATH: `${work}:${process.env.PATH}` },
    });
  const main = join(units, "recipe-test.service");
  return { units, fake, schedule, main };
}

it("writes a unit only where it differs, and reloads systemd only then", () => {
  const { units, schedule, main } = scheduling();
  expect(schedule().status).toBe(0);
  expect(readFileSync(main, "utf8")).toContain(`ExecStart=${home}/current/opensteer-home start`);
  expect(said()).toContain("systemctl daemon-reload");
  expect(said()).toContain("systemctl enable recipe-test.service recipe-test-update.timer");
  rmSync(log);
  expect(schedule().status).toBe(0);
  expect(said()).not.toContain("daemon-reload");
  expect(said()).not.toContain("systemctl enable");
  // The fleet's update checks spread over a quarter of an hour; an update runs while the Home is down.
  expect(readFileSync(join(units, "recipe-test-update.timer"), "utf8")).toContain(
    "RandomizedDelaySec=15min\nFixedRandomDelay=true",
  );
  expect(readFileSync(join(units, "recipe-test-update.service"), "utf8")).not.toContain(
    "Requisite=",
  );
  expect(readFileSync(join(units, "recipe-test-backup.service"), "utf8")).toContain(
    "Requisite=recipe-test.service",
  );
});

it("leaves a unit a person disabled, and starts an enabled timer that is not running", () => {
  const { units, fake, schedule } = scheduling();
  expect(schedule().status).toBe(0);
  // A timer a person disabled stays disabled; an enabled one that is not running is started.
  fake(
    "systemctl",
    `printf 'systemctl %s\\n' "$*" >> "${log}"
[[ $1 != show ]] || echo no
[[ "$*" != "is-enabled --quiet recipe-test-update.timer" ]] || exit 1
[[ "$*" != "is-active --quiet recipe-test-backup.timer" ]] || exit 3`,
  );
  rmSync(log);
  expect(schedule().status).toBe(0);
  expect(said()).not.toContain("systemctl enable");
  expect(said()).not.toContain("systemctl start recipe-test-update.timer");
  expect(said()).toContain("systemctl start recipe-test-backup.timer");
  // A unit file that was gone is written again and enabled: no person disabled it.
  rmSync(join(units, "recipe-test-maintain.timer"));
  rmSync(log);
  expect(schedule().status).toBe(0);
  expect(said()).toContain("systemctl enable recipe-test-maintain.timer\n");
});

it("enables the units at the next scheduling when the first was cut short before it enabled them", () => {
  const { schedule } = scheduling();
  expect(schedule().status).toBe(0);
  rmSync(log);
  // A first scheduling cut short before it enabled them enables them at the next.
  rmSync(join(home, "units.enabled"));
  expect(schedule().status).toBe(0);
  expect(said()).toContain("systemctl enable recipe-test.service");
});

it("writes every unit beside itself and renames it: an interrupted write never leaves an empty unit", () => {
  const { fake, schedule, main } = scheduling();
  expect(schedule().status).toBe(0);
  // A unit that differs, whose copy into place dies before its first byte, stays as it was.
  writeFileSync(main, "[Service]\nExecStart=the installed one\n");
  fake("install", "exit 1");
  expect(schedule().status).not.toBe(0);
  expect(readFileSync(main, "utf8")).toBe("[Service]\nExecStart=the installed one\n");
});

it("installs the release the real packager bundles with the real fetch: every listed file, and its version", () => {
  const bundle = join(work, "opensteer-home-installer.sh");
  execFileSync("bash", [join(source, "package-installer.sh"), bundle]);
  network(null, bundle);
  const sha256 = createHash("sha256").update(readFileSync(bundle)).digest("hex");
  const unpacked = join(work, "unpacked");
  mkdirSync(unpacked);
  const fetched = spawnSync(
    "bash",
    [
      "-c",
      `source "$1"; fetch_recipe "${recipeUrl}" "${sha256}" "$2" false && install_release "$2"`,
      "fetch",
      join(source, "common.sh"),
      unpacked,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, OPENSTEER_HOME_DIR: home, PATH: `${work}:${process.env.PATH}` },
    },
  );
  expect(fetched.status, fetched.stderr).toBe(0);
  expect(readdirSync(unpacked).sort()).toEqual([...releaseFiles, "version"].sort());
  const installed = fetched.stdout.trim();
  expect(readdirSync(installed).sort()).toEqual([...releaseFiles, "version"].sort());
  for (const file of releaseFiles)
    expect(readFileSync(join(installed, file), "utf8"), file).toBe(
      readFileSync(join(source, file), "utf8"),
    );
});

it("finishes a managed boot without touching the Home's release, and keeps the operator's command current", () => {
  // The bootstrap unit runs install.sh --resume-managed at every boot (it runs only as root on
  // Linux: its order is read). A finished boot only starts the main unit.
  const install = readFileSync(join(source, "install.sh"), "utf8");
  const finished = install.indexOf(
    'if [[ -f "$home_dir/boot/$outcome" ]]; then finish_managed_boot',
  );
  const installed = install.indexOf('release_dir=$(install_release "$source_dir")');
  expect(finished).toBeGreaterThan(0);
  expect(finished).toBeLessThan(installed);
  const finish = install.slice(install.indexOf("finish_managed_boot() {"), finished);
  expect(finish).not.toContain("install_release");
  expect(finish).not.toContain("$source_dir");
  // A command that waited for the lock while an update switched runs as the current release.
  const command = readFileSync(join(source, "opensteer-home"), "utf8");
  expect(command).toContain('exec "$current/opensteer-home" "${command_args[@]}"');
});

/** B failed its gate here at 08:00: its directory and the dump taken before it, and the memory. */
const failedBefore = (sha256: string, reason = "") => {
  const failed = join(home, "releases", "1.2.4-failed");
  mkdirSync(failed);
  writeFileSync(join(failed, "database.dump"), "pre-migration dump\n");
  const identity = createHash("sha256")
    .update(`${selection("1.2.4", "b")}${sha256}\n`)
    .digest("hex");
  writeFileSync(
    join(home, "update.failed"),
    `1.2.4-failed ${identity} 2026-11-25T08:00:00Z${reason && ` ${reason}`}\n`,
  );
  return failed;
};

it("does not try again by itself a release that failed its gate here, and keeps the dump from before it", () => {
  const failed = failedBefore(pinned(release("B")).sha256);
  const again = update(newer);
  expect(again.status, again.stderr).toBe(0);
  expect(again.stdout).toContain("Release 1.2.4 did not start here: waiting for the next one");
  expect(said()).not.toContain("release B");
  expect(said()).not.toContain("compose down");
  expect(current()).toBe(`releases/${running}`);
  expect(readFileSync(join(failed, "database.dump"), "utf8")).toBe("pre-migration dump\n");
  expect(lastUpdate()).toEqual({
    result: "not-retried",
    at: "2026-11-25T08:00:00Z",
    fromVersion: "1.2.3",
    toVersion: "1.2.4",
  });
});

it("says a person went back from a release, not that it did not start, when the next check offers it", () => {
  failedBefore(pinned(release("B")).sha256, "went-back");
  const again = update(newer);
  expect(again.status, again.stderr).toBe(0);
  expect(again.stdout).toContain(
    "You went back from 1.2.4 on 2026-11-25: waiting for the next one (sudo opensteer-home update --retry installs it again).",
  );
  expect(again.stdout).not.toContain("did not start here");
  expect(said()).not.toContain("release B");
  expect(current()).toBe(`releases/${running}`);
});

it("tries another release, and forgets the failed one once that one is in", () => {
  failedBefore(pinned(release("B")).sha256);
  pinned(release("C"), "1.2.5");
  writeFileSync(join(work, "present"), `${[...Object.values(images("a")), postgres].join("\n")}\n`);
  const next = update({ version: "1.2.5", images: images("c") });
  expect(next.status, next.stderr).toBe(0);
  expect(said()).toContain("release C release-gate");
  expect(current()).toMatch(/^releases\/1\.2\.5-/u);
  expect(existsSync(join(home, "update.failed"))).toBe(false);
  expect(releases()).not.toContain("1.2.4-failed");
});

it("tries the failed release once more when the operator asks (update --retry)", () => {
  failedBefore(pinned(release("B")).sha256);
  // As opensteer-home sets it for `update --retry`; a timer never does.
  const retried = update(newer, "update", undefined, "retry_failed=true");
  expect(retried.status, retried.stderr).toBe(0);
  expect(said()).toContain("release B release-gate");
  expect(current()).toMatch(/^releases\/1\.2\.4-/u);
  expect(readFileSync(join(source, "opensteer-home"), "utf8")).toContain(
    'if [[ $1 == update && ${2:-} == --retry ]]; then retry_failed=true; set -- update "${@:3}"; fi',
  );
});

it("starts A when the update stops between the failed gate and remembering it, and tries once more at most", () => {
  pinned(release("B", { gate: 1, says: "B fails its gate" }));
  const stopped = update(
    newer,
    "scheduled-update",
    undefined,
    "remember_failed() { kill -KILL $BASHPID; }",
  );
  expect(stopped.status).not.toBe(0);
  const next = nextStart();
  expect(next.status, next.stderr).toBe(0);
  expect(current()).toBe(`releases/${running}`);
  expect(said()).toContain("start_pod (");
  expect(existsSync(join(home, "update.pending"))).toBe(false);
  // Not remembered: the next check tries B again, once, and then remembers it.
  expect(existsSync(join(home, "update.failed"))).toBe(false);
});

it("removes the images a release it gave up on pulled, by their ids", () => {
  pinned(release("B", { prepare: 1, says: "B's preparation fails late" }));
  const result = update(newer);
  expect(result.status).not.toBe(0);
  // By the name it pulled, never by id and never forced: an image goes only when nothing else names it.
  expect(said()).toContain("docker image rm -- example.test/b:pulled");
  expect(said()).not.toContain("image rm -f");
  untouched();
});

it("flushes a release to disk before anything names it", () => {
  pinned(release("B"));
  const result = update(
    newer,
    "scheduled-update",
    undefined,
    `sync() { printf 'sync %s\\n' "$*" >> "${log}"; }`,
  );
  expect(result.status, result.stderr).toBe(0);
  const steps = said();
  const flushed = [...steps.matchAll(/^sync -f -- .*\/releases\/1\.2\.4-[^/\n]+$/gmu)].map(
    (m) => m.index,
  );
  expect(flushed).toHaveLength(2);
  expect(flushed[0]).toBeLessThan(steps.indexOf(`compose down (${running})`));
  expect(flushed[1]).toBeGreaterThan(steps.indexOf("release B release-gate"));
  const install = readFileSync(join(source, "install.sh"), "utf8");
  expect(install).toContain(
    'sync -f -- "$release_dir"\n  switch_link "releases/${release_dir##*/}" "$home_dir/current"',
  );
});

it("checks every sandbox policy it publishes", () => {
  const b = join(work, "release-b");
  mkdirSync(b);
  for (const file of releaseFiles) cpSync(join(source, file), join(b, file));
  writeFileSync(join(b, "images.env"), selection("1.2.4", "b"));
  const published = spawnSync(
    "bash",
    [
      "-c",
      `source "$1/common.sh"
       ${configured}
       compose() { configured "${postgres}" "$release_dir/images.env"; }
       docker() { echo '{}'; }
       # The browser's policy is not moved into place, once.
       mv() { if [[ $4 == */chromium-oci.json ]]; then return 1; fi; command mv "$@"; }
       install_sandbox_policies`,
      "policies",
      b,
    ],
    { encoding: "utf8", env: { ...process.env, OPENSTEER_HOME_DIR: home } },
  );
  expect(published.status).not.toBe(0);
});

it("runs every Compose command in the Home's one project, whatever a release's files name", () => {
  writeFileSync(join(home, "config.env"), "OPENSTEER_HOME_HOSTNAME=home.example.test\n");
  const printed = execFileSync(
    "bash",
    [
      "-c",
      `source "$1"; env() { printf '%s\\n' "$@"; }; compose config`,
      "project",
      join(source, "common.sh"),
    ],
    { encoding: "utf8", env: { ...process.env, OPENSTEER_HOME_DIR: home } },
  );
  expect(printed).toContain("--project-name\nopensteer-home\n");
  expect(readFileSync(join(source, "common.sh"), "utf8")).toContain(
    `[[ $(compose_project) == "$(pod_project)" ]] || fail "The release's Compose project is not this Home's."`,
  );
});

it("refuses a release whose units do not do what they are for", () => {
  const b = join(work, "release-b");
  mkdirSync(b);
  for (const file of releaseFiles) cpSync(join(source, file), join(b, file));
  // The real scheduler, then one change to what it wrote.
  const broken = (change: string) => {
    writeFileSync(
      join(b, "install-scheduler.sh"),
      `#!/usr/bin/env bash\nbash "${join(source, "install-scheduler.sh")}" "$@" && cd "$OPENSTEER_HOME_UNITS_CHECK" && ${change}\n`,
    );
    return spawnSync("bash", ["-c", 'source "$1/common.sh"; check_units', "units", b], {
      encoding: "utf8",
      env: { ...process.env, OPENSTEER_HOME_DIR: home, PATH: `${work}:${process.env.PATH}` },
    });
  };
  expect(broken("true").status).toBe(0);
  // The update service stops the Home; the backup timer has no schedule.
  expect(
    broken("sed -i.was 's/scheduled-update$/stop/' opensteer-home-update.service").status,
  ).not.toBe(0);
  expect(broken("sed -i.was '/^OnCalendar=/d' opensteer-home-backup.timer").status).not.toBe(0);
  // A schedule systemd cannot read (asked of systemd-analyze, here a stand-in that knows these).
  writeFileSync(
    join(work, "systemd-analyze"),
    "#!/usr/bin/env bash\ncase \"$1 $3\" in 'calendar hourly' | 'calendar daily' | timespan\\ *) exit 0 ;; esac\nexit 1\n",
  );
  chmodSync(join(work, "systemd-analyze"), 0o755);
  expect(broken("true").status).toBe(0);
  expect(
    broken(
      "sed -i.was 's/^OnCalendar=daily$/OnCalendar=never-a-calendar/' opensteer-home-backup.timer",
    ).status,
  ).not.toBe(0);
});

it("says the Home runs its feed's release when the pair agrees again, clearing what was waiting", () => {
  writeFileSync(
    join(home, "last-update.json"),
    JSON.stringify({ result: "waiting", at: "2026-11-25T07:00:00Z", toVersion: "1.2.4" }),
  );
  network({
    releaseManifestUrl: "https://releases.example.test/stable.json",
    recipe: { url: recipeUrl, sha256: "a".repeat(64) },
  });
  const result = update({ version: "1.2.3", images: images("a") });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Already on this release (1.2.3).");
  expect(lastUpdate()).toMatchObject({ result: "updated", toVersion: "1.2.3" });
});

it("keeps the dump a rollback names when the next check changes nothing (the runbook's steps)", () => {
  pinned(release("B", { gate: 1, says: "B fails its gate" }));
  const failed = update(newer);
  const named = /kept in (\S+database\.dump)/u.exec(failed.stderr)?.[1];
  expect(named).toBeDefined();
  // Step 3: the operator pulls the feed back to A; the next check changes nothing, removes nothing.
  network({
    releaseManifestUrl: "https://releases.example.test/stable.json",
    recipe: { url: recipeUrl, sha256: "a".repeat(64) },
  });
  const back = update({ version: "1.2.3", images: images("a") });
  expect(back.stdout).toContain("Already on this release");
  // Step 4: the dump is where the message said.
  expect(readFileSync(named!, "utf8")).toBe("dump of the database\n");
});

it("updates a Home whose pod is down: no dump, and the new release started and checked", () => {
  writeFileSync(join(work, "down"), "");
  pinned(release("B"));
  const result = update(newer);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("The Home is not running: no dump is taken");
  expect(said()).not.toContain("pg_dump");
  expect(current()).toMatch(/^releases\/1\.2\.4-/u);
});

it("goes back to the previous release when the operator asks, and does not take the bad one again", () => {
  // P was the release before A; A runs now.
  const p = join(home, "releases", "1.2.2-pppppp");
  mkdirSync(p);
  for (const [file, content] of Object.entries(release("P"))) {
    writeFileSync(join(p, file), content);
    chmodSync(join(p, file), 0o700);
  }
  writeFileSync(join(p, "images.env"), selection("1.2.2", "c"));
  symlinkSync("releases/1.2.2-pppppp", join(home, "previous"));
  const rollback = () =>
    spawnSync(
      "bash",
      [
        "-c",
        `source "$1/common.sh"; source "$1/update.sh"
       sync() { :; }
       ${configured}
       compose() {
         printf 'compose %s (%s)\\n' "$*" "\${release_dir##*/}" >> "${log}"
         [[ $1 != config ]] || configured "${postgres}" "$release_dir/images.env"
       }
       start_pod() { printf 'start_pod (%s)\\n' "\${release_dir##*/}" >> "${log}"; }
       ${dockerStub(work, log)}
       rollback_home`,
        "rollback",
        join(home, "current"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENSTEER_HOME_DIR: home,
          OPENSTEER_HOME_UNIT_DIR: join(work, "units"),
          PATH: `${work}:${process.env.PATH}`,
        },
      },
    );
  // P's images are gone from this machine: nothing stops.
  const missing = rollback();
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("The previous release's images are not all on this machine");
  expect(said()).not.toContain("compose down");
  writeFileSync(
    join(work, "present"),
    `${[...Object.values(images("c")), postgres].join("\n")}\n`,
    { flag: "a" },
  );
  const back = rollback();
  expect(back.status, back.stderr).toBe(0);
  expect(back.stdout).toContain("Back on the previous release (1.2.2).");
  expect(said()).toContain(`compose down (${running})`);
  expect(said()).toContain("release P release-gate");
  expect(current()).toBe("releases/1.2.2-pppppp");
  expect(readlinkSync(join(home, "previous"))).toBe(`releases/${running}`);
  // The release left is remembered, as one the person went back from: no timer installs it again.
  expect(readFileSync(join(home, "update.failed"), "utf8")).toMatch(
    new RegExp(
      `^${running} [0-9a-f]{64} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00Z went-back\\n$`,
      "u",
    ),
  );
});

it("reads a self-hosted Home's feed from config.env, and a line it cannot read is a failed check", () => {
  rmSync(join(home, "managed"));
  const fetched = update(
    newer,
    "scheduled-update",
    undefined,
    `fetch_manifest() { printf '%s\\n' "$1" > "${join(work, "fetched")}"; return 22; }`,
  );
  expect(fetched.status).not.toBe(0);
  expect(readFileSync(join(work, "fetched"), "utf8")).toBe(
    "https://releases.example.test/stable.json\n",
  );
  writeFileSync(
    join(home, "config.env"),
    readFileSync(join(home, "config.env"), "utf8").replace(
      /MANIFEST_URL='([^']*)'/u,
      'MANIFEST_URL="$1"',
    ),
  );
  const unreadable = update(newer, "scheduled-update");
  expect(unreadable.status).not.toBe(0);
  expect(unreadable.stderr).toContain("could not be read from config.env");
});

it("does not remember a release whose switch failed for another reason than its gate", () => {
  pinned(release("B"));
  const result = update(newer, "scheduled-update", undefined, "switch_link() { return 1; }");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("The switch to 1.2.4 failed before it was made");
  expect(result.stderr).toContain("the next check tries it again");
  expect(current()).toBe(`releases/${running}`);
  expect(said()).toContain(`start_pod (${running})`);
  expect(existsSync(join(home, "update.failed"))).toBe(false);
});

it("remembers every release that failed here, keeping the first one's line and dump", () => {
  const failed = failedBefore(pinned(release("B")).sha256);
  const firstLine = readFileSync(join(home, "update.failed"), "utf8");
  pinned(release("C", { gate: 1, says: "C fails its gate" }), "1.2.5");
  const result = update({ version: "1.2.5", images: images("c") });
  expect(result.stderr).toContain("The update was rolled back.");
  const lines = readFileSync(join(home, "update.failed"), "utf8").split("\n").filter(Boolean);
  expect(lines).toHaveLength(2);
  expect(`${lines[0]}\n`).toBe(firstLine);
  expect(readFileSync(join(failed, "database.dump"), "utf8")).toBe("pre-migration dump\n");
});

/** B is this checkout's code, its preparation and gate stood in for: after the switch, its own code owns the Home. */
const ownedByB = "prepare_release() { :; }; gate_release() { :; }";

it("switches a Home a person stopped and leaves it stopped", () => {
  writeFileSync(join(work, "main-state"), "inactive\n");
  pinned(sourceFiles());
  const result = update(newer, "scheduled-update", undefined, ownedByB);
  expect(result.status, result.stderr).toBe(0);
  expect(said()).toContain(`compose down (${current().slice("releases/".length)})`);
  expect(said()).not.toContain("start_pod");
  expect(said()).not.toContain("systemctl start");
});

it("starts a Home whose start had failed through its main unit after the switch", () => {
  writeFileSync(join(work, "main-state"), "failed\n");
  pinned(sourceFiles());
  const result = update(newer, "scheduled-update", undefined, ownedByB);
  expect(result.status, result.stderr).toBe(0);
  expect(said()).toContain("systemctl start --no-block opensteer-home.service");
  expect(said()).not.toContain("start_pod");
});

it.each([
  ["active", ""],
  ["inactive", "inactive\n"],
  ["failed", "failed\n"],
])(
  "tells the release it switched to that the main unit was %s, and leaves the Home to that release's own command",
  (told, state) => {
    if (state) writeFileSync(join(work, "main-state"), state);
    pinned(release("B"));
    const result = update(newer);
    expect(result.status, result.stderr).toBe(0);
    expect(said()).toContain(`release B release-own ${told}`);
    // Nothing of the code that switched starts or stops the Home after B's gate.
    expect(said().slice(said().indexOf("release B release-gate"))).not.toMatch(
      /start_pod|compose down \(|systemctl start/u,
    );
    // This checkout's own command takes the step only from a switch to its release.
    const command = readFileSync(join(source, "opensteer-home"), "utf8");
    expect(command).toContain(
      '[[ $# == 2 && $2 =~ ^(active|inactive|failed)$ && ${OPENSTEER_HOME_SWITCHING:-} == "${release_dir##*/}" ]] ||',
    );
    expect(command).toContain('own_release "$2"');
  },
);

it("does not take Docker's failed answer for a Home that is down", () => {
  writeFileSync(join(work, "docker-fails"), "");
  pinned(release("B"));
  const result = update(newer);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    "Docker could not say whether this Home runs. Nothing was changed.",
  );
  untouched();
});

it("names no dump when a down Home's update is rolled back without one", () => {
  writeFileSync(join(work, "down"), "");
  pinned(release("B", { gate: 1, says: "B fails its gate" }));
  const result = update(newer);
  expect(result.stderr).toContain("no dump was taken before it (the Home was not running)");
  expect(result.stderr).not.toContain("database.dump");
});

it("tells a feed line it cannot read, or a config.env it cannot read, from no feed", () => {
  rmSync(join(home, "managed"));
  const config = readFileSync(join(home, "config.env"), "utf8");
  writeFileSync(
    join(home, "config.env"),
    config.replace(
      "OPENSTEER_HOME_RELEASE_MANIFEST_URL=",
      "export OPENSTEER_HOME_RELEASE_MANIFEST_URL=",
    ),
  );
  const unparsed = update(newer, "scheduled-update");
  expect(unparsed.status).not.toBe(0);
  expect(unparsed.stderr).toContain("could not be read from config.env");
  writeFileSync(join(home, "config.env"), config);
  chmodSync(join(home, "config.env"), 0o000);
  const unreadable = update(newer, "scheduled-update");
  chmodSync(join(home, "config.env"), 0o600);
  expect(unreadable.status).not.toBe(0);
  expect(unreadable.stdout).not.toContain("No update feed is set");
});

it("gives a Home installed without units (--prepare) none from a start", () => {
  rmSync(join(work, "units", "opensteer-home.service"));
  const started = spawnSync(
    "bash",
    ["-c", 'source "$1/common.sh"; refresh_units', "start", join(home, "current")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENSTEER_HOME_DIR: home,
        OPENSTEER_HOME_UNIT_DIR: join(work, "units"),
        PATH: `${work}:${process.env.PATH}`,
      },
    },
  );
  expect(started.status, started.stderr).toBe(0);
  expect(readdirSync(join(work, "units"))).toEqual([]);
  expect(said()).not.toContain("systemctl");
});
