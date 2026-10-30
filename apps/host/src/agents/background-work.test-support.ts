import { withTimeout } from "@opensteer/shared/withTimeout";
import { vi } from "vitest";

export async function waitForBackgroundWork(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
) {
  try {
    await withTimeout(
      vi.waitFor(
        async () => {
          if (!(await check())) throw new Error(`Waiting for ${label}`);
        },
        { interval: 100, timeout: timeoutMs },
      ),
      timeoutMs,
      { timeoutError: () => new Error(`Timed out waiting for ${label}`) },
    );
  } catch (cause) {
    throw new Error(`Timed out waiting for ${label}`, { cause });
  }
}
