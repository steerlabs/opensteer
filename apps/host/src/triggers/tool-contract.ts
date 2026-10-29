/** Normalize requests emitted by a program under its immutable tool contract. */
export function requestForToolContract(version: 1 | 2 | 3, input: unknown): unknown {
  if (version !== 1 || typeof input !== "object" || input === null || !("type" in input))
    return input;
  if (
    input.type === "trigger.control" &&
    "input" in input &&
    typeof input.input === "object" &&
    input.input !== null &&
    "program" in input.input &&
    typeof input.input.program === "object" &&
    input.input.program !== null
  ) {
    return {
      ...input,
      input: { ...input.input, program: { ...input.input.program, toolContractVersion: 1 } },
    };
  }
  if (input.type !== "thread.message" || !("delivery" in input)) return input;
  return {
    ...input,
    delivery:
      input.delivery === "trigger"
        ? "queue"
        : input.delivery === "queue"
          ? "report"
          : "invalid-v1-delivery",
  };
}

/** Return the request representation used by that contract's durable idempotency ledger. */
export function requestFingerprintForToolContract(version: 1 | 2 | 3, input: unknown): unknown {
  if (version !== 1 || typeof input !== "object" || input === null || !("type" in input))
    return input;
  if (input.type === "thread.message" && "delivery" in input) {
    return {
      ...input,
      delivery:
        input.delivery === "report"
          ? "queue"
          : input.delivery === "queue"
            ? "trigger"
            : input.delivery,
    };
  }
  if (
    input.type === "trigger.control" &&
    "input" in input &&
    typeof input.input === "object" &&
    input.input !== null &&
    "program" in input.input &&
    typeof input.input.program === "object" &&
    input.input.program !== null
  ) {
    const { toolContractVersion: _version, ...program } = input.input.program as Record<
      string,
      unknown
    >;
    return { ...input, input: { ...input.input, program } };
  }
  return input;
}
