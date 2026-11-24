import { lstat, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { HostConfig } from "@opensteer/config";
import {
  readProblemReportsSetting,
  readStoredProblems,
  setProblemReportsSetting,
  type DatabaseSchema,
} from "@opensteer/database";
import type { ProblemReporting } from "@opensteer/protocol";
import {
  HomeHealthReportSchema,
  MachineStatusSchema,
  OpensteerProblemReportSchema,
  ReleaseVersionSchema,
  cloudComputerHealthPath,
  compareProblems,
  diskBucket,
  problemCountBucket,
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
/** How often a Cloud Computer, or a Home sending to its own collector, sends its report. */
export const problemReportIntervalMs = 15 * 60_000;
/** How often a person's own Home sends Opensteer its codes: once a day. */
export const opensteerReportIntervalMs = 24 * 60 * 60_000;

type Destination =
  | {
      readonly kind: "operator";
      readonly url: URL;
      readonly clientId: string;
      readonly clientSecret: string;
    }
  | { readonly kind: "opensteer" | "own"; readonly url: URL }
  | { readonly kind: "none" };

/** Where this Home's report goes, from configuration only; nothing an agent says changes it. */
export function problemReportDestination(
  config: Pick<HostConfig, "managedHome" | "personalAccountIssuer" | "problemReportsOrigin">,
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
  if (config.personalAccountIssuer)
    return { kind: "opensteer", url: new URL(problemReportsPath, config.personalAccountIssuer) };
  return { kind: "none" };
}

/** The release this Host is, as a report may name it: anything else reads as 0.0.0. */
export function reportVersion(value: string | undefined): string {
  return ReleaseVersionSchema.safeParse(value).success ? value! : "0.0.0";
}

/**
 * This Home's problems, and the one report it sends. The read is the one function behind the
 * person's Settings, `opensteer_state` area `problems` and the report: what the database keeps
 * (`readStoredProblems`), what the machine's root maintenance wrote, and the disk. The report is
 * sent by this Home on its own timer, never for a connection or a Run, to one address from
 * configuration: the full health report to the Opensteer account for a Cloud Computer (its
 * operator) or to a self-hoster's own collector, and only codes with bucketed counts, once a day,
 * from a person's own Home to Opensteer. Nothing but a Cloud Computer sends anything unless the
 * person turned it on, and while it is off there is no timer at all.
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
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sending: Promise<void> | undefined;
  /** Set by `setSending` before anything else it does, so an Off already counts mid-send. */
  #on = false;
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
  }) {
    this.#database = options.database;
    this.#dataDirectory = options.dataDirectory;
    this.#home = options.home;
    this.#readsMachineStatus = options.readsMachineStatus;
    this.#version = reportVersion(options.version);
    this.#destination = options.destination;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
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

  /** The full health report: what a Cloud Computer or a Home's own collector receives. */
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

  async reporting(): Promise<ProblemReporting> {
    const mode =
      this.#destination.kind === "operator"
        ? "operator"
        : await readProblemReportsSetting(this.#database);
    return {
      mode,
      destination: this.#destination.kind === "operator" ? "opensteer" : this.#destination.kind,
      ...this.#last,
    };
  }

  /**
   * Exactly the bytes this Home sends, or would send, to its destination: the preview the person
   * sees and the upload are this one string. Null where there is nowhere to send.
   */
  async body(): Promise<string | null> {
    const kind = this.#destination.kind;
    if (kind === "none") return null;
    if (kind === "operator" || kind === "own") return JSON.stringify(await this.report());
    const totals = new Map<string, number>();
    for (const problem of await this.problems())
      totals.set(problem.code, (totals.get(problem.code) ?? 0) + problem.count);
    const codes = Object.fromEntries(
      [...totals].map(([code, total]) => [code, problemCountBucket(total)]),
    );
    const home = this.#home === "cloud-computer" ? "other" : this.#home;
    return JSON.stringify(
      OpensteerProblemReportSchema.parse({ schema: 1, home, version: this.#version, codes }),
    );
  }

  async view() {
    const [problems, reporting, body] = await Promise.all([
      this.problems(),
      this.reporting(),
      this.body(),
    ]);
    return { problems, reporting, body };
  }

  /** Whether a timer is set: none while nothing will be sent (rule 7). */
  scheduled(): boolean {
    return this.#timer !== undefined;
  }

  /**
   * The person's own choice, approved by them at the door; a Cloud Computer's report is not
   * theirs to turn off. Off counts at once, before the setting is written.
   */
  async setSending(send: boolean): Promise<ProblemReporting> {
    if (this.#destination.kind !== "operator") {
      if (!send) this.#stop();
      await setProblemReportsSetting(this.#database, send ? "on" : "off");
      this.#on = send;
      if (send) this.#schedule(60_000);
    }
    return this.reporting();
  }

  /** Sends the report once, if this Home sends one. Never throws: the result is remembered. */
  async sendOnce(): Promise<void> {
    const destination = this.#destination;
    if (destination.kind === "none" || !this.#sends()) return;
    const body = await this.body();
    // An Off that landed while the body was built stops it here, before anything leaves.
    if (body === null || !this.#sends()) return;
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

  /**
   * Starts the timer only where something will be sent: always on a Cloud Computer, elsewhere
   * only while the person has it on. Off, nothing wakes.
   */
  async start(): Promise<void> {
    const kind = this.#destination.kind;
    if (kind === "none") return;
    this.#on = kind === "operator" || (await readProblemReportsSetting(this.#database)) === "on";
    if (this.#on) this.#schedule(60_000 + Math.floor(Math.random() * 60_000));
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stop();
    await this.#sending;
  }

  #sends(): boolean {
    return !this.#closed && (this.#destination.kind === "operator" || this.#on);
  }

  #stop(): void {
    this.#on = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(delayMs: number): void {
    if (this.#destination.kind === "none" || !this.#sends()) return;
    if (this.#timer) clearTimeout(this.#timer);
    const interval =
      this.#destination.kind === "opensteer" ? opensteerReportIntervalMs : problemReportIntervalMs;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#sending ??= this.sendOnce()
        .catch(() => undefined)
        .finally(() => {
          this.#sending = undefined;
          this.#schedule(interval + Math.floor(Math.random() * 60_000));
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

  async #disk(): Promise<DiskBucket | undefined> {
    try {
      const disk = await statfs(this.#dataDirectory);
      if (!disk.blocks) return undefined;
      return diskBucket(1 - disk.bavail / disk.blocks);
    } catch {
      return undefined;
    }
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
