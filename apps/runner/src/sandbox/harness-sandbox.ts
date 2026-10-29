import {
  spawnSupervised,
  type HarnessProcessLaunch,
  type HarnessProcessLaunchWrapper,
  type HarnessProviderState,
  type HarnessRuntimeBoundary,
} from "@opensteer/harness";
import { safeMessage } from "@opensteer/shared/safeMessage";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * The Runner-owned tenant boundary around a Run's harness process tree.
 *
 * An isolated-service Runner executes work for every user of a Deployment, and
 * its data directory holds what none of them may read: the Runner's identity
 * key, its shell host key, Workspace mount credentials, and every profile's
 * provider state. Each harness also sandboxes the commands the model runs, but
 * that sandbox is the vendor's and protects the harness's own credentials from
 * the model; the boundary between tenants and the Runner is the Runner's to
 * enforce, with code it controls and can test without any vendor binary.
 *
 * Linux provides that boundary as mount and pid namespaces through bubblewrap,
 * which the Runner image ships. The harness sees the whole filesystem as it is,
 * except that the data directory is an empty tmpfs with only this profile's
 * home, its session store, and this Thread's Runner-supplied directories bound
 * back in, and /tmp is private to the Run with the machine-access launch
 * directory bound at its real path. The harness's own per-command sandbox nests
 * inside (both Codex and Claude create their own user namespaces there).
 * Networking is shared: the harness reaches the model provider, the Host, and
 * the browser relay over it.
 *
 * macOS cannot nest Seatbelt profiles, so wrapping the harness there would
 * disable the harness's own command sandbox; on macOS and Windows an
 * isolated-service Runner relies on that sandbox alone, which denies the whole
 * data directory. This class therefore exists exactly on isolated-service
 * Linux Runners, and such a Runner refuses to start when it cannot prove the
 * sandbox works.
 */
export function harnessSandboxRequired(
  platform: NodeJS.Platform,
  runtimeBoundary: HarnessRuntimeBoundary,
): boolean {
  return platform === "linux" && runtimeBoundary.kind === "isolated-service";
}

export interface HarnessSandboxOptions {
  readonly attachmentRoot?: string;
  /** Resolved through PATH like any executable; the Runner image installs it at /usr/local/bin. */
  readonly bubblewrapExecutable?: string;
  readonly dataDirectory: string;
  /** The Runner's own environment: HOME, TMPDIR, and PATH shape the boot proof. */
  readonly environment: Readonly<Record<string, string>>;
  /** Where harness profiles live under the data directory; the boot proof stages its fixture there. */
  readonly stateDirectory: string;
  /**
   * Every Workspace backing root this Runner shares between users (the
   * PortableFS root; the local-directory root when it is owner-scoped). Other
   * users' Workspaces live under them, so they are masked like the data
   * directory and only this Run's roots are re-exposed. A single-owner root is
   * one person's and is not listed.
   */
  readonly workspaceRoots: readonly string[];
}

/** Everything one Run's harness process tree must reach beyond the filesystem it inherits. */
export interface HarnessSandboxRunPlan {
  readonly attachmentDirectory?: string;
  /** The environment the harness process will receive; HOME and TMPDIR shape the mounts. */
  readonly environment: Readonly<Record<string, string>>;
  /** Absent when this Run has no machine access. */
  readonly launchDirectory: string | undefined;
  /** Absent when no integration skills were materialized for this Thread. */
  readonly integrationSkillsDirectory: string | undefined;
  readonly providerState: HarnessProviderState;
  readonly threadStateDirectory: string;
  readonly workspacePath: string;
  readonly writableRoots: readonly string[];
}

/**
 * One Trigger or Watch program: its Workspace, and the Runner-private files
 * that hold its runtime, event and capabilities, which it may read.
 */
export interface ProgramSandboxPlan {
  readonly environment: Readonly<Record<string, string>>;
  readonly privateDirectory: string;
  readonly workspacePath: string;
}

