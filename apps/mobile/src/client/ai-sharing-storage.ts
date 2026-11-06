import { AiSharingRecordsSchema, type AiSharingRecord } from "@opensteer/client/ai-sharing";

export function readAiSharing(file: {
  readonly exists: boolean;
  readonly size: number;
  textSync(): string;
}): readonly AiSharingRecord[] {
  try {
    if (!file.exists || file.size > 64 * 1024) return [];
    return AiSharingRecordsSchema.parse(JSON.parse(file.textSync()));
  } catch {
    return [];
  }
}
