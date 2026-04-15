import { isBrowserCoreError } from "@opensteer/browser-core";
import { isOpensteerProtocolError, type OpensteerError } from "@opensteer/protocol";

export type CliErrorType =
  | "unknown_command"
  | "unknown_option"
  | "missing_arguments"
  | "invalid_value"
  | "invalid_option"
  | "missing_workspace"
  | "config_conflict"
  | "unsupported_operation";

export class CliError extends Error {
  readonly type: CliErrorType;
  readonly usage: string | undefined;

  constructor(type: CliErrorType, message: string, usage?: string) {
    super(message);
    this.name = "CliError";
    this.type = type;
    this.usage = usage;
  }

  format(): string {
    return this.usage === undefined ? this.message : `${this.message}\nUsage: ${this.usage}`;
  }
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}

export function formatCliErrorOutput(error: unknown): Record<string, unknown> {
  if (isCliError(error)) {
    return {
      success: false,
      error: error.format(),
      type: error.type,
    };
  }

  if (isOpensteerProtocolError(error)) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      retriable: error.retriable,
    };
  }

  if (isBrowserCoreError(error)) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      retriable: error.retriable,
    };
  }

  if (error instanceof Error && "opensteerError" in error) {
    const oe = (error as { opensteerError: OpensteerError }).opensteerError;
    return {
      success: false,
      error: oe.message,
      code: oe.code,
      retriable: oe.retriable,
    };
  }

  if (error instanceof SyntaxError) {
    return {
      success: false,
      error: error.message,
      type: "invalid_value" as CliErrorType,
    };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function emitWarning(warning: string): void {
  process.stderr.write(`${JSON.stringify({ warning })}\n`);
}

export const CLI_USAGE_HINTS: Partial<Record<string, string>> = {
  "session.open": "opensteer open <url> [--workspace <id>]",
  "page.goto": "opensteer goto <url>",
  "page.evaluate": "opensteer evaluate <script>",
  "page.add-init-script": "opensteer init-script <script>",
  "dom.click": "opensteer click <element> --persist <key>",
  "dom.hover": "opensteer hover <element> --persist <key>",
  "dom.input": "opensteer input <element> <text> --persist <key>",
  "dom.scroll": "opensteer scroll <direction> <amount> --persist <key>",
  "dom.extract": "opensteer extract <template> --persist <key>",
  "network.detail": "opensteer network detail <recordId>",
  "session.fetch": "opensteer fetch <url>",
  "captcha.solve": "opensteer captcha solve --provider <name> --api-key <key>",
  "scripts.capture": "opensteer scripts capture",
  "scripts.beautify": "opensteer scripts beautify <artifactId>",
  "scripts.deobfuscate": "opensteer scripts deobfuscate <artifactId>",
  "scripts.sandbox": "opensteer scripts sandbox <artifactId>",
  "interaction.capture": "opensteer interaction capture",
  "interaction.get": "opensteer interaction get <traceId>",
  "interaction.replay": "opensteer interaction replay <traceId>",
  "interaction.diff": "opensteer interaction diff <leftTraceId> <rightTraceId>",
  "artifact.read": "opensteer artifact read <artifactId>",
  "computer.click": "opensteer computer click <x> <y>",
  "computer.type": "opensteer computer type <text>",
  "computer.key": "opensteer computer key <key>",
  "computer.scroll": "opensteer computer scroll <x> <y> --dx <n> --dy <n>",
  "computer.move": "opensteer computer move <x> <y>",
  "computer.drag": "opensteer computer drag <x1> <y1> <x2> <y2>",
  "computer.screenshot": "opensteer computer screenshot",
  exec: 'opensteer exec <expression>',
  record: "opensteer record --url <url> --workspace <id>",
  "browser.inspect": "opensteer browser inspect <endpoint>",
  "browser.clone": "opensteer browser clone --source-user-data-dir <path>",
};
