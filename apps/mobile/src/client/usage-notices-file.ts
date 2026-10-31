import type { PrivateFilesystem } from "@opensteer/client/connections";
import type { UsageNoticeDismissalStorage } from "@opensteer/client/host";
import { z } from "zod";

const maxUsageNoticesFileBytes = 16_384;

const UsageNoticesFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  dismissed: z.array(z.string().max(512)).max(64),
});

/**
 * The usage-limit notices dismissed on this phone, remembered across launches.
 * Each key already names its Deployment, person, account and limit, so one
 * file serves them all; one that cannot be read dismisses nothing.
 */
export function createUsageNoticesFile(options: {
  readonly filePath: string;
  readonly privateFiles: PrivateFilesystem;
}): UsageNoticeDismissalStorage {
  return {
    async read() {
      try {
        const stored = await options.privateFiles.readFile(
          options.filePath,
          maxUsageNoticesFileBytes,
        );
        if (stored === null) return [];
        const parsed = UsageNoticesFileSchema.safeParse(
          JSON.parse(new TextDecoder().decode(stored)) as unknown,
        );
        return parsed.success ? parsed.data.dismissed : [];
      } catch {
        return [];
      }
    },

    async write(dismissed) {
      await options.privateFiles.writeFileAtomic(
        options.filePath,
        JSON.stringify(UsageNoticesFileSchema.parse({ dismissed, schemaVersion: 1 })),
      );
    },
  };
}
