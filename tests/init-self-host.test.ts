import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  initializeSelfHost,
  initializeSelfHostSecrets,
  selfHostWorkspaceBacking,
  selfHostInitializationSummary,
} from "../scripts/init-self-host.js";

describe("self-host secret initialization", () => {
  it("reports the selected storage backing without advertising PortableFS in local mode", () => {
    expect(selfHostWorkspaceBacking({})).toBe("local-directory");
    expect(
      selfHostInitializationSummary(
        { created: [], directory: "/tmp/opensteer-secrets" },
        "local-directory",
      ),
    ).toEqual({
      created: [],
      directory: "/tmp/opensteer-secrets",
      note: "Configure model credentials on the Runner.",
      backing: "local-directory",
    });
    expect(
      selfHostInitializationSummary(
        { created: [], directory: "/tmp/opensteer-secrets" },
        "portablefs",
      ).note,
    ).toMatch(/PortableFS/);
    expect(() =>
      selfHostWorkspaceBacking({ OPENSTEER_DEFAULT_WORKSPACE_BACKING: "invalid" }),
    ).toThrow(/requires OPENSTEER_DEFAULT_WORKSPACE_BACKING/);
  });

  it("creates internal secrets once behind an owner-only directory", async () => {
    const directory = join(tmpdir(), `opensteer-self-host-${randomUUID()}`);
    await mkdir(directory, { mode: 0o755 });

    const first = await initializeSelfHostSecrets(directory);
    expect(first.created).toEqual([
      "browser_bridge_token",
      "browser_runner_enrollment_token",
      "credential_key",
      "database_url",
      "initial_owner_enrollment_token",
      "messaging_runner_enrollment_token",
      "opensteer_auth_secret",
      "postgres_password",
    ]);
    const token = await readFile(join(directory, "opensteer_auth_secret"), "utf8");
    const postgresPassword = await readFile(join(directory, "postgres_password"), "utf8");
    expect(token.trim()).toHaveLength(64);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const name of first.created) {
        expect((await stat(join(directory, name))).mode & 0o777).toBe(0o644);
      }

      // Exact file-backed Compose secret mounts preserve native Linux mode and
      // ownership. Re-running initialization repairs a restrictive umask or a
      // legacy 0600 file without rotating its value.
      await chmod(join(directory, "opensteer_auth_secret"), 0o600);
      await chmod(join(directory, "postgres_password"), 0o600);
      await chmod(directory, 0o755);
    }

    const second = await initializeSelfHostSecrets(directory);
    expect(second.created).toEqual([]);
    expect(await readFile(join(directory, "opensteer_auth_secret"), "utf8")).toBe(token);
    expect(await readFile(join(directory, "postgres_password"), "utf8")).toBe(postgresPassword);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "opensteer_auth_secret"))).mode & 0o777).toBe(0o644);
      expect((await stat(join(directory, "postgres_password"))).mode & 0o777).toBe(0o644);
    }
  });

  it("keeps the PostgreSQL password and DSN consistent across concurrent first runs", async () => {
    const directory = join(tmpdir(), `opensteer-self-host-race-${randomUUID()}`);
    const results = await Promise.all(
      Array.from({ length: 24 }, () => initializeSelfHostSecrets(directory)),
    );
    const password = (await readFile(join(directory, "postgres_password"), "utf8")).trim();
    const databaseUrl = (await readFile(join(directory, "database_url"), "utf8")).trim();

    expect(databaseUrl).toBe(
      `postgres://opensteer:${encodeURIComponent(password)}@postgres:5432/opensteer`,
    );
    expect(new Set(results.flatMap((result) => result.created))).toEqual(
      new Set([
        "browser_bridge_token",
        "browser_runner_enrollment_token",
        "messaging_runner_enrollment_token",
        "credential_key",
        "database_url",
        "initial_owner_enrollment_token",
        "opensteer_auth_secret",
        "postgres_password",
      ]),
    );
    expect((await readdir(directory)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("materializes exactly the file-backed secrets declared by the self-host stack", async () => {
    const directory = join(tmpdir(), `opensteer-self-host-contract-${randomUUID()}`);
    const result = await initializeSelfHostSecrets(directory);
    const declared = new Set<string>();
    for (const file of ["compose.yaml", "compose.initial-owner.yaml"]) {
      const source = await readFile(resolve("deploy/self-host", file), "utf8");
      const document: unknown = parse(source, { logLevel: "silent" });
      if (typeof document !== "object" || document === null || !("secrets" in document)) {
        throw new Error(`${file} does not declare a Compose secrets map`);
      }
      const secrets = document.secrets;
      if (typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) {
        throw new Error(`${file} declares an invalid Compose secrets map`);
      }
      for (const name of Object.keys(secrets)) declared.add(name);
    }

    expect(new Set(result.created)).toEqual(declared);
  });

  it("writes canonical source-build identity into a fresh Compose config", async () => {
    const directory = join(tmpdir(), `opensteer-self-host-config-${randomUUID()}`);
    const repository = join(directory, "repository");
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, "package.json"), '{"version":"1.2.3"}\n');
    execFileSync("git", ["init"], { cwd: repository, stdio: "pipe" });
    execFileSync("git", ["add", "package.json"], { cwd: repository, stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Opensteer Test",
        "-c",
        "user.email=test@opensteer.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "test fixture",
      ],
      { cwd: repository, stdio: "pipe" },
    );
    const configPath = join(directory, "config.env");
    const result = await initializeSelfHost({
      configPath,
      configTemplatePath: resolve("deploy/self-host/config.env.example"),
      repositoryRoot: repository,
      secretsDirectory: join(directory, "secrets"),
    });
    const config = Object.fromEntries(
      (await readFile(configPath, "utf8"))
        .split("\n")
        .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    expect(config).toMatchObject({
      OPENSTEER_RELEASE_VERSION: "1.2.3",
      OPENSTEER_SOURCE_REVISION: result.sourceRevision,
    });
    expect(result.sourceRevision).toMatch(/^[a-f0-9]{40}$/u);

    for (const file of [
      "compose.yaml",
      "compose.runner-linux.yaml",
      "compose.runner-portablefs-linux.yaml",
    ]) {
      const document: unknown = parse(await readFile(resolve("deploy/self-host", file), "utf8"), {
        logLevel: "silent",
      });
      if (typeof document !== "object" || document === null || !("services" in document)) {
        throw new Error(`${file} does not declare Compose services`);
      }
      const services = document.services;
      if (typeof services !== "object" || services === null || Array.isArray(services)) {
        throw new Error(`${file} declares invalid Compose services`);
      }
      for (const [name, service] of Object.entries(services)) {
        if (typeof service !== "object" || service === null || !("build" in service)) continue;
        const build = service.build;
        if (
          typeof build !== "object" ||
          build === null ||
          !("dockerfile" in build) ||
          build.dockerfile !== "deploy/container/Containerfile"
        ) {
          continue;
        }
        if (!("args" in build) || typeof build.args !== "object" || build.args === null) {
          throw new Error(`${file} service ${name} has no build arguments`);
        }
        expect(build.args).toMatchObject({
          OPENSTEER_RELEASE_VERSION: "${OPENSTEER_RELEASE_VERSION:?set OPENSTEER_RELEASE_VERSION}",
          OPENSTEER_SOURCE_REVISION: "${OPENSTEER_SOURCE_REVISION:?set OPENSTEER_SOURCE_REVISION}",
        });
      }
    }
  });

  it("waits for an atomic publication link to settle before reading it", async () => {
    const directory = join(tmpdir(), `opensteer-self-host-publish-${randomUUID()}`);
    const staging = join(directory, ".postgres_password.tmp-existing-publisher");
    const passwordPath = join(directory, "postgres_password");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(staging, "stable-password\n", { mode: 0o644 });
    await link(staging, passwordPath);
    const release = delay(50).then(() => unlink(staging));

    await initializeSelfHostSecrets(directory);
    await release;
    expect((await readFile(join(directory, "database_url"), "utf8")).trim()).toBe(
      "postgres://opensteer:stable-password@postgres:5432/opensteer",
    );
  });

  it("rejects a persisted password whose exact value has surrounding whitespace", async () => {
    const directory = join(tmpdir(), `opensteer-self-host-whitespace-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "postgres_password"), " leading-space\n", { mode: 0o644 });
    await expect(initializeSelfHostSecrets(directory)).rejects.toThrow(/surrounding whitespace/);
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlinked, hard-linked, and non-regular secret paths",
    async () => {
      const outside = join(tmpdir(), `opensteer-self-host-outside-${randomUUID()}`);
      await writeFile(outside, "must-not-change\n", { mode: 0o600 });

      const symlinkDirectory = join(tmpdir(), `opensteer-self-host-symlink-${randomUUID()}`);
      await mkdir(symlinkDirectory, { mode: 0o700 });
      await symlink(outside, join(symlinkDirectory, "postgres_password"));
      await expect(initializeSelfHostSecrets(symlinkDirectory)).rejects.toThrow();
      expect(await readFile(outside, "utf8")).toBe("must-not-change\n");
      expect((await stat(outside)).mode & 0o777).toBe(0o600);

      const hardLinkDirectory = join(tmpdir(), `opensteer-self-host-hardlink-${randomUUID()}`);
      await mkdir(hardLinkDirectory, { mode: 0o700 });
      await link(outside, join(hardLinkDirectory, "postgres_password"));
      await expect(initializeSelfHostSecrets(hardLinkDirectory)).rejects.toThrow(
        /exactly one filesystem link/,
      );

      const nonRegularDirectory = join(tmpdir(), `opensteer-self-host-nonregular-${randomUUID()}`);
      await mkdir(join(nonRegularDirectory, "postgres_password"), {
        mode: 0o700,
        recursive: true,
      });
      await expect(initializeSelfHostSecrets(nonRegularDirectory)).rejects.toThrow(
        /not a regular secret file/,
      );
    },
  );

  it.skipIf(process.platform === "win32")("rejects a symlinked secret directory", async () => {
    const actual = join(tmpdir(), `opensteer-self-host-actual-${randomUUID()}`);
    const linked = join(tmpdir(), `opensteer-self-host-linked-${randomUUID()}`);
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, linked);
    await expect(initializeSelfHostSecrets(linked)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without blocking the initializer",
    async () => {
      const directory = join(tmpdir(), `opensteer-self-host-fifo-${randomUUID()}`);
      const fifo = join(directory, "postgres_password");
      await mkdir(directory, { mode: 0o700 });
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
      expect(created.status, created.stderr).toBe(0);

      const result = await runInitializerCli(directory, 2_000);
      expect(result.timedOut).toBe(false);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("not a regular secret file");
    },
  );
});

function runInitializerCli(
  directory: string,
  timeoutMilliseconds: number,
): Promise<{ readonly code: number | null; readonly stderr: string; readonly timedOut: boolean }> {
  return new Promise((resolveResult) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve(process.cwd(), "scripts/init-self-host.ts"),
        "--secrets-dir",
        directory,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let timedOut = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMilliseconds);
    child.once("close", (code) => {
      globalThis.clearTimeout(timer);
      resolveResult({ code, stderr, timedOut });
    });
  });
}
