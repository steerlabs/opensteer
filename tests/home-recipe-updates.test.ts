// A release is one thing: an update carries the release's recipe (the Home's scripts and Compose
// files) with its images, checked against its SHA-256 before anything stops, gated by the new
// recipe's own start and maintenance check, and rolled back with the images when that fails
// (deploy/home/update.sh, common.sh, install-scheduler.sh). The updater's code is the real one;
// the recipes on disk are stand-ins that say which they are.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const source = join(import.meta.dirname, "../deploy/home");
const recipeFiles = (() => {
  const line = /^recipe_files=\(([^)]*)\)$/mu.exec(readFileSync(join(source, "common.sh"), "utf8"));
  if (!line?.[1]) throw new Error("common.sh names no recipe_files");
  return line[1].split(" ");
})();
const id = "cc_00000000-0000-4000-8000-000000000001";
const recipeUrl = "https://releases.example.test/opensteer-home-installer.sh";
let work: string;
let home: string;
let log: string;

/** A recipe whose files say which it is; its gate passes or fails as asked. */
function recipe(
  name: string,
  gate: { readonly exit: number; readonly says?: string } = { exit: 0 },
) {
  const files: Record<string, string> = {};
  for (const file of recipeFiles) files[file] = `# recipe ${name}: ${file}\n`;
  files["opensteer-home"] = `#!/usr/bin/env bash
printf 'gate %s %s\\n' "${name}" "$1" >> "${log}"
${gate.says ? `echo "${gate.says}" >&2` : ""}
exit ${gate.exit}
`;
  files["backup.sh"] = `postgres_tool() { echo "dump of recipe ${name}"; }\n`;
  files["install-scheduler.sh"] = `#!/usr/bin/env bash
printf 'units from recipe %s\\n' "${name}" >> "${log}"
`;
  return files;
}

/** A standalone installer carrying these files, as package-installer.sh writes one. */
function installer(files: Record<string, string>): { path: string; sha256: string } {
  const staged = mkdtempSync(join(work, "package-"));
  for (const [file, content] of Object.entries(files)) writeFileSync(join(staged, file), content);
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

/** Installs recipe A on the Home, with its data that no update may touch. */
function installed(files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) writeFileSync(join(home, file), content);
  chmodSync(join(home, "opensteer-home"), 0o700);
  chmodSync(join(home, "install-scheduler.sh"), 0o700);
  writeFileSync(join(home, "images.env"), selection("1.2.3", "a"));
}

