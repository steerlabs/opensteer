import { harnessKinds, type HarnessKind } from "@opensteer/core";
import { z } from "zod";

/**
 * Problems: what is going wrong with a Home, in one fixed table. A problem is a code, a
 * severity, one plain sentence for the person with what to do, and a few fields that are enums
 * or whole numbers. Nothing else can be part of one: no address, title, task text, file path,
 * account or device name, token or error text. The schemas below are strict and enumerated, and
 * `problems.test.ts` fails if a free-text field is ever added (the same idea as the client's
 * `ClientIssueCode`: a failure becomes a code before anything is built from it).
 *
 * The person sees their Home's problems; agents read them through `opensteer_state`; a Home
 * that sends problem reports sends exactly `HomeHealthReportSchema` (docs/architecture.md,
 * "Problems and reports"). Adding a code is one entry in `problemTable` and one place that
 * counts it.
 */

/** The seven services of a Linux Home (deploy/home/compose.yaml). */
export const homeServices = [
  "postgres",
  "host",
  "gateway",
  "runner",
  "browser-runtime",
  "browser-egress",
  "channel-runtime",
] as const;
export const HomeServiceSchema = z.enum(homeServices);
export type HomeService = z.infer<typeof HomeServiceSchema>;

export const ServiceHealthSchema = z.enum(["healthy", "starting", "unhealthy", "stopped"]);
export const DiskBucketSchema = z.enum(["under-70", "70-85", "85-95", "over-95"]);
export type DiskBucket = z.infer<typeof DiskBucketSchema>;

export const BackupFailureSchema = z.enum([
  "repository-unreachable",
  "snapshot-failed",
  "restart-failed",
  "report-refused",
]);
/**
 * How a Home's last update check ended. `waiting`: the release's two halves (its installer and its
 * images) have named different releases at more than one check since the result's time.
 */
export const UpdateResultSchema = z.enum([
  "updated",
  "rolled-back",
  "feed-older",
  "waiting",
  "failed",
]);

/** A Cloud Computer's setup failure, by its cause: the provisioner's and the claim's codes. */
export const CloudComputerSetupFailureSchema = z.enum([
  "bootstrap-missing",
  "newer-generation",
  "duplicate-server",
  "readiness-timeout",
  "identity-mismatch",
  "provider-failed",
  "dns-failed",
  "claim-timeout",
  "claim-setup-failed",
  "claim-failed",
]);
export type CloudComputerSetupFailure = z.infer<typeof CloudComputerSetupFailureSchema>;

/**
 * A release version: `x.y.z`, or `x.y.z-alpha.N`, `-beta.N`, `-rc.N`. Nothing else, so no
 * pre-release tag can carry a word of anyone's choosing.
 */
export const ReleaseVersionSchema = z
  .string()
  .max(24)
  .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)\.\d{1,4})?$/u);

/**
 * A time in a report, to the minute and nothing finer: `2026-11-24T10:42:00Z`, a real month,
 * day, hour and minute of this century and zero seconds. A free number of fractional digits, or
 * any two digits in each place, would be room for chosen text.
 */
export const ReportTimeSchema = z
  .string()
  .max(20)
  .regex(/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:00Z$/u);
export type ReportTime = z.infer<typeof ReportTimeSchema>;

/** A time as a report holds it: truncated to its minute. */
export function reportTime(at: Date | number | string): ReportTime {
  const date = new Date(at);
  date.setUTCSeconds(0, 0);
  return date.toISOString().replace(".000Z", "Z");
}

/** Every field a problem may carry. Each is an enum or a whole number. */
const problemFieldSchemas = {
  engine: z.enum(["other", ...harnessKinds] as const satisfies readonly (HarnessKind | "other")[]),
  operation: z.enum(["agent-operation", "automation-firing", "chat-reply"]),
  surface: z.enum(["desktop", "native", "web"]),
  updateTarget: z.enum(["desktop", "home"]),
  updateResult: UpdateResultSchema.exclude(["updated"]),
  service: HomeServiceSchema,
  backupFailure: BackupFailureSchema,
  disk: DiskBucketSchema.extract(["85-95", "over-95"]),
  setupFailure: CloudComputerSetupFailureSchema,
  phase: z.enum(["provisioning", "booting", "ready", "claiming", "failed"]),
  minutes: z.number().int().min(0).max(1_000_000),
} as const;
export type ProblemFieldName = keyof typeof problemFieldSchemas;

