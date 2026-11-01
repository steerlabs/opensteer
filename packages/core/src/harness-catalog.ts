import type { ThreadAccessMode } from "./models.js";

/*
 * Every AI engine the product ships a driver for, as one typed list.
 *
 * An engine used to be named in a dozen places — the Runner's registry and its
 * executable environment variables, the machine-access matrix, the Personal
 * runtime manifest and its packager, the lent-computer install script, the
 * settings rail and the model picker's sort order. Each of those lists could
 * be updated without the others, so adding an engine meant finding them all.
 * This is the one list; everything else folds over it.
 *
 * It is deliberately data only. `packages/core` is bundled into the web and
 * mobile apps, so it must never import a driver package: the factories that
 * construct a `HarnessDriver` live in the Runner, keyed by the kinds declared
 * here, which makes a catalog entry with no factory a compile error.
 */

/**
 * Where a distribution puts an engine's runtime and what it must answer for
 * `--version`. A `file` runtime is one executable; a `tree` runtime is a whole
 * directory its executable resolves siblings against, so the packagers stage
 * `treeRoot` whole rather than copying `path` alone; a `script` runtime is a
 * Node program shipped as a tree and run by the Runner's own interpreter,
 * because the engine is published as JavaScript rather than as a binary.
 *
 * An `installed` runtime is one the product does not ship at all: no
 * redistribution grant has been established for the engine, so the person
 * installs it and the Runner finds it. Nothing pins its version, so the entry
 * names the oldest release the driver was written against and the driver
 * refuses an older one.
 */
export type HarnessRuntimeDescriptor =
  | {
      /** The executable, relative to the root of a distribution. */
      readonly path: string;
      /** Exactly what `<executable> --version` prints for the pinned release. */
      readonly expectedVersion: string;
      /**
       * The npm package the runtime arrives in, pinned once in the pnpm
       * catalog. Package versions may differ from the runtime's own.
       */
      readonly npmPackage: string;
      readonly shape: "file";
    }
  | {
      readonly path: string;
      readonly expectedVersion: string;
      readonly npmPackage: string;
      readonly shape: "tree";
      /** The directory that travels whole, which `path` sits inside. */
      readonly treeRoot: string;
    }
  | {
      /** The program's entry script, relative to the root of a distribution. */
      readonly path: string;
      /** Exactly what `node <path> --version` prints for the pinned release. */
      readonly expectedVersion: string;
      readonly npmPackage: string;
      readonly shape: "script";
      readonly treeRoot: string;
    }
  | (HarnessInstalledRuntimeDescriptor & { readonly shape: "installed" });

/** An engine as the person installed it, found on their own PATH. */
export interface HarnessInstalledRuntimeDescriptor {
  /** The command name the person's installation puts on their PATH. */
  readonly command: string;
  /** Where a person gets the engine, shown when it is not installed. */
  readonly installUrl: string;
  /**
   * The oldest release the driver accepts. It moves when the driver needs
   * something newer, not with every shipped release, so a CLI the person
   * updates on their own schedule keeps working.
   */
  readonly minimumVersion: string;
}

/**
 * What a Run's harness can reach another enrolled computer from, asserted
 * cell by cell in `apps/runner/src/shell/machine-access-setup.test.ts`.
 * `accessModes: "all"` means the engine's own
 * command sandbox takes an explicit allowance for the relay socket in every
 * mode; a list means only those modes reach it. A kind that is not in this
 * catalog is denied, because nothing here has measured it.
 */
export interface HarnessMachineAccessDescriptor {
  readonly platforms: readonly ("darwin" | "linux" | "win32")[];
  readonly accessModes: readonly ThreadAccessMode[] | "all";
}

export interface HarnessCatalogEntry {
  /** The driver kind, as it is stored on a harness instance row. */
  readonly kind: string;
  /** What the product calls the engine: the name people know the CLI by. */
  readonly label: string;
  /** The lab behind the engine, so it can wear that lab's mark. */
  readonly brandProviderId: string;
  readonly runtime: HarnessRuntimeDescriptor;
  /**
   * The person's own install of an engine whose bytes a distribution also
   * ships. Accounts using the person's own sign-in run it rather than the
   * shipped runtime, so the sign-in and the program that reads it come from
   * one installation and a new model arrives the day the person's CLI knows it.
   */
  readonly installed?: HarnessInstalledRuntimeDescriptor;
  /**
   * The variables a person's login shell may pass through to this engine. They
   * point at an engine's configuration home or executable, a location and never
   * a secret.
   */
  readonly userEnvironmentVariables: readonly string[];
  readonly machineAccess: HarnessMachineAccessDescriptor;
}

