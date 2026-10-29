import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initializeLocalDevelopment } from "../scripts/setup-local.js";

const template = `OPENSTEER_AUTH_SECRET=replace-with-at-least-32-random-characters
OPENSTEER_CANONICAL_ORIGIN=http://localhost:43100
OPENSTEER_BIND_ADDRESS=127.0.0.1
OPENSTEER_DEFAULT_WORKSPACE_BACKING=local-directory
OPENSTEER_DEPLOYMENT_KIND=server
`;

describe("local development initialization", () => {
  it("creates one private environment, validates tools, and starts PostgreSQL idempotently", async () => {
    const repositoryRoot = join(tmpdir(), `opensteer-local-setup-${randomUUID()}`);
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(join(repositoryRoot, ".env.example"), template);
    const commands: string[] = [];
    const runCommand = vi.fn(async (command: string, arguments_: readonly string[]) => {
      commands.push([command, ...arguments_].join(" "));
      if (command === "pnpm") return "10.29.3\n";
      if (command === "go") return "go version go1.26.2 test/arch\n";
      return "ok\n";
    });
    const validatePortableFs = vi.fn(async () => undefined);

    const first = await initializeLocalDevelopment({
      nodeVersion: "24.18.0",
      repositoryRoot,
      runCommand,
      validatePortableFs,
    });
    const firstContent = await readFile(join(repositoryRoot, ".env"), "utf8");
    expect(first.environmentCreated).toBe(true);
    expect(firstContent).not.toContain("replace-with");
    expect(first).toMatchObject({ backing: "local-directory" });
    expect(firstContent).not.toContain("OPENSTEER_PORTABLEFS");
    expect(validatePortableFs).not.toHaveBeenCalled();
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
      nodeVersion: "24.18.0",
      repositoryRoot,
      runCommand,
      validatePortableFs,
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
    const runCommand = async (command: string) => {
      if (command === "pnpm") return "10.29.3";
      if (command === "go") return "go version go1.25.0 test/arch";
      return "ok";
    };

    const result = await initializeLocalDevelopment({
      nodeVersion: "24.13.0",
      repositoryRoot,
      runCommand,
      validatePortableFs: async () => undefined,
    });
    const content = await readFile(join(repositoryRoot, ".env"), "utf8");
    expect(result.environmentUpdated).toBe(true);
    expect(content).toContain(`OPENSTEER_AUTH_SECRET=${authSecret}`);
    expect(content).toContain("OPENSTEER_DEFAULT_WORKSPACE_BACKING=local-directory");
  });

  it("converges concurrent first runs on one persisted set of secrets", async () => {
    const repositoryRoot = join(tmpdir(), `opensteer-local-race-${randomUUID()}`);
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(join(repositoryRoot, ".env.example"), template);
    const runCommand = async (command: string) => {
      if (command === "pnpm") return "10.29.3";
      if (command === "go") return "go version go1.26.0 test/arch";
      return "ok";
    };

    await Promise.all(
      Array.from({ length: 12 }, () =>
        initializeLocalDevelopment({
          nodeVersion: "24.18.0",
          repositoryRoot,
          runCommand,
          validatePortableFs: async () => undefined,
        }),
      ),
    );
    const content = await readFile(join(repositoryRoot, ".env"), "utf8");
    expect(content.match(/^OPENSTEER_AUTH_SECRET=/gmu)).toHaveLength(1);
    expect(content).not.toContain("replace-with");
  });

  it("validates PortableFS only when its integration backing is explicit", async () => {
    const repositoryRoot = join(tmpdir(), `opensteer-local-pfs-${randomUUID()}`);
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(
      join(repositoryRoot, ".env.example"),
      template.replace("local-directory", "portablefs") + "OPENSTEER_DEV_PORTABLEFS=local\n",
    );
    const commands: string[] = [];
    const validatePortableFs = vi.fn(async () => undefined);
    const result = await initializeLocalDevelopment({
      nodeVersion: "24.18.0",
      repositoryRoot,
      runCommand: async (command, arguments_) => {
        commands.push([command, ...arguments_].join(" "));
        if (command === "pnpm") return "10.29.3";
        if (command === "go") return "go version go1.26.0 test/arch";
        return "ok";
      },
      validatePortableFs,
    });
    expect(result).toMatchObject({
      portableFsSourceDirectory: join(tmpdir(), "portablefs"),
      backing: "portablefs",
    });
    expect(validatePortableFs).toHaveBeenCalledOnce();
    expect(commands).toContain("openssl version");
  });

  it("rejects PortableFS configuration under the default local-directory backing", async () => {
    const repositoryRoot = join(tmpdir(), `opensteer-local-mixed-${randomUUID()}`);
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(
      join(repositoryRoot, ".env.example"),
      `${template}OPENSTEER_PORTABLEFS_MANAGER_URL=https://manager.example.test\n`,
    );
    await expect(
      initializeLocalDevelopment({
        nodeVersion: "24.18.0",
        repositoryRoot,
        runCommand: async (command) => {
          if (command === "pnpm") return "10.29.3";
          if (command === "go") return "go version go1.26.0 test/arch";
          return "ok";
        },
      }),
    ).rejects.toThrow(/local-directory.*OPENSTEER_PORTABLEFS_MANAGER_URL/);
  });

  it("rejects PortableFS configuration inherited from the shell in local mode", async () => {
    const repositoryRoot = join(tmpdir(), `opensteer-local-shell-mixed-${randomUUID()}`);
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(join(repositoryRoot, ".env.example"), template);
    await expect(
      initializeLocalDevelopment({
        environment: {
          OPENSTEER_PORTABLEFS_MANAGER_URL: "https://manager.example.test",
        },
        nodeVersion: "24.18.0",
        repositoryRoot,
        runCommand: async (command) => {
          if (command === "pnpm") return "10.29.3";
          if (command === "go") return "go version go1.26.0 test/arch";
          return "ok";
        },
      }),
    ).rejects.toThrow(/local-directory.*OPENSTEER_PORTABLEFS_MANAGER_URL/);
  });

  it("rejects an unsafe existing environment path", async () => {
    const repositoryRoot = join(tmpdir(), `opensteer-local-unsafe-${randomUUID()}`);
    await mkdir(join(repositoryRoot, ".env"), { recursive: true });
    await writeFile(join(repositoryRoot, ".env.example"), template);
    await expect(
      initializeLocalDevelopment({
        nodeVersion: "24.18.0",
        repositoryRoot,
        runCommand: async (command) =>
          command === "pnpm"
            ? "10.29.3"
            : command === "go"
              ? "go version go1.26.0 test/arch"
              : "ok",
        validatePortableFs: async () => undefined,
      }),
    ).rejects.toThrow(/regular file/);
  });
});
