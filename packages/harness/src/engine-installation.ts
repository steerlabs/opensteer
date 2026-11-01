import type { HarnessInstallation } from "@opensteer/protocol";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, join, normalize, resolve, sep } from "node:path";
import { findExecutableOnPath, meetsMinimumVersion } from "./installed-engine.js";
import { spawnSupervised } from "./process-supervisor.js";

export type EnginePackageManager = "bun" | "homebrew" | "npm" | "pnpm" | "volta" | "yarn";

export interface InstalledEngineUpdateFacts {
  readonly executableName: string;
  readonly minimumVersion: string;
  readonly packageName?: string;
  readonly version: {
    readonly args: readonly string[];
    readonly pattern: RegExp;
  };
  readonly native?: {
    readonly executableBasename?: string;
    readonly launcherFile?: {
      readonly contains: readonly string[];
      readonly maxBytes: number;
    };
    readonly realPathIncludes?: readonly string[];
    readonly updateArgs: readonly string[];
  };
  readonly homebrew?: {
    readonly cask?: string;
    readonly formula?: string;
  };
  readonly updateEnvironment?: Readonly<Record<string, string>>;
  readonly latest?:
    | { readonly kind: "npm" }
    | {
        readonly channelEnvironment: string;
        readonly channels: Readonly<Record<string, string>>;
        readonly defaultChannel: string;
        readonly kind: "channel-manifest";
        readonly url: string;
        readonly versionField: string;
      };
  readonly comparison?: "dotted" | "revision";
}

export interface EngineUpdatePlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly serializationKey: string;
}

export interface ResolvedEngineInstallation {
  readonly descriptor: HarnessInstallation;
  readonly plan?: EngineUpdatePlan;
}

interface CommandResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface EngineInstallationResolverOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly inspectionTimeoutMs?: number;
  readonly now?: () => number;
  readonly run?: (
    executable: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ) => Promise<CommandResult>;
  readonly fetchJson?: (url: string, signal: AbortSignal) => Promise<unknown>;
}

interface CachedResolution {
  readonly expiresAt: number;
  readonly value: ResolvedEngineInstallation;
}

interface ResolvedOwnership {
  readonly kind?: EnginePackageManager | "native";
  readonly plan?: EngineUpdatePlan;
  readonly detail?: string;
  readonly manualCommand?: string;
  readonly brewName?: string;
  readonly brewType?: "cask" | "formula";
  readonly manager?: string;
}

const hourMs = 60 * 60 * 1_000;
const maxInspectionBytes = 128 * 1_024;
const defaultInspectionTimeoutMs = 5_000;

/** Resolves only ownership the filesystem or package manager can prove. */
export class EngineInstallationResolver {
  readonly #cache = new Map<string, CachedResolution>();
  readonly #environment: NodeJS.ProcessEnv;
  readonly #inspectionTimeoutMs: number;
  readonly #now: () => number;
  readonly #run: NonNullable<EngineInstallationResolverOptions["run"]>;
  readonly #fetchJson: NonNullable<EngineInstallationResolverOptions["fetchJson"]>;

  constructor(options: EngineInstallationResolverOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#inspectionTimeoutMs = options.inspectionTimeoutMs ?? defaultInspectionTimeoutMs;
    this.#now = options.now ?? Date.now;
    this.#run = options.run ?? runSupervised;
    this.#fetchJson =
      options.fetchJson ??
      (async (url, signal) => {
        const response = await fetch(url, { headers: { accept: "application/json" }, signal });
        if (!response.ok) throw new Error(`Latest-version request failed (${response.status})`);
        return response.json();
      });
  }

  invalidate(executable?: string): void {
    if (!executable) this.#cache.clear();
    else this.#cache.delete(executable);
  }