export const ProblemFieldsSchema = z.strictObject(
  Object.fromEntries(
    Object.entries(problemFieldSchemas).map(([name, schema]) => [name, schema.optional()]),
  ) as { [Name in ProblemFieldName]: z.ZodOptional<(typeof problemFieldSchemas)[Name]> },
);
export type ProblemFields = z.infer<typeof ProblemFieldsSchema>;

export type ProblemSeverity = "needs-you" | "worth-knowing";

interface ProblemDefinition {
  /** `needs-you`: someone has to act now. `worth-knowing`: it is shown, nobody is asked. */
  readonly severity: ProblemSeverity;
  /** Where it is known: on the Home itself, or only on the Opensteer account service. */
  readonly knownBy: "home" | "account";
  /** One plain sentence: what is wrong. */
  readonly words: string;
  /** One plain sentence: what to do. */
  readonly next: string;
  readonly fields: readonly ProblemFieldName[];
}

export const problemTable = {
  "engine.inspection_failed": {
    severity: "needs-you",
    knownBy: "home",
    words: "An AI engine could not be checked, so it cannot start work.",
    next: "Open AI engines in Settings to see why, then update or reinstall it.",
    fields: ["engine"],
  },
  "stop.unconfirmed": {
    severity: "needs-you",
    knownBy: "home",
    words: "A Stop could not be confirmed, so its task is held.",
    next: "Open the task and check what it did last. Stop it again when its device is back.",
    fields: [],
  },
  "operation.outcome_unknown": {
    severity: "worth-knowing",
    knownBy: "home",
    words: "Something an agent did may or may not have happened.",
    next: "Open its task and check its last action before doing it again.",
    fields: ["operation"],
  },
  "sign_in.unfinished": {
    severity: "worth-knowing",
    knownBy: "home",
    words: "A sign-in to a plugin account did not finish.",
    next: "Connect the account again from Plugins.",
    fields: ["surface"],
  },
  "update.failed": {
    severity: "needs-you",
    knownBy: "home",
    words: "An update did not install. Opensteer kept the version it had.",
    next: "Nothing was lost. Opensteer tries again with its next update.",
    fields: ["updateTarget", "updateResult"],
  },
  "home.service_unhealthy": {
    severity: "needs-you",
    knownBy: "home",
    words: "Part of this Home is not running.",
    next: "Opensteer restarts it by itself. If this stays, restart the Home.",
    fields: ["service"],
  },
  "backup.failed": {
    severity: "needs-you",
    knownBy: "home",
    words: "The last backup did not finish. Nothing on this Home was lost.",
    next: "Opensteer tries again tomorrow. If it keeps failing, check the backup storage.",
    fields: ["backupFailure"],
  },
  "backup.overdue": {
    severity: "needs-you",
    knownBy: "home",
    words: "This Home has not been backed up for more than 36 hours.",
    next: "Check that the Home is running and that its backup storage can be reached.",
    fields: [],
  },
  "disk.nearly_full": {
    severity: "needs-you",
    knownBy: "home",
    words: "This Home's disk is almost full.",
    next: "Remove files you do not need from Agent home, or give the computer more disk.",
    fields: ["disk"],
  },
  "connection.stopping_stuck": {
    severity: "worth-knowing",
    knownBy: "home",
    words: "A connected agent you disconnected is still stopping.",
    next: "Opensteer is waiting for its device to confirm. Check its last action when it ends.",
    fields: [],
  },
  "cloud_computer.setup_failed": {
    severity: "needs-you",
    knownBy: "account",
    words: "Your Cloud Computer could not be set up.",
    next: "Opensteer has been told and is fixing it. Contact support if it is not ready soon.",
    fields: ["setupFailure"],
  },
  "cloud_computer.not_ready": {
    severity: "needs-you",
    knownBy: "account",
    words: "Your Cloud Computer is taking longer than it should to be ready.",
    next: "Opensteer has been told and is looking at it.",
    fields: ["phase", "minutes"],
  },
  "cloud_computer.report_missing": {
    severity: "worth-knowing",
    knownBy: "account",
    words: "This Cloud Computer has stopped reporting its health.",
    next: "Opensteer has been told. Check that the computer is running.",
    fields: ["minutes"],
  },
} as const satisfies Record<string, ProblemDefinition>;

export type ProblemCode = keyof typeof problemTable;
export const problemCodes = Object.keys(problemTable) as [ProblemCode, ...ProblemCode[]];
export const ProblemCodeSchema = z.enum(problemCodes);
export const homeProblemCodes = problemCodes.filter(
  (code) => problemTable[code].knownBy === "home",
) as [ProblemCode, ...ProblemCode[]];

