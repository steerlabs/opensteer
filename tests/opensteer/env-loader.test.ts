import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { loadCliEnvironment } from "../../packages/opensteer/src/cli/env-loader.js";
import { resolveOpensteerEnvironment } from "../../packages/opensteer/src/env.js";

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.OPENSTEER_PROVIDER;
  delete process.env.OPENSTEER_BASE_URL;
  delete process.env.OPENSTEER_API_KEY;
  delete process.env.DATABASE_URL;
});

describe("CLI env loading", () => {
  test("loads env files from parent to child and preserves existing process env", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-env-loader-"));
    const childDir = path.join(rootDir, "nested", "workspace");
    await mkdir(childDir, { recursive: true });

    try {
      await writeFile(
        path.join(rootDir, ".env"),
        [
          "OPENSTEER_PROVIDER=local",
          "OPENSTEER_BASE_URL=https://parent.example",
          "OPENSTEER_API_KEY=parent-key",
        ].join("\n"),
      );
      await writeFile(
        path.join(childDir, ".env"),
        ["OPENSTEER_PROVIDER=cloud", "OPENSTEER_BASE_URL=https://child.example"].join("\n"),
      );
      await writeFile(
        path.join(childDir, ".env.local"),
        "OPENSTEER_BASE_URL=https://child-local.example\n",
      );

      vi.stubEnv("OPENSTEER_API_KEY", "protected-key");

      await loadCliEnvironment(childDir);

      expect(process.env.OPENSTEER_PROVIDER).toBe("cloud");
      expect(process.env.OPENSTEER_BASE_URL).toBe("https://child-local.example");
      expect(process.env.OPENSTEER_API_KEY).toBe("protected-key");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("resolves only OPENSTEER_* keys without mutating unrelated host env", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-env-resolve-"));
    const childDir = path.join(rootDir, "workspace");
    await mkdir(childDir, { recursive: true });

    try {
      await writeFile(
        path.join(rootDir, ".env"),
        [
          "DATABASE_URL=postgres://host-app",
          "OPENSTEER_PROVIDER=cloud",
          "OPENSTEER_BASE_URL=https://cloud.example",
        ].join("\n"),
      );

      const environment = resolveOpensteerEnvironment(childDir, {});

      expect(environment).toEqual({
        OPENSTEER_PROVIDER: "cloud",
        OPENSTEER_BASE_URL: "https://cloud.example",
      });
      expect(process.env.DATABASE_URL).toBeUndefined();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
