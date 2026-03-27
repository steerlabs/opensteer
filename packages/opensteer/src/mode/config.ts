export const OPENSTEER_EXECUTION_MODES = ["local", "cloud"] as const;

export type OpensteerExecutionMode = (typeof OPENSTEER_EXECUTION_MODES)[number];

export function assertExecutionModeSupportsEngine(
  mode: OpensteerExecutionMode,
  engine: string,
): void {
  if (engine !== "abp") {
    return;
  }

  if (mode === "cloud") {
    throw new Error(
      "ABP is not supported in cloud mode. Cloud mode currently requires Playwright.",
    );
  }
}

export function normalizeOpensteerExecutionMode(
  value: string,
  source = "OPENSTEER_MODE",
): OpensteerExecutionMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === OPENSTEER_EXECUTION_MODES[0] || normalized === OPENSTEER_EXECUTION_MODES[1]) {
    return normalized;
  }

  throw new Error(
    `${source} must be one of ${OPENSTEER_EXECUTION_MODES.join(", ")}; received "${value}".`,
  );
}

export function resolveOpensteerExecutionMode(
  input: {
    readonly local?: boolean;
    readonly cloud?: boolean;
    readonly explicit?: OpensteerExecutionMode;
    readonly environment?: string;
  } = {},
): OpensteerExecutionMode {
  const explicitFlags = [input.local, input.cloud].filter(Boolean).length;
  if (explicitFlags > 1) {
    throw new Error("Choose exactly one execution mode: local or cloud.");
  }

  if (input.explicit) {
    return input.explicit;
  }

  if (input.local) {
    return "local";
  }

  if (input.cloud) {
    return "cloud";
  }

  if (input.environment !== undefined && input.environment.trim().length > 0) {
    return normalizeOpensteerExecutionMode(input.environment);
  }

  return "local";
}
