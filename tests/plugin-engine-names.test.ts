import { expect, test } from "vitest";
import { checkNames } from "../scripts/plugin-engine/names.mjs";
import { resolve } from "node:path";

test("the imported engine keeps its identity only in explicit compatibility modules and notices", async () => {
  await expect(checkNames(resolve(import.meta.dirname, ".."))).resolves.toBeUndefined();
});
