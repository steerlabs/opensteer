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
export const UpdateResultSchema = z.enum(["updated", "rolled-back", "feed-older", "failed"]);

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

/** A release version: digits and a lowercase pre-release tag, never anything else. */
export const ReleaseVersionSchema = z
  .string()
  .max(64)
  .regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[a-z0-9]{1,20}(?:\.[a-z0-9]{1,20}){0,3})?$/u);

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

/** A problem as it is now: how many there are, since when, and its fields. */
export const ProblemSchema = z
  .strictObject({
    code: ProblemCodeSchema,
    count: z.number().int().min(1).max(1_000_000),
    firstSeenAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
    fields: ProblemFieldsSchema,
  })
  .superRefine((problem, context) => {
    const allowed = new Set<string>(problemTable[problem.code].fields);
    for (const name of Object.keys(problem.fields))
      if (!allowed.has(name))
        context.addIssue({ code: "custom", path: ["fields", name], message: "Not a field of it" });
  });
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
      at: z.iso.datetime(),
    })
    .optional(),
  lastUpdate: z
    .strictObject({
      result: UpdateResultSchema,
      at: z.iso.datetime(),
      fromVersion: ReleaseVersionSchema.optional(),
      toVersion: ReleaseVersionSchema.optional(),
    })
    .optional(),
});
export type MachineStatus = z.infer<typeof MachineStatusSchema>;

/**
 * The one report a Home sends: to the Opensteer account service by a Cloud Computer (its
 * operator's health report), or by any other Home only when the person turned on "Send problem
 * reports". The person sees this exact value before and after it is sent.
 */
export const HomeHealthReportSchema = z.strictObject({
  schema: z.literal(1),
  home: z.enum(["cloud-computer", "linux", "mac"]),
  version: ReleaseVersionSchema,
  disk: DiskBucketSchema.optional(),
  ...MachineStatusSchema.shape,
  problems: z
    .array(
      ProblemSchema.refine((problem) => problemTable[problem.code].knownBy === "home", {
        message: "Only a Home's own problems",
      }),
    )
    .max(problemsLimit),
});
export type HomeHealthReport = z.infer<typeof HomeHealthReportSchema>;

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

/** The paths of the account service that receive a report. */
export const cloudComputerHealthPath = (id: string) => `/v1/cloud-computers/${id}/health`;
export const problemReportsPath = "/v1/problem-reports";
