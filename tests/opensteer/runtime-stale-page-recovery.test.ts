import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { createFakeBrowserCoreEngine } from "../../packages/browser-core/src/index.js";
import { OpensteerSessionRuntime } from "../../packages/opensteer/src/sdk/runtime.js";

const temporaryRoots: string[] = [];

describe("runtime stale page recovery", () => {
  afterAll(async () => {
    await Promise.all(
      temporaryRoots.map((rootPath) =>
        rm(rootPath, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  });

  test("rebinds to another live page when the previously bound page disappears", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-stale-page-recovery-"));
    temporaryRoots.push(rootDir);

    const engine = createFakeBrowserCoreEngine();
    const runtime = new OpensteerSessionRuntime({
      name: "stale-page-recovery",
      rootDir,
      engine,
    });

    try {
      const opened = await runtime.open({
        url: "https://example.com/a",
      });
      const secondPage = await runtime.newPage({
        url: "https://example.com/b",
      });

      await engine.closePage({
        pageRef: opened.pageRef,
      });

      await expect(runtime.listPages()).resolves.toMatchObject({
        activePageRef: secondPage.pageRef,
        pages: [expect.objectContaining({ pageRef: secondPage.pageRef })],
      });
      await expect(runtime.evaluate({
        pageRef: secondPage.pageRef,
        script: "() => null",
      })).resolves.toMatchObject({
        pageRef: secondPage.pageRef,
        value: null,
      });
    } finally {
      await runtime.disconnect();
    }
  });
});
