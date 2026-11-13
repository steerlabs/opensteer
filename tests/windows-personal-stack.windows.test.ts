import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { CompiledQuery } from "kysely";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createId,
  HarnessInstanceIdSchema,
  type EnvironmentId,
} from "../packages/core/src/index.js";
import { createDatabase } from "../packages/database/src/connection.js";
import { hostApiVersion } from "../packages/deployment-authority/src/index.js";
import { hostApiVersionHeader } from "../packages/protocol/src/index.js";
import {
  spawnSupervised,
  type SupervisedProcess,
} from "../packages/harness/src/process-supervisor.js";
import { testRpcData } from "../apps/host/src/server/test-host-api-request.js";
import { hostCommandPlatform, resolveCommand } from "@opensteer/shared/command";
import { generatedShims } from "@opensteer/shared/test-support/commandShims";
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { mergeEnvironment } from "@opensteer/shared/userEnvironment";
import { withTimeout } from "@opensteer/shared/withTimeout";

const repository = resolve(import.meta.dirname, "..");
// The lane points this at the runner image's PostgreSQL, whose service it leaves stopped.
const postgresBin = process.env.OPENSTEER_TEST_POSTGRES_BIN;
const windows = process.platform === "win32";
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const exe = (name: string) => join(postgresBin!, windows ? `${name}.exe` : name);

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface Service {
  readonly name: string;
  readonly process: SupervisedProcess;
  readonly lines: string[];
  waitFor(label: string, match: (line: string) => boolean, timeoutMs?: number): Promise<string>;
  /** Stops the process and returns its exit once all its output is read and logged. */
  stop(graceMs: number): Promise<Exit>;
}

const services = new Set<Service>();
const temporary: string[] = [];

afterAll(async () => {
  const stopped = await Promise.allSettled([...services].map((service) => service.stop(5_000)));
  const failures = stopped.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new Error(`Services did not stop cleanly; kept ${temporary.join(", ")}`, {
      cause: new AggregateError(failures),
    });
  for (const directory of temporary) await rm(directory, { force: true, recursive: true });
}, 60_000);

/**
 * Starts `command` under the real process supervisor, tees its output into a
 * log beside the test's state, and lets the test wait for a line it prints.
 */
function supervise(
  name: string,
  command: readonly [string, ...string[]],
  options: {
    readonly cwd: string;
    readonly environment: Record<string, string>;
    readonly log: string;
  },
): Service {
  const [executable, ...args] = command;
  const child = spawnSupervised({
    args,
    cwd: options.cwd,
    environment: options.environment,
    executable,
    output: "raw",
    stdin: "closed",
  });
  const log = createWriteStream(options.log, { flags: "a" });
  // Settled at once, so a failed log write is reported by `stop` instead of going unhandled.
  const logged = finished(log).then(
    () => undefined,
    (error: unknown) => error,
  );
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  const read = async (stream: AsyncIterable<Buffer>) => {
    let pending = "";
    for await (const chunk of stream) {
      log.write(chunk);
      pending += chunk.toString("utf8");
      const complete = pending.split(/\r?\n/u);
      pending = complete.pop() ?? "";
      lines.push(...complete);
      for (const waiter of waiters) waiter();
    }
  };
  // The exit can come before the last output, so the log ends only once both streams have.
  const closed = Promise.allSettled([child.exited, read(child.stdout), read(child.stderr)]).then(
    async ([exit, ...output]) => {
      log.end();
      const logError = await logged;
      const failures = [exit, ...output].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (logError) failures.push(logError);
      return { exit: exit.status === "fulfilled" ? exit.value : undefined, failures };
    },
  );
  let stopping: Promise<Exit> | undefined;
  const stop = async (graceMs: number): Promise<Exit> => {
    const terminated = await child.terminate(graceMs).then(
      () => undefined,
      (error: unknown) => error,
    );
    const { exit, failures } = await withTimeout(closed, graceMs + 10_000, {
      timeoutError: () => new Error(`${name}'s output never closed after it was stopped`),
    });
    if (terminated) failures.unshift(terminated);
    if (!exit || failures.length)
      throw new AggregateError(failures, `${name} did not stop cleanly`);
    return exit;
  };
  const service: Service = {
    lines,
    name,
    process: child,
    waitFor(label, match, timeoutMs = 60_000) {
      return withTimeout(
        new Promise<string>((found, failed) => {
          const check = () => {
            const line = lines.find(match);
            if (line === undefined) return;
            waiters.delete(check);
            found(line);
          };
          waiters.add(check);
          check();
          void closed.then(({ exit }) => {
            check();
            waiters.delete(check);
            failed(
              new Error(
                `${name} exited (${exit?.signal ?? exit?.code}) before ${label}:\n${lines.slice(-40).join("\n")}`,
              ),
            );
          });
        }),
        timeoutMs,
        {
          timeoutError: () => new Error(`${name} never ${label}:\n${lines.slice(-40).join("\n")}`),
        },
      );
    },
    stop: (graceMs) => (stopping ??= stop(graceMs)),
  };
  services.add(service);
  return service;
}

