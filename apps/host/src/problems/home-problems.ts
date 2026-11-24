import { lstat, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { HostConfig } from "@opensteer/config";
import { readStoredProblems, type DatabaseSchema } from "@opensteer/database";
import type { ProblemReporting } from "@opensteer/protocol";
import {
  HomeHealthReportSchema,
  MachineStatusSchema,
  ReleaseVersionSchema,
  cloudComputerHealthPath,
  compareProblems,
  diskBucket,
  problemReportsPath,
  reportTime,
  problemsLimit,
  type DiskBucket,
  type HomeHealthReport,
  type MachineStatus,
  type Problem,
} from "@opensteer/protocol/problems";
import type { Kysely } from "kysely";

/** The file a Linux Home's root maintenance writes; see deploy/home/opensteer-home `maintain`. */
export const machineStatusFile = "machine-status.json";
/** A machine status older than this says nothing about services now. */
const machineStatusFreshMs = 15 * 60_000;
const backupOverdueMs = 36 * 60 * 60_000;
/** How often a Home that reports sends its report. */
export const problemReportIntervalMs = 15 * 60_000;

type Destination =
  | {
      readonly kind: "operator";
      readonly url: URL;
      readonly clientId: string;
      readonly clientSecret: string;
    }
  | { readonly kind: "own"; readonly url: URL }
  | { readonly kind: "none" };

/**
 * Where this Home's report goes, from its operator's configuration only; nothing a person's app
 * or an agent says changes it. A Cloud Computer reports to the Opensteer account that runs it; a
 * Home whose operator set `OPENSTEER_PROBLEM_REPORTS_URL` reports to that collector (the
 * operator's setting is the consent); every other Home, a person's own Mac among them, sends
 * nothing at all.
 */
export function problemReportDestination(
  config: Pick<HostConfig, "managedHome" | "problemReportsOrigin">,
): Destination {
  const managed = config.managedHome;
  if (managed)
    return {
      kind: "operator",
      url: new URL(cloudComputerHealthPath(managed.cloudComputerId), managed.accountOrigin),
      clientId: managed.oidc.clientId,
      clientSecret: managed.oidc.clientSecret,
    };
  if (config.problemReportsOrigin)
    return { kind: "own", url: new URL(problemReportsPath, config.problemReportsOrigin) };
  return { kind: "none" };
}

/** The release this Host is, as a report may name it: anything else reads as 0.0.0. */
export function reportVersion(value: string | undefined): string {
  return ReleaseVersionSchema.safeParse(value).success ? value! : "0.0.0";
}

/** How full the disk holding a folder is, as a bucket; undefined when it cannot be read. */
export async function statfsDiskBucket(directory: string): Promise<DiskBucket | undefined> {
  try {
    const disk = await statfs(directory);
    if (!disk.blocks) return undefined;
    return diskBucket(1 - disk.bavail / disk.blocks);
  } catch {
    return undefined;
  }
}

/**
 * This Home's problems, and the one report it sends where its operator configured one. The read
 * is the one function behind the person's Settings, `opensteer_state` area `problems` and the
 * report: what the database keeps (`readStoredProblems`), what the machine's root maintenance
 * wrote, and the disk. The report is sent by this Home on its own timer, never for a connection
 * or a Run: the health report to the Opensteer account for a Cloud Computer, or to a self-hosted
 * Home's own collector. Where there is no destination there is no timer and nothing is sent.
 */
export class HomeProblems {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #dataDirectory: string;
  readonly #home: HomeHealthReport["home"];
  readonly #readsMachineStatus: boolean;
  readonly #version: string;
  readonly #destination: Destination;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #readDisk: (directory: string) => Promise<DiskBucket | undefined>;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sending: Promise<void> | undefined;
  #closed = false;
  #last: Pick<ProblemReporting, "lastSentAt" | "lastResult"> = {};

  constructor(options: {
    readonly database: Kysely<DatabaseSchema>;
    readonly dataDirectory: string;
    readonly home: HomeHealthReport["home"];
    /**
     * Whether root's maintenance writes the machine status here (`OPENSTEER_MACHINE_STATUS`,
     * set only by deploy/home): the file is in host-data, which no Runner mounts, and the Host
     * itself writes only in subfolders. Anywhere else an agent's shell might write it, so unset
     * it is never read.
     */
    readonly readsMachineStatus: boolean;
    readonly version: string;
    readonly destination: Destination;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    /** How full the data folder's disk is; `statfs` unless a test stands in for it. */
    readonly readDisk?: (directory: string) => Promise<DiskBucket | undefined>;
  }) {
    this.#database = options.database;
    this.#dataDirectory = options.dataDirectory;
    this.#home = options.home;
    this.#readsMachineStatus = options.readsMachineStatus;
    this.#version = reportVersion(options.version);
    this.#destination = options.destination;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#readDisk = options.readDisk ?? statfsDiskBucket;
  }

  /** This Home's problems now, the ones that need someone first. */
  async problems(): Promise<Problem[]> {
    const [stored, machine, disk] = await Promise.all([
      readStoredProblems(this.#database),
      this.#machine(),
      this.#disk(),
    ]);
    return [...stored, ...machineProblems(machine, disk, this.#now())]
      .toSorted(compareProblems)
      .slice(0, problemsLimit);
  }

  /** The health report a Cloud Computer's operator or a self-hosted Home's collector receives. */
  async report(): Promise<HomeHealthReport> {
    const [problems, machine, disk] = await Promise.all([
      this.problems(),
      this.#machine(),
      this.#disk(),
    ]);
    return HomeHealthReportSchema.parse({
      schema: 1,
      home: this.#home,
      version: this.#version,
      ...(disk ? { disk } : {}),
      ...machine.status,
      problems,
    });
  }

  reporting(): ProblemReporting {
    return { destination: this.#destination.kind, ...this.#last };
  }

  /**
   * Exactly the bytes this Home sends: the preview the person sees and the upload are this one
   * string. Null where nothing is sent.
   */
  async body(): Promise<string | null> {
    return this.#destination.kind === "none" ? null : JSON.stringify(await this.report());
  }

  async view() {
    const [problems, body] = await Promise.all([this.problems(), this.body()]);
    return { problems, reporting: this.reporting(), body };
  }

  /** Whether a timer is set: never where nothing is sent (rule 7). */
  scheduled(): boolean {
    return this.#timer !== undefined;
  }

  /** Sends the report once, if this Home sends one. Never throws: the result is remembered. */
  async sendOnce(): Promise<void> {
    const destination = this.#destination;
    if (destination.kind === "none" || this.#closed) return;
    const body = await this.body();
    if (body === null || this.#closed) return;
    const at = reportTime(this.#now());
    try {
      const response = await this.#fetch(destination.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "content-type": "application/json",
          ...(destination.kind === "operator"
            ? {
                authorization: `Basic ${Buffer.from(
                  `${destination.clientId}:${destination.clientSecret}`,
                ).toString("base64")}`,
              }
            : {}),
        },
        body,
      });
      await response.body?.cancel().catch(() => undefined);
      this.#last = { lastSentAt: at, lastResult: response.ok ? "sent" : "refused" };
    } catch {
      this.#last = { lastSentAt: at, lastResult: "unreachable" };
    }
  }

  /** Starts the timer where a report goes; where none does, nothing is ever scheduled. */
  start(): void {
    this.#schedule(60_000 + Math.floor(Math.random() * 60_000));
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#sending;
  }

  #schedule(delayMs: number): void {
    if (this.#destination.kind === "none" || this.#closed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#sending ??= this.sendOnce()
        .catch(() => undefined)
        .finally(() => {
          this.#sending = undefined;
          this.#schedule(problemReportIntervalMs + Math.floor(Math.random() * 60_000));
        });
    }, delayMs);
    this.#timer.unref();
  }

  async #machine(): Promise<{ readonly status: MachineStatus; readonly at?: number }> {
    if (!this.#readsMachineStatus) return { status: {} };
    const path = join(this.#dataDirectory, machineStatusFile);
    try {
      // Only a plain file root wrote, never a link to somewhere else.
      const info = await lstat(path);
      if (!info.isFile() || info.size > 16_384) return { status: {} };
      const text = await readFile(path, "utf8");
      const parsed = MachineStatusSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return { status: {} };
      const fresh = this.#now() - info.mtimeMs < machineStatusFreshMs;
      const { services, ...rest } = parsed.data;
      return { status: fresh && services ? { ...rest, services } : rest, at: info.mtimeMs };
    } catch {
      return { status: {} };
    }
  }

  #disk(): Promise<DiskBucket | undefined> {
    return this.#readDisk(this.#dataDirectory);
  }
}

/** The problems only the machine knows, as fixed values. */
export function machineProblems(
  machine: { readonly status: MachineStatus; readonly at?: number },
  disk: DiskBucket | undefined,
  now: number,
): Problem[] {
  const at = reportTime(machine.at ?? now);
  const problems: Problem[] = [];
  for (const [service, health] of Object.entries(machine.status.services ?? {}))
    if (health === "unhealthy" || health === "stopped")
      problems.push({
        code: "home.service_unhealthy",
        count: 1,
        firstSeenAt: at,
        lastSeenAt: at,
        fields: { service: service as never },
      });
  const backup = machine.status.lastBackup;
  if (backup?.result === "failed")
    problems.push({
      code: "backup.failed",
      count: 1,
      firstSeenAt: backup.at,
      lastSeenAt: backup.at,
      fields: backup.failure ? { backupFailure: backup.failure } : {},
    });
  else if (backup && now - Date.parse(backup.at) >= backupOverdueMs)
    problems.push({
      code: "backup.overdue",
      count: 1,
      firstSeenAt: backup.at,
      lastSeenAt: reportTime(now),
      fields: {},
    });
  const update = machine.status.lastUpdate;
  if (update && update.result !== "updated")
    problems.push({
      code: "update.failed",
      count: 1,
      firstSeenAt: update.at,
      lastSeenAt: update.at,
      fields: { updateTarget: "home", updateResult: update.result },
    });
  if (disk === "85-95" || disk === "over-95")
    problems.push({
      code: "disk.nearly_full",
      count: 1,
      firstSeenAt: reportTime(now),
      lastSeenAt: reportTime(now),
      fields: { disk },
    });
  return problems;
}
