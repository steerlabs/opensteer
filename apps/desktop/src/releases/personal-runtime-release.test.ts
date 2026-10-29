import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  harnessCatalog,
  shippedHarnessKindRecord,
  shipsHarnessRuntimeBytes,
  type ShippedHarnessKind,
} from "@opensteer/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  PersonalRuntimeReleaseError,
  PersonalRuntimeReleaseManifestSchema,
  readPersonalRuntimeRelease,
} from "./personal-runtime-release.js";

const shippedHarnesses = harnessCatalog.filter(shipsHarnessRuntimeBytes);

function shippedHarness(kind: ShippedHarnessKind) {
  const entry = shippedHarnesses.find((candidate) => candidate.kind === kind);
  if (!entry) throw new Error(`No harness catalog entry for ${kind}`);
  return entry;
}

const harnessArtifacts = shippedHarnessKindRecord((kind) => shippedHarness(kind).runtime.path);

/** A Node program is code the bundled interpreter reads, not machine code. */
const harnessArtifactModes = shippedHarnessKindRecord((kind) =>
  shippedHarness(kind).runtime.shape === "script" ? ("code" as const) : ("executable" as const),
);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Personal runtime release", () => {
  it("accepts only the complete pinned platform release", async () => {
    const directory = await releaseDirectory();
    const release = await readPersonalRuntimeRelease(directory, {
      architecture: "arm64",
      operatingSystem: "linux",
    });
    expect(release.identity).toMatchObject({
      architecture: "arm64",
      hostVersion: "1.2.3",
      operatingSystem: "linux",
      postgresMajor: 17,
      postgresVersion: "17.4.0",
      runnerVersion: "2.3.4",
    });
    expect(release.entrypoints.browserHarness).toBe(path.join(directory, "bin", "browser-harness"));
    expect(release.entrypoints.host).toBe(path.join(directory, "bin", "host"));
    expect(release.entrypoints.node).toBe(path.join(directory, "bin", "node"));
    expect(release.assets.agentSkills).toBe(path.join(directory, "agent-skills"));
    for (const entry of shippedHarnesses) {
      expect(release.harnesses[entry.kind]).toBe(
        path.join(directory, ...entry.runtime.path.split("/")),
      );
    }
    expect(release.identity.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects the wrong architecture and a changed artifact", async () => {
    const directory = await releaseDirectory();
    await expect(
      readPersonalRuntimeRelease(directory, {
        architecture: "amd64",
        operatingSystem: "linux",
      }),
    ).rejects.toThrow(/targets linux\/arm64/u);
    await chmod(path.join(directory, "bin", "host"), 0o755);
    await writeFile(path.join(directory, "bin", "host"), "tampered", { mode: 0o555 });
    await chmod(path.join(directory, "bin", "host"), 0o555);
    await expect(
      readPersonalRuntimeRelease(directory, {
        architecture: "arm64",
        operatingSystem: "linux",
      }),
    ).rejects.toThrow(/failed release verification/u);
  });

  it("rejects symlinked artifacts even when their bytes match", async () => {
    const directory = await releaseDirectory();
    const host = path.join(directory, "bin", "host");
    const outside = path.join(directory, "outside-host");
    await writeFile(outside, await readFile(host), { mode: 0o555 });
    await rm(host);
    await symlink(outside, host);
    await expect(
      readPersonalRuntimeRelease(directory, {
        architecture: "arm64",
        operatingSystem: "linux",
      }),
    ).rejects.toThrow(/symbolic link|real regular file/u);
  });

  it("checks executable architecture instead of trusting the manifest label", async () => {
    const directory = await releaseDirectory("amd64");
    await expect(
      readPersonalRuntimeRelease(directory, {
        architecture: "arm64",
        operatingSystem: "linux",
      }),
    ).rejects.toThrow(/does not contain arm64 code/u);
  });

  it("rejects undeclared release files", async () => {
    const directory = await releaseDirectory();
    await writeFile(path.join(directory, "bin", "unreviewed.dylib"), "unexpected");
    await expect(
      readPersonalRuntimeRelease(directory, {
        architecture: "arm64",
        operatingSystem: "linux",
      }),
    ).rejects.toThrow(/undeclared or missing/u);
  });

  it("names each refusal of the release as shipped: missing, incompatible or tampered", async () => {
    // Failure mode: the supervisor guesses from words in the sentence, so a
    // FIFO ("unsupported file type") reads as an incompatible release that
    // needs an update.
    const read = (directory: string, architecture = "arm64") =>
      readPersonalRuntimeRelease(directory, { architecture, operatingSystem: "linux" }).catch(
        (error: unknown) => error,
      );
    expect(await read(await releaseDirectory(), "amd64")).toMatchObject({ kind: "incompatible" });
    const missing = await releaseDirectory();
    await rm(path.join(missing, "web", "index.html"));
    expect(await read(missing)).toMatchObject({ kind: "missing" });
    const undeclared = await releaseDirectory();
    await writeFile(path.join(undeclared, "bin", "unreviewed.dylib"), "unexpected");
    expect(await read(undeclared)).toMatchObject({ kind: "tampered" });
    const changed = await releaseDirectory();
    await chmod(path.join(changed, "web", "index.html"), 0o644);
    await writeFile(
      path.join(changed, "web", "index.html"),
      "<!doctype html><title>Changed</title>\n",
    );
    expect(await read(changed)).toMatchObject({ kind: "tampered" });
    const pipe = await releaseDirectory();
    execFileSync("mkfifo", [path.join(pipe, "bin", "pipe")]);
    expect(await read(pipe)).toMatchObject({ kind: "tampered" });
  });

  it("lets a file-system failure through as itself, never as a missing release", async () => {
    // Failure mode: any failure to look a path up (too many open files, a
    // failing disk, no permission) is reported as the release missing, which
    // stops recovery for good and asks for a reinstall.
    const parent = await mkdtemp(path.join(tmpdir(), "opensteer-personal-release-parent-"));
    temporaryDirectories.push(parent);
    const directory = path.join(parent, "personal-runtime");
    await rename(await releaseDirectory(), directory);
    const read = () =>
      readPersonalRuntimeRelease(directory, {
        architecture: "arm64",
        operatingSystem: "linux",
      }).catch((error: unknown) => error);
    await chmod(parent, 0o600);
    try {
      const failure = await read();
      expect(failure).toMatchObject({ code: "EACCES", syscall: "lstat" });
      expect(failure).not.toBeInstanceOf(PersonalRuntimeReleaseError);
    } finally {
      await chmod(parent, 0o700);
    }
    const web = path.join(directory, "web");
    await chmod(web, 0o400);
    try {
      const failure = await read();
      expect(failure).toMatchObject({ code: "EACCES", syscall: "lstat" });
      expect(failure).not.toBeInstanceOf(PersonalRuntimeReleaseError);
    } finally {
      await chmod(web, 0o755);
    }
    await expect(read()).resolves.toMatchObject({ directory });
  });

  it("names exactly the engines the harness catalog declares", () => {
    const manifest = {
      architecture: "arm64",
      assets: {
        agentSkills: "agent-skills",
        webDistribution: {
          directory: "web",
          hostVersion: "1.2.3",
          manifest: "web/opensteer-web.json",
        },
      },
      entrypoints: {
        browserHarness: "bin/browser-harness",
        channelRuntime: "bin/channel-runtime",
        host: "bin/host",
        initdb: "bin/initdb",
        nativeFsHelper: "bin/native-fs",
        node: "bin/node",
        pgIsReady: "bin/pg-isready",
        postgres: "bin/postgres",
        runner: "bin/runner",
      },
      files: [],
      harnesses: harnessArtifacts,
      hostVersion: "1.2.3",
      operatingSystem: "linux",
      postgresMajor: 17,
      postgresVersion: "17.4.0",
      runnerVersion: "2.3.4",
      schemaVersion: 7,
    };
    const firstKind = shippedHarnesses[0];
    if (!firstKind) throw new Error("The catalog ships no harness runtimes");
    const { [firstKind.kind]: _omitted, ...missingOne } = harnessArtifacts;

    // An engine the person installs ships no bytes, so naming one here is a
    // manifest claiming to carry a runtime it does not have.
    expect(
      PersonalRuntimeReleaseManifestSchema.safeParse({
        ...manifest,
        harnesses: { ...harnessArtifacts, cursor: "bin/agent" },
      }).success,
    ).toBe(false);
    expect(
      PersonalRuntimeReleaseManifestSchema.safeParse({ ...manifest, harnesses: missingOne })
        .success,
    ).toBe(false);
  });
});

