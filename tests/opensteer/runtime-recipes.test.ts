import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { OpensteerRuntime } from "../../packages/opensteer/src/sdk/runtime.js";

describe("Opensteer recipe registries", () => {
  test("keeps recipe and auth-recipe records isolated end to end", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-runtime-recipes-"));
    const runtime = new OpensteerRuntime({
      workspace: "github-sync",
      rootDir,
    });

    const recipe = await runtime.writeRecipe({
      key: "login",
      version: "1",
      payload: {
        description: "general workflow recipe",
        steps: [
          {
            kind: "goto",
            url: "https://example.com/login",
          },
        ],
      },
    });

    const authRecipe = await runtime.writeAuthRecipe({
      key: "login",
      version: "1",
      payload: {
        description: "auth workflow recipe",
        steps: [
          {
            kind: "goto",
            url: "https://example.com/auth",
          },
        ],
      },
    });

    await expect(
      runtime.getRecipe({
        key: "login",
        version: "1",
      }),
    ).resolves.toMatchObject({
      id: recipe.id,
      payload: recipe.payload,
    });

    await expect(
      runtime.getAuthRecipe({
        key: "login",
        version: "1",
      }),
    ).resolves.toMatchObject({
      id: authRecipe.id,
      payload: authRecipe.payload,
    });

    await expect(
      runtime.listRecipes({
        key: "login",
      }),
    ).resolves.toEqual({
      recipes: [recipe],
    });

    await expect(
      runtime.listAuthRecipes({
        key: "login",
      }),
    ).resolves.toEqual({
      recipes: [authRecipe],
    });

    await runtime.disconnect();
  });
});
