import type { PrivateFilesystem } from "@opensteer/client/connections";
import { z } from "zod";

const maxShownFileBytes = 32 * 1_024;
/** More than the Host ever lists for one iPhone; older entries are dropped first. */
export const maxShownApprovals = 200;

const ShownApprovalSchema = z.strictObject({
  expiresAt: z.iso.datetime({ offset: true }),
  id: z.string().min(1).max(128),
});

const ShownApprovalsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  shown: z.array(ShownApprovalSchema).max(maxShownApprovals),
});

/** A request the iPhone already put in front of the person on its own. */
export type ShownApproval = z.infer<typeof ShownApprovalSchema>;

/**
 * The requests already shown on their own, kept across launches so a request
 * is put in front of the person once. Each is kept until it expires: a request
 * can leave the iPhone's list for a moment while it reconnects and must not
 * pop up again when it returns.
 */
export interface ShownApprovalsFile {
  read(): Promise<readonly ShownApproval[]>;
  write(shown: readonly ShownApproval[]): Promise<void>;
}

export function createShownApprovalsFile(options: {
  readonly filePath: string;
  readonly privateFiles: PrivateFilesystem;
}): ShownApprovalsFile {
  return {
    async read() {
      try {
        const stored = await options.privateFiles.readFile(options.filePath, maxShownFileBytes);
        if (stored === null) return [];
        const parsed = ShownApprovalsFileSchema.safeParse(
          JSON.parse(new TextDecoder().decode(stored)) as unknown,
        );
        return parsed.success ? parsed.data.shown : [];
      } catch {
        // Forgetting what was shown only means a request may be shown again.
        return [];
      }
    },

    async write(shown) {
      await options.privateFiles.writeFileAtomic(
        options.filePath,
        JSON.stringify(ShownApprovalsFileSchema.parse({ schemaVersion: 1, shown })),
      );
    },
  };
}