  async resolve(
    visibleExecutable: string,
    facts: InstalledEngineUpdateFacts,
    scope: HarnessInstallation["scope"],
  ): Promise<ResolvedEngineInstallation> {
    const cached = this.#cache.get(visibleExecutable);
    if (cached && cached.expiresAt > this.#now()) return cached.value;
    const executable = await realpath(visibleExecutable).catch(() => visibleExecutable);
    const version = await this.#readVersion(executable, facts);
    const ownership = await this.#ownership(visibleExecutable, executable, facts);
    const latestVersion = await this.#latest(ownership, facts);
    const belowMinimum = !meetsMinimumVersion(version, facts.minimumVersion);
    const hasNewer = latestVersion
      ? (facts.comparison === "revision" ? compareRevisionVersions : compareVersions)(
          version,
          latestVersion,
        ) < 0
      : false;
    const update = !ownership.plan
      ? "manual"
      : belowMinimum || hasNewer
        ? "available"
        : latestVersion
          ? "current"
          : "unknown";
    const plan =
      ownership.kind === "pnpm" && ownership.plan && latestVersion && facts.packageName
        ? { ...ownership.plan, args: ["add", "--global", `${facts.packageName}@${latestVersion}`] }
        : ownership.plan;
    const value: ResolvedEngineInstallation = {
      descriptor: {
        ...(ownership.detail ? { detail: ownership.detail } : {}),
        latestVersion,
        ...(ownership.manualCommand
          ? { manualCommand: ownership.manualCommand }
          : plan
            ? { manualCommand: renderCommand(plan.executable, plan.args) }
            : {}),
        scope,
        update,
        version,
      },
      ...(plan ? { plan } : {}),
    };
    this.#cache.set(visibleExecutable, { expiresAt: this.#now() + hourMs, value });
    return value;
  }

  async #readVersion(executable: string, facts: InstalledEngineUpdateFacts): Promise<string> {
    const result = await this.#runInspection(
      executable,
      facts.version.args,
      processEnvironment(this.#environment),
    );
    const match = facts.version.pattern.exec(`${result.stdout}\n${result.stderr}`);
    if (result.code !== 0 || !match?.[1])
      throw new Error(`Could not read ${facts.executableName} version`);
    return match[1];
  }