/** This test's own environment without its test-runner and Opensteer settings, under `overrides`. */
function environment(overrides: Record<string, string> = {}): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^(OPENSTEER_|VITEST|PG)/iu.test(entry[0]),
    ),
  );
  return mergeEnvironment(inherited, overrides, process.platform);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function startPostgres(root: string) {
  const data = join(root, "postgres");
  const initdb = supervise(
    "initdb",
    [
      exe("initdb"),
      "-D",
      data,
      "-U",
      "opensteer",
      "-A",
      "trust",
      "-E",
      "UTF8",
      "--no-locale",
      "--no-sync",
    ],
    { cwd: root, environment: environment(), log: join(root, "initdb.log") },
  );
  let initialized: Exit;
  try {
    initialized = await withTimeout(initdb.process.exited, 120_000, {
      timeoutError: () => new Error(`initdb never finished:\n${initdb.lines.join("\n")}`),
    });
  } finally {
    await initdb.stop(5_000);
  }
  if (initialized.code !== 0)
    throw new Error(
      `initdb failed (${initialized.signal ?? initialized.code}):\n${initdb.lines.join("\n")}`,
    );
  const port = await freePort();
  const postgres = supervise(
    "postgres",
    [
      exe("postgres"),
      "-D",
      data,
      "-p",
      String(port),
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      "unix_socket_directories=",
      "-c",
      "fsync=off",
    ],
    { cwd: root, environment: environment(), log: join(root, "postgres.log") },
  );
  await postgres.waitFor("accepted connections", (line) =>
    line.includes("database system is ready to accept connections"),
  );
  const postmaster = Number(
    (await readFile(join(data, "postmaster.pid"), "utf8")).split(/\r?\n/u)[0],
  );
  const server = `postgres://opensteer@127.0.0.1:${port}`;
  const administrator = createDatabase({
    connectionString: `${server}/postgres`,
    maxConnections: 1,
  });
  try {
    await administrator.executeQuery(CompiledQuery.raw("create database opensteer"));
  } finally {
    await administrator.destroy();
  }
  return { postgres, postmaster, url: `${server}/opensteer` };
}

const tsx = ["--import", "tsx"] as const;

interface Stack {
  readonly root: string;
  readonly database: string;
  readonly agentHome: string;
  readonly home: string;
  readonly temporary: string;
  readonly path: string;
  readonly port: number;
  readonly claim: string;
  readonly authSecret: string;
  readonly environmentId: EnvironmentId;
}

function startHost(stack: Stack, log: string): Service {
  return supervise("host", [process.execPath, ...tsx, join(repository, "apps/host/src/main.ts")], {
    cwd: join(repository, "apps/host"),
    environment: environment({
      OPENSTEER_MODE: "development",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_DATABASE_URL: stack.database,
      OPENSTEER_AUTH_SECRET: stack.authSecret,
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: stack.claim,
      OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
      OPENSTEER_HOST_DATA_DIR: join(stack.root, "host"),
      OPENSTEER_PORT: String(stack.port),
      OPENSTEER_BIND_ADDRESS: "127.0.0.1",
      OPENSTEER_CANONICAL_ORIGIN: `http://127.0.0.1:${stack.port}`,
      OPENSTEER_HOSTING_ENVIRONMENT_ID: stack.environmentId,
      OPENSTEER_AGENT_HOME: stack.agentHome,
      OPENSTEER_NATIVE_FS_HELPER: nativeFsHelper,
    }),
    log,
  });
}

