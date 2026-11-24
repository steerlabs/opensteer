import type { FastifyBaseLogger } from "fastify";
import type { CloudComputerSetupFailure, ProblemCode } from "@opensteer/protocol/problems";
import type { CloudComputerReport } from "@opensteer/control-plane-protocol";

/**
 * The account service's stable log events: each failure the operator runbook
 * (docs/cloud-computer-operations.md) names, one name each, so an alert can be written against
 * `jsonPayload.event` (deploy/monitoring). The fields have the same names in every event:
 * `computerId`, `code`, `phase`, `minutes`, `step`, `waitedMs`, `pool`, `free`, `codes`,
 * `status` and a redacted `error`. A name here is a contract with the alert files: rename one
 * only with its alert.
 */
export const accountEvents = {
  /** A person paid and has no working Cloud Computer. Pages. */
  "account.cloud_computer.not_ready": "error",
  /** The provisioner recorded a failed setup. */
  "account.cloud_computer.setup_failed": "error",
  /** Claiming a ready Home for its buyer failed. */
  "account.cloud_computer.claim_failed": "error",
  /** A Cloud Computer keeps going down, each outage too short to page, for the limit. */
  "account.cloud_computer.unstable": "warn",
  /** A ready Cloud Computer has not reported a backup for 36 hours. */
  "account.cloud_computer.backup_overdue": "warn",
  /** A ready Cloud Computer has not sent its health report for an hour. */
  "account.cloud_computer.report_missing": "warn",
  /** A Cloud Computer's health report names a problem that needs someone. */
  "account.cloud_computer.unhealthy": "warn",
  /** A billing pass step failed; it is retried every 60 seconds. */
  "account.billing.failed": "error",
  /** A deleted computer's subscription was cancelled late: look for a renewal to refund. */
  "account.billing.cancelled_late": "error",
  /** A deleted computer is not settled with Stripe an hour after its request. */
  "account.billing.deletion_unsettled": "error",
  /** Fewer than two free backup targets or egress endpoints: checkout or browsing will stop. */
  "account.pool.low": "warn",
  /** Removing a deleted computer's stored backups is not finished; it is retried. */
  "account.backup.erasure_pending": "error",
  /** A heartbeat request was not answered with success. */
  "account.heartbeat.failed": "warn",
} as const satisfies Record<string, "error" | "warn" | "info">;
export type AccountEvent = keyof typeof accountEvents;

export interface AccountEventFields {
  readonly computerId?: string;
  readonly code?: string;
  readonly phase?: string;
  readonly minutes?: number;
  readonly step?: string;
  readonly waitedMs?: number;
  readonly pool?: "backup" | "egress";
  readonly free?: number;
  readonly codes?: readonly ProblemCode[];
  readonly status?: number | "unreachable";
  readonly error?: Record<string, unknown>;
  /** An error the logger serializes; only where the runbook's own logs carried one before. */
  readonly err?: unknown;
  readonly type?: string;
  readonly message?: string;
  readonly home?: string;
  readonly version?: string;
}

/** Writes one event: `{ event, ...fields }`, with the runbook's words as its message. */
export function logAccountEvent(
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info">,
  event: AccountEvent,
  fields: AccountEventFields = {},
  message: string = event,
): void {
  log[accountEvents[event]]({ event, ...fields }, message);
}

/** A Cloud Computer's setup failure as one code: the provisioner's error or the claim's. */
export function cloudComputerSetupFailure(
  lastError: CloudComputerReport["lastError"],
  claim: "timeout" | "setup-failed" | "claim-failed" | null,
): CloudComputerSetupFailure | undefined {
  if (claim)
    return (
      {
        timeout: "claim-timeout",
        "setup-failed": "claim-setup-failed",
        "claim-failed": "claim-failed",
      } as const
    )[claim];
  if (!lastError) return undefined;
  const codes: Record<NonNullable<CloudComputerReport["lastError"]>, CloudComputerSetupFailure> = {
    "A bootstrap token is required to create this Cloud Computer.": "bootstrap-missing",
    "The provider has a newer Cloud Computer generation.": "newer-generation",
    "The Cloud Computer has more than one server for this generation.": "duplicate-server",
    "The Cloud Computer did not become ready before its deadline.": "readiness-timeout",
    "The Cloud Computer reported a different Home identity for this generation.":
      "identity-mismatch",
    "The Cloud Computer provider operation failed.": "provider-failed",
    "The Cloud Computer DNS operation failed.": "dns-failed",
  };
  return codes[lastError];
}
