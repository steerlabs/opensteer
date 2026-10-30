import { z } from "zod";
import { compareStableVersions } from "../engines.js";

export const journeyMetadata = z.object({ expectedTeamId: z.string().regex(/^[A-Z0-9]{10}$/u) });
export const numericVersion = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
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
export const rejectionEvidence = z
  .object({
    kind: z.enum(["signature", "downgrade"]),
    delivery: deliveryEvidence,
    expectedBytes: z.number().int().positive(),
    messages: z.array(z.string()).nonempty(),
  })
  .refine((x) => x.delivery.bytes === x.expectedBytes, "Delivered ZIP size differs from fixture")
  .refine(
    (x) =>
      x.messages.some(
        (message) =>
          !/localizationNames:|table: Localizable|result: <same as key>/u.test(message) &&
          (x.kind === "signature"
            ? /(?:did not pass validation|code signature[^\n]*(?:invalid|fail|does not|not valid)|(?:invalid|fail)[^\n]*code signature|does not satisfy[^\n]*requirement|designated requirement[^\n]*(?:fail|not|mismatch))/iu.test(
                message,
              )
            : /ElectronSquirrelPreventDowngrades[\s\S]*appears to be a downgrade/iu.test(message)),
      ),
    "Expected native refusal cause is not observable",
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