export function problemDefinition(code: ProblemCode): ProblemDefinition {
  return problemTable[code];
}

/**
 * The refinements a report's schemas use, and the only ones: each reads a problem and changes
 * nothing. The no-words guard (`problems.test.ts`) admits these by name and no other check that is
 * not a bound or one of the two named patterns, so a check that rewrites a value is never sent.
 */
export const reportRefinements = {
  /** Only the fields its code's row in the table names. */
  fieldsOfItsCode: (problem: { readonly code: ProblemCode; readonly fields: object }) => {
    const allowed: readonly string[] = problemTable[problem.code].fields;
    return Object.keys(problem.fields).every((name) => allowed.includes(name));
  },
  /** Only a problem the Home itself knows (`knownBy: "home"`). */
  knownByHome: (problem: { readonly code: ProblemCode }) =>
    problemTable[problem.code].knownBy === "home",
} as const;

/** A problem as it is now: how many there are, since when, and its fields. */
export const ProblemSchema = z
  .strictObject({
    code: ProblemCodeSchema,
    count: z.number().int().min(1).max(1_000_000),
    firstSeenAt: ReportTimeSchema,
    lastSeenAt: ReportTimeSchema,
    fields: ProblemFieldsSchema,
  })
  .refine(reportRefinements.fieldsOfItsCode, { path: ["fields"], message: "Not a field of it" });
export type Problem = z.infer<typeof ProblemSchema>;

export const problemsLimit = 32;

/**
 * What only the machine's root maintenance knows of a Linux Home, written by
 * `deploy/home` into the Host's data folder as fixed values, read strictly by the Host.
 */
export const MachineStatusSchema = z.strictObject({
  services: z.partialRecord(HomeServiceSchema, ServiceHealthSchema).optional(),
  lastBackup: z
    .strictObject({
      result: z.enum(["ok", "failed"]),
      failure: BackupFailureSchema.optional(),
      at: ReportTimeSchema,
    })
    .optional(),
  lastUpdate: z
    .strictObject({
      result: UpdateResultSchema,
      at: ReportTimeSchema,
      fromVersion: ReleaseVersionSchema.optional(),
      toVersion: ReleaseVersionSchema.optional(),
    })
    .optional(),
});
export type MachineStatus = z.infer<typeof MachineStatusSchema>;

/**
 * The one report a Home sends: what a Cloud Computer sends its operator, the Opensteer account,
 * and what a self-hosted Home sends its operator's own collector when that operator set its
 * address. A person's own Home sends nothing. The person sees the exact bytes in Settings.
 */
export const HomeHealthReportSchema = z.strictObject({
  schema: z.literal(1),
  /** Where the Home runs, in the Host's own words (`personalHomeKind`); `other` for the rest. */
  home: z.enum(["cloud-computer", "server", "mac", "other"]),
  version: ReleaseVersionSchema,
  disk: DiskBucketSchema.optional(),
  ...MachineStatusSchema.shape,
  problems: z
    .array(
      ProblemSchema.refine(reportRefinements.knownByHome, {
        message: "Only a Home's own problems",
      }),
    )
    .max(problemsLimit),
});
export type HomeHealthReport = z.infer<typeof HomeHealthReportSchema>;

/** A problem as the Host's API answers it: tolerant of fields a newer Host adds. */
export const ProblemViewSchema = z.object({
  ...ProblemSchema.shape,
  fields: z.object(ProblemFieldsSchema.shape),
});

/** The bucket a used share of a disk falls in. */
export function diskBucket(usedFraction: number): DiskBucket {
  if (usedFraction >= 0.95) return "over-95";
  if (usedFraction >= 0.85) return "85-95";
  if (usedFraction >= 0.7) return "70-85";
  return "under-70";
}

/** Whether a problem asks someone to act now, for ordering: those first. */
export function compareProblems(left: Problem, right: Problem): number {
  const rank = (problem: Problem) => (problemTable[problem.code].severity === "needs-you" ? 0 : 1);
  return (
    rank(left) - rank(right) ||
    right.lastSeenAt.localeCompare(left.lastSeenAt) ||
    problemCodes.indexOf(left.code) - problemCodes.indexOf(right.code)
  );
}

/** Where a Cloud Computer's report goes on the account service, and on a self-hoster's collector. */
export const cloudComputerHealthPath = (id: string) => `/v1/cloud-computers/${id}/health`;
export const problemReportsPath = "/v1/problem-reports";
