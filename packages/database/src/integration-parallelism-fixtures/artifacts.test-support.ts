import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { expect, it } from "vitest";

// Capture before test hooks, like the real browser fixtures do.
const artifacts = Object.fromEntries(
  [
    "OPENSTEER_SHARED_BROWSER_E2E_ARTIFACT_DIR",
    "OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR",
    "OPENSTEER_PROPOSAL_CREDENTIAL_ARTIFACT_DIR",
    "OPENSTEER_BROWSER_SOURCE_E2E_ARTIFACT_DIR",
    "OPENSTEER_STATE_IMPORT_E2E_ARTIFACT_DIR",
    "OPENSTEER_PASSKEY_POLICY_E2E_ARTIFACT_DIR",
    "OPENSTEER_CDP_BOUNDARY_E2E_ARTIFACT_DIR",
  ].map((key) => [key, process.env[key]]),
);
const directory = process.env.OPENSTEER_PARALLELISM_FIXTURE_DIR!;
const coordination = process.env.OPENSTEER_PARALLELISM_ARTIFACT_COORDINATION!;
const side = process.env.OPENSTEER_PARALLELISM_FIXTURE_SCENARIO!.slice("artifacts-".length);

export function artifactJourney(label: string): void {
  it("keeps default and overridden artifacts after another run deletes its own evidence", async () => {
    const paths: Record<string, string> = {};
    for (const [key, value] of Object.entries(artifacts)) {
      expect(value, `${key} must be scoped before importing a fixture`).toBeTruthy();
      const path = value!;
      expect(relative(process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY!, path)).not.toMatch(
        /^\.\./u,
      );
      paths[key] = join(path, "report.json");
    }
    const overrideDirectory = process.env.OPENSTEER_PARALLELISM_OVERRIDE_ARTIFACT_DIR!;
    const overridePath = process.env.OPENSTEER_PARALLELISM_OVERRIDE_ARTIFACT_PATH!;
    expect(relative(join(coordination, "directories"), overrideDirectory)).not.toMatch(/^\.\./u);
    expect(relative(join(coordination, "files"), overridePath)).not.toMatch(/^\.\./u);
    paths.directoryOverride = join(overrideDirectory, "report.json");
    paths.fileOverride = overridePath;
    const marker = `${side}-${label}`;
    for (const path of Object.values(paths)) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, marker);
    }
    await writeFile(join(directory, `${label}-artifacts.json`), JSON.stringify(paths, null, 2));
    await writeFile(join(coordination, `${marker}.ready`), "ready");
    async function waitFor(name: string) {
      await expect
        .poll(() => readFile(join(coordination, name), "utf8").catch(() => ""), {
          timeout: 10_000,
        })
        .toBe("ready");
    }
    await Promise.all(
      ["left-a", "left-b", "right-a", "right-b"].map((name) => waitFor(`${name}.ready`)),
    );
    if (side === "left") {
      for (const path of Object.values(paths)) {
        await rm(dirname(path), { recursive: true, force: true });
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, marker);
      }
      await writeFile(join(coordination, `${marker}.deleted`), "ready");
    }
    await Promise.all(["left-a", "left-b"].map((name) => waitFor(`${name}.deleted`)));
    for (const path of Object.values(paths)) expect(await readFile(path, "utf8")).toBe(marker);
  });
}