export interface HarnessProcessSandbox {
  plan(run: HarnessSandboxRunPlan): Promise<HarnessProcessLaunchWrapper>;
  planProgram(program: ProgramSandboxPlan): Promise<HarnessProcessLaunchWrapper>;
}

export interface HarnessSandboxLayout {
  readonly attachmentRoot?: string;
  /** Canonical (realpath) Runner data directory. */
  readonly dataDirectory: string;
  /**
   * Whether a fresh procfs is mounted for the pid namespace. Some container
   * runtimes mask paths under /proc and then refuse a new procfs mount from an
   * unprivileged user namespace; the sandbox then inherits the container's
   * /proc, exactly as Codex's own sandbox does after the same preflight.
   */
  readonly freshProc: boolean;
  /** Canonical system temporary directory. */
  readonly temporaryDirectory: string;
  /** Canonical Workspace backing roots; those that exist on this machine. */
  readonly workspaceRoots: readonly string[];
}

/**
 * The bubblewrap arguments for one Run, before `--chdir` and the command.
 *
 * The filesystem is inherited read-only. Every place that must not leak
 * between Runs becomes an empty private directory first, ancestors before
 * descendants so no later mask can hide an earlier one: the Runner data
 * directory, every shared Workspace backing root, the home directory, and the
 * temporary directories. Only then does the Run get back exactly what is its
 * own: this profile's home and store, this Thread's Runner-supplied
 * directories, this Run's Workspace roots, and its machine-access launch
 * directory at its real path, because the generated ssh configuration names
 * it.
 */
export async function harnessSandboxMounts(
  layout: HarnessSandboxLayout,
  run: HarnessSandboxRunPlan,
  environment: Readonly<Record<string, string>>,
): Promise<readonly string[]> {
  const providerHome = run.providerState.providerHomeDirectory;
  if (!providerHome) {
    throw new Error("An isolated-service Runner sandboxes only isolated harness profiles");
  }
  return sandboxMounts(layout, environment, {
    ...(run.attachmentDirectory ? { attachmentDirectory: run.attachmentDirectory } : {}),
    launchDirectory: run.launchDirectory,
    privateDirectories: [
      { mode: "--bind", path: providerHome },
      { mode: "--bind", path: run.providerState.store.directory },
      { mode: "--ro-bind", path: run.threadStateDirectory },
      ...(run.integrationSkillsDirectory
        ? [{ mode: "--ro-bind" as const, path: run.integrationSkillsDirectory }]
        : []),
    ],
    workspaceRoots: [run.workspacePath, ...run.writableRoots],
  });
}

/** The bubblewrap arguments for one program, under the same masks as a Run. */
export async function programSandboxMounts(
  layout: HarnessSandboxLayout,
  program: ProgramSandboxPlan,
): Promise<readonly string[]> {
  return sandboxMounts(layout, program.environment, {
    launchDirectory: undefined,
    privateDirectories: [{ mode: "--ro-bind", path: program.privateDirectory }],
    workspaceRoots: [program.workspacePath],
  });
}

