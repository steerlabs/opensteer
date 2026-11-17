import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const nonblank = z.string().refine((value) => value.trim().length > 0, "Must not be blank");
const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;

export const QuarantineEntrySchema = z
  .strictObject({
    file: nonblank.refine(
      (file) =>
        !file.includes("\\") &&
        !file.startsWith("/") &&
        !file.split("/").some((part) => ["", ".", ".."].includes(part)),
      "Use an exact repository-relative file path",
    ),
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

export function activeQuarantines(
  entries: readonly QuarantineEntry[],
  now = Date.now(),
): QuarantineEntry[] {
  const active = entries.filter((entry) => entry.status === "quarantined");
  for (const entry of active) {
    if (Date.parse(entry.deadline) <= now)
      throw new Error(
        `Quarantine expired: ${entry.file} ${JSON.stringify(entry.name)}; owner: ${entry.owner}; deadline: ${entry.deadline}. Fix the test or return it to investigating.`,
      );
    if (Date.parse(entry.firstSeen) > now)
      throw new Error(`Quarantine firstSeen is in the future: ${entry.file}`);
  }
  return active;
}

export function readQuarantines(root: string): QuarantineEntry[] {
  return activeQuarantines(
    QuarantineSchema.parse(
      JSON.parse(readFileSync(path.join(root, "tests/quarantine.json"), "utf8")),
    ),
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  console.log(`${readQuarantines(process.cwd()).length} active test quarantines`);