  async #ownership(
    visibleExecutable: string,
    executable: string,
    facts: InstalledEngineUpdateFacts,
  ): Promise<ResolvedOwnership> {
    const normalized = slash(executable).toLowerCase();
    if (normalized.includes("/mise/installs/") || normalized.includes("/mise/shims/")) {
      return { detail: "Update this engine with mise." };
    }

    if (facts.packageName) {
      const manager = await this.#nodePackageOwnership(executable, facts.packageName);
      if (manager) return packageManagerPlan(manager, facts, this.#environment);
    }

    const brew = await this.#homebrewOwnership(executable, facts);
    if (brew) return brew;

    const nativeRecognized =
      (facts.native?.realPathIncludes?.some((part) => normalized.includes(part.toLowerCase())) ??
        false) ||
      (facts.native?.executableBasename !== undefined &&
        basename(executable).toLowerCase() === facts.native.executableBasename.toLowerCase()) ||
      (facts.native?.launcherFile !== undefined &&
        (await fileContainsMarkers(executable, facts.native.launcherFile)));
    if (facts.native && nativeRecognized) {
      return {
        kind: "native",
        plan: {
          args: facts.native.updateArgs,
          environment: updateEnvironment(this.#environment, facts),
          executable: visibleExecutable,
          serializationKey: `native:${executable}`,
        },
      };
    }
    return {
      detail:
        "Opensteer could not prove how this engine was installed. Update it with the tool that installed it.",
    };
  }

  async #nodePackageOwnership(
    executable: string,
    packageName: string,
  ): Promise<
    | { readonly kind: Exclude<EnginePackageManager, "homebrew">; readonly executable: string }
    | undefined
  > {
    const path = this.#environment.PATH;
    const normalized = slash(executable).toLowerCase();
    const packagePath = packageName.toLowerCase().replace("@", "@");
    const containsPackage = normalized.includes(`/node_modules/${packagePath}/`);
    if (normalized.includes("/.bun/bin/") && containsPackage) {
      const command = findExecutableOnPath("bun", path);
      if (command) return { executable: command, kind: "bun" };
    }
    const pnpmPatterns = [
      "/.local/share/pnpm/",
      "/library/pnpm/",
      "/local/share/pnpm/",
      "/appdata/local/pnpm/",
      "/pnpm/global/",
    ];
    if (pnpmPatterns.some((part) => normalized.includes(part)) && containsPackage) {
      const command = findExecutableOnPath("pnpm", path);
      if (command) return { executable: command, kind: "pnpm" };
    }
    if (/\/yarn\/(?:data\/)?global\/node_modules\//.test(normalized) && containsPackage) {
      const command = findExecutableOnPath("yarn", path);
      if (command) return { executable: command, kind: "yarn" };
    }
    const volta = this.#environment.VOLTA_HOME;
    if (volta && normalized.endsWith("/volta-shim")) {
      const packageDirectory = join(volta, "tools", "image", "packages", packageName);
      if (await isDirectory(packageDirectory)) {
        const command = findExecutableOnPath("volta", path);
        if (command) return { executable: command, kind: "volta" };
      }
    }
    const npm = findExecutableOnPath("npm", path);
    if (npm) {
      const prefixResult = await this.#runInspection(
        npm,
        ["prefix", "--global"],
        processEnvironment(this.#environment),
      );
      const prefix = prefixResult.code === 0 ? prefixResult.stdout.trim() : "";
      if (prefix) {
        const resolvedPrefix = await realpath(prefix).catch(() => prefix);
        const root = slash(
          resolve(resolvedPrefix, "lib", "node_modules", packageName),
        ).toLowerCase();
        if (normalized === root || normalized.startsWith(`${root}/`)) {
          return { executable: npm, kind: "npm" };
        }
      }
    }
    return undefined;
  }

  async #homebrewOwnership(
    executable: string,
    facts: InstalledEngineUpdateFacts,
  ): Promise<
    | {
        readonly kind: "homebrew";
        readonly plan: EngineUpdatePlan;
        readonly brewName: string;
        readonly brewType: "cask" | "formula";
        readonly manager: string;
      }
    | undefined
  > {
    const match = slash(executable).match(/^(.*)\/(Cellar|Caskroom)\/([^/]+)\/[^/]+\//i);
    if (!match?.[1] || !match[2] || !match[3]) return undefined;
    const brewType = match[2].toLowerCase() === "caskroom" ? "cask" : "formula";
    const expected = brewType === "cask" ? facts.homebrew?.cask : facts.homebrew?.formula;
    if (!expected || expected.toLowerCase() !== match[3].toLowerCase()) return undefined;
    const candidate = join(match[1], "bin", "brew");
    const manager = (await isFile(candidate))
      ? candidate
      : findExecutableOnPath("brew", this.#environment.PATH);
    if (!manager) return undefined;
    const prefix = await this.#runInspection(
      manager,
      ["--prefix"],
      processEnvironment(this.#environment),
    );
    const vouchedPrefix = await realpath(prefix.stdout.trim()).catch(() =>
      normalize(prefix.stdout.trim()),
    );
    const ownedPrefix = await realpath(match[1]).catch(() => normalize(match[1] ?? ""));
    if (prefix.code !== 0 || vouchedPrefix !== ownedPrefix) return undefined;
    return {
      brewName: expected,
      brewType,
      kind: "homebrew",
      manager,
      plan: {
        args: ["upgrade", ...(brewType === "cask" ? ["--cask"] : []), expected],
        environment: processEnvironment(this.#environment),
        executable: manager,
        serializationKey: `homebrew:${ownedPrefix}`,
      },
    };
  }

  async #latest(
    ownership: ResolvedOwnership,
    facts: InstalledEngineUpdateFacts,
  ): Promise<string | null> {
    if (
      ownership.kind === "homebrew" &&
      ownership.manager &&
      ownership.brewName &&
      ownership.brewType
    ) {
      const result = await this.#runInspection(
        ownership.manager,
        ["info", "--json=v2", ownership.brewName],
        processEnvironment(this.#environment),
      );
      if (result.code !== 0) return null;
      return parseBrewLatestVersion(result.stdout, ownership.brewType);
    }
    if (facts.latest?.kind === "channel-manifest") {
      const requested = this.#environment[facts.latest.channelEnvironment];
      const channel =
        (requested ? facts.latest.channels[requested] : undefined) ??
        facts.latest.channels[facts.latest.defaultChannel];
      if (!channel) return null;
      try {
        const manifest = await this.#fetchInspection(
          facts.latest.url.replace("{channel}", channel),
        );
        return readStringField(manifest, facts.latest.versionField);
      } catch {
        return null;
      }
    }
    if (!facts.packageName) return null;
    const npm = findExecutableOnPath("npm", this.#environment.PATH);
    if (!npm) return null;
    const result = await this.#runInspection(
      npm,
      ["view", "--json", `${facts.packageName}@latest`, "version"],
      processEnvironment(this.#environment),
    );
    return result.code === 0 ? parseNpmLatestVersion(result.stdout) : null;
  }

  #runInspection(
    executable: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>>,
  ): Promise<CommandResult> {
    const signal = AbortSignal.timeout(this.#inspectionTimeoutMs);
    return abortable(this.#run(executable, args, environment, signal), signal);
  }

  #fetchInspection(url: string): Promise<unknown> {
    const signal = AbortSignal.timeout(this.#inspectionTimeoutMs);
    return abortable(this.#fetchJson(url, signal), signal);
  }
}

function packageManagerPlan(
  manager: {
    readonly kind: Exclude<EnginePackageManager, "homebrew">;
    readonly executable: string;
  },
  facts: InstalledEngineUpdateFacts,
  environment: NodeJS.ProcessEnv,
) {
  const packageName = facts.packageName;
  if (!packageName) return {};
  const versionTarget = `${packageName}@latest`;
  const args: readonly string[] =
    manager.kind === "npm"
      ? ["install", "--global", versionTarget]
      : manager.kind === "pnpm"
        ? ["add", "--global", versionTarget]
        : manager.kind === "bun"
          ? ["add", "--global", versionTarget]
          : manager.kind === "yarn"
            ? ["global", "add", versionTarget]
            : ["install", packageName];
  return {
    kind: manager.kind,
    plan: {
      args,
      environment: updateEnvironment(environment, facts),
      executable: manager.executable,
      serializationKey: `${manager.kind}:${manager.executable}`,
    },
  } as const;
}

function updateEnvironment(
  source: NodeJS.ProcessEnv,
  facts: InstalledEngineUpdateFacts,
): Readonly<Record<string, string>> {
  return { ...processEnvironment(source), ...facts.updateEnvironment };
}

function processEnvironment(source: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const exact = new Set([
    "APPDATA",
    "BUN_INSTALL",
    "ComSpec",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOMEBREW_BREW_FILE",
    "HOMEBREW_CACHE",
    "HOMEBREW_CELLAR",
    "HOMEBREW_LIBRARY",
    "HOMEBREW_PREFIX",
    "HOMEBREW_REPOSITORY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LANGUAGE",
    "LOCALAPPDATA",
    "LOGNAME",
    "MISE_CACHE_DIR",
    "MISE_CONFIG_DIR",
    "MISE_DATA_DIR",
    "MISE_INSTALL_PATH",
    "MISE_STATE_DIR",
    "MUSE_CHANNEL",
    "NODE_EXTRA_CA_CERTS",
    "NO_PROXY",
    "NPM_CONFIG_PREFIX",
    "PATH",
    "PATHEXT",
    "PNPM_HOME",
    "PWD",
    "Path",
    "SHELL",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SystemRoot",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USER",
    "USERNAME",
    "VOLTA_HOME",
    "WINDIR",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "npm_config_prefix",
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && (exact.has(entry[0]) || entry[0].startsWith("LC_")),
    ),
  );
}

async function runSupervised(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<CommandResult> {
  const process = spawnSupervised({
    args,
    cwd: processCwd(environment),
    environment,
    executable,
    maxOutputBytes: maxInspectionBytes,
  });
  const abort = () => void process.terminate(0).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  const stdout = collect(process.stdout);
  const stderr = collect(process.stderr);
  try {
    const exit = await process.exited;
    return { code: exit.code, stderr: await stderr, stdout: await stdout };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void operation
      .then(resolvePromise, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function collect(chunks: AsyncIterable<Buffer>): Promise<string> {
  const values: Buffer[] = [];
  for await (const chunk of chunks) values.push(chunk);
  return Buffer.concat(values).toString("utf8");
}

function processCwd(environment: Readonly<Record<string, string>>): string {
  return environment.PWD && resolve(environment.PWD) === environment.PWD
    ? environment.PWD
    : process.cwd();
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (value) => value.isFile(),
    () => false,
  );
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (value) => value.isDirectory(),
    () => false,
  );
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

export function parseNpmLatestVersion(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
  } catch {
    return null;
  }
}

export function parseBrewLatestVersion(value: string, type: "cask" | "formula"): string | null {
  try {
    const parsed = JSON.parse(value) as {
      readonly casks?: readonly { readonly version?: unknown }[];
      readonly formulae?: readonly { readonly versions?: { readonly stable?: unknown } }[];
    };
    const candidate =
      type === "cask" ? parsed.casks?.[0]?.version : parsed.formulae?.[0]?.versions?.stable;
    if (typeof candidate !== "string") return null;
    const version = candidate.split(",")[0]?.trim();
    return !version || version === "latest" ? null : version;
  } catch {
    return null;
  }
}

export function compareVersions(left: string, right: string): number {
  const parts = (value: string) =>
    value
      .split("-")[0]
      ?.split(".")
      .map((part) => Number.parseInt(part, 10)) ?? [];
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function compareRevisionVersions(left: string, right: string): number {
  const revision = /^(.*?)-R(\d+(?:\.\d+)*)$/;
  const a = revision.exec(left);
  const b = revision.exec(right);
  if (!a?.[1] || !b?.[1]) return compareVersions(left, right);
  const base = compareVersions(a[1], b[1]);
  if (base !== 0) return base;
  return compareVersions(a[2] ?? "0", b[2] ?? "0");
}

async function fileContainsMarkers(
  path: string,
  proof: { readonly contains: readonly string[]; readonly maxBytes: number },
): Promise<boolean> {
  const details = await stat(path).catch(() => undefined);
  if (!details?.isFile() || details.size > proof.maxBytes) return false;
  const content = await readFile(path, "utf8").catch(() => undefined);
  return content !== undefined && proof.contains.every((marker) => content.includes(marker));
}

function readStringField(value: unknown, field: string): string | null {
  let current: unknown = value;
  for (const part of field.split(".")) {
    if (!current || typeof current !== "object" || !(part in current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function renderCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args]
    .map((part) =>
      /^[a-zA-Z0-9_./:@+-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}
