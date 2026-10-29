import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runBounded } from "../scripts/command-runner.js";
import {
  integrationPrerequisites,
  integrationTestArguments,
  runIntegrationTests,
  assertDockerBindSource,
} from "../scripts/test-integration.js";

const ownedRoots: string[] = [];
afterAll(() => Promise.all(ownedRoots.map((root) => rm(root, { recursive: true, force: true }))));

/** A home whose Docker Desktop shares `root`, so no case reads this machine's sharing settings. */
async function sharingHome(root: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opensteer-integration-home-"));
  ownedRoots.push(home);
  const settings = join(home, "Library/Group Containers/group.com.docker");
  await mkdir(settings, { recursive: true });
  await writeFile(
    join(settings, "settings-store.json"),
    JSON.stringify({ filesharingDirectories: [await realpath(root)] }),
  );
  return home;
}
describe("integration-test launcher", () => {
  it("rejects an unshared bind source before Docker and respects path boundaries", () => {
    expect(() =>
      assertDockerBindSource("/private/var/folders/rerun/init.sql", ["/Users/person"]),
    ).toThrow(/outside.*shared paths/u);
    expect(() =>
      assertDockerBindSource("/Users/person/shared-else/init.sql", ["/Users/person/shared"]),
    ).toThrow(/outside.*shared paths/u);
    expect(() =>
      assertDockerBindSource("/Users/person/.local/state/reruns/init.sql", ["/Users/person"]),
    ).not.toThrow();
  });
  it("starts and removes its disposable PostgreSQL when no external database is configured", async () => {
    const commands: Array<{
      readonly command: string;
      readonly arguments_: readonly string[];
      readonly environment?: NodeJS.ProcessEnv;
    }> = [];
    const runCommand = vi.fn(
      async (
        command: string,
        arguments_: readonly string[],
        options?: { readonly environment?: NodeJS.ProcessEnv },
      ) => {
        commands.push({
          command,
          arguments_,
          ...(options?.environment ? { environment: options.environment } : {}),
        });
        if (arguments_[0] === "create") return "a".repeat(64);
        if (arguments_[0] === "inspect") return "healthy";
        if (arguments_[0] === "port") return "127.0.0.1:49152\n";
        return "";
      },
    );

    await runIntegrationTests({
      environment: {},
      home: await sharingHome(resolve(import.meta.dirname, "..")),
      packageManager: "/test/pnpm.cjs",
      repositoryRoot: resolve(import.meta.dirname, ".."),
      runCommand,
    });

    expect(commands.map(({ arguments_ }) => arguments_[0])).toEqual([
      "create",
      "start",
      "inspect",
      "port",
      "/test/pnpm.cjs",
      "rm",
    ]);
    const create = commands[0]!.arguments_;
    expect(create[create.indexOf("--name") + 1]).toMatch(/^opensteer-integration-[a-f0-9-]{36}$/);
    expect(create[create.indexOf("--publish") + 1]).toBe("127.0.0.1::5432");
    expect(create.at(-1)).toMatch(/^postgres:18-alpine@sha256:[a-f0-9]{64}$/);
    expect(commands.at(-1)?.arguments_).toEqual(["rm", "--force", "--volumes", "a".repeat(64)]);
    expect(commands[4]?.environment).toMatchObject({
      OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL:
        "postgres://opensteer:opensteer@127.0.0.1:49152/opensteer_control_plane",
      OPENSTEER_TEST_DATABASE_URL: "postgres://opensteer:opensteer@127.0.0.1:49152/opensteer",
    });
  });

  it("runs another database-backed suite with its own Vitest arguments", async () => {
    const commands: string[] = [];
    await runIntegrationTests({
      ...integrationTestArguments(["--config", "vitest.engines.config.ts", "--", "-t", "Codex"]),
      environment: {
        OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL: "postgres://cp.example/test",
        OPENSTEER_TEST_DATABASE_URL: "postgres://host.example/test",
      },
      packageManager: "/test/pnpm.cjs",
      repositoryRoot: resolve(import.meta.dirname, ".."),
      runCommand: async (_command, arguments_) => {
        commands.push(arguments_.join(" "));
        return "";
      },
    });

    expect(commands).toEqual([
      "/test/pnpm.cjs exec vitest run --config vitest.engines.config.ts -t Codex",
    ]);
    expect(integrationTestArguments(["--", "-t", "Claude"])).toEqual({
      vitestArguments: ["-t", "Claude"],
    });
    expect(integrationTestArguments(["--", "--preflight", "tests/a.integration.test.ts"])).toEqual({
      preflight: true,
      vitestArguments: ["tests/a.integration.test.ts"],
    });
    expect(
      integrationTestArguments([
        "--preflight",
        "--config",
        "vitest.engines.config.ts",
        "--",
        "-t",
        "x",
      ]),
    ).toEqual({
      preflight: true,
      config: "vitest.engines.config.ts",
      vitestArguments: ["-t", "x"],
    });
    expect(() => integrationTestArguments(["--config"])).toThrow("--config needs");
  });

  it("uses an explicit database pair without invoking Docker", async () => {
    const commands: Array<{ command: string; environment?: NodeJS.ProcessEnv }> = [];
    await runIntegrationTests({
      environment: {
        OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL: "postgres://cp.example/test",
        OPENSTEER_TEST_DATABASE_URL: "postgres://host.example/test",
      },
      packageManager: "/test/pnpm.cjs",
      repositoryRoot: resolve(import.meta.dirname, ".."),
      runCommand: async (command, _arguments, options) => {
        commands.push({
          command,
          ...(options?.environment ? { environment: options.environment } : {}),
        });
        return "";
      },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: process.execPath });
    expect(commands[0]?.environment).toMatchObject({
      OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL: "postgres://cp.example/test",
      OPENSTEER_TEST_DATABASE_URL: "postgres://host.example/test",
    });
  });

  it("requires external Host and control-plane database URLs as one authority pair", async () => {
    await expect(
      runIntegrationTests({
        environment: { OPENSTEER_TEST_DATABASE_URL: "postgres://host.example/test" },
        packageManager: "/test/pnpm.cjs",
        runCommand: vi.fn(),
      }),
    ).rejects.toThrow(/Set both OPENSTEER_TEST_DATABASE_URL/);
  });

  it("removes the disposable database even when the suite fails", async () => {
    const commands: string[] = [];
    await expect(
      runIntegrationTests({
        environment: {},
        home: await sharingHome(resolve(import.meta.dirname, "..")),
        packageManager: "/test/pnpm.cjs",
        repositoryRoot: resolve(import.meta.dirname, ".."),
        runCommand: async (command, arguments_) => {
          commands.push(`${command} ${arguments_.join(" ")}`);
          if (command === process.execPath) throw new Error("test failure");
          if (arguments_[0] === "create") return "b".repeat(64);
          if (arguments_[0] === "inspect") return "healthy";
          if (arguments_[0] === "port") return "127.0.0.1:49153";
          return "";
        },
      }),
    ).rejects.toThrow("test failure");

    expect(commands.at(-1)).toBe(`docker rm --force --volumes ${"b".repeat(64)}`);
  });

  it("builds every app output an integration test reads before the suite runs", async () => {
    // Missing, the output fails a fresh checkout; stale, it puts old bytes under a new proof.
    const root = resolve(import.meta.dirname, "..");
    const manifest = z.object({ name: z.string(), scripts: z.record(z.string(), z.string()) });
    const read = async (file: string) =>
      manifest.parse(JSON.parse(await readFile(join(root, file), "utf8")));
    // pnpm runs a lifecycle hook before the launcher holds the checkout's outputs.
    expect((await read("package.json")).scripts["pretest:integration"]).toBeUndefined();
    const tests = (
      await runBounded("git", ["ls-files", "*.integration.test.ts", "*.integration.test.tsx"], {
        cwd: root,
      })
    )
      .split("\n")
      .filter(Boolean);
    const apps = new Set<string>();
    for (const test of tests)
      for (const [, app] of (await readFile(join(root, test), "utf8")).matchAll(
        /apps\/([\w-]+)\/dist\//gu,
      ))
        apps.add(app!);
    // Today: the desktop runner worker, which local Runner startup launches.
    expect(apps.size).toBeGreaterThan(0);
    for (const app of apps) {
      const { name, scripts } = await read(`apps/${app}/package.json`);
      const script = integrationPrerequisites.find(({ filter }) => filter === name)?.script;
      expect(script, `the launcher must build ${name}`).toBeDefined();
      expect(scripts[script!]).toMatch(/^tsup /u);
    }
  });
});
