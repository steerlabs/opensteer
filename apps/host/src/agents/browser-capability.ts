import type { ThreadAccessMode } from "@opensteer/core";
import { integrationAccessCeilingForRun } from "@opensteer/integration-core/effective-grants";

export function runHasBrowserPages(driverKind: string, accessMode: ThreadAccessMode): boolean {
  return (
    (driverKind !== "codex" || accessMode === "full-access") &&
    integrationAccessCeilingForRun(accessMode) === "read-write"
  );
}
