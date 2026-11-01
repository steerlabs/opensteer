import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { holdCheckoutWrites } from "@opensteer/shared/kernelLock";
import { lockOrderMode } from "@opensteer/shared/lockOrderMode";
import { runBounded } from "./command-runner.js";
import {
  invalidateIntegrationBundles,
  prepareIntegrationBundle,
} from "./integration-runner-build.js";
import { contractSchema, runRecordsDirectory, runRecordVariable } from "./run-record.js";

const databaseImageSchema = z.object({
  services: z.object({
    postgres: z.object({ image: z.string().regex(/^postgres:[^@]+@sha256:[a-f0-9]{64}$/u) }),
  }),
});

export function assertDockerBindSource(source: string, sharedPaths: readonly string[]): void {
  if (
    sharedPaths.some((root) => {
      const suffix = relative(root, source);
      return (
        suffix === "" || (suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("/"))
      );
    })
  )
    return;
  throw new Error(
    `Docker bind source ${source} is outside the Docker VM's shared paths (${sharedPaths.join(", ")}). Put the checkout under a shared home directory or add its parent to the VM's file sharing before running integration tests.`,
  );
}

/** Read the VM's host sharing configuration before builds or docker create. */
async function requireSharedDatabaseFixture(
  root: string,
  environment: NodeJS.ProcessEnv,
  home: string,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const json = async (file: string) => JSON.parse(await readFile(file, "utf8")) as unknown;
  const source = await realpath(resolve(root, "deploy/compose/init-test-databases.sql"));
  if (environment.DOCKER_HOST && !environment.DOCKER_HOST.startsWith("unix:"))
    throw new Error(
      `Cannot verify Docker VM shared paths for ${environment.DOCKER_HOST}; use local Docker or explicit test database URLs.`,
    );
  let context = environment.DOCKER_CONTEXT;
  if (!context) {
    try {
      context = z
        .object({ currentContext: z.string().optional() })
        .parse(
          await json(join(environment.DOCKER_CONFIG ?? join(home, ".docker"), "config.json")),
        ).currentContext;
    } catch {
      /* Default Docker Desktop context. */
    }
  }
  if (context && !["default", "desktop-linux"].includes(context) && !context.startsWith("colima"))
    throw new Error(
      `Cannot verify shared paths for Docker context ${context}; use a local Docker Desktop/Colima context or explicit test database URLs.`,
    );
  let sharedPaths: string[];
  if (context?.startsWith("colima") || environment.DOCKER_HOST?.includes("/.colima/")) {
    const profile = context?.startsWith("colima-") ? context.slice(7) : "default";
    if (!/^[\w-]+$/u.test(profile))
      throw new Error("Cannot determine Colima profile for Docker bind mount preflight");
    const config = z
      .object({ mounts: z.array(z.object({ location: z.string() })).optional() })
      .parse(
        parse(
          await readFile(
            join(environment.COLIMA_HOME ?? join(home, ".colima"), profile, "colima.yaml"),
            "utf8",
          ),
        ),
      );
    sharedPaths = config.mounts?.length
      ? config.mounts.map((mount) => mount.location.replace(/^~(?=\/|$)|^\$HOME(?=\/|$)/u, home))
      : [home];
  } else if (environment.DOCKER_HOST && !environment.DOCKER_HOST.startsWith("unix:")) {
    throw new Error(
      `Cannot verify Docker VM shared paths for ${environment.DOCKER_HOST}; use local Docker or explicit test database URLs.`,
    );
  } else {
    sharedPaths = [home];
    for (const filename of ["settings-store.json", "settings.json"]) {
      try {
        const settings = z
          .object({
            filesharingDirectories: z.array(z.string()).optional(),
            fileSharingDirectories: z.array(z.string()).optional(),
          })
          .parse(await json(join(home, "Library/Group Containers/group.com.docker", filename)));
        const paths = settings.filesharingDirectories ?? settings.fileSharingDirectories;
        if (paths) {
          sharedPaths = paths;
          break;
        }
      } catch {
        /* Without settings, only home is known to be shared. */
      }
    }
  }
  const canonical = await Promise.all(
    sharedPaths.map(async (folder) => realpath(folder).catch(() => resolve(folder))),
  );
  assertDockerBindSource(source, canonical);
}

interface CommandOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly inherit?: boolean;
  readonly signal?: AbortSignal;
}

type CommandRunner = (
  command: string,
  arguments_: readonly string[],
  options?: CommandOptions,
) => Promise<string>;

