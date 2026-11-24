import { readFile, stat, statfs } from "node:fs/promises";
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
  ReleaseVersionSchema,
  cloudComputerHealthPath,
  compareProblems,
  diskBucket,
  problemReportsPath,
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
 * configuration: the Opensteer account for a Cloud Computer (its operator's health report), and on
 * any other Home only while the person has turned it on.
 */
export class HomeProblems {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #dataDirectory: string;
  readonly #home: HomeHealthReport["home"];
  readonly #version: string;
  readonly #destination: Destination;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sending: Promise<void> | undefined;
  #last: Pick<ProblemReporting, "lastSentAt" | "lastResult"> = {};

  constructor(options: {
    readonly database: Kysely<DatabaseSchema>;
    readonly dataDirectory: string;
    readonly home: HomeHealthReport["home"];
    readonly version: string;
    readonly destination: Destination;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
  }) {
    this.#database = options.database;
    this.#dataDirectory = options.dataDirectory;
    this.#home = options.home;
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

  /** Exactly what this Home sends, or would send: the person's preview and the upload are one. */
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

  async view() {
    const [problems, reporting, report] = await Promise.all([
      this.problems(),
      this.reporting(),
      this.report(),
    ]);
    return { problems, reporting, report };
  }

  /** The person's own choice; a Cloud Computer's report is not theirs to turn off. */
  async setSending(send: boolean): Promise<ProblemReporting> {
    if (this.#destination.kind !== "operator")
      await setProblemReportsSetting(this.#database, send ? "on" : "off");
    const reporting = await this.reporting();
    if (reporting.mode === "on") this.#schedule(0);
    return reporting;
  }

  /** Sends the report once, if this Home sends one. Never throws: the result is remembered. */
  async sendOnce(): Promise<void> {
    const destination = this.#destination;
    if (destination.kind === "none") return;
    if (
      destination.kind !== "operator" &&
      (await readProblemReportsSetting(this.#database)) !== "on"
    )
      return;
    const report = await this.report();
    const at = new Date(this.#now()).toISOString();
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
        body: JSON.stringify(report),
      });
      await response.body?.cancel().catch(() => undefined);
      this.#last = { lastSentAt: at, lastResult: response.ok ? "sent" : "refused" };
    } catch {
      this.#last = { lastSentAt: at, lastResult: "unreachable" };
    }
  }

  /** Starts the timer: a first report a minute or two after start, then every 15 minutes. */
  start(): void {
    this.#schedule(60_000 + Math.floor(Math.random() * 60_000));
  }

  async close(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#sending;
  }

  #schedule(delayMs: number): void {
    if (this.#destination.kind === "none") return;
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
    const path = join(this.#dataDirectory, machineStatusFile);
    try {
      const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      if (text.length > 16_384) return { status: {} };
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
  const at = new Date(machine.at ?? now).toISOString();
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
      lastSeenAt: new Date(now).toISOString(),
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
      firstSeenAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      fields: { disk },
    });
  return problems;
}
