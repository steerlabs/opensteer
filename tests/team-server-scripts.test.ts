import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const secretsScript = resolve("deploy/team/secrets.sh");

function secrets(mode: "init" | "renew", directory: string) {
  return spawnSync("bash", [secretsScript, mode, directory], { encoding: "utf8", timeout: 10_000 });
}

function freshDirectory(label: string): string {
  return join(tmpdir(), `opensteer-team-${label}-${randomUUID()}`);
}

describe.skipIf(process.platform === "win32")("team secrets", () => {
  it("creates file-backed secrets once in an owner-only directory and repairs modes", async () => {
    const directory = freshDirectory("secrets");
    await mkdir(directory, { mode: 0o755 });
    expect(secrets("init", directory).status).toBe(0);
    expect((await readdir(directory)).sort()).toEqual([
      "auth_secret",
      "database_url",
      "initial_owner_enrollment_token",
      "postgres_password",
    ]);
    const password = (await readFile(join(directory, "postgres_password"), "utf8")).trim();
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect((await readFile(join(directory, "auth_secret"), "utf8")).trim()).toHaveLength(64);
    expect(await readFile(join(directory, "database_url"), "utf8")).toBe(
      `postgres://opensteer:${password}@postgres:5432/opensteer\n`,
    );
    const before = await readFile(join(directory, "auth_secret"), "utf8");

    await chmod(join(directory, "auth_secret"), 0o600);
    await chmod(directory, 0o755);
    expect(secrets("init", directory).status).toBe(0);
    expect(await readFile(join(directory, "auth_secret"), "utf8")).toBe(before);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(directory)) {
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o644);
    }
  });

  it("renews only the setup token through a fresh file", async () => {
    const directory = freshDirectory("renew");
    expect(secrets("renew", directory).status).not.toBe(0);
    expect(secrets("init", directory).status).toBe(0);
    const names = await readdir(directory);
    const before = new Map(
      await Promise.all(
        names.map(async (name) => [name, await readFile(join(directory, name), "utf8")] as const),
      ),
    );
    const token = join(directory, "initial_owner_enrollment_token");
    const inode = (await stat(token)).ino;
    expect(secrets("renew", directory).status).toBe(0);
    for (const name of names) {
      const current = await readFile(join(directory, name), "utf8");
      if (name === "initial_owner_enrollment_token") expect(current).not.toBe(before.get(name));
      else expect(current).toBe(before.get(name));
    }
    expect((await stat(token)).ino).not.toBe(inode);
    expect((await readdir(directory)).sort()).toEqual([...names].sort());
  });

  it("keeps the database URL derived from the one persisted password across concurrent runs", async () => {
    const directory = freshDirectory("race");
    await Promise.all(
      Array.from(
        { length: 12 },
        () =>
          new Promise((done) =>
            spawn("bash", [secretsScript, "init", directory], { stdio: "ignore" }).once(
              "close",
              done,
            ),
          ),
      ),
    );
    expect(secrets("init", directory).status).toBe(0);
    const password = (await readFile(join(directory, "postgres_password"), "utf8")).trim();
    expect((await readFile(join(directory, "database_url"), "utf8")).trim()).toBe(
      `postgres://opensteer:${password}@postgres:5432/opensteer`,
    );
  });

  it("refuses unsafe or inconsistent secret paths without changing them", async () => {
    const outside = join(await mkdtemp(join(tmpdir(), "opensteer-team-outside-")), "target");
    await writeFile(outside, "mustnotchange\n", { mode: 0o600 });
    const cases: [string, (directory: string) => Promise<unknown>, RegExp][] = [
      ["symlink", (d) => symlink(outside, join(d, "postgres_password")), /regular secret file/u],
      ["hardlink", (d) => link(outside, join(d, "postgres_password")), /one filesystem link/u],
      ["directory", (d) => mkdir(join(d, "postgres_password")), /regular secret file/u],
      [
        "fifo",
        async (d) => execFileSync("mkfifo", [join(d, "postgres_password")]),
        /regular secret file/u,
      ],
      [
        "whitespace",
        (d) => writeFile(join(d, "postgres_password"), " leading\n"),
        /one generated secret/u,
      ],
      [
        "mismatch",
        async (d) => {
          await writeFile(join(d, "postgres_password"), "password\n");
          await writeFile(
            join(d, "database_url"),
            "postgres://opensteer:other@postgres:5432/opensteer\n",
          );
        },
        /does not match/u,
      ],
    ];
    for (const [label, arrange, message] of cases) {
      const directory = freshDirectory(label);
      await mkdir(directory, { mode: 0o700 });
      await arrange(directory);
      const result = secrets("init", directory);
      expect(result.error, label).toBeUndefined();
      expect(result.status, label).not.toBe(0);
      expect(result.stderr, label).toMatch(message);
    }
    expect(await readFile(outside, "utf8")).toBe("mustnotchange\n");
    expect((await stat(outside)).mode & 0o777).toBe(0o600);

    const actual = freshDirectory("actual");
    const linked = freshDirectory("linked");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, linked);
    expect(secrets("init", linked).status).not.toBe(0);
    expect(await readdir(actual)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("team updater", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "opensteer-team-update-"));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    const origin = join(root, "origin");
    await mkdir(join(origin, "deploy/team"), { recursive: true });
    for (const file of ["common.sh", "update.sh"]) {
      await copyFile(resolve("deploy/team", file), join(origin, "deploy/team", file));
    }
    git(origin, "init", "-q", "-b", "main");
    git(origin, "config", "user.name", "Team Test");
    git(origin, "config", "user.email", "team@opensteer.invalid");
    const release = async (tag: string) => {
      await writeFile(join(origin, "release"), tag);
      git(origin, "add", ".");
      git(origin, "commit", "-q", "-m", tag);
      git(origin, "tag", tag);
      return git(origin, "rev-parse", "HEAD");
    };
    await release("desktop-v1.0.4");
    const insider = await release("v1.0.5-insider");
    await release("v2.0.0-rc");
    const checkout = join(root, "checkout");
    git(root, "clone", "-q", origin, checkout);
    const team = join(checkout, "deploy/team");
    const configure = (channel: string) =>
      writeFile(join(team, "config.env"), `OPENSTEER_UPDATE_CHANNEL=${channel}\n`);
    await configure("beta");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      `#!/usr/bin/env bash
echo "$* version=$OPENSTEER_TEAM_VERSION" >> "${root}/calls"
[[ ! -f "${root}/fail-pull" || " $* " != *" pull "* ]]
`,
      { mode: 0o755 },
    );
    const update = () =>
      spawnSync("bash", [join(team, "update.sh")], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        timeout: 20_000,
      });
    const read = (path: string) => readFile(path, "utf8").catch(() => "");
    return {
      configure,
      git,
      insider,
      release,
      update,
      calls: () => read(join(root, "calls")),
      failPull: () => writeFile(join(root, "fail-pull"), ""),
      head: () => git(checkout, "rev-parse", "HEAD"),
      log: () => read(join(team, "update.log")),
      running: () => read(join(team, "state/running-version")),
    };
  }

  it("runs the newest channel release's images, then never repeats or downgrades", async () => {
    const f = await fixture();
    expect(f.update().status).toBe(0);
    expect(await f.calls()).toMatch(
      /compose .* pull --quiet version=1\.0\.5\n.*compose .* up -d --wait version=1\.0\.5\n$/u,
    );
    expect(await f.running()).toBe("1.0.5\n");
    expect(f.head()).toBe(f.insider);

    const calls = await f.calls();
    expect(f.update().status).toBe(0);
    await f.configure("stable");
    expect(f.update().status).toBe(0);
    expect(await f.calls()).toBe(calls);
    expect(await f.log()).toMatch(/keeping 1\.0\.5; desktop-v1\.0\.4 is older/u);
  });

  it("keeps the running version when the new release's images cannot be pulled", async () => {
    const f = await fixture();
    expect(f.update().status).toBe(0);
    await f.release("v1.0.6-insider");
    await f.failPull();
    expect(f.update().status).not.toBe(0);
    expect(await f.running()).toBe("1.0.5\n");
    expect(await f.calls()).not.toMatch(/up -d --wait version=1\.0\.6/u);
    expect(await f.log()).toMatch(/update failed/u);
  });
});
