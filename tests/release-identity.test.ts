import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { requireCanonicalReleaseIdentity } = require("../scripts/release-identity.cjs") as {
  readonly requireCanonicalReleaseIdentity: (
    repositoryRoot: string,
    environment?: NodeJS.ProcessEnv,
    options?: { readonly verifyRepository?: boolean },
  ) => { readonly sourceRevision: string; readonly version: string };
};
const { desktopReleaseMetadata, verifyPackagedDesktopRelease } =
  require("../apps/desktop/scripts/desktop-release-metadata.cjs") as {
    readonly desktopReleaseMetadata: (
      repositoryRoot: string,
      environment?: NodeJS.ProcessEnv,
      options?: { readonly verifyRepository?: boolean },
    ) => {
      readonly builderArguments: readonly string[];
      readonly identity: { readonly sourceRevision: string; readonly version: string };
    };
    readonly verifyPackagedDesktopRelease: (
      manifest: unknown,
      appInfo: unknown,
      identity: { readonly sourceRevision: string; readonly version: string },
    ) => void;
  };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("canonical release identity", () => {
  it("takes the version from the root manifest and an exact source revision", async () => {
    const repository = await fixtureRepository("1.2.3");
    expect(
      requireCanonicalReleaseIdentity(
        repository,
        { OPENSTEER_SOURCE_REVISION: "a".repeat(40) },
        { verifyRepository: false },
      ),
    ).toEqual({ sourceRevision: "a".repeat(40), version: "1.2.3" });
  });

  it.each([
    { revision: "a".repeat(40), version: "0.0.0" },
    { revision: "unknown", version: "1.2.3" },
    { revision: "0".repeat(40), version: "1.2.3" },
    { revision: ` ${"a".repeat(40)}`, version: "1.2.3" },
  ])("rejects a non-release identity: $version at $revision", async ({ revision, version }) => {
    const repository = await fixtureRepository(version);
    expect(() =>
      requireCanonicalReleaseIdentity(
        repository,
        { OPENSTEER_SOURCE_REVISION: revision },
        { verifyRepository: false },
      ),
    ).toThrow(/real stable release version|exact lowercase 40-hex/u);
  });

  it("rejects a caller version that disagrees with the root manifest", async () => {
    const repository = await fixtureRepository("1.2.3");
    expect(() =>
      requireCanonicalReleaseIdentity(
        repository,
        {
          OPENSTEER_RELEASE_VERSION: "1.2.4",
          OPENSTEER_SOURCE_REVISION: "a".repeat(40),
        },
        { verifyRepository: false },
      ),
    ).toThrow(/does not match canonical release/u);
  });

  it("requires the exact clean Git commit", async () => {
    const repository = await fixtureRepository("1.2.3");
    git(repository, "init");
    git(repository, "add", "package.json");
    commitFixture(repository);
    const revision = git(repository, "rev-parse", "HEAD");
    expect(
      requireCanonicalReleaseIdentity(repository, { OPENSTEER_SOURCE_REVISION: revision }),
    ).toEqual({ sourceRevision: revision, version: "1.2.3" });
    await writeFile(path.join(repository, "uncommitted.txt"), "dirty\n");
    expect(() =>
      requireCanonicalReleaseIdentity(repository, { OPENSTEER_SOURCE_REVISION: revision }),
    ).toThrow(/clean source checkout/u);
  });

  it("stamps deployed package metadata with the same tuple", async () => {
    const directory = await fixtureRepository("1.2.3");
    const manifestPath = path.join(directory, "deployed-package.json");
    await writeFile(manifestPath, `${JSON.stringify({ name: "fixture", version: "0.0.0" })}\n`);
    execFileSync(
      process.execPath,
      [path.resolve("scripts/stamp-release-package.cjs"), manifestPath],
      {
        env: {
          OPENSTEER_RELEASE_VERSION: "1.2.3",
          OPENSTEER_SOURCE_REVISION: "a".repeat(40),
        },
        stdio: "pipe",
      },
    );
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({
      name: "fixture",
      opensteerBuild: { sourceRevision: "a".repeat(40), version: "1.2.3" },
      version: "1.2.3",
    });
  });

  it("binds Desktop package and native bundle versions to the canonical tuple", async () => {
    const repository = await fixtureRepository("1.2.3");
    const sourceRevision = "a".repeat(40);
    const metadata = desktopReleaseMetadata(
      repository,
      { OPENSTEER_SOURCE_REVISION: sourceRevision },
      { verifyRepository: false },
    );
    expect(metadata).toEqual({
      builderArguments: [
        "-c.buildVersion=1.2.3",
        "-c.extraMetadata.version=1.2.3",
        "-c.extraMetadata.opensteerBuild.version=1.2.3",
        `-c.extraMetadata.opensteerBuild.sourceRevision=${sourceRevision}`,
      ],
      identity: { sourceRevision, version: "1.2.3" },
    });
    expect(() =>
      verifyPackagedDesktopRelease(
        { opensteerBuild: { sourceRevision, version: "1.2.3" }, version: "1.2.3" },
        { buildVersion: "1.2.3", version: "1.2.3" },
        metadata.identity,
      ),
    ).not.toThrow();
    expect(() =>
      verifyPackagedDesktopRelease(
        { opensteerBuild: { sourceRevision, version: "1.2.3" }, version: "0.0.0" },
        { buildVersion: "1.2.3", version: "1.2.3" },
        metadata.identity,
      ),
    ).toThrow(/canonical source/u);
    expect(() =>
      verifyPackagedDesktopRelease(
        { opensteerBuild: { sourceRevision, version: "1.2.3" }, version: "1.2.3" },
        { buildVersion: "0.0.0", version: "1.2.3" },
        metadata.identity,
      ),
    ).toThrow(/canonical source/u);
  });
});

async function fixtureRepository(version: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-release-identity-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({ version })}\n`);
  return directory;
}

function commitFixture(repository: string): void {
  git(
    repository,
    "-c",
    "user.name=Opensteer Test",
    "-c",
    "user.email=test@opensteer.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "test fixture",
  );
}

function git(repository: string, ...arguments_: string[]): string {
  return execFileSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