async function sandboxMounts(
  layout: HarnessSandboxLayout,
  environment: Readonly<Record<string, string>>,
  run: {
    readonly attachmentDirectory?: string;
    readonly launchDirectory: string | undefined;
    /** Runner-private directories the process gets back, each under the data directory. */
    readonly privateDirectories: readonly {
      readonly mode: "--bind" | "--ro-bind";
      readonly path: string;
    }[];
    readonly workspaceRoots: readonly string[];
  },
): Promise<readonly string[]> {
  const home = privateHome(environment);
  const masks = orderedMasks([
    { mode: "0700", path: layout.dataDirectory },
    ...(layout.attachmentRoot ? [{ mode: "0700", path: layout.attachmentRoot }] : []),
    ...layout.workspaceRoots.map((path) => ({ mode: "0700", path })),
    { mode: "0700", path: home },
    { mode: "1777", path: layout.temporaryDirectory },
    { mode: "1777", path: "/tmp" },
  ]);
  const maskedRoots = masks.map((mask) => mask.path);
  const args: string[] = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    ...(layout.freshProc ? ["--proc", "/proc"] : ["--bind", "/proc", "/proc"]),
    ...masks.flatMap((mask) => ["--perms", mask.mode, "--tmpfs", mask.path]),
  ];
  const configuredTemporary = environment.TMPDIR;
  if (configuredTemporary && isAbsolute(configuredTemporary)) {
    args.push("--dir", resolve(configuredTemporary));
  }

  const exposed = new Set<string>();
  const expose = (mode: "--bind" | "--ro-bind", canonical: string) => {
    if (exposed.has(canonical)) return;
    for (const root of maskedRoots) {
      if (pathContains(canonical, root)) {
        throw new Error(`The Runner sandbox will not expose ${canonical} over ${root}`);
      }
    }
    exposed.add(canonical);
    args.push(mode, canonical, canonical);
  };
  const runnerPrivate = async (path: string) => {
    const canonical = await canonicalPath(path);
    if (!pathContains(layout.dataDirectory, canonical)) {
      throw new Error(`Runner-private path ${path} is outside the Runner data directory`);
    }
    return canonical;
  };
  for (const { mode, path } of run.privateDirectories) expose(mode, await runnerPrivate(path));
  if (run.attachmentDirectory) {
    if (!layout.attachmentRoot) throw new Error("Attachment cache root is not sandboxed");
    const canonical = await canonicalPath(run.attachmentDirectory);
    if (canonical === layout.attachmentRoot || !pathContains(layout.attachmentRoot, canonical)) {
      throw new Error("Attachment directory is outside the shared cache root");
    }
    expose("--ro-bind", canonical);
  }
  if (run.launchDirectory) expose("--bind", await canonicalPath(run.launchDirectory));

  // A certificate bundle the harness must trust may live under a masked root.
  // Only a regular file comes back, at its real path and at the path the
  // environment names when that is a symlink into it.
  const bundle = environment.NODE_EXTRA_CA_CERTS;
  if (bundle && isAbsolute(bundle)) {
    const canonical = await canonicalPath(bundle);
    const details = await stat(canonical);
    if (!details.isFile()) {
      throw new Error(`NODE_EXTRA_CA_CERTS must name a file, not ${bundle}`);
    }
    if (maskedRoots.some((root) => pathContains(root, canonical)) && !exposed.has(canonical)) {
      exposed.add(canonical);
      args.push("--ro-bind", canonical, canonical);
      const named = resolve(bundle);
      if (named !== canonical && maskedRoots.some((root) => pathContains(root, named))) {
        args.push("--ro-bind", canonical, named);
      }
    }
  }

  for (const root of run.workspaceRoots) {
    const canonical = await canonicalPath(root);
    if (exposed.has(canonical)) continue;
    // A Workspace lives under a declared backing root or wholly outside the
    // data directory; anything else would re-expose Runner-private state.
    const under = layout.workspaceRoots.find(
      (workspaceRoot) => pathContains(workspaceRoot, canonical) && canonical !== workspaceRoot,
    );
    if (!under && pathContains(layout.dataDirectory, canonical)) {
      throw new Error(
        `Workspace ${root} overlaps the Runner data directory ${layout.dataDirectory}`,
      );
    }
    expose("--bind", canonical);
  }

  args.push(...privateNamespaces(layout.freshProc));
  return args;
}

/**
 * The home the harness would otherwise reach: `$HOME`, or the OS account's
 * home when the environment does not say. A home that cannot be masked as a
 * directory of its own is refused rather than left readable.
 */
function privateHome(environment: Readonly<Record<string, string>>): string {
  const home = environment.HOME ?? homedir();
  if (!isAbsolute(home) || resolve(home) === "/") {
    throw new Error(`The Runner sandbox cannot make ${home} a private home directory`);
  }
  return resolve(home);
}

