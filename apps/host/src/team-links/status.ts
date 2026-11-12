import { TeamStatusStepSchema, type TeamStatusStepKindSchema } from "@opensteer/core";
import type { z } from "zod";

export interface PrivateTeamProgress {
  readonly state: "working" | "needs_you" | "failed" | "stopped" | "cancelled";
  readonly steps: readonly { readonly kind: string; readonly count: number }[];
}

export function publicTeamStatus(progress: PrivateTeamProgress) {
  const counts = new Map<z.infer<typeof TeamStatusStepKindSchema>, number>();
  for (const step of progress.steps) {
    const parsed = TeamStatusStepSchema.safeParse({ kind: step.kind, count: step.count });
    if (parsed.success)
      counts.set(
        parsed.data.kind,
        Math.min(Number.MAX_SAFE_INTEGER, (counts.get(parsed.data.kind) ?? 0) + parsed.data.count),
      );
  }
  return { state: progress.state, steps: [...counts].map(([kind, count]) => ({ kind, count })) };
}
