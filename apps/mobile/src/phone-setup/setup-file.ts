import type { PrivateFilesystem } from "@opensteer/client/connections";
import { z } from "zod";

const AppSchema = z.enum([
  "apple-calendar",
  "apple-contacts",
  "apple-reminders",
  "iphone-location",
  "iphone-photos",
]);
const OutcomeSchema = z.enum(["on", "off", "denied", "waiting", "unavailable"]);
const ProgressSchema = z.strictObject({
  draft: z.strictObject({
    name: z.string().max(160),
    browser: z.boolean(),
    notifications: z.boolean(),
    apps: z.partialRecord(AppSchema, z.boolean()),
  }),
  runnerId: z.string().min(1).max(255).nullable(),
  completed: z.array(z.union([z.literal("enrollment"), z.literal("notifications"), AppSchema])),
  deferred: z.boolean(),
  browser: OutcomeSchema,
  notifications: OutcomeSchema,
  apps: z.partialRecord(AppSchema, OutcomeSchema),
});
const SetupFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deployments: z.record(z.string().min(1).max(255), ProgressSchema),
});

export type PhoneSetupProgress = z.infer<typeof ProgressSchema>;
export type PhoneSetups = Readonly<Record<string, PhoneSetupProgress>>;

export interface PhoneSetupFile {
  read(): Promise<PhoneSetups>;
  write(deployments: PhoneSetups): Promise<void>;
}

export function createPhoneSetupFile(options: {
  readonly filePath: string;
  readonly privateFiles: PrivateFilesystem;
}): PhoneSetupFile {
  return {
    async read() {
      const stored = await options.privateFiles.readFile(options.filePath, 64 * 1_024);
      if (stored === null) return {};
      try {
        const parsed = SetupFileSchema.safeParse(
          JSON.parse(new TextDecoder().decode(stored)) as unknown,
        );
        return parsed.success ? parsed.data.deployments : {};
      } catch {
        return {};
      }
    },
    async write(deployments) {
      await options.privateFiles.writeFileAtomic(
        options.filePath,
        JSON.stringify(SetupFileSchema.parse({ schemaVersion: 1, deployments })),
      );
    },
  };
}