interface Mask {
  readonly mode: string;
  readonly path: string;
}

/**
 * Each path once, ancestors first, so a descendant mask lands inside its
 * ancestor's tmpfs. Depth is a total order that puts every ancestor before
 * every descendant; ties are broken lexically so the plan is deterministic.
 */
function orderedMasks(masks: readonly Mask[]): readonly Mask[] {
  const byPath = new Map<string, Mask>();
  for (const mask of masks) if (!byPath.has(mask.path)) byPath.set(mask.path, mask);
  const depth = (path: string) => path.split("/").filter(Boolean).length;
  return [...byPath.values()].sort(
    (left, right) => depth(left.path) - depth(right.path) || left.path.localeCompare(right.path),
  );
}

const procMountRefusal = "Can't mount proc";

/**
 * A fresh user namespace is what lets the harness's own sandbox nest inside;
 * `--die-with-parent` ends the tree if the Runner dies without signalling it.
 * A pid namespace is only coherent with a procfs of its own: without one,
 * `/proc/self` would name nothing and a nested sandbox could not set itself
 * up, so the container's pid namespace is kept and its /proc bound writable.
 */
function privateNamespaces(freshProc: boolean): readonly string[] {
  return [
    "--unshare-user",
    ...(freshProc ? ["--unshare-pid"] : []),
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--die-with-parent",
  ];
}

const selfTestTimeoutMs = 15_000;

export class HarnessSandbox implements HarnessProcessSandbox {
  readonly #bubblewrap: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #layout: HarnessSandboxLayout;

  private constructor(options: {
    readonly bubblewrap: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly layout: HarnessSandboxLayout;
  }) {
    this.#bubblewrap = options.bubblewrap;
    this.#environment = options.environment;
    this.#layout = options.layout;
  }

  /**
   * Builds the sandbox and proves it on this machine with the same plan a Run
   * gets: a command inside must see nothing of the data directory but a staged
   * profile, must read that profile's home, and must write a bound Workspace
   * and launch directory. Launchability alone would prove nothing about
   * confinement.
   */
  static async create(options: HarnessSandboxOptions): Promise<HarnessSandbox> {
    if (options.attachmentRoot)
      await mkdir(options.attachmentRoot, { mode: 0o700, recursive: true });
    const workspaceRoots: string[] = [];
    for (const root of options.workspaceRoots) {
      // A declared backing root is the Runner's to hold; one that does not
      // exist yet is created now so it can be masked from the first Run on.
      await mkdir(root, { mode: 0o700, recursive: true });
      workspaceRoots.push(await realpath(root));
    }
    const bubblewrap = options.bubblewrapExecutable ?? "bwrap";
    const layout = {
      ...(options.attachmentRoot ? { attachmentRoot: await realpath(options.attachmentRoot) } : {}),
      dataDirectory: await realpath(options.dataDirectory),
      freshProc: await freshProcSupported(bubblewrap, options.environment),
      temporaryDirectory: await realpath(tmpdir()),
      workspaceRoots,
    };
    const sandbox = new HarnessSandbox({ bubblewrap, environment: options.environment, layout });
    await sandbox.#selfTest(options.stateDirectory);
    return sandbox;
  }

  /** What the boot proof established; reported once so an operator can see it. */
  get layout(): HarnessSandboxLayout {
    return this.#layout;
  }

  /**
   * The launch wrapper for one Run. The mounts follow the environment the
   * Runner assembled for the harness (HOME and TMPDIR become private
   * directories; a certificate bundle under a masked root is exposed), and the
   * wrapper refuses a launch whose HOME or TMPDIR differ from that plan.
   */
  async plan(run: HarnessSandboxRunPlan): Promise<HarnessProcessLaunchWrapper> {
    return this.#wrapper(await harnessSandboxMounts(this.#layout, run, run.environment), run);
  }

