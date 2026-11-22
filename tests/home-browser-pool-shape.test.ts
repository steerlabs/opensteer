// A Cloud Computer is pooled only by its boot answer's own flag (phase B, piece 2): the installer
// marks it, the marker adds one override, and the default recipe is the self-hosted one.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  expect(parse(read("compose.browser-pool.yaml"))).toEqual({
    services: { host: { environment: { OPENSTEER_MANAGED_HOME_BROWSER_POOL: "true" } } },
  });
  for (const installer of ["install.sh", "package-installer.sh"])
    expect(read(installer)).toContain("compose.browser-pool.yaml");
});
