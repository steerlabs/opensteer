export function createCaptureRecordWriter(
  directory: string,
): (message: Readonly<Record<string, unknown>>, runId?: string | null) => void;