  /**
   * A Trigger or Watch program runs arbitrary code a Workspace member wrote, so
   * on a shared Runner it gets the same confinement as an engine: its own
   * Workspace, its own private files read-only, and nothing of other Runs.
   */
  async planProgram(program: ProgramSandboxPlan): Promise<HarnessProcessLaunchWrapper> {
    return this.#wrapper(await programSandboxMounts(this.#layout, program), program);
  }

  #wrapper(
    mounts: readonly string[],
    planned: { readonly environment: Readonly<Record<string, string>> },
  ): HarnessProcessLaunchWrapper {
    const bubblewrap = this.#bubblewrap;
    return (launch: HarnessProcessLaunch): HarnessProcessLaunch => {
      for (const name of ["HOME", "TMPDIR"]) {
        if (launch.environment[name] !== planned.environment[name]) {
          throw new Error(`The launch changed ${name} after the sandbox was planned`);
        }
      }
      return {
        args: [...mounts, "--chdir", launch.cwd, "--", launch.executable, ...launch.args],
        cwd: launch.cwd,
        environment: launch.environment,
        executable: bubblewrap,
      };
    };
  }

  async #selfTest(stateDirectory: string): Promise<void> {
    await mkdir(stateDirectory, { mode: 0o700, recursive: true });
    const fixture = await mkdtemp(join(stateDirectory, "sandbox-proof-"));
    const workspace = await mkdtemp(join(this.#layout.temporaryDirectory, "opensteer-sandbox-"));
    const launchDirectory = await mkdtemp(join(this.#layout.temporaryDirectory, "opensteer-"));
    const ownAttachmentDirectory = this.#layout.attachmentRoot
      ? await mkdtemp(join(this.#layout.attachmentRoot, "sandbox-own-"))
      : undefined;
    const otherAttachmentDirectory = this.#layout.attachmentRoot
      ? await mkdtemp(join(this.#layout.attachmentRoot, "sandbox-other-"))
      : undefined;
    try {
      const providerHome = join(fixture, "provider-home");
      const store = join(fixture, "store");
      const threadState = join(fixture, "thread");
      for (const directory of [providerHome, store, threadState]) {
        await mkdir(directory, { mode: 0o700 });
      }
      await writeFile(join(providerHome, "proof"), "own-profile\n", { mode: 0o600 });
      await writeFile(join(this.#layout.dataDirectory, ".sandbox-proof"), "runner-private\n", {
        mode: 0o600,
      });
      if (ownAttachmentDirectory) await writeFile(join(ownAttachmentDirectory, "proof"), "own\n");
      if (otherAttachmentDirectory)
        await writeFile(join(otherAttachmentDirectory, "proof"), "other\n");
      const wrapper = await this.plan({
        ...(ownAttachmentDirectory ? { attachmentDirectory: ownAttachmentDirectory } : {}),
        environment: this.#environment,
        integrationSkillsDirectory: undefined,
        launchDirectory,
        providerState: {
          continuationKey: "sandbox-proof",
          kind: "isolated",
          privateStateRoot: this.#layout.dataDirectory,
          providerHomeDirectory: providerHome,
          store: { directory: store, id: "sandbox-proof" },
        },
        threadStateDirectory: threadState,
        workspacePath: workspace,
        writableRoots: [],
      });
      // The private tmp holds exactly the two directories bound into it: the
      // proof's Workspace and its launch directory.
      const script = [
        'test ! -e "$1/.sandbox-proof"',
        'test "$(cat "$2/proof")" = own-profile',
        'printf ok > "$3/written-inside"',
        'printf ok > "$4/written-inside"',
        'test -z "$(ls -A "$5" | grep -v -e "^$(basename "$3")$" -e "^$(basename "$4")$")"',
        // A runtime that cannot mount a fresh procfs may keep the container's
        // pid namespace only when procfs itself still hides the Runner. Without
        // this proof, a same-uid harness could read the Runner's credentials
        // from its environment even though the filesystem mounts are private.
        'test ! -e "$6/exe" || test "$(readlink "$6/exe")" != "$7"',
        ...(ownAttachmentDirectory && otherAttachmentDirectory
          ? [
              'test "$(cat "$8/proof")" = own',
              'test ! -e "$9/proof"',
              '! (printf bad > "$8/write-attempt" 2>/dev/null)',
            ]
          : []),
      ].join(" && ");
      const command = wrapper({
        args: [
          "-c",
          script,
          "opensteer-sandbox-proof",
          this.#layout.dataDirectory,
          providerHome,
          workspace,
          launchDirectory,
          this.#layout.temporaryDirectory,
          `/proc/${String(process.pid)}`,
          process.execPath,
          ...(ownAttachmentDirectory && otherAttachmentDirectory
            ? [ownAttachmentDirectory, otherAttachmentDirectory]
            : []),
        ],
        cwd: workspace,
        environment: this.#environment,
        executable: "/bin/sh",
      });
      const supervised = spawnSupervised({
        args: command.args,
        cwd: command.cwd,
        environment: command.environment,
        executable: command.executable,
        signal: AbortSignal.timeout(selfTestTimeoutMs),
      });
      supervised.child.stdin?.end();
      const [stderr, exit] = await Promise.all([
        collectOutput(supervised.stderr),
        supervised.exited.catch((error: unknown) => {
          throw new Error(
            `The Runner sandbox could not start: ${safeMessage(error, { fallback: "bubblewrap did not start", singleLine: true })}`,
          );
        }),
      ]);
      if (exit.code !== 0) {
        throw new Error(
          `The Runner sandbox did not confine a test command (exit ${String(exit.code ?? exit.signal)}${
            stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""
          })`,
        );
      }
      for (const written of [
        join(workspace, "written-inside"),
        join(launchDirectory, "written-inside"),
      ]) {
        await stat(written).catch(() => {
          throw new Error("The Runner sandbox did not let a test command write a bound directory");
        });
      }
    } finally {
      if (ownAttachmentDirectory)
        await rm(ownAttachmentDirectory, { force: true, recursive: true });
      if (otherAttachmentDirectory)
        await rm(otherAttachmentDirectory, { force: true, recursive: true });
      await rm(join(this.#layout.dataDirectory, ".sandbox-proof"), { force: true });
      await rm(fixture, { force: true, recursive: true });
      await rm(workspace, { force: true, recursive: true });
      await rm(launchDirectory, { force: true, recursive: true });
    }
  }
}

/**
 * The same preflight Codex's Linux sandbox performs: a fresh procfs is the
 * secure default, and a runtime that refuses it is detected once at boot
 * rather than on every Run.
 */
async function freshProcSupported(
  bubblewrap: string,
  environment: Readonly<Record<string, string>>,
): Promise<boolean> {
  const supervised = spawnSupervised({
    args: [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      ...privateNamespaces(true),
      "--",
      "/bin/true",
    ],
    cwd: "/",
    environment,
    executable: bubblewrap,
    signal: AbortSignal.timeout(selfTestTimeoutMs),
  });
  supervised.child.stdin?.end();
  const [stderr, exit] = await Promise.all([
    collectOutput(supervised.stderr),
    supervised.exited.catch((error: unknown) => {
      throw new Error(
        `The Runner sandbox could not start: ${safeMessage(error, { fallback: "bubblewrap did not start", singleLine: true })}`,
      );
    }),
  ]);
  if (exit.code === 0) return true;
  if (stderr.includes(procMountRefusal)) return false;
  throw new Error(
    `The Runner sandbox could not start (exit ${String(exit.code ?? exit.signal)}${
      stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""
    })`,
  );
}

async function collectOutput(stream: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new Error(
      `The Runner sandbox cannot expose ${path}: ${safeMessage(error, { fallback: "path is missing", singleLine: true })}`,
    );
  }
}

function pathContains(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