function startRunner(stack: Stack, log: string, enrollmentToken: string | null): Service {
  return supervise(
    "runner",
    [process.execPath, ...tsx, join(repository, "apps/runner/src/main.ts")],
    {
      cwd: join(repository, "apps/runner"),
      environment: environment({
        // The person's own engine CLIs come from their PATH, and their sign-ins from their home.
        HOME: stack.home,
        USERPROFILE: stack.home,
        // Its attachment cache lives in its home and must not be inside its temporary folder.
        TEMP: stack.temporary,
        TMP: stack.temporary,
        TMPDIR: stack.temporary,
        PATH: stack.path,
        OPENSTEER_MODE: "development",
        OPENSTEER_DEPLOYMENT_KIND: "personal",
        OPENSTEER_HOST_URL: `http://127.0.0.1:${stack.port}`,
        OPENSTEER_ENVIRONMENT_ID: stack.environmentId,
        OPENSTEER_RUNNER_NAME: "Windows acceptance",
        OPENSTEER_RUNNER_DATA_DIR: join(stack.root, "runner"),
        OPENSTEER_RUNNER_MODULES: "agents",
        OPENSTEER_MAX_CONCURRENT_RUNS: "2",
        OPENSTEER_NATIVE_FS_HELPER: nativeFsHelper,
        ...(enrollmentToken ? { OPENSTEER_RUNNER_ENROLLMENT_TOKEN: enrollmentToken } : {}),
      }),
      log,
    },
  );
}

const nativeFsHelper = join(
  repository,
  "apps/runner/native-fs-helper",
  windows ? "opensteer-native-fs.exe" : "opensteer-native-fs",
);

async function localBootstrap(stack: Stack) {
  const response = await fetch(`http://127.0.0.1:${stack.port}/v1/local-bootstrap`, {
    headers: { accept: "application/json", authorization: `Bearer ${stack.claim}` },
  });
  if (!response.ok) throw new Error(`Local bootstrap failed (${response.status})`);
  return (await response.json()) as { readonly runnerEnrollmentToken: string | null };
}

async function signIn(stack: Stack): Promise<Record<string, string>> {
  const origin = `http://127.0.0.1:${stack.port}`;
  const response = await fetch(`${origin}/v1/rpc/auth.setup.claim`, {
    body: JSON.stringify({ kind: "local-machine-owner", token: stack.claim }),
    headers: {
      "content-type": "application/json",
      origin,
      [hostApiVersionHeader]: String(hostApiVersion),
    },
    method: "POST",
  });
  if (!response.ok)
    throw new Error(`Owner claim failed (${response.status}): ${await response.text()}`);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  return { cookie, origin, [hostApiVersionHeader]: String(hostApiVersion) };
}

const listening = (line: string) => line.includes("Opensteer Host listening");

