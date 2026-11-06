import type { RunId } from "@opensteer/core";
import { expect, vi } from "vitest";
import type { MachineAccessHost } from "../runtime/machine-access.test-support.js";

export async function startHeldRequest<T>(
  host: MachineAccessHost,
  runId: RunId,
  call: () => Promise<T>,
) {
  const previous = await host.store.database
    .selectFrom("requests")
    .select("id")
    .where("originatingRunId", "=", runId)
    .execute();
  const result = call();
  void result.catch(() => undefined);
  const request = await vi.waitFor(
    async () => {
      const rows = await host.store.database
        .selectFrom("requests")
        .selectAll()
        .where("originatingRunId", "=", runId)
        .execute();
      const created = rows.find((row) => !previous.some(({ id }) => id === row.id));
      expect(created, "The held tool did not create its Request").toBeDefined();
      return created!;
    },
    { timeout: 10_000 },
  );
  return { request, result };
}