export interface IntegrationTestOptions {
  readonly signal?: AbortSignal;
  /** The Vitest configuration naming the suite; the integration suite by default. */
  readonly config?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly packageManager?: string;
  readonly repositoryRoot?: string;
  /** The home whose Docker sharing settings the macOS preflight reads; the user's by default. */
  readonly home?: string;
  readonly runCommand?: CommandRunner;
  /** Passed to Vitest after the configuration, such as a `-t` name filter. */
  readonly vitestArguments?: readonly string[];
  /** Runs under the launcher's signal handling, before it starts a database. */
  readonly prepare?: (signal: AbortSignal) => Promise<void>;
  /** The run-record attempt this run's Vitest child, teardown and envelope write into. */
  readonly record?: {
    readonly directory: string;
    readonly contract: z.infer<typeof contractSchema>;
    readonly filtered: boolean;
  };
}

/**
 * Outputs the integration suite drives, each built from the current source
 * while the launcher holds the checkout's outputs: a missing one fails a fresh
 * checkout, and a stale one puts old bytes under a new proof. A lifecycle hook
 * would run before that hold.
 */
export const integrationPrerequisites = [
  {
    filter: "@opensteer/browser-runtime",
    script: "build",
    output: "apps/browser-runtime/dist/main.js",
  },
  {
    filter: "@opensteer/runner",
    script: "build:native-fs:test",
    output: "apps/runner/native-fs-helper/opensteer-native-fs-test",
  },
  {
    filter: "@opensteer/runner",
    script: "build:integration",
    output: "apps/runner/dist-integration/recovery-runner.test-support.js",
    bundle: "recovery",
  },
  // The worker shares a chunk with main.js, so only the bundle build produces its shipped bytes.
  {
    filter: "@opensteer/desktop",
    script: "build:bundles",
    output: "apps/desktop/dist/runner-worker.js",
    bundle: "desktop",
  },
] as const;

async function buildPrerequisites(
  root: string,
  packageManager: string,
  run: CommandRunner,
  signal: AbortSignal,
): Promise<void> {
  await invalidateIntegrationBundles(root);
  const pending: Awaited<ReturnType<typeof prepareIntegrationBundle>>[] = [];
  try {
    for (const prerequisite of integrationPrerequisites) {
      signal.throwIfAborted();
      if ("bundle" in prerequisite)
        pending.push(await prepareIntegrationBundle(root, prerequisite.bundle, signal));
      await run(
        process.execPath,
        [packageManager, "--filter", prerequisite.filter, prerequisite.script],
        {
          cwd: root,
          inherit: true,
          signal,
        },
      );
    }
    const missing = [];
    for (const prerequisite of integrationPrerequisites) {
      try {
        await access(resolve(root, prerequisite.output));
      } catch {
        missing.push(prerequisite);
      }
    }
    if (missing.length)
      throw new Error(
        "The integration suite needs build outputs that its builds did not produce:\n" +
          missing
            .map(({ output, filter, script }) => `  ${output}: pnpm --filter ${filter} ${script}`)
            .join("\n"),
      );
    for (const build of pending) await build.publish();
  } catch (error) {
    await invalidateIntegrationBundles(root);
    throw error;
  }
}