async function releaseDirectory(
  executableArchitecture: "amd64" | "arm64" = "arm64",
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-personal-release-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "bin"), { recursive: true });
  const harnesses = harnessArtifacts;
  for (const relative of Object.values(harnesses)) {
    await mkdir(path.dirname(path.join(directory, ...relative.split("/"))), { recursive: true });
  }
  await mkdir(path.join(directory, "agent-skills", "skills", "opensteer-test"), {
    recursive: true,
  });
  await mkdir(path.join(directory, "web"), { recursive: true });
  const entries = {
    browserHarness: "bin/browser-harness",
    channelRuntime: "bin/channel-runtime",
    host: "bin/host",
    initdb: "bin/initdb",
    nativeFsHelper: "bin/native-fs",
    node: "bin/node",
    pgIsReady: "bin/pg-isready",
    postgres: "bin/postgres",
    runner: "bin/runner",
  } as const;
  const files: Array<{
    mode: "code" | "data" | "executable";
    path: string;
    sha256: string;
  }> = await Promise.all(
    [
      ...Object.entries(entries).map(([name, relative]) => ({
        mode: "executable" as const,
        name,
        relative,
      })),
      ...Object.entries(harnesses).map(([kind, relative]) => ({
        mode: harnessArtifactModes[kind as ShippedHarnessKind],
        name: kind,
        relative,
      })),
    ].map(async ({ mode, name, relative }) => {
      const content = fakeElf(executableArchitecture, name);
      const target = path.join(directory, ...relative.split("/"));
      await writeFile(target, content, { mode: 0o555 });
      await chmod(target, mode === "executable" ? 0o555 : 0o444);
      return {
        mode,
        path: relative,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    }),
  );
  for (const [relative, content] of [
    ["agent-skills/plugin.json", '{"name":"opensteer-test"}\n'],
    ["agent-skills/skills/opensteer-test/SKILL.md", "# Opensteer test\n"],
  ] as const) {
    await writeFile(path.join(directory, ...relative.split("/")), content, { mode: 0o444 });
    files.push({
      mode: "data" as const,
      path: relative,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  const webIndex = "<!doctype html><title>Opensteer</title>\n";
  await writeFile(path.join(directory, "web", "index.html"), webIndex, { mode: 0o444 });
  files.push({
    mode: "data",
    path: "web/index.html",
    sha256: createHash("sha256").update(webIndex).digest("hex"),
  });
  const webManifest = `${JSON.stringify({
    files: [
      {
        path: "index.html",
        sha256: createHash("sha256").update(webIndex).digest("hex"),
      },
    ],
    hostVersion: "1.2.3",
    schemaVersion: 1,
  })}\n`;
  await writeFile(path.join(directory, "web", "opensteer-web.json"), webManifest, {
    mode: 0o444,
  });
  files.push({
    mode: "data",
    path: "web/opensteer-web.json",
    sha256: createHash("sha256").update(webManifest).digest("hex"),
  });
  const manifest = PersonalRuntimeReleaseManifestSchema.parse({
    architecture: "arm64",
    assets: {
      agentSkills: "agent-skills",
      webDistribution: {
        directory: "web",
        hostVersion: "1.2.3",
        manifest: "web/opensteer-web.json",
      },
    },
    entrypoints: entries,
    files,
    harnesses,
    hostVersion: "1.2.3",
    operatingSystem: "linux",
    postgresMajor: 17,
    postgresVersion: "17.4.0",
    runnerVersion: "2.3.4",
    schemaVersion: 7,
  });
  await writeFile(path.join(directory, "release.json"), `${JSON.stringify(manifest)}\n`, {
    mode: 0o444,
  });
  return directory;
}

function fakeElf(architecture: "amd64" | "arm64", marker: string): Buffer {
  const content = Buffer.alloc(64 + Buffer.byteLength(marker));
  content.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  content.writeUInt16LE(architecture === "amd64" ? 62 : 183, 18);
  content.write(marker, 64, "utf8");
  return content;
}
