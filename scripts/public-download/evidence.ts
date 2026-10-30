import { z } from "zod";
import { compareStableVersions } from "../engines.js";

type Channel = "beta" | "stable";

/** The release tag and archive name `desktop:public-release prepare` writes per channel. */
export function releaseAsset(channel: Channel, version: string) {
  return channel === "stable"
    ? { tag: `desktop-v${version}`, zip: "Opensteer-mac-arm64.zip" }
    : { tag: `v${version}-insider`, zip: "Opensteer-Beta-mac-arm64.zip" };
}

/** Every journey a channel's release must pass; a selected subset is only partial evidence. */
export const certificationCases = {
  stable: ["stable:menu", "stable:tray", "stable:quit"],
  beta: ["beta:menu", "beta:quit"],
} as const satisfies Record<Channel, readonly string[]>;

export const journeyMetadata = z.object({ expectedTeamId: z.string().regex(/^[A-Z0-9]{10}$/u) });
export const numericVersion = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
const release = z.object({
  version: numericVersion,
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
});
export const journeyInput = z
  .object({ older: release, n: release, next: release })
  .refine(
    (x) =>
      compareStableVersions(x.older.version, x.n.version) < 0 &&
      compareStableVersions(x.n.version, x.next.version) < 0,
    "Require older fixture < N < N+1",
  );
export function advertisedVersion(n: string, next: string): string {
  numericVersion.parse(n);
  numericVersion.parse(next);
  const parts = next.split(".");
  const advertised = numericVersion.parse(`${parts[0]}.${parts[1]}.${BigInt(parts[2]!) + 1n}`);
  if (compareStableVersions(next, n) <= 0 || compareStableVersions(advertised, next) <= 0)
    throw Error("Require N < N+1 < advertised");
  return advertised;
}
export const deliveryEvidence = z
  .object({
    at: z.number(),
    transferComplete: z.string(),
    bytes: z.number().int().positive(),
    size: z.number().int().positive(),
    start: z.literal(0),
    end: z.number().int().nonnegative(),
  })
  .refine((x) => x.bytes === x.size && x.end === x.size - 1, "Full ZIP delivery required");
export const updateFailure = z.object({
  at: z.number(),
  event: z.literal("desktop.update.failed"),
  reason: z.enum(["signature", "downgrade", "other"]),
});
export function updateFailures(log: string) {
  return log.split("\n").flatMap((line) => {
    const start = line.indexOf("{");
    if (start < 0) return [];
    let value: unknown;
    try {
      value = JSON.parse(line.slice(start));
    } catch {
      return [];
    }
    if (!z.object({ event: z.literal("desktop.update.failed") }).safeParse(value).success)
      return [];
    const timestamp = z.string().datetime().parse(line.split(" ")[0]);
    return [
      updateFailure.parse({
        ...z.record(z.string(), z.unknown()).parse(value),
        at: Date.parse(timestamp),
      }),
    ];
  });
}
export const rejectionEvidence = z
  .object({
    kind: z.enum(["signature", "downgrade"]),
    delivery: deliveryEvidence,
    expectedBytes: z.number().int().positive(),
    failure: updateFailure,
  })
  .refine((x) => x.delivery.bytes === x.expectedBytes, "Delivered ZIP size differs from fixture")
  .refine(
    (x) => x.failure.reason === x.kind && x.failure.at > x.delivery.at,
    "Expected classified native refusal must follow completed delivery",
  );
export const shutdownEvidence = z
  .object({
    inventory: z
      .array(z.object({ pid: z.number().int().positive(), command: z.string() }))
      .nonempty(),
    exits: z.array(
      z.object({
        pid: z.number().int().positive(),
        exitedAt: z.number(),
        oldBundleObservedAt: z.number(),
      }),
    ),
    swapObservedAt: z.number(),
  })
  .refine(
    (x) =>
      x.inventory.every((p) =>
        x.exits.some(
          (e) =>
            e.pid === p.pid &&
            e.exitedAt <= e.oldBundleObservedAt &&
            e.oldBundleObservedAt < x.swapObservedAt,
        ),
      ),
    "Each exit must precede an unchanged-bundle witness and the swap",
  );