/** Array order is display order, everywhere an engine list is shown. */
export const harnessCatalog = [
  {
    kind: "codex",
    label: "Codex",
    brandProviderId: "openai",
    runtime: {
      path: "codex/bin/codex",
      shape: "tree",
      treeRoot: "codex",
      expectedVersion: "codex-cli 0.162.0",
      npmPackage: "@openai/codex",
    },
    installed: {
      command: "codex",
      installUrl: "https://github.com/openai/codex",
      minimumVersion: "0.156.0",
    },
    userEnvironmentVariables: ["CODEX_HOME"],
    machineAccess: { platforms: ["darwin", "linux"], accessModes: ["full-access"] },
  },
  {
    kind: "claude",
    label: "Claude Code",
    brandProviderId: "anthropic",
    runtime: {
      shape: "installed",
      command: "claude",
      installUrl: "https://code.claude.com/docs/en/setup",
      // The oldest release qualified to name, in each result, the messages its
      // turn consumed, which a message steered into a Run is answered by.
      minimumVersion: "2.1.294",
    },
    userEnvironmentVariables: ["CLAUDE_CONFIG_DIR", "OPENSTEER_CLAUDE_EXECUTABLE"],
    machineAccess: { platforms: ["darwin", "linux"], accessModes: "all" },
  },
  {
    kind: "muse",
    label: "Muse Code",
    brandProviderId: "meta",
    runtime: {
      shape: "installed",
      command: "muse",
      installUrl: "https://dev.meta.ai/docs/muse-code",
      minimumVersion: "1.4.14",
    },
    userEnvironmentVariables: ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "MUSE_PROJECTS_HOME"],
    // Muse machine-access relay reachability has not been measured yet.
    machineAccess: { platforms: [], accessModes: "all" },
  },
  {
    kind: "opencode",
    label: "OpenCode",
    brandProviderId: "opencode",
    runtime: {
      path: "bin/opencode",
      shape: "file",
      expectedVersion: "1.18.32",
      npmPackage: "opencode-ai",
    },
    userEnvironmentVariables: [],
    machineAccess: { platforms: ["darwin", "linux"], accessModes: "all" },
  },
  {
    kind: "pi",
    label: "Pi",
    brandProviderId: "pi",
    runtime: {
      path: "pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      shape: "script",
      treeRoot: "pi",
      expectedVersion: "0.87.1",
      npmPackage: "@earendil-works/pi-coding-agent",
    },
    userEnvironmentVariables: ["PI_CODING_AGENT_DIR"],
    machineAccess: { platforms: ["darwin", "linux"], accessModes: "all" },
  },
  {
    kind: "cursor",
    label: "Cursor",
    brandProviderId: "cursor",
    runtime: {
      command: "agent",
      installUrl: "https://cursor.com/install",
      minimumVersion: "2026.09.10",
      shape: "installed",
    },
    userEnvironmentVariables: ["CURSOR_CONFIG_DIR"],
    machineAccess: { platforms: ["darwin", "linux"], accessModes: "all" },
  },
] as const satisfies readonly HarnessCatalogEntry[];

export type HarnessKind = (typeof harnessCatalog)[number]["kind"];

export const harnessKinds: readonly HarnessKind[] = harnessCatalog.map((entry) => entry.kind);

/**
 * A catalog entry whose runtime bytes a distribution ships. Separating it by
 * the runtime's `shape` rather than by a hand-kept list is what lets the
 * packagers, the release manifest and the container image say "every engine we
 * ship" and have the compiler agree with the catalog.
 */
export type ShippedHarnessCatalogEntry = Extract<
  (typeof harnessCatalog)[number],
  { readonly runtime: { readonly shape: "file" | "script" | "tree" } }
>;

/** The kinds whose runtime bytes every distribution ships and version-asserts. */
export type ShippedHarnessKind = ShippedHarnessCatalogEntry["kind"];

