import { z } from "zod";

const nonblank = z.string().refine((value) => value.trim().length > 0, "Must not be blank");
const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;

/** Ownership and history only: these records never exempt a test or authorize a passing gate. */
export const QuarantineEntrySchema = z
  .strictObject({
    file: nonblank,
    name: z.array(nonblank).min(1),
    area: nonblank,
    owner: nonblank,
    status: z.enum(["quarantined", "investigating", "known-failure"]),
    firstSeen: z.iso.datetime(),
    deadline: z.iso.datetime(),
    sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
    evidence: z.array(nonblank),
  })
  .superRefine((entry, context) => {
    const firstSeen = Date.parse(entry.firstSeen);
    const deadline = Date.parse(entry.deadline);
    if (deadline < firstSeen || deadline > firstSeen + sevenDaysMs) {
      context.addIssue({
        code: "custom",
        path: ["deadline"],
        message: "Deadline must be between firstSeen and seven days later, inclusive",
      });
    }
    if (entry.status === "quarantined") {
      if (!entry.sha) {
        context.addIssue({ code: "custom", path: ["sha"], message: "Quarantine requires a SHA" });
      }
      if (entry.evidence.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["evidence"],
          message: "Quarantine requires evidence",
        });
      }
    }
  });

export const QuarantineSchema = z.array(QuarantineEntrySchema).superRefine((entries, context) => {
  const identities = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const identity = JSON.stringify([entry.file, entry.name]);
    if (identities.has(identity)) {
      context.addIssue({
        code: "custom",
        path: [index, "name"],
        message: "Duplicate test identity",
      });
    }
    identities.add(identity);
  }
});

export type QuarantineEntry = z.infer<typeof QuarantineEntrySchema>;
