import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

// Review G8: the production entry and the daemon it runs carry no fault-injection hook.
it("keeps the bench's crash hook out of the production entry", async () => {
  for (const file of ["main.ts", "daemon.ts"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    expect(text).not.toMatch(/test-crash|SIGKILL|checkpoint:/u);
  }
});