export async function runIntegrationTests(options: IntegrationTestOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  const packageManager = options.packageManager ?? environment.npm_execpath;
  if (!packageManager) {
    throw new Error("pnpm did not provide npm_execpath to the integration-test launcher.");
  }

  explicitIntegrationDatabases(environment);
  const explicitHostDatabaseUrl = environment.OPENSTEER_TEST_DATABASE_URL;
  const explicitControlPlaneDatabaseUrl = environment.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;

  const repositoryRoot = resolve(options.repositoryRoot ?? resolve(import.meta.dirname, ".."));
  if (!explicitHostDatabaseUrl)
    await requireSharedDatabaseFixture(repositoryRoot, environment, options.home ?? homedir());
  const run = options.runCommand ?? runCommand;
  const stop = new AbortController();
  const cancel = () => stop.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
  let interrupted: string | undefined;
  const handlers = Object.entries(signals).map(([signal, exitCode]) => {
    const handler = () => {
      if (stop.signal.aborted) return;
      interrupted = signal;
      process.exitCode = exitCode;
      stop.abort(new Error(`Integration tests interrupted by ${signal}`));
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  let container: string | undefined;
  let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
  let cleanup: { ok: boolean; error?: string } = { ok: true };
  let suiteStarted = false;
  let launcherError: string | undefined;
  if (options.record) await mkdir(options.record.directory, { recursive: true, mode: 0o700 });

  try {
    stop.signal.throwIfAborted();
    await options.prepare?.(stop.signal);
    let hostDatabaseUrl = explicitHostDatabaseUrl;
    let controlPlaneDatabaseUrl = explicitControlPlaneDatabaseUrl;
    if (!hostDatabaseUrl) {
      const started = performance.now();
      const composeFile = resolve(repositoryRoot, "deploy", "compose", "compose.yaml");
      const image = databaseImageSchema.parse(parse(await readFile(composeFile, "utf8"))).services
        .postgres.image;
      stop.signal.throwIfAborted();
      // Finish creation before observing cancellation so teardown always has its owner ID.
      container = z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(
          (
            await run(
              "docker",
              [
                "create",
                "--name",
                `opensteer-integration-${randomUUID()}`,
                "--publish",
                "127.0.0.1::5432",
                "--tmpfs",
                "/var/lib/postgresql",
                "--env",
                "POSTGRES_DB=opensteer",
                "--env",
                "POSTGRES_USER=opensteer",
                "--env",
                "POSTGRES_PASSWORD=opensteer",
                "--mount",
                `type=bind,src=${resolve(repositoryRoot, "deploy/compose/init-test-databases.sql")},dst=/docker-entrypoint-initdb.d/10-opensteer-test-databases.sql,readonly`,
                "--health-cmd",
                "pg_isready -h 127.0.0.1 -U opensteer -d opensteer",
                "--health-interval",
                "250ms",
                "--health-timeout",
                "3s",
                "--health-retries",
                "80",
                image,
              ],
              { cwd: repositoryRoot },
            )
          ).trim(),
        );
      stop.signal.throwIfAborted();
      await run("docker", ["start", container], { cwd: repositoryRoot });
      const deadline = performance.now() + 60_000;
      while (true) {
        stop.signal.throwIfAborted();
        const health = (
          await run("docker", ["inspect", "--format", "{{.State.Health.Status}}", container], {
            signal: stop.signal,
          })
        ).trim();
        if (health === "healthy") break;
        if (health === "unhealthy" || performance.now() >= deadline)
          throw new Error(
            `Integration PostgreSQL ${container} did not become healthy (${health}).`,
          );
        await delay(100, undefined, { signal: stop.signal });
      }
      const address = z
        .string()
        .regex(/^127\.0\.0\.1:\d+$/u)
        .parse((await run("docker", ["port", container, "5432/tcp"])).trim());
      hostDatabaseUrl = `postgres://opensteer:opensteer@${address}/opensteer`;
      controlPlaneDatabaseUrl = `postgres://opensteer:opensteer@${address}/opensteer_control_plane`;
      console.info(
        `Integration PostgreSQL: ${container} at ${address}; ready in ${((performance.now() - started) / 1_000).toFixed(2)}s`,
      );
    }
    suiteStarted = true;
    await run(
      process.execPath,
      [
        packageManager,
        "exec",
        "vitest",
        "run",
        "--config",
        options.config ?? "vitest.integration.config.ts",
        ...(options.vitestArguments ?? []),
      ],
      {
        cwd: repositoryRoot,
        environment: {
          ...environment,
          OPENSTEER_TEST_DATABASE_URL: hostDatabaseUrl,
          OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL: controlPlaneDatabaseUrl,
          ...(options.record ? { [runRecordVariable]: options.record.directory } : {}),
        },
        inherit: true,
        signal: stop.signal,
      },
    ).then(
      () => (exit = { code: 0, signal: null }),
      (error: unknown) => {
        const status = error as { exitCode?: unknown; signal?: unknown };
        exit = {
          code: typeof status.exitCode === "number" ? status.exitCode : null,
          signal: interrupted ?? (typeof status.signal === "string" ? status.signal : null),
        };
        throw error;
      },
    );
  } catch (error) {
    if (!suiteStarted) {
      launcherError = error instanceof Error ? error.message : String(error);
      exit = {
        code: typeof process.exitCode === "number" ? process.exitCode : 1,
        signal: interrupted ?? null,
      };
    }
    throw error;
  } finally {
    try {
      if (container)
        await run("docker", ["rm", "--force", "--volumes", container], { inherit: true }).catch(
          (error: unknown) => {
            cleanup = { ok: false, error: error instanceof Error ? error.message : String(error) };
            throw error;
          },
        );
    } finally {
      for (const { signal, handler } of handlers) process.removeListener(signal, handler);
      options.signal?.removeEventListener("abort", cancel);
      // Written last, after the child exited and cleanup finished.
      if (options.record)
        await writeFile(
          join(options.record.directory, "envelope.json"),
          JSON.stringify(
            {
              attempt: basename(options.record.directory),
              contract: options.record.contract,
              argv: options.vitestArguments ?? [],
              filtered: options.record.filtered,
              exit,
              cleanup,
              ...(launcherError !== undefined ? { launcherError } : {}),
            },
            null,
            2,
          ) + "\n",
          { mode: 0o600 },
        );
    }
  }
  stop.signal.throwIfAborted();
}

async function requireDocker(run: CommandRunner) {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  } catch (error) {
    throw new Error(
      `Docker is unavailable for the suite's database (${error instanceof Error ? error.message : String(error)}). Start Docker, or set both OPENSTEER_TEST_DATABASE_URL and OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL.`,
      { cause: error },
    );
  }
}

async function runCommand(
  command: string,
  arguments_: readonly string[],
  options: CommandOptions = {},
): Promise<string> {
  return runBounded(command, arguments_, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.environment ? { env: options.environment } : {}),
    ...(options.inherit !== undefined ? { inheritOutput: options.inherit } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: command === process.execPath ? 86_400_000 : 60_000,
  });
}

/**
 * `--preflight` first stops at the first failure without proving anything.
 * `--config <file>` selects another database-backed suite; everything after it
 * (and after a `--` separator pnpm may leave in place) goes to Vitest.
 */
export function integrationTestArguments(
  arguments_: readonly string[],
): Pick<IntegrationLaunchOptions, "config" | "preflight" | "vitestArguments"> {
  let rest = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const flags: { preflight?: true } = {};
  for (;;) {
    if (rest[0] === "--preflight") flags.preflight = true;
    else break;
    rest = rest.slice(1);
  }
  if (rest[0] !== "--config") return { ...flags, vitestArguments: rest };
  const config = rest[1];
  if (!config) throw new Error("--config needs a Vitest configuration file.");
  const vitestArguments = rest.slice(2);
  return {
    ...flags,
    config,
    vitestArguments: vitestArguments[0] === "--" ? vitestArguments.slice(1) : vitestArguments,
  };
}

export interface IntegrationLaunchOptions extends IntegrationTestOptions {
  /** Stops at the first failure (`--bail=1`); never reads or writes proof. */
  readonly preflight?: boolean;
  /** Where run records go; one attempt directory per run, under the SHA. */
  readonly recordsDirectory?: string;
  /** Holds the checkout's build outputs while the launcher builds them and the suite runs. */
  readonly holdOutputs?: () => Promise<{ release(): void }>;
  readonly run?: typeof runBounded;
}

/** Runs every requested suite; CI owns qualification of the commit. */
export async function testIntegration(options: IntegrationLaunchOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  lockOrderMode(environment);
  const root = resolve(options.repositoryRoot ?? resolve(import.meta.dirname, ".."));
  const packageManager = options.packageManager ?? environment.npm_execpath;
  if (!explicitIntegrationDatabases(environment)) {
    await requireSharedDatabaseFixture(root, environment, options.home ?? homedir());
    await requireDocker(options.runCommand ?? runCommand);
  }
  const run = options.run ?? runBounded;
  const sourceRevision = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).trim();
  const contract = {
    identity: { sourceRevision },
    suite: "integration",
    recipe: ["pnpm test:integration"],
    inputs: { "lock-order": lockOrderMode(environment) },
  };
  const directory =
    environment.OPENSTEER_RUN_RECORD_ATTEMPT ??
    join(
      options.recordsDirectory ?? runRecordsDirectory,
      sourceRevision,
      `${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomUUID().slice(0, 8)}`,
    );
  process.stdout.write(`Integration run record: ${directory}\n`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const outputs = !options.config && packageManager ? await options.holdOutputs?.() : undefined;
  try {
    await runIntegrationTests({
      ...options,
      record: {
        directory,
        contract,
        filtered: Boolean(options.config || options.vitestArguments?.length || options.preflight),
      },
      ...(options.preflight
        ? { vitestArguments: [...(options.vitestArguments ?? []), "--bail=1"] }
        : {}),
      ...(options.config || !packageManager
        ? {}
        : {
            prepare: (signal: AbortSignal) =>
              buildPrerequisites(root, packageManager, options.runCommand ?? runCommand, signal),
          }),
    });
  } finally {
    outputs?.release();
  }
}

/** Caller-owned test servers require both database URLs. */
export function explicitIntegrationDatabases(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const host = Boolean(environment.OPENSTEER_TEST_DATABASE_URL);
  if (host !== Boolean(environment.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL))
    throw new Error(
      "Set both OPENSTEER_TEST_DATABASE_URL and OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL, or neither.",
    );
  return host;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const arguments_ = process.argv.slice(2);
  const launch = integrationTestArguments(arguments_);
  const options = {
    purpose: ["pnpm", process.env.npm_lifecycle_event ?? "test:integration", ...arguments_].join(
      " ",
    ),
  };
  void testIntegration({
    ...launch,
    holdOutputs: () => holdCheckoutWrites(resolve(import.meta.dirname, ".."), options),
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode ||= 1;
  });
}