describe("the personal stack from source", () => {
  it("serves engines, a task, an app and an automation, and keeps them across a restart", async () => {
    if (!postgresBin)
      throw new Error("OPENSTEER_TEST_POSTGRES_BIN must name PostgreSQL's bin folder");
    const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-stack-")));
    temporary.push(root);
    // Every task works in Agent home; a person's folder may hold a space and any letter.
    const agentHome = join(root, "Agent home ü");
    const appFolder = join(agentHome, "server app");
    const home = join(root, "home");
    const runnerTemporary = join(root, "tmp");
    for (const directory of [appFolder, home, runnerTemporary])
      await mkdir(directory, { recursive: true });
    const pids = new Map<string, number>();
    const { postgres, postmaster, url } = await startPostgres(root);
    pids.set("postgres", postmaster);
    pids.set("postgres supervisor", postgres.process.child.pid!);

    const codexCapture = join(root, "codex-capture.jsonl");
    const bin = await installCli(
      join(root, "global"),
      "codex",
      join(repository, "packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs"),
      ["--scenario=notifications", `--capture=${codexCapture}`],
    );
    await writeFile(join(appFolder, "server.cjs"), appServerSource);
    await writeFile(join(appFolder, "index.html"), "<!doctype html><title>Stopped</title>");
    const stack: Stack = {
      agentHome,
      authSecret: randomBytes(48).toString("base64url"),
      claim: randomBytes(32).toString("base64url"),
      database: url,
      environmentId: createId("environment"),
      home,
      // Only the fake engine's shim, Node and the system: CLIs installed here stay out.
      path: (windows
        ? [bin, dirname(process.execPath), join(systemRoot, "System32"), systemRoot]
        : [bin, dirname(process.execPath), "/usr/bin", "/bin"]
      ).join(delimiter),
      port: await freePort(),
      root,
      temporary: runnerTemporary,
    };
    // Codex's quoted `-c key="value"` arguments pass only through a generated shim.
    const codex = resolveCommand("codex", {
      cwd: root,
      environment: { PATH: stack.path, PATHEXT: process.env.PATHEXT },
      platform: hostCommandPlatform(),
    });
    expect(codex).toEqual({
      kind: windows ? "batch-shim" : "native",
      path: join(bin, windows ? "codex.cmd" : "codex"),
    });
    const origin = `http://127.0.0.1:${stack.port}`;

    let host = startHost(stack, join(root, "host.log"));
    pids.set("host", hostPid(await host.waitFor("listened", listening, 120_000)));
    pids.set("host supervisor", host.process.child.pid!);
    const bootstrap = await localBootstrap(stack);
    expect(
      bootstrap.runnerEnrollmentToken,
      "the Host offered its Main Runner no enrollment",
    ).toEqual(expect.any(String));
    const headers = await signIn(stack);
    const rpc = <Name extends Parameters<typeof testRpcData>[1]>(
      name: Name,
      input: Parameters<typeof testRpcData<Name>>[2],
    ) => testRpcData(origin, name, input, { headers });
    const dispatch = async (command: Parameters<typeof testRpcData<"commands.dispatch">>[2]) =>
      rpc("commands.dispatch", command);

    let runner = startRunner(stack, join(root, "runner.log"), bootstrap.runnerEnrollmentToken);
    pids.set("runner supervisor", runner.process.child.pid!);
    const runnerId = runnerOf(await runner.waitFor("connected", connected, 120_000));

    // The person's own Codex is found on PATH as a package manager's shim, launched
    // through it, read for its version and signed in on its default account.
    const engines = await vi.waitFor(
      async () => {
        const view = await rpc("bootstrap.get", {});
        const computer = view.environments.find((value) => value.id === stack.environmentId);
        const driver = computer?.harnessDrivers.find((value) => value.driverKind === "codex");
        const account = view.harnesses.find(
          (value) => value.driverKind === "codex" && value.stateKind === "ambient",
        );
        const catalog = computer?.harnessCatalogs.find(
          (value) => value.harnessInstanceId === account?.id,
        );
        if (!driver || driver.readiness === "unavailable" || !driver.installation?.version)
          throw new Error(`Codex on PATH was never inspected: ${JSON.stringify(driver)}`);
        if (catalog?.status !== "ready" || !catalog.models[0])
          throw new Error(`The Codex account never became ready: ${JSON.stringify(catalog)}`);
        return { account: account!, driver, model: catalog.models[0] };
      },
      { interval: 250, timeout: 60_000 },
    );
    expect(engines.driver.installation).toMatchObject({ scope: "ambient", update: "manual" });
    expect(await enginePids(codexCapture), `${codex!.path} never served the Runner`).not.toEqual(
      [],
    );

    // One task, full access so its agent may serve an app from Agent home.
    const created = await dispatch({
      accessMode: "full-access",
      environmentId: stack.environmentId,
      harnessInstanceId: HarnessInstanceIdSchema.parse(engines.account.id),
      idempotencyKey: randomUUID(),
      modelSelection: {
        modelId: engines.model.modelId,
        options: {},
        providerId: engines.model.providerId,
      },
      title: "Windows acceptance",
      type: "thread.create",
    });
    if (created.type !== "thread.create") throw new Error("thread.create returned another receipt");
    const threadId = created.thread.id;
    const turn = async (text: string, reply: string) => {
      const sent = await dispatch({
        content: [{ text, type: "text" }],
        delivery: "queue",
        idempotencyKey: randomUUID(),
        threadId,
        type: "thread.sendMessage",
      });
      if (sent.type !== "thread.sendMessage")
        throw new Error("thread.sendMessage returned another receipt");
      return vi.waitFor(
        async () => {
          const { messages } = await rpc("thread.messages.list", { limit: 100, threadId });
          const answered = messages.find(
            (message) => message.kind === "assistant" && textOf(message).includes(reply),
          );
          if (!answered)
            throw new Error(
              `The turn never answered "${reply}": ${JSON.stringify(messages.map(textOf))}`,
            );
          return messages;
        },
        { interval: 250, timeout: 60_000 },
      );
    };
    const start = windows
      ? `set "GREETING=hello from cmd" && node server.cjs`
      : `export GREETING="hello from cmd" && node server.cjs`;
    await turn(
      `${toolCall("app_publish", { path: "server app", start, title: "Greeting" })} [[reply Published.]]`,
      "Published.",
    );
    const { events } = await rpc("thread.events.list", { threadId });
    const published = events.find((event) => event.type === "app.published");
    if (published?.type !== "app.published") throw new Error("The task never published its app");
    const appId = published.data.appId;

    // The app is reached through the Host, which tunnels to the Runner's loopback server.
    const view = await rpc("apps.view", { appId, theme: "light" });
    const served = (await (await fetch(new URL(view.path, origin))).json()) as {
      readonly child: number;
      readonly cwd: string;
      readonly greeting: string;
      readonly pid: number;
    };
    expect(served).toMatchObject({ cwd: appFolder, greeting: "hello from cmd" });
    pids.set("app server", served.pid);
    pids.set("app server child", served.child);

    // A program automation runs on the Runner and returns its result to the Host.
    const trigger = await dispatch({
      idempotencyKey: randomUUID(),
      input: {
        anchorThreadId: threadId,
        name: "Doubler",
        program: { language: "typescript", source: automationSource, toolContractVersion: 3 },
        source: { kind: "webhook" },
      },
      type: "trigger.create",
    });
    if (trigger.type !== "trigger.create")
      throw new Error("trigger.create returned another receipt");
    const triggerId = trigger.trigger.id;
    await dispatch({
      idempotencyKey: randomUUID(),
      payload: { n: 21 },
      triggerId,
      type: "trigger.run",
    });
    const occurrence = await vi.waitFor(
      async () => {
        const read = await rpc("triggers.get", { triggerId });
        const [latest] = read.occurrences;
        if (latest?.status !== "succeeded")
          throw new Error(`The automation never succeeded: ${JSON.stringify(latest)}`);
        return latest;
      },
      { interval: 250, timeout: 60_000 },
    );
    const result = occurrence.result as { readonly doubled: number; readonly pid: number };
    expect(result.doubled).toBe(42);
    pids.set("automation", result.pid);

    // Publishing a page in its place stops the server and everything it started.
    await turn(
      `${toolCall("app_publish", { appId, path: "server app/index.html", title: "Greeting" })} [[reply Replaced.]]`,
      "Replaced.",
    );
    await vi.waitFor(
      () => {
        for (const name of ["app server", "app server child"] as const)
          if (alive(pids.get(name)!)) throw new Error(`The ${name} outlived its app`);
      },
      { interval: 100, timeout: 15_000 },
    );

    // A graceful stop reaches each service, which exits cleanly under its supervisor.
    await stopGracefully(runner);
    await stopGracefully(host);
    expect(host.lines.find((line) => line.includes("Opensteer Host shutting down"))).toContain(
      windows ? '"signal":"SIGBREAK"' : '"signal":"SIGTERM"',
    );
    for (const pid of await enginePids(codexCapture))
      expect(alive(pid), `engine ${pid} outlived its Runner`).toBe(false);

    host = startHost(stack, join(root, "host.log"));
    pids.set("restarted host", hostPid(await host.waitFor("listened again", listening, 120_000)));
    pids.set("restarted host supervisor", host.process.child.pid!);
    // Like `pnpm dev`, the Runner is handed whatever the Host offers; it keeps its identity.
    runner = startRunner(
      stack,
      join(root, "runner.log"),
      (await localBootstrap(stack)).runnerEnrollmentToken,
    );
    pids.set("restarted runner supervisor", runner.process.child.pid!);
    expect(runnerOf(await runner.waitFor("reconnected", connected, 120_000))).toBe(runnerId);

    // The person's session, the task's conversation and the automation's result persisted.
    const { messages } = await rpc("thread.messages.list", { limit: 100, threadId });
    expect(messages.map(textOf)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Published."),
        expect.stringContaining("Replaced."),
      ]),
    );
    const { tasks } = await rpc("tasks.list", {});
    expect(tasks.map((task) => task.thread.id)).toContain(threadId);
    expect((await rpc("triggers.get", { triggerId })).occurrences[0]).toMatchObject({
      result: { doubled: 42 },
      status: "succeeded",
    });
    // And the task goes on, through the engine the restarted Runner launches again.
    await turn("[[reply Still here.]]", "Still here.");

    await stopGracefully(runner);
    await stopGracefully(host);
    await stopGracefully(postgres);
    for (const pid of await enginePids(codexCapture)) pids.set(`engine ${pid}`, pid);
    for (const [name, pid] of pids) expect(alive(pid), `${name} (pid ${pid}) survived`).toBe(false);
  }, 600_000);
});

