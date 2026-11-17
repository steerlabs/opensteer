import type { Kysely } from "kysely";
import {
  ComputerAppSetupRequestSchema,
  IntegrationConnectionSummarySchema,
  type DeviceComputerAppSetupRequest,
  type DeviceIntegrationConnectionSummary,
} from "@opensteer/integration-core";
import type { DatabaseSchema } from "./schema.js";
import { requireDeviceSelfRunnerId } from "./device-inventory-store.js";

export async function legacySelfConnection(
  database: Kysely<DatabaseSchema>,
  connection: DeviceIntegrationConnectionSummary,
) {
  const computer = connection.computer;
  return IntegrationConnectionSummarySchema.parse({
    ...connection,
    computer: computer
      ? {
          access: computer.access,
          app: computer.app,
          blockedAt: computer.blockedAt,
          policyRevision: computer.policyRevision,
          runnerId: await requireDeviceSelfRunnerId(database, computer.deviceId),
        }
      : null,
  });
}
export async function legacySelfSetupRequest(
  database: Kysely<DatabaseSchema>,
  request: DeviceComputerAppSetupRequest,
) {
  const { deviceId, ...rest } = request;
  return ComputerAppSetupRequestSchema.parse({
    ...rest,
    runnerId: await requireDeviceSelfRunnerId(database, deviceId),
  });
}

export async function legacySelfSessionReset(
  database: Kysely<DatabaseSchema>,
  reset:
    | {
        readonly deviceId: import("@opensteer/core").DeviceId;
        readonly kind: "app";
        readonly appKey: string;
      }
    | {
        readonly deviceId: import("@opensteer/core").DeviceId;
        readonly kind: "display";
        readonly definitionId: string;
      }
    | null,
) {
  if (!reset) return null;
  const { deviceId, ...rest } = reset;
  return { ...rest, runnerId: await requireDeviceSelfRunnerId(database, deviceId) };
}
