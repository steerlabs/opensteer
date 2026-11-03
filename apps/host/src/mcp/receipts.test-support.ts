import { OpensteerError } from "@opensteer/core";
import type { AgentOperationReceipts } from "@opensteer/database";
export class MemoryOperationReceipts implements Pick<AgentOperationReceipts, "execute"> {
  readonly results = new Map<string, { fingerprint: string; result: Record<string, unknown> }>();
  async execute(input: Parameters<AgentOperationReceipts["execute"]>[0]) {
    await input.check();
    const key = `${input.callerKey}:${input.operationKey}:${input.tool}`;
    const existing = this.results.get(key);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint)
        throw new OpensteerError({
          code: "conflict",
          message: "Operation key was already used with different input",
        });
      return existing.result;
    }
    const result = await input.invoke();
    this.results.set(key, { fingerprint: input.fingerprint, result });
    return result;
  }
}