/** Stands in for curl: the account's release-feed answer, and the installer at its address. */
function network(answer: object | null, bundle?: string) {
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

/** The update as its timer runs it, with Docker and the database stood in for. */
function update(release: object, args = "scheduled-update", manifestPath?: string) {
  writeFileSync(join(work, "release.json"), JSON.stringify(release));
  return spawnSync(
    "bash",
    [
      "-c",
      `source "$1"; source "$2"
       managed_feed_resolution() { echo ok; }
       fetch_manifest() { cp "${join(work, "release.json")}" "$2"; }
       fetch_release_images() { :; }
       check_release_stamps() { :; }
       compose_project() { echo recipe-test; }
       install_sandbox_policies() { :; }
       compose() {
         printf 'compose %s\\n' "$*" >> "${log}"
         case "$1 \${2:-}" in "ps -q") echo "container-$3" ;; esac
       }
       docker() { case $1 in inspect) c=\${*: -1}; echo "example.test/\${c#container-}@sha256:${"a".repeat(64)}" ;; esac; }
       start_pod() { printf 'start_pod from the updater (the previous recipe)\\n' >> "${log}"; }
       update_home ${args}${manifestPath ? ` "${manifestPath}"` : ""}`,
      "update",
      join(source, "common.sh"),
      join(source, "update.sh"),
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

const onDisk = () => readFileSync(join(home, "compose.yaml"), "utf8");
const said = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
/** What no update may touch: the configuration and every secret, byte for byte. */
const data = () =>
  [
    readFileSync(join(home, "config.env"), "utf8"),
    ...readdirSync(join(home, "secrets")).map((file) =>
      readFileSync(join(home, "secrets", file), "utf8"),
    ),
  ].join("\0");

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "opensteer-home-recipe-"));
  home = join(work, "home");
  log = join(work, "log");
  mkdirSync(join(home, "secrets"), { recursive: true });
  mkdirSync(join(work, "units"));
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
  installed(recipe("A"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const newer = { version: "1.2.4", images: images("b") };

it("updates a managed Home's recipe with its images, from its account's answer only", () => {
  const b = installer(recipe("B"));
  network(
    {
      releaseManifestUrl: "https://releases.example.test/stable.json",
      recipe: { url: recipeUrl, sha256: b.sha256 },
    },
    b.path,
  );
  const before = data();
  const result = update(newer);
  expect(result.status, result.stderr).toBe(0);
  // Recipe B is on disk, the images are B's, B's own code gated it, B's units followed the commit.
  expect(onDisk()).toBe("# recipe B: compose.yaml\n");
  expect(readFileSync(join(home, "images.env"), "utf8")).toBe(selection("1.2.4", "b"));
  expect(said()).toContain("gate B update-gate");
  expect(said()).toContain("units from recipe B");
  expect(said().indexOf("gate B")).toBeLessThan(said().indexOf("units from recipe B"));
  expect(existsSync(join(home, "update.pending"))).toBe(false);
  // Configuration and secrets are never touched.
  expect(data()).toBe(before);
});

it("changes nothing when the recipe does not match its SHA-256", () => {
  const b = installer(recipe("B"));
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
  expect(onDisk()).toBe("# recipe A: compose.yaml\n");
  expect(readFileSync(join(home, "images.env"), "utf8")).toBe(selection("1.2.3", "a"));
  expect(said()).not.toContain("compose down");
  expect(existsSync(join(home, "update.pending"))).toBe(false);
});

it.each([
  ["its pod does not become healthy", "The new release's services are not all healthy."],
  ["its maintenance check fails", "The new release's firewall check failed."],
])("rolls the recipe and the images back together when %s, and starts A", (_case, says) => {
  const b = installer(recipe("B", { exit: 1, says }));
  network(
    {
      releaseManifestUrl: "https://releases.example.test/stable.json",
      recipe: { url: recipeUrl, sha256: b.sha256 },
    },
    b.path,
  );
  const before = data();
  const result = update(newer);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(says);
  expect(result.stderr).toContain("The update was rolled back.");
  expect(onDisk()).toBe("# recipe A: compose.yaml\n");
  expect(readFileSync(join(home, "opensteer-home"), "utf8")).toContain('"A"');
  expect(readFileSync(join(home, "images.env"), "utf8")).toBe(selection("1.2.3", "a"));
  // A started again; no unit was written from B.
  expect(said()).toContain("start_pod from the updater (the previous recipe)");
  expect(said()).not.toContain("units from recipe B");
  expect(data()).toBe(before);
});

it("never takes a managed Home's recipe from a manifest, and says when its account names none", () => {
  const b = installer(recipe("B"));
  network({ releaseManifestUrl: "https://releases.example.test/stable.json" }, b.path);
  const result = update({ ...newer, recipe: { url: recipeUrl, sha256: b.sha256 } });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("The Opensteer account named no recipe for this release");
  expect(onDisk()).toBe("# recipe A: compose.yaml\n");
  expect(readFileSync(join(home, "images.env"), "utf8")).toBe(selection("1.2.4", "b"));
});

it("updates a self-hosted Home's recipe from the manifest its owner gives, or says it did not", () => {
  rmSync(join(home, "managed"));
  const b = installer(recipe("B"));
  network(null, b.path);
  const manifest = join(work, "owner.json");
  writeFileSync(
    manifest,
    JSON.stringify({ ...newer, recipe: { url: recipeUrl, sha256: b.sha256 } }),
  );
  const result = update(newer, "update", manifest);
  expect(result.status, result.stderr).toBe(0);
  expect(onDisk()).toBe("# recipe B: compose.yaml\n");
  // A release without a recipe: images only, and the command says so.
  writeFileSync(manifest, JSON.stringify({ version: "1.2.5", images: images("c") }));
  const imagesOnly = update(newer, "update", manifest);
  expect(imagesOnly.status, imagesOnly.stderr).toBe(0);
  expect(imagesOnly.stdout).toContain("the recipe was not updated");
  expect(onDisk()).toBe("# recipe B: compose.yaml\n");
});

/** A journal as an update leaves it when interrupted after `step`. */
function interrupted(step: "recipe-swapped" | "committed") {
  const journal = join(home, "update.pending");
  mkdirSync(join(journal, "recipe.previous"), { recursive: true });
  for (const [file, content] of Object.entries(recipe("A")))
    writeFileSync(join(journal, "recipe.previous", file), content);
  writeFileSync(join(journal, "candidate.env"), selection("1.2.4", "b"));
  writeFileSync(join(journal, "previous.env"), selection("1.2.3", "a"));
  writeFileSync(join(journal, "original.env"), selection("1.2.3", "a"));
  // Recipe B half in place: some files swapped, others not.
  const b = recipe("B");
  for (const file of recipeFiles.slice(0, Math.ceil(recipeFiles.length / 2)))
    writeFileSync(join(home, file), b[file]!);
  if (step === "committed") {
    for (const [file, content] of Object.entries(b)) writeFileSync(join(home, file), content);
    writeFileSync(join(home, "images.env"), selection("1.2.4", "b"));
    writeFileSync(join(journal, "committed"), "");
  }
}

/** The next start: the units' restore step (from the committed recipe), then the recovery. */
function nextStart() {
  // The real install-scheduler.sh writes the restore step and the units (systemctl stood in).
  writeFileSync(join(work, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(work, "systemctl"), 0o755);
  const env = {
    ...process.env,
    OPENSTEER_HOME_DIR: home,
    OPENSTEER_HOME_UNIT_DIR: join(work, "units"),
    PATH: `${work}:${process.env.PATH}`,
  };
  const scheduler = spawnSync("bash", [join(source, "install-scheduler.sh"), home, "recipe-test"], {
    encoding: "utf8",
    env,
  });
  expect(scheduler.status, scheduler.stderr).toBe(0);
  // flock is util-linux; here a stand-in that runs the command it guards.
  writeFileSync(join(work, "flock"), '#!/usr/bin/env bash\nshift; exec "$@"\n');
  chmodSync(join(work, "flock"), 0o755);
  const restore = readFileSync(join(home, "restore-recipe.sh"), "utf8").replace(
    "exec /usr/bin/flock",
    `exec ${join(work, "flock")}`,
  );
  const restored = spawnSync("sh", ["-c", restore, "restore", home], { encoding: "utf8", env });
  expect(restored.status, restored.stderr).toBe(0);
  return spawnSync(
    "bash",
    [
      "-c",
      `source "$1"; source "$2"
       install_sandbox_policies() { :; }
       compose() { printf 'compose %s\\n' "$*" >> "${log}"; }
       start_pod() { printf 'start_pod at the next start\\n' >> "${log}"; }
       update_recovery`,
      "recover",
      join(source, "common.sh"),
      join(source, "update.sh"),
    ],
    { encoding: "utf8", env },
  );
}

it("puts the previous recipe and images back at the next start when an update stopped before its commit", () => {
  interrupted("recipe-swapped");
  const recovered = nextStart();
  expect(recovered.status, recovered.stderr).toBe(0);
  for (const file of recipeFiles)
    expect(readFileSync(join(home, file), "utf8"), file).toBe(recipe("A")[file]);
  expect(readFileSync(join(home, "images.env"), "utf8")).toBe(selection("1.2.3", "a"));
  expect(said()).toContain("start_pod at the next start");
  expect(existsSync(join(home, "update.pending"))).toBe(false);
});

it("completes an update that committed before it stopped: B stays, its units are written", () => {
  interrupted("committed");
  const recovered = nextStart();
  expect(recovered.status, recovered.stderr).toBe(0);
  expect(onDisk()).toBe("# recipe B: compose.yaml\n");
  expect(readFileSync(join(home, "images.env"), "utf8")).toBe(selection("1.2.4", "b"));
  expect(said()).toContain("units from recipe B");
  expect(existsSync(join(home, "update.pending"))).toBe(false);
});

it("runs every unit's restore step before the Home's own code, and the step changes only with the units", () => {
  writeFileSync(join(work, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(work, "systemctl"), 0o755);
  const scheduler = spawnSync("bash", [join(source, "install-scheduler.sh"), home, "recipe-test"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENSTEER_HOME_UNIT_DIR: join(work, "units"),
      PATH: `${work}:${process.env.PATH}`,
    },
  });
  expect(scheduler.status, scheduler.stderr).toBe(0);
  for (const unit of readdirSync(join(work, "units")).filter((file) => file.endsWith(".service"))) {
    const text = readFileSync(join(work, "units", unit), "utf8");
    expect(text, unit).toMatch(
      new RegExp(`ExecStartPre=${home}/restore-recipe\\.sh ${home}\\nExecStart=`, "u"),
    );
  }
  // It takes the Home's lock, and is not one of the recipe's files an update swaps.
  expect(readFileSync(join(home, "restore-recipe.sh"), "utf8")).toContain("/usr/bin/flock");
  expect(recipeFiles).not.toContain("restore-recipe.sh");
});

it("keeps machine-status.sh where opensteer-home reads it on an installed Home", () => {
  const installedHome = mkdtempSync(join(work, "installed-"));
  const result = spawnSync(
    "bash",
    [
      "-c",
      `source "$1"; install_recipe "$2" "$3"
       # As opensteer-home loads it: only when the file is where it looks.
       home_dir=$3
       if [[ -f "$home_dir/machine-status.sh" ]]; then source "$home_dir/machine-status.sh"; fi
       declare -F publish_machine_status`,
      "installed",
      join(source, "common.sh"),
      source,
      installedHome,
    ],
    { encoding: "utf8", env: { ...process.env, OPENSTEER_HOME_DIR: installedHome } },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("publish_machine_status");
});
