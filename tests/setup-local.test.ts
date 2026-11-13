import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initializeLocalDevelopment } from "../scripts/setup-local.js";

const pnpmEntrypoint = join(tmpdir(), `opensteer-local-pnpm-${randomUUID()}`, "pnpm.cjs");
const environment = { npm_execpath: pnpmEntrypoint };
const tool = (command: string, arguments_: readonly string[]) =>
  command === process.execPath && arguments_[0] === pnpmEntrypoint ? "pnpm" : command;
beforeAll(async () => {
  await mkdir(join(pnpmEntrypoint, ".."), { recursive: true });
  await writeFile(pnpmEntrypoint, "");
});

const template = `OPENSTEER_AUTH_SECRET=replace-with-at-least-32-random-characters
OPENSTEER_CANONICAL_ORIGIN=http://localhost:43100
OPENSTEER_BIND_ADDRESS=127.0.0.1
OPENSTEER_DEPLOYMENT_KIND=personal
`;

describe("local development initialization", () => {
  it("creates one private environment, validates tools, and starts PostgreSQL idempotently", async () => {
    const repositoryRoot = join(tmpdir(), `opensteer-local-setup-${randomUUID()}`);
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(join(repositoryRoot, ".env.example"), template);
    const commands: string[] = [];
    const runCommand = vi.fn(async (command: string, arguments_: readonly string[]) => {
      command = tool(command, arguments_);
      commands.push(
        [command, ...(command === "pnpm" ? arguments_.slice(1) : arguments_)].join(" "),
      );
      if (command === "pnpm") return "10.29.3\n";
      if (command === "go") return "go version go1.26.2 test/arch\n";
      return "ok\n";
    });

    const first = await initializeLocalDevelopment({
      environment,
      nodeVersion: "24.18.0",
      repositoryRoot,
      runCommand,
    });
    const firstContent = await readFile(join(repositoryRoot, ".env"), "utf8");
    expect(first.environmentCreated).toBe(true);
    expect(firstContent).not.toContain("replace-with");
    expect(first).toMatchObject({ kind: "personal" });
    expect(commands).toContain("docker info --format {{.ServerVersion}}");
    expect(commands).toContain("pnpm exec playwright-core install chromium");
    expect(
      commands.some(
        (command) => command.includes("docker compose -f") && command.endsWith("up -d --wait"),
      ),
    ).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(join(repositoryRoot, ".env"))).mode & 0o777).toBe(0o600);
    }

    const second = await initializeLocalDevelopment({
      environment,
      nodeVersion: "24.18.0",
      repositoryRoot,
      runCommand,
    });
    expect(second).toMatchObject({ environmentCreated: false, environmentUpdated: false });
    expect(await readFile(join(repositoryRoot, ".env"), "utf8")).toBe(firstContent);
  });

  it("repairs exact placeholders and missing local secrets without rotating existing values", async () => {
    const repositoryRoot = join(tmpdir(), `opensteer-local-repair-${randomUUID()}`);
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(join(repositoryRoot, ".env.example"), template);
    const authSecret = "a".repeat(64);
    await writeFile(
      join(repositoryRoot, ".env"),
      `OPENSTEER_AUTH_SECRET=${authSecret}\nOPENSTEER_CANONICAL_ORIGIN=http://localhost:43100\nOPENSTEER_BIND_ADDRESS=127.0.0.1\n`,
      { mode: 0o644 },
    );
    const runCommand = async (command: string, arguments_: readonly string[]) => {
      if (tool(command, arguments_) === "pnpm") return "10.29.3";
      if (command === "go") return "go version go1.25.0 test/arch";
      return "ok";
    };

    const result = await initializeLocalDevelopment({
      environment,
      nodeVersion: "24.13.0",
      repositoryRoot,
      runCommand,
    });
    const content = await readFile(join(repositoryRoot, ".env"), "utf8");
    expect(result.environmentUpdated).toBe(true);
    expect(content).toContain(`OPENSTEER_AUTH_SECRET=${authSecret}`);
    expect(content).toContain("OPENSTEER_DEPLOYMENT_KIND=personal");
  });

  it("converges concurrent first runs on one persisted set of secrets", async () => {
    const repositoryRoot = join(tmpdir(), `opensteer-local-race-${randomUUID()}`);
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(join(repositoryRoot, ".env.example"), template);
    const runCommand = async (command: string, arguments_: readonly string[]) => {
      if (tool(command, arguments_) === "pnpm") return "10.29.3";
      if (command === "go") return "go version go1.26.0 test/arch";
      return "ok";
    };

    await Promise.all(
      Array.from({ length: 12 }, () =>
        initializeLocalDevelopment({
          environment,
          nodeVersion: "24.18.0",
          repositoryRoot,
          runCommand,
        }),
      ),
    );
    const content = await readFile(join(repositoryRoot, ".env"), "utf8");
    expect(content.match(/^OPENSTEER_AUTH_SECRET=/gmu)).toHaveLength(1);
    expect(content).not.toContain("replace-with");
  });

  it("runs the pnpm that launched it, and refuses to run outside pnpm", async () => {
    const repositoryRoot = join(tmpdir(), `opensteer-local-pnpm-${randomUUID()}`);
    const runCommand = vi.fn(async () => "ok");
    for (const npm_execpath of [undefined, join(pnpmEntrypoint, "..", "npm-cli.js"), "pnpm.cjs"])
      await expect(
        initializeLocalDevelopment({
          environment: { npm_execpath },
          nodeVersion: "24.18.0",
          repositoryRoot,
          runCommand,
        }),
      ).rejects.toThrow(/Run this through pnpm/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects an unsafe existing environment path", async () => {
    const repositoryRoot = join(tmpdir(), `opensteer-local-unsafe-${randomUUID()}`);
    await mkdir(join(repositoryRoot, ".env"), { recursive: true });
    await writeFile(join(repositoryRoot, ".env.example"), template);
    await expect(
      initializeLocalDevelopment({
        nodeVersion: "24.18.0",
        repositoryRoot,
        environment,
        runCommand: async (command, arguments_) =>
          tool(command, arguments_) === "pnpm"
            ? "10.29.3"
            : command === "go"
              ? "go version go1.26.0 test/arch"
              : "ok",
      }),
    ).rejects.toThrow(/regular file/);
  });
});
