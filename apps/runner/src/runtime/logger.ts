import type { RunnerLogger } from "../host/host-connection.js";

export class JsonRunnerLogger implements RunnerLogger {
  info(message: string, details: Readonly<Record<string, unknown>> = {}): void {
    process.stdout.write(formatLog("info", message, details));
  }

  error(message: string, details: Readonly<Record<string, unknown>> = {}): void {
    process.stderr.write(formatLog("error", message, details));
  }
}

function formatLog(
  level: "error" | "info",
  message: string,
  details: Readonly<Record<string, unknown>>,
): string {
  return `${JSON.stringify({
    ...sanitizeDetails(details),
    level,
    message: message.slice(0, 2_000),
    service: "opensteer-runner",
    timestamp: new Date().toISOString(),
  })}\n`;
}

function sanitizeDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => !/(authorization|capability|credential|secret|token)/i.test(key))
      .map(([key, value]) => [key, sanitizeValue(value)]),
  );
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
      .replace(/os_secret_[A-Za-z0-9_-]+/g, "os_secret_[redacted]")
      .slice(0, 2_000);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}