const connected = (line: string) => line.includes("Runner connected to Host");

function runnerOf(line: string): string {
  return z.object({ runnerId: z.string().min(1) }).parse(JSON.parse(line)).runnerId;
}

function hostPid(line: string): number {
  return z.object({ pid: z.number().int().positive() }).parse(JSON.parse(line)).pid;
}

async function stopGracefully(service: Service): Promise<void> {
  expect(
    await service.stop(30_000),
    `${service.name} did not stop cleanly:\n${service.lines.slice(-20).join("\n")}`,
  ).toEqual({
    code: 0,
    signal: null,
  });
}

function textOf(message: { readonly content: readonly { readonly type: string }[] }): string {
  return message.content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

/** What the fake agent reads as one Opensteer tool call. */
function toolCall(name: string, input: unknown): string {
  return `[[call ${name} ${Buffer.from(JSON.stringify(input)).toString("base64url")}]]`;
}

/** Every fake engine process the shim started, as the fake recorded itself. */
async function enginePids(capture: string): Promise<number[]> {
  const record = z.object({ fakeCodexProcess: z.object({ pid: z.number() }).optional() });
  return (await readFile(capture, "utf8"))
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => record.parse(JSON.parse(line)).fakeCodexProcess?.pid ?? []);
}

/** Serves its own identity and a long-lived child, so the test can prove both stop. */
const appServerSource = `
const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:http").createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ child: child.pid, cwd: process.cwd(), greeting: process.env.GREETING, pid: process.pid }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const automationSource = `export default function ({ event }: { event: { payload: { n: number } } }) {
  return { doubled: event.payload.n * 2, pid: process.pid };
}`;

/**
 * A person's global CLI as npm installs it: the shim npm generates on Windows,
 * a link elsewhere, to a package script that runs `script` with `args`.
 */
async function installCli(prefix: string, name: string, script: string, args: readonly string[]) {
  const bin = join(prefix, "node_modules", ".bin");
  // The package script the generated shim names.
  const entry = join(prefix, "node_modules", "echo-argv", "bin", "echo-argv.js");
  await mkdir(bin, { recursive: true });
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(
    entry,
    `#!/usr/bin/env node\nprocess.argv.push(...${JSON.stringify(args)});\nimport(${JSON.stringify(pathToFileURL(script).href)});\n`,
    { mode: 0o755 },
  );
  if (windows) await writeFile(join(bin, `${name}.cmd`), generatedShims.npm.node);
  else await symlink(join("..", "echo-argv", "bin", "echo-argv.js"), join(bin, name));
  return bin;
}