/**
 * Whether a distribution ships this engine's bytes. A packager loop reads the
 * catalog in display order and needs the entry itself narrowed, not only its
 * runtime, to reach the resolver keyed by shipped kind.
 */
export function shipsHarnessRuntimeBytes(
  entry: (typeof harnessCatalog)[number],
): entry is ShippedHarnessCatalogEntry {
  return entry.runtime.shape !== "installed";
}

export const shippedHarnessKinds: readonly ShippedHarnessKind[] = harnessCatalog
  .filter(shipsHarnessRuntimeBytes)
  .map((entry) => entry.kind);

export function harnessCatalogEntry(driverKind: string): HarnessCatalogEntry | undefined {
  return harnessCatalog.find((entry) => entry.kind === driverKind);
}

/**
 * The entry for a kind this tree ships a driver for. Total, unlike
 * {@link harnessCatalogEntry}, because the kind came from the catalog itself.
 */
export function shippedHarnessCatalogEntry(kind: HarnessKind): HarnessCatalogEntry {
  const entry = harnessCatalogEntry(kind);
  if (!entry) throw new Error(`No harness catalog entry for ${kind}`);
  return entry;
}

/**
 * What the product calls each AI engine. Anything not in the catalog is a
 * driver the product has not named yet, so its kind is title-cased rather than
 * shown raw.
 */
export function harnessDriverLabel(driverKind: string): string {
  const entry = harnessCatalogEntry(driverKind);
  if (entry) return entry.label;
  return driverKind
    .split(/[._-]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

/** Which executable a distribution tells the Runner to spawn for this engine. */
export function harnessExecutableEnvironmentVariable(driverKind: string): string {
  return `OPENSTEER_${driverKind.toLocaleUpperCase()}_EXECUTABLE`;
}

/** Catalog order, with an engine the product has not named yet sorted last. */
export function harnessDisplayRank(driverKind: string): number {
  const index = harnessCatalog.findIndex((entry) => entry.kind === driverKind);
  return index === -1 ? harnessCatalog.length : index;
}

/**
 * Exactly what a shipped engine's runtime prints for `--version`. An
 * `installed` engine has no such string, and nothing that ships bytes asks.
 */
export function harnessRuntimeExpectedVersion(kind: HarnessKind): string {
  const { runtime } = shippedHarnessCatalogEntry(kind);
  if (runtime.shape === "installed") {
    throw new Error(`Harness ${kind} is installed by the person, so nothing pins its version`);
  }
  return runtime.expectedVersion;
}

/**
 * The version an engine's own protocol reports, taken from the one string the
 * packagers assert against `--version`. Drivers pin their protocol to exactly
 * this release, and a pin that lived beside the driver could drift from the
 * bytes a distribution ships.
 */
export function harnessRuntimeVersion(kind: HarnessKind): string {
  const version = /\d+\.\d+\.\d+/u.exec(harnessRuntimeExpectedVersion(kind))?.[0];
  if (!version) throw new Error(`Harness ${kind} declares no runtime version`);
  return version;
}

/**
 * The oldest release a driver accepts: the floor its person's install must
 * meet, which the shipped runtime meets too. An engine with no person's
 * install accepts only the release a distribution ships.
 */
export function harnessMinimumVersion(kind: HarnessKind): string {
  const entry = shippedHarnessCatalogEntry(kind);
  if (entry.installed) return entry.installed.minimumVersion;
  if (entry.runtime.shape === "installed") return entry.runtime.minimumVersion;
  return harnessRuntimeVersion(kind);
}

/** One value per catalog engine, so a caller never asserts a lookup is present. */
export function harnessKindRecord<T>(build: (kind: HarnessKind) => T): Record<HarnessKind, T> {
  return Object.fromEntries(harnessKinds.map((kind) => [kind, build(kind)])) as Record<
    HarnessKind,
    T
  >;
}

/**
 * One value per engine whose bytes a distribution ships. An `installed` engine
 * has no bytes here to name, so a record keyed by every kind would force its
 * callers — the release manifest, the packagers — to invent one.
 */
export function shippedHarnessKindRecord<T>(
  build: (kind: ShippedHarnessKind) => T,
): Record<ShippedHarnessKind, T> {
  return Object.fromEntries(shippedHarnessKinds.map((kind) => [kind, build(kind)])) as Record<
    ShippedHarnessKind,
    T
  >;
}
