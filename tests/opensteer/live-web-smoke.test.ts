import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Opensteer } from "../../packages/opensteer/src/index.js";

const LIVE_WEB = process.env.OPENSTEER_LIVE_WEB_SMOKE === "1";
const liveDescribe = LIVE_WEB ? describe : describe.skip;
const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "opensteer-live-web-"));
  temporaryRoots.push(rootDir);
  return rootDir;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })),
  );
});

liveDescribe("Live web smoke", () => {
  const cases = [
    {
      name: "Wikipedia",
      url: "https://www.wikipedia.org/",
      schema: {
        heading: { selector: "strong" },
      },
      description: "wikipedia heading",
    },
    {
      name: "GitHub",
      url: "https://github.com/",
      schema: {
        loginText: { selector: 'a[href="/login"]' },
      },
      description: "github login link",
    },
    {
      name: "Hacker News",
      url: "https://news.ycombinator.com/",
      schema: {
        loginText: { selector: 'a[href="login?goto=news"]' },
      },
      description: "hn login link",
    },
  ] as const;

  for (const site of cases) {
    test(`${site.name} supports both snapshot modes and deterministic descriptor authoring`, async () => {
      const rootDir = await createTemporaryRoot();
      const opensteer = new Opensteer({
        name: `live-web-${site.name.toLowerCase().replace(/\s+/g, "-")}`,
        rootDir,
        browser: {
          headless: true,
        },
      });

      try {
        await opensteer.open(site.url);

        const actionSnapshot = await opensteer.snapshot("action");
        const extractionSnapshot = await opensteer.snapshot("extraction");
        expect(actionSnapshot.counters.length).toBeGreaterThan(0);
        expect(extractionSnapshot.counters.length).toBeGreaterThan(0);

        const extracted = await opensteer.extract({
          description: site.description,
          schema: site.schema,
        });
        expect(Object.keys(extracted).length).toBeGreaterThan(0);

        expect(await opensteer.extract({ description: site.description })).toEqual(extracted);
      } finally {
        await opensteer.close();
      }
    }, 120_000);
  }
});
